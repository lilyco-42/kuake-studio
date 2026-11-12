//! 夸克扫码登录：官方二维码接口 → service_ticket → 登录 cookie。
//!
//! 目的：让客户端彻底摆脱「手工从 Chrome dump cookie」(tools/dump-cookies.mjs)。
//! 安全不变量：
//!   * cookie 只存在进程环境 + ~/.config/kuake/.env，**绝不进返回信封、日志或 telemetry**
//!     （SSE 的 Done 事件会原样送到浏览器，CLI --json 会打到 stdout）。
//!   * 落盘前用 /account/info?fr=pc&platform=pc 强校验 nickname，校验失败不写 .env。
//!   * 写 .env 先备份，保留其它 KUAKE_* 行；值用单引号包裹（cookie 含分号与空格）。

use std::collections::BTreeMap;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use lilyco::__core::AppError;
use qrcodegen::{QrCode, QrCodeEcc};
use reqwest::blocking::Client;
use reqwest::header::{self, HeaderMap};
use serde_json::{json, Value};

const UOP: &str = "https://uop.quark.cn";
const PAN: &str = "https://pan.quark.cn";
const UA_PC: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const CLIENT_ID: &str = "532";
const BIZ_STR: &str =
    "S%3Acustom%7COPT%3ASAREA%400%7COPT%3AIMMERSIVE%401%7COPT%3ABACK_BTN_STYLE%400";

fn err(msg: impl Into<String>) -> AppError {
    AppError::Runtime(msg.into())
}

fn rid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// 极简 cookie jar：登录链路的三个请求之间必须携带 uop 下发的 _UP_* cookie。
/// 只认 name=value 与 Max-Age=0（删除），不解析 domain/path —— 这几个请求同属 quark.cn。
#[derive(Default)]
struct Jar(BTreeMap<String, String>);

impl Jar {
    fn absorb(&mut self, headers: &HeaderMap) {
        for raw in headers.get_all(header::SET_COOKIE).iter() {
            let Ok(line) = raw.to_str() else { continue };
            let mut parts = line.split(';');
            let Some((name, value)) = parts.next().unwrap_or("").trim().split_once('=') else {
                continue;
            };
            let name = name.trim().to_string();
            if name.is_empty() {
                continue;
            }
            let mut drop = false;
            for attr in parts {
                let a = attr.trim().to_ascii_lowercase();
                if a == "max-age=0" || a.starts_with("max-age=-") {
                    drop = true;
                }
            }
            if drop || value.trim().is_empty() {
                self.0.remove(&name);
            } else {
                self.0.insert(name, value.trim().to_string());
            }
        }
    }

    fn header(&self) -> String {
        self.0
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("; ")
    }

    fn names(&self) -> Vec<String> {
        self.0.keys().cloned().collect()
    }
}

fn qr_url(token: &str) -> String {
    format!(
        "https://su.quark.cn/4_eMHBJ?token={token}&client_id={CLIENT_ID}&ssb=weblogin&uc_param_str=&uc_biz_str={BIZ_STR}"
    )
}

/// qrcodegen 不含 SVG 渲染器，自己拼一个纯黑白模块路径。
fn qr_svg(text: &str) -> Result<String, AppError> {
    let qr = QrCode::encode_text(text, QrCodeEcc::Medium)
        .map_err(|_| err("二维码内容过长，无法生成"))?;
    let n = qr.size();
    let border = 4;
    let dim = n + border * 2;
    let mut path = String::new();
    for y in 0..n {
        for x in 0..n {
            if qr.get_module(x, y) {
                path.push_str(&format!("M{},{}h1v1h-1z ", x + border, y + border));
            }
        }
    }
    Ok(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {dim} {dim}\" width=\"{dim}\" height=\"{dim}\" shape-rendering=\"crispEdges\"><rect width=\"{dim}\" height=\"{dim}\" fill=\"#fff\"/><path d=\"{path}\" fill=\"#000\"/></svg>"
    ))
}

/// /account/info 的强校验：必须 success=true 且 data.nickname 非空。
fn account_nickname(v: &Value) -> Result<String, AppError> {
    if v.get("success").and_then(Value::as_bool) != Some(true) {
        return Err(err("凭据校验失败：/account/info 未返回 success=true"));
    }
    let name = v
        .pointer("/data/nickname")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if name.is_empty() {
        return Err(err("凭据校验失败：/account/info 没有返回昵称"));
    }
    Ok(name.to_string())
}

