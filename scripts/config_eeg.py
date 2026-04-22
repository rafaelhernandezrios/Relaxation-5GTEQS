"""EEG sampling and channel layout (AURA LSL). See LATEST_EXECUTABLE_STACK.md §8."""

SAMPLE_RATE_HZ = 250
WINDOW_DURATION_S = 4.0
WINDOW_SAMPLES = int(SAMPLE_RATE_HZ * WINDOW_DURATION_S)
ADAPTIVE_UPDATE_INTERVAL_S = 2.0
BAD_CHANNEL_VALUE = -375000.0

# Band definitions (Hz)
THETA_BAND = (4.0, 8.0)
ALPHA_BAND = (8.0, 13.0)
BETA_BAND = (13.0, 30.0)

# Logical 10–20 indices into padded (n, 8) array — see §8.2
IDX_F1 = 0   # left FAA
IDX_FP1 = 1
IDX_FZ = 2
IDX_FP2 = 3
IDX_F2 = 4   # right FAA
IDX_P5 = 5
IDX_P6 = 6
IDX_P7 = 7

# Minimum windows before baseline z-scores are trusted
BASELINE_MIN_WINDOWS = 20

# Map relaxation composite to 0–100
RELAXATION_INDEX_K = 12.0
RELAXATION_INDEX_CENTER = 50.0
