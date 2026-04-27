import { useEffect, useMemo, useRef, useState } from "react";

type BandSample = {
  t: number;
  theta: number | null;
  alphaPost: number | null;
  betaAlpha: number | null;
  ri: number | null;
};

type VideoItem = {
  id: string;
  title: string;
  video_url_360: string;
  thumbnail_url?: string;
  duration_seconds: number;
};

interface ExhibitionViewProps {
  wsState: string;
  experimentId: string;
  currentIndex: number | null;
  videos: VideoItem[];
  ri: number | null;
  bandsHistory: BandSample[];
  summary: Record<string, unknown> | null;
  iframeSrc: string;
  durationPerVideo: number;
  exhibitionTotalDuration: number;
  onExhibitionTotalDurationChange: (value: number) => void;
  onStart: () => void;
  onStartSimulation: () => void;
  onStop: () => void;
  onExitExhibition: () => void;
}
const CALC_HOLD_MS = 2000;
const WINNER_HOLD_MS = 10000;

type Phase = "idle" | "running" | "calc" | "winner";

function normalize(value: number | null | undefined, history: Array<number | null>): number {
  if (value == null || !Number.isFinite(value)) return 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of history) {
    if (v == null) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!isFinite(lo) || !isFinite(hi) || hi - lo < 1e-9) return 0.5;
  return Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
}

const BAND_DISPLAY: Array<{
  key: keyof Omit<BandSample, "t">;
  label: string;
  colorClass: string;
  digits: number;
  invert?: boolean;
}> = [
  { key: "theta", label: "θ Fz", colorClass: "theta", digits: 3 },
  { key: "alphaPost", label: "α post", colorClass: "alpha", digits: 3 },
  { key: "betaAlpha", label: "β / α", colorClass: "beta", digits: 3, invert: true },
  { key: "ri", label: "RI", colorClass: "ri", digits: 1 },
];

