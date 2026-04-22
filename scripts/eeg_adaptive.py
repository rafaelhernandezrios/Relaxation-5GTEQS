"""EEG metrics and relaxation index from windowed multi-channel data."""

from __future__ import annotations

import math
from collections import deque
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from scipy import signal

def _trapz_compat(y: np.ndarray, x: np.ndarray) -> float:
    """Integrate y over x. NumPy 2.0+ uses trapezoid; np.trapz was removed."""
    if hasattr(np, "trapezoid"):
        return float(np.trapezoid(y, x))
    return float(np.trapz(y, x))  # type: ignore[attr-defined]


from config_eeg import (
    ADAPTIVE_UPDATE_INTERVAL_S,
    ALPHA_BAND,
    BAD_CHANNEL_VALUE,
    BASELINE_MIN_WINDOWS,
    BETA_BAND,
    IDX_F1,
    IDX_F2,
    IDX_FP1,
    IDX_FP2,
    IDX_FZ,
    IDX_P5,
    IDX_P6,
    IDX_P7,
    RELAXATION_INDEX_CENTER,
    RELAXATION_INDEX_K,
    SAMPLE_RATE_HZ,
    THETA_BAND,
)


def _replace_bad_channels(data: np.ndarray) -> np.ndarray:
    out = data.astype(np.float64, copy=True)
    out[np.abs(out - BAD_CHANNEL_VALUE) < 1e-3] = np.nan
    return out


def _band_power_1d(x: np.ndarray, band: Tuple[float, float]) -> float:
    """Mean power in band via Welch PSD (single channel)."""
    x = np.asarray(x, dtype=np.float64)
    if np.all(np.isnan(x)):
        return float("nan")
    mask = ~np.isnan(x)
    if mask.sum() < 32:
        return float("nan")
    x = x[mask]
    nperseg = min(256, len(x))
    f, pxx = signal.welch(
        x,
        fs=SAMPLE_RATE_HZ,
        nperseg=nperseg,
        noverlap=nperseg // 2,
        scaling="density",
    )
    lo, hi = band
    sel = (f >= lo) & (f <= hi)
    if not np.any(sel):
        return float("nan")
    return _trapz_compat(pxx[sel], f[sel])


def _mean_band_channel(data: np.ndarray, ch: int, band: Tuple[float, float]) -> float:
    return _band_power_1d(data[:, ch], band)


def _mean_band_frontal_alpha(data: np.ndarray) -> float:
    """Mean alpha across Fp1, Fp2, Fz proxies for beta/alpha denominator."""
    vals = []
    for ch in (IDX_FP1, IDX_FP2, IDX_FZ):
        v = _mean_band_channel(data, ch, ALPHA_BAND)
        if not math.isnan(v):
            vals.append(v)
    if not vals:
        return float("nan")
    return float(np.mean(vals))


def _mean_band_frontal_beta(data: np.ndarray) -> float:
    vals = []
    for ch in (IDX_FP1, IDX_FP2, IDX_FZ):
        v = _mean_band_channel(data, ch, BETA_BAND)
        if not math.isnan(v):
            vals.append(v)
    if not vals:
        return float("nan")
    return float(np.mean(vals))


def _posterior_alpha(data: np.ndarray) -> float:
    vals = []
    for ch in (IDX_P5, IDX_P6, IDX_P7):
        v = _mean_band_channel(data, ch, ALPHA_BAND)
        if not math.isnan(v):
            vals.append(v)
    if vals:
        return float(np.mean(vals))
    # Fallback: frontal alpha
    return _mean_band_frontal_alpha(data)


def _faa_ratio(data: np.ndarray) -> float:
    """(alpha_right - alpha_left) / (alpha_right + alpha_left) at F2 vs F1."""
    al = _mean_band_channel(data, IDX_F1, ALPHA_BAND)
    ar = _mean_band_channel(data, IDX_F2, ALPHA_BAND)
    if math.isnan(al) or math.isnan(ar):
        return float("nan")
    s = ar + al
    if abs(s) < 1e-20:
        return float("nan")
    return float((ar - al) / s)


def compute_raw_metrics(data: np.ndarray) -> Dict[str, float]:
    """Band metrics for one window; data shape (n_samples, 5 or 8 padded to 8)."""
    data = _replace_bad_channels(np.asarray(data, dtype=np.float64))
    if data.ndim != 2 or data.shape[1] < 5:
        return {}

    theta_fz = _mean_band_channel(data, IDX_FZ, THETA_BAND)
    a_front = _mean_band_frontal_alpha(data)
    b_front = _mean_band_frontal_beta(data)
    if math.isnan(a_front) or a_front < 1e-30:
        beta_alpha = float("nan")
    else:
        beta_alpha = b_front / a_front
    alpha_post = _posterior_alpha(data)
    faa = _faa_ratio(data)

    return {
        "theta_fz": theta_fz,
        "beta_alpha_fz_cz": beta_alpha,
        "alpha_posterior": alpha_post,
        "faa": faa,
    }


