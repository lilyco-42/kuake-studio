import * as React from "react";

import { interpolate, lookup } from "@/lib/i18n-core";

/**
 * 轻量 i18n：不引第三方库、不改 bun.lock。
 * 首轮覆盖 App 外壳、启动赞助窗、关于/赞助页与授权框；业务视图（文件/搜索/分享/
 * 回收站）仍为中文，迁移进度见 docs/DEVELOPMENT-STANDARDS.md。
 * 新增文案请同时补 zh 与 en 两个字典，缺 key 时 t() 会回退中文并原样返回 key。
 */
export type Lang = "zh-CN" | "en";

const zh: Record<string, string> = {
  "nav.files": "文件",
  "nav.search": "搜索",
  "nav.shares": "分享",
  "nav.recycle": "回收站",
  "nav.account": "账号",
  "nav.about": "关于 / 赞助",
  "brand.subtitle": "lilyco + shadcn",
  "header.commands": "{n} 个命令",
  "header.connected": "已连接",
  "header.connecting": "正在握手…",
  "theme.toggle": "切换明暗主题",
  "theme.toLight": "亮色",
  "theme.toDark": "暗色",
  "lang.toggle": "切换语言 / Switch language",
  "lang.name": "中文",
  "boot.title": "无法连接本地后端",
  "boot.hint1": "确认后端进程仍在运行（终端里没有报错退出）",
  "boot.hint2": "确认浏览器地址是 http://127.0.0.1 上的端口，不是别的域名",
  "boot.hint3": "确认 KUAKE_COOKIE 有效，必要时重启程序",
  "boot.reload": "重新加载",
  "cap.searchNative": "搜索仅在内置原生后端可用",
  "cap.recycleNative": "回收站仅在内置原生后端可用",
  "startup.title": "欢迎使用 Kuake Studio",
  "startup.intro": "软件源码可见、个人使用免费。若它帮到了你，可以请作者喝杯咖啡。",
  "startup.contact": "联系作者",
  "startup.sponsorTitle": "支持 Kuake Studio",
  "startup.benefits": "名利选其一",
  "startup.edition": "开源版（源码可见）",
  "startup.noMore": "不再显示",
  "startup.about": "关于 / 赞助",
  "startup.start": "开始使用",
  "startup.sponsorHint": "微信扫一扫 · 赞赏码",
  "startup.contactHint": "微信扫一扫 · 联系作者与商用授权咨询",
  "startup.pay": "微信支付赞赏",
  "startup.contactQr": "加微信 / 交流群",
  "license.title": "已有赞助授权码？",
  "license.placeholder": "粘贴作者签发的授权码（离线校验）",
  "license.activate": "激活",
  "license.activated": "已激活赞助授权",
  "license.sponsor": "赞助者",
  "license.tierFame": "名誉",
  "license.tierProfit": "利益",
  "license.activeHint": "启动提示与广告位已关闭。授权在本机离线校验，不联网。",
  "license.remove": "移除本机授权",
  "license.hint": "赞助后向作者索取；激活后不再弹启动提示与广告位。授权码只在本机验签，不会外传。",
  "license.badFormat": "授权码格式不对，应为两段以 . 分隔的 base64url 字符串",
  "license.success": "赞助授权已生效，启动提示与广告位已关闭",
  "license.removed": "已移除本机授权",
  "ad.label": "广告位",
  "about.title": "关于 Kuake Studio",
  "about.subtitle": "lilyco 框架 + shadcn/ui · 六平台同一个内核",
  "about.contact": "联系方式",
  "about.sponsor": "赞助方式",
  "about.benefits": "赞助者权益",
  "about.cloud": "云端推送（预留）",
  "about.cloudOff": "未开启。设置 KUAKE_STUDIO_CLOUD_CONFIG_URL 后由后端定时拉取白名单配置。",
  "about.cloudOn": "已开启，刷新间隔 {sec} 秒。",
  "about.cloudLast": "上次成功刷新",
  "about.cloudError": "上次错误",
  "about.refresh": "立即刷新",
  "about.refreshOk": "云端配置已刷新",
  "about.refreshFail": "刷新失败",
  "about.license": "赞助授权",
  "about.legal": "许可与商用",
  "about.version": "客户端版本",
  "about.backend": "网盘后端",
  "about.native": "内置原生 API（无需 kuake.exe）",
  "about.cli": "kuake CLI 子进程",
  "about.repo": "项目仓库",
  "about.shared": "赞助图来源（shared 仓库）",
  "about.images": "赞助二维码",
  "about.sameOrigin": "图片由同源 /assets/sponsor/ 提供，CSP 不放行任何外部域名。",
  "about.openSource": "源码可见",
  "about.commercial": "商用需作者授权",
  "legal.summaryEn": "Personal use and modification are free; resale is prohibited; commercial use requires the author lilyco's permission.",
};

