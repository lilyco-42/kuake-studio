import { describe, expect, test } from "bun:test";

import { interpolate, lookup } from "@/lib/i18n-core";

describe("interpolate", () => {
  test("替换单个与多个占位", () => {
    expect(interpolate("{n} 个命令", { n: 25 })).toBe("25 个命令");
    expect(interpolate("{a}-{b}", { a: 1, b: "x" })).toBe("1-x");
  });

  test("未提供 / 无占位时原样返回，空模板用 fallback", () => {
    expect(interpolate("{n} commands")).toBe("{n} commands");
    expect(interpolate("plain", { n: 1 })).toBe("plain");
    expect(interpolate("", undefined, "fallback")).toBe("fallback");
  });
});

describe("lookup", () => {
  const zh = { a: "中文", onlyZh: "仅中文" };
  const en = { a: "English" };
  test("当前语言优先，缺 key 回退中文，再缺返回 key", () => {
    expect(lookup(en, zh, "a")).toBe("English");
    expect(lookup(en, zh, "onlyZh")).toBe("仅中文");
    expect(lookup(en, zh, "missing")).toBe("missing");
  });
});