export function ExhibitionView(props: ExhibitionViewProps) {
  const {
    wsState,
    experimentId,
    currentIndex,
    videos,
    ri,
    bandsHistory,
    summary,
    iframeSrc,
    durationPerVideo,
    exhibitionTotalDuration,
    onExhibitionTotalDurationChange,
    onStart,
    onStartSimulation,
    onStop,
    onExitExhibition,
  } = props;

  const [phase, setPhase] = useState<Phase>("idle");
  const [riTrend, setRiTrend] = useState<"up" | "down" | "neutral">("neutral");
  const [sessionsToday, setSessionsToday] = useState(0);
  const prevRiRef = useRef<number | null>(null);
  const summaryShownRef = useRef<string | null>(null);

  // Phase state machine driven by parent props (currentIndex + summary).
  useEffect(() => {
    const summaryKey = summary
      ? String(summary.winner_video_id ?? "") + "|" + String(summary.csv_file ?? "")
      : null;

    if (summaryKey && summaryKey !== summaryShownRef.current) {
      // Fresh summary received — show calc → winner → idle
      summaryShownRef.current = summaryKey;
      setPhase("calc");
      const t1 = setTimeout(() => setPhase("winner"), CALC_HOLD_MS);
      const t2 = setTimeout(() => {
        setPhase("idle");
        setSessionsToday((n) => n + 1);
      }, CALC_HOLD_MS + WINNER_HOLD_MS);
      return () => {
        clearTimeout(t1);
        clearTimeout(t2);
      };
    }

    if (summaryKey) {
      // Already shown this summary — depend on currentIndex
      if (currentIndex != null) setPhase("running");
      return;
    }

    // No summary
    if (currentIndex != null) setPhase("running");
    else setPhase("idle");
  }, [summary, currentIndex]);

  // RI trend tracker
  useEffect(() => {
    if (ri == null) return;
    const prev = prevRiRef.current;
    if (prev == null) {
      prevRiRef.current = ri;
      return;
    }
    if (ri > prev + 0.3) setRiTrend("up");
    else if (ri < prev - 0.3) setRiTrend("down");
    else setRiTrend("neutral");
    prevRiRef.current = ri;
  }, [ri]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && phase === "idle" && wsState === "open") {
        e.preventDefault();
        onStart();
      } else if (e.key === "Escape" && phase === "running") {
        onStop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, wsState, onStart, onStop]);

  // Normalized values for brain heatmap
  const normalized = useMemo(() => {
    const n = bandsHistory.length;
    if (n === 0) return { theta: 0, alpha: 0, beta: 0, ri: 0 };
    const last = bandsHistory[n - 1];
    const theta = normalize(last.theta, bandsHistory.map((b) => b.theta));
    const alpha = normalize(last.alphaPost, bandsHistory.map((b) => b.alphaPost));
    const betaR = normalize(last.betaAlpha, bandsHistory.map((b) => b.betaAlpha));
    const beta = 1 - betaR; // inverted: lower is more relaxed
    const riN = last.ri != null ? Math.max(0, Math.min(1, last.ri / 100)) : 0;
    return { theta, alpha, beta, ri: riN };
  }, [bandsHistory]);

  const currentVideo =
    currentIndex != null && videos[currentIndex] ? videos[currentIndex] : null;

  const winnerInfo = useMemo(() => {
    if (!summary) return null;
    const winnerId = String(summary.winner_video_id ?? "");
    const perVideo = summary.per_video_mean_relaxation as
      | Record<string, number>
      | undefined;
    const winnerRi = perVideo?.[winnerId];
    const winnerTitle =
      videos.find((v) => v.id === winnerId)?.title || winnerId || "Best Match";
    return { id: winnerId, title: winnerTitle, ri: winnerRi };
  }, [summary, videos]);

  const perVideoMean = (summary?.per_video_mean_relaxation as
    | Record<string, number>
    | undefined) || undefined;

  const status = (() => {
    switch (phase) {
      case "running":
        return { text: "● Recording", dot: "live" };
      case "calc":
        return { text: "Calculating", dot: "calc" };
      case "winner":
        return { text: "Winner reveal", dot: "winner" };
      default:
        return { text: wsState === "open" ? "Ready" : "Recorder offline", dot: "idle" };
    }
  })();

  // Hotspot intensities driven by EEG when running, else CSS animation
  const hotValues =
    phase === "running"
      ? {
          theta: 0.3 + 0.65 * normalized.theta,
          alpha: 0.3 + 0.65 * normalized.alpha,
          ri: 0.3 + 0.65 * normalized.ri,
          rTheta: 50 + 12 * normalized.theta,
          rAlpha: 44 + 12 * normalized.alpha,
          rRi: 38 + 12 * normalized.ri,
        }
      : null;

  const feedClass = `ex-feed ${phase === "idle" ? "idle" : ""} ${
    phase === "calc" ? "calc" : ""
  } ${phase === "winner" ? "winner" : ""}`.trim();

  const brainClass = `ex-brain-svg-el ${
    phase === "idle" ? "idle" : phase === "calc" ? "calc" : phase === "winner" ? "winner" : ""
  }`.trim();

  const totalVideos = videos.length || 5;
  const placeholderVideos: VideoItem[] = videos.length
    ? videos
    : Array.from({ length: 5 }, (_, i) => ({
        id: `placeholder-${i}`,
        title: `Video ${i + 1}`,
        video_url_360: "",
        duration_seconds: durationPerVideo,
      }));

  const riScalePct =
    ri != null && phase !== "idle" ? Math.max(0, Math.min(100, ri)) : 50;

  return (
    <div className="exhibition-root">
      {/* ===== Top bar ===== */}
      <div className="ex-topbar">
        <div className="ex-topbar-left">
          <span className="ex-brand">
            Relaxation <span className="ex-brand-accent">×</span> VR
          </span>
          <span className="ex-exp-id mono">{experimentId}</span>
        </div>
        <div className="ex-topbar-center">
          <div className="ex-status-pill">
            <span className={`ex-status-dot ${status.dot}`} />
            <span>{status.text}</span>
          </div>
        </div>
        <div className="ex-topbar-right">
          {phase !== "running" && (
            <button
              type="button"
              className="ex-btn-restart-demo"
              onClick={onStartSimulation}
              title="Restart demo session"
            >
              Restart Demo
            </button>
          )}
          {phase !== "running" && (
            <label className="ex-total-time">
              Total (s)
              <input
                type="number"
                min={30}
                step={10}
                value={exhibitionTotalDuration}
                onChange={(e) => onExhibitionTotalDurationChange(Number(e.target.value))}
                title="Total exhibition duration distributed across 5 videos + winner"
              />
            </label>
          )}
          {phase === "running" && (
            <button type="button" className="ex-btn-stop" onClick={onStop}>
              ■ Stop
            </button>
          )}
          <button
            type="button"
            className="ex-btn-exit"
            onClick={onExitExhibition}
            title="Exit Exhibition Mode (Cmd/Ctrl+Shift+E)"
          >
            Operator
          </button>
        </div>
      </div>

      {/* ===== Stage ===== */}
      <div className="ex-stage">
        {/* LEFT: Participant feed */}
        <div className={feedClass}>
          <iframe
            className="ex-feed-iframe"
            src={iframeSrc}
            title="Participant feed"
          />

          <div className="ex-feed-overlay">
            <div className="ex-live-chip">
              <span className="ex-live-dot" />
              <span>Live · Participant View</span>
            </div>
            <div className="ex-feed-title-row">
              <div className="ex-video-info">
                <div className="ex-video-stage">
                  Video {(currentIndex ?? 0) + 1} of {totalVideos}
                </div>
                <div className="ex-video-name">
                  {currentVideo?.title || "—"}
                </div>
              </div>
            </div>
          </div>

          {phase === "idle" && (
            <div className="ex-idle-overlay">
              <div className="ex-idle-card">
                <div className="ex-idle-eyebrow">Ready to begin</div>
                <div className="ex-idle-title">Relaxation × VR</div>
                <div className="ex-idle-subtitle">
                  {totalVideos} videos · {durationPerVideo}s each ·
                  Live brain activity
                </div>
                <div className="ex-idle-subtitle">
                  Total {Math.max(30, Number(exhibitionTotalDuration) || 30)}s split across 5 videos + winner
                </div>
                <button
                  type="button"
                  className="ex-btn-start"
                  onClick={onStart}
                  disabled={wsState !== "open"}
                >
                  ▶ Start Experience
                </button>
                <button
                  type="button"
                  className="ex-btn-start ex-btn-start-sim"
                  onClick={onStartSimulation}
                >
                  ◇ Start Demo
                </button>
                <div className="ex-idle-meta">
                  {wsState === "open"
                    ? "準備完了 · AURA未接続なら Demo を使用"
                    : "AURA未接続でも Demo で開始できます"}
                </div>
              </div>
            </div>
          )}

          {phase === "calc" && (
            <div className="ex-calc-overlay">
              <div className="ex-calc-spinner" />
              <div className="ex-calc-text">Calculating results</div>
              <div className="ex-calc-text-jp">結果を集計中</div>
            </div>
          )}

          {phase === "winner" && winnerInfo && (
            <div className="ex-winner-overlay">
              <div className="ex-winner-eyebrow">
                ★ Best Match · ベストマッチ
              </div>
              <div className="ex-winner-name">{winnerInfo.title}</div>
              <div className="ex-winner-ri">
                RI{" "}
                <span className="mono">
                  {winnerInfo.ri != null ? winnerInfo.ri.toFixed(2) : "—"}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* RIGHT column */}
        <div className="ex-right-col">
          {/* Brain Activity */}
          <div className="ex-panel">
            <div className="ex-corner-glow tl" />
            <div className="ex-panel-header">
              <div>
                <span className="ex-panel-title">Brain Activity</span>
                <span className="ex-panel-title-jp">脳活動</span>
              </div>
              <span className="ex-panel-tag">EEG · Live Heatmap</span>
            </div>

            <div className="ex-brain-grid">
              <div className="ex-brain-svg-wrap">
                <svg
                  className={brainClass}
                  viewBox="0 0 240 290"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <defs>
                    <radialGradient id="exHotTheta" cx="50%" cy="50%" r="50%">
                      <stop offset="0%" stopColor="#a855f7" stopOpacity="1" />
                      <stop offset="60%" stopColor="#a855f7" stopOpacity="0.3" />
                      <stop offset="100%" stopColor="#a855f7" stopOpacity="0" />
                    </radialGradient>
                    <radialGradient id="exHotAlpha" cx="50%" cy="50%" r="50%">
                      <stop offset="0%" stopColor="#34d399" stopOpacity="1" />
                      <stop offset="60%" stopColor="#34d399" stopOpacity="0.3" />
                      <stop offset="100%" stopColor="#34d399" stopOpacity="0" />
                    </radialGradient>
                    <radialGradient id="exHotRI" cx="50%" cy="50%" r="50%">
                      <stop offset="0%" stopColor="#22d3ee" stopOpacity="1" />
                      <stop offset="60%" stopColor="#22d3ee" stopOpacity="0.3" />
                      <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
                    </radialGradient>
                    <linearGradient
                      id="exBrainSurface"
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop offset="0%" stopColor="rgba(168,85,247,0.08)" />
                      <stop offset="100%" stopColor="rgba(34,211,238,0.05)" />
                    </linearGradient>
                    <clipPath id="exBrainClip">
                      <path d="M 120 18 C 90 18, 64 28, 48 50 C 28 78, 18 118, 24 158 C 30 200, 50 240, 80 262 C 100 274, 140 274, 160 262 C 190 240, 210 200, 216 158 C 222 118, 212 78, 192 50 C 176 28, 150 18, 120 18 Z" />
                    </clipPath>
                    <filter
                      id="exHotBlur"
                      x="-50%"
                      y="-50%"
                      width="200%"
                      height="200%"
                    >
                      <feGaussianBlur stdDeviation="6" />
                    </filter>
                  </defs>

                  {/* Brain base */}
                  <path
                    d="M 120 18 C 90 18, 64 28, 48 50 C 28 78, 18 118, 24 158 C 30 200, 50 240, 80 262 C 100 274, 140 274, 160 262 C 190 240, 210 200, 216 158 C 222 118, 212 78, 192 50 C 176 28, 150 18, 120 18 Z"
                    fill="url(#exBrainSurface)"
                    stroke="rgba(255,255,255,0.18)"
                    strokeWidth="1.5"
                  />

                  {/* Hotspots */}
                  <g clipPath="url(#exBrainClip)" filter="url(#exHotBlur)">
                    <circle
                      className="hotspot"
                      cx="120"
                      cy="58"
                      r={hotValues ? hotValues.rTheta : 50}
                      fill="url(#exHotTheta)"
                      opacity={hotValues ? hotValues.theta : 0.4}
                    />
                    <circle
                      className="hotspot"
                      cx="82"
                      cy="208"
                      r={hotValues ? hotValues.rAlpha : 44}
                      fill="url(#exHotAlpha)"
                      opacity={hotValues ? hotValues.alpha : 0.4}
                    />
                    <circle
                      className="hotspot"
                      cx="158"
                      cy="208"
                      r={hotValues ? hotValues.rAlpha : 44}
                      fill="url(#exHotAlpha)"
                      opacity={hotValues ? hotValues.alpha : 0.4}
                    />
                    <circle
                      className="hotspot"
                      cx="120"
                      cy="138"
                      r={hotValues ? hotValues.rRi : 38}
                      fill="url(#exHotRI)"
                      opacity={hotValues ? hotValues.ri : 0.4}
                    />
                  </g>

                  {/* Central fissure */}
                  <path
                    d="M 120 22 Q 118 80, 120 140 Q 122 200, 120 268"
                    stroke="rgba(255,255,255,0.18)"
                    fill="none"
                    strokeWidth="1"
                  />

                  {/* Sulci */}
                  <g
                    stroke="rgba(255,255,255,0.10)"
                    fill="none"
                    strokeWidth="1"
                    strokeLinecap="round"
                  >
                    <path d="M 50 90  Q 80 100, 105 92" />
                    <path d="M 38 130 Q 70 142, 100 132" />
                    <path d="M 50 180 Q 80 192, 105 182" />
                    <path d="M 50 225 Q 78 232, 102 224" />
                    <path d="M 190 90  Q 160 100, 135 92" />
                    <path d="M 202 130 Q 170 142, 140 132" />
                    <path d="M 190 180 Q 160 192, 135 182" />
                    <path d="M 190 225 Q 162 232, 138 224" />
                  </g>

                  {/* Brain outline on top */}
                  <path
                    d="M 120 18 C 90 18, 64 28, 48 50 C 28 78, 18 118, 24 158 C 30 200, 50 240, 80 262 C 100 274, 140 274, 160 262 C 190 240, 210 200, 216 158 C 222 118, 212 78, 192 50 C 176 28, 150 18, 120 18 Z"
                    fill="none"
                    stroke="rgba(255,255,255,0.22)"
                    strokeWidth="1.5"
                  />

                  {/* Electrode markers */}
                  <g fontFamily="JetBrains Mono, monospace">
                    <circle
                      cx="120"
                      cy="40"
                      r="2.5"
                      fill="rgba(255,255,255,0.85)"
                    />
                    <text
                      x="127"
                      y="44"
                      fontSize="9"
                      fill="rgba(255,255,255,0.55)"
                    >
                      Fz
                    </text>
                    <circle
                      cx="120"
                      cy="135"
                      r="2.5"
                      fill="rgba(255,255,255,0.85)"
                    />
                    <text
                      x="127"
                      y="139"
                      fontSize="9"
                      fill="rgba(255,255,255,0.55)"
                    >
                      Cz
                    </text>
                    <circle
                      cx="82"
                      cy="222"
                      r="2.5"
                      fill="rgba(255,255,255,0.85)"
                    />
                    <text
                      x="60"
                      y="238"
                      fontSize="9"
                      fill="rgba(255,255,255,0.55)"
                    >
                      O1
                    </text>
                    <circle
                      cx="158"
                      cy="222"
                      r="2.5"
                      fill="rgba(255,255,255,0.85)"
                    />
                    <text
                      x="164"
                      y="238"
                      fontSize="9"
                      fill="rgba(255,255,255,0.55)"
                    >
                      O2
                    </text>
                  </g>
                </svg>
              </div>

              <div className="ex-ri-display">
                <div className="ex-ri-eyebrow">Relaxation Index</div>
                <div
                  className={`ex-ri-value mono ${
                    ri == null || phase === "idle" ? "idle" : ""
                  }`}
                >
                  {ri != null && phase !== "idle" ? ri.toFixed(1) : "––"}
                </div>
                <div
                  className={`ex-ri-trend ${
                    phase === "idle" ? "idle" : ""
                  } ${riTrend === "down" ? "down" : ""}`}
                >
                  {phase === "idle"
                    ? "awaiting signal"
                    : riTrend === "up"
                    ? "↑ rising"
                    : riTrend === "down"
                    ? "↓ settling"
                    : "— steady"}
                </div>
                <div
                  className="ex-ri-scale"
                  style={
                    {
                      ["--ri-pct" as string]: `${riScalePct}%`,
                    } as React.CSSProperties
                  }
                />
              </div>
            </div>

            <div className="ex-bands-row">
              {BAND_DISPLAY.map((b) => {
                const last = bandsHistory.length
                  ? bandsHistory[bandsHistory.length - 1]
                  : null;
                const val = last ? (last[b.key] as number | null) : null;
                const series = bandsHistory.map(
                  (x) => x[b.key] as number | null
                );
                let pct = last ? normalize(val, series) : 0;
                if (b.invert) pct = 1 - pct;
                if (b.key === "ri" && val != null) {
                  pct = Math.max(0, Math.min(1, val / 100));
                }
                return (
                  <div key={b.key} className="ex-band-cell">
                    <div className="ex-band-head">
                      <span className="ex-band-label">{b.label}</span>
                      <span className="ex-band-value mono">
                        {val != null ? val.toFixed(b.digits) : "––"}
                      </span>
                    </div>
                    <div className="ex-band-track">
                      <div
                        className={`ex-band-fill ${b.colorClass}`}
                        style={{ width: `${(pct * 100).toFixed(1)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Journey */}
          <div className="ex-panel">
            <div className="ex-corner-glow br" />
            <div className="ex-panel-header">
              <div>
                <span className="ex-panel-title">Journey</span>
                <span className="ex-panel-title-jp">旅</span>
              </div>
              <span className="ex-panel-tag">
                {totalVideos} Videos · {durationPerVideo}s each
              </span>
            </div>

            <div className="ex-journey">
              {placeholderVideos.map((v, i) => {
                const isActive = phase === "running" && i === currentIndex;
                const isDone =
                  phase === "winner"
                    ? true
                    : currentIndex != null && i < currentIndex;
                const videoRi = perVideoMean?.[v.id];
                const meta = isDone && videoRi != null
                  ? (
                    <>
                      RI <strong>{videoRi.toFixed(2)}</strong>
                    </>
                  )
                  : isDone
                  ? "Completed"
                  : isActive
                  ? "Now playing"
                  : i === (currentIndex ?? -1) + 1
                  ? "Up next"
                  : "Queued";
                return (
                  <div
                    key={v.id || i}
                    className={`ex-pill ${isDone ? "done" : ""} ${
                      isActive ? "active" : ""
                    }`}
                  >
                    <div className="ex-pill-num">
                      {isDone ? "✓" : String(i + 1)}
                    </div>
                    <div>
                      <div className="ex-pill-name">{v.title}</div>
                    </div>
                    <div className="ex-pill-meta">{meta}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* ===== Footer ===== */}
      <div className="ex-footer">
        <div className="ex-footer-left">
          <span>5G Lab TEQS ATC · Osaka</span>
          <span className="ex-footer-sep" />
          <span>リラクゼーション × VR 体験</span>
        </div>
        <div className="ex-footer-right">
          <span>Session #{sessionsToday} today</span>
          <span className="ex-footer-sep" />
          <span>Scan to learn more</span>
          <div className="ex-qr" />
        </div>
      </div>
    </div>
  );
}
