# 安全政策（SECURITY）

## Supported Versions

仅最新发布的 `vX.Y.Z` 接收安全更新。

## 报告漏洞

**不要**在公开 Issue 披露漏洞或凭据。请通过以下方式私下报告：

- GitHub Security Advisories（本仓 `Security` 标签 → `Report a vulnerability`）
- 或邮件联系维护者（见 `README.md` 关于页的微信 / QQ）

## 威胁模型（摘要）

- 本地回环 Web 宿主：Host / Origin 必须回环，受保护 POST 需随机令牌，防 DNS rebinding / CSRF / 同机越权调用。
- 凭据（夸克 cookie / license.json）存本机用户目录，目录 0700 / 文件 0600。
- 商业化授权只内嵌 ed25519 **公钥**，私钥不入库；云端推送默认关闭，白名单字段才接受。
- 详见 `docs/DEVELOPMENT-STANDARDS.md` 第 3、4 节。