const en: Record<string, string> = {
  "nav.files": "Files",
  "nav.search": "Search",
  "nav.shares": "Shares",
  "nav.recycle": "Recycle",
  "nav.account": "Account",
  "nav.about": "About / Sponsor",
  "brand.subtitle": "lilyco + shadcn",
  "header.commands": "{n} commands",
  "header.connected": "Connected",
  "header.connecting": "Handshaking…",
  "theme.toggle": "Toggle theme",
  "theme.toLight": "Light",
  "theme.toDark": "Dark",
  "lang.toggle": "Switch language / 切换语言",
  "lang.name": "English",
  "boot.title": "Cannot reach the local backend",
  "boot.hint1": "Make sure the backend process is still running (no fatal error in the terminal)",
  "boot.hint2": "Make sure the browser is on http://127.0.0.1, not another host",
  "boot.hint3": "Make sure KUAKE_COOKIE is valid; restart if needed",
  "boot.reload": "Reload",
  "cap.searchNative": "Search is available only with the built-in native backend",
  "cap.recycleNative": "Recycle bin is available only with the built-in native backend",
  "startup.title": "Welcome to Kuake Studio",
  "startup.intro": "Source-visible and free for personal use. If it helps you, you can buy the author a coffee.",
  "startup.contact": "Contact",
  "startup.sponsorTitle": "Support Kuake Studio",
  "startup.benefits": "Choose one: fame or benefit",
  "startup.edition": "Source-visible edition",
  "startup.noMore": "Don't show again",
  "startup.about": "About / Sponsor",
  "startup.start": "Get started",
  "startup.sponsorHint": "Scan with WeChat · reward code",
  "startup.contactHint": "Scan with WeChat · contact the author / commercial licensing",
  "startup.pay": "WeChat Pay reward",
  "startup.contactQr": "Add WeChat / community",
  "license.title": "Already have a sponsor license?",
  "license.placeholder": "Paste the author-signed license (verified offline)",
  "license.activate": "Activate",
  "license.activated": "Sponsor license active",
  "license.sponsor": "Sponsor",
  "license.tierFame": "Fame",
  "license.tierProfit": "Benefit",
  "license.activeHint": "Startup prompts and ad slots are off. The license is verified locally, no network.",
  "license.remove": "Remove local license",
  "license.hint": "Ask the author after sponsoring; activating turns off startup prompts and ad slots. The code never leaves this machine.",
  "license.badFormat": "Invalid license format: expected two base64url segments separated by a dot",
  "license.success": "Sponsor license activated; prompts and ad slots are off",
  "license.removed": "Local license removed",
  "ad.label": "Ad slot",
  "about.title": "About Kuake Studio",
  "about.subtitle": "lilyco framework + shadcn/ui · one core on six platforms",
  "about.contact": "Contact",
  "about.sponsor": "Sponsor",
  "about.benefits": "Sponsor benefits",
  "about.cloud": "Cloud config (reserved)",
  "about.cloudOff": "Off. Set KUAKE_STUDIO_CLOUD_CONFIG_URL to let the backend poll a whitelisted config.",
  "about.cloudOn": "On, refreshing every {sec} seconds.",
  "about.cloudLast": "Last successful refresh",
  "about.cloudError": "Last error",
  "about.refresh": "Refresh now",
  "about.refreshOk": "Cloud config refreshed",
  "about.refreshFail": "Refresh failed",
  "about.license": "Sponsor license",
  "about.legal": "License & commercial use",
  "about.version": "Client version",
  "about.backend": "Drive backend",
  "about.native": "Built-in native API (no kuake.exe needed)",
  "about.cli": "kuake CLI subprocess",
  "about.repo": "Repository",
  "about.shared": "Sponsor images (shared repo)",
  "about.images": "Sponsor QR codes",
  "about.sameOrigin": "Images are served from same-origin /assets/sponsor/; CSP allows no external host.",
  "about.openSource": "Source-visible",
  "about.commercial": "Commercial use requires author permission",
};

const DICT: Record<Lang, Record<string, string>> = { "zh-CN": zh, en };
const KEY = "kuake-studio:lang";

interface I18nCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const Ctx = React.createContext<I18nCtx | null>(null);

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "en" || saved === "zh-CN") return saved;
  } catch {
    /* 隐私模式忽略 */
  }
  return "zh-CN";
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = React.useState<Lang>(initialLang);
  const setLang = React.useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(KEY, l);
    } catch {
      /* 忽略 */
    }
  }, []);
  const t = React.useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      return interpolate(lookup(DICT[lang], zh, key), vars);
    },
    [lang],
  );
  const value = React.useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nCtx {
  const v = React.useContext(Ctx);
  if (!v) throw new Error("useI18n must be used inside I18nProvider");
  return v;
}
