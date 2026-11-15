//! Web 宿主：axum 路由 + SSE 进度 + 静态资源。
//!
//! 为什么不用 lilyco-gui 现成的 serve_registry：那套页面是自研 CSS + vanilla JS，
//! 本次要求是 shadcn/ui（React + Radix + Tailwind）。但**执行语义照抄**：
//! 同一个 executor::spawn、同一条 Done/Error 收尾不变量、同样登记取消句柄。

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use axum::extract::{Path, Request, State};
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
use lilyco::__core::{AppError, CommandSchema, Progress};

/// 一次扫码登录会话的状态（后台 std::thread 与 Web 请求共享）。
pub struct LoginHandle {
    pub state: String,
    pub message: Option<String>,
    pub data: Option<serde_json::Value>,
    pub cancel: Arc<std::sync::atomic::AtomicBool>,
}

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
    /// 扫码登录会话 → 状态/取消句柄。后台是阻塞 std::thread，所以用 std::sync::Mutex。
    pub logins: std::sync::Mutex<HashMap<String, LoginHandle>>,
    /// 商业化配置（内置默认 + 云端白名单字段）。std RwLock：只在无 await 时持锁。
    pub commercial: RwLock<serde_json::Value>,
    /// 授权文件所在用户目录；桌面 / Android / FFI 共用 commercial::config_home()。
    pub commercial_home: std::path::PathBuf,
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
    let mut saw_terminal = false;
    let mut sent_ok = true;
    for event in task.rx {
        let terminal = matches!(event, Progress::Done { .. } | Progress::Error { .. });
        let json = serde_json::to_value(&event).unwrap_or(serde_json::Value::Null);
        if gui_tx.send(json).await.is_err() {
            sent_ok = false;
            break;
        }
        if terminal {
            saw_terminal = true;
            break;
        }
    }
    state.cancels.lock().await.remove(sid);
    // 兜底合成终态：仅当事件流里**没有**出现过 Done/Error 时才补发。
    // 此前无条件补发，导致每条失败命令都推两条一模一样的 error（前端收两次）。
    if let Ok(Err(e)) = task.handle.join() {
        if sent_ok && !saw_terminal {
            let _ = gui_tx
                .send(serde_json::json!({
                    "type": "error", "code": 1, "message": e.to_string(), "kind": null
                }))
                .await;
        }
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

/// 拖拽上传：请求体直接就是文件字节（不再 base64 膨胀 1/3），文件名放
/// X-Kuake-File（UTF-8 的 base64，HTTP 头不能放中文）。
///
/// 为什么单独一条路由：axum 的 Json / Bytes 提取器默认只收 2 MiB body，
/// 而拖进来的往往是几十 MB 的图片/视频。这里不经过任何提取器，自己用
/// to_bytes 收，并把上限显式钉在 2 GiB（回环 Host + 令牌保护，用户自担）。
/// 旧的 /api/upload（base64 JSON）保留给点击按钮的单文件上传对话框。
async fn api_upload_raw(request: Request) -> Response {
    const MAX_RAW: usize = 2 * 1024 * 1024 * 1024;
    let name = raw_upload_name(
        request
            .headers()
            .get("X-Kuake-File")
            .and_then(|v| v.to_str().ok())
            .unwrap_or(""),
    );
    if name.is_empty() {
        return (StatusCode::BAD_REQUEST, "文件名非法").into_response();
    }
    let body = match axum::body::to_bytes(request.into_body(), MAX_RAW).await {
        Ok(b) => b,
        Err(_) => return (StatusCode::PAYLOAD_TOO_LARGE, "文件过大（上限 2 GiB）").into_response(),
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
    if let Err(e) = std::fs::write(&path, body.as_ref()) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("写入暂存文件失败: {e}"),
        )
            .into_response();
    }
    Json(serde_json::json!({
        "path": path.to_string_lossy(),
        "name": name,
        "size": body.len(),
    }))
    .into_response()
}

