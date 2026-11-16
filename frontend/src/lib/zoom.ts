const KEY = "kuake.zoom";
const MIN = 0.8;
const MAX = 1.6;
export const ZOOM_STEP = 0.1;

export function clampZoom(scale: number): number {
  const bounded = Math.min(MAX, Math.max(MIN, scale));
  return Math.round(bounded * 100) / 100;
}

export function readZoom(): number {
  try {
    return clampZoom(Number(localStorage.getItem(KEY)));
  } catch {
    return 1;
  }
}

/** 缩放整个界面：Tailwind 的字号都是 rem，改根字号即可整体放大/缩小。 */
export function applyZoom(scale: number): number {
  const next = clampZoom(scale);
  document.documentElement.style.fontSize = `${16 * next}px`;
  try {
    localStorage.setItem(KEY, String(next));
  } catch {
    // 隐私模式写不了 localStorage 也不影响本次缩放
  }
  return next;
}

export function resetZoom(): number {
  return applyZoom(1);
}