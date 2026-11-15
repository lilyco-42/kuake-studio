//! 商业化与赞助：联系方式、赞助图、启动弹窗、广告位、云端推送、离线赞助授权。
//!
//! 设计约束（写清楚免得后面被改坏）：
//! - 本模块是**纯 Rust**：不依赖 axum / tokio / 桌面特性，所以 Android JNI、iOS Swift、
//!   鸿蒙 NAPI 通过 FFI 也能拿到同一份配置与授权状态（六平台一致）。
//! - 赞助图用 include_bytes! 编进二进制，由后端以同源 /assets/sponsor/* 提供：
//!   CSP 保持 default-src 'self'，不需要为 raw.githubusercontent.com 放行 img-src。
//! - 云端推送默认**不联网**：只有设了 KUAKE_STUDIO_CLOUD_CONFIG_URL 才由后端拉一次；
//!   远端只能改白名单字段（公告 / 广告开关 / 启动弹窗节奏），永远改不了收款码、联系方式、
//!   公钥与授权状态 —— 防止远端被劫持后把赞助码换成别人的。
//! - 授权令牌是离线 ed25519 签名：二进制里只有公钥，私钥由维护者本机保管。
//!   落盘后再读也会重新验签，手改 license.json 里的 sponsored 无效。

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};

/// 维护者签发的 ed25519 公钥（32 B）。对应私钥在维护者本机
/// ~/.config/kuake-studio/keys/license-signing.key，**绝不入库**。
pub const SPONSOR_VERIFY_KEY: [u8; 32] = [
    0xa4, 0xf6, 0x55, 0x1c, 0x93, 0x63, 0xee, 0xcb, 0x47, 0x64, 0x2b, 0x2f, 0xbc, 0xfc, 0x69, 0x17,
    0x45, 0x0f, 0xd3, 0x4d, 0x04, 0x16, 0x85, 0x8b, 0x90, 0x18, 0x5b, 0x2d, 0xd2, 0xc5, 0x5a, 0x4c,
];

/// 两张赞助图按二维码**实际解码内容**命名（上游 shared 仓库里 alipay.png 其实是微信支付码）。
pub const SPONSOR_PNG_PAY: &[u8] = include_bytes!("../assets/sponsor/wechat-pay.png");
pub const SPONSOR_PNG_CONTACT: &[u8] = include_bytes!("../assets/sponsor/wechat-contact.png");

pub const SPONSOR_PATH_PAY: &str = "/assets/sponsor/wechat-pay.png";
pub const SPONSOR_PATH_CONTACT: &str = "/assets/sponsor/wechat-contact.png";

/// 按白名单取赞助图；返回 (bytes, content-type)。绝不读磁盘路径，杜绝穿越。
pub fn sponsor_png(name: &str) -> Option<&'static [u8]> {
    match name {
        "wechat-pay.png" => Some(SPONSOR_PNG_PAY),
        "wechat-contact.png" => Some(SPONSOR_PNG_CONTACT),
        _ => None,
    }
}