class RollingBaseline:
    """Rolling mean/std for z-scoring (calibration windows)."""

    def __init__(self, maxlen: int = 600) -> None:
        self._theta: deque = deque(maxlen=maxlen)
        self._ba: deque = deque(maxlen=maxlen)
        self._ap: deque = deque(maxlen=maxlen)
        self._faa: deque = deque(maxlen=maxlen)

    def update(self, metrics: Dict[str, float]) -> None:
        if not math.isnan(metrics.get("theta_fz", float("nan"))):
            self._theta.append(metrics["theta_fz"])
        if not math.isnan(metrics.get("beta_alpha_fz_cz", float("nan"))):
            self._ba.append(metrics["beta_alpha_fz_cz"])
        if not math.isnan(metrics.get("alpha_posterior", float("nan"))):
            self._ap.append(metrics["alpha_posterior"])
        if not math.isnan(metrics.get("faa", float("nan"))):
            self._faa.append(metrics["faa"])

    def _z(self, dq: deque, x: float) -> float:
        if math.isnan(x) or len(dq) < 2:
            return float("nan")
        arr = np.array(dq, dtype=np.float64)
        mu = float(np.nanmean(arr))
        sd = float(np.nanstd(arr))
        if sd < 1e-12:
            return 0.0
        return (x - mu) / sd

    def z_scores(self, metrics: Dict[str, float]) -> Dict[str, float]:
        return {
            "z_theta_fz": self._z(self._theta, metrics.get("theta_fz", float("nan"))),
            "z_beta_alpha": self._z(self._ba, metrics.get("beta_alpha_fz_cz", float("nan"))),
            "z_alpha_posterior": self._z(self._ap, metrics.get("alpha_posterior", float("nan"))),
            "z_faa": self._z(self._faa, metrics.get("faa", float("nan"))),
        }

    def ready(self) -> bool:
        return (
            len(self._theta) >= BASELINE_MIN_WINDOWS
            and len(self._ba) >= BASELINE_MIN_WINDOWS
            and len(self._ap) >= BASELINE_MIN_WINDOWS
        )


def compute_relaxation_index(
    metrics: Dict[str, float], z: Dict[str, float]
) -> Tuple[float, Dict[str, Any]]:
    """
    Higher relaxation index:
    - Higher posterior alpha (z_alpha_posterior)
    - Lower frontal theta (use -z_theta)
    - Lower beta/alpha (use -z_beta_alpha)
    - FAA: use -z_faa as exploratory calm term (invert association if needed in studies)
    """
    terms: List[float] = []
    weights: List[float] = []
    w = 0.25

    z_ap = z.get("z_alpha_posterior", float("nan"))
    if not math.isnan(z_ap):
        terms.append(z_ap)
        weights.append(w)

    z_th = z.get("z_theta_fz", float("nan"))
    if not math.isnan(z_th):
        terms.append(-z_th)
        weights.append(w)

    z_ba = z.get("z_beta_alpha", float("nan"))
    if not math.isnan(z_ba):
        terms.append(-z_ba)
        weights.append(w)

    z_f = z.get("z_faa", float("nan"))
    if not math.isnan(z_f):
        terms.append(-z_f)
        weights.append(w)

    if not terms:
        ri = RELAXATION_INDEX_CENTER
    else:
        sw = sum(weights)
        raw = sum(t * wt for t, wt in zip(terms, weights)) / sw
        ri = RELAXATION_INDEX_CENTER + RELAXATION_INDEX_K * raw
    ri = float(max(0.0, min(100.0, ri)))

    out_metrics = dict(metrics)
    out_metrics.update(z)
    out_metrics["relaxation_index_raw_terms"] = len(terms)
    return ri, out_metrics


def pad_to_eight(data: np.ndarray) -> np.ndarray:
    """Pad 5-channel rows to 8 columns with NaN; trim extras to 8."""
    data = np.asarray(data, dtype=np.float64)
    if data.ndim != 2:
        raise ValueError("expected 2d array")
    n, c = data.shape
    if c > 8:
        data = data[:, :8]
        c = 8
    if c == 8:
        return data
    if c == 5:
        out = np.full((n, 8), np.nan, dtype=np.float64)
        out[:, :5] = data
        return out
    raise ValueError(f"unsupported channel count {c}")
