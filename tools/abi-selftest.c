/*
 * kuake-studio 进程内 C ABI 自检（host 架构可跑）。
 *
 * 编译（Linux）：
 *   cargo build --locked --no-default-features --lib
 *   cc -std=c11 -Wall -Wextra -I include -o /tmp/ks-abi \
 *      tools/abi-selftest.c target/debug/libkuake_studio.a -lpthread -ldl -lm
 *   /tmp/ks-abi
 *
 * 故意不写死版本号：version() / boot.version / call(version) 三处互相对照，
 * 升版本时这个自检不用改。dummy cookie 只为让 Api::new() 能构造，不发网络请求。
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "kuake_studio.h"

static int fails = 0;

static void check(int cond, const char *what) {
    printf("[%s] %s\n", cond ? "PASS" : "FAIL", what);
    if (!cond) fails++;
}

static int contains(const char *hay, const char *needle) {
    return hay && strstr(hay, needle) != NULL;
}

int main(void) {
    const char *ver = kuake_studio_version();          /* 静态缓冲，勿 free */
    printf("version = %s\n", ver ? ver : "(null)");
    check(ver != NULL && strlen(ver) > 0, "version() 返回非空版本");

    char *boot = kuake_studio_boot();
    printf("boot    = %s\n", boot ? boot : "(null)");
    check(contains(boot, "\"mode\":\"in-process\""), "boot.mode = in-process");
    check(contains(boot, "\"backend\":\"native\""), "boot.backend = native");
    check(ver && contains(boot, ver), "boot.version 与 version() 一致");
    check(!contains(boot, "token") && !contains(boot, "KUAKE_COOKIE"), "boot 无 token/cookie");
    kuake_studio_free(boot);

    char *schemas = kuake_studio_schemas();
    printf("schemas = %zu bytes\n", schemas ? strlen(schemas) : 0);
    check(schemas && schemas[0] == '[', "schemas() 是 JSON 数组");
    check(contains(schemas, "\"name\":\"search\""), "schemas 含全盘 search 命令");
    kuake_studio_free(schemas);

    /* dummy 凭据：Api::new() 只要非空 cookie 就能构造，version 命令不发网络请求 */
    int rc = kuake_studio_set_cookie("offline-abi-selftest");
    printf("set_cookie = %d\n", rc);
    check(rc == 0, "set_cookie 成功");
    check(kuake_studio_set_cookie(NULL) == 1, "set_cookie(NULL) 返回 1");

    char *v = kuake_studio_call("version", "{}");
    printf("call(version) = %s\n", v ? v : "(null)");
    check(contains(v, "\"success\":true"), "call(version) 走通 Registry 且成功");
    check(ver && contains(v, "native ") && contains(v, ver), "call(version) 返回原生后端版本");
    kuake_studio_free(v);

    char *bad = kuake_studio_call("__no_such__", NULL);   /* args_json NULL 等同 "{}" */
    printf("call(unknown) = %s\n", bad ? bad : "(null)");
    check(contains(bad, "\"success\":false"), "未知命令返回失败信封");
    check(contains(bad, "INVALID_ARG"), "未知命令错误码 INVALID_ARG");
    kuake_studio_free(bad);

    char *junk = kuake_studio_call("user", "{not json");
    printf("call(bad json) = %s\n", junk ? junk : "(null)");
    check(contains(junk, "args_json 不是合法 JSON"), "非法 JSON 被拦下且不 panic");
    kuake_studio_free(junk);

    kuake_studio_free(NULL);                              /* NULL 是空操作 */
    printf("\n%s (%d failures)\n", fails == 0 ? "ABI SELFTEST OK" : "ABI SELFTEST FAILED", fails);
    return fails == 0 ? 0 : 1;
}