/// X-Kuake-File 里放的是 UTF-8 文件名的 base64（HTTP 头不能直接放中文）。
fn raw_upload_name(encoded: &str) -> String {
    let bytes = base64_decode(encoded).unwrap_or_default();
    sanitize_filename(&String::from_utf8_lossy(&bytes))
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

// ── 扫码登录：后台阻塞线程轮询，前端轮询状态 ───────────────

async fn api_login_start(State(state): State<Arc<AppState>>) -> Response {
    // LoginSession::start 会真实访问 uop.quark.cn，绝不能占着 tokio worker。
    let started = tokio::task::spawn_blocking(|| {
        crate::login::LoginSession::start().map_err(|e| e.to_string())
    })
    .await;
    let session = match started {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            return (StatusCode::BAD_GATEWAY, format!("获取二维码失败：{e}")).into_response()
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("登录线程异常：{e}"),
            )
                .into_response()
        }
    };

    let sid = generate_id();
    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let mut map = state.logins.lock().unwrap_or_else(|e| e.into_inner());
        // 最多保留 8 个未完成会话；旧会话一律取消，避免恶意页面刷爆内存
        map.retain(|_, h| h.state == "waiting");
        if map.len() >= 8 {
            for h in map.values() {
                h.cancel.store(true, Ordering::Relaxed);
            }
            map.clear();
        }
        map.insert(
            sid.clone(),
            LoginHandle {
                state: "waiting".into(),
                message: Some("等待夸克 App 扫码…".into()),
                data: None,
                cancel: Arc::clone(&cancel),
            },
        );
    }
    let qr_url = session.qr_url.clone();
    let qr_data = session.qr_data.clone();

    let state2 = Arc::clone(&state);
    let sid2 = sid.clone();
    let cancel2 = Arc::clone(&cancel);
    std::thread::spawn(move || {
        let mut session = session;
        let result = session.wait(
            &|| cancel2.load(Ordering::Relaxed),
            &|msg| {
                let mut map = state2.logins.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(h) = map.get_mut(&sid2) {
                    h.message = Some(msg.to_string());
                }
            },
            300,
        );
        let mut map = state2.logins.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(h) = map.get_mut(&sid2) {
            match result {
                Ok(data) => {
                    h.state = "success".into();
                    h.message = None;
                    h.data = Some(data);
                }
                Err(AppError::Cancelled) => {
                    h.state = "cancelled".into();
                    h.message = None;
                }
                Err(e) => {
                    h.state = "failed".into();
                    h.message = Some(e.to_string());
                }
            }
        }
    });

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "sid": sid,
            "qr_url": qr_url,
            "qr_data": qr_data,
        })),
    )
        .into_response()
}

async fn api_login_status(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let snapshot = {
        let map = state.logins.lock().unwrap_or_else(|e| e.into_inner());
        map.get(&id)
            .map(|h| (h.state.clone(), h.message.clone(), h.data.clone()))
    };
    let Some((state, message, data)) = snapshot else {
        return (StatusCode::NOT_FOUND, "登录会话不存在或已结束").into_response();
    };
    let mut body = serde_json::json!({ "state": state, "message": message });
    if let Some(d) = data {
        body["data"] = d;
    }
    Json(body).into_response()
}

async fn api_login_cancel(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let found = {
        let map = state.logins.lock().unwrap_or_else(|e| e.into_inner());
        map.get(&id).map(|h| Arc::clone(&h.cancel))
    };
    match found {
        Some(flag) => {
            flag.store(true, Ordering::Relaxed);
            Json(serde_json::json!({ "ok": true })).into_response()
        }
        None => (StatusCode::NOT_FOUND, "登录会话不存在或已结束").into_response(),
    }
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
        // 前端据此决定是否拉 /api/commercial/config（旧版后端没有这些路由）。
        "commercial": true,
    }))
    .into_response()
}

/// 前端唯一的命令清单来源：直接吐 CommandSchema 数组。
/// 前端据此渲染表单（Flag→Switch、Enum→Select、Number→带 min/max 的 Input…），
/// 不硬编码任何 kuake 命令 —— 后端加一条命令，UI 自动多一个入口。
async fn api_schema(State(state): State<Arc<AppState>>) -> Response {
    Json(serde_json::json!({ "commands": state.schemas })).into_response()
}

// ── 商业化：联系方式 / 赞助图 / 启动弹窗 / 广告位 / 云端推送 / 离线授权 ───

#[derive(serde::Deserialize)]
struct LicenseRequest {
    #[serde(alias = "code")]
    token: String,
}

fn commercial_snapshot(state: &AppState) -> serde_json::Value {
    let cfg = state
        .commercial
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    crate::commercial::snapshot(&state.commercial_home, &cfg)
}

async fn api_commercial_config(State(state): State<Arc<AppState>>) -> Response {
    Json(commercial_snapshot(&state)).into_response()
}

async fn api_commercial_status(State(state): State<Arc<AppState>>) -> Response {
    Json(crate::commercial::status(&state.commercial_home)).into_response()
}

