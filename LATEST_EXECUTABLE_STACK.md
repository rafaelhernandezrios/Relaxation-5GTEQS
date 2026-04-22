# Latest executable stack — context for AI / Plataforma ejecutable (contexto)

This document describes **only what `npm run experiment` and `run-experiment.sh` launch**: technologies, participant flow (scenes), transitions, WebSocket communication, and the researcher UI. It excludes classic self-guided flows unless noted.

Este documento describe **solo lo que arrancan `npm run experiment` y `run-experiment.sh`**: tecnologías, flujo del participante (escenas), transiciones, comunicación WebSocket e interfaz del investigador. Excluye flujos clásicos autoguiados salvo nota al final.

**Code-level detail (LSL, Web VR / hand tracking, buffers, pseudocode):** see **§8**.

---

## 1. Executable command / Comando ejecutable

```bash
npm run experiment
# or: ./run-experiment.sh (macOS/Linux) / run-experiment.bat (Windows)
```

**Processes (from root `package.json`):**

| Process | Role |
|--------|------|
| `serve:https` | `http-server` serves **`app/`** over **HTTPS port 8443** (needed for WebXR on many devices). |
| `python3 scripts/aura_recorder.py --wss` | **AURA LSL** ↔ **WebSocket port 8765** (WSS using project `cert.pem` / `key.pem`). |
| `npm run monitor` | **Electron adaptive monitor** (`monitor-electron/`): researcher UI, WebSocket client to the recorder. |

**Prerequisites:** Node (`npm install` triggers `postinstall` for `monitor-electron`), Python venv with `requirements.txt` (`pylsl`, `websockets`, `numpy`, `scipy`). First run: `npm run cert` for TLS (used by HTTPS static server and WSS).

---

## 2. Technology stack / Pila tecnológica

### Participant (browser / VR)

- **A-Frame 1.7** (CDN: `aframe.min.js`).
- Static **HTML / CSS / JS** under `app/`.
- **360° video:** hidden `<video>` + **VideoTexture** on **`<a-videosphere>`** (custom A-Frame components manage texture lifecycle to avoid flicker).
- **`app/js/app-base.js`:** `window.assetUrl()` and `APP_BASE_URL` for correct asset URLs on different hosts (e.g. Quest on LAN).
- **`app/js/logger.js`:** session logging where used.
- Content model: **`app/data/content.json`** — phobias, optional per-phobia **baseline** (level 0), exposure levels **1–5**, `video_url_360`, `duration_seconds`.

### Backend bridge (EEG)

- **`scripts/aura_recorder.py`:** asyncio **websockets** server, LSL inlet **"AURA"**, adaptive metrics from **`eeg_adaptive.py`** / **`config_eeg.py`**, CSV output under **`output/`**.

### Researcher UI

- **`monitor-electron/`:** **Electron** + **Vite** + **React 18**; main process uses **`ws`** (`monitor-electron/src/main/ws-client.ts`) with reconnect; local WSS may use `rejectUnauthorized: false`.

### Not used by `npm run experiment`

- **`server-https.js`** — the launcher uses **`http-server -S`**, not this file.
- **Tk monitor** (`scripts/adaptive_monitor_gui.py`, `npm run monitor:tk`) — optional fallback, not the default stack.

---

## 3. Participant flow: “scenes” / Flujo: escenas

### Default lab path (EEG)

1. **`app/index.html`** → redirect to **`disclaimer-v2.html`**.
2. **`disclaimer-v2.html`:** 2D disclosure overlay + embedded **`<a-scene>`** (VR consent buttons). On **Accept**, the default behavior is **full navigation** to **`experiment-wait-config.html`** (adds **`?vr=1`** if VR mode was active). The in-page “choice” / embedded EEG menus are **not** used on this default path.
3. **`experiment-wait-config.html`:**  
   - **Waiting state:** “Waiting for configuration” (2D card + simple VR text).  
   - **Experiment state:** after WebSocket **`start_experiment`** — bottom **HUD** (level, phobia label, time, fear index, **EMERGENCY EXIT**), **`a-videosphere`** world visible, video playback driven by level and `content.json`.

### Classic / demo (not started by `npm run experiment`)

- **`index-classic.html` → `menu.html` → `level-select.html` → `player.html`** — self-guided phobia/level selection without researcher WebSocket control.
- **`experiment.html`** — legacy alternate experiment page (see README tree).

