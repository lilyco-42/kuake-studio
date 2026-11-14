#!/usr/bin/env bash
# kuake-studio Linux 桌面安装器（幂等，可重复跑）
#   ./install.sh                装桌面图标 + 应用菜单 + 开机自启，双击「夸克网盘」即用
#   ./install.sh --uninstall   卸载桌面入口（不动凭据与已下载文件）
# 用法：从 Release 下载 *-linux-x64.tar.gz，解压后在该目录里跑一次本脚本。
#
# 开机自启只有一份真源：XDG 登录项 ${XDG_CONFIG_HOME:-~/.config}/autostart/kuake-studio.desktop
# ——与托盘菜单「开机自启」勾选框读写的是同一个文件（见 src/tray.rs 的 autostart_path）。
# 刻意不再装 systemd --user unit：两套登录项并存时，托盘里取消勾选只能删掉 XDG
# 那份，systemd 仍会在下次登录把服务拉起来，「关掉自启」就成了假动作。
# 服务只监听 127.0.0.1:8787，开机由桌面会话按登录项拉起（带托盘、不弹浏览器）。
set -euo pipefail

PORT=8787
URL="http://127.0.0.1:${PORT}/"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SRC/kuake-studio"
die() { echo "✗ $*" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || die "需要 curl（用于探活），请先安装"

USER_HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$USER_HOME/.config}"
AUTOSTART_DIR="$CONFIG_DIR/autostart"
AUTOSTART="$AUTOSTART_DIR/kuake-studio.desktop"
OPT="$USER_HOME/.local/opt/kuake-studio"
APPS="$USER_HOME/.local/share/applications"
ICON_DIR="$USER_HOME/.local/share/icons/hicolor/1024x1024/apps"
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
[ -d "$DESKTOP_DIR" ] || DESKTOP_DIR="$USER_HOME/Desktop"
[ -d "$DESKTOP_DIR" ] || DESKTOP_DIR="$USER_HOME/桌面"

boot_ok() { curl -sf -o /dev/null "$URL/api/boot"; }

# ── 卸载 ──────────────────────────────────────────────────────────────
if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$AUTOSTART" "$APPS/kuake-studio.desktop" "$ICON_DIR/kuake-studio.png" "$DESKTOP_DIR/夸克网盘.desktop"
  rm -rf "$OPT"
  echo "✓ 已卸载 kuake-studio 桌面入口（凭据与下载文件未动）"
  echo "  正在运行的服务请用托盘菜单「退出」关闭。"
  exit 0
fi

# ── 前置检查 ──────────────────────────────────────────────────────────
[ -x "$BIN" ] || die "找不到 kuake-studio：请把本脚本放在解压出的 linux-x64 包目录里运行"
[ -f "$SRC/dist/index.html" ] || die "找不到 dist/index.html：包不完整"

echo "→ 安装到 $OPT"
mkdir -p "$OPT" "$AUTOSTART_DIR" "$APPS" "$ICON_DIR" "$DESKTOP_DIR"
cp -f "$BIN" "$OPT/kuake-studio"; chmod 755 "$OPT/kuake-studio"
rm -rf "$OPT/dist"; cp -r "$SRC/dist" "$OPT/dist"
[ -f "$SRC/kuake-studio-1024.png" ] && cp -f "$SRC/kuake-studio-1024.png" "$ICON_DIR/kuake-studio.png" || true
[ -f "$SRC/README.md" ] && cp -f "$SRC/README.md" "$OPT/README.md" || true

# 一键打开：探活 → 服务没起就拉起（带托盘，不弹浏览器）→ 打开浏览器
cat > "$OPT/open.sh" <<'OPEN_EOF'
#!/usr/bin/env bash
set -u
OPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="http://127.0.0.1:8787/"
boot_ok() { curl -sf -o /dev/null "$URL/api/boot"; }
if ! boot_ok; then
  (cd "$OPT" && setsid nohup ./kuake-studio --port 8787 --no-open >/dev/null 2>&1 < /dev/null &)
  for _ in $(seq 1 60); do boot_ok && break; sleep 0.25; done
fi
# 无桌面 / 自检场景：只确保服务在线，不弹浏览器
[ "${KUAKE_STUDIO_NO_OPEN:-}" = "1" ] && exit 0
xdg-open "$URL" >/dev/null 2>&1 || google-chrome-stable "$URL" >/dev/null 2>&1 || chromium "$URL" >/dev/null 2>&1 || firefox "$URL" >/dev/null 2>&1 || true
OPEN_EOF
chmod 755 "$OPT/open.sh"

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

# 开机自启：唯一真源，与托盘菜单「开机自启」勾选框共用同一个 XDG 登录项
cat > "$AUTOSTART" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=夸克网盘
Comment=kuake-studio 夸克网盘客户端（系统托盘）
Exec="$OPT/kuake-studio" --port $PORT --no-open
Icon=kuake-studio
Terminal=false
Categories=Network;FileTransfer;Utility;
X-GNOME-Autostart-enabled=true
Hidden=false
EOF

# ── 当场起一次（带托盘）；开机那次交给上面的 XDG 登录项 ──────────────
(cd "$OPT" && setsid nohup ./kuake-studio --port "$PORT" --no-open >/dev/null 2>&1 < /dev/null &)
ok=0
for _ in $(seq 1 60); do boot_ok && { ok=1; break; }; sleep 0.25; done
[ "$ok" = 1 ] || die "服务没能起来，可手动跑：$OPT/kuake-studio --port $PORT"

echo "✅ 装好了：桌面双击「夸克网盘」即可使用（不用记 IP / 端口）"
echo "   开机自启由托盘菜单「开机自启」控制（同一个 XDG 登录项）；只监听 127.0.0.1:8787"
echo "   卸载：./install.sh --uninstall"
