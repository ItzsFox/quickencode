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
  filePath:  string;
  info:      VideoInfo;
  theme:     "light" | "dark";
  onConfirm: (edits: VideoEdits) => void;
  onCancel:  () => void;
}

// Hit radius in px for grabbing a trim handle
const HANDLE_HIT_PX = 18;

// ── component ──────────────────────────────────────────────────────────────
export default function VideoEditor({ filePath, info, theme, onConfirm, onCancel }: Props) {
  const duration    = info.duration_secs;
  const videoRef    = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  const [playing,     setPlaying]     = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [trimStart,   setTrimStart]   = useState(0);
  const [trimEnd,     setTrimEnd]     = useState(duration);

  // Keep mutable refs in sync so callbacks never close over stale values
  const trimStartRef = useRef(0);
  const trimEndRef   = useRef(duration);
  useEffect(() => { trimStartRef.current = trimStart; }, [trimStart]);
  useEffect(() => { trimEndRef.current   = trimEnd;   }, [trimEnd]);

  // Drag state — stored in refs to avoid re-renders on every pointermove
  const dragging = useRef<"start" | "end" | null>(null);

  // Audio tracks
  const defaultTracks = (
    info.audio_tracks ?? [{ index: 0, label: "Audio", language: "" }]
  ).map(t => ({
    index:   t.index,
    label:   t.label || `Track ${t.index + 1}`,
    volume:  100,
    deleted: false,
  }));
  const [tracks, setTracks] = useState(defaultTracks);

  const isDark     = theme === "dark";
  const fillColor  = isDark ? "#888888" : "#555555";
  const emptyColor = isDark ? "#333336" : "#d0d0d0";

  // Tauri asset URL — no crossOrigin to avoid CORS issues on tauri:// protocol
  const videoSrc = convertFileSrc(filePath);

  // Force reload when src changes
  useEffect(() => {
    const v = videoRef.current;
    if (v) v.load();
  }, [videoSrc]);

  // ── Pause at trimEnd & track currentTime ───────────────────────────────
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => {
      setCurrentTime(v.currentTime);
      if (v.currentTime >= trimEndRef.current) {
        v.pause();
        v.currentTime = trimEndRef.current;
        setPlaying(false);
      }
    };
    const onPlay  = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("play",       onPlay);
    v.addEventListener("pause",      onPause);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("play",       onPlay);
      v.removeEventListener("pause",      onPause);
    };
  }, []);

  // ── Play / pause ───────────────────────────────────────────────────────
  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      if (v.currentTime >= trimEndRef.current) v.currentTime = trimStartRef.current;
      v.play();
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
      // Bare track click → seek (clamped to trim region)
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
      if (videoRef.current && videoRef.current.currentTime < clamped) {
        videoRef.current.currentTime = clamped;
        setCurrentTime(clamped);
      }
    } else {
      const clamped = Math.max(trimStartRef.current + 0.1, Math.min(t, duration));
      setTrimEnd(clamped);
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
  const playPct   = duration > 0 ? (currentTime / duration) * 100 : 0;
  const startPct  = duration > 0 ? (trimStart   / duration) * 100 : 0;
  const endPct    = duration > 0 ? (trimEnd     / duration) * 100 : 100;
  const clipLen   = trimEnd - trimStart;

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
          key={videoSrc}
          ref={videoRef}
          src={videoSrc}
          preload="auto"
          playsInline
          onLoadedMetadata={() => {
            const v = videoRef.current;
            if (v) v.currentTime = 0;
          }}
          tabIndex={-1}
        />
      </div>

      {/* ── PLAYBACK CONTROLS ──────────────────────────────────────────── */}
      <div className="veditor-controls">
        <button
          className="veditor-play-btn"
          onClick={togglePlay}
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6"  y="4" width="4" height="16" rx="1"/>
              <rect x="14" y="4" width="4" height="16" rx="1"/>
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5,3 19,12 5,21"/>
            </svg>
          )}
        </button>

        <span className="veditor-time">
          {fmtTime(currentTime)}&nbsp;/&nbsp;{fmtTime(duration)}
        </span>

        {/* ── Unified trim timeline ── */}
        <div
          ref={timelineRef}
          className="veditor-timeline-track"
          onPointerDown={onTimelinePointerDown}
          onPointerMove={onTimelinePointerMove}
          onPointerUp={onTimelinePointerUp}
          onPointerCancel={onTimelinePointerUp}
        >
          {/* Base rail */}
          <div className="vtl-bg" />

          {/* Dimmed regions outside the trim window */}
          <div className="vtl-dim" style={{ left: 0, width: `${startPct}%` }} />
          <div className="vtl-dim" style={{ left: `${endPct}%`, right: 0 }} />

          {/* Active (in-trim) region */}
          <div className="vtl-active" style={{ left: `${startPct}%`, width: `${endPct - startPct}%` }} />

          {/* Playhead */}
          <div className="vtl-playhead" style={{ left: `${playPct}%` }} />

          {/* Trim start handle */}
          <div className="vtl-handle vtl-handle-start" style={{ left: `${startPct}%` }}>
            <div className="vtl-handle-bar" />
            <div className="vtl-handle-time">{fmtTime(trimStart)}</div>
          </div>

          {/* Trim end handle */}
          <div className="vtl-handle vtl-handle-end" style={{ left: `${endPct}%` }}>
            <div className="vtl-handle-bar" />
            <div className="vtl-handle-time">{fmtTime(trimEnd)}</div>
          </div>
        </div>

        <span className="veditor-time" style={{ opacity: 0.6, fontSize: 10 }}>
          clip&nbsp;{fmtTime(clipLen)}
        </span>
      </div>

      {/* ── VIDEO TRACK LABEL ──────────────────────────────────────────── */}
      <div className="veditor-track-section">
        <span className="veditor-section-label">Video Track</span>
        <div className="veditor-video-track-row">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.6 }}>
            <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/>
            <line x1="7" y1="2" x2="7" y2="22"/>
            <line x1="17" y1="2" x2="17" y2="22"/>
            <line x1="2" y1="12" x2="22" y2="12"/>
            <line x1="2" y1="7" x2="7" y2="7"/>
            <line x1="2" y1="17" x2="7" y2="17"/>
            <line x1="17" y1="17" x2="22" y2="17"/>
            <line x1="17" y1="7" x2="22" y2="7"/>
          </svg>
          <span className="veditor-track-label">{basename(filePath)}</span>
          <span className="veditor-track-vol-pct" style={{ marginLeft: "auto" }}>{fmtTime(clipLen)}</span>
        </div>
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
            ` · ${tracks.filter(t => t.deleted).length} track(s) removed`}
        </span>
        <button className="veditor-cancel"  onClick={onCancel}>Cancel</button>
        <button className="veditor-confirm" onClick={confirm}>Confirm &amp; Back to Settings</button>
      </div>
    </div>
  );
}
