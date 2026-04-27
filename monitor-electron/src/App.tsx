import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExhibitionView } from "./ExhibitionView";

type VideoItem = {
  id: string;
  title: string;
  video_url_360: string;
  thumbnail_url?: string;
  duration_seconds: number;
};

const DEFAULT_GLOBAL_DURATION = 90;
const DEFAULT_EXHIBITION_TOTAL_DURATION = 90;

type BandSample = {
  t: number;
  theta: number | null;
  alphaPost: number | null;
  betaAlpha: number | null;
  ri: number | null;
};

const BAND_HISTORY_LEN = 60; // ~2 min at 2s update interval

const BAND_SERIES: Array<{
  key: keyof Omit<BandSample, "t">;
  label: string;
  color: string;
  unit: string;
  digits: number;
}> = [
  { key: "theta", label: "θ Fz", color: "#a78bfa", unit: "pwr", digits: 3 },
  { key: "alphaPost", label: "α post", color: "#34d399", unit: "pwr", digits: 3 },
  { key: "betaAlpha", label: "β/α", color: "#fbbf24", unit: "ratio", digits: 3 },
  { key: "ri", label: "RI", color: "#f472b6", unit: "0–100", digits: 1 },
];

function toNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function minMax(values: Array<number | null>): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v == null) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!isFinite(lo) || !isFinite(hi)) return [0, 1];
  if (hi - lo < 1e-9) return [lo - 0.5, hi + 0.5];
  return [lo, hi];
}

function buildPath(
  values: Array<number | null>,
  w: number,
  h: number,
  pad: number
): string {
  if (values.length < 2) return "";
  const [lo, hi] = minMax(values);
  const span = hi - lo || 1;
  const innerW = w - pad * 2;
  const innerH = h - pad * 2;
  const n = values.length;
  let d = "";
  let started = false;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v == null) {
      started = false;
      continue;
    }
    const x = pad + (n === 1 ? 0 : (i / (n - 1)) * innerW);
    const y = pad + innerH - ((v - lo) / span) * innerH;
    d += (started ? " L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
    started = true;
  }
  return d;
}

function fmt(n: unknown, d = 2): string {
  if (typeof n !== "number" || Number.isNaN(n)) return "—";
  return n.toFixed(d);
}

function buildParticipantPreviewUrl(input: string): string {
  const raw = input.trim() || "https://127.0.0.1:8443/experiment-wait-config.html";
  try {
    const u = new URL(raw.includes("://") ? raw : `https://${raw}`);
    u.searchParams.set("embedded", "1");
    return u.toString();
  } catch {
    return "https://127.0.0.1:8443/experiment-wait-config.html?embedded=1";
  }
}

