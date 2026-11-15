/**
 * 商业化配置的纯逻辑：零依赖、零 DOM，可在 bun test / Node 里直接跑。
 * 与后端 src/commercial.rs::default_config() 的字段一一对应。
 */

export interface SponsorLink {
  id: string;
  name: string;
  image: string;
  note?: string;
  qr_url?: string;
}

export interface AdSlot {
  id: string;
  kind: string;
  label: string;
}

export interface Contact {
  wechat: string;
  qq: string;
  bilibili: string;
  bilibili_label: string;
  author: string;
}

export interface CommercialConfig {
  project: string;
  version: string;
  contact: Contact;
  sponsor: {
    title: string;
    intro: string;
    shared_repo: string;
    links: SponsorLink[];
    benefits: { title: string; fame: string; profit: string; choose_one: string };
  };
  startup: {
    enabled: boolean;
    daily_once: boolean;
    delay_ms: number;
    title: string;
    notice: string;
  };
  ad: { enabled: boolean; label: string; note: string; slots: AdSlot[] };
  cloud: {
    enabled: boolean;
    url: string;
    refresh_interval_sec: number;
    last_refresh: number | null;
    last_error: string | null;
  };
  license: { scheme: string; token_format: string; tiers: string[]; storage: string };
  legal: { edition: string; summary: string; license_file: string };
}

export interface LicenseClaims {
  sub: string;
  sponsor: boolean;
  tier: "fame" | "profit";
  iat?: number | null;
  exp?: number | null;
  note?: string | null;
}

export interface CommercialStatus {
  sponsored: boolean;
  claims: LicenseClaims | null;
  license_path: string;
  license_file_exists: boolean;
}

export interface CommercialSnapshot {
  config: CommercialConfig;
  status: CommercialStatus;
  sponsored: boolean;
}

/** 后端失联 / 旧版后端时的兜底：只保证联系方式与同源图片仍可见，其余全部关闭。 */
export const OFFLINE_SNAPSHOT: CommercialSnapshot = {
  config: {
    project: "kuake-studio",
    version: "",
    contact: {
      wechat: "lilyco42",
      qq: "1957374829",
      bilibili: "https://space.bilibili.com/",
      bilibili_label: "B 站：lilyco42",
      author: "lilyco",
    },
    sponsor: {
      title: "支持 Kuake Studio",
      intro: "软件源码可见、个人使用免费。若它帮到了你，可以请作者喝杯咖啡。",
      shared_repo: "https://github.com/lilyco-42/shared/tree/master/sponsor/assets",
      links: [
        {
          id: "wechat-pay",
          name: "微信支付赞赏",
          image: "/assets/sponsor/wechat-pay.png",
          note: "微信扫一扫 · 赞赏码",
          qr_url: "https://payapp.wechatpay.cn/sjt/qr/AQHyNye4l1nMR5C6F3u2jDKI",
        },
        {
          id: "wechat-contact",
          name: "加微信 / 交流群",
          image: "/assets/sponsor/wechat-contact.png",
          note: "微信扫一扫 · 联系作者与商用授权咨询",
          qr_url: "https://u.wechat.com/MPaHAJWSVNSS_V5ATLhiiao?s=4",
        },
      ],
      benefits: {
        title: "名利选其一",
        fame: "名誉：在关于页与 README 的赞助者名单中署名（可附链接）",
        profit: "利益：获得商用授权咨询资格，付费后可去除启动提示与广告位",
        choose_one: "同一笔赞助在「署名」与「商用权益」中二选一，作者按你的选择登记。",
      },
    },
    startup: {
      enabled: false,
      daily_once: true,
      delay_ms: 0,
      title: "欢迎使用 Kuake Studio",
      notice: "",
    },
    ad: { enabled: false, label: "广告位（云端可配置）", note: "", slots: [] },
    cloud: {
      enabled: false,
      url: "",
      refresh_interval_sec: 3600,
      last_refresh: null,
      last_error: null,
    },
    license: { scheme: "ed25519", token_format: "", tiers: ["fame", "profit"], storage: "" },
    legal: {
      edition: "开源版（源码可见）",
      summary: "个人可自由使用与修改；禁止二次贩卖／转售；商用须获得作者 lilyco 的授权。",
      license_file: "LICENSE",
    },
  },
  status: {
    sponsored: false,
    claims: null,
    license_path: "",
    license_file_exists: false,
  },
  sponsored: false,
};

