#!/usr/bin/env python3
"""
Quick LSL discovery diagnostic.

Lists visible LSL streams so we can confirm whether AURA is discoverable
from this machine/network.
"""

from __future__ import annotations

import argparse
import sys
import time
from typing import Any, Iterable

try:
    from pylsl import StreamInlet, resolve_streams
except ImportError:
    raise SystemExit("Missing dependency: pylsl. Install with: pip install -r scripts/requirements.txt")

import concurrent.futures


def _safe(value: Any, fallback: str = "—") -> str:
    if value is None:
        return fallback
    try:
        txt = str(value).strip()
        return txt if txt else fallback
    except Exception:
        return fallback


def _stream_row(idx: int, s: Any) -> str:
    return (
        f"[{idx}] "
        f"name={_safe(s.name())} | "
        f"type={_safe(s.type())} | "
        f"source_id={_safe(s.source_id())} | "
        f"uid={_safe(s.uid())} | "
        f"host={_safe(s.hostname())} | "
        f"channels={_safe(s.channel_count())} | "
        f"srate={_safe(s.nominal_srate())} | "
        f"fmt={_safe(s.channel_format())} | "
        f"created_at={_safe(s.created_at())}"
    )


def print_streams(streams: Iterable[Any], elapsed_s: float) -> int:
    streams = list(streams)
    print("=" * 96)
    print(f"LSL scan at +{elapsed_s:.1f}s | streams_found={len(streams)}")
    if not streams:
        print("No streams found.")
        return 0
    for i, s in enumerate(streams, start=1):
        print(_stream_row(i, s))
    return len(streams)


def _try_open_inlet_and_pull(stream: Any, open_timeout_s: float, pull_timeout_s: float) -> None:
    """End-to-end smoke test: open the inlet, then try to pull one chunk.

    The discovery side of LSL uses multicast UDP and almost always works on
    a single host. The data side opens TCP to whatever address/port the
    outlet announced, and that's where Macs typically get stuck (firewall,
    wrong interface, IPv6 vs IPv4, sandboxed Quest WiFi). This makes that
    failure visible without needing the full recorder running.
    """
    name = _safe(stream.name())
    print(f"    -> opening inlet for name={name} (timeout {open_timeout_s:.1f}s)…")

    def _build() -> Any:
        return StreamInlet(stream, max_buflen=60, max_chunklen=0, recover=False)

    ex = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    try:
        try:
            inlet = ex.submit(_build).result(timeout=open_timeout_s)
        except concurrent.futures.TimeoutError:
            print(
                f"    !! inlet open TIMED OUT after {open_timeout_s:.1f}s — "
                f"discovery sees the outlet but TCP to its data port is not reachable. "
                f"Check firewall, interface binding, or IPv6/IPv4 mismatch."
            )
            return
        except Exception as e:
            print(f"    !! inlet open FAILED: {e!r}")
            return
    finally:
        ex.shutdown(wait=False, cancel_futures=True)

    print("    -> inlet open OK; pulling a chunk…")
    try:
        samples, timestamps = inlet.pull_chunk(timeout=pull_timeout_s, max_samples=32)
    except Exception as e:
        print(f"    !! pull_chunk FAILED: {e!r}")
        return
    if samples and timestamps:
        n = len(samples)
        first = samples[0]
        ch = len(first) if first else 0
        print(
            f"    OK: pulled {n} sample(s), {ch} channel(s); "
            f"first sample preview = {first[:5]}"
        )
    else:
        print(
            f"    !! no samples within {pull_timeout_s:.1f}s — outlet is reachable "
            f"but not pushing data right now."
        )


def main() -> int:
    ap = argparse.ArgumentParser(description="List available LSL streams for diagnostics.")
    ap.add_argument("--timeout", type=float, default=3.0, help="Discovery timeout per scan in seconds (default: 3)")
    ap.add_argument(
        "--watch",
        type=float,
        default=0.0,
        help="If > 0, keep scanning every N seconds (default: one-shot)",
    )
    ap.add_argument(
        "--probe",
        action="store_true",
        help="After listing, also try to open an inlet on each AURA-like stream and pull one chunk.",
    )
    ap.add_argument(
        "--open-timeout",
        type=float,
        default=8.0,
        help="Hard timeout for opening each inlet during --probe (default: 8s)",
    )
    args = ap.parse_args()

    t0 = time.time()
    try:
        while True:
            streams = resolve_streams(wait_time=max(0.1, float(args.timeout)))
            print_streams(streams, time.time() - t0)
            if args.probe:
                for s in streams:
                    try:
                        nm = (s.name() or "").lower()
                        ty = (s.type() or "").lower()
                    except Exception:
                        nm, ty = "", ""
                    if "aura" in nm or "aura" in ty:
                        _try_open_inlet_and_pull(
                            s, open_timeout_s=float(args.open_timeout), pull_timeout_s=2.0
                        )
            if args.watch <= 0:
                break
            time.sleep(max(0.1, float(args.watch)))
    except KeyboardInterrupt:
        print("\nStopped by user.")
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())

