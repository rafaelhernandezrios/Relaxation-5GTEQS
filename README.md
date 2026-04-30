# Relaxation 360° + EEG (lab stack)

**EN:** HTTPS **A-Frame** participant app (offline-ready, local A-Frame bundle), **Python** WebSocket bridge from LSL stream **“AURA”** (or `--mock-eeg`), and **Electron** researcher monitor with Operator + Exhibition modes. Spec reference: [LATEST_EXECUTABLE_STACK.md](LATEST_EXECUTABLE_STACK.md).

**ES:** App de participante en **A-Frame** por HTTPS (lista para LAN sin internet, A-Frame local), puente **Python** (LSL → WebSocket) y monitor **Electron** con modos Operador + Exhibición.

## What's new in this version / Novedades de esta versión

- **No consent gate on default entry:** `app/index.html` goes directly to `experiment-wait-config.html`.
- **Offline/LAN support:** A-Frame is loaded from `app/js/aframe.min.js` (no CDN dependency).
- **Quest/LAN reliability:** participant page uses robust `runtime-state.json` polling fallback even when WSS is unstable.
- **Exhibition Mode timing model:** configurable **total exhibition time** split across **5 playlist videos + winner replay**.
- **Winner replay is timed:** no infinite winner loop; winner uses the same per-segment duration.

## Quick start

### Easiest path — external demo / demo fácil (mock EEG, no hardware)

**EN:** One script installs Node deps, creates `.venv`, installs Python packages, creates TLS certs, and starts **mock** EEG + HTTPS + Electron. Needs **Node.js**, **Python 3**, and **OpenSSL** (macOS/Linux: usually preinstalled).

**ES:** Un solo script instala dependencias de Node, crea `.venv`, instala paquetes Python, genera certificados TLS y arranca EEG **simulado** + HTTPS + Electron. Requiere **Node.js**, **Python 3** y **OpenSSL**.

```bash
bash scripts/demo.sh
# or: bash demo.sh
```

**Windows:** use **Git Bash** (or WSL) and run `bash scripts/demo.sh`, or double-check `scripts\demo.bat` (delegates to Bash).

After the first setup, repeat runs are faster:

```bash
npm run demo
```

(`npm run demo` = `npm run cert` + `npm run experiment:mock`; ensure `.venv` exists and `pip install -r scripts/requirements.txt` was done once — use `bash scripts/demo.sh` if not.)

---

### Full lab setup (manual steps)

1. **Node:** `npm install` (also installs `monitor-electron/` via `postinstall`).

2. **Python venv (recommended):**

   ```bash
   python3 -m venv .venv
   .venv/bin/pip install -r scripts/requirements.txt
   ```

3. **TLS (required for WebXR / WSS):** `npm run cert` → `cert.pem` / `key.pem` in the project root.

4. **Run everything:**

   ```bash
   npm run experiment
   ```

   - **Participant (Quest / browser):** `https://<this-host>:8443/` (direct entry to `experiment-wait-config.html`, immersive HUD, **sin** `embedded`).
   - **Monitor (Electron):** panel de control (estilo laboratorio) + **iframe** de la misma página HTTPS con `?embedded=1` (vista previa silenciada). **Start** envía `controller_start` al recorder y arranca los vídeos en **todos** los clientes WebSocket (Quest + iframe).
   - Recorder: `wss://<host>:8765`.

**Without EEG hardware:** use mock signals for development:

```bash
npm run experiment:mock
```

(Replace `python3 scripts/aura_recorder.py --wss` in that script with `.venv/bin/python ...` if you rely on the venv.)

## Content

Edit **[app/data/content.json](app/data/content.json)** — exactly **five** `videos` entries (`id`, `title`, `video_url_360`, optional `thumbnail_url`, default `duration_seconds`). Replace sample URLs with your own 360° equirectangular assets as needed.

## Outputs

- CSV under **`output/`** when a session stops (`stop`): `eeg_relax_<experiment_id>_<timestamp>.csv`.
- WebSocket **`experiment_summary`** includes **`per_video_mean_relaxation`** and **`winner_video_id`** (highest mean relaxation index across clips).

## Protocol notes

- **`controller_start`** fields: `experiment_id`, `video_index`, `durations_seconds` (length 5), `baseline_calibration_seconds`, `session_type`: `relaxation_playlist`.
- Browser playlist advances clips locally; server tracks **`relaxation_index`** and per-video means.

## Exhibition mode timing / Temporización en modo exhibición

**EN**

- In Exhibition mode, configure a **total duration** (seconds) from the top bar.
- The app computes: `segment_seconds = max(5, floor(total_seconds / 6))`.
- `controller_start` is sent with `durations_seconds = [segment_seconds x 5]`.
- Winner replay also uses `segment_seconds`, so full exhibition = 5 clips + winner.

**ES**

- En modo Exhibición configuras un **tiempo total** (segundos) en la barra superior.
- La app calcula: `segment_seconds = max(5, floor(total_seconds / 6))`.
- `controller_start` se envía con `durations_seconds = [segment_seconds x 5]`.
- La repetición del ganador usa el mismo `segment_seconds`, así la experiencia completa = 5 clips + ganador.

## ui-ux-pro-max (optional)

The repo keeps a **single** copy of this design skill under **`.claude/skills/ui-ux-pro-max/`** (duplicated IDE sync trees were removed to reduce size).

For extra UI guidance, run (from repo root):

```bash
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "wellness biometrics research dashboard calm" --design-system -p "Relaxation Lab"
```
