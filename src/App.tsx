import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";

interface VideoInfo {
  duration_secs: number;
  size_mb:       number;
  bitrate_kbps:  number;
  width:         number;
  height:        number;
}
interface EncodeProgress {
  percent:  number;
  eta_secs: number;
  pass:     number;
}
interface BatchFile {
  path:   string;
  status: "pending" | "active" | "done" | "error";
  msg?:   string;
}
interface DoneResult {
  outputPath: string;
  originalMb: number;
  finalMb:    number;
}
interface BatchDoneResult {
  total:     number;
  succeeded: number;
  failed:    number;
  outputDir: string;
}

const FRAME_COUNT    = 10;
const DISCORD_TARGET = 9;
const DISCORD_AUDIO  = 96;
const VIDEO_EXTS     = new Set(["mp4","mkv","avi","mov","webm","m4v","wmv","flv","ts","mts"]);
const RES_BITRATES: Record<string, number> = {
  "1080p": 5000, "720p": 2500, "480p": 1000,
};

function fmtTime(s: number) {
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`
    : `${m}:${String(sec).padStart(2,"0")}`;
}
function fmtMb(mb: number) {
  return mb >= 1024 ? `${(mb/1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}
function fmtEta(s: number) {
  if (s <= 0) return "—";
  if (s < 60) return `${Math.ceil(s)}s`;
  return `${Math.floor(s/60)}m ${Math.ceil(s%60)}s`;
}
function sliderBg(val: number, min: number, max: number, fill: string, empty: string) {
  const pct = ((val - min) / (max - min)) * 100;
  return `linear-gradient(to right, ${fill} ${pct}%, ${empty} ${pct}%)`;
}
function qualityInfo(q: number) {
  if (q >= 85) return { label: "Near Lossless", cls: "c4" };
  if (q >= 65) return { label: "High Quality",  cls: "c3" };
  if (q >= 40) return { label: "Balanced",       cls: "c2" };
  if (q >= 20) return { label: "Low Quality",    cls: "c1" };
  return             { label: "Very Low",         cls: "c0" };
}
function basename(p: string) { return p.split(/[\\\/]/).pop() ?? p; }
function discordBr(dur: number) {
  return Math.max(Math.floor((DISCORD_TARGET * 8 * 1024) / dur) - DISCORD_AUDIO, 80);
}
function frameTs(i: number, duration: number) {
  return duration * (i + 0.5) / FRAME_COUNT;
}
function gcd(a: number, b: number): number { return b === 0 ? a : gcd(b, a % b); }
function isVideo(p: string) {
  return VIDEO_EXTS.has((p.split(".").pop() ?? "").toLowerCase());
}

const QELogo = ({ size = 20 }: { size?: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 85 85" fill="currentColor" aria-label="quick encode logo" style={{ flexShrink: 0, display: "block" }}>
    <path d="M80 30C82.7614 30 85 32.2386 85 35V80C85 82.7614 82.7614 85 80 85H35C32.2386 85 30 82.7614 30 80V69H65C67.2091 69 69 67.2091 69 65V30H80ZM65 16C67.2091 16 69 17.7909 69 20V30H55V50C55 52.7614 52.7614 55 50 55H30V69H20C17.7909 69 16 67.2091 16 65V55H30V35C30 32.2386 32.2386 30 35 30H55V16H65ZM50 0C52.7614 0 55 2.23858 55 5V16H20C17.7909 16 16 17.7909 16 20V55H5C2.23858 55 0 52.7614 0 50V5C0 2.23858 2.23858 0 5 0H50Z" />
  </svg>
);

const DiscordIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057.1 18.08.114 18.1.131 18.111a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
  </svg>
);

type Screen = "drop" | "loading" | "editor" | "batch" | "done" | "batch-done";

export default function App() {
  const initTheme = (): "light" | "dark" => {
    try { return (localStorage.getItem("qe_theme") as "light" | "dark") ?? "light"; }
    catch { return "light"; }
  };
  const [theme, setThemeState] = useState<"light" | "dark">(initTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("qe_theme", theme); } catch {}
  }, [theme]);
  useEffect(() => { document.documentElement.setAttribute("data-theme", theme); }, []);

  const toggleTheme = (e: React.MouseEvent) => {
    e.stopPropagation();
    setThemeState(t => t === "light" ? "dark" : "light");
  };

  const [screen, setScreen]         = useState<Screen>("drop");
  const [filePath, setFilePath]     = useState("");
  const [info, setInfo]             = useState<VideoInfo | null>(null);
  const [dragOver, setDragOver]     = useState(false);
  const [origFrames, setOrigFrames] = useState<string[]>([]);
  const [encFrames, setEncFrames]   = useState<Record<number, string>>({});
  const [encLoading, setEncLoading] = useState(false);
  const [frameIdx, setFrameIdx]     = useState(0);
  const [resolution, setRes]        = useState("original");
  const [format, setFmt]            = useState("mp4");
  const [quality, setQuality]       = useState(75);
  const [audio, setAudio]           = useState(128);
  const [fps, setFps]               = useState("original");
  const [encoding, setEncoding]     = useState(false);
  const [progress, setProgress]     = useState<EncodeProgress | null>(null);
  const [fsImage, setFsImage]       = useState<{src: string; label: string} | null>(null);
  const [status, setStatus]         = useState("");
  const [doneResult, setDoneResult] = useState<DoneResult | null>(null);

  const [batchFiles, setBatchFiles]             = useState<BatchFile[]>([]);
  const [batchProgress, setBatchProgress]       = useState<{idx: number; enc: EncodeProgress; currentFile: string} | null>(null);
  const [batchRunning, setBatchRunning]         = useState(false);
  const [batchDiscordMode, setBatchDiscordMode] = useState(false);
  const [batchDoneResult, setBatchDoneResult]   = useState<BatchDoneResult | null>(null);

  const encDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const base    = resolution === "original" ? (info?.bitrate_kbps ?? 5000) : RES_BITRATES[resolution];
  const videoBr = Math.max(Math.round(base * (quality / 100)), 80);
  const estMb   = info ? ((videoBr + audio) * info.duration_secs) / 8 / 1024 : 0;
  const estLow  = estMb * 0.85;
  const estHigh = estMb * 1.15;
  const reduction = info ? Math.round((1 - estMb / info.size_mb) * 100) : 0;

  const loadEncodedFrame = useCallback((idx: number, vbr: number, res: string, f: string) => {
    if (!filePath || !info) return;
    if (encDebounce.current) clearTimeout(encDebounce.current);
    setEncLoading(true);
    encDebounce.current = setTimeout(async () => {
      const ts = frameTs(idx, info.duration_secs);
      try {
        const result = await invoke<string>("get_encoded_frame", {
          input: filePath, timestamp: ts, resolution: res,
          videoBitrateKbps: vbr, fps: f,
        });
        setEncFrames(prev => ({ ...prev, [idx]: result }));
      } catch (e) {
        setStatus(`Preview failed: ${e}`);
      } finally {
        setEncLoading(false);
      }
    }, 600);
  }, [filePath, info]);

  useEffect(() => {
    if (screen !== "editor" || !info) return;
    setEncFrames({});
    loadEncodedFrame(frameIdx, videoBr, resolution, fps);
  }, [videoBr, resolution, fps, screen]);

  useEffect(() => {
    if (screen !== "editor" || !info) return;
    if (!encFrames[frameIdx]) loadEncodedFrame(frameIdx, videoBr, resolution, fps);
  }, [frameIdx]);

  const loadFile = useCallback(async (path: string) => {
    setScreen("loading");
    setFilePath(path);
    setOrigFrames([]);
    setEncFrames({});
    setFrameIdx(0);
    setStatus("");
    setDoneResult(null);
    try {
      const [videoInfo, frames] = await Promise.all([
        invoke<VideoInfo>("get_video_info", { input: path }),
        invoke<string[]>("get_video_frames", { input: path, count: FRAME_COUNT }),
      ]);
      setInfo(videoInfo);
      setOrigFrames(frames);
      setScreen("editor");
      const b = resolution === "original" ? videoInfo.bitrate_kbps : (RES_BITRATES[resolution] ?? videoInfo.bitrate_kbps);
      const vbr = Math.max(Math.round(b * (quality / 100)), 80);
      loadEncodedFrame(0, vbr, resolution, fps);
    } catch (e) {
      setStatus(`❌ ${e}`);
      setScreen("drop");
    }
  }, [resolution, quality, fps]);

  const resolveDroppedPaths = useCallback(async (paths: string[]): Promise<string[]> => {
    const videos: string[] = [];
    for (const p of paths) {
      if (isVideo(p)) {
        videos.push(p);
      } else {
        try {
          const found = await invoke<string[]>("scan_folder_for_videos", { folder: p });
          videos.push(...found);
        } catch { /* skip */ }
      }
    }
    return videos;
  }, []);

  useEffect(() => {
    let off: (() => void) | undefined;
    getCurrentWebview().onDragDropEvent(async (ev) => {
      const t = ev.payload.type;
      if (t === "over")  setDragOver(true);
      if (t === "leave") setDragOver(false);
      if (t === "drop") {
        setDragOver(false);
        const raw = (ev.payload as any).paths as string[];
        if (!raw?.length) return;
        const resolved = await resolveDroppedPaths(raw);
        if (!resolved.length) {
          setStatus("No video files found in dropped items.");
          return;
        }
        if (resolved.length === 1) {
          loadFile(resolved[0]);
        } else {
          setBatchFiles(resolved.map(p => ({ path: p, status: "pending" })));
          setScreen("batch");
        }
      }
    }).then(fn => { off = fn; });
    return () => off?.();
  }, [loadFile, resolveDroppedPaths]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<EncodeProgress>("encode-progress", (ev) => {
      setProgress(ev.payload);
    }).then(fn => { unlisten = fn; });
    return () => unlisten?.();
  }, []);

  const pickFiles = async () => {
    const result = await open({
      multiple: true,
      filters: [{ name: "Video", extensions: ["mp4","mkv","avi","mov","webm","m4v","wmv","flv","ts","mts"] }],
    }) as string[] | string | null;
    if (!result) return;
    const paths = Array.isArray(result) ? result : [result];
    if (paths.length === 0) return;
    if (paths.length === 1) { loadFile(paths[0]); return; }
    setBatchFiles(paths.map(p => ({ path: p, status: "pending" })));
    setScreen("batch");
  };

  const goFrame = (delta: number) =>
    setFrameIdx(i => Math.max(0, Math.min(FRAME_COUNT - 1, i + delta)));

  const runEncode = async (vbr: number, abr: number, res: string, f: string, outPath?: string) => {
    if (!filePath || !info) return;
    const out = outPath ?? await save({ filters: [{ name: "Output", extensions: [format] }] });
    if (!out) return;
    setEncoding(true);
    setProgress({ percent: 0, eta_secs: 0, pass: 1 });
    try {
      await invoke("encode_video_with_progress", {
        input: filePath, output: out,
        resolution: res, videoBitrateKbps: vbr,
        audioBitrateKbps: abr, fps: f,
        durationSecs: info.duration_secs,
      });
      let finalMb = estMb;
      try { finalMb = await invoke<number>("get_file_size_mb", { path: out }); } catch {}
      setDoneResult({ outputPath: out, originalMb: info.size_mb, finalMb });
      setScreen("done");
    } catch (e) {
      setStatus(`❌ ${e}`);
    } finally {
      setEncoding(false);
      setProgress(null);
    }
  };

  const handleEncode  = () => runEncode(videoBr, audio, resolution, fps);
  const handleDiscord = async () => {
    if (!info) return;
    if (info.size_mb <= 10) { setStatus("✅ Already under 10 MB — no compression needed."); return; }
    const vbr = discordBr(info.duration_secs);
    const defaultName = basename(filePath).replace(/\.[^.]+$/, "") + "_discord.mp4";
    const out = await save({ defaultPath: defaultName, filters: [{ name: "MP4", extensions: ["mp4"] }] });
    if (!out) return;
    runEncode(vbr, DISCORD_AUDIO, "original", "original", out);
  };

  const runBatch = async (outputDir: string, discordMode: boolean) => {
    setBatchRunning(true);
    let succeeded = 0;
    let failed = 0;
    for (let i = 0; i < batchFiles.length; i++) {
      const file = batchFiles[i];
      setBatchFiles(prev => prev.map((f, idx) => idx === i ? { ...f, status: "active" } : f));
      setBatchProgress({ idx: i, enc: { percent: 0, eta_secs: 0, pass: 1 }, currentFile: basename(file.path) });
      const inName  = basename(file.path).replace(/\.[^.]+$/, "");
      const suffix  = discordMode ? "_discord" : "_encoded";
      const outFile = `${outputDir}/${inName}${suffix}.mp4`;
      try {
        const infoRaw = await invoke<VideoInfo>("get_video_info", { input: file.path });
        let vbr: number, abr: number, res: string, f: string;
        if (discordMode) {
          vbr = discordBr(infoRaw.duration_secs); abr = DISCORD_AUDIO; res = "original"; f = "original";
        } else {
          const b = resolution === "original" ? infoRaw.bitrate_kbps : (RES_BITRATES[resolution] ?? infoRaw.bitrate_kbps);
          vbr = Math.max(Math.round(b * (quality / 100)), 80); abr = audio; res = resolution; f = fps;
        }
        await invoke("encode_video_with_progress", {
          input: file.path, output: outFile,
          resolution: res, videoBitrateKbps: vbr,
          audioBitrateKbps: abr, fps: f,
          durationSecs: infoRaw.duration_secs,
        });
        setBatchFiles(prev => prev.map((bf, idx) => idx === i ? { ...bf, status: "done" } : bf));
        succeeded++;
      } catch (e) {
        setBatchFiles(prev => prev.map((bf, idx) => idx === i ? { ...bf, status: "error", msg: String(e) } : bf));
        failed++;
      }
    }
    setBatchRunning(false);
    setBatchProgress(null);
    setBatchDoneResult({ total: batchFiles.length, succeeded, failed, outputDir });
    setScreen("batch-done");
  };

  const startBatch = async (discordMode = false) => {
    const dir = await open({ directory: true, multiple: false }) as string | null;
    if (!dir) return;
    setBatchDiscordMode(discordMode);
    runBatch(dir, discordMode);
  };

  const removeBatchFile = (idx: number) =>
    setBatchFiles(prev => prev.filter((_, i) => i !== idx));

  const addMoreFiles = async () => {
    const result = await open({
      multiple: true,
      filters: [{ name: "Video", extensions: ["mp4","mkv","avi","mov","webm","m4v","wmv","flv","ts","mts"] }],
    }) as string[] | null;
    if (!result?.length) return;
    setBatchFiles(prev => [...prev, ...result.map(p => ({ path: p, status: "pending" as const }))]);
  };

  const reset = () => {
    setScreen("drop"); setFilePath(""); setInfo(null);
    setOrigFrames([]); setEncFrames({}); setFrameIdx(0);
    setStatus(""); setProgress(null); setEncoding(false);
    setBatchFiles([]); setBatchRunning(false); setBatchProgress(null);
    setBatchDiscordMode(false); setDoneResult(null); setBatchDoneResult(null);
  };

  const ql          = qualityInfo(quality);
  const currentOrig = origFrames[frameIdx];
  const currentEnc  = encFrames[frameIdx];

  const slBg = (val: number, min: number, max: number) => {
    const isDark = theme === "dark";
    return sliderBg(val, min, max,
      isDark ? "#888888" : "#555555",
      isDark ? "#333336" : "#d0d0d0"
    );
  };

  const Wordmark = ({ size = "base" }: { size?: "sm" | "base" }) => (
    <div className={`wordmark wordmark-${size}`}>
      <QELogo size={size === "sm" ? 14 : 17} />
      <span>quick encode<em>.</em></span>
    </div>
  );

  const ThemeBtn = () => (
    <button className="theme-toggle" onClick={toggleTheme} title={`Switch to ${theme === "light" ? "dark" : "light"} mode`} aria-label="Toggle theme">
      {theme === "light" ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="5"/>
          <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
          <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
        </svg>
      )}
    </button>
  );

  const QualitySettings = () => (
    <>
      <div className="quality-col">
        <div className="quality-header">
          <span className="section-label">Quality</span>
          <div className="quality-values">
            <span className={`q-badge ${ql.cls}`}>{ql.label}</span>
            <span className="q-pct">{quality}%</span>
          </div>
        </div>
        <input type="range" min={5} max={100} value={quality}
          style={{ background: slBg(quality, 5, 100) }}
          onChange={e => setQuality(Number(e.target.value))}
        />
        <div className="range-labels"><span>Smallest</span><span>Best</span></div>
      </div>
      <div className="settings-divider" />
      <div className="options-col">
        <div className="options-grid">
          <div className="setting"><label>Resolution</label>
            <select value={resolution} onChange={e => setRes(e.target.value)}>
              <option value="original">Original</option>
              <option value="1080p">1080p</option>
              <option value="720p">720p</option>
              <option value="480p">480p</option>
            </select>
          </div>
          <div className="setting"><label>Format</label>
            <select value={format} onChange={e => setFmt(e.target.value)}>
              <option value="mp4">MP4</option>
              <option value="mkv">MKV</option>
              <option value="webm">WebM</option>
            </select>
          </div>
          <div className="setting"><label>Audio</label>
            <select value={audio} onChange={e => setAudio(Number(e.target.value))}>
              <option value={64}>64 kbps</option>
              <option value={128}>128 kbps</option>
              <option value={192}>192 kbps</option>
              <option value={256}>256 kbps</option>
            </select>
          </div>
          <div className="setting"><label>FPS</label>
            <select value={fps} onChange={e => setFps(e.target.value)}>
              <option value="original">Original</option>
              <option value="60">60 fps</option>
              <option value="30">30 fps</option>
              <option value="24">24 fps</option>
            </select>
          </div>
        </div>
      </div>
    </>
  );

  return (
    <div className="app">

      {/* ── DROP ── */}
      {screen === "drop" && (
        <div className={`drop-screen${dragOver ? " drag-over" : ""}`} onClick={pickFiles}>
          <div className="drop-theme-btn"><ThemeBtn /></div>
          <div className="drop-wordmark">
            <QELogo size={36} />
            <h1>quick encode<em>.</em></h1>
            <small>video compressor</small>
          </div>
          <div className="drop-hint-text">
            <p>{dragOver ? "Drop to load" : "Drop files or folders here, or"}</p>
            <small>MP4 · MKV · AVI · MOV · WebM · M4V · select multiple for batch</small>
          </div>
          <div className="drop-actions">
            <button className="drop-browse" onClick={e => { e.stopPropagation(); pickFiles(); }}>Browse files</button>
          </div>
          {status && <div className="status-bar">{status}</div>}
        </div>
      )}

      {/* ── LOADING ── */}
      {screen === "loading" && (
        <div className="loading-screen">
          <div className="loading-content">
            <div className="loading-wordmark">
              <QELogo size={18} />
              <span>quick encode<em>.</em></span>
            </div>
            <div className="loading-bar-wrap">
              <div className="loading-bar-bg"><div className="loading-bar-fill" /></div>
              <div className="loading-label">Reading file &amp; extracting frames&hellip;</div>
            </div>
          </div>
        </div>
      )}

      {/* ── DONE (single) ── */}
      {screen === "done" && doneResult && (() => {
        const { outputPath, originalMb, finalMb } = doneResult;
        const saved = Math.round((1 - finalMb / originalMb) * 100);
        const grew  = finalMb > originalMb;
        return (
          <div className="done-screen">
            <div className="done-theme-btn"><ThemeBtn /></div>
            <div className="done-card">
              <div className="done-icon">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <div className="done-title">Encode complete</div>
              <div className="done-stats">
                <div className="done-stat">
                  <span className="done-stat-label">Output</span>
                  <span className="done-stat-val">{fmtMb(finalMb)}</span>
                </div>
                <div className="done-stat-divider" />
                <div className="done-stat">
                  <span className="done-stat-label">Original</span>
                  <span className="done-stat-val done-stat-muted">{fmtMb(originalMb)}</span>
                </div>
                <div className="done-stat-divider" />
                <div className="done-stat">
                  <span className="done-stat-label">Saved</span>
                  <span className={`done-stat-val ${grew ? "done-stat-warn" : "done-stat-green"}`}>
                    {grew ? `+${Math.abs(saved)}%` : `-${saved}%`}
                  </span>
                </div>
              </div>
              <div className="done-filename">{basename(outputPath)}</div>
              <div className="done-actions">
                <button className="done-btn-reveal" onClick={() => invoke("show_in_folder", { path: outputPath })}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                  </svg>
                  Show in folder
                </button>
                <button className="done-btn-new" onClick={reset}>Import new file</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── BATCH DONE ── */}
      {screen === "batch-done" && batchDoneResult && (
        <div className="done-screen">
          <div className="done-theme-btn"><ThemeBtn /></div>
          <div className="done-card">
            <div className="done-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <div className="done-title">Encode complete</div>
            <div className="done-stats">
              <div className="done-stat">
                <span className="done-stat-label">Total</span>
                <span className="done-stat-val">{batchDoneResult.total}</span>
              </div>
              <div className="done-stat-divider" />
              <div className="done-stat">
                <span className="done-stat-label">Done</span>
                <span className="done-stat-val done-stat-green">{batchDoneResult.succeeded}</span>
              </div>
              {batchDoneResult.failed > 0 && (
                <>
                  <div className="done-stat-divider" />
                  <div className="done-stat">
                    <span className="done-stat-label">Failed</span>
                    <span className="done-stat-val done-stat-warn">{batchDoneResult.failed}</span>
                  </div>
                </>
              )}
            </div>
            <div className="done-filename">{batchDoneResult.outputDir}</div>
            <div className="done-actions">
              <button className="done-btn-reveal" onClick={() => invoke("open_folder", { path: batchDoneResult.outputDir })}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
                Show in folder
              </button>
              <button className="done-btn-new" onClick={reset}>Import new file</button>
            </div>
          </div>
        </div>
      )}

      {/* ── BATCH SCREEN ── */}
      {screen === "batch" && (
        <div className="batch-screen">
          <div className="batch-topbar">
            <Wordmark size="sm" />
            <div className="batch-topbar-right">
              <span className="batch-count">{batchFiles.length} file{batchFiles.length !== 1 ? "s" : ""}</span>
              <ThemeBtn />
              <button className="file-chip" onClick={reset}>
                <span>Clear all</span>
                <span className="file-chip-x">&times;</span>
              </button>
            </div>
          </div>

          <div className="batch-file-list">
            {batchFiles.map((f, i) => (
              <div key={f.path} className="batch-file-row">
                <span className="batch-file-icon">&#9654;</span>
                <span className="batch-file-name" title={f.path}>{basename(f.path)}</span>
                <span className={`batch-file-status ${f.status}`}>
                  {f.status === "pending" ? "Pending"
                    : f.status === "active" ? "Encoding…"
                    : f.status === "done"   ? "✓ Done"
                    : "✕ Error"}
                </span>
                {!batchRunning && f.status !== "active" && (
                  <button className="batch-file-remove" onClick={() => removeBatchFile(i)}>&times;</button>
                )}
              </div>
            ))}
          </div>

          <div className="batch-bottom">
            <div className="batch-settings-row settings-row">
              <QualitySettings />
            </div>
            <div className="batch-actions">
              <button className="batch-add-btn" onClick={addMoreFiles} disabled={batchRunning}>+ Add more</button>
              <div style={{ flex: 1 }} />
              <button className="preset-btn" onClick={() => startBatch(true)} disabled={batchRunning} title="Encode all files targeting ≤9 MB for Discord">
                <DiscordIcon />
                Discord Ready
                <span className="preset-size">≤9 MB each</span>
              </button>
              <button className="btn-encode" onClick={() => startBatch(false)} disabled={batchRunning}>
                {batchRunning
                  ? <span className="btn-inner"><div className="spin" />Encoding…</span>
                  : `Encode All (${batchFiles.length})`}
              </button>
            </div>
            <div className="status-bar">{status}</div>
          </div>
        </div>
      )}

      {/* ── EDITOR ── */}
      {screen === "editor" && info && (
        <div className="editor">
          <div className="topbar">
            <div className="topbar-left"><Wordmark size="sm" /></div>
            <div className="topbar-right">
              <div className="file-chip" onClick={reset}>
                <span>{basename(filePath)}</span>
                <span className="file-chip-x">&times;</span>
              </div>
              <ThemeBtn />
              <span className="version-badge">v2.0</span>
            </div>
          </div>

          <div className="video-meta">
            {(() => {
              const d = gcd(info.width, info.height);
              const items = [
                { label: "Duration", val: fmtTime(info.duration_secs) },
                { label: "Size",     val: fmtMb(info.size_mb) },
                { label: "Res",      val: `${info.width}\u00d7${info.height}` },
                { label: "Bitrate",  val: `${(info.bitrate_kbps/1000).toFixed(1)} Mbps` },
                { label: "Aspect",   val: `${info.width/d}:${info.height/d}` },
              ];
              return items.map(({ label, val }) => (
                <div key={label} className="meta-item">
                  <span className="meta-label">{label}</span>
                  <span className="meta-val">{val}</span>
                </div>
              ));
            })()}
          </div>

          <div className="preview-section">
            <div className="preview-grid">
              <div className="preview-side" onClick={() => currentOrig && setFsImage({ src: currentOrig, label: "Original" })}>
                {currentOrig ? (
                  <img src={`data:image/jpeg;base64,${currentOrig}`} alt="Original" />
                ) : (
                  <div className="preview-loading"><div className="spin" /><span>Loading</span></div>
                )}
                <span className="preview-tag">Original</span>
                {currentOrig && (
                  <button className="preview-fullscreen-btn" onClick={e => { e.stopPropagation(); setFsImage({ src: currentOrig, label: "Original" }); }}>⛶</button>
                )}
              </div>
              <div className="preview-side" onClick={() => currentEnc && !encLoading && setFsImage({ src: currentEnc, label: "Output" })}>
                {encLoading ? (
                  <div className="preview-loading"><div className="spin" /><span>Rendering</span></div>
                ) : currentEnc ? (
                  <img src={`data:image/jpeg;base64,${currentEnc}`} alt="Output" />
                ) : (
                  <div className="preview-loading"><div className="spin" /><span>Loading</span></div>
                )}
                <span className="preview-tag">Output</span>
                {currentEnc && !encLoading && (
                  <button className="preview-fullscreen-btn" onClick={e => { e.stopPropagation(); setFsImage({ src: currentEnc, label: "Output" }); }}>⛶</button>
                )}
              </div>
            </div>
            <div className="frame-nav">
              <button className="frame-nav-btn" onClick={() => goFrame(-1)} disabled={frameIdx === 0}>‹</button>
              <div className="frame-dots">
                {Array.from({ length: FRAME_COUNT }, (_, i) => (
                  <button key={i} className={`frame-dot${i === frameIdx ? " active" : ""}`} onClick={() => setFrameIdx(i)} />
                ))}
              </div>
              <button className="frame-nav-btn" onClick={() => goFrame(1)} disabled={frameIdx === FRAME_COUNT - 1}>›</button>
              <span className="frame-label">{frameIdx + 1} / {FRAME_COUNT} · {fmtTime(frameTs(frameIdx, info.duration_secs))}</span>
            </div>
          </div>

          <div className="settings-row">
            <QualitySettings />
          </div>

          <div className="bottom-bar">
            <div className="est-inline">
              <span className="est-val">{fmtMb(estLow)} – {fmtMb(estHigh)}</span>
              {reduction !== 0 && (
                <span className="est-diff">{reduction > 0 ? `−${reduction}%` : `+${Math.abs(reduction)}%`}</span>
              )}
            </div>
            <button className="preset-btn" onClick={handleDiscord} disabled={encoding}
              title={`Targets ${DISCORD_TARGET} MB — ${discordBr(info.duration_secs)} kbps video, ${DISCORD_AUDIO} kbps audio`}>
              <DiscordIcon />
              Discord Ready
              <span className="preset-size">≤10 MB</span>
            </button>
            <button className="btn-encode" onClick={handleEncode} disabled={encoding}>
              {encoding ? <span className="btn-inner"><div className="spin" />Encoding…</span> : "Start Encode"}
            </button>
          </div>

          <div className="status-bar">{status}</div>
        </div>
      )}

      {/* ── PROGRESS OVERLAY ── */}
      {(encoding || batchRunning) && progress && (
        <div className="progress-overlay">
          <div className="progress-card">
            <div className="progress-title">
              {progress.percent >= 100 ? "Done" : "Encoding…"}
            </div>
            {batchRunning && batchProgress && (
              <div className="progress-pass">
                File {batchProgress.idx + 1} / {batchFiles.length} — {batchProgress.currentFile}
              </div>
            )}
            <div className="progress-pass">
              {progress.percent < 50 ? "Pass 1 / 2 — Analyzing"
                : progress.percent < 100 ? "Pass 2 / 2 — Encoding"
                : "Finalizing"}
            </div>
            <div className="progress-bar-wrap">
              <div className="progress-bar-bg">
                <div
                  className={`progress-bar-fill${progress.percent >= 100 ? " done" : ""}`}
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
              <div className="progress-numbers">
                <span className="progress-pct">{Math.round(progress.percent)}%</span>
                <span>
                  {progress.percent >= 100
                    ? <span className="progress-done-msg">Complete</span>
                    : progress.percent >= 50 && progress.eta_secs > 0
                      ? `ETA ${fmtEta(progress.eta_secs)}`
                      : "Calculating…"}
                </span>
              </div>
            </div>
            {batchRunning && batchProgress && (
              <div className="progress-numbers" style={{ marginTop: -8 }}>
                <span className="progress-file-label">Overall: {batchProgress.idx + 1} / {batchFiles.length}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── FULLSCREEN ── */}
      {fsImage && (
        <div className="fullscreen-overlay" onClick={() => setFsImage(null)}>
          <span className="fullscreen-label">{fsImage.label}</span>
          <img src={`data:image/jpeg;base64,${fsImage.src}`} alt={fsImage.label} onClick={e => e.stopPropagation()} />
          <div className="fullscreen-close" onClick={() => setFsImage(null)}>&times;</div>
        </div>
      )}
    </div>
  );
}
