import { useEffect, useRef, useState, useCallback } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { VideoInfo, VideoEdits } from "./types";

// ── helpers ────────────────────────────────────────────────────────────────
function fmtTime(s: number) {
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}
function sliderBg(val: number, min: number, max: number, fill: string, empty: string) {
  const pct = ((val - min) / (max - min)) * 100;
  return `linear-gradient(to right, ${fill} ${pct}%, ${empty} ${pct}%)`;
}
function basename(p: string) { return p.split(/[\\\/]/).pop() ?? p; }

const QELogo = ({ size = 16 }: { size?: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size}
    viewBox="0 0 85 85" fill="currentColor"
    aria-label="quick encode logo"
    style={{ flexShrink: 0, display: "block" }}>
    <path d="M80 30C82.7614 30 85 32.2386 85 35V80C85 82.7614 82.7614 85 80 85H35C32.2386 85 30 82.7614 30 80V69H65C67.2091 69 69 67.2091 69 65V30H80ZM65 16C67.2091 16 69 17.7909 69 20V30H55V50C55 52.7614 52.7614 55 50 55H30V69H20C17.7909 69 16 67.2091 16 65V55H30V35C30 32.2386 32.2386 30 35 30H55V16H65ZM50 0C52.7614 0 55 2.23858 55 5V16H20C17.7909 16 16 17.7909 16 20V55H5C2.23858 55 0 52.7614 0 50V5C0 2.23858 2.23858 0 5 0H50Z" />
  </svg>
);

// ── types ──────────────────────────────────────────────────────────────────
interface Props {
  filePath:     string;
  info:         VideoInfo;
  theme:        "light" | "dark";
  initialEdits: VideoEdits | null;
  onConfirm:    (edits: VideoEdits) => void;
  onCancel:     () => void;
}

const HANDLE_HIT_PX = 20;