/// 内置默认配置：离线可用、六平台一致、所有图片与接口都同源。
pub fn default_config() -> serde_json::Value {
    serde_json::json!({
        "project": "kuake-studio",
        "version": env!("CARGO_PKG_VERSION"),
        "contact": {
            "wechat": "lilyco42",
            "qq": "1957374829",
            "bilibili": "https://space.bilibili.com/",
            "bilibili_label": "B 站：lilyco42",
            "author": "lilyco"
        },
        "sponsor": {
            "title": "支持 Kuake Studio",
            "intro": "软件源码可见、个人使用免费。若它帮到了你，可以请作者喝杯咖啡。",
            "shared_repo": "https://github.com/lilyco-42/shared/tree/master/sponsor/assets",
            "links": [
                {
                    "id": "wechat-pay",
                    "name": "微信支付赞赏",
                    "image": SPONSOR_PATH_PAY,
                    "note": "微信扫一扫 · 赞赏码",
                    "qr_url": "https://payapp.wechatpay.cn/sjt/qr/AQHyNye4l1nMR5C6F3u2jDKI"
                },
                {
                    "id": "wechat-contact",
                    "name": "加微信 / 交流群",
                    "image": SPONSOR_PATH_CONTACT,
                    "note": "微信扫一扫 · 联系作者与商用授权咨询",
                    "qr_url": "https://u.wechat.com/MPaHAJWSVNSS_V5ATLhiiao?s=4"
                }
            ],
            "benefits": {
                "title": "名利选其一",
                "fame": "名誉：在关于页与 README 的赞助者名单中署名（可附链接）",
                "profit": "利益：获得商用授权咨询资格，付费后可去除启动提示与广告位",
                "choose_one": "同一笔赞助在「署名」与「商用权益」中二选一，作者按你的选择登记。"
            }
        },
        "startup": {
            "enabled": true,
            "daily_once": true,
            "delay_ms": 400,
            "title": "欢迎使用 Kuake Studio",
            "notice": ""
        },
        "ad": {
            "enabled": false,
            "label": "广告位（云端可配置）",
            "note": "赞助后可关闭赞助提示与广告位",
            "slots": [
                { "id": "startup", "kind": "placeholder", "label": "启动页广告位" },
                { "id": "about", "kind": "placeholder", "label": "关于页广告位" }
            ]
        },
        "cloud": {
            "enabled": false,
            "url": "",
            "refresh_interval_sec": 3600,
            "last_refresh": null,
            "last_error": null
        },
        "license": {
            "scheme": "ed25519",
            "token_format": "base64url(payload).base64url(signature)",
            "tiers": ["fame", "profit"],
            "storage": "~/.config/kuake-studio/license.json"
        },
        "legal": {
            "edition": "开源版（源码可见）",
            "summary": "个人可自由使用与修改；禁止二次贩卖／转售；商用（含付费或赞助后的商业使用）须获得作者 lilyco 的授权。",
            "license_file": "LICENSE"
        }
    })
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 离线授权载荷。exp 省略＝永久；tier 只接受 fame / profit（名利选其一）。
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct LicenseClaims {
    pub sub: String,
    pub sponsor: bool,
    pub tier: String,
    #[serde(default)]
    pub iat: Option<u64>,
    #[serde(default)]
    pub exp: Option<u64>,
    #[serde(default)]
    pub note: Option<String>,
}

/// 校验一条离线授权令牌：payloadB64.sigB64，签名覆盖 payload 的原始字节。
pub fn verify_license(token: &str, key: &[u8; 32]) -> Result<LicenseClaims, String> {
    let token = token.trim();
    let mut parts = token.split('.');
    let payload_b64 = parts.next().unwrap_or("");
    let sig_b64 = parts.next().unwrap_or("");
    if payload_b64.is_empty() || sig_b64.is_empty() || parts.next().is_some() {
        return Err("授权码格式不对（应为 两段 base64url，以 . 分隔）".into());
    }
    let payload = URL_SAFE_NO_PAD
        .decode(payload_b64)
        .map_err(|e| format!("授权码 payload 不是合法 base64url: {e}"))?;
    let sig_bytes = URL_SAFE_NO_PAD
        .decode(sig_b64)
        .map_err(|e| format!("授权码签名不是合法 base64url: {e}"))?;
    if payload.len() > 4096 || sig_bytes.len() != 64 {
        return Err("授权码长度不合法".into());
    }
    let vk = VerifyingKey::from_bytes(key).map_err(|e| format!("公钥无效: {e}"))?;
    let sig = Signature::from_slice(&sig_bytes).map_err(|e| format!("签名无效: {e}"))?;
    // verify_strict 比 Verifier::verify 更严（拒绝可延展签名变体）
    vk.verify_strict(&payload, &sig)
        .map_err(|_| "授权码验签失败（可能被篡改或不是本软件签发的）".to_string())?;
    let claims: LicenseClaims =
        serde_json::from_slice(&payload).map_err(|e| format!("授权码内容不是合法 JSON: {e}"))?;
    if !claims.sponsor {
        return Err("该授权码没有赞助标记".into());
    }
    if claims.tier != "fame" && claims.tier != "profit" {
        return Err("授权码的权益类型必须是 fame 或 profit".into());
    }
    if let Some(exp) = claims.exp {
        if exp < now_secs() {
            return Err("授权码已过期，请联系作者续期".into());
        }
    }
    if claims.sub.trim().is_empty() || claims.sub.len() > 200 {
        return Err("授权码的赞助者标识不合法".into());
    }
    Ok(claims)
}

/// 授权文件所在的用户目录。
/// 桌面走 paths::home_dir()（Windows 用 USERPROFILE），移动宿主在 loadLibrary 前设 HOME。
/// 测试 / 单机多实例可用 KUAKE_STUDIO_COMMERCIAL_HOME 指到临时目录，不碰真实授权。
pub fn config_home() -> PathBuf {
    if let Ok(p) = std::env::var("KUAKE_STUDIO_COMMERCIAL_HOME") {
        let p = p.trim();
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    crate::paths::home_dir().unwrap_or_else(std::env::temp_dir)
}

/// 授权文件位置：走 paths::home_dir 的同款规则由调用方传入 home，便于测试换临时目录。
pub fn license_path(home: &Path) -> PathBuf {
    home.join(".config")
        .join("kuake-studio")
        .join("license.json")
}

fn read_license_file(path: &Path) -> Option<serde_json::Value> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() > 16 * 1024 {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

fn private_dir(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
    }
}

fn private_file(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
}

fn store_license(home: &Path, token: &str, claims: &LicenseClaims) -> Result<(), String> {
    let dir = home.join(".config").join("kuake-studio");
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建配置目录: {e}"))?;
    private_dir(&dir);
    let path = license_path(home);
    let tmp = dir.join("license.json.tmp");
    let body = serde_json::json!({
        "token": token.trim(),
        "claims": claims,
        "activated_at": now_secs(),
    });
    std::fs::write(&tmp, serde_json::to_vec_pretty(&body).unwrap())
        .map_err(|e| format!("写入授权失败: {e}"))?;
    private_file(&tmp);
    if path.exists() {
        let _ = std::fs::remove_file(&path);
    }
    std::fs::rename(&tmp, &path).map_err(|e| format!("保存授权失败: {e}"))?;
    private_file(&path);
    Ok(())
}

/// 当前授权状态。**每次都重新验签**：用户手改 license.json 不能把自己变成赞助者。
pub fn status_with_key(home: &Path, key: &[u8; 32]) -> serde_json::Value {
    let path = license_path(home);
    let stored = read_license_file(&path);
    let claims = stored
        .as_ref()
        .and_then(|v| v.get("token").and_then(|t| t.as_str()))
        .and_then(|t| verify_license(t, key).ok());
    serde_json::json!({
        "sponsored": claims.is_some(),
        "claims": claims,
        "license_path": path.to_string_lossy(),
        "license_file_exists": path.exists(),
    })
}

pub fn status(home: &Path) -> serde_json::Value {
    status_with_key(home, &SPONSOR_VERIFY_KEY)
}

pub fn activate_with_key(
    home: &Path,
    token: &str,
    key: &[u8; 32],
) -> Result<serde_json::Value, String> {
    let claims = verify_license(token, key)?;
    store_license(home, token, &claims)?;
    Ok(status_with_key(home, key))
}

pub fn activate(home: &Path, token: &str) -> Result<serde_json::Value, String> {
    activate_with_key(home, token, &SPONSOR_VERIFY_KEY)
}

pub fn deactivate(home: &Path) -> Result<serde_json::Value, String> {
    let path = license_path(home);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("移除授权失败: {e}"))?;
    }
    Ok(status(home))
}