---

## 4. Transitions / Transiciones

- **Between pages:** hard navigation (`location.href`) disclaimer → wait-config.
- **Inside `experiment-wait-config.html`:** no SPA router; **DOM state** toggles:
  - Waiting: show `#waiting-screen`, VR `#waiting-vr`, hide video world / HUD.
  - Running: hide waiting, show **`#video-hud`**, show **`#video-world`** + videosphere, load video URL for current level.
- **Level changes:** same `<video>` element, new `src` from `content.json`; texture refresh flags (`_playerForceReapply` / similar); HUD badge updates.
- **Session types:** `hybrid` (adaptive + manual) vs **`auto_sequence`** (timed ramp baseline **0** → **1…5** per `duration_seconds` split).
- **VR:** optional auto `enterVR()` when URL has **`?vr=1`**; `vr-world-offset` adjusts world position in VR.
- **Web VR implementation detail** (hand layers, pinch, pseudocode): **§8.11–8.15**.

---

## 5. WebSocket protocol (port 8765) / Protocolo WebSocket

Browser connects to **`wss://<hostname>:8765`** when the page is HTTPS (same host as the app).

### Client → `aura_recorder` (examples)

| Message `type` | Purpose |
|----------------|---------|
| `controller_start` | Start recording + broadcast **`start_experiment`** to all browser clients (phobia, level 0–5, `experiment_id`, `duration_seconds`, `session_type`, `baseline_calibration_seconds`, etc.). |
| `start` | Start recording from a browser (no broadcast of `start_experiment` in the same way as controller — see `aura_recorder.py`). |
| `level_change` | Sync level on recorder after client-side adaptive step. |
| `manual_level` | Set level 0–5; server broadcasts **`force_level`** to all clients. |
| `set_auto_adaptation` | Toggle; broadcast **`auto_adaptation_toggle`**. |
| `stop` | Save CSV, stop recording, broadcast **`stop_video`** / stopped status. |
| `stop_video` | Broadcast stop video UI only (without full stop semantics — see script). |

### Server → browsers (examples)

| Message | Purpose |
|---------|---------|
| `start_experiment` | Participant UI starts experiment (from `controller_start` path). |
| `adaptive_state` | `fear_index`, metrics (`theta_fz`, `beta_alpha_fz_cz`, …), `level_suggestion`, calibration fields, etc. |
| `force_level` | Immediate level sync (e.g. manual from monitor). |
| `auto_adaptation_toggle` | Client enables/disables applying adaptive suggestions. |
| `stop_video` | Return participant to waiting / stop playback. |
| `status: stopped` (and related) | Acknowledgments / end of run. |

Full logic: **`scripts/aura_recorder.py`** (`handle_websocket`, `adaptive_broadcast_loop`).

---

## 6. Researcher interface (Electron) / Interfaz del investigador

- **Path:** `monitor-electron/`.
- **Tabs:** **Metrics** (fear/engagement, mood, θ Fz, β/α, posterior α, FAA) and **Session** (phobia from `content.json`, start level 0–5, experiment ID, duration, baseline calibration seconds, `hybrid` vs `auto_sequence`, **Start** / **Stop**, **adaptive toggle**, **manual levels** 0–5).
- **Start experiment** sends **`controller_start`** with the selected fields (see `monitor-electron/src/renderer/src/App.tsx`).
- WebSocket connection: main process **`RecorderWsClient`**, renderer receives `ws:message` / `ws:status` via preload API.

---

## 7. File map (executable-relevant) / Mapa de archivos

| Area | Files |
|------|--------|
| Entry & wait | `app/index.html`, `app/disclaimer-v2.html`, `app/experiment-wait-config.html` |
| Assets helper | `app/js/app-base.js` |
| Content | `app/data/content.json` |
| Recorder | `scripts/aura_recorder.py`, `scripts/eeg_adaptive.py`, `scripts/config_eeg.py` |
| Monitor | `monitor-electron/` (e.g. `src/renderer/src/App.tsx`, `src/main/ws-client.ts`) |
| Launcher | `package.json` scripts, `run-experiment.sh`, `run-experiment.bat` |
| Certs | `generate-cert.js` → `cert.pem` / `key.pem` (project root) |

---

## 8. Code paths & pseudocode / Rutas de código y pseudocódigo