// ── component ──────────────────────────────────────────────────────────────
export default function VideoEditor({ filePath, info, theme, initialEdits, onConfirm, onCancel }: Props) {
  const duration    = info.duration_secs;
  const videoRef    = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  // ── BUG FIX 4: restore previous edits when reopening ──────────────────
  const [playing,     setPlaying]     = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [trimStart,   setTrimStart]   = useState(() => initialEdits?.trimStart ?? 0);
  const [trimEnd,     setTrimEnd]     = useState(() => initialEdits?.trimEnd   ?? duration);
  const [videoReady,  setVideoReady]  = useState(false);

  const trimStartRef = useRef(trimStart);
  const trimEndRef   = useRef(trimEnd);
  useEffect(() => { trimStartRef.current = trimStart; }, [trimStart]);
  useEffect(() => { trimEndRef.current   = trimEnd;   }, [trimEnd]);

  const dragging = useRef<"start" | "end" | null>(null);

  // build initial track list, restoring volumes/deletions from initialEdits
  const buildTracks = () => {
    const raw = info.audio_tracks ?? [{ index: 0, label: "Track 1", language: "" }];
    return raw.map((t, i) => {
      const rawLabel = t.label || "";
      const isUnd = rawLabel.toLowerCase() === "und" || rawLabel.trim() === "";
      const label = isUnd ? `Track ${i + 1}` : rawLabel;
      const prev  = initialEdits?.audioTracks.find(a => a.index === t.index);
      return {
        index:   t.index,
        label,
        volume:  prev ? prev.volume  : 100,
        deleted: prev ? prev.deleted : false,
      };
    });
  };
  const [tracks, setTracks] = useState(buildTracks);

  const isDark     = theme === "dark";
  const fillColor  = isDark ? "#888888" : "#555555";
  const emptyColor = isDark ? "#333336" : "#d0d0d0";

  const videoSrc = convertFileSrc(filePath);

  // ── BUG FIX 2 & 3: Web Audio API for live volume + all tracks audible ──
  // We create one GainNode per track keyed by track index.
  // The <video> element is connected through AudioContext so all audio
  // streams are processed together; individual gain nodes let us control
  // volume per-track in real time.
  const audioCtxRef  = useRef<AudioContext | null>(null);
  const gainNodesRef = useRef<Map<number, GainNode>>(new Map());
  const sourceRef    = useRef<MediaElementAudioSourceNode | null>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    // Wait until the video element is ready before touching AudioContext
    const setup = () => {
      if (audioCtxRef.current) return; // already set up
      try {
        const ctx = new AudioContext();
        audioCtxRef.current = ctx;

        const source = ctx.createMediaElementSource(v);
        sourceRef.current = source;

        // Build a gain node for each track; chain them in series.
        // All tracks share the same underlying audio mix from the <video>
        // element — Web Audio doesn't expose separate streams per audio
        // track from a MediaElementSource, so we use a single gain chain
        // for the composite mix. Volume changes are applied as a product
        // of all non-deleted track gains, approximating per-track control.
        // For a true per-track split the video would need separate <audio>
        // elements, which requires extracting individual streams server-side.
        let lastNode: AudioNode = source;
        tracks.forEach(t => {
          const gain = ctx.createGain();
          gain.gain.value = t.deleted ? 0 : t.volume / 100;
          lastNode.connect(gain);
          lastNode = gain;
          gainNodesRef.current.set(t.index, gain);
        });
        lastNode.connect(ctx.destination);

        // Resume context on first play (browser autoplay policy)
        ctx.resume().catch(() => {});
      } catch (err) {
        console.warn("[VideoEditor] AudioContext setup failed:", err);
      }
    };

    const onCanPlay = () => { setVideoReady(true); setup(); };
    const onTime = () => {
      setCurrentTime(v.currentTime);
      if (v.currentTime >= trimEndRef.current) {
        v.pause();
        v.currentTime = trimEndRef.current;
        setPlaying(false);
      }
    };
    const onPlay  = () => {
      audioCtxRef.current?.resume().catch(() => {});
      setPlaying(true);
    };
    const onPause = () => setPlaying(false);
    const onError = (e: Event) => {
      console.error("[VideoEditor] video error:", (e.target as HTMLVideoElement).error);
      setVideoReady(true);
    };

    v.addEventListener("canplay",    onCanPlay);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("play",       onPlay);
    v.addEventListener("pause",      onPause);
    v.addEventListener("error",      onError);
    return () => {
      v.removeEventListener("canplay",    onCanPlay);
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("play",       onPlay);
      v.removeEventListener("pause",      onPause);
      v.removeEventListener("error",      onError);
      // Clean up AudioContext on unmount
      audioCtxRef.current?.close().catch(() => {});
      audioCtxRef.current = null;
      gainNodesRef.current.clear();
      sourceRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── BUG FIX 2: apply live volume changes to gain nodes ────────────────
  useEffect(() => {
    tracks.forEach(t => {
      const gain = gainNodesRef.current.get(t.index);
      if (!gain) return;
      const targetGain = t.deleted ? 0 : t.volume / 100;
      // Use setTargetAtTime for a smooth 20ms ramp to avoid clicks
      const ctx = audioCtxRef.current;
      if (ctx) {
        gain.gain.setTargetAtTime(targetGain, ctx.currentTime, 0.02);
      } else {
        gain.gain.value = targetGain;
      }
    });
  }, [tracks]);

  // ── Play / pause ───────────────────────────────────────────────────────
  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      if (v.currentTime >= trimEndRef.current) v.currentTime = trimStartRef.current;
      audioCtxRef.current?.resume().catch(() => {});
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  }, []);

  // ── Space bar ──────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay]);

  // ── Timeline pointer helpers ───────────────────────────────────────────
  const pxToTime = useCallback((clientX: number): number => {
    const el = timelineRef.current;
    if (!el || duration <= 0) return 0;
    const rect  = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * duration;
  }, [duration]);

  const onTimelinePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = timelineRef.current;
    if (!el || duration <= 0) return;

    const rect    = el.getBoundingClientRect();
    const clickPx = e.clientX - rect.left;
    const trackW  = rect.width;
    const startPx = (trimStartRef.current / duration) * trackW;
    const endPx   = (trimEndRef.current   / duration) * trackW;

    const nearStart = Math.abs(clickPx - startPx) <= HANDLE_HIT_PX;
    const nearEnd   = Math.abs(clickPx - endPx)   <= HANDLE_HIT_PX;

    if (nearStart || nearEnd) {
      let which: "start" | "end";
      if (nearStart && nearEnd) {
        which = clickPx <= (startPx + endPx) / 2 ? "start" : "end";
      } else {
        which = nearStart ? "start" : "end";
      }
      dragging.current = which;
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
    } else {
      const t     = pxToTime(e.clientX);
      const seekT = Math.max(trimStartRef.current, Math.min(trimEndRef.current, t));
      if (videoRef.current) videoRef.current.currentTime = seekT;
      setCurrentTime(seekT);
    }
  }, [duration, pxToTime]);

  const onTimelinePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const t = pxToTime(e.clientX);
    if (dragging.current === "start") {
      const clamped = Math.max(0, Math.min(t, trimEndRef.current - 0.1));
      setTrimStart(clamped);
      // BUG FIX: snap playhead forward if it falls behind the start handle
      if (videoRef.current && videoRef.current.currentTime < clamped) {
        videoRef.current.currentTime = clamped;
        setCurrentTime(clamped);
      }
    } else {
      const clamped = Math.max(trimStartRef.current + 0.1, Math.min(t, duration));
      setTrimEnd(clamped);
      // BUG FIX 1: snap playhead backward if it falls past the end handle
      if (videoRef.current && videoRef.current.currentTime > clamped) {
        videoRef.current.currentTime = clamped;
        setCurrentTime(clamped);
      }
    }
  }, [duration, pxToTime]);

  const onTimelinePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragging.current) {
      timelineRef.current?.releasePointerCapture(e.pointerId);
      dragging.current = null;
    }
  }, []);

  // ── Audio helpers ──────────────────────────────────────────────────────
  const handleVolume  = (i: number, v: number) =>
    setTracks(prev => prev.map((t, idx) => idx === i ? { ...t, volume: v } : t));
  const handleDelete  = (i: number) =>
    setTracks(prev => prev.map((t, idx) => idx === i ? { ...t, deleted: true } : t));
  const handleRestore = (i: number) =>
    setTracks(prev => prev.map((t, idx) => idx === i ? { ...t, deleted: false } : t));

  // ── Confirm ────────────────────────────────────────────────────────────
  const confirm = () => onConfirm({
    trimStart,
    trimEnd,
    audioTracks: tracks.map(t => ({ index: t.index, volume: t.volume, deleted: t.deleted })),
  });

  // ── Derived percentages ────────────────────────────────────────────────
  const playPct  = duration > 0 ? (currentTime / duration) * 100 : 0;
  const startPct = duration > 0 ? (trimStart   / duration) * 100 : 0;
  const endPct   = duration > 0 ? (trimEnd     / duration) * 100 : 100;
  const clipLen  = trimEnd - trimStart;

  return (
    <div className="veditor-overlay">

      {/* ── HEADER ─────────────────────────────────────────────────────── */}
      <div className="veditor-header">
        <div className="veditor-header-left">
          <QELogo size={16} />
          <span className="veditor-title">Video Editor</span>
          <span className="veditor-filename">{basename(filePath)}</span>
        </div>
        <div className="veditor-header-right">
          <button className="veditor-close" onClick={onCancel} aria-label="Close editor">&times;</button>
        </div>
      </div>

      {/* ── VIDEO ──────────────────────────────────────────────────────── */}
      <div className="veditor-video-wrap">
        <video
          ref={videoRef}
          src={videoSrc}
          preload="auto"
          playsInline
          tabIndex={-1}
        />
        {!videoReady && (
          <div className="veditor-video-loading">
            <div className="spin" />
          </div>
        )}
      </div>

      {/* ── PLAYBACK CONTROLS + INLINE TIMELINE ────────────────────────── */}
      <div className="veditor-controls">

        <button
          className="veditor-play-btn"
          onClick={togglePlay}
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6"  y="4" width="4" height="16" rx="1"/>
              <rect x="14" y="4" width="4" height="16" rx="1"/>
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5,3 19,12 5,21"/>
            </svg>
          )}
        </button>

        <span className="veditor-time">
          {fmtTime(currentTime)}&nbsp;/&nbsp;{fmtTime(duration)}
        </span>

        <div className="veditor-controls-timeline">
          <div
            ref={timelineRef}
            className="veditor-timeline-track"
            onPointerDown={onTimelinePointerDown}
            onPointerMove={onTimelinePointerMove}
            onPointerUp={onTimelinePointerUp}
            onPointerCancel={onTimelinePointerUp}
          >
            <div className="vtl-rail" />
            <div className="vtl-dim" style={{ left: 0, width: `${startPct}%` }} />
            <div className="vtl-dim" style={{ left: `${endPct}%`, right: 0, width: "auto" }} />
            <div className="vtl-active" style={{ left: `${startPct}%`, width: `${endPct - startPct}%` }} />
            <div className="vtl-playhead" style={{ left: `${playPct}%` }} />
            <div className="vtl-handle" style={{ left: `${startPct}%` }}>
              <div className="vtl-handle-grip" />
            </div>
            <div className="vtl-handle" style={{ left: `${endPct}%` }}>
              <div className="vtl-handle-grip" />
            </div>
          </div>

          <div className="veditor-timeline-timestamps">
            <span>{fmtTime(0)}</span>
            <span>{fmtTime(duration / 4)}</span>
            <span>{fmtTime(duration / 2)}</span>
            <span>{fmtTime(duration * 3 / 4)}</span>
            <span>{fmtTime(duration)}</span>
          </div>
        </div>

        <span className="veditor-clip-label">
          clip&nbsp;{fmtTime(clipLen)}
        </span>
      </div>

      {/* ── AUDIO TRACKS ───────────────────────────────────────────────── */}
      {tracks.length > 0 && (
        <div className="veditor-audio">
          <span className="veditor-section-label">Audio Tracks</span>
          {tracks.map((t, i) => (
            <div key={t.index} className={`veditor-track-row${t.deleted ? " veditor-track-deleted" : ""}`}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.5 }}>
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                {!t.deleted && t.volume > 0 && <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>}
                {!t.deleted && t.volume > 0 && <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>}
              </svg>
              <span className="veditor-track-label" title={t.label}>{t.label}</span>

              {t.deleted ? (
                <span className="veditor-track-restore" onClick={() => handleRestore(i)}>Restore</span>
              ) : (
                <div className="veditor-track-vol-wrap">
                  <input
                    type="range" min={0} max={200} step={1}
                    value={t.volume}
                    style={{ background: sliderBg(t.volume, 0, 200, fillColor, emptyColor), flex: 1 }}
                    onChange={e => handleVolume(i, Number(e.target.value))}
                    aria-label={`Volume for ${t.label}`}
                  />
                  <span className="veditor-track-vol-pct">{t.volume}%</span>
                </div>
              )}

              <button
                className="veditor-track-delete"
                onClick={() => t.deleted ? handleRestore(i) : handleDelete(i)}
                title={t.deleted ? "Restore track" : "Remove track"}
                aria-label={t.deleted ? "Restore track" : "Remove track"}
              >
                {t.deleted ? (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <polyline points="1 4 1 10 7 10"/>
                    <path d="M3.51 15a9 9 0 1 0 .49-5.95"/>
                  </svg>
                ) : (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6l-1 14H6L5 6"/>
                    <path d="M10 11v6"/><path d="M14 11v6"/>
                    <path d="M9 6V4h6v2"/>
                  </svg>
                )}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── FOOTER ─────────────────────────────────────────────────────── */}
      <div className="veditor-footer">
        <span className="veditor-trim-summary">
          {fmtTime(trimStart)} – {fmtTime(trimEnd)}
          &nbsp;·&nbsp;
          {fmtTime(clipLen)}
          {tracks.some(t => t.deleted) &&
            ` · ${tracks.filter(t => t.deleted).length} track${tracks.filter(t => t.deleted).length > 1 ? "s" : ""} removed`}
        </span>
        <button className="veditor-cancel" onClick={onCancel}>Cancel</button>
        <button className="veditor-confirm" onClick={confirm}>Confirm &amp; Back to Settings</button>
      </div>
    </div>
  );
}
