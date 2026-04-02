import { useEffect, useRef, useState, useCallback } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { VideoInfo, VideoEdits, AudioTrackInfo } from "./types";

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

type DragTarget = "start" | "end" | null;

// ── component ──────────────────────────────────────────────────────────────
export default function VideoEditor({ filePath, info, theme, onConfirm, onCancel }: Props) {
  const duration = info.duration_secs;
  const videoRef    = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  const [playing,     setPlaying]     = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [trimStart,   setTrimStart]   = useState(0);
  const [trimEnd,     setTrimEnd]     = useState(duration);

  // Mirror trim state into refs so pointer-move callbacks always read fresh
  // values without needing to be re-created on every state change.
  const trimStartRef = useRef(0);
  const trimEndRef   = useRef(duration);
  useEffect(() => { trimStartRef.current = trimStart; }, [trimStart]);
  useEffect(() => { trimEndRef.current   = trimEnd;   }, [trimEnd]);

  // Drag state stored in refs (no re-render on every mousemove)
  const dragging    = useRef<DragTarget>(null);
  const dragStartX  = useRef(0);
  const dragStartTs = useRef(0);

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

  const isDark    = theme === "dark";
  const fillColor  = isDark ? "#888888" : "#555555";
  const emptyColor = isDark ? "#333336" : "#d0d0d0";

  // ── video src via Tauri asset protocol ───────────────────────────────────
  // convertFileSrc turns an absolute OS path into tauri://localhost/... so
  // WKWebView / WebView2 can load it without CORS issues.
  const videoSrc = convertFileSrc(filePath);

  // ── sync playhead when video ticks ───────────────────────────────────────
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
    v.addEventListener("timeupdate",    onTime);
    v.addEventListener("play",          onPlay);
    v.addEventListener("pause",         onPause);
    return () => {
      v.removeEventListener("timeupdate",    onTime);
      v.removeEventListener("play",          onPlay);
      v.removeEventListener("pause",         onPause);
    };
  // trimEndRef is a ref — only needs to run once on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── play / pause ─────────────────────────────────────────────────────────
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

  // ── space bar ─────────────────────────────────────────────────────────────
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

  // ── seek helper ──────────────────────────────────────────────────────────
  const seekTo = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    const clamped = Math.max(0, Math.min(duration, t));
    v.currentTime = clamped;
    setCurrentTime(clamped);
  }, [duration]);

  // ── pointer-event drag for trim handles ─────────────────────────────────
  // THUMB_HIT: px radius around a handle centre that counts as a handle grab.
  // Kept tight (10px) so bare-track clicks reliably seek instead of dragging.
  const THUMB_HIT = 10;

  const onTimelinePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const el = timelineRef.current;
    if (!el || duration <= 0) return;
    const rect   = el.getBoundingClientRect();
    const ratio  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const clickT = ratio * duration;
    const clickPx = ratio * rect.width;

    // Use ref values so we always have the latest trim positions
    const startPx = (trimStartRef.current / duration) * rect.width;
    const endPx   = (trimEndRef.current   / duration) * rect.width;

    const nearStart = Math.abs(clickPx - startPx) <= THUMB_HIT;
    const nearEnd   = Math.abs(clickPx - endPx)   <= THUMB_HIT;

    if (nearStart || nearEnd) {
      // When both handles are within hit range pick by which side of the
      // midpoint the click landed on.
      const target: DragTarget = (nearStart && nearEnd)
        ? (clickPx >= (startPx + endPx) / 2 ? "end" : "start")
        : nearStart ? "start" : "end";

      dragging.current    = target;
      dragStartX.current  = e.clientX;
      dragStartTs.current = target === "start" ? trimStartRef.current : trimEndRef.current;
      el.setPointerCapture(e.pointerId);
      e.stopPropagation();
    } else {
      // Bare track click → seek video to that position
      seekTo(clickT);
    }
  }, [duration, seekTo]);

  const onTimelinePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current || !timelineRef.current || duration <= 0) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const dx   = e.clientX - dragStartX.current;
    const dt   = (dx / rect.width) * duration;
    const newT = Math.max(0, Math.min(duration, dragStartTs.current + dt));

    if (dragging.current === "start") {
      // Read trimEndRef so we never rely on a stale closure value
      setTrimStart(Math.min(newT, trimEndRef.current - 0.1));
    } else {
      setTrimEnd(Math.max(newT, trimStartRef.current + 0.1));
    }
  }, [duration]);

  const onTimelinePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    timelineRef.current?.releasePointerCapture(e.pointerId);
    dragging.current = null;
  }, []);

  // ── audio helpers ────────────────────────────────────────────────────────
  const handleVolume  = (i: number, v: number) =>
    setTracks(prev => prev.map((t, idx) => idx === i ? { ...t, volume: v } : t));
  const handleDelete  = (i: number) =>
    setTracks(prev => prev.map((t, idx) => idx === i ? { ...t, deleted: true } : t));
  const handleRestore = (i: number) =>
    setTracks(prev => prev.map((t, idx) => idx === i ? { ...t, deleted: false } : t));

  // ── confirm ───────────────────────────────────────────────────────────────
  const confirm = () => onConfirm({
    trimStart,
    trimEnd,
    audioTracks: tracks.map(t => ({ index: t.index, volume: t.volume, deleted: t.deleted })),
  });

  // ── derived layout percentages ────────────────────────────────────────────
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
        <button className="veditor-close" onClick={onCancel} aria-label="Close">&times;</button>
      </div>

      {/* ── VIDEO ─────────────────────────────────────────────────────── */}
      <div className="veditor-video-wrap">
        <video
          ref={videoRef}
          src={videoSrc}
          crossOrigin="anonymous"
          preload="auto"
          playsInline
          onLoadedMetadata={() => {
            const v = videoRef.current;
            if (v) v.currentTime = 0;
          }}
          tabIndex={-1}
        />
      </div>

      {/* ── PLAYBACK BAR ─────────────────────────────────────────────── */}
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
        <span className="veditor-time veditor-clip-len">
          clip:&nbsp;{fmtTime(clipLen)}
        </span>
      </div>

      {/* ── UNIFIED TIMELINE ─────────────────────────────────────────── */}
      {/*
        Single timeline bar that combines:
          • Playhead scrub (click bare track → seek)
          • Trim in/out handles (drag the bookend handles only)
        All pointer events are handled by custom logic — no <input type=range>.
      */}
      <div className="veditor-timeline">
        <div className="veditor-timeline-labels">
          <span className="veditor-section-label">Timeline</span>
          <span className="veditor-trim-stamps">
            <span>{fmtTime(trimStart)}</span>
            <span style={{ color: "var(--text-faint)" }}>–</span>
            <span>{fmtTime(trimEnd)}</span>
          </span>
        </div>

        {/* The interactive track */}
        <div
          ref={timelineRef}
          className="veditor-track-container"
          onPointerDown={onTimelinePointerDown}
          onPointerMove={onTimelinePointerMove}
          onPointerUp={onTimelinePointerUp}
          onPointerCancel={onTimelinePointerUp}
        >
          {/* Base rail */}
          <div className="veditor-rail" />

          {/* Dim region before trimStart */}
          <div className="veditor-rail-dim" style={{ left: 0, width: `${startPct}%` }} />

          {/* Active (selected) region */}
          <div className="veditor-rail-active"
            style={{ left: `${startPct}%`, width: `${endPct - startPct}%` }} />

          {/* Dim region after trimEnd */}
          <div className="veditor-rail-dim" style={{ left: `${endPct}%`, right: 0 }} />

          {/* Playhead needle */}
          <div className="veditor-playhead" style={{ left: `${playPct}%` }} />

          {/* Trim start handle */}
          <div
            className="veditor-trim-handle veditor-trim-handle-start"
            style={{ left: `${startPct}%` }}
            title="Drag to set clip start"
          />

          {/* Trim end handle */}
          <div
            className="veditor-trim-handle veditor-trim-handle-end"
            style={{ left: `${endPct}%` }}
            title="Drag to set clip end"
          />
        </div>

        <div className="veditor-timeline-edge-labels">
          <span>{fmtTime(0)}</span>
          <span>{fmtTime(duration)}</span>
        </div>
      </div>

      {/* ── AUDIO TRACKS ─────────────────────────────────────────────── */}
      {tracks.length > 0 && (
        <div className="veditor-audio">
          <span className="veditor-section-label">Audio Tracks</span>
          {tracks.map((t, i) => (
            <div key={t.index} className={`veditor-track-row${t.deleted ? " veditor-track-deleted" : ""}`}>
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
                  />
                  <span className="veditor-track-vol-pct">{t.volume}%</span>
                </div>
              )}

              <button
                className="veditor-track-delete"
                onClick={() => t.deleted ? handleRestore(i) : handleDelete(i)}
                title={t.deleted ? "Restore" : "Remove track"}
                aria-label={t.deleted ? "Restore" : "Remove track"}
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

      {/* ── FOOTER ───────────────────────────────────────────────────── */}
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
