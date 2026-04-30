#!/usr/bin/env python3
"""
LSL (AURA) ↔ WebSocket bridge for relaxation playlist experiments.
"""

from __future__ import annotations

import argparse
import asyncio
import concurrent.futures
import csv
import json
import math
import random
import ssl
import threading
import time
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

import numpy as np

from config_eeg import ADAPTIVE_UPDATE_INTERVAL_S, SAMPLE_RATE_HZ, WINDOW_SAMPLES
from eeg_adaptive import (
    RollingBaseline,
    compute_raw_metrics,
    compute_relaxation_index,
    pad_to_eight,
)

try:
    import websockets
except ImportError:
    raise SystemExit("pip install websockets")

try:
    from pylsl import StreamInlet, resolve_byprop, resolve_streams
except ImportError:
    StreamInlet = None  # type: ignore
    resolve_byprop = None  # type: ignore
    resolve_streams = None  # type: ignore


ROOT = Path(__file__).resolve().parent.parent
APP_DATA = ROOT / "app" / "data" / "content.json"
OUTPUT_DIR = ROOT / "output"
RUNTIME_STATE_PATH = ROOT / "app" / "data" / "runtime-state.json"


def parse_bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return bool(default)
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        v = value.strip().lower()
        if v in {"1", "true", "yes", "y", "on"}:
            return True
        if v in {"0", "false", "no", "n", "off", ""}:
            return False
    return bool(value)


def write_runtime_state(payload: Dict[str, Any]) -> None:
    try:
        RUNTIME_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = RUNTIME_STATE_PATH.with_suffix(".tmp")
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(_json_safe(payload), f, ensure_ascii=False)
        tmp_path.replace(RUNTIME_STATE_PATH)
    except Exception:
        pass


def load_content() -> List[Dict[str, Any]]:
    if not APP_DATA.is_file():
        return []
    with open(APP_DATA, "r", encoding="utf-8") as f:
        data = json.load(f)
    return list(data.get("videos", []))


def _list_visible_streams() -> List[Tuple[str, str]]:
    """Return [(name, type), ...] for every LSL stream visible right now."""
    if resolve_streams is None:
        return []
    try:
        streams = resolve_streams(wait_time=2.0)
    except Exception:
        return []
    out: List[Tuple[str, str]] = []
    for s in streams or []:
        try:
            out.append((str(s.name() or ""), str(s.type() or "")))
        except Exception:
            continue
    return out


def _discover_aura_stream() -> Optional[Any]:
    """Find an AURA-compatible LSL outlet.

    Tries the strict exact-name match first (fast path), then falls back to
    enumerating all streams and matching case-insensitively on name OR type
    containing 'aura'. Many AURA outlets advertise themselves as 'Aura' or
    'AURA-Raw' rather than the literal 'AURA' the original code required.
    """
    if resolve_byprop is None:
        return None

    # Fast path: exact match. 2.5 s gives pylsl room to enumerate
    # interfaces on the very first call without freezing the UI.
    try:
        strict = resolve_byprop("name", "AURA", minimum=1, timeout=2.5)
    except Exception:
        strict = []
    if strict:
        print("[recorder] LSL discovery: strict name='AURA' matched", flush=True)
        return strict[0]

    # Fallback: enumerate all and accept anything aura-ish.
    if resolve_streams is None:
        return None
    try:
        all_streams = resolve_streams(wait_time=2.5)
    except Exception:
        all_streams = []
    print(
        f"[recorder] LSL discovery: strict miss, scanning {len(all_streams)} stream(s)",
        flush=True,
    )
    for s in all_streams or []:
        try:
            name = (s.name() or "").lower()
            stype = (s.type() or "").lower()
        except Exception:
            continue
        if "aura" in name or "aura" in stype:
            print(
                f"[recorder] LSL discovery: fuzzy match name='{s.name()}' type='{s.type()}'",
                flush=True,
            )
            return s
    return None


