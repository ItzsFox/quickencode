import { useEffect, useRef, useState, useCallback } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { VideoEdits } from "./App";

interface AudioTrackInfo {
  index:    number;
  label:    string;
  language: string;
}
interface VideoInfo {
  duration_secs: number;
  width:         number;
  height:        number;
  audio_tracks?: AudioTrackInfo[];
}

interface TrackState {
  index:   number;
  label:   string;
  volume:  number;   // 0–200
  deleted: boolean;
}

interface Props {
  filePath:     string;
  info:         VideoInfo;
  theme:        "light" | "dark";
  initialEdits?: VideoEdits;
  onConfirm:    (edits: VideoEdits) => void;
  onCancel:     () => void;
}

function fmtTime(s: number) {
  const m   = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1).padStart(4, "0");
  return `${m}:${sec}`;
}

export default function VideoEditor({ filePath, info, theme: _theme, initialEdits, onConfirm, onCancel }: Props) {
  const duration = info.duration_secs;

  // ── initialise from saved edits or defaults ──────────────────────────────
  const initTrimStart = initialEdits?.trimStart ?? 0;
  const initTrimEnd   = initialEdits?.trimEnd   ?? duration;

  const defaultTracks = (): TrackState[] => {
    const tracks = info.audio_tracks ?? [{ index: 0, label: "Audio 1", language: "" }];
    return tracks.map(t => {
      const saved = initialEdits?.audioTracks.find(a => a.index === t.index);
      return {
        index:   t.index,
        label:   t.label || `Audio ${t.index + 1}`,
        volume:  saved?.volume  ?? 100,
        deleted: saved?.deleted ?? false,
      };
    });
  };

  const [trimStart, setTrimStart] = useState(initTrimStart);
  const [trimEnd,   setTrimEnd]   = useState(initTrimEnd);
  const [current,   setCurrent]   = useState(initTrimStart);
  const [playing,   setPlaying]   = useState(false);
  const [tracks,    setTracks]    = useState<TrackState[]>(defaultTracks);

  const videoRef    = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  // ── Web Audio API for per-track volume control ───────────────────────────
  const audioCtxRef   = useRef<AudioContext | null>(null);
  // gainNodes[trackIndex] = GainNode
  const gainNodesRef  = useRef<Map<number, GainNode>>(new Map());
  const sourceRef     = useRef<MediaElementAudioSourceNode | null>(null);
  const audioReadyRef = useRef(false);

  const buildAudioGraph = useCallback(() => {
    const video = videoRef.current;
    if (!video || audioReadyRef.current) return;
    try {
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaElementSource(video);
      sourceRef.current = src;

      // For a single MediaElement source we can only have one gain chain
      // that controls the overall mix. True per-track routing requires
      // separate source nodes per ffmpeg-demuxed stream, which isn't
      // possible in the browser for a single <video>. Instead we keep
      // one GainNode per track and the combined gain = product of active
      // track gains. We update the master gain whenever any volume changes.
      const masterGain = ctx.createGain();
      gainNodesRef.current.set(-1, masterGain); // -1 = master
      src.connect(masterGain);
      masterGain.connect(ctx.destination);
      audioReadyRef.current = true;
    } catch {
      // AudioContext unavailable – fall back to video.volume
      audioReadyRef.current = false;
    }
  }, []);

  // Recalculate master gain whenever track volumes/deleted state changes.
  // We compute the average of all non-deleted volumes (0-200) normalised to 0-2.
  const applyVolumes = useCallback((currentTracks: TrackState[]) => {
    const video = videoRef.current;
    if (!video) return;

    const active = currentTracks.filter(t => !t.deleted);
    if (active.length === 0) {
      video.volume = 0;
      return;
    }

    // Average volume percentage of active tracks, normalised 0-2
    const avg = active.reduce((sum, t) => sum + t.volume, 0) / active.length / 100;
    const clamped = Math.min(2, Math.max(0, avg));

    const master = gainNodesRef.current.get(-1);
    if (master) {
      master.gain.setTargetAtTime(clamped, audioCtxRef.current!.currentTime, 0.01);
    } else {
      // Fallback: browser video volume only goes 0-1
      video.volume = Math.min(1, clamped);
    }
  }, []);

  useEffect(() => {
    applyVolumes(tracks);
  }, [tracks, applyVolumes]);

  // ── space-bar play/pause ─────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === "Space") {
        e.preventDefault();
        setPlaying(p => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── sync playing state ───────────────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (playing) {
      // Resume AudioContext if suspended (browser autoplay policy)
      audioCtxRef.current?.resume();
      video.play().catch(() => setPlaying(false));
    } else {
      video.pause();
    }
  }, [playing]);

  // ── timeupdate: track current, enforce trim end ──────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => {
      setCurrent(video.currentTime);
      if (video.currentTime >= trimEnd) {
        video.pause();
        video.currentTime = trimEnd;
        setPlaying(false);
        setCurrent(trimEnd);
      }
    };
    video.addEventListener("timeupdate", onTime);
    return () => video.removeEventListener("timeupdate", onTime);
  }, [trimEnd]);

  // ── seek video when current changes externally (trim handle drag) ────────
  const seekVideo = useCallback((t: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = t;
  }, []);

  // ── timeline drag helpers ────────────────────────────────────────────────
  type DragTarget = "start" | "end" | "seek";

  const pxToTime = useCallback((clientX: number): number => {
    const el = timelineRef.current;
    if (!el) return 0;
    const { left, width } = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - left) / width));
    return ratio * duration;
  }, [duration]);

  const startDrag = useCallback((target: DragTarget, e: React.PointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const t = pxToTime(ev.clientX);
      if (target === "start") {
        const newStart = Math.max(0, Math.min(t, trimEnd - 0.1));
        setTrimStart(newStart);
        // If playhead is before new start, snap it forward
        setCurrent(prev => {
          const next = Math.max(prev, newStart);
          seekVideo(next);
          return next;
        });
      } else if (target === "end") {
        const newEnd = Math.min(duration, Math.max(t, trimStart + 0.1));
        setTrimEnd(newEnd);
        // If playhead is past new end, snap it back
        setCurrent(prev => {
          const next = Math.min(prev, newEnd);
          seekVideo(next);
          return next;
        });
      } else {
        // seek click — only within trim region
        const clamped = Math.max(trimStart, Math.min(trimEnd, t));
        setCurrent(clamped);
        seekVideo(clamped);
      }
    };

    const onUp = () => {
      el.removeEventListener("pointermove", onMove as EventListener);
      el.removeEventListener("pointerup",   onUp);
    };
    el.addEventListener("pointermove", onMove as EventListener);
    el.addEventListener("pointerup",   onUp);
  }, [pxToTime, trimEnd, trimStart, duration, seekVideo]);

  // ── timeline click to seek ───────────────────────────────────────────────
  const onTimelineClick = useCallback((e: React.MouseEvent) => {
    const t = pxToTime(e.clientX);
    const clamped = Math.max(trimStart, Math.min(trimEnd, t));
    setCurrent(clamped);
    seekVideo(clamped);
  }, [pxToTime, trimStart, trimEnd, seekVideo]);

  // ── confirm ──────────────────────────────────────────────────────────────
  const handleConfirm = () => {
    onConfirm({
      trimStart,
      trimEnd,
      audioTracks: tracks.map(t => ({ index: t.index, volume: t.volume, deleted: t.deleted })),
    });
  };

  // ── volume change ─────────────────────────────────────────────────────────
  const setVolume = (index: number, vol: number) => {
    setTracks(prev => prev.map(t => t.index === index ? { ...t, volume: vol } : t));
  };
  const deleteTrack = (index: number) => {
    setTracks(prev => prev.map(t => t.index === index ? { ...t, deleted: true } : t));
  };
  const restoreTrack = (index: number) => {
    setTracks(prev => prev.map(t => t.index === index ? { ...t, deleted: false } : t));
  };

  // ── percentage helpers for CSS ───────────────────────────────────────────
  const pct = (t: number) => `${(t / duration) * 100}%`;

  const src = convertFileSrc(filePath);

  return (
    <div className="veditor-overlay">
      {/* Header */}
      <div className="veditor-header">
        <div className="veditor-header-left">
          <span className="veditor-title">Video Editor</span>
          <span className="veditor-filename">{filePath.split(/[\\\/]/).pop()}</span>
        </div>
        <button className="veditor-close" onClick={onCancel} aria-label="Close editor">&times;</button>
      </div>

      {/* Video */}
      <div className="veditor-video-wrap">
        <video
          ref={videoRef}
          src={src}
          onLoadedMetadata={() => {
            const video = videoRef.current;
            if (!video) return;
            video.currentTime = trimStart;
            buildAudioGraph();
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          playsInline
          preload="auto"
        />
      </div>

      {/* Playback controls + timeline */}
      <div className="veditor-controls">
        <button
          className="veditor-play-btn"
          onClick={() => setPlaying(p => !p)}
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? (
            <svg width="11" height="13" viewBox="0 0 11 13" fill="currentColor">
              <rect x="0" y="0" width="4" height="13" rx="1"/>
              <rect x="7" y="0" width="4" height="13" rx="1"/>
            </svg>
          ) : (
            <svg width="11" height="13" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5,3 19,12 5,21"/>
            </svg>
          )}
        </button>

        <span className="veditor-time">{fmtTime(current)}</span>

        {/* Timeline track */}
        <div
          className="veditor-timeline-track"
          ref={timelineRef}
          onClick={onTimelineClick}
        >
          {/* background bar */}
          <div className="vtl-bg" />

          {/* dimmed region before trim start */}
          <div className="vtl-dim" style={{ left: 0, width: pct(trimStart) }} />
          {/* dimmed region after trim end */}
          <div className="vtl-dim" style={{ left: pct(trimEnd), right: 0, width: undefined }} />

          {/* active region */}
          <div className="vtl-active" style={{ left: pct(trimStart), width: pct(trimEnd - trimStart) }} />

          {/* playhead */}
          <div className="vtl-playhead" style={{ left: pct(current) }} />

          {/* trim start handle */}
          <div
            className="vtl-handle"
            style={{ left: pct(trimStart) }}
            onPointerDown={e => startDrag("start", e)}
          >
            <div className="vtl-handle-bar" />
            <span className="vtl-handle-time">{fmtTime(trimStart)}</span>
          </div>

          {/* trim end handle */}
          <div
            className="vtl-handle"
            style={{ left: pct(trimEnd) }}
            onPointerDown={e => startDrag("end", e)}
          >
            <div className="vtl-handle-bar" />
            <span className="vtl-handle-time">{fmtTime(trimEnd)}</span>
          </div>
        </div>

        <span className="veditor-time">{fmtTime(duration)}</span>
      </div>

      {/* Video track info */}
      <div className="veditor-track-section">
        <span className="veditor-section-label">Video Track</span>
        <div className="veditor-video-track-row">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/>
            <line x1="7" y1="2" x2="7" y2="22"/>
            <line x1="17" y1="2" x2="17" y2="22"/>
            <line x1="2" y1="12" x2="22" y2="12"/>
            <line x1="2" y1="7" x2="7" y2="7"/>
            <line x1="2" y1="17" x2="7" y2="17"/>
            <line x1="17" y1="17" x2="22" y2="17"/>
            <line x1="17" y1="7" x2="22" y2="7"/>
          </svg>
          <span className="veditor-track-label">{filePath.split(/[\\\/]/).pop()}</span>
          <span className="veditor-track-vol-pct" style={{ marginLeft: "auto" }}>
            {fmtTime(trimEnd - trimStart)} of {fmtTime(duration)}
          </span>
        </div>
      </div>

      {/* Audio tracks */}
      <div className="veditor-audio">
        <span className="veditor-section-label">Audio Tracks</span>
        {tracks.map(track => (
          <div key={track.index} className={`veditor-track-row${track.deleted ? " veditor-track-deleted" : ""}`}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              {!track.deleted && track.volume > 0 && (
                <>
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
                </>
              )}
            </svg>
            <span className="veditor-track-label">{track.label}</span>
            {track.deleted ? (
              <button className="veditor-track-restore" onClick={() => restoreTrack(track.index)}>
                Restore
              </button>
            ) : (
              <>
                <div className="veditor-track-vol-wrap">
                  <input
                    type="range"
                    min={0}
                    max={200}
                    value={track.volume}
                    onChange={e => setVolume(track.index, Number(e.target.value))}
                    aria-label={`Volume for ${track.label}`}
                  />
                  <span className="veditor-track-vol-pct">{track.volume}%</span>
                </div>
                <button
                  className="veditor-track-delete"
                  onClick={() => deleteTrack(track.index)}
                  aria-label={`Delete ${track.label}`}
                  title="Delete this audio track"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6l-1 14H6L5 6"/>
                    <path d="M10 11v6"/>
                    <path d="M14 11v6"/>
                    <path d="M9 6V4h6v2"/>
                  </svg>
                </button>
              </>
            )}
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="veditor-footer">
        <span className="veditor-trim-summary">
          Trim: {fmtTime(trimStart)} &rarr; {fmtTime(trimEnd)}
          &nbsp;&middot;&nbsp;
          Duration: {fmtTime(trimEnd - trimStart)}
        </span>
        <button className="veditor-cancel" onClick={onCancel}>Cancel</button>
        <button className="veditor-confirm" onClick={handleConfirm}>Confirm &amp; Back</button>
      </div>
    </div>
  );
}