/// 只替换 KUAKE_COOKIE 一行，其余行原样保留；无该行则追加。
fn write_env(path: &Path, cookie: &str) -> Result<(), AppError> {
    if cookie
        .chars()
        .any(|c| matches!(c, '\'' | '"' | '\n' | '\r' | '\\' | '\u{60}'))
    {
        return Err(err("登录 cookie 含引号、反斜杠或换行，拒绝写入 .env"));
    }
    let line = format!("KUAKE_COOKIE='{cookie}'");
    let old = std::fs::read_to_string(path).unwrap_or_default();
    let mut out = String::new();
    let mut replaced = false;
    for raw in old.lines() {
        let trimmed = raw.trim_start();
        if trimmed.starts_with("KUAKE_COOKIE=") || trimmed.starts_with("KUAKE_COOKIE =") {
            if !replaced {
                out.push_str(&line);
                out.push('\n');
                replaced = true;
            }
        } else {
            out.push_str(raw);
            out.push('\n');
        }
    }
    if !replaced {
        out.push_str(&line);
        out.push('\n');
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| err(format!("无法创建 {}：{e}", parent.display())))?;
    }
    if path.is_file() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy())
            .unwrap_or_default();
        let bak = path.with_file_name(format!("{name}.bak-{stamp}"));
        let _ = std::fs::copy(path, &bak);
    }
    std::fs::write(path, out).map_err(|e| err(format!("写入 {} 失败：{e}", path.display())))
}

pub struct LoginSession {
    http: Client,
    jar: Jar,
    token: String,
    pub qr_url: String,
    /// 原始 SVG 文本（CLI 落盘用）
    pub qr_svg: String,
    /// data:image/svg+xml;base64,...（Web <img src> 直接用，CSP 已放行 data:）
    pub qr_data: String,
}

impl LoginSession {
    /// 取二维码 token。会真实访问 uop.quark.cn，属阻塞调用：Web 端必须放进 spawn_blocking。
    pub fn start() -> Result<Self, AppError> {
        let http = Client::builder()
            .user_agent(UA_PC)
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| err(format!("创建 HTTP 客户端失败：{e}")))?;
        let mut jar = Jar::default();
        let url = format!(
            "{UOP}/cas/ajax/getTokenForQrcodeLogin?client_id={CLIENT_ID}&v=1.2&request_id={}",
            rid()
        );
        let resp = http
            .get(url.as_str())
            .header(header::ACCEPT, "application/json, text/plain, */*")
            .header(header::ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9")
            .header(header::REFERER, "https://pan.quark.cn/")
            .send()
            .map_err(|e| err(format!("获取二维码 token 失败：{e}")))?;
        jar.absorb(resp.headers());
        let body: Value = resp
            .json()
            .map_err(|e| err(format!("解析二维码 token 响应失败：{e}")))?;
        if body.get("status").and_then(Value::as_i64) != Some(2_000_000) {
            return Err(err(format!(
                "获取二维码 token 被拒：{}",
                body.get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("未知响应")
            )));
        }
        let token = body
            .pointer("/data/members/token")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if token.is_empty() {
            return Err(err("二维码 token 为空"));
        }
        let url = qr_url(&token);
        let svg = qr_svg(&url)?;
        let data = format!(
            "data:image/svg+xml;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(svg.as_bytes())
        );
        Ok(Self {
            http,
            jar,
            token,
            qr_url: url,
            qr_svg: svg,
            qr_data: data,
        })
    }

