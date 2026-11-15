/** 语言标识。零依赖，供纯函数（format.ts）与 React provider 共用。 */
export type Lang = "zh-CN" | "en";

/** i18n 插值：把 {key} 替换掉；未提供的占位保持原样。零依赖，便于 bun test。 */
export function interpolate(
  template: string,
  vars?: Record<string, string | number>,
  fallback?: string,
): string {
  let s = template || fallback || "";
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split("{" + k + "}").join(String(v));
    }
  }
  return s;
}

/** 字典缺 key 时的回退顺序：当前语言 → 中文 → key 本身。 */
export function lookup(
  dict: Record<string, string>,
  fallback: Record<string, string>,
  key: string,
): string {
  return dict[key] ?? fallback[key] ?? key;
}