/// 远端配置只允许覆盖这些字段；收款码、联系方式、公钥、cloud.url 一律不接受远端改写。
/// remote 整体大小上限 16 KiB，字符串单值上限 300 字符，delay 夹在 0..=10000。
pub fn merge_cloud_config(
    base: &serde_json::Value,
    remote: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let raw = serde_json::to_string(remote).map_err(|e| e.to_string())?;
    if raw.len() > 16 * 1024 {
        return Err("云端配置超过 16 KiB，已忽略".into());
    }
    if !remote.is_object() {
        return Err("云端配置必须是 JSON 对象".into());
    }
    let mut out = base.clone();

    if let Some(notice) = remote.get("notice").and_then(|v| v.as_str()) {
        let s: String = notice.chars().take(300).collect();
        out["startup"]["notice"] = serde_json::Value::String(s);
    }
    for key in ["enabled", "daily_once"] {
        if let Some(v) = remote
            .pointer(&format!("/startup/{key}"))
            .and_then(|v| v.as_bool())
        {
            out["startup"][key] = serde_json::Value::Bool(v);
        }
    }
    if let Some(ms) = remote.pointer("/startup/delay_ms").and_then(|v| v.as_u64()) {
        out["startup"]["delay_ms"] = serde_json::json!(ms.min(10_000));
    }
    if let Some(v) = remote.pointer("/ad/enabled").and_then(|v| v.as_bool()) {
        out["ad"]["enabled"] = serde_json::Value::Bool(v);
    }
    if let Some(label) = remote.pointer("/ad/label").and_then(|v| v.as_str()) {
        let s: String = label.chars().take(120).collect();
        out["ad"]["label"] = serde_json::Value::String(s);
    }
    if let Some(slots) = remote.pointer("/ad/slots").and_then(|v| v.as_array()) {
        let clean: Vec<serde_json::Value> = slots
            .iter()
            .take(8)
            .filter_map(|s| {
                let id = s.get("id").and_then(|v| v.as_str())?;
                let label = s.get("label").and_then(|v| v.as_str()).unwrap_or("广告位");
                if !id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
                    || id.len() > 40
                {
                    return None;
                }
                Some(serde_json::json!({
                    "id": id,
                    "kind": "placeholder",
                    "label": label.chars().take(80).collect::<String>()
                }))
            })
            .collect();
        out["ad"]["slots"] = serde_json::Value::Array(clean);
    }
    if let Some(sec) = remote
        .pointer("/cloud/refresh_interval_sec")
        .and_then(|v| v.as_u64())
    {
        out["cloud"]["refresh_interval_sec"] = serde_json::json!(sec.clamp(60, 86_400));
    }
    Ok(out)
}