async fn api_commercial_activate(
    State(state): State<Arc<AppState>>,
    Json(req): Json<LicenseRequest>,
) -> Response {
    match crate::commercial::activate(&state.commercial_home, &req.token) {
        Ok(_) => Json(commercial_snapshot(&state)).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

async fn api_commercial_deactivate(State(state): State<Arc<AppState>>) -> Response {
    match crate::commercial::deactivate(&state.commercial_home) {
        Ok(_) => Json(commercial_snapshot(&state)).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

/// 赞助图同源路由：白名单 + include_bytes!，CSP 不用为任何外部域名开 img-src。
/// 路径参数只接受文件名（commercial::sponsor_png 白名单），不做磁盘拼接，无穿越。
async fn api_sponsor_png(Path(name): Path<String>) -> Response {
    let Some(bytes) = crate::commercial::sponsor_png(&name) else {
        return (StatusCode::NOT_FOUND, "Not Found").into_response();
    };
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "public, max-age=86400"),
        ],
        bytes.to_vec(),
    )
        .into_response()
}

/// 拉一次远端配置并合入白名单字段。阻塞 HTTP 放 spawn_blocking，绝不占 tokio worker。
/// 远端改不了收款码 / 联系方式 / 公钥 / 拉取地址；失败只记 last_error，不影响离线使用。
async fn commercial_refresh_once(state: &Arc<AppState>) -> Result<serde_json::Value, String> {
    let (base, url) = {
        let cfg = state
            .commercial
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let url = cfg["cloud"]["url"].as_str().unwrap_or("").to_string();
        (cfg, url)
    };
    if url.is_empty() {
        return Err("未配置 KUAKE_STUDIO_CLOUD_CONFIG_URL".into());
    }
    let remote = tokio::task::spawn_blocking(move || crate::commercial::fetch_cloud_config(&url))
        .await
        .map_err(|e| format!("云端拉取线程异常: {e}"))??;
    let mut out = crate::commercial::merge_cloud_config(&base, &remote)?;
    out["cloud"]["last_refresh"] = serde_json::json!(crate::commercial::now_secs());
    out["cloud"]["last_error"] = serde_json::Value::Null;
    {
        let mut guard = state.commercial.write().unwrap_or_else(|e| e.into_inner());
        *guard = out.clone();
    }
    Ok(crate::commercial::snapshot(&state.commercial_home, &out))
}

async fn api_commercial_refresh(State(state): State<Arc<AppState>>) -> Response {
    match commercial_refresh_once(&state).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => {
            let mut guard = state.commercial.write().unwrap_or_else(|g| g.into_inner());
            (*guard)["cloud"]["last_error"] = serde_json::Value::String(e.clone());
            (StatusCode::BAD_GATEWAY, e).into_response()
        }
    }
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
    let mut commercial = crate::commercial::default_config();
    // 云端推送是「显式开启」：不设环境变量就一个外连都不发，离线可用。
    if let Ok(url) = std::env::var("KUAKE_STUDIO_CLOUD_CONFIG_URL") {
        let url = url.trim().to_string();
        if !url.is_empty() {
            commercial["cloud"]["enabled"] = serde_json::Value::Bool(true);
            commercial["cloud"]["url"] = serde_json::Value::String(url);
        }
    }
    Arc::new(AppState {
        registry: Arc::new(registry),
        schemas,
        sessions: Mutex::new(HashMap::new()),
        cancels: Mutex::new(HashMap::new()),
        token,
        dist,
        logins: std::sync::Mutex::new(HashMap::new()),
        commercial: RwLock::new(commercial),
        commercial_home: crate::commercial::config_home(),
    })
}

