#!/usr/bin/env bash
# Run the F.E.A.R. backend and frontend together for local development.
# Stops both on Ctrl+C.
set -euo pipefail

cd "$(dirname "$0")/.."

python main.py &
backend_pid=$!

npm run dev &
frontend_pid=$!

cleanup() {
  kill "$backend_pid" "$frontend_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "F.E.A.R. backend (pid $backend_pid) → http://127.0.0.1:8765"
echo "F.E.A.R. frontend (pid $frontend_pid) → http://localhost:3000"
wait