/// 拉一次云端配置（3 秒超时）。reqwest::blocking 不能在 tokio 线程里直接跑，
/// 调用方必须放在 spawn_blocking / std::thread 里；见 server.rs::api_commercial_refresh。
pub fn fetch_cloud_config(url: &str) -> Result<serde_json::Value, String> {
    if !(url.starts_with("https://") || url.starts_with("http://127.0.0.1")) {
        return Err("云端配置地址必须是 https 或本机回环 http".into());
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| format!("无法创建 HTTP 客户端: {e}"))?;
    let resp = client
        .get(url)
        .send()
        .map_err(|e| format!("拉取云端配置失败: {e}"))?
        .error_for_status()
        .map_err(|e| format!("云端配置返回错误: {e}"))?;
    resp.json::<serde_json::Value>()
        .map_err(|e| format!("云端配置不是合法 JSON: {e}"))
}

/// 给前端 / FFI 的单一快照：配置 + 授权状态 + 是否已赞助。
/// 已赞助时自动关掉启动提示与广告位（用户要的「赞助之后取消赞助广告弹窗」）。
pub fn snapshot_with_key(
    home: &Path,
    config: &serde_json::Value,
    key: &[u8; 32],
) -> serde_json::Value {
    let st = status_with_key(home, key);
    let sponsored = st["sponsored"].as_bool().unwrap_or(false);
    let mut cfg = config.clone();
    if sponsored {
        cfg["startup"]["enabled"] = serde_json::Value::Bool(false);
        cfg["ad"]["enabled"] = serde_json::Value::Bool(false);
    }
    serde_json::json!({ "config": cfg, "status": st, "sponsored": sponsored })
}

