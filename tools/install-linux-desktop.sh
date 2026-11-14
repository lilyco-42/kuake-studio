#!/usr/bin/env bash
# kuake-studio Linux 桌面安装器（幂等，可重复跑）
#   ./install.sh                装好桌面图标 + 开机自启，双击「夸克网盘」即用
#   ./install.sh --uninstall   卸载桌面入口（不动凭据与已下载文件）
# 用法：从 Release 下载 *-linux-x64.tar.gz，解压后在该目录里跑一次本脚本。
# 之后不需要知道 IP / 端口：服务固定监听 127.0.0.1:8787，开机自动在后台跑。
set -euo pipefail

PORT=8787
URL="http://127.0.0.1:${PORT}/"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SRC/kuake-studio"
die() { echo "✗ $*" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || die "需要 curl（用于探活），请先安装"

USER_HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
USER_ID="$(id -u)"
RUNTIME="${XDG_RUNTIME_DIR:-/run/user/$USER_ID}"
BUS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$RUNTIME/bus}"
OPT="$USER_HOME/.local/opt/kuake-studio"
UNIT_DIR="$USER_HOME/.config/systemd/user"
UNIT="$UNIT_DIR/kuake-studio.service"
APPS="$USER_HOME/.local/share/applications"
ICON_DIR="$USER_HOME/.local/share/icons/hicolor/1024x1024/apps"
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
[ -d "$DESKTOP_DIR" ] || DESKTOP_DIR="$USER_HOME/Desktop"
[ -d "$DESKTOP_DIR" ] || DESKTOP_DIR="$USER_HOME/桌面"

export XDG_RUNTIME_DIR="$RUNTIME"
export DBUS_SESSION_BUS_ADDRESS="$BUS"
have_systemd() { command -v systemctl >/dev/null 2>&1 && [ -S "$RUNTIME/bus" ] && systemctl --user daemon-reload >/dev/null 2>&1; }
boot_ok() { curl -sf -o /dev/null "$URL/api/boot"; }

# ── 卸载 ──────────────────────────────────────────────────────────────
if [ "${1:-}" = "--uninstall" ]; then
  systemctl --user stop kuake-studio.service 2>/dev/null || true
  systemctl --user disable kuake-studio.service 2>/dev/null || true
  rm -f "$UNIT" "$APPS/kuake-studio.desktop" "$ICON_DIR/kuake-studio.png" "$DESKTOP_DIR/夸克网盘.desktop"
  rm -rf "$OPT"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "✓ 已卸载 kuake-studio 桌面入口（凭据与下载文件未动）"
  exit 0
fi

# ── 前置检查 ──────────────────────────────────────────────────────────
[ -x "$BIN" ] || die "找不到 kuake-studio：请把本脚本放在解压出的 linux-x64 包目录里运行"
[ -f "$SRC/dist/index.html" ] || die "找不到 dist/index.html：包不完整"

echo "→ 安装到 $OPT"
mkdir -p "$OPT" "$UNIT_DIR" "$APPS" "$ICON_DIR" "$DESKTOP_DIR"
cp -f "$BIN" "$OPT/kuake-studio"; chmod 755 "$OPT/kuake-studio"
rm -rf "$OPT/dist"; cp -r "$SRC/dist" "$OPT/dist"
[ -f "$SRC/start.sh" ] && { cp -f "$SRC/start.sh" "$OPT/start.sh"; chmod 755 "$OPT/start.sh"; } || true
[ -f "$SRC/kuake-studio-1024.png" ] && cp -f "$SRC/kuake-studio-1024.png" "$ICON_DIR/kuake-studio.png" || true
[ -f "$SRC/README.md" ] && cp -f "$SRC/README.md" "$OPT/README.md" || true