/** 本地日期键（YYYY-MM-DD，按本机时区）；赞助弹窗「每天一次」用它比较。 */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

/**
 * 是否弹启动窗：只由后端配置 + 授权状态决定，前端不自己发明规则。
 * lastShownAt=null（没记录过）时视为可弹；daily_once=false 时每次启动都弹。
 */
export function shouldShowStartup(
  snapshot: CommercialSnapshot,
  now: number,
  lastShownAt: number | null,
  dismissed = false,
): boolean {
  if (dismissed) return false;
  if (snapshot.sponsored || snapshot.status.sponsored) return false;
  const s = snapshot.config.startup;
  if (!s.enabled) return false;
  if (!s.daily_once) return true;
  return lastShownAt === null || dayKey(lastShownAt) !== dayKey(now);
}

/** 赞助者 / 未开启时一律不渲染广告位；slotId 为空则取全部。 */
export function visibleAdSlots(snapshot: CommercialSnapshot, slotId?: string): AdSlot[] {
  if (snapshot.sponsored || snapshot.status.sponsored || !snapshot.config.ad.enabled) return [];
  const slots = Array.isArray(snapshot.config.ad.slots) ? snapshot.config.ad.slots : [];
  return slots.filter((s) => !slotId || s.id === slotId);
}

export interface ContactLine {
  label: string;
  value: string;
  href?: string;
}

/** 联系方式统一出口：外部链接只允许 https，杜绝 javascript: / data: 注入。 */
export function contactLines(contact: Contact): ContactLine[] {
  const lines: ContactLine[] = [
    { label: "微信", value: contact.wechat },
    { label: "QQ", value: contact.qq },
    { label: "作者", value: contact.author },
  ];
  const b = contact.bilibili;
  if (b) lines.push({ label: "B 站", value: contact.bilibili_label || b, href: b });
  return lines;
}

/** 只放行 https 外链（以及本机回环 http）；用于赞助链接 / 云端地址展示。 */
export function safeExternalUrl(raw: string | undefined | null): string | null {
  const s = (raw ?? "").trim();
  if (s.startsWith("https://")) return s;
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(s)) return s;
  return null;
}

/** 授权码基本形状检查：两段 base64url，避免把明显的手滑输入发给后端。 */
export function looksLikeLicenseToken(raw: string): boolean {
  return /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{80,90}$/.test(raw.trim());
}

/** 把后端返回的任意 JSON 收敛成快照；字段缺失时退回 OFFLINE_SNAPSHOT 的对应块。 */
export function normalizeSnapshot(raw: unknown): CommercialSnapshot {
  if (!raw || typeof raw !== "object") return OFFLINE_SNAPSHOT;
  const v = raw as Partial<CommercialSnapshot>;
  if (!v.config || typeof v.config !== "object") return OFFLINE_SNAPSHOT;
  const base = OFFLINE_SNAPSHOT;
  const c = v.config as Partial<CommercialConfig>;
  return {
    config: {
      ...base.config,
      ...c,
      contact: { ...base.config.contact, ...(c.contact ?? {}) },
      sponsor: {
        ...base.config.sponsor,
        ...(c.sponsor ?? {}),
        links: Array.isArray(c.sponsor?.links) ? c.sponsor.links : base.config.sponsor.links,
        benefits: { ...base.config.sponsor.benefits, ...(c.sponsor?.benefits ?? {}) },
      },
      startup: { ...base.config.startup, ...(c.startup ?? {}) },
      ad: {
        ...base.config.ad,
        ...(c.ad ?? {}),
        slots: Array.isArray(c.ad?.slots) ? c.ad.slots : [],
      },
      cloud: { ...base.config.cloud, ...(c.cloud ?? {}) },
      license: { ...base.config.license, ...(c.license ?? {}) },
      legal: { ...base.config.legal, ...(c.legal ?? {}) },
    },
    status: { ...base.status, ...(v.status ?? {}) },
    sponsored: Boolean(v.sponsored ?? v.status?.sponsored ?? false),
  };
}
