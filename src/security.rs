//! 回环安全闸：与 lilyco-gui 同一套威胁模型。
//!
//! 1. 所有请求的 Host 必须是回环地址（防 DNS rebinding）
//! 2. 受保护 POST 的 Origin 若存在必须是回环地址（防 CSRF）
//! 3. 受保护 POST 必须带本次启动随机生成的令牌（防同机其他页面乱调）

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::server::AppState;

/// 前端从 <meta name="kuake-token"> 读出后塞进这个头
pub const TOKEN_HEADER: &str = "X-Kuake-Token";

const PROTECTED_POST: &[&str] = &["/api/run", "/api/upload", "/api/cancel"];
/// 扫码登录会改本机凭据，POST 必须同样带令牌 + 回环 Origin。
const PROTECTED_PREFIXES: &[&str] = &["/api/login/"];

pub fn is_loopback_host(host: &str) -> bool {
    let host = host.trim().to_ascii_lowercase();
    let host = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or("")
    } else {
        host.split(':').next().unwrap_or("")
    };
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

fn origin_host(origin: &str) -> Option<&str> {
    let rest = origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))?;
    let host = rest.split(['/', ':', '?', '#']).next().unwrap_or("");
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

pub fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.as_bytes().iter().zip(b.as_bytes().iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name)?.to_str().ok()
}

pub async fn guard(State(state): State<Arc<AppState>>, request: Request, next: Next) -> Response {
    let headers = request.headers();

    let host = header_str(headers, "host").unwrap_or_default();
    if !is_loopback_host(host) {
        return (StatusCode::FORBIDDEN, "Forbidden: non-loopback Host").into_response();
    }

    let path = request.uri().path().to_string();
    let protected = request.method() == Method::POST
        && (PROTECTED_POST.contains(&path.as_str())
            || path.starts_with("/api/cancel/")
            || PROTECTED_PREFIXES.iter().any(|p| path.starts_with(p)));
    if protected {
        if let Some(origin) = header_str(headers, "origin") {
            let ok = origin_host(origin).map(is_loopback_host).unwrap_or(false);
            if !ok {
                return (StatusCode::FORBIDDEN, "Forbidden: cross-origin").into_response();
            }
        }
        let token = header_str(headers, TOKEN_HEADER).unwrap_or_default();
        if !constant_time_eq(token, &state.token) {
            return (StatusCode::UNAUTHORIZED, "Unauthorized: bad token").into_response();
        }
    }

    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_detection() {
        assert!(is_loopback_host("127.0.0.1:8787"));
        assert!(is_loopback_host("localhost:5180"));
        assert!(is_loopback_host("[::1]:8787"));
        assert!(!is_loopback_host("evil.example.com"));
    }

    #[test]
    fn login_post_is_protected() {
        assert!("/api/login/start".starts_with(PROTECTED_PREFIXES[0]));
        assert!("/api/login/cancel/abc".starts_with(PROTECTED_PREFIXES[0]));
        assert!(!"/api/loginish/start".starts_with(PROTECTED_PREFIXES[0]));
    }

    #[test]
    fn origin_parsing() {
        assert_eq!(origin_host("http://127.0.0.1:8080"), Some("127.0.0.1"));
        assert_eq!(origin_host("https://attacker.io"), Some("attacker.io"));
        assert_eq!(origin_host("file://"), None);
    }
}