pub fn snapshot(home: &Path, config: &serde_json::Value) -> serde_json::Value {
    snapshot_with_key(home, config, &SPONSOR_VERIFY_KEY)
}

/// 把赞助图就地换成 data: URI —— 给不跑 axum 的 FFI 宿主（iOS / 鸿蒙）用。
/// 桌面 / Android 走同源 /assets/sponsor/xxx.png，CSP 一个外域都不用放行。
pub fn config_inline(config: &serde_json::Value) -> serde_json::Value {
    let mut out = config.clone();
    if let Some(links) = out["sponsor"]["links"].as_array_mut() {
        for l in links {
            let name = l["image"]
                .as_str()
                .unwrap_or("")
                .trim_start_matches("/assets/sponsor/");
            if let Some(bytes) = sponsor_png(name) {
                l["image"] = serde_json::Value::String(format!(
                    "data:image/png;base64,{}",
                    STANDARD.encode(bytes)
                ));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    const TEST_KEY: [u8; 32] = [7u8; 32];

    fn test_pub(seed: &[u8; 32]) -> [u8; 32] {
        SigningKey::from_bytes(seed).verifying_key().to_bytes()
    }

    fn sign(seed: &[u8; 32], claims: &LicenseClaims) -> String {
        let payload = serde_json::to_vec(claims).unwrap();
        let sig = SigningKey::from_bytes(seed).sign(&payload);
        format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(&payload),
            URL_SAFE_NO_PAD.encode(sig.to_bytes())
        )
    }

    fn claims(sub: &str) -> LicenseClaims {
        LicenseClaims {
            sub: sub.into(),
            sponsor: true,
            tier: "fame".into(),
            iat: Some(now_secs()),
            exp: None,
            note: None,
        }
    }

    fn temp_home(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ks-commercial-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn default_config_has_contacts_images_and_slots() {
        let c = default_config();
        assert_eq!(c["contact"]["wechat"], "lilyco42");
        assert_eq!(c["contact"]["qq"], "1957374829");
        assert!(c["contact"]["bilibili"]
            .as_str()
            .unwrap()
            .starts_with("https://"));
        assert_eq!(c["sponsor"]["links"].as_array().unwrap().len(), 2);
        for l in c["sponsor"]["links"].as_array().unwrap() {
            assert!(
                l["image"].as_str().unwrap().starts_with("/assets/sponsor/"),
                "赞助图必须同源，CSP 才不用放行外部域名"
            );
        }
        assert_eq!(c["sponsor"]["benefits"]["title"], "名利选其一");
        assert!(!c["ad"]["slots"].as_array().unwrap().is_empty());
        assert_eq!(c["cloud"]["enabled"], false, "云端推送默认不联网");
        assert!(c["legal"]["summary"]
            .as_str()
            .unwrap()
            .contains("禁止二次贩卖"));
    }

    #[test]
    fn png_assets_have_png_magic_and_are_whitelisted() {
        for b in [SPONSOR_PNG_PAY, SPONSOR_PNG_CONTACT] {
            assert!(b.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]));
            assert!(b.len() > 100_000);
        }
        assert!(sponsor_png("wechat-pay.png").is_some());
        assert!(sponsor_png("wechat-contact.png").is_some());
        assert!(sponsor_png("../.env").is_none());
        assert!(sponsor_png("alipay.png").is_none(), "旧文件名已被弃用");
    }

    #[test]
    fn verify_accepts_valid_token() {
        let pubk = test_pub(&TEST_KEY);
        let got = verify_license(&sign(&TEST_KEY, &claims("alice")), &pubk).unwrap();
        assert_eq!(got.sub, "alice");
        assert_eq!(got.tier, "fame");
    }

    #[test]
    fn verify_rejects_tampered_payload_and_wrong_key() {
        let pubk = test_pub(&TEST_KEY);
        let tok = sign(&TEST_KEY, &claims("alice"));
        let mut parts = tok.split('.');
        let p = parts.next().unwrap().to_string();
        let s = parts.next().unwrap().to_string();
        let mut payload = URL_SAFE_NO_PAD.decode(&p).unwrap();
        payload[2] ^= 0x01;
        let bad = format!("{}.{}", URL_SAFE_NO_PAD.encode(&payload), s);
        assert!(verify_license(&bad, &pubk)
            .unwrap_err()
            .contains("验签失败"));
        let other = test_pub(&[9u8; 32]);
        assert!(verify_license(&tok, &other).is_err());
    }

    #[test]
    fn verify_rejects_non_sponsor_bad_tier_and_expired() {
        let pubk = test_pub(&TEST_KEY);
        let mut c = claims("bob");
        c.sponsor = false;
        assert!(verify_license(&sign(&TEST_KEY, &c), &pubk)
            .unwrap_err()
            .contains("赞助标记"));
        let mut c = claims("bob");
        c.tier = "both".into();
        assert!(verify_license(&sign(&TEST_KEY, &c), &pubk)
            .unwrap_err()
            .contains("fame 或 profit"));
        let mut c = claims("bob");
        c.exp = Some(1);
        assert!(verify_license(&sign(&TEST_KEY, &c), &pubk)
            .unwrap_err()
            .contains("过期"));
        let mut c = claims("bob");
        c.sub = "".into();
        assert!(verify_license(&sign(&TEST_KEY, &c), &pubk)
            .unwrap_err()
            .contains("标识"));
    }

    #[test]
    fn verify_rejects_malformed_tokens() {
        let pubk = test_pub(&TEST_KEY);
        for bad in ["", "abc", "a.b.c", "!!!.!!!", "YWJj.YWJj"] {
            assert!(verify_license(bad, &pubk).is_err(), "应拒绝: {bad}");
        }
    }

    #[test]
    fn license_roundtrip_and_tamper_proof() {
        let home = temp_home("roundtrip");
        let pubk = test_pub(&TEST_KEY);
        assert_eq!(status_with_key(&home, &pubk)["sponsored"], false);
        let tok = sign(&TEST_KEY, &claims("alice"));
        let st = activate_with_key(&home, &tok, &pubk).unwrap();
        assert_eq!(st["sponsored"], true);
        assert_eq!(st["claims"]["sub"], "alice");
        assert_eq!(
            status_with_key(&home, &pubk)["sponsored"],
            true,
            "重启后仍在"
        );
        assert!(license_path(&home).exists());

        // 手改 claims 字段是无效的：状态只认 token 的签名，不认文件里的展示字段。
        // 这正是「防篡改」的正确形态 —— 改了也拿不到别人的身份。
        let p = license_path(&home);
        let mut v: serde_json::Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
        v["claims"]["sub"] = "someone-else".into();
        std::fs::write(&p, serde_json::to_vec(&v).unwrap()).unwrap();
        let st_tampered = status_with_key(&home, &pubk);
        assert_eq!(st_tampered["sponsored"], true);
        assert_eq!(
            st_tampered["claims"]["sub"], "alice",
            "展示字段来自签名载荷，不是文件里的 claims"
        );

        // 真去改 token 就立刻失效；重新激活后才恢复；deactivate 后清空
        v["token"] = "Ym9ndXM.Ym9ndXM".into();
        std::fs::write(&p, serde_json::to_vec(&v).unwrap()).unwrap();
        assert_eq!(status_with_key(&home, &pubk)["sponsored"], false);
        activate_with_key(&home, &tok, &pubk).unwrap();
        let st2 = deactivate(&home).unwrap();
        assert_eq!(st2["sponsored"], false);
        assert!(!license_path(&home).exists());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn license_file_is_private_on_unix() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let home = temp_home("perm");
            let pubk = test_pub(&TEST_KEY);
            activate_with_key(&home, &sign(&TEST_KEY, &claims("carol")), &pubk).unwrap();
            let mode = std::fs::metadata(license_path(&home))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
            let dmode = std::fs::metadata(home.join(".config/kuake-studio"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(dmode, 0o700);
            let _ = std::fs::remove_dir_all(&home);
        }
    }

    #[test]
    fn cloud_merge_only_allows_whitelisted_fields() {
        let base = default_config();
        let remote = serde_json::json!({
            "notice": "新版本已发布",
            "startup": { "enabled": false, "daily_once": false, "delay_ms": 999999 },
            "ad": { "enabled": true, "label": "推广位", "slots": [
                { "id": "ok_slot-1", "label": "A", "kind": "iframe", "url": "https://evil.example" },
                { "id": "../bad", "label": "B" }
            ]},
            "cloud": { "refresh_interval_sec": 1, "url": "https://evil.example/cfg" },
            "contact": { "wechat": "hacker" },
            "sponsor": { "links": [{ "image": "https://evil.example/qr.png" }] },
            "license": { "sponsored": true }
        });
        let out = merge_cloud_config(&base, &remote).unwrap();
        assert_eq!(out["startup"]["notice"], "新版本已发布");
        assert_eq!(out["startup"]["enabled"], false);
        assert_eq!(out["startup"]["delay_ms"], 10_000);
        assert_eq!(out["ad"]["enabled"], true);
        assert_eq!(out["cloud"]["refresh_interval_sec"], 60);
        assert_eq!(
            out["contact"]["wechat"], "lilyco42",
            "联系方式不可被远端改写"
        );
        assert_eq!(out["cloud"]["url"], "", "远端不能给自己换个拉取地址");
        assert_eq!(
            out["sponsor"]["links"], base["sponsor"]["links"],
            "收款码不可被远端改写"
        );
        assert_eq!(out["license"], base["license"]);
        let slots = out["ad"]["slots"].as_array().unwrap();
        assert_eq!(slots.len(), 1);
        assert_eq!(slots[0]["id"], "ok_slot-1");
        assert_eq!(slots[0]["kind"], "placeholder", "不接受远端 iframe / 外链");
        assert!(slots[0].get("url").is_none());
    }

    #[test]
    fn cloud_merge_rejects_non_object_and_huge_payload() {
        let base = default_config();
        assert!(merge_cloud_config(&base, &serde_json::json!([1, 2])).is_err());
        let big = serde_json::json!({ "notice": "x".repeat(20 * 1024) });
        assert!(merge_cloud_config(&base, &big).is_err());
        let clipped =
            merge_cloud_config(&base, &serde_json::json!({ "notice": "y".repeat(500) })).unwrap();
        assert_eq!(
            clipped["startup"]["notice"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            300
        );
    }

    #[test]
    fn fetch_cloud_config_rejects_unsafe_urls_without_network() {
        assert!(fetch_cloud_config("http://evil.example/cfg").is_err());
        assert!(fetch_cloud_config("file:///etc/passwd").is_err());
    }
    #[test]
    fn snapshot_disables_prompts_for_sponsors() {
        let home = temp_home("snapshot");
        let pubk = test_pub(&TEST_KEY);
        let base = default_config();
        let before = snapshot_with_key(&home, &base, &pubk);
        assert_eq!(before["sponsored"], false);
        assert_eq!(before["config"]["startup"]["enabled"], true);
        activate_with_key(&home, &sign(&TEST_KEY, &claims("dora")), &pubk).unwrap();
        let after = snapshot_with_key(&home, &base, &pubk);
        assert_eq!(after["sponsored"], true);
        assert_eq!(
            after["config"]["startup"]["enabled"], false,
            "赞助后不再弹启动窗"
        );
        assert_eq!(after["config"]["ad"]["enabled"], false, "赞助后关广告位");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn inline_config_embeds_real_png_data_uris() {
        let out = config_inline(&default_config());
        let links = out["sponsor"]["links"].as_array().unwrap();
        assert_eq!(links.len(), 2);
        for l in links {
            let s = l["image"].as_str().unwrap();
            assert!(s.starts_with("data:image/png;base64,"));
            let bytes = STANDARD
                .decode(s.trim_start_matches("data:image/png;base64,"))
                .unwrap();
            assert!(bytes.starts_with(&[0x89, b'P', b'N', b'G']));
            assert!(bytes.len() > 100_000);
        }
    }
}