Real implementation lives in `scripts/aura_recorder.py`, `scripts/config_eeg.py`, `scripts/eeg_adaptive.py`, and `app/experiment-wait-config.html`. Below is **pseudocode** aligned with the current logic.

La implementación real está en esos archivos. Lo siguiente es **pseudocódigo** alineado con la lógica actual.

### 8.1 LSL: cómo se conecta a AURA / How AURA LSL is opened

**API:** `pylsl` — `resolve_byprop("name", "AURA")`, then `StreamInlet(stream_info)`.

```
function start_lsl():
    streams = resolve_byprop("name", "AURA")
    if streams is empty:
        raise "No stream named AURA"
    # Optional: pick by --lsl-source-id (match source_id) or newest created_at
    chosen = pick_stream(streams)
    inlet = StreamInlet(chosen)
    read channel_count from inlet.info() → channel_names = ["ch1", "ch2", ...]
```

**Formato de cada muestra / Sample format:** `inlet.pull_sample(timeout)` → `(sample, timestamp)` where `sample` is a **list of floats**, one value per EEG channel at **~250 Hz** (see `SAMPLE_RATE_HZ` in `config_eeg.py`). The LSL layer is vendor-specific; this project assumes the stream is named **`AURA`** and uses whatever channel count the device publishes (5 or 8 are handled downstream).

**Valor sentinela / Sentinel for disconnected channels:** AURA may emit **`BAD_CHANNEL_VALUE` (-375000)** for disconnected electrodes; `eeg_adaptive._replace_bad_channels` maps those to **NaN** before metrics.

---

### 8.2 Mapeo de canales AURA → índices usados en métricas / Channel mapping

Defined in **`config_eeg.py`** as `CHANNEL_TO_1020` (conceptual labels). The **numeric array** passed to `eeg_adaptive` is shaped **`(n_samples, 8)`** with indices:

| Index | Default label (device mapping) | Used for |
|-------|-------------------------------|----------|
| 0 | F1 (as “left” for FAA) | FAA, frontal alpha fallback |
| 1 | Fp1 | frontal alpha fallback |
| 2 | **Fz** | theta, β/α with frontal refs |
| 3 | Fp2 | frontal alpha fallback |
| 4 | F2 (as “right” for FAA) | FAA, β/α |
| 5–7 | OFF6/OFF7/OFF8 or Pz/P3/P4/Oz | posterior alpha if real electrodes; else NaN → fallback |

If the stream has **only 5 channels**, `get_recent_window` **pads** columns 5–7 with **NaN** so the shape stays `(WINDOW_SAMPLES, 8)`.

**Constants (typical):** `SAMPLE_RATE_HZ = 250`, `WINDOW_DURATION_S = 4.0` → `WINDOW_SAMPLES = 1000`; `ADAPTIVE_UPDATE_INTERVAL_S = 2.0` (broadcast tick).

---

### 8.3 Hilo de muestreo EEG / EEG sampling thread (`EEGRecorder`)

```
function _reader_thread():
    while recording and inlet exists:
        sample, ts = inlet.pull_sample(timeout=0.1)
        if sample is not None and current_label is set:
            append (ts, list(sample), current_label) to samples_buffer under lock
```

**Label string** when level changes: `{phobia_id}_level{level}` (e.g. `arachnophobia_level2`).

---

### 8.4 Ventana reciente para adaptación / `get_recent_window`

```
function get_recent_window():
    buf = copy(samples_buffer)
    if len(buf) < WINDOW_SAMPLES:
        return None
    take last WINDOW_SAMPLES rows
    arr = numpy array of shape (WINDOW_SAMPLES, n_channels_from_device)
    if arr has 8 columns:
        return arr
    if arr has 5 columns:
        padded = full of NaN shape (N, 8)
        padded[:, :5] = arr[:, :5]
        return padded
    return None
```

---

### 8.5 Métricas por ventana y índice compuesto / `compute_fear_engagement_index`

**Pipeline (see `eeg_adaptive.py`):**

