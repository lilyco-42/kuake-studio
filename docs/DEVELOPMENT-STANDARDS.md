# 开发规范（kuake-studio）

本文件是 lyco 生态「需求先钉死再动手」哲学在本仓的具体落地，也是 CI 门禁的可读化版。
所有贡献者（含 AI 协作者）都应先读 lyco skill 的五信条，再读本文件。

## 1. 框架与依赖基线

- **lilyco 框架**：命令用 `#[derive(App)]` 派生，schema 由宏生成（`ArgSchema` / `CommandSchema`）。
  本仓通过 git 依赖钉死 rev（`3f5ce094…`），**绝不写 `branch = "main/master"`**（lyco-hygiene 守则 2）。
- **宿主一致性**：`build_registry()` 是唯一装配入口。CLI 走 clap（按 schema 填默认）；
  Web(SSE) / MCP / FFI / 嵌入方都直接把 args JSON 交给 handler，`build_registry` 在注册前统一按 schema 补「缺失或 null」的默认值。改默认行为只能动这一处。
- **前端**：shadcn/ui 语义令牌（`bg-muted/30` / `text-muted-foreground` / `text-primary` 等），**禁止裸色字面量**。
  组件基于 radix-ui 聚合包手写，零运行时 CDN、零 webfont，图标只用 Unicode / lucide。

## 2. 六平台构建矩阵

| 平台 | 产物 | 特性 | 说明 |
| --- | --- | --- | --- |
| Windows x64 | `.msi` + 便携 `.zip` | `desktop` | WiX v3 打包 |
| Linux x64 | `.tar.gz` + `install.sh` | `desktop` | 一键安装器含旧 systemd 登录项清理 |
| macOS universal | `.tar.gz` + `.app` | `desktop` | aarch64 + x86_64 lipo 合成 |
| Android arm64 / x86_64 | 可安装 `.apk` + 静态库 `.tar.gz` | `--no-default-features` | NDK aapt2/javac/d8/zipalign/apksigner 纯命令行 |
| iOS arm64 | 静态库 `.tar.gz` | `--no-default-features` | Xcode 宿主链 .a |
| OpenHarmony arm64 | 静态库 `.tar.gz` | `--no-default-features` | DevEco 宿主链 .a |

移动 / 鸿蒙只编 `[lib]` 的 **C ABI**（`staticlib`，不编 `cdylib`：交叉目标无平台 linker）。
桌面编 `[[bin]]` 起 axum Web 宿主 + 系统托盘。

## 3. 安全门（回环 + 令牌）

- 所有请求 Host 必须回环（防 DNS rebinding）；受保护 POST 的 Origin 必须回环（防 CSRF）。
- 受保护 POST 必须带本次启动随机令牌 `X-Kuake-Token`（前端从 `<meta name="kuake-token">` 读）。
- 受保护端点：`/api/run` `/api/upload` `/api/upload/raw` `/api/cancel` `/api/login/*`
  `/api/commercial/activate` `/api/commercial/deactivate` `/api/commercial/refresh`。
- CSP 默认 `default-src 'self'`；图与推送**全走同源**，不为任何外部域名开 `img-src` / `connect-src`。

## 4. 商业化与赞助（v0.5.11 新增）

- `src/commercial.rs` 是纯 Rust 核心（不依赖 axum/tokio），桌面 / 移动 / 鸿蒙 FFI 共用。
- 内置收款码用 `include_bytes!("../assets/sponsor/*.png")` + 同源 `/assets/sponsor/{name}` 路由，零外连。
- 授权令牌：ed25519 验签，只内嵌**公钥**，私钥永不入库。`license.json` 目录 0700 / 文件 0600。
- 云端推送默认关闭；只有显式设 `KUAKE_STUDIO_CLOUD_CONFIG_URL` 才拉，且 `merge_cloud_config` 只接受白名单字段
  （notice / startup / ad 占位 / refresh_interval），**不接受** 联系方式 / 收款码 / 公钥 / 授权状态 / 拉取地址改写。
- 赞助者自动关闭启动提示与广告位（`snapshot` 里 `startup.enabled=false` / `ad.enabled=false`）。
- 许可口径：开源版（源码可见），个人自由使用与修改；禁止二次贩卖／转售；商用须获作者授权。

## 5. i18n 迁移进度

- 已完成（v0.5.12）：`lib/i18n.tsx`（React Context，zh-CN / en，localStorage key
  `kuake-studio:lang`）+ `lib/i18n-core.ts`（纯函数，可单测）+ `lib/i18n-dict.ts`
  （**单一数据源**：每行 `[key, 中文, English]`，zh/en 由 `Object.fromEntries` 派生）。
  App 外壳 / 启动窗 / 授权框 / 关于页 / 五个业务视图（文件 / 搜索 / 分享 / 回收站 / 账号）
  与 Runner 日志（`store.tsx`）全部走 `t(key, vars)`；`format.ts` 的相对时间与面包屑
  根节点也随语言切换。侧栏底部语言按钮即时切换，无需重启。
- 字典守卫：`i18n-dict.test.ts` 钉死「键唯一 + zh/en 键集一致 + 值非空 + 英文无中文 +
  占位符一一对应 + 源码静态 `t("...")` 的 key 全在字典」。新增文案只改字典一行，
  不许在业务代码里写死中/英文字面量。
- 未迁移：若干对话框（upload / decrypt / login / command / confirm / console / drop /
  info / schema-form）与 `lib/api.ts` 的内部错误文案仍是中文；后端返回的
  `message` 天生是中文，按原样展示，不翻译。

## 6. 测试与 CI 门禁

- Rust：`cargo fmt --all --check` / `cargo clippy --all-targets -- -D warnings` /
  `cargo test --locked` / `cargo test --locked --no-default-features --lib` / C ABI 真链接自检。
- 前端：`bun install --frozen-lockfile` → `bun run typecheck` → `bun run test` → `bun run build`（**test 不可省**）。
- 发版后：`node tools/verify-release.mjs --tag vX.Y.Z` 核对 8 资产 / SHA256 / 架构 / ABI / APK 结构。
- 大文件阈值 2MB：资产走 Release attachment，仓库只放源码与小资产（`git ls-files` 无 >1MB 文件）。

## 7. 发版流程

1. 升 4 处版本号：`Cargo.toml` / `android/Cargo.toml` / `src/main.rs`（2 处）→ 跑 `cargo metadata` 同步两个 `Cargo.lock`。
2. `cargo test` + `bun test` + `bun run build` 全绿 → `git commit` → `git push origin main`。
3. `git tag -a vX.Y.Z -m "..."` → `git push origin vX.Y.Z` → tag CI 出 8 资产并打 Release。
4. `node tools/verify-release.mjs --tag vX.Y.Z` → 本地 8787 升级并回归。
