#!/usr/bin/env bash
# Kuake Studio 启动器
#   ./run.sh              → 默认 8787 端口，自动开浏览器
#   PORT=9000 ./run.sh    → 指定端口
#   ./run.sh --cli list --path / → 同一套命令走终端（lilyco 框架的 CLI 后端）
#   ./run.sh --mcp        → 以 MCP server 方式跑（给 AI 用）
set -euo pipefail
cd "$(dirname "$0")"

# 凭据单一口径：~/.config/kuake/.env（由 tools/dump-cookies.mjs --write-env 刷新）
# 必须先清掉继承来的旧 KUAKE_COOKIE，否则 kuake.rs 的 load_env_fallback 会提前返回、用上过期 cookie
unset KUAKE_COOKIE KUAKE_PUS KUAKE_PUUS
if [ -f "$HOME/.config/kuake/.env" ]; then
  set -a; . "$HOME/.config/kuake/.env"; set +a
fi

# 共享编译缓存（多个 lilyco 项目共用，见 ~/.local/bin/lyc）
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/home/lilyco/.cache/lilyco-build/target}"
BIN="$CARGO_TARGET_DIR/release/kuake-studio"
[ -x "$BIN" ] || BIN="$CARGO_TARGET_DIR/debug/kuake-studio"
[ -x "$BIN" ] || BIN="./target/debug/kuake-studio"

if [ ! -x "$BIN" ]; then
  echo "找不到二进制，先编译：" >&2
  echo "  cd $(pwd) && cargo build --offline" >&2
  exit 1
fi

if [ ! -f frontend/dist/index.html ]; then
  echo "前端未构建：cd frontend && bun install && bun run build" >&2
fi

if [ "${1:-}" = "--cli" ] || [ "${1:-}" = "--mcp" ] || [ "${1:-}" = "--schema" ] || [ "${1:-}" = "-h" ]; then
  exec "$BIN" "$@"
fi
# 已经显式写了 --port 就不要再补一个，否则 chrome 打开的是最后一个端口、日志却打第一个
case " $* " in
  *" --port "*) exec "$BIN" "$@" ;;
  *) exec "$BIN" --port "${PORT:-8787}" "$@" ;;
esac
