#!/usr/bin/env bash
# One-shot demo: deps, venv, TLS, then mock EEG + HTTPS + Electron monitor.
# Usage: bash scripts/demo.sh   (from repo root or any cwd)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

die() { echo "demo: $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "Install Node.js (LTS): https://nodejs.org/"
command -v python3 >/dev/null 2>&1 || die "Install Python 3."
command -v openssl >/dev/null 2>&1 || die "OpenSSL not found (needed for cert.pem / key.pem)."

echo "==> npm install"
npm install

if [[ ! -x "$ROOT/.venv/bin/python" ]]; then
  echo "==> Creating .venv (Python bridge)"
  python3 -m venv "$ROOT/.venv"
fi
echo "==> pip install — scripts/requirements.txt"
"$ROOT/.venv/bin/pip" install -r "$ROOT/scripts/requirements.txt"

echo "==> TLS (skip if cert.pem / key.pem already exist)"
npm run cert

echo "==> Starting stack: mock EEG (no hardware), HTTPS :8443, monitor"
echo "    Participant URL: https://<this-computer-LAN-IP>:8443/"
echo "    Press Ctrl+C to stop."
npm run experiment:mock