pub async fn serve(state: Arc<AppState>, port: u16) -> std::io::Result<()> {
    // 凭据恢复的唯一入口：桌面 main.rs 与 Android JNI（android/src/lib.rs）都从这里起服务。
    //
    // 为什么放在 serve() 而不是各自入口：login 成功后 login.rs 只把 cookie 写进
    // $HOME/.config/kuake/.env 并 set_var 到**当次进程**，重启后必须从文件读回。
    // 桌面端 main.rs 早就调了，Android 走 JNI 不经过 main —— 于是 v0.5.3 及以前在
    // Android 上「扫码登录后杀掉 App 重开，凭据全丢，每次启动都要重扫」。
    // 放在 serve() 里，任何「跑本机服务」的宿主都自动具备，不会再有第三处漏掉。
    // 走 FFI 的 iOS / 鸿蒙宿主不经过 serve()，它们按设计由宿主自己注入凭据。
    crate::kuake::load_env_fallback();

    let app = Router::new()
        .route("/api/boot", get(api_boot))
        .route("/api/schema", get(api_schema))
        .route("/api/run", post(api_run))
        .route("/api/progress/{sid}", get(api_progress))
        .route("/api/cancel/{sid}", post(api_cancel))
        .route("/api/upload", post(api_upload))
        .route("/api/upload/raw", post(api_upload_raw))
        .route("/api/login/start", post(api_login_start))
        .route("/api/login/status/{sid}", get(api_login_status))
        .route("/api/login/cancel/{sid}", post(api_login_cancel))
        .route("/api/commercial/config", get(api_commercial_config))
        .route("/api/commercial/status", get(api_commercial_status))
        .route("/api/commercial/activate", post(api_commercial_activate))
        .route(
            "/api/commercial/deactivate",
            post(api_commercial_deactivate),
        )
        .route("/api/commercial/refresh", post(api_commercial_refresh))
        .route("/assets/sponsor/{name}", get(api_sponsor_png))
        .fallback(static_handler)
        .layer(axum::middleware::from_fn_with_state(
            Arc::clone(&state),
            crate::security::guard,
        ))
        .with_state(Arc::clone(&state));

    // 云端推送：只有显式设了 URL 才起后台轮询；间隔每次从（可被远端白名单改的）配置读。
    if state.commercial.read().unwrap_or_else(|e| e.into_inner())["cloud"]["enabled"]
        .as_bool()
        .unwrap_or(false)
    {
        let st = Arc::clone(&state);
        tokio::spawn(async move {
            loop {
                let _ = commercial_refresh_once(&st).await;
                let secs = st.commercial.read().unwrap_or_else(|e| e.into_inner())["cloud"]
                    ["refresh_interval_sec"]
                    .as_u64()
                    .unwrap_or(3600)
                    .clamp(60, 86_400);
                tokio::time::sleep(Duration::from_secs(secs)).await;
            }
        });
    }

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
    fn raw_upload_name_decodes_and_sanitizes() {
        // "a b.txt" 的 base64；空格会被 sanitize_filename 换成下划线
        assert_eq!(raw_upload_name("YSBiLnR4dA=="), "a_b.txt");
        assert!(raw_upload_name("!!!not-base64!!!").is_empty());
        assert!(raw_upload_name("").is_empty());
    }

    #[test]
    fn filename_is_sanitized() {
        assert_eq!(sanitize_filename("../../etc/passwd"), "____etc_passwd");
        assert!(sanitize_filename("").is_empty());
    }

    #[test]
    fn login_state_starts_clean() {
        let reg = Registry::new();
        let state = build_state(reg, "t".into(), std::path::PathBuf::from("dist"));
        assert!(state.logins.lock().unwrap().is_empty());
    }

    #[test]
    fn commercial_snapshot_is_offline_and_same_origin() {
        let reg = Registry::new();
        let state = build_state(reg, "t".into(), std::path::PathBuf::from("dist"));
        let v = commercial_snapshot(&state);
        assert_eq!(v["config"]["contact"]["wechat"], "lilyco42");
        assert_eq!(v["config"]["contact"]["qq"], "1957374829");
        assert_eq!(v["config"]["cloud"]["url"], "");
        assert_eq!(v["config"]["cloud"]["enabled"], false);
        let img = v["config"]["sponsor"]["links"][0]["image"]
            .as_str()
            .unwrap();
        assert!(img.starts_with("/assets/sponsor/"), "赞助图必须同源");
        assert!(v["status"].get("sponsored").is_some());
    }

    #[test]
    fn sponsor_png_whitelist_blocks_traversal() {
        assert!(crate::commercial::sponsor_png("wechat-pay.png").is_some());
        assert!(crate::commercial::sponsor_png("..%2f.env").is_none());
        assert!(crate::commercial::sponsor_png("../../etc/passwd").is_none());
    }

    #[tokio::test]
    async fn refresh_without_url_fails_without_network() {
        let reg = Registry::new();
        let state = build_state(reg, "t".into(), std::path::PathBuf::from("dist"));
        {
            let mut g = state.commercial.write().unwrap();
            (*g)["cloud"]["url"] = serde_json::Value::String(String::new());
        }
        let err = commercial_refresh_once(&state).await.unwrap_err();
        assert!(err.contains("未配置"), "实际: {err}");
    }

    #[test]
    fn content_types_are_explicit() {
        assert!(content_type("a.js").starts_with("text/javascript"));
        assert_eq!(content_type("a.css"), "text/css; charset=utf-8");
    }
}