export function App() {
  const bridge = window.recorderBridge;
  const [tab, setTab] = useState<"control" | "signals">("control");
  const [mode, setMode] = useState<"operator" | "exhibition">("operator");
  const [wsState, setWsState] = useState<string>("…");
  const [participantUrlInput, setParticipantUrlInput] = useState(
    "https://127.0.0.1:8443/experiment-wait-config.html"
  );
  const [iframeSrc, setIframeSrc] = useState(() => buildParticipantPreviewUrl(participantUrlInput));

  const [experimentId, setExperimentId] = useState("exp-001");
  const [baselineCal, setBaselineCal] = useState(0);
  const [simulationMode, setSimulationMode] = useState(true);
  const [globalDuration, setGlobalDuration] = useState<number>(DEFAULT_GLOBAL_DURATION);
  const [exhibitionTotalDuration, setExhibitionTotalDuration] = useState<number>(
    DEFAULT_EXHIBITION_TOTAL_DURATION
  );
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [currentTitle, setCurrentTitle] = useState("—");
  const [currentIndex, setCurrentIndex] = useState<number | null>(null);
  const [ri, setRi] = useState<number | null>(null);
  const [agg, setAgg] = useState<number | null>(null);
  const [metrics, setMetrics] = useState<Record<string, number>>({});
  const [riHistory, setRiHistory] = useState<number[]>([]);
  const [bandsHistory, setBandsHistory] = useState<BandSample[]>([]);
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [lastFile, setLastFile] = useState<string>("");
  const playlistRef = useRef<VideoItem[]>([]);

  useEffect(() => {
    fetch("https://127.0.0.1:8443/data/content.json")
      .then((r) => r.json())
      .then((data: { videos?: VideoItem[] }) => {
        const v = data.videos || [];
        setVideos(v);
        if (v.length === 5) {
          setGlobalDuration(Number(v[0]?.duration_seconds) || DEFAULT_GLOBAL_DURATION);
        }
      })
      .catch(() => {
        setVideos([]);
      });
  }, []);

  useEffect(() => {
    if (!bridge) return;
    const offStatus = bridge.onStatus((s) => setWsState(s.state || "…"));
    const offMsg = bridge.onMessage((msg) => {
      if (!msg) return;
      if (msg.type === "adaptive_state") {
        const riNum = toNum(msg.relaxation_index);
        if (riNum != null) {
          setRi(riNum);
          setRiHistory((h) => [...h.slice(-59), riNum]);
        }
        const aggNum = toNum(msg.relaxation_index_aggregate);
        if (aggNum != null) setAgg(aggNum);
        const m = msg.metrics as Record<string, unknown> | undefined;
        if (m && typeof m === "object") {
          setMetrics(m as Record<string, number>);
          const sample: BandSample = {
            t: Date.now(),
            theta: toNum(m.theta_fz),
            alphaPost: toNum(m.alpha_posterior),
            betaAlpha: toNum(m.beta_alpha_fz_cz),
            ri: riNum,
          };
          setBandsHistory((h) => [...h.slice(-(BAND_HISTORY_LEN - 1)), sample]);
        }
      }
      if (msg.type === "start_experiment") {
        const vids = msg.videos as VideoItem[] | undefined;
        const idx = msg.video_index as number | undefined;
        if (vids && vids.length) {
          setVideos(vids);
          playlistRef.current = vids;
        }
        if (vids && typeof idx === "number") {
          setCurrentIndex(idx);
          setCurrentTitle(vids[idx]?.title || vids[idx]?.id || "—");
        }
      }
      if (msg.type === "force_video") {
        const idx = msg.video_index as number;
        setCurrentIndex(idx);
        const vids = playlistRef.current;
        setCurrentTitle(vids[idx]?.title || vids[idx]?.id || `Clip ${idx + 1}`);
      }
      if (msg.type === "experiment_summary") {
        setSummary(msg as unknown as Record<string, unknown>);
        const cf = (msg as { csv_file?: string }).csv_file;
        if (typeof cf === "string" && cf) setLastFile(cf);
      }
      if (msg.status === "stopped" && typeof (msg as { file?: string }).file === "string") {
        setLastFile((msg as { file: string }).file);
      }
    });
    return () => {
      offStatus();
      offMsg();
    };
  }, [bridge]);

  const send = useCallback(
    (obj: Record<string, unknown>) => {
      bridge?.send(obj);
    },
    [bridge]
  );

  const applyPreviewUrl = useCallback(() => {
    setIframeSrc(buildParticipantPreviewUrl(participantUrlInput));
  }, [participantUrlInput]);

  const sendStart = useCallback(
    (durationPerVideo: number, forceSimulation?: boolean) => {
      setSummary(null);
      setRiHistory([]);
      setBandsHistory([]);
      send({
        type: "controller_start",
        session_type: "relaxation_playlist",
        experiment_id: experimentId,
        video_index: 0,
        durations_seconds: Array(5).fill(Math.max(5, durationPerVideo)),
        baseline_calibration_seconds: baselineCal,
        simulate_eeg: forceSimulation ?? simulationMode,
      });
    },
    [send, experimentId, baselineCal, simulationMode]
  );

  const onStart = () =>
    sendStart(Number(globalDuration) || DEFAULT_GLOBAL_DURATION);

  const exhibitionSegmentDuration = useMemo(() => {
    const total = Math.max(30, Number(exhibitionTotalDuration) || DEFAULT_EXHIBITION_TOTAL_DURATION);
    return Math.max(5, Math.floor(total / 6));
  }, [exhibitionTotalDuration]);

  const onStartExhibition = useCallback(
    () => sendStart(exhibitionSegmentDuration),
    [sendStart, exhibitionSegmentDuration]
  );
  const onStartExhibitionSimulation = useCallback(
    () => sendStart(exhibitionSegmentDuration, true),
    [sendStart, exhibitionSegmentDuration]
  );

  const onStop = () => {
    send({ type: "stop" });
  };

  // Cmd/Ctrl+Shift+E toggles Exhibition Mode (works from either mode).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "e" || e.key === "E")) {
        e.preventDefault();
        setMode((m) => (m === "exhibition" ? "operator" : "exhibition"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const sparkHeights = useMemo(() => {
    if (!riHistory.length) return [];
    const lo = Math.min(...riHistory);
    const hi = Math.max(...riHistory);
    const span = hi - lo || 1;
    return riHistory.map((v) => Math.max(8, ((v - lo) / span) * 100));
  }, [riHistory]);

  const bandChart = useMemo(() => {
    const W = 900;
    const H = 260;
    const PAD = 22;
    const paths = BAND_SERIES.map((s) => {
      const values = bandsHistory.map((b) => b[s.key]);
      const last = [...values].reverse().find((v) => v != null) ?? null;
      return {
        ...s,
        d: buildPath(values, W, H, PAD),
        last,
      };
    });
    return { W, H, PAD, paths };
  }, [bandsHistory]);

  if (mode === "exhibition") {
    return (
      <ExhibitionView
        wsState={wsState}
        experimentId={experimentId}
        currentIndex={currentIndex}
        videos={videos}
        ri={ri}
        bandsHistory={bandsHistory}
        summary={summary}
        iframeSrc={iframeSrc}
        durationPerVideo={exhibitionSegmentDuration}
        exhibitionTotalDuration={exhibitionTotalDuration}
        onExhibitionTotalDurationChange={setExhibitionTotalDuration}
        onStart={onStartExhibition}
        onStartSimulation={onStartExhibitionSimulation}
        onStop={onStop}
        onExitExhibition={() => setMode("operator")}
      />
    );
  }

  return (
    <div className="monitor-root">
      <header className="app-header">
        <div className="titles">
          <h1>Researcher Panel · Lab Control / 研究者パネル</h1>
          <p className="sub">
            <strong>EN:</strong> This is not the immersive participant view. Configure here and press{" "}
            <strong>Start</strong> to launch the session in the recorder; videos play on the HTTPS web page
            (iframe) and on Quest. <strong>JA:</strong> これは参加者向けの没入ビューではありません。ここで設定し、
            <strong>Start</strong> を押すと、レコーダーのセッションが開始されます。
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span className={"ws-pill " + (wsState === "open" ? "open" : "")}>Recorder WS: {wsState}</span>
          <button
            type="button"
            className="toggle-exhibition-btn"
            onClick={() => setMode("exhibition")}
            title="Switch to Exhibition Mode (Cmd/Ctrl+Shift+E)"
          >
            ✦ Exhibition Mode
          </button>
        </div>
      </header>

      <nav className="tabs main-tabs">
        <button type="button" className={tab === "control" ? "active" : ""} onClick={() => setTab("control")}>
          Control + Preview / 制御 + プレビュー
        </button>
        <button type="button" className={tab === "signals" ? "active" : ""} onClick={() => setTab("signals")}>
          EEG Signals / EEG信号
        </button>
      </nav>

      {tab === "control" && (
        <div className="shell">
          <aside className="control-pane">
            <div className="panel-scroll">
              <div className="preview-url-row">
                <label htmlFor="purl">Participant page URL (HTTPS) / 参加者ページURL</label>
                <input
                  id="purl"
                  value={participantUrlInput}
                  onChange={(e) => setParticipantUrlInput(e.target.value)}
                  onBlur={applyPreviewUrl}
                  placeholder="https://&lt;IP&gt;:8443/experiment-wait-config.html"
                />
                <p className="compact-hint">
                  Quest: use the PC IP address. The iframe appends <code>?embedded=1</code> (preview only, no audio).
                </p>
                <button type="button" className="btn-primary" style={{ marginTop: "0.5rem" }} onClick={applyPreviewUrl}>
                  Apply preview / プレビューを適用
                </button>
              </div>

              <div className="grid2" style={{ marginTop: "0.85rem" }}>
                <label className="field">
                  Experiment ID
                  <input value={experimentId} onChange={(e) => setExperimentId(e.target.value)} />
                </label>
                <label className="field">
                  Baseline (s)
                  <input
                    type="number"
                    min={0}
                    value={baselineCal}
                    onChange={(e) => setBaselineCal(Number(e.target.value))}
                  />
                </label>
              </div>
              <label className="field" style={{ marginTop: "0.65rem", display: "flex", gap: "0.6rem", alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={simulationMode}
                  onChange={(e) => setSimulationMode(e.target.checked)}
                />
                <span>
                  Simulation mode (without AURA) / シミュレーションモード（AURAなし）
                </span>
              </label>

              <p className="compact-hint" style={{ marginTop: "0.65rem" }}>
                Global duration per clip (s) - applied equally to all 5 videos
              </p>
              <label className="field" style={{ marginTop: "0.35rem" }}>
                Timer (s)
                <input
                  type="number"
                  min={5}
                  value={globalDuration}
                  onChange={(e) => setGlobalDuration(Number(e.target.value))}
                />
              </label>

              <div className="actions">
                <button type="button" className="btn-primary" onClick={onStart}>
                  Start / 開始
                </button>
                <button type="button" className="btn-danger" onClick={onStop}>
                  Stop / 停止
                </button>
              </div>

              <div className="now-playing-mini">
                Status: {currentIndex != null ? `clip ${currentIndex + 1}/5` : "waiting"} - {currentTitle}
              </div>

              {summary && (
                <div className="summary-block">
                  <strong>Winner (mean RI) / 勝者（平均RI）:</strong> {String(summary.winner_video_id || "—")}
                  <pre>{JSON.stringify(summary.per_video_mean_relaxation, null, 2)}</pre>
                </div>
              )}
              {lastFile ? (
                <p className="compact-hint" style={{ marginTop: "0.5rem" }}>
                  CSV: {lastFile}
                </p>
              ) : null}
            </div>
          </aside>

          <section className="preview-pane">
            <div className="preview-chrome">
              <strong>Preview - same page as Quest (HTTPS server) / プレビュー</strong>
              <span className="hint">embedded=1</span>
            </div>
            <iframe className="participant-iframe" title="Participant session" src={iframeSrc} />
          </section>
        </div>
      )}

      {tab === "signals" && (
        <div className="signals-only">
          <div className="metrics-full">
            <div className="signals-head">
              <div>
                <div className="metrics-hero">{ri != null ? fmt(ri, 1) : "—"}</div>
                <div className="metrics-sub">
                  Relaxation index · aggregate: {agg != null ? fmt(agg, 1) : "—"}
                </div>
              </div>
              <div className="spark-wrap" aria-hidden>
                <div className="spark-label">RI 2 min</div>
                <div className="spark">
                  {sparkHeights.map((h, i) => (
                    <span key={i} style={{ height: `${h}%` }} />
                  ))}
                </div>
              </div>
            </div>

            <div className="bands-card">
              <div className="bands-legend">
                {bandChart.paths.map((s) => (
                  <div key={s.key} className="legend-item">
                    <span className="dot" style={{ background: s.color }} />
                    <span className="lbl">{s.label}</span>
                    <span className="val" style={{ color: s.color }}>
                      {s.last != null ? s.last.toFixed(s.digits) : "—"}
                    </span>
                    <span className="unit">{s.unit}</span>
                  </div>
                ))}
              </div>

              <svg
                className="bands-chart"
                viewBox={`0 0 ${bandChart.W} ${bandChart.H}`}
                preserveAspectRatio="none"
                role="img"
                aria-label="EEG band waves in real time"
              >
                <rect
                  x="0"
                  y="0"
                  width={bandChart.W}
                  height={bandChart.H}
                  fill="#0a0a0b"
                />
                {[0.25, 0.5, 0.75].map((p) => {
                  const y = bandChart.PAD + (bandChart.H - bandChart.PAD * 2) * p;
                  return (
                    <line
                      key={p}
                      x1={bandChart.PAD}
                      x2={bandChart.W - bandChart.PAD}
                      y1={y}
                      y2={y}
                      stroke="rgba(250,250,250,0.06)"
                      strokeDasharray="4 6"
                    />
                  );
                })}
                {bandChart.paths.map((s) =>
                  s.d ? (
                    <path
                      key={s.key}
                      d={s.d}
                      fill="none"
                      stroke={s.color}
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity="0.95"
                    />
                  ) : null
                )}
                {!bandsHistory.length && (
                  <text
                    x={bandChart.W / 2}
                    y={bandChart.H / 2}
                    textAnchor="middle"
                    fill="#52525b"
                    fontSize="14"
                  >
                    Waiting for recorder samples...
                  </text>
                )}
              </svg>
              <div className="bands-footer">
                <span>Rolling window ~{BAND_HISTORY_LEN * 2}s (each series normalized to its min/max)</span>
                <span>
                  {bandsHistory.length}/{BAND_HISTORY_LEN} samples
                </span>
              </div>
            </div>

            <div className="metric-cards">
              <div className="metric-card">
                <div className="k">θ Fz</div>
                <div className="v">{fmt(metrics.theta_fz, 4)}</div>
              </div>
              <div className="metric-card">
                <div className="k">β/α</div>
                <div className="v">{fmt(metrics.beta_alpha_fz_cz, 4)}</div>
              </div>
              <div className="metric-card">
                <div className="k">α post.</div>
                <div className="v">{fmt(metrics.alpha_posterior, 4)}</div>
              </div>
              <div className="metric-card">
                <div className="k">FAA</div>
                <div className="v">{fmt(metrics.faa, 4)}</div>
              </div>
            </div>
            <p className="compact-hint" style={{ marginTop: "1rem" }}>
              Real-time waves from the recorder (updated every 2 s). Control start/stop from{" "}
              <strong>Control + Preview</strong>; videos only play on the HTTPS server (Quest/iframe).
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
