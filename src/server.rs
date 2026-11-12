//! Web 宿主：axum 路由 + SSE 进度 + 静态资源。
//!
//! 为什么不用 lilyco-gui 现成的 serve_registry：那套页面是自研 CSS + vanilla JS，
//! 本次要求是 shadcn/ui（React + Radix + Tailwind）。但**执行语义照抄**：
//! 同一个 executor::spawn、同一条 Done/Error 收尾不变量、同样登记取消句柄。

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{header, HeaderValue, StatusCode, Uri};
use axum::response::{
    sse::{Event, KeepAlive, Sse},
    IntoResponse, Response,
};
use axum::routing::{get, post};
use axum::{Json, Router};
use tokio::sync::{mpsc, Mutex};

use lilyco::__core::executor;
use lilyco::__core::registry::{Handler, Registry};
use lilyco::__core::{CommandSchema, Progress};

pub struct AppState {
    /// 多命令注册表（每条 kuake 命令一个 App）
    pub registry: Arc<Registry>,
    /// 每个命令的 schema 快照（/api/schema 直接吐它）
    pub schemas: Vec<CommandSchema>,
    /// 会话 → 事件流接收端
    pub sessions: Mutex<HashMap<String, mpsc::Receiver<serde_json::Value>>>,
    /// 会话 → 取消句柄（/api/cancel 唯一能找到句柄的地方）
    pub cancels: Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>,
    /// 本次启动随机令牌
    pub token: String,
    /// 前端构建产物目录（dist）
    pub dist: std::path::PathBuf,
}

fn generate_id() -> String {
    use rand::distributions::Alphanumeric;
    use rand::Rng;
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

// ── 执行：把 handler 的进度事件转发进 SSE 通道 ──────────────

async fn run_progress(
    state: &AppState,
    sid: &str,
    handler: Handler,
    args: serde_json::Value,
    gui_tx: mpsc::Sender<serde_json::Value>,
) {
    let task = executor::spawn(handler, args);
    state
        .cancels
        .lock()
        .await
        .insert(sid.to_string(), Arc::clone(&task.cancel));
    // for event in task.rx 是阻塞收（crossbeam），占一个 worker 线程
    // —— 与 lilyco-gui 同一条约束：只能在多线程 runtime 上跑
    for event in task.rx {
        let json = serde_json::to_value(&event).unwrap_or(serde_json::Value::Null);
        if gui_tx.send(json).await.is_err() {
            break;
        }
        if matches!(event, Progress::Done { .. } | Progress::Error { .. }) {
            break;
        }
    }
    state.cancels.lock().await.remove(sid);
    if let Ok(Err(e)) = task.handle.join() {
        let _ = gui_tx
            .send(serde_json::json!({
                "type": "error", "code": 1, "message": e.to_string(), "kind": null
            }))
            .await;
    }
}

#[derive(serde::Deserialize)]
struct RunRequest {
    cmd: String,
    #[serde(default)]
    args: HashMap<String, serde_json::Value>,
}

async fn api_run(State(state): State<Arc<AppState>>, Json(req): Json<RunRequest>) -> Response {
    let Some(cmd) = state.registry.get(&req.cmd).filter(|c| !c.hidden) else {
        return (StatusCode::BAD_REQUEST, format!("未知命令: {}", req.cmd)).into_response();
    };
    let args_value = serde_json::json!(req.args);
    // 服务端 schema 校验：浏览器端的 required/min/max 可被绕过
    if let Err(e) = cmd.schema.validate_args(&args_value) {
        return (StatusCode::BAD_REQUEST, e.to_string()).into_response();
    }
    let Some(handler) = cmd.handler.clone() else {
        return (
            StatusCode::BAD_REQUEST,
            format!("命令 {} 没有处理器", cmd.name),
        )
            .into_response();
    };

    let sid = generate_id();
    let (tx, rx) = mpsc::channel::<serde_json::Value>(256);
    state.sessions.lock().await.insert(sid.clone(), rx);
    let state2 = Arc::clone(&state);
    let sid2 = sid.clone();
    tokio::spawn(async move {
        run_progress(&state2, &sid2, handler, args_value, tx).await;
    });
    (
        StatusCode::OK,
        Json(serde_json::json!({ "session_id": sid })),
    )
        .into_response()
}

async fn api_cancel(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let flag = state.cancels.lock().await.get(&id).cloned();
    match flag {
        Some(f) => {
            f.store(true, Ordering::Relaxed);
            Json(serde_json::json!({ "ok": true })).into_response()
        }
        None => (StatusCode::NOT_FOUND, "没有正在运行的会话（可能已结束）").into_response(),
    }
}

async fn api_progress(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let maybe_rx = { state.sessions.lock().await.remove(&id) };
    let found = maybe_rx.is_some();

    let stream = async_stream::stream! {
        if !found {
            yield Result::<Event, Infallible>::Ok(
                Event::default().data(
                    serde_json::json!({"type":"error","code":1,"message":"会话不存在或已被消费"}).to_string()
                )
            );
        } else {
            let mut rx = maybe_rx.unwrap();
            while let Some(msg) = rx.recv().await {
                yield Ok(Event::default().data(msg.to_string()));
            }
        }
    };

    Sse::new(stream).keep_alive(KeepAlive::default())
}

#[derive(serde::Deserialize)]
struct UploadRequest {
    name: String,
    #[serde(alias = "dataB64")]
    data_b64: String,
}

/// 浏览器不给真实路径 → base64 落盘到临时目录 → 回填绝对路径给 upload 命令。
/// 与 lilyco-gui 的 /upload 同形，但上限放宽到 2 GiB 之外不做限制（本机回环，用户自担）。
async fn api_upload(Json(req): Json<UploadRequest>) -> Response {
    let name = sanitize_filename(&req.name);
    if name.is_empty() {
        return (StatusCode::BAD_REQUEST, "文件名非法").into_response();
    }
    let Some(bytes) = base64_decode(&req.data_b64) else {
        return (StatusCode::BAD_REQUEST, "base64 解码失败").into_response();
    };
    let dir = std::env::temp_dir().join("kuake-studio-uploads");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("创建暂存目录失败: {e}"),
        )
            .into_response();
    }
    let unique = format!("{}-{}", generate_id(), name);
    let path = dir.join(unique);
    if let Err(e) = std::fs::write(&path, &bytes) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("写入暂存文件失败: {e}"),
        )
            .into_response();
    }
    Json(serde_json::json!({
        "path": path.to_string_lossy(),
        "name": name,
        "size": bytes.len(),
    }))
    .into_response()
}

fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .take(160)
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let cleaned = cleaned.replace("..", "_");
    if cleaned.is_empty() || cleaned == "." {
        String::new()
    } else {
        cleaned
    }
}

fn base64_decode(input: &str) -> Option<Vec<u8>> {
    const INVALID: u8 = 0xFF;
    fn val(c: u8) -> u8 {
        match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => INVALID,
        }
    }
    let bytes: Vec<u8> = input
        .bytes()
        .filter(|b| !b.is_ascii_whitespace() && *b != b'=')
        .collect();
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3 + 3);
    let mut acc: u32 = 0;
    let mut nbits: u32 = 0;
    for &b in &bytes {
        let v = val(b);
        if v == INVALID {
            return None;
        }
        acc = (acc << 6) | v as u32;
        nbits += 6;
        if nbits >= 8 {
            nbits -= 8;
            out.push((acc >> nbits) as u8);
        }
    }
    if nbits >= 6 && (acc & ((1 << nbits) - 1)) != 0 {
        return None;
    }
    Some(out)
}

// ── 元信息 ─────────────────────────────────────────────────

/// 启动握手：前端从这里拿令牌。
/// 安全性：只做 GET（无副作用）+ 回环 Host 校验 + **不设任何 CORS 头**，
/// 因此其他源（包括本机的恶意页面）读不到响应体，令牌不会外泄。
async fn api_boot(State(state): State<Arc<AppState>>) -> Response {
    Json(serde_json::json!({
        "token": state.token,
        "name": "kuake-studio",
        "version": env!("CARGO_PKG_VERSION"),
        "kuake": crate::kuake::kuake_bin(),
        // 默认内置的原生夸克 API；设 KUAKE_STUDIO_BACKEND=cli 才回退到子进程。
        "backend": if std::env::var("KUAKE_STUDIO_BACKEND").as_deref() == Ok("cli") { "cli" } else { "native" },
        // 临时目录也交给后端决定：前端原来硬编码 /tmp，在 Windows 上会落到盘符根。
        "temp": std::env::temp_dir().to_string_lossy(),
    }))
    .into_response()
}

/// 前端唯一的命令清单来源：直接吐 CommandSchema 数组。
/// 前端据此渲染表单（Flag→Switch、Enum→Select、Number→带 min/max 的 Input…），
/// 不硬编码任何 kuake 命令 —— 后端加一条命令，UI 自动多一个入口。
async fn api_schema(State(state): State<Arc<AppState>>) -> Response {
    Json(serde_json::json!({ "commands": state.schemas })).into_response()
}

// ── 静态资源 ───────────────────────────────────────────────

