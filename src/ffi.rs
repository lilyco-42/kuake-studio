//! 进程内 C ABI：给 Android (JNI/NDK)、iOS (Swift)、鸿蒙 (NAPI/ArkTS) 的原生层调用。
//!
//! 设计约束（与桌面 Web 宿主的差别，写清楚免得被误当成"移动 App"）：
//! - 不启动 axum、不监听端口、不打开外部浏览器、不生成随机 token；
//! - 宿主 App 自己用 WebView 渲染前端 dist、自己管生命周期与凭据；
//!   启动后先调 kuake_studio_set_cookie 注入 cookie，本库不读本机 .env 覆盖；
//! - 所有字符串都用 C UTF-8；带 _alloc 语义的返回值必须用 kuake_studio_free 释放；
//! - kuake_studio_version 返回进程内静态缓冲，永不释放、不可 free。
//!
//! panic 绝不允许越过 extern "C" 边界：所有入口都用 catch_unwind 兜底，
//! 空指针与非法 UTF-8 都转成 JSON 错误信封，而不是 UB。

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};

/// 读一个 C 字符串；空指针或非法 UTF-8 返回 None（绝不解引用野指针）。
unsafe fn input<'a>(p: *const c_char) -> Option<&'a str> {
    if p.is_null() {
        return None;
    }
    CStr::from_ptr(p).to_str().ok()
}

/// 把 Rust String 交给调用方：CString::into_raw，配 kuake_studio_free 回收。
fn alloc(s: String) -> *mut c_char {
    CString::new(s)
        .unwrap_or_else(|_| {
            // 返回串里混进 NUL 时换成一份安全的错误信封（failure 生成的内容不含 NUL）
            CString::new(failure("NUL", "返回串含 NUL 字节，已替换为错误信封"))
                .expect("错误信封是合法 C 字符串")
        })
        .into_raw()
}

fn failure(code: &str, message: &str) -> String {
    serde_json::json!({
        "success": false, "code": code, "message": message, "data": null
    })
    .to_string()
}

/// 库版本（如 "0.5.0"）。静态缓冲，勿 free。
#[no_mangle]
pub extern "C" fn kuake_studio_version() -> *const c_char {
    static VERSION: std::sync::OnceLock<CString> = std::sync::OnceLock::new();
    VERSION
        .get_or_init(|| CString::new(env!("CARGO_PKG_VERSION")).unwrap())
        .as_ptr()
}

/// 启动信息 JSON：{name, version, backend, mode, os, arch}。
/// mode 恒为 "in-process"，明确不是 axum 服务器；不含任何 token/cookie。
/// 返回值需 kuake_studio_free。
#[no_mangle]
pub extern "C" fn kuake_studio_boot() -> *mut c_char {
    let s = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        serde_json::json!({
            "name": "kuake-studio",
            "version": env!("CARGO_PKG_VERSION"),
            "backend": "native",
            "mode": "in-process",
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
        })
        .to_string()
    }))
    .unwrap_or_else(|_| failure("PANIC", "boot 内部错误（panic 已拦截）"));
    alloc(s)
}

/// 全部命令 schema 的 JSON 数组（宿主据此渲染表单 / 校验参数）。返回值需 free。
#[no_mangle]
pub extern "C" fn kuake_studio_schemas() -> *mut c_char {
    let s = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        crate::build_registry().to_json().to_string()
    }))
    .unwrap_or_else(|_| "[]".to_string());
    alloc(s)
}

/// 设置夸克登录凭据（写进程环境 KUAKE_COOKIE，与桌面扫码登录后同一口径）。
/// 建议在启动时调用一次，之后不要再并发改写；返回 0 成功，1 表示空/非法参数。
///
/// # Safety
/// cookie 必须是 NULL 或指向合法的、以 NUL 结尾的 UTF-8 C 字符串。
#[no_mangle]
pub unsafe extern "C" fn kuake_studio_set_cookie(cookie: *const c_char) -> c_int {
    match unsafe { input(cookie) } {
        Some(c) if crate::set_cookie(c).is_ok() => 0,
        _ => 1,
    }
}

/// 同步执行一条命令。
///   cmd       : 命令名 UTF-8（如 "list" / "search" / "user"）
///   args_json : 参数对象 JSON UTF-8（可传 NULL，等同 "{}"）
/// 返回 JSON 信封，需 kuake_studio_free。命令内部错误也以 {success:false,...} 返回。
///
/// # Safety
/// cmd / args_json 必须是 NULL 或指向合法的、以 NUL 结尾的 UTF-8 C 字符串。
#[no_mangle]
pub unsafe extern "C" fn kuake_studio_call(
    cmd: *const c_char,
    args_json: *const c_char,
) -> *mut c_char {
    let s = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let Some(cmd) = (unsafe { input(cmd) }) else {
            return failure("INVALID_ARG", "cmd 为空或非法 UTF-8");
        };
        let raw = (unsafe { input(args_json) }).unwrap_or("{}");
        let args: serde_json::Value = match serde_json::from_str(raw) {
            Ok(v) => v,
            Err(e) => return failure("INVALID_ARG", &format!("args_json 不是合法 JSON: {e}")),
        };
        crate::call(cmd, &args).to_string()
    }))
    .unwrap_or_else(|_| failure("PANIC", "call 内部错误（panic 已拦截）"));
    alloc(s)
}

/// 释放 kuake_studio_boot / _schemas / _call 返回的字符串。
/// 只能传本库返回的指针；传 NULL 是安全的空操作。
///
/// # Safety
/// p 必须是 NULL，或是本库 kuake_studio_boot / _schemas / _call 返回的、
/// 尚未被释放过的指针。传其它指针或重复释放是未定义行为。
#[no_mangle]
pub unsafe extern "C" fn kuake_studio_free(p: *mut c_char) {
    if !p.is_null() {
        drop(CString::from_raw(p));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CStr;

    unsafe fn take(p: *mut c_char) -> String {
        assert!(!p.is_null());
        let s = CStr::from_ptr(p).to_str().unwrap().to_string();
        kuake_studio_free(p);
        s
    }

    #[test]
    fn version_is_static_and_readable() {
        let p = kuake_studio_version();
        let s = unsafe { CStr::from_ptr(p) }.to_str().unwrap();
        assert_eq!(s, env!("CARGO_PKG_VERSION"));
        // 不 free：静态缓冲
    }

    #[test]
    fn boot_is_in_process_and_has_no_secret() {
        let s = unsafe { take(kuake_studio_boot()) };
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["name"], "kuake-studio");
        assert_eq!(v["mode"], "in-process");
        assert_eq!(v["backend"], "native");
        assert!(v.get("token").is_none());
        assert!(!s.contains("KUAKE_COOKIE"));
    }

    #[test]
    fn schemas_exposes_all_commands() {
        let s = unsafe { take(kuake_studio_schemas()) };
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v.as_array().unwrap().len(), 19);
    }

    #[test]
    fn null_args_and_bad_cmd_never_panic() {
        let c = CString::new("__no_such__").unwrap();
        let s = unsafe { take(kuake_studio_call(c.as_ptr(), std::ptr::null())) };
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["success"], false);
        assert_eq!(v["code"], "INVALID_ARG");
    }

    #[test]
    fn free_null_is_a_noop() {
        unsafe { kuake_studio_free(std::ptr::null_mut()) };
    }
}
