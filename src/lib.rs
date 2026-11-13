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
    for mut cmd in apps::commands() {
        // 在 register 的安全门「之前」补默认：策略门拿到的仍是调用方原始 args，
        // 语义不变；补齐只发生在真正进入 from_args 之前。
        if let Some(handler) = cmd.handler.take() {
            let defaults = defaults_of(&cmd.schema);
            cmd.handler = Some(with_defaults(defaults, handler));
        }
        if let Err(e) = reg.register(cmd) {
            panic!("注册命令失败: {e}");
        }
    }
    reg
}

/// 从命令 schema 抽出 (参数名 → 默认值) 清单，供注册层补齐 args。
///
/// 背景：`#[derive(App)]` 会把 `#[arg(default = …)]` 写进 `ArgSchema.default`，
/// 但生成的 `from_args` 取值时对缺失键一律 `unwrap_or(0 / "" / false)`，Enum 甚至
/// 会对空串直接返回 InvalidArg。lilyco-cli 走 clap，clap 会按 schema 把默认值填进
/// args，所以 CLI 正常；而 Web(SSE) / MCP / FFI / 任何嵌入方都是直接把调用方的
/// args JSON 交给 handler —— 缺键就变成 0 或空串：search 不传 size 只回 1 条、
/// share 不传 days 直接报错、login 不传 timeout 只等 10 秒。
///
/// 本项目所有宿主都从 build_registry() 取命令（见模块头注释），所以在这里统一
/// 补一次即可全覆盖，不必改上游 lilyco、不必跨仓重新锁 rev。
fn defaults_of(schema: &CommandSchema) -> Vec<(String, serde_json::Value)> {
    schema
        .args
        .iter()
        .filter_map(|a| a.default.as_ref().map(|d| (a.name.clone(), d.clone())))
        .collect()
}

/// 给 handler 包一层「按 schema 补默认」。
///
/// 只补**缺失 / null** 的键（与 CommandSchema::validate_args「null 视为缺省」同口径）；
/// 调用方显式给的值（含合法的 0 / 空串）一律不动 —— 幂等、不覆盖用户意图，
/// 显式的非法值仍由 validate_args / 业务层判定。非对象 args 原样透传，
/// 仍由 from_app 给出参数错误信封。defaults 为空时原样返回同一个 handler，零开销。
fn with_defaults(defaults: Vec<(String, serde_json::Value)>, handler: Handler) -> Handler {
    if defaults.is_empty() {
        return handler;
    }
    Arc::new(move |ctx, args| {
        let mut filled = args.clone();
        if let Some(map) = filled.as_object_mut() {
            for (name, default) in &defaults {
                if matches!(map.get(name), None | Some(serde_json::Value::Null)) {
                    map.insert(name.clone(), default.clone());
                }
            }
        }
        handler(ctx, &filled)
    })
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

    /// 回显 args 的假 handler：只验证补默认这一层，完全不碰网络。
    fn echo_handler() -> Handler {
        Arc::new(|_ctx, args| Ok(args.clone()))
    }

    #[test]
    fn with_defaults_fills_missing_and_null_only() {
        let defaults = vec![
            ("page".to_string(), serde_json::json!(1)),
            ("size".to_string(), serde_json::json!(50)),
            ("days".to_string(), serde_json::json!("1")),
        ];
        let h = with_defaults(defaults, echo_handler());
        let (tx, _rx) = std::sync::mpsc::channel();
        let ctx = Context::from_sender(tx);

        // 缺失的补齐，显式给的不动
        let got = h(&ctx, &serde_json::json!({ "size": 2 })).unwrap();
        assert_eq!(got["page"], 1);
        assert_eq!(got["size"], 2, "显式值不得被覆盖");
        assert_eq!(got["days"], "1");

        // null 与缺失同义（与 validate_args 口径一致）
        let got2 = h(&ctx, &serde_json::json!({ "page": null, "size": null })).unwrap();
        assert_eq!(got2["page"], 1);
        assert_eq!(got2["size"], 50);

        // 显式的 0 也尊重（是调用方选择，交由 validate_args / 业务层判定）
        let got3 = h(&ctx, &serde_json::json!({ "page": 0 })).unwrap();
        assert_eq!(got3["page"], 0);

        // 非对象 args 原样透传，不 panic
        let got4 = h(&ctx, &serde_json::Value::Bool(true)).unwrap();
        assert_eq!(got4, serde_json::Value::Bool(true));
    }

    #[test]
    fn empty_defaults_returns_same_handler() {
        let h = echo_handler();
        let same = with_defaults(vec![], Arc::clone(&h));
        assert!(Arc::ptr_eq(&h, &same), "无 default 的命令不该被包一层");
    }

    /// 这些 default 是各宿主（HTTP/SSE/MCP/FFI）行为的前提；schema 一旦漂移，
    /// 补默认就会失效（例如 search 又悄悄只回 1 条），所以在此钉死。
    #[test]
    fn registry_schemas_expose_defaults_hosts_rely_on() {
        let reg = build_registry();
        let expect = |cmd: &str, key: &str, val: serde_json::Value| {
            let c = reg.get(cmd).unwrap_or_else(|| panic!("缺命令 {cmd}"));
            let d = defaults_of(&c.schema);
            assert!(
                d.iter().any(|(k, v)| k == key && v == &val),
                "{cmd}.{key} 应有 default {val}，实际 {d:?}"
            );
        };
        expect("search", "page", serde_json::json!(1));
        expect("search", "size", serde_json::json!(50));
        expect("share-list", "page", serde_json::json!(1));
        expect("share-list", "size", serde_json::json!(50));
        expect("share", "days", serde_json::json!("1"));
        expect("login", "timeout", serde_json::json!(300));
        expect("list", "path", serde_json::json!("/"));
        expect("create", "pdir", serde_json::json!("/"));
    }
}
