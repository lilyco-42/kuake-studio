#!/usr/bin/env bash
# kuake-studio Linux 桌面安装器（幂等，可重复跑）
#   ./install.sh                         装桌面图标 + 应用菜单 + 开机自启，双击「夸克网盘」即用
#   ./install.sh --uninstall            卸载桌面入口（不动凭据与已下载文件）
#   ./install.sh --cleanup-legacy-only  只清 0.5.2–0.5.6 遗留的 systemd --user 登录项
# 用法：从 Release 下载 *-linux-x64.tar.gz，解压后在该目录里跑一次本脚本。
#
# 开机自启只有一份真源：XDG 登录项 ${XDG_CONFIG_HOME:-~/.config}/autostart/kuake-studio.desktop
# ——与托盘菜单「开机自启」勾选框读写的是同一个文件（见 src/tray.rs 的 autostart_path）。
# 刻意不再装 systemd --user unit：两套登录项并存时，托盘里取消勾选只能删掉 XDG
# 那份，systemd 仍会在下次登录把服务拉起来，「关掉自启」就成了假动作。
# 0.5.2–0.5.6 装过这份旧 unit，升级时由 cleanup_legacy_systemd() 一次性清掉；
# 没有 systemd / 用户总线（容器、CI、无桌面会话）时只删文件，绝不让安装失败。
# 服务只监听 127.0.0.1:8787，开机由桌面会话按登录项拉起（带托盘、不弹浏览器）。
set -euo pipefail

PORT=8787
URL="http://127.0.0.1:${PORT}/"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SRC/kuake-studio"
die() { echo "✗ $*" >&2; exit 1; }
# 探活只在「安装」路径需要；--uninstall / --cleanup-legacy-only 不依赖 curl
require_curl() { command -v curl >/dev/null 2>&1 || die "需要 curl（用于探活），请先安装"; }

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

# ── 旧版遗留：systemd --user 登录项 ────────────────────────────────────
# 0.5.2–0.5.6 曾把 kuake-studio.service 装进 systemd --user 并链到
# default.target.wants。它和现在的 XDG 登录项是两份真源：托盘里取消「开机自启」
# 只能删掉 XDG 那份，systemd 下次登录照样把旧服务拉起来，「关掉自启」成假动作。
# 只针对确实存在的旧文件动手，全新安装不碰 systemd。
LEGACY_CLEANED=0
systemd_user_available() {
  # 没有用户总线（容器 / CI / 无桌面会话）时不可用，绝不让安装失败
  command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1
}
cleanup_legacy_systemd() {
  local base unit wants found=0
  # XDG_CONFIG_HOME 被改过时旧 unit 可能在两处，都查一遍
  for base in "$CONFIG_DIR/systemd/user" "$USER_HOME/.config/systemd/user"; do
    unit="$base/kuake-studio.service"
    wants="$base/default.target.wants/kuake-studio.service"
    if [ -f "$unit" ] || [ -e "$wants" ] || [ -L "$wants" ]; then found=1; fi
  done
  [ "$found" = 1 ] || return 0
  if systemd_user_available; then
    # --now 顺带停掉还跑着的旧版本进程，端口随后由本次安装的新实例接管
    systemctl --user disable --now kuake-studio.service >/dev/null 2>&1 || true
  fi
  for base in "$CONFIG_DIR/systemd/user" "$USER_HOME/.config/systemd/user"; do
    rm -f "$base/kuake-studio.service" "$base/default.target.wants/kuake-studio.service"
    rmdir "$base/default.target.wants" 2>/dev/null || true
  done
  if systemd_user_available; then
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
  LEGACY_CLEANED=1
}

# 只清旧登录项：不装程序、不动 XDG 登录项，供便携版用户 / 排障 / CI 自检调用
if [ "${1:-}" = "--cleanup-legacy-only" ]; then
  cleanup_legacy_systemd
  if [ "$LEGACY_CLEANED" = 1 ]; then
    echo "✓ 已清理旧版 systemd --user 登录项（程序与 XDG 登录项未动）"
  else
    echo "✓ 没有发现旧版 systemd --user 登录项，无需清理"
  fi
  exit 0
fi

# ── 卸载 ──────────────────────────────────────────────────────────────
if [ "${1:-}" = "--uninstall" ]; then
  cleanup_legacy_systemd
  rm -f "$AUTOSTART" "$APPS/kuake-studio.desktop" "$ICON_DIR/kuake-studio.png" "$DESKTOP_DIR/夸克网盘.desktop"
  rm -f "$USER_HOME"/.local/share/icons/hicolor/*/apps/kuake-studio.png
  rm -rf "$OPT"
  echo "✓ 已卸载 kuake-studio 桌面入口（凭据与下载文件未动）"
  if [ "$LEGACY_CLEANED" = 1 ]; then
    echo "→ 旧版 systemd --user 登录项已一并清理"
  fi
  echo "  正在运行的服务请用托盘菜单「退出」关闭。"
  exit 0
fi

# ── 前置检查 ──────────────────────────────────────────────────────────
[ -x "$BIN" ] || die "找不到 kuake-studio：请把本脚本放在解压出的 linux-x64 包目录里运行"
[ -f "$SRC/dist/index.html" ] || die "找不到 dist/index.html：包不完整"

echo "→ 安装到 $OPT"
require_curl
cleanup_legacy_systemd
if [ "$LEGACY_CLEANED" = 1 ]; then
  echo "→ 旧版 systemd --user 登录项已清理：开机自启现在只由 XDG 登录项控制"
fi
mkdir -p "$OPT" "$AUTOSTART_DIR" "$APPS" "$ICON_DIR" "$DESKTOP_DIR"
cp -f "$BIN" "$OPT/kuake-studio"; chmod 755 "$OPT/kuake-studio"
rm -rf "$OPT/dist"; cp -r "$SRC/dist" "$OPT/dist"
if [ -d "$SRC/icons" ]; then
  for f in "$SRC"/icons/*x*.png; do
    [ -f "$f" ] || continue
    size="$(basename "$f" .png)"
    d="$USER_HOME/.local/share/icons/hicolor/$size/apps"
    mkdir -p "$d"
    cp -f "$f" "$d/kuake-studio.png"
  done
else
  [ -f "$SRC/kuake-studio-1024.png" ] && cp -f "$SRC/kuake-studio-1024.png" "$ICON_DIR/kuake-studio.png" || true
fi
[ -f "$SRC/README.md" ] && cp -f "$SRC/README.md" "$OPT/README.md" || true

# 一键打开：探活 → 服务没起就拉起（带托盘，不弹浏览器）→ 打开浏览器
cat > "$OPT/open.sh" <<'OPEN_EOF'
#!/usr/bin/env bash
set -u
OPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="http://127.0.0.1:8787/"
boot_ok() { curl -sf -o /dev/null "$URL/api/boot"; }
if ! boot_ok; then
  LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/kuake-studio"
  mkdir -p "$LOG_DIR"
  LOG="$LOG_DIR/studio.log"
  # 简单轮转：单文件超过 5 MB 时保留一份 .1
  if [ -f "$LOG" ] && [ "$(wc -c <"$LOG" 2>/dev/null || echo 0)" -gt 5242880 ]; then
    mv -f "$LOG" "$LOG.1"
  fi
  (cd "$OPT" && setsid nohup ./kuake-studio --port 8787 --no-open >>"$LOG" 2>&1 < /dev/null &)
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
echo "   从 0.5.2–0.5.6 升级时已自动清理旧 systemd --user 登录项（也可单独跑 --cleanup-legacy-only）"
echo "   卸载：./install.sh --uninstall"
