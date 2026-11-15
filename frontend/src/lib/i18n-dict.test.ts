import { describe, expect, test } from "bun:test";

import { ROWS, zh, en } from "@/lib/i18n-dict";
import { interpolate, lookup } from "@/lib/i18n-core";
import { relativeTime, splitPath } from "@/lib/format";

const placeholders = (s: string) => (s.match(/\{[a-zA-Z]+\}/g) ?? []).sort().join(",");

describe("i18n 字典（单一数据源）", () => {
  test("键唯一，且 zh / en 键集完全一致", () => {
    expect(new Set(ROWS.map((r) => r[0])).size).toBe(ROWS.length);
    expect(Object.keys(en).sort().join("|")).toBe(Object.keys(zh).sort().join("|"));
    expect(ROWS.length).toBeGreaterThanOrEqual(220);
  });

  test("每个值非空，英文不得夹带中文", () => {
    expect(ROWS.filter(([, z, e]) => !z || !e).length).toBe(0);
    expect(ROWS.filter(([, , e]) => /[\u4e00-\u9fff]/.test(e)).length).toBe(0);
  });

  test("中英文占位符必须一一对应", () => {
    const bad = ROWS.filter(([, z, e]) => placeholders(z) !== placeholders(e));
    expect(bad.map((r) => r[0]).join(",")).toBe("");
  });

  test("五个业务视图的关键键都在", () => {
    const keys = [
      "files.newFolder", "files.confirmBatchDelete", "search.noMatch",
      "shares.confirmRevoke", "recycle.confirmPurge", "account.qrLogin",
      "common.retry", "op.list", "search.page",
    ];
    expect(keys.filter((k) => !zh[k] || !en[k]).join(",")).toBe("");
  });
});

describe("插值与回退", () => {
  test("中英文都能替换占位符", () => {
    expect(interpolate(zh["search.noMatch"], { term: "README" })).toBe("没有匹配「README」的文件");
    expect(interpolate(en["recycle.count"], { n: 3 })).toBe("3 items");
    expect(interpolate(en["files.countDirs"], { n: 0 })).toBe("0 folders");
  });

  test("en 缺 key 回退中文，再缺返回 key", () => {
    expect(lookup({ a: "A" }, zh, "a")).toBe("A");
    expect(lookup({}, zh, "nav.files")).toBe("文件");
    expect(lookup({}, zh, "nonexistent.key")).toBe("nonexistent.key");
  });
});

describe("format.ts 也随语言切换", () => {
  test("相对时间", () => {
    const now = Date.now();
    expect(relativeTime(now - 2 * 60_000, "zh-CN")).toBe("2 分钟前");
    expect(relativeTime(now - 2 * 60_000, "en")).toBe("2 min ago");
    expect(relativeTime(now - 3 * 3_600_000, "en")).toBe("3 h ago");
    expect(relativeTime(0)).toBe("—");
  });

  test("面包屑根节点", () => {
    expect(splitPath("/")[0].label).toBe("根目录");
    expect(splitPath("/", "en")[0].label).toBe("Root");
    expect(splitPath("/a/b", "en").map((c) => c.path).join(",")).toBe("/,/a,/a/b");
  });
});
