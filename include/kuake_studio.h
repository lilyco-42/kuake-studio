/*
 * kuake-studio —— 移动 / 鸿蒙进程内 C ABI
 *
 * 适用于 Android (JNI/NDK, aarch64-linux-android)、iOS (Swift, aarch64-apple-ios)、
 * 鸿蒙 / OpenHarmony (NAPI/ArkTS, aarch64-unknown-linux-ohos) 的原生层。
 *
 * 注意：这不是一个能直接安装的 App，也不启动本机 HTTP 服务、不打开外部浏览器。
 * 宿主 App 自己用 WebView 渲染前端 dist、自己管凭据（启动后先调
 * kuake_studio_set_cookie 注入，本库绝不读本机 .env 去覆盖宿主凭据），本库只提供：
 *   - 版本 / 启动信息 / 全部命令 schema
 *   - 同步执行一条命令（复用桌面端同一份 lilyco Registry）
 *
 * 桌面三平台（Windows / Linux / macOS）不用这个头，走安装包里的 axum Web 宿主。
 *
 * 内存约定：
 *   - kuake_studio_version() 返回静态缓冲，永不释放，禁止传给 kuake_studio_free
 *   - 其余返回 char* 的函数都必须用 kuake_studio_free() 释放
 *   - 所有字符串均为 UTF-8；传 NULL 是安全的（args_json 为 NULL 等同 "{}"）
 *   - 任何 panic 都在库内被 catch_unwind 拦下，转成 {success:false,...} 信封
 */
#ifndef KUAKE_STUDIO_H
#define KUAKE_STUDIO_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* 库版本，如 "0.5.0"。静态缓冲：勿 free。 */
const char *kuake_studio_version(void);

/* 启动信息 JSON：{name,version,backend,mode,os,arch}，mode 恒为 "in-process"。
 * 不含 token / cookie。返回值需 kuake_studio_free。 */
char *kuake_studio_boot(void);

/* 全部命令 schema 的 JSON 数组（宿主据此渲染表单 / 校验参数）。返回值需 free。 */
char *kuake_studio_schemas(void);

/* 设置夸克登录凭据（写进程环境 KUAKE_COOKIE）。返回 0 成功，1 表示空/非法参数。
 * 建议启动时调用一次，之后不要并发改写。 */
int32_t kuake_studio_set_cookie(const char *cookie);

/* 同步执行一条命令。
 *   cmd       : 命令名 UTF-8，如 "list" / "search" / "user"
 *   args_json : 参数对象 JSON UTF-8；NULL 等同 "{}"
 * 返回 JSON 信封（含 {success:false,code,message,data:null} 错误信封），需 free。 */
char *kuake_studio_call(const char *cmd, const char *args_json);

/* 释放本库返回的 char*；传 NULL 是空操作。只能传本库返回的指针。 */
void kuake_studio_free(char *p);

#ifdef __cplusplus
}
#endif

#endif /* KUAKE_STUDIO_H */
