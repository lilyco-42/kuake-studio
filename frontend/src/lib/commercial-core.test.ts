import { describe, expect, test } from "bun:test";

import {
  OFFLINE_SNAPSHOT,
  contactLines,
  dayKey,
  looksLikeLicenseToken,
  normalizeSnapshot,
  safeExternalUrl,
  shouldShowStartup,
  visibleAdSlots,
  type CommercialSnapshot,
} from "@/lib/commercial-core";

function snap(patch: Record<string, unknown> = {}): CommercialSnapshot {
  return normalizeSnapshot({
    ...OFFLINE_SNAPSHOT,
    config: {
      ...OFFLINE_SNAPSHOT.config,
      startup: { ...OFFLINE_SNAPSHOT.config.startup, enabled: true },
      ad: {
        ...OFFLINE_SNAPSHOT.config.ad,
        enabled: true,
        slots: [
          { id: "startup", kind: "placeholder", label: "启动页广告位" },
          { id: "about", kind: "placeholder", label: "关于页广告位" },
        ],
      },
      ...patch,
    },
  });
}

describe("离线兜底快照", () => {
  test("含微信 / QQ / B 站联系方式与两张同源赞助图", () => {
    expect(OFFLINE_SNAPSHOT.config.contact.wechat).toBe("lilyco42");
    expect(OFFLINE_SNAPSHOT.config.contact.qq).toBe("1957374829");
    expect(OFFLINE_SNAPSHOT.config.contact.bilibili.startsWith("https://")).toBe(true);
    expect(OFFLINE_SNAPSHOT.config.sponsor.links).toHaveLength(2);
    for (const l of OFFLINE_SNAPSHOT.config.sponsor.links) {
      expect(l.image.startsWith("/assets/sponsor/")).toBe(true);
    }
  });

  test("兜底状态一律不弹、不广告、不联网", () => {
    expect(OFFLINE_SNAPSHOT.config.startup.enabled).toBe(false);
    expect(OFFLINE_SNAPSHOT.config.ad.enabled).toBe(false);
    expect(OFFLINE_SNAPSHOT.config.cloud.enabled).toBe(false);
    expect(OFFLINE_SNAPSHOT.sponsored).toBe(false);
  });

  test("许可证口径写明禁止二次贩卖与作者授权", () => {
    expect(OFFLINE_SNAPSHOT.config.legal.summary).toContain("禁止二次贩卖");
    expect(OFFLINE_SNAPSHOT.config.legal.summary).toContain("lilyco");
  });
});

describe("启动弹窗节奏", () => {
  test("每天最多一次（同一天不再弹，隔天再弹）", () => {
    const s = snap();
    const day1 = new Date(2026, 10, 15, 9, 0, 0).getTime();
    const day1Later = new Date(2026, 10, 15, 21, 0, 0).getTime();
    const day2 = new Date(2026, 10, 16, 8, 0, 0).getTime();
    expect(shouldShowStartup(s, day1, null)).toBe(true);
    expect(shouldShowStartup(s, day1Later, day1)).toBe(false);
    expect(shouldShowStartup(s, day2, day1)).toBe(true);
  });

  test("赞助者 / 已点不再显示 / 后端关闭时都不弹", () => {
    const s = snap();
    const now = Date.now();
    expect(shouldShowStartup(s, now, null, true)).toBe(false);
    expect(shouldShowStartup({ ...s, sponsored: true }, now, null)).toBe(false);
    expect(shouldShowStartup({ ...s, status: { ...s.status, sponsored: true } }, now, null)).toBe(false);
    const off = snap({ startup: { ...OFFLINE_SNAPSHOT.config.startup, enabled: false } });
    expect(shouldShowStartup(off, now, null)).toBe(false);
  });

  test("daily_once=false 时每次启动都弹", () => {
    const s = snap({ startup: { ...OFFLINE_SNAPSHOT.config.startup, enabled: true, daily_once: false } });
    const now = Date.now();
    expect(shouldShowStartup(s, now, now)).toBe(true);
  });

  test("dayKey 按本地时区补零", () => {
    expect(dayKey(new Date(2026, 0, 3, 23, 59).getTime())).toBe("2026-01-03");
  });
});

describe("广告位与赞助解锁", () => {
  test("开启时按 slotId 过滤", () => {
    const s = snap();
    expect(visibleAdSlots(s)).toHaveLength(2);
    expect(visibleAdSlots(s, "about").map((x) => x.id)).toEqual(["about"]);
    expect(visibleAdSlots(s, "nope")).toEqual([]);
  });

  test("赞助后一个广告位都不给", () => {
    const s = snap();
    expect(visibleAdSlots({ ...s, sponsored: true })).toEqual([]);
    expect(visibleAdSlots({ ...s, status: { ...s.status, sponsored: true } })).toEqual([]);
  });
});

describe("链接与授权码输入", () => {
  test("联系方式含微信 / QQ / B 站 / 作者", () => {
    const lines = contactLines(OFFLINE_SNAPSHOT.config.contact);
    expect(lines.map((l) => l.label)).toEqual(["微信", "QQ", "作者", "B 站"]);
    expect(lines.find((l) => l.href)?.href?.startsWith("https://")).toBe(true);
  });

  test("外链只放行 https 与本机回环", () => {
    expect(safeExternalUrl("https://space.bilibili.com/")).toBe("https://space.bilibili.com/");
    expect(safeExternalUrl("http://127.0.0.1:8787/x")).toBe("http://127.0.0.1:8787/x");
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("data:text/html,x")).toBeNull();
    expect(safeExternalUrl("http://evil.example/x")).toBeNull();
    expect(safeExternalUrl(null)).toBeNull();
  });

  test("授权码形状：两段 base64url，拒绝明显手滑", () => {
    const p = "A".repeat(40);
    const sig = "B".repeat(86);
    expect(looksLikeLicenseToken(p + "." + sig)).toBe(true);
    expect(looksLikeLicenseToken("not-a-license")).toBe(false);
    expect(looksLikeLicenseToken(p + "." + sig + ".extra")).toBe(false);
  });
});

describe("normalizeSnapshot 收敛后端脏数据", () => {
  test("非对象 / 缺 config 一律退回兜底", () => {
    expect(normalizeSnapshot(null)).toBe(OFFLINE_SNAPSHOT);
    expect(normalizeSnapshot("x")).toBe(OFFLINE_SNAPSHOT);
    expect(normalizeSnapshot({})).toBe(OFFLINE_SNAPSHOT);
  });

  test("部分字段缺失时补默认值，不丢赞助图", () => {
    const v = normalizeSnapshot({
      config: { contact: { wechat: "someone-else" }, startup: { enabled: true } },
      sponsored: true,
    });
    expect(v.config.contact.wechat).toBe("someone-else");
    expect(v.config.contact.qq).toBe("1957374829");
    expect(v.config.sponsor.links).toHaveLength(2);
    expect(v.config.startup.daily_once).toBe(true);
    expect(v.sponsored).toBe(true);
  });

  test("status.sponsored 也能推断 sponsored", () => {
    const v = normalizeSnapshot({
      config: { ...OFFLINE_SNAPSHOT.config },
      status: { ...OFFLINE_SNAPSHOT.status, sponsored: true },
    });
    expect(v.sponsored).toBe(true);
  });
});
