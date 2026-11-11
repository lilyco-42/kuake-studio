#!/usr/bin/env bash
# 重启 kuake-studio：只杀真正的服务进程（按二进制绝对路径锚定，避免 pkill -f 自杀）
set -uo pipefail
BIN=/home/lilyco/.cache/lilyco-build/target/release/kuake-studio
PORT="${PORT:-8787}"
for pid in $(pgrep -f "^$BIN"); do kill "$pid" 2>/dev/null; done
for _ in $(seq 1 40); do pgrep -f "^$BIN" >/dev/null || break; sleep 0.1; done
cd "$(dirname "$0")"
KUAKE_STUDIO_NO_OPEN="${KUAKE_STUDIO_NO_OPEN:-1}" setsid nohup ./run.sh --port "$PORT" > /tmp/kuake-studio.log 2>&1 < /dev/null &
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/boot"; then echo "up on $PORT"; exit 0; fi
  sleep 0.2
done
echo "failed to come up; log:" >&2; tail -20 /tmp/kuake-studio.log >&2; exit 1
