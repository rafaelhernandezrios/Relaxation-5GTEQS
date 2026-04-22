#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ ! -f cert.pem || ! -f key.pem ]]; then
  echo "Run: npm run cert"
  exit 1
fi
exec npm run experiment