# 一键打开：探活 → 服务没起就拉起 → 打开浏览器。小白全程不用碰地址栏
cat > "$OPT/open.sh" <<'OPEN_EOF'
#!/usr/bin/env bash
# 双击桌面图标时执行：服务没起自动拉起，再打开浏览器；不需要知道 IP/端口
set -u
OPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="http://127.0.0.1:8787/"
boot_ok() { curl -sf -o /dev/null "$URL/api/boot"; }
if ! boot_ok; then
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}"
  systemctl --user start kuake-studio.service >/dev/null 2>&1 || {
    cd "$OPT" || exit 1
    KUAKE_STUDIO_NO_OPEN=1 setsid nohup ./kuake-studio --port 8787 >/dev/null 2>&1 < /dev/null &
  }
  for _ in $(seq 1 60); do boot_ok && break; sleep 0.25; done
fi
# 无桌面 / 自检场景：只确保服务在线，不弹浏览器
[ "${KUAKE_STUDIO_NO_OPEN:-}" = "1" ] && exit 0
xdg-open "$URL" >/dev/null 2>&1 || google-chrome-stable "$URL" >/dev/null 2>&1 || chromium "$URL" >/dev/null 2>&1 || firefox "$URL" >/dev/null 2>&1 || true
OPEN_EOF
chmod 755 "$OPT/open.sh"

# systemd --user：开机自启 + 崩了自动重启（KUAKE_STUDIO_NO_OPEN=1 不弹浏览器）
cat > "$UNIT" <<EOF
[Unit]
Description=kuake-studio 夸克网盘客户端（本地后台服务）
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$OPT
ExecStart=$OPT/kuake-studio --port $PORT
Environment=HOME=$USER_HOME
Environment=KUAKE_STUDIO_NO_OPEN=1
Environment=XDG_RUNTIME_DIR=/run/user/$USER_ID
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$USER_ID/bus
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF

# 桌面图标 + 应用菜单入口（绝对路径，不依赖 PATH；中文桌面目录也支持）
cat > "$DESKTOP_DIR/夸克网盘.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=夸克网盘
Name[zh_CN]=夸克网盘
GenericName=网盘客户端
Comment=双击打开夸克网盘客户端，无需输入地址或端口
Exec=$OPT/open.sh
Icon=kuake-studio
Terminal=false
Categories=Network;
StartupNotify=true
Keywords=quark;kuake;网盘;云盘;
EOF
cp -f "$DESKTOP_DIR/夸克网盘.desktop" "$APPS/kuake-studio.desktop"
chmod 755 "$DESKTOP_DIR/夸克网盘.desktop"
gio set "$DESKTOP_DIR/夸克网盘.desktop" metadata::trusted true 2>/dev/null || true
update-desktop-database "$APPS" 2>/dev/null || true
command -v desktop-file-validate >/dev/null 2>&1 && desktop-file-validate "$APPS/kuake-studio.desktop" 2>/dev/null || true

# ── 起服务 ────────────────────────────────────────────────────────────
if have_systemd; then
  systemctl --user enable kuake-studio.service >/dev/null 2>&1 || true
  systemctl --user restart kuake-studio.service
  echo "→ 后台服务已交给 systemd --user（开机自启、崩溃自动重启）"
else
  echo "→ 未检测到 systemd --user，改为直接后台启动（开机自启需自行配置）"
  (cd "$OPT" && KUAKE_STUDIO_NO_OPEN=1 setsid nohup ./kuake-studio --port "$PORT" >/dev/null 2>&1 < /dev/null &)
fi

ok=0
for _ in $(seq 1 60); do boot_ok && { ok=1; break; }; sleep 0.25; done
[ "$ok" = 1 ] || die "服务没能起来，看日志：journalctl --user -u kuake-studio.service -n 30"

echo "✅ 装好了：桌面双击「夸克网盘」即可使用（不用记 IP / 端口）"
echo "   后台服务开机自启；只监听 127.0.0.1:8787，局域网访问不到"
echo "   卸载：./install.sh --uninstall"
