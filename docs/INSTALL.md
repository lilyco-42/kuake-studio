# kuake-studio 安装与使用教程

本文覆盖 **一键安装 / 手动安装 / 首次使用 / 升级 / 卸载 / 常见问题**。
所有命令都可以直接复制执行。

---

## 1. 一键安装（最快）

脚本会：识别系统 → 下载对应 Release 资产 → 用 `SHA256SUMS` 校验 → 调用包内安装器 →
创建菜单/桌面快捷方式。安装到用户目录，不需要 `sudo`。

### Linux / macOS

```bash
curl -fsSL https://github.com/lilyco-42/kuake-studio/releases/latest/download/install.sh | bash
```

指定版本：

```bash
curl -fsSL https://github.com/lilyco-42/kuake-studio/releases/latest/download/install.sh | bash -s -- v0.5.19
```

卸载（不动凭据与已下载文件）：

```bash
curl -fsSL https://github.com/lilyco-42/kuake-studio/releases/latest/download/install.sh | bash -s -- --uninstall
```

### Windows（PowerShell）

```powershell
irm https://github.com/lilyco-42/kuake-studio/releases/latest/download/install.ps1 | iex
```

指定版本：

```powershell
irm https://github.com/lilyco-42/kuake-studio/releases/latest/download/install.ps1 -OutFile install.ps1
.\install.ps1 -Version v0.5.19
```

安装位置：`%LOCALAPPDATA%\Programs\kuake-studio`，并创建开始菜单 + 桌面「夸克网盘」快捷方式。

### Android

到 [Releases](https://github.com/lilyco-42/kuake-studio/releases) 下载 `*-android.apk`，
传到手机点安装（首次需允许「安装未知来源应用」）。

---

## 2. 手动安装

| 平台 | 资产 | 步骤 |
| --- | --- | --- |
| Linux | `*-linux-x64.tar.gz` | 解压 → `./install.sh`（应用菜单 + 桌面 + 开机自启）；`./start.sh` 便携启动 |
| macOS | `*-macos-universal.tar.gz` | 解压 → `./install-macos.sh`（进 `/Applications`）或直接双击 `.app` |
| Windows | `*-windows-x64.msi` | 双击安装（开始菜单 + 桌面）；`*.zip` 解压双击 `run.bat` 便携用 |
| Android | `*-android.apk` | 点安装 |
| iOS / 鸿蒙 | `*-ios-arm64.tar.gz` / `*-ohos-arm64.tar.gz` | 给宿主 App 链接的静态库 + C 头，**不是可安装 App** |

Linux 图标会装到 `~/.local/share/icons/hicolor/{48,64,128,256,512,1024}/apps/kuake-studio.png`；
卸载时由 `install.sh --uninstall` 一并清理。

---

## 3. 首次使用

1. 打开应用（桌面/开始菜单/Launchpad 里的「夸克网盘」），程序会自动打开
   `http://127.0.0.1:8787`，不需要手输 IP/端口。
2. 「账号」页 → **扫码登录** → 用夸克 App 扫码。凭据写入 `~/.config/kuake/.env`，
   无需重启。
3. 「文件」页勾选文件 → **下载到本机**。目标目录留空即落到 `~/Downloads`（同名文件自动
   变成 `name (1).ext`）。活动日志会显示：
   - `开始下载：<网盘路径> → <本机绝对路径>（大小）`
   - `下载中 · 已下载 / 总大小 · 速度`（每 256 KB 刷新）
   - `下载完成：<本机绝对路径>（字节数）`
4. 界面缩放：侧栏底部 `− 100% + ↺`，或 `Ctrl/⌘ +` / `-` / `0`（80%–160%，会记住）。
5. 服务日志：`~/.local/state/kuake-studio/studio.log`（超过 5 MB 轮转 `.1`）。

---

## 4. 升级

- **一键安装脚本**：重复执行一次即升级到最新版（凭据与已下载文件不动）。
- **Linux**：下载新 tar.gz → 解压 → `./install.sh`。
- **Windows**：覆盖安装 MSI，或重跑 `install.ps1`。
- **macOS**：替换 `/Applications/kuake-studio.app`，或重跑 `install-macos.sh`。

升级后界面顶部版本号应变化；若仍是旧版本号，说明启动的是旧进程——从托盘退出后重新打开。

---

## 5. 卸载

```bash
# Linux / macOS
curl -fsSL https://github.com/lilyco-42/kuake-studio/releases/latest/download/install.sh | bash -s -- --uninstall
```

Windows：删除 `%LOCALAPPDATA%\Programs\kuake-studio` 与开始菜单/桌面快捷方式（MSI 安装则从
「应用和功能」卸载）。

---

## 6. 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 下载 `403 auth expired`，距上次成功很久 | Cookie 失效 | 「账号」页重新扫码 |
| 下载 `403 auth expired`，距上次成功只有几秒 | 夸克对短时间重复下载的风控 | 客户端自动退避 3s → 6s → 12s 重试；仍失败等 30 秒 |
| 下载 `403 auth miss` | Cookie 缺 `__puus` | v0.5.13 起自动从 `Set-Cookie` 补全并写回 `.env`，重开一次下载即可 |
| 下载 `412 Precondition Failed` | 直链被 CDN 临时拒绝 | 客户端自动重新申请直链（1.5s → 3s → 6s） |
| `23018 download file size limit` | 账号对单文件下载大小有上限 | 开通/升级会员，或先下较小文件 |
| `Unauthorized: bad token` | 服务重启换了 CSRF token，页面还是旧 token | v0.5.13 起前端自动重新握手并重试；旧页面刷新一次 |
| 页面一直「执行中」 | 命令线程异常或终态丢失 | v0.5.13 起会补发明确错误；仍复现则看日志文件 |

---

## 7. 校验下载完整性

Release 附带 `SHA256SUMS`，可自行核对：

```bash
curl -fsSL https://github.com/lilyco-42/kuake-studio/releases/latest/download/SHA256SUMS -o SHA256SUMS
sha256sum -c SHA256SUMS --ignore-missing
```

Windows PowerShell：

```powershell
Get-FileHash .\kuake-studio-0.5.15-windows-x64.zip -Algorithm SHA256
```

---

## 8. 从源码构建

```bash
git clone https://github.com/lilyco-42/kuake-studio
cd kuake-studio
cargo build --release
cd frontend && bun install --frozen-lockfile && bun run build
cd .. && ./run.sh
```

更多实现细节见仓库根 `README.md` 与 `CONTRIBUTING.md`。