```
function compute_fear_engagement_index(data, baseline):
    # data: (n_samples, 8)
    replace BAD_CHANNEL_VALUE with NaN per channel

    theta_fz      = mean power in THETA band at Fz index
    beta_alpha    = mean_beta(Fz + frontal refs) / mean_alpha(same)  # ratio
    alpha_post    = mean alpha at posterior indices OR frontal fallback if NaN
    faa           = (alpha_right - alpha_left) / (alpha_right + alpha_left)  # F2 vs F1 indices here

    (z_theta, z_ba, z_ap, z_faa) = baseline.z_score(...)   # first ~20 windows finalize baseline stats

    z_alpha_suppression = -z_ap    # lower raw alpha → more positive contribution

    fear_index = weighted_mean of available z terms (weights 0.25 each), renormalizing if some NaN
    metrics = { theta_fz, beta_alpha_fz_cz, alpha_posterior, faa, z_* ... }
    return fear_index, metrics
```

**`fear_stress_threshold(ref_mean, ref_std)`:** `μ + (15/100) * max(σ, 0.05)` — additive, not `μ*(1+pct/100)`.

**`tick_dwell_and_suggest(agg, current_level, stress_thr, dwell_above_s, _, dt, dwell_required_s)`:**

- If `agg >= stress_thr`: accumulate `dwell_above_s += dt`; when ≥ `dwell_required_s` → **`"down"`** (reduce level), reset dwell.
- Else: reset dwell above → **`"up"`** if level `< 5` else **`"hold"`** (browser/recorder may still apply extra hysteresis on the VR side for legacy flows).

The recorder combines this with a **rolling mean** `agg` of recent `fear_index` values (`_fear_index_ring`) and optional **timed baseline** (`baseline_calibration_seconds`).

---

### 8.6 Bucle adaptativo del servidor / `adaptive_broadcast_loop` (pseudocode)

```
every ADAPTIVE_UPDATE_INTERVAL_S seconds:
    if not recording or no websocket clients:
        continue
    data = get_recent_window()
    if data is None:
        continue

    fear_index, metrics = compute_fear_engagement_index(data, recorder.baseline)
    baseline.update(theta_fz, beta_alpha, alpha_post, faa from metrics)

    # Timed calibration vs sample-count calibration — see aura_recorder.py
    # Produces: adaptive_phase, agg, stress_thr, level_suggestion ("up"|"down"|"hold")

    payload = {
        type: "adaptive_state",
        fear_index, fear_index_aggregate, fear_ref_mean, fear_ref_std,
        fear_stress_threshold, level_suggestion, current_level,
        adaptive_phase, baseline_remaining_s, metrics: { ... }
    }
    send JSON payload to every connected websocket client

    # Optional --lsl: also push_sample to outlet VRPhobia_State (fear_index, current_level)
```

---

### 8.7 Enrutado WebSocket entrante / `handle_websocket` (simplified)

```
on message JSON:
    switch type:
        "start" | "controller_start":
            optionally save_csv + stop if already recording
            start_recording(phobia_id, level, experiment_id, baseline_calibration_seconds)
            if type == "controller_start":
                broadcast { type: "start_experiment", ... } to ALL clients
            reply { status: "started", ... }

        "level_change":
            recorder.set_level(level) → reply { status: "level_changed" }

        "manual_level":
            recorder.set_level(level)
            broadcast { type: "force_level", level } to ALL clients

        "set_auto_adaptation":
            broadcast { type: "auto_adaptation_toggle", enabled }

        "stop":
            path = save_csv(); stop_recording()
            broadcast { type: "stop_video" }; reply { status: "stopped", file: path }
```

---

### 8.8 Formato CSV de salida / Output CSV (`save_csv`)

**Path pattern:** `output/eeg_{phobia_id}_{experiment_id}_{YYYYMMDD_HHMMSS}.csv`

**Header:** `timestamp`, `ch1`, `ch2`, … (dynamic channel names from LSL), `label`

**Each row:** LSL timestamp, float samples per channel, string label (e.g. `arachnophobia_level3`).

---

### 8.9 Cliente web `experiment-wait-config.html` / Browser client (pseudocode)

```
on load:
    fetch content.json → contentData
    connectWebSocket() → wss://host:8765
    showWaitingUI()

on websocket message:
    parse JSON
    if type == "adaptive_state":
        update fear index on HUD
        if autoAdaptationEnabled and not autoSequence:
            applyAdaptiveSuggestion(level_suggestion)  # may call setLevelTo after lock window
    if type == "force_level":
        setLevelTo(level, sendLevelChange: false)
    if type == "auto_adaptation_toggle":
        autoAdaptationEnabled = enabled
    if type == "start_experiment":
        startExperiment(payload)  # phobia_id, level, duration, session_type, ...
    if type == "stop_video" or status stopped:
        stopExperimentUI()

setLevelTo(level):
    clamp 0..5, update HUD badge, optionally send { type: "level_change", level }
    loadVideoForLevel(level) → resolve URL from content.json → set video#src, refresh texture

startExperiment(payload):
    showExperimentUI()
    load baseline or level video; if auto_sequence schedule timers 1..5
    if duration_seconds > 0: setTimeout → endExperiment → send { type: "stop" }
```