fn content_type(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("");
    match ext {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "map" => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
}

const FALLBACK_HTML: &str = concat!(
    "<!doctype html><meta charset=utf-8><title>kuake studio</title>",
    "<body style=\"font-family:system-ui;padding:48px;max-width:720px;margin:auto;line-height:1.7\">",
    "<h1>前端还没构建</h1>",
    "<p>后端已在运行，但找不到 <code>frontend/dist</code>。</p>",
    "<pre style=\"background:#f4f4f5;padding:16px;border-radius:8px\">cd frontend\nbun install\nbun run build</pre>",
    "<p>或者开发模式：终端 A 跑 <code>bun run dev</code>，终端 B 保留本服务。</p>",
    "</body>"
);

async fn static_handler(State(state): State<Arc<AppState>>, uri: Uri) -> Response {
    let raw = uri.path().trim_start_matches('/');
    let rel = if raw.is_empty() { "index.html" } else { raw };

    // 路径穿越防护
    if rel.contains("..") {
        return (StatusCode::FORBIDDEN, "Forbidden").into_response();
    }

    let candidate = state.dist.join(rel);
    let (bytes, path_str) = if candidate.is_file() {
        match std::fs::read(&candidate) {
            Ok(b) => (b, rel.to_string()),
            Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "read failed").into_response(),
        }
    } else {
        // SPA 回退：非静态资源路径一律给 index.html
        let index = state.dist.join("index.html");
        match std::fs::read(&index) {
            Ok(b) => (b, "index.html".to_string()),
            Err(_) => {
                return (
                    StatusCode::OK,
                    [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                    FALLBACK_HTML,
                )
                    .into_response()
            }
        }
    };

    let mut resp = (StatusCode::OK, bytes).into_response();
    let headers = resp.headers_mut();
    if let Ok(v) = HeaderValue::from_str(content_type(&path_str)) {
        headers.insert(header::CONTENT_TYPE, v);
    }
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache, must-revalidate"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; \
             style-src 'self' 'unsafe-inline'; \
             script-src 'self'; \
             img-src 'self' data: blob:; \
             connect-src 'self'; \
             base-uri 'none'; \
             frame-ancestors 'none'",
        ),
    );
    resp
}

// ── 装配 ───────────────────────────────────────────────────

pub fn default_dist() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("KUAKE_STUDIO_DIST") {
        if !p.trim().is_empty() {
            return std::path::PathBuf::from(p);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let guess = dir.join("dist");
            if guess.is_dir() {
                return guess;
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        let guess = cwd.join("frontend/dist");
        if guess.is_dir() {
            return guess;
        }
        let guess2 = cwd.join("dist");
        if guess2.is_dir() {
            return guess2;
        }
    }
    // 最后兜底：源码树里跑（开发者本机）。Windows 上拿不到 HOME 就退 USERPROFILE。
    crate::paths::home_dir()
        .map(|h| h.join("code/kuake-studio/frontend/dist"))
        .unwrap_or_else(|| std::path::PathBuf::from("frontend/dist"))
}

pub fn build_state(registry: Registry, token: String, dist: std::path::PathBuf) -> Arc<AppState> {
    let schemas = registry.visible().map(|c| c.schema.clone()).collect();
    Arc::new(AppState {
        registry: Arc::new(registry),
        schemas,
        sessions: Mutex::new(HashMap::new()),
        cancels: Mutex::new(HashMap::new()),
        token,
        dist,
    })
}

pub async fn serve(state: Arc<AppState>, port: u16) -> std::io::Result<()> {
    let app = Router::new()
        .route("/api/boot", get(api_boot))
        .route("/api/schema", get(api_schema))
        .route("/api/run", post(api_run))
        .route("/api/progress/{sid}", get(api_progress))
        .route("/api/cancel/{sid}", post(api_cancel))
        .route("/api/upload", post(api_upload))
        .fallback(static_handler)
        .layer(axum::middleware::from_fn_with_state(
            Arc::clone(&state),
            crate::security::guard,
        ))
        .with_state(Arc::clone(&state));

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    eprintln!(
        "[kuake-studio] http://127.0.0.1:{port}  （前端目录: {}）",
        state.dist.display()
    );
    axum::serve(listener, app).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_roundtrip() {
        assert_eq!(base64_decode("aGVsbG8=").unwrap(), b"hello".to_vec());
    }

    #[test]
    fn filename_is_sanitized() {
        assert_eq!(sanitize_filename("../../etc/passwd"), "____etc_passwd");
        assert!(sanitize_filename("").is_empty());
    }

    #[test]
    fn content_types_are_explicit() {
        assert!(content_type("a.js").starts_with("text/javascript"));
        assert_eq!(content_type("a.css"), "text/css; charset=utf-8");
    }
}
