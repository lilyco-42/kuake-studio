# 贡献指南（CONTRIBUTING）

感谢你关注 kuake-studio。本仓是 lyco 生态成员，遵循「需求先钉死再动手」的工作流。

## 提 Issue 前

- 先读 `docs/DEVELOPMENT-STANDARDS.md` 与 `README.md`。
- 复现问题请带：平台（Windows / Linux / macOS / Android / iOS / 鸿蒙）、版本号（`/api/boot` 的 version）、复现步骤、日志。
- 日志在终端启动 `kuake-studio` 时输出；Android 可用 `adb logcat`。

## 提 PR 前

- 分支从 `main` 拉；PR 标题用「feat / fix / docs / chore(scope): 简述」。
- 本地必须跑通 CI 门禁：`cargo fmt --all --check`、`cargo clippy --all-targets -- -D warnings`、
  `cargo test --locked`、`cargo test --locked --no-default-features --lib`；前端 `bun run typecheck` `bun run test` `bun run build`。
- 不提交大文件（阈值 2MB），资产走 Release。
- 不写 `branch = "main/master"` 的 git 依赖（锁 rev / tag）。

## 安全相关

请走 `SECURITY.md` 的私下披露流程，不要在公开 Issue 贴凭据或漏洞细节。