---

### 8.10 Monitor Electron: inicio de sesión / `App.tsx` start (pseudocode)

```
onStart():
    level = parse startLevel (or 0 if sessionType == "auto_sequence")
    send websocket JSON:
        type: "controller_start"
        phobia_id, phobia_name, level, experiment_id,
        duration_seconds, session_type, baseline_calibration_seconds
```

**Manual level buttons:** `send({ type: "manual_level", level: n })`.

---

### 8.11 Web VR pages on the executable path / Páginas Web VR en el flujo ejecutable

| Page | Hand tracking | Role in `npm run experiment` |
|------|---------------|------------------------------|
| **`disclaimer-v2.html`** | **Yes** — `hand-tracking-controls` ×2 + custom components (see §8.13) | Consent; **Accept** → navigates away (see §3). VR UI uses layers + raycasters. |
| **`experiment-wait-config.html`** | **No** — camera + `look-controls` only | Main EEG page: wait → 360° video + 2D HUD. |

Shared: **A-Frame 1.7**, `app/js/app-base.js` (`assetUrl`). **`js/vr-ui.js`** (`vr-hover-scale`) is loaded on **classic** `menu.html` / `level-select.html`, **not** on these two pages.

---

### 8.12 Rendering layers & raycasters / Capas y raycasters (Three.js)

Used on **`disclaimer-v2.html`** so UI quads (e.g. experiment cards) stay visible **over** the 360° sphere when both exist in the scene.

- **`layer-over-video`:** on `init`, traverses `object3D` and sets **`layers.set(1)`** on meshes (render layer **1**).
- **`camera-enable-layer-1`:** enables **layer 1** on the actual Three.js camera so layer-1 objects are drawn.
- **`raycaster-both-layers`:** enables **layer 1** on the A-Frame `raycaster` so hits work on both default layer **0** and UI layer **1** (required for `.clickable` on cards above video).

**Pseudocode:**

```
layer-over-video.init:
    traverse el.object3D:
        if object.layers: layers.set(1)

camera-enable-layer-1.init:
    camera.layers.enable(1)

raycaster-both-layers.init:
    raycaster.layers.enable(1)  # after raycaster ready
```

---

### 8.13 Hand tracking stack / Pila de hand tracking

**Markup pattern** (see `disclaimer-v2.html` — same idea as `menu.html` / `player.html`):

```html
<a-entity id="cam-rig" vr-camera-height="height: 2.0">
  <a-entity id="cam" camera look-controls
    cursor="rayOrigin: mouse; fuse: true; ..."
    raycaster="objects: .clickable; ..." raycaster-both-layers />
  <a-entity hand-tracking-controls="hand: left; modelStyle: mesh"
    raycaster="objects: .clickable; far: 8" raycaster-both-layers
    hand-pose-sync hand-pinch-cursor hand-laser-visual />
  <!-- same for right -->
</a-entity>
```

**Built-in:** A-Frame **`hand-tracking-controls`** (WebXR hand tracking mesh).

**Custom components (registered inline in `disclaimer-v2.html`):**

| Component | Purpose |
|-----------|---------|
| **`hand-pose-sync`** | Each **tick**: read `hand-tracking-controls.wristObject3D` world position/quaternion, convert to **local space of parent** (camera rig), assign to the hand entity. Effect: the raycaster + laser **follow the physical wrist** so pointing matches the real hand. |
| **`hand-pinch-cursor`** | On **`pinchended`**: read `raycaster.intersectedEls` (or first `intersections`), walk up to an element with class **`clickable`**, **`emit('click')`** on it — same as a fuse click but **pinch**-triggered. |
| **`hand-laser-visual`** | **init:** child entities = cyan **cylinder** (beam) + **ring** (hit cursor). **tick:** beam length = `min(raycaster hit distance, maxLength)`; cursor at hit distance. |
| **`vr-camera-height`** | In VR mode, forces rig `position.y` to configured height (e.g. 2.0) for consistent stance. |