def _read_lsl_channel_labels(info: Any, n_ch: int) -> List[str]:
    """Return the channel labels declared by the LSL stream (e.g. F1, FZ, FP1).

    Falls back to ch1..chN when the XML is missing/incomplete so the recorder
    keeps working with non-conformant streams.
    """
    labels: List[str] = []
    try:
        ch = info.desc().child("channels").child("channel")
        while not ch.empty():
            label = ch.child_value("label") or ch.child_value("name") or ""
            labels.append(label.strip())
            ch = ch.next_sibling()
    except Exception:
        labels = []
    if len(labels) != n_ch or not all(labels):
        return [f"ch{i+1}" for i in range(n_ch)]
    return labels


def _open_inlet_with_timeout(stream_info: Any, timeout_s: float = 8.0) -> Any:
    """Create StreamInlet with a hard timeout."""
    if StreamInlet is None:
        raise RuntimeError("pylsl not available")

    def _build() -> Any:
        inlet = StreamInlet(stream_info)
        return inlet

    ex = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    fut = ex.submit(_build)
    try:
        return fut.result(timeout=max(0.1, float(timeout_s)))
    except concurrent.futures.TimeoutError as e:
        # Do not block waiting for the worker to finish; if pylsl gets stuck
        # internally, we still need to return control to the websocket loop.
        fut.cancel()
        ex.shutdown(wait=False, cancel_futures=True)
        raise RuntimeError(
            f"AURA stream found, but inlet opening timed out after {timeout_s:.1f}s. "
            f"This usually means the outlet advertised an interface this Mac "
            f"can't reach. Try restarting the recorder with "
            f"LSL_LIST_INTERFACES=en0 (or your active interface name)."
        ) from e
    finally:
        # Normal path: shut down cleanly.
        if fut.done():
            ex.shutdown(wait=True, cancel_futures=False)


def _json_safe(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_json_safe(v) for v in obj]
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
    return obj


