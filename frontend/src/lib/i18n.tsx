import * as React from "react";

import { interpolate, lookup, type Lang } from "@/lib/i18n-core";
import { zh, en } from "@/lib/i18n-dict";

export type { Lang };

/**
 * 轻量 i18n：不引第三方库、不改 bun.lock。
 * 字典单一数据源见 lib/i18n-dict.ts（每行 [key, 中文, English]）；
 * 五个业务视图（文件/搜索/分享/回收站/账号）与 App 外壳均已覆盖。
 * 缺 key 时 t() 回退中文，再缺则原样返回 key。
 */
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
    (key: string, vars?: Record<string, string | number>) =>
      interpolate(lookup(DICT[lang], zh, key), vars),
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