**After entering VR:** listeners call **`raycaster.refreshObjects()`** on `#cam` and on each `[hand-tracking-controls]` so newly visible `.clickable` meshes are picked up (see `enter-vr` in `disclaimer-v2.html`).

**Pseudocode (combined):**

```
each frame (hand-pose-sync):
    wrist = handTrackingControls.wristObject3D
    pos_local = rig.worldToLocal(wrist.getWorldPosition())
    quat_local = wrist.worldQuaternion adjusted for rig
    handEntity.object3D.position / quaternion = pos_local, quat_local

on pinch end (hand-pinch-cursor):
    target = first intersected aframe element with .clickable ancestor
    if target: target.emit("click")

each frame (hand-laser-visual):
    dist = raycaster.firstHitDistance or maxRayLength
    resize beam to dist; place ring at dist along local -Z
```

---

### 8.14 View transitions in `disclaimer-v2.html` / Transiciones entre vistas (disclaimer)

The **default lab path** only uses **`goToChoice()`** → **`location.href = 'experiment-wait-config.html' + (?vr=1)`**. The same file still contains **in-page** state machines used if you stay on the page (e.g. **Experiment EEG** embedded flow).

**2D ↔ VR overlay (`exit-vr`):** if the user leaves VR mid-flow, the script shows the appropriate **2D** block (`#disclaimer-2d`, `#choice-2d`, `#experiment-select-2d`) depending on which VR panel was visible (waiting vs video vs choice).

**In-page “views” (optional / not default after Accept):**

| Transition | Mechanism |
|------------|-----------|
| Consent → choice | `goToChoice()` **or** hide `#disclaimer-2d`, show `#choice-2d` / VR `choice-panel` (when not using redirect-only path). |
| Choice → EEG experiment menu | `goToExperimentView()`: hide choice 2D, show `#experiment-select-2d`, show VR `#vr-experiment-menu`, hide `#video-world-flow`, restore reticle + sky + ray line. |
| EEG menu → 360° video | `selectPhobiaInFlow()`: hide menus, show `#video-world-flow`, hide reticle & `a-sky`, disable camera ray line (`showLine: false`), **`loadVideoForLevelFlow`**. |
| Back from EEG menu | `goBackFromExperiment()`: show choice again, reposition VR `choice-panel` to `0 3.5 -2`. |

**Trick:** `choice-panel` may be moved to **`position="0 -50 -100"`** when entering the experiment menu so it **does not intercept raycasts** in VR.

---

### 8.15 `experiment-wait-config.html`: waiting ↔ experiment (no hands) / Espera ↔ experimento

- **Rig:** `#camera-rig` + `#main-camera` with **`look-controls`** only (no `hand-tracking-controls`).
- **`vr-world-offset`:** on `enter-vr`, sets **`#video-world`** entity `position` to `(0, offsetY, 0)` (default **-1.5**); on `exit-vr`, resets to **0** — vertical alignment of the 360° sphere in headset vs desktop.
- **Transitions:**
  - **`showWaitingUI()`:** show `#waiting-screen`, show `#waiting-vr`, **`visible=false`** on `#video-world`, pause video, hide `#video-hud`.
  - **`showExperimentUI()`:** hide waiting 2D/VR text, **`visible=true`** on `#video-world`, show `#video-hud`.
- **360 texture:** component **`video-texture-on-ready`** on `a-videosphere` — builds **one** `THREE.VideoTexture` when `readyState >= 2`, updates `needsUpdate` on time change (contrast: **`disclaimer-v2`** uses **`video-texture-flow`** for the embedded EEG demo path with `_flowForceReapply` flags).

---

## 9. Adapting for a “relaxation” platform / Adaptación a relajación

Reuse the same **architecture**: static A-Frame app + HTTPS + one **Python WebSocket bridge** (EEG or other biosignals) + **Electron** (or web) controller. Replace **`content.json`** structure and copy/HUD strings; adjust **`eeg_adaptive.py`** metrics and naming if the signal goal changes (e.g. relaxation index instead of fear/engagement).

Para una plataforma de **relajación**, puedes reutilizar la misma **arquitectura**: app A-Frame estática + HTTPS + **puente WebSocket en Python** (EEG u otras señales) + **Electron** como controlador. Sustituye **`content.json`** y textos; ajusta métricas en **`eeg_adaptive.py`** si el objetivo deja de ser miedo/exposición.