class EEGRecorder:
    def __init__(self, mock: bool = False) -> None:
        self.mock = mock
        self.inlet: Any = None
        self.channel_names: List[str] = []
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._buffer: List[tuple] = []
        self.max_buffer = SAMPLE_RATE_HZ * 120
        self.on_sample: Optional[Callable[[float, List[float], str], None]] = None

    def connect(self) -> None:
        if self.mock:
            self.channel_names = [f"ch{i+1}" for i in range(5)]
            print("[recorder] EEG mode: MOCK (5 simulated channels)", flush=True)
            return
        if resolve_byprop is None:
            raise RuntimeError("pylsl not available")

        chosen = _discover_aura_stream()
        if chosen is None:
            # Build a helpful error with whatever streams ARE visible so the
            # operator can spot the actual outlet name (e.g. "Aura", "EEG",
            # "AURA-Raw") and we don't just say "not found".
            visible = _list_visible_streams()
            if visible:
                hint = "; visible streams: " + ", ".join(
                    f"name='{n}' type='{t}'" for n, t in visible
                )
            else:
                hint = "; no LSL streams visible from this host"
            raise RuntimeError("No AURA-like LSL stream found" + hint)

        self.inlet = _open_inlet_with_timeout(chosen, timeout_s=8.0)
        try:
            n_ch = int(chosen.channel_count())
        except Exception:
            n_ch = 5
        if n_ch <= 0:
            n_ch = 5
        self.channel_names = [f"ch{i+1}" for i in range(n_ch)]
        # Best effort metadata read; do not block the connect path on this.
        stream_name = "AURA"
        stream_type = "EEG"
        stream_srate: Any = SAMPLE_RATE_HZ
        try:
            stream_name = str(chosen.name() or stream_name)
        except Exception:
            pass
        try:
            stream_type = str(chosen.type() or stream_type)
        except Exception:
            pass
        try:
            stream_srate = chosen.nominal_srate()
        except Exception:
            pass
        print(
            f"[recorder] AURA connected: name='{stream_name}' "
            f"type='{stream_type}' channels={n_ch} "
            f"labels={self.channel_names} srate={stream_srate}",
            flush=True,
        )

    def start_thread(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop_thread(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2.0)

    def _run(self) -> None:
        if self.mock:
            t0 = time.time()
            while not self._stop.is_set():
                ts = time.time()
                t = ts - t0
                sample: List[float] = []
                for ch in range(5):
                    v = 10 * math.sin(2 * math.pi * (1.0 + ch * 0.1) * t)
                    v += 5 * random.gauss(0, 1)
                    sample.append(v)
                self._push(ts, sample)
                time.sleep(1.0 / SAMPLE_RATE_HZ)
            return

        assert self.inlet is not None
        while not self._stop.is_set():
            # Chunked pulls are far cheaper at 250 Hz than per-sample polls
            # and keep the websocket loop responsive between drains.
            try:
                samples, timestamps = self.inlet.pull_chunk(
                    timeout=0.1, max_samples=64
                )
            except Exception:
                samples, timestamps = [], []
            if samples and timestamps:
                for ts, s in zip(timestamps, samples):
                    self._push(ts, list(s))

    def _push(self, ts: float, sample: List[float]) -> None:
        label = getattr(self, "_current_label", "idle")
        with self._lock:
            self._buffer.append((ts, sample, label))
            if len(self._buffer) > self.max_buffer:
                self._buffer = self._buffer[-self.max_buffer :]
        if self.on_sample:
            self.on_sample(ts, list(sample), label)

    def set_label(self, label: str) -> None:
        self._current_label = label

    def get_recent_window(self) -> Optional[np.ndarray]:
        with self._lock:
            if len(self._buffer) < WINDOW_SAMPLES:
                return None
            chunk = self._buffer[-WINDOW_SAMPLES:]
        rows = [c[1] for c in chunk]
        arr = np.asarray(rows, dtype=np.float64)
        if arr.ndim != 2:
            return None
        try:
            return pad_to_eight(arr)
        except ValueError:
            return None


class RelaxationRecorder:
    def __init__(self, eeg: EEGRecorder) -> None:
        self.eeg = eeg
        self.recording = False
        self.experiment_id = ""
        self.session_type = "relaxation_playlist"
        self.video_index = 0
        self.videos: List[Dict[str, Any]] = []
        self.durations_seconds: List[float] = []
        self.baseline = RollingBaseline()
        self.baseline_calibration_seconds = 0.0
        self._calibration_end_ts: Optional[float] = None
        self._relax_ring: deque = deque(maxlen=60)
        self._per_video_ri: Dict[str, List[float]] = {}
        self._current_video_id: str = ""

    def _ensure_video_dict(self) -> None:
        for v in self.videos:
            vid = v.get("id", "")
            if vid and vid not in self._per_video_ri:
                self._per_video_ri[vid] = []

    def start(
        self,
        experiment_id: str,
        video_index: int,
        videos: List[Dict[str, Any]],
        durations_seconds: List[float],
        baseline_calibration_seconds: float,
    ) -> None:
        self.recording = True
        self.experiment_id = experiment_id or "exp"
        self.video_index = max(0, min(4, video_index))
        self.videos = videos
        if len(durations_seconds) == 5:
            self.durations_seconds = [float(x) for x in durations_seconds]
        else:
            self.durations_seconds = [float(v.get("duration_seconds", 120)) for v in videos]
        self.baseline = RollingBaseline()
        self.baseline_calibration_seconds = float(baseline_calibration_seconds or 0)
        self._calibration_end_ts = (
            time.time() + self.baseline_calibration_seconds
            if self.baseline_calibration_seconds > 0
            else None
        )
        self._per_video_ri = {}
        self._ensure_video_dict()
        self._set_level_label()

    def _set_level_label(self) -> None:
        if not self.videos or self.video_index >= len(self.videos):
            self._current_video_id = ""
            self.eeg.set_label("idle")
            return
        vid = self.videos[self.video_index].get("id", f"v{self.video_index}")
        self._current_video_id = str(vid)
        self.eeg.set_label(f"{self.experiment_id}_relax_{vid}")

    def set_video_index(self, idx: int) -> None:
        if not self.videos:
            return
        self.video_index = max(0, min(len(self.videos) - 1, idx))
        self._set_level_label()

    def stop(self) -> None:
        self.recording = False
        self.eeg.set_label("idle")

    def tick_adaptive(self) -> Optional[Dict[str, Any]]:
        if not self.recording:
            return None
        data = self.eeg.get_recent_window()
        if data is None:
            return None

        metrics = compute_raw_metrics(data)
        self.baseline.update(metrics)
        z = self.baseline.z_scores(metrics)
        ri, full_m = compute_relaxation_index(metrics, z)

        calibrating = False
        if self._calibration_end_ts is not None:
            if time.time() < self._calibration_end_ts:
                calibrating = True
            else:
                self._calibration_end_ts = None

        if not calibrating and self._current_video_id:
            self._per_video_ri.setdefault(self._current_video_id, []).append(ri)

        self._relax_ring.append(ri)
        agg = float(np.mean(self._relax_ring)) if self._relax_ring else ri

        phase = "calibration" if calibrating else "live"
        remaining = 0.0
        if self._calibration_end_ts is not None:
            remaining = max(0.0, self._calibration_end_ts - time.time())

        return {
            "type": "adaptive_state",
            "relaxation_index": ri,
            "relaxation_index_aggregate": agg,
            "adaptive_phase": phase,
            "baseline_remaining_s": remaining,
            "baseline_ready": self.baseline.ready(),
            "current_video_index": self.video_index,
            "current_video_id": self._current_video_id,
            "segment_mean_relaxation": float(
                np.mean(self._per_video_ri.get(self._current_video_id, [ri]) or [ri])
            ),
            "metrics": full_m,
        }

    def build_summary(self) -> Dict[str, Any]:
        means = {}
        for vid, vals in self._per_video_ri.items():
            if vals:
                means[vid] = float(np.mean(vals))
        winner = None
        if means:
            winner = max(means, key=lambda k: means[k])
        return {
            "type": "experiment_summary",
            "per_video_mean_relaxation": means,
            "winner_video_id": winner,
        }


def save_csv(
    recorder: RelaxationRecorder,
    eeg: EEGRecorder,
    rows: List[tuple],
) -> str:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    exp = recorder.experiment_id or "exp"
    path = OUTPUT_DIR / f"eeg_relax_{exp}_{ts}.csv"
    ch = eeg.channel_names or ["ch1"]
    nch = len(ch)
    header = ["timestamp"] + ch + ["label"]
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(header)
        for ts_v, sample, label in rows:
            sample = list(sample)
            while len(sample) < nch:
                sample.append(float("nan"))
            sample = sample[:nch]
            row = [ts_v] + [f"{x:.8f}" if isinstance(x, float) else x for x in sample]
            row.append(label)
            w.writerow(row)
    return str(path)


class SessionState:
    def __init__(self, mock: bool) -> None:
        self.default_mock = mock
        self.eeg = EEGRecorder(mock=mock)
        self.rec = RelaxationRecorder(self.eeg)
        self.clients: Set[Any] = set()
        self.full_buffer: List[tuple] = []
        self.buffer_lock = threading.Lock()
        # Server-side timer that closes out the experiment when the
        # playlist's total duration elapses, in case no client (e.g. a
        # Quest VR running in poll-only mode) ever sends an explicit
        # `stop`. Re-scheduled on start / set_video / video_advance,
        # cancelled on explicit `stop`.
        self.auto_stop_task: Optional["asyncio.Task[Any]"] = None

        def on_sample(ts: float, sample: List[float], label: str) -> None:
            if self.rec.recording:
                with self.buffer_lock:
                    self.full_buffer.append((ts, list(sample), label))

        self.eeg.on_sample = on_sample
        self._on_sample = on_sample
        self.runtime_seq = 0
        write_runtime_state(
            {
                "seq": self.runtime_seq,
                "active": False,
                "experiment_id": "",
                "video_index": 0,
                "videos": [],
                "durations_seconds": [],
                "updated_at": int(time.time() * 1000),
            }
        )

    def _bind_eeg(self, eeg: EEGRecorder) -> None:
        eeg.on_sample = self._on_sample
        self.eeg = eeg
        self.rec.eeg = eeg

    def switch_eeg_mode(self, use_mock: bool) -> None:
        if self.eeg.mock == use_mock:
            return
        self.eeg.stop_thread()
        next_eeg = EEGRecorder(mock=use_mock)
        next_eeg.connect()
        next_eeg.start_thread()
        self._bind_eeg(next_eeg)

    def ensure_eeg_running(self, use_mock: Optional[bool] = None) -> None:
        target_mock = self.default_mock if use_mock is None else bool(use_mock)
        if self.eeg.mock != target_mock:
            self.switch_eeg_mode(target_mock)
            return
        if not self.eeg.channel_names:
            self.eeg.connect()
        self.eeg.start_thread()

    def aura_status_message(self) -> Dict[str, Any]:
        is_aura = not self.eeg.mock
        return {
            "type": "aura_status",
            "mode": "aura" if is_aura else "mock",
            "connected": bool(is_aura and self.eeg.channel_names),
            "channels": len(self.eeg.channel_names),
        }

    async def register(self, ws: Any) -> None:
        self.clients.add(ws)
        await ws.send(json.dumps(_json_safe(self.aura_status_message())))
        # Late-joining participant clients must receive the current running state,
        # otherwise they miss the initial start trigger broadcast.
        if self.rec.recording:
            await ws.send(
                json.dumps(
                    _json_safe(
                        {
                            "type": "start_experiment",
                            "session_type": self.rec.session_type,
                            "experiment_id": self.rec.experiment_id,
                            "video_index": self.rec.video_index,
                            "durations_seconds": self.rec.durations_seconds,
                            "videos": self.rec.videos,
                            "baseline_calibration_seconds": self.rec.baseline_calibration_seconds,
                            "simulate_eeg": self.eeg.mock,
                        }
                    )
                )
            )

    async def unregister(self, ws: Any) -> None:
        self.clients.discard(ws)

    async def broadcast(self, msg: Dict[str, Any]) -> None:
        raw = json.dumps(_json_safe(msg))
        dead = []
        for c in self.clients:
            try:
                await c.send(raw)
            except Exception:
                dead.append(c)
        for c in dead:
            self.clients.discard(c)


async def adaptive_loop(state: SessionState) -> None:
    while True:
        await asyncio.sleep(ADAPTIVE_UPDATE_INTERVAL_S)
        payload = state.rec.tick_adaptive()
        if payload and state.clients:
            await state.broadcast(payload)


def merge_durations(videos: List[Dict[str, Any]], override: Optional[List[float]]) -> List[float]:
    base = [float(v.get("duration_seconds", 120)) for v in videos]
    if override and len(override) == 5:
        return [float(override[i]) for i in range(5)]
    return base


# Buffer (seconds) added on top of the playlist's remaining duration when
# scheduling the server-side auto-stop. Keeps the recorder running long
# enough that the participant client (Quest VR / desktop) finishes its
# last clip before the recorder closes the experiment.
AUTO_STOP_BUFFER_S = 5.0


async def _perform_stop(state: SessionState) -> Tuple[Dict[str, Any], str]:
    """Build the experiment summary, persist it, and broadcast over WS.

    Used by both the explicit `stop` message handler and the server-side
    auto-stop timer. Returns (summary, csv_path).
    """
    summary = state.rec.build_summary()
    path = ""
    with state.buffer_lock:
        rows = list(state.full_buffer)
    if rows:
        path = save_csv(state.rec, state.eeg, rows)
    state.rec.stop()
    state.runtime_seq += 1
    if path:
        summary["csv_file"] = path
    write_runtime_state(
        {
            "seq": state.runtime_seq,
            "active": False,
            "experiment_id": state.rec.experiment_id,
            "video_index": state.rec.video_index,
            "videos": state.rec.videos,
            "durations_seconds": state.rec.durations_seconds,
            "summary": summary,
            "summary_seq": state.runtime_seq,
            "updated_at": int(time.time() * 1000),
        }
    )
    await state.broadcast({"type": "stop_video"})
    await state.broadcast(summary)
    return summary, path


async def _auto_stop_after(state: SessionState, delay: float) -> None:
    try:
        await asyncio.sleep(delay)
    except asyncio.CancelledError:
        return
    if not state.rec.recording:
        return
    try:
        await _perform_stop(state)
    except Exception:
        pass


def _schedule_auto_stop(state: SessionState, delay: float) -> None:
    if state.auto_stop_task and not state.auto_stop_task.done():
        state.auto_stop_task.cancel()
    state.auto_stop_task = asyncio.create_task(
        _auto_stop_after(state, max(1.0, float(delay)))
    )


def _cancel_auto_stop(state: SessionState) -> None:
    if state.auto_stop_task and not state.auto_stop_task.done():
        state.auto_stop_task.cancel()
    state.auto_stop_task = None


def _remaining_playlist_seconds(state: SessionState) -> float:
    durs = state.rec.durations_seconds or []
    idx = max(0, int(state.rec.video_index or 0))
    if idx >= len(durs):
        return AUTO_STOP_BUFFER_S
    return float(sum(float(d) for d in durs[idx:])) + AUTO_STOP_BUFFER_S


async def handle_client(ws: Any, state: SessionState) -> None:
    await state.register(ws)
    try:
        try:
            async for message in ws:
                try:
                    data = json.loads(message)
                except json.JSONDecodeError:
                    continue
                mtype = data.get("type")
                if mtype == "aura_status_request":
                    await ws.send(json.dumps(_json_safe(state.aura_status_message())))

                elif mtype == "aura_connect":
                    if state.rec.recording:
                        await ws.send(
                            json.dumps(
                                {
                                    "status": "error",
                                    "message": "Stop the current session before changing AURA connection mode.",
                                }
                            )
                        )
                        continue
                    print("[recorder] aura_connect requested", flush=True)
                    last_error: Optional[Exception] = None
                    for attempt in range(1, 4):
                        try:
                            print(f"[recorder] aura_connect attempt {attempt}/3", flush=True)
                            await asyncio.to_thread(state.ensure_eeg_running, False)
                            state.default_mock = False
                            last_error = None
                            break
                        except RuntimeError as e:
                            last_error = e
                            print(f"[recorder] aura_connect attempt {attempt} failed: {e}", flush=True)
                            if attempt < 3:
                                await asyncio.sleep(0.35)
                    if last_error is not None:
                        print(f"[recorder] aura_connect failed: {last_error}", flush=True)
                        await ws.send(
                            json.dumps(
                                {
                                    "status": "error",
                                    "message": str(last_error),
                                }
                            )
                        )
                        continue
                    status_msg = state.aura_status_message()
                    print(f"[recorder] aura_connect ok: {status_msg}", flush=True)
                    await ws.send(json.dumps({"status": "aura_connected"}))
                    await state.broadcast(status_msg)

                elif mtype == "aura_disconnect":
                    if state.rec.recording:
                        await ws.send(
                            json.dumps(
                                {
                                    "status": "error",
                                    "message": "Stop the current session before changing AURA connection mode.",
                                }
                            )
                        )
                        continue
                    print("[recorder] aura_disconnect requested -> switching to MOCK", flush=True)
                    state.default_mock = True
                    await asyncio.to_thread(state.ensure_eeg_running, True)
                    status_msg = state.aura_status_message()
                    print(f"[recorder] aura_disconnect ok: {status_msg}", flush=True)
                    await ws.send(json.dumps({"status": "aura_disconnected"}))
                    await state.broadcast(status_msg)

                elif mtype == "controller_start":
                    videos = load_content()
                    if len(videos) != 5:
                        await ws.send(
                            json.dumps(
                                {"status": "error", "message": "content.json must list exactly 5 videos"}
                            )
                        )
                        continue
                    exp_id = data.get("experiment_id", "exp")
                    vidx = int(data.get("video_index", 0))
                    durs = merge_durations(videos, data.get("durations_seconds"))
                    base_cal = float(data.get("baseline_calibration_seconds", 0) or 0)
                    raw_sim = data.get("simulate_eeg")
                    requested_mock = parse_bool(raw_sim, state.default_mock)
                    # If AURA is connected, default to AURA for normal starts,
                    # but still allow explicit demo starts (simulate_eeg=true).
                    aura_live = (not state.eeg.mock) and bool(state.eeg.channel_names)
                    explicit_demo = (raw_sim is not None) and requested_mock
                    use_mock = requested_mock
                    if aura_live and not explicit_demo:
                        use_mock = False
                    print(
                        f"[recorder] controller_start exp={exp_id} vidx={vidx} "
                        f"requested_mock={requested_mock} aura_live={aura_live} "
                        f"-> use_mock={use_mock}",
                        flush=True,
                    )
                    try:
                        await asyncio.to_thread(state.ensure_eeg_running, use_mock)
                    except RuntimeError as e:
                        print(f"[recorder] controller_start aborted: {e}", flush=True)
                        await ws.send(
                            json.dumps(
                                {
                                    "status": "error",
                                    "message": f"{e}. Enable simulation mode to run without AURA hardware.",
                                }
                            )
                        )
                        continue
                    await state.broadcast(state.aura_status_message())
                    with state.buffer_lock:
                        state.full_buffer.clear()
                    state.rec.start(exp_id, vidx, videos, durs, base_cal)
                    state.runtime_seq += 1
                    write_runtime_state(
                        {
                            "seq": state.runtime_seq,
                            "active": True,
                            "experiment_id": exp_id,
                            "video_index": state.rec.video_index,
                            "videos": videos,
                            "durations_seconds": durs,
                            "simulate_eeg": use_mock,
                            "updated_at": int(time.time() * 1000),
                        }
                    )
                    _schedule_auto_stop(state, _remaining_playlist_seconds(state))

                    print(
                        f"[recorder] experiment running mode={'mock' if use_mock else 'aura'} "
                        f"channels={len(state.eeg.channel_names)} "
                        f"durations={durs}",
                        flush=True,
                    )
                    await state.broadcast(
                        {
                            "type": "start_experiment",
                            "session_type": "relaxation_playlist",
                            "experiment_id": exp_id,
                            "video_index": state.rec.video_index,
                            "durations_seconds": durs,
                            "videos": videos,
                            "baseline_calibration_seconds": base_cal,
                            "simulate_eeg": use_mock,
                        }
                    )
                    await ws.send(json.dumps({"status": "started"}))

                elif mtype == "start":
                    videos = load_content()
                    if len(videos) != 5:
                        await ws.send(json.dumps({"status": "error", "message": "need 5 videos in content.json"}))
                        continue
                    exp_id = data.get("experiment_id", "exp")
                    durs = merge_durations(videos, data.get("durations_seconds"))
                    raw_sim = data.get("simulate_eeg")
                    requested_mock = parse_bool(raw_sim, state.default_mock)
                    aura_live = (not state.eeg.mock) and bool(state.eeg.channel_names)
                    explicit_demo = (raw_sim is not None) and requested_mock
                    use_mock = requested_mock
                    if aura_live and not explicit_demo:
                        use_mock = False
                    try:
                        await asyncio.to_thread(state.ensure_eeg_running, use_mock)
                    except RuntimeError as e:
                        await ws.send(
                            json.dumps(
                                {
                                    "status": "error",
                                    "message": f"{e}. Enable simulation mode to run without AURA hardware.",
                                }
                            )
                        )
                        continue
                    await state.broadcast(state.aura_status_message())
                    with state.buffer_lock:
                        state.full_buffer.clear()
                    state.rec.start(
                        exp_id,
                        int(data.get("video_index", 0)),
                        videos,
                        durs,
                        float(data.get("baseline_calibration_seconds", 0) or 0),
                    )
                    _schedule_auto_stop(state, _remaining_playlist_seconds(state))
                    await ws.send(json.dumps({"status": "started"}))

                elif mtype in ("set_video", "manual_level", "level_change"):
                    idx = int(data.get("video_index", data.get("level", 0)))
                    state.rec.set_video_index(idx)
                    state.runtime_seq += 1
                    write_runtime_state(
                        {
                            "seq": state.runtime_seq,
                            "active": state.rec.recording,
                            "experiment_id": state.rec.experiment_id,
                            "video_index": state.rec.video_index,
                            "videos": state.rec.videos,
                            "durations_seconds": state.rec.durations_seconds,
                            "updated_at": int(time.time() * 1000),
                        }
                    )
                    if state.rec.recording:
                        _schedule_auto_stop(state, _remaining_playlist_seconds(state))
                    await state.broadcast({"type": "force_video", "video_index": idx})

                elif mtype == "video_advance":
                    nxt = int(data.get("video_index", state.rec.video_index))
                    state.rec.set_video_index(nxt)
                    state.runtime_seq += 1
                    write_runtime_state(
                        {
                            "seq": state.runtime_seq,
                            "active": state.rec.recording,
                            "experiment_id": state.rec.experiment_id,
                            "video_index": state.rec.video_index,
                            "videos": state.rec.videos,
                            "durations_seconds": state.rec.durations_seconds,
                            "updated_at": int(time.time() * 1000),
                        }
                    )
                    if state.rec.recording:
                        _schedule_auto_stop(state, _remaining_playlist_seconds(state))
                    await state.broadcast({"type": "force_video", "video_index": nxt})

                elif mtype == "stop":
                    print("[recorder] stop requested", flush=True)
                    _cancel_auto_stop(state)
                    await ws.send(json.dumps({"status": "stopping"}))
                    summary, path = await _perform_stop(state)
                    print(
                        f"[recorder] experiment stopped winner={summary.get('winner_video_id')!r} "
                        f"csv={path or '(none)'}",
                        flush=True,
                    )
                    await ws.send(json.dumps({"status": "stopped", "file": path}))

                elif mtype == "stop_video":
                    await state.broadcast({"type": "stop_video"})
        except websockets.exceptions.ConnectionClosed:
            # Electron can terminate without a graceful websocket close frame.
            # Treat this as a normal disconnect, not a server error.
            pass

    finally:
        await state.unregister(ws)


async def main_async(ssl_ctx: Optional[ssl.SSLContext], host: str, port: int, mock: bool) -> None:
    state = SessionState(mock=mock)

    async def handler(websocket: Any) -> None:
        await handle_client(websocket, state)

    asyncio.create_task(adaptive_loop(state))

    async with websockets.serve(handler, host, port, ssl=ssl_ctx, max_size=2**22):
        print(f"WebSocket server wss://{host}:{port} (mock_eeg={mock})")
        await asyncio.Future()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wss", action="store_true", help="Use TLS (cert.pem/key.pem)")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--mock-eeg", action="store_true", help="Simulated EEG (no LSL)")
    args = ap.parse_args()

    ssl_ctx: Optional[ssl.SSLContext] = None
    if args.wss:
        ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        cert = ROOT / "cert.pem"
        key = ROOT / "key.pem"
        if not cert.is_file() or not key.is_file():
            raise SystemExit("Missing cert.pem / key.pem — run npm run cert")
        ssl_ctx.load_cert_chain(str(cert), str(key))

    try:
        asyncio.run(main_async(ssl_ctx, args.host, args.port, mock=args.mock_eeg))
    except RuntimeError as e:
        if "AURA" in str(e) and not args.mock_eeg:
            raise SystemExit(f"{e}\nUse --mock-eeg for development without hardware.")
        raise


if __name__ == "__main__":
    main()
