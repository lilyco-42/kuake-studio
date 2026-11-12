//! kuake-studio 核心库：桌面安装包与移动/鸿蒙进程内原生库共用同一份 Registry。
//!
//! 桌面（Windows / Linux / macOS）：开启默认特性 `desktop`，额外编入 axum Web 宿主
//! （src/server.rs）与安全中间件（src/security.rs），由 [[bin]] 起本地服务并打开浏览器。
//!
//! 移动 / 鸿蒙（Android / iOS / OpenHarmony）：用 --no-default-features 只编本库，
//! 通过 src/ffi.rs 的 C ABI 进程内执行命令 —— 不起 axum、不开浏览器、不读 stdin。
//! 宿主 App（Kotlin/Swift/ArkTS + WebView）自己渲染 UI、自己管凭据，本库只做逻辑。

pub mod apps;
pub mod crypt;
pub mod ffi;
pub mod kuake;
pub mod login;
pub mod paths;
pub mod quark;

#[cfg(feature = "desktop")]
pub mod security;
#[cfg(feature = "desktop")]
pub mod server;

use std::sync::Arc;

use lilyco::prelude::*;

/// 装配命令注册表：桌面 CLI / Web / MCP 与 FFI 共用的唯一入口。
/// 本地交互面 T0 只读 + T1 需确认全部放行，T2/T3 仍拒绝。
pub fn build_registry() -> Registry {
    let mut reg = Registry::new().with_policy(Arc::new(lilyco::__core::safety::Interactive));
    for cmd in apps::commands() {
        if let Err(e) = reg.register(cmd) {
            panic!("注册命令失败: {e}");
        }
    }
    reg
}

/// 同步执行一条命令，返回 JSON 信封（成功沿用命令自身的信封，失败统一包装）。
///
/// 纯进程内：不起 axum、不开浏览器、不读 stdin、不需要 token。进度事件走一个
/// 无人接收的 mpsc 通道（Context::emit 忽略发送失败，不会阻塞）。供 FFI 与
/// 任何嵌入方直接调用。
///
/// 凭据由宿主全权负责，本库不主动读本机 .env 覆盖：桌面入口 main() 启动时调
/// kuake::load_env_fallback() 做文件回退，移动/鸿蒙宿主调 set_cookie()（或 C ABI 的
/// kuake_studio_set_cookie）注入。网络命令需要 KUAKE_COOKIE / KUAKE_PUS 等凭据。
pub fn call(cmd: &str, args: &serde_json::Value) -> serde_json::Value {
    match call_inner(cmd, args) {
        Ok(v) => v,
        Err(e) => serde_json::json!({
            "success": false,
            "code": error_code(&e),
            "message": e.to_string(),
            "data": null,
        }),
    }
}

fn call_inner(cmd: &str, args: &serde_json::Value) -> Result<serde_json::Value, AppError> {
    let registry = build_registry();
    let command = registry
        .get(cmd)
        .filter(|c| !c.hidden)
        .ok_or_else(|| AppError::InvalidArg(format!("未知命令: {cmd}")))?;
    // 与 server.rs::api_run 同一条校验，浏览器端/宿主端都绕不过 required/min/max。
    command.schema.validate_args(args)?;
    let handler = command
        .handler
        .as_ref()
        .ok_or_else(|| AppError::Runtime(format!("命令 {cmd} 无可执行处理器")))?;
    let (tx, _rx) = std::sync::mpsc::channel();
    let ctx = Context::from_sender(tx);
    let f: &dyn Fn(&Context, &serde_json::Value) -> Result<serde_json::Value, AppError> =
        handler.as_ref();
    f(&ctx, args)
}

/// 把 AppError 变体映射成机器可读的错误码（对齐 HTTP/SSE 侧的 code 约定）。
fn error_code(e: &AppError) -> &'static str {
    match e {
        AppError::InvalidArg(_) => "INVALID_ARG",
        AppError::InvalidInput(_) => "INVALID_INPUT",
        AppError::Runtime(_) => "RUNTIME",
        AppError::Cancelled => "CANCELLED",
        AppError::Safety(_) => "SAFETY",
        AppError::Io(_) => "IO",
        AppError::Serialize(_) => "SERIALIZE",
    }
}

/// 注入夸克登录凭据（移动 / 鸿蒙宿主 App 的入口）。
///
/// 宿主 App 自己从安全存储读出 cookie，通过本函数（或 C ABI 的
/// kuake_studio_set_cookie）写进进程环境；之后 call() 执行命令时，
/// quark::Api::new() 每次都从这个环境读取，扫码登录也是同一口径。
/// 本库刻意不读本机 .env：那属于桌面 CLI 的便利回退，不该覆盖宿主新凭据。
pub fn set_cookie(cookie: &str) -> Result<(), AppError> {
    let c = cookie.trim();
    if c.is_empty() {
        return Err(AppError::InvalidArg("cookie 不能为空".into()));
    }
    std::env::set_var("KUAKE_COOKIE", c);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_cookie_rejects_empty() {
        assert!(set_cookie("   ").is_err());
        assert!(set_cookie("").is_err());
    }

    #[test]
    fn registry_has_all_commands() {
        let n = build_registry().to_json().as_array().unwrap().len();
        assert_eq!(n, 19, "命令数应当与 --schema 自检一致");
    }

    #[test]
    fn unknown_command_is_a_failure_envelope() {
        let v = call("__no_such_command__", &serde_json::json!({}));
        assert_eq!(v["success"], false);
        assert_eq!(v["code"], "INVALID_ARG");
        assert_eq!(v["data"], serde_json::Value::Null);
        assert!(v["message"].as_str().unwrap().contains("未知命令"));
    }

    #[test]
    fn hidden_or_null_args_do_not_panic() {
        // 非对象 args：validate_args / from_args 会给出参数错误信封，而不是 panic。
        let v = call("user", &serde_json::Value::Bool(true));
        assert_eq!(v["success"], false);
    }
}