    fn get_raw(&mut self, url: &str) -> Result<String, AppError> {
        let resp = self
            .http
            .get(url)
            .header(header::COOKIE, self.jar.header())
            .header(header::ACCEPT, "application/json, text/plain, */*")
            .header(header::ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9")
            .header(header::REFERER, "https://pan.quark.cn/")
            .send()
            .map_err(|e| err(format!("扫码登录请求失败：{e}")))?;
        self.jar.absorb(resp.headers());
        resp.text()
            .map_err(|e| err(format!("读取扫码登录响应失败：{e}")))
    }

    fn get(&mut self, url: &str) -> Result<Value, AppError> {
        let text = self.get_raw(url)?;
        serde_json::from_str(&text)
            .map_err(|e| err(format!("扫码登录响应不是 JSON：{e}；正文 {text:.200}")))
    }

    /// 轮询到扫码成功 → 换 cookie → 强校验 → 落盘 → 只返回元数据。
    pub fn wait(
        &mut self,
        cancel: &dyn Fn() -> bool,
        on_status: &dyn Fn(&str),
        timeout_secs: u64,
    ) -> Result<Value, AppError> {
        let deadline = Instant::now() + Duration::from_secs(timeout_secs.max(1));
        let mut round = 0u64;
        loop {
            if cancel() {
                return Err(AppError::Cancelled);
            }
            if Instant::now() >= deadline {
                return Err(err("扫码登录超时（二维码已失效，请重新打开）"));
            }
            if round.is_multiple_of(4) {
                on_status("等待夸克 App 扫码…");
            }
            let url = format!(
                "{UOP}/cas/ajax/getServiceTicketByQrcodeToken?client_id={CLIENT_ID}&v=1.2&token={}&request_id={}",
                self.token,
                rid()
            );
            let v = self.get(&url)?;
            let status = v.get("status").and_then(Value::as_i64).unwrap_or(0);
            let message = v.get("message").and_then(Value::as_str).unwrap_or("");
            let ticket = v
                .pointer("/data/members/service_ticket")
                .and_then(Value::as_str)
                .unwrap_or("");
            if status == 2_000_000 && message == "ok" && !ticket.is_empty() {
                return self.finish(ticket);
            }
            let low = message.to_ascii_lowercase();
            let failed = (5_000_402..=5_000_404).contains(&status)
                || ["expired", "failed", "error", "timeout", "invalid"]
                    .iter()
                    .any(|k| low.contains(k));
            if failed {
                return Err(err(format!("扫码登录失败：{message} [status {status}]")));
            }
            // 50004001 = 还没扫，继续等；每 250ms 检查一次取消
            for _ in 0..8 {
                if cancel() {
                    return Err(AppError::Cancelled);
                }
                std::thread::sleep(Duration::from_millis(250));
            }
            round += 1;
        }
    }

    fn finish(&mut self, ticket: &str) -> Result<Value, AppError> {
        let url = format!("{PAN}/account/info?st={ticket}&lw=scan");
        let _ = self.get_raw(&url)?;
        let cookie = self.jar.header();
        if cookie.is_empty() {
            return Err(err("扫码成功但服务端没有下发登录 cookie"));
        }
        // 落盘前强校验：不带 jar，只用这一份 cookie 问一遍账号信息
        let resp = self
            .http
            .get(format!("{PAN}/account/info?fr=pc&platform=pc"))
            .header(header::COOKIE, &cookie)
            .header(header::ACCEPT, "application/json, text/plain, */*")
            .header(header::REFERER, "https://pan.quark.cn/list")
            .send()
            .map_err(|e| err(format!("凭据校验请求失败：{e}")))?;
        let v: Value = resp
            .json()
            .map_err(|e| err(format!("凭据校验响应不是 JSON：{e}")))?;
        let nickname = account_nickname(&v)?;

        let home =
            crate::paths::home_dir().ok_or_else(|| err("找不到用户主目录，无法写入登录凭据"))?;
        let env_path = home.join(".config/kuake/.env");
        write_env(&env_path, &cookie)?;
        // 立即生效，无需重启：quark.rs::cookie() 每次都读进程环境
        std::env::set_var("KUAKE_COOKIE", &cookie);
        Ok(json!({
            "nickname": nickname,
            "cookie_len": cookie.len(),
            "cookie_names": self.jar.names(),
            "env_path": env_path.to_string_lossy(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jar_absorbs_set_cookie_and_honours_max_age_zero() {
        let mut h = HeaderMap::new();
        h.append(
            header::SET_COOKIE,
            "_UP_A4A_11_=abc; Max-Age=31536000; Domain=.quark.cn"
                .parse()
                .unwrap(),
        );
        h.append(
            header::SET_COOKIE,
            "_UP_BT_=; Max-Age=0; Domain=.quark.cn".parse().unwrap(),
        );
        h.append(header::SET_COOKIE, "_UP_D_=pc".parse().unwrap());
        let mut jar = Jar::default();
        jar.absorb(&h);
        assert_eq!(jar.header(), "_UP_A4A_11_=abc; _UP_D_=pc");
        assert_eq!(jar.names(), vec!["_UP_A4A_11_", "_UP_D_"]);
    }

    #[test]
    fn qr_url_is_percent_encoded() {
        let u = qr_url("sta123");
        assert!(u.starts_with("https://su.quark.cn/4_eMHBJ?token=sta123&client_id=532"));
        assert!(u.contains("S%3Acustom%7COPT%3ASAREA%400"));
    }

    #[test]
    fn qr_svg_contains_modules() {
        let svg = qr_svg(&qr_url("sta336333edc8ydzk4pvsxd4pifxid0u")).unwrap();
        assert!(svg.starts_with("<svg "));
        assert!(svg.contains("shape-rendering=\"crispEdges\""));
        assert!(svg.contains("M"));
    }

    #[test]
    fn account_check_requires_success_and_nickname() {
        assert_eq!(
            account_nickname(&json!({"success":true,"code":"OK","data":{"nickname":"lilyco42"}}))
                .unwrap(),
            "lilyco42"
        );
        assert!(account_nickname(&json!({"success":false,"data":{"nickname":"x"}})).is_err());
        assert!(account_nickname(&json!({"success":true,"data":{}})).is_err());
    }

    #[test]
    fn write_env_preserves_other_lines_and_replaces_cookie() {
        let dir = std::env::temp_dir().join(format!("ks-login-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join(".env");
        std::fs::write(
            &path,
            "# note\nFOO=bar\nKUAKE_COOKIE='old'\nKUAKE_PUS=keep\n",
        )
        .unwrap();
        write_env(&path, "__pus=new; __uid=u; b-user-id=x=y").unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("FOO=bar"));
        assert!(text.contains("KUAKE_PUS=keep"));
        assert!(text.contains("KUAKE_COOKIE='__pus=new; __uid=u; b-user-id=x=y'"));
        assert_eq!(text.matches("KUAKE_COOKIE=").count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_env_rejects_shell_unsafe_cookie() {
        let dir = std::env::temp_dir().join(format!("ks-login-unsafe-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join(".env");
        assert!(write_env(&path, "a=b'c").is_err());
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
