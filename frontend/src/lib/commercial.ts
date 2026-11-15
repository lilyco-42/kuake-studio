import { getToken } from "@/lib/api";
import { OFFLINE_SNAPSHOT, normalizeSnapshot, type CommercialSnapshot } from "@/lib/commercial-core";

export * from "@/lib/commercial-core";

function postHeaders(): HeadersInit {
  return { "Content-Type": "application/json", "X-Kuake-Token": getToken() };
}

/** 启动握手后拉一次商业化快照；后端是旧版或网络出错时静默退回离线兜底。 */
export async function fetchCommercial(enabled: boolean): Promise<CommercialSnapshot> {
  if (!enabled) return OFFLINE_SNAPSHOT_FALLBACK();
  try {
    const res = await fetch("/api/commercial/config", { cache: "no-store" });
    if (!res.ok) return OFFLINE_SNAPSHOT_FALLBACK();
    return normalizeSnapshot(await res.json());
  } catch {
    return OFFLINE_SNAPSHOT_FALLBACK();
  }
}

// 单独包一层，避免 import 循环里把常量当函数调用
function OFFLINE_SNAPSHOT_FALLBACK(): CommercialSnapshot {
  return OFFLINE_SNAPSHOT;
}

export async function activateLicense(token: string): Promise<CommercialSnapshot> {
  const res = await fetch("/api/commercial/activate", {
    method: "POST",
    headers: postHeaders(),
    body: JSON.stringify({ token: token.trim() }),
  });
  if (!res.ok) throw new Error((await res.text()) || ("激活失败 (" + res.status + ")"));
  return normalizeSnapshot(await res.json());
}

export async function deactivateLicense(): Promise<CommercialSnapshot> {
  const res = await fetch("/api/commercial/deactivate", {
    method: "POST",
    headers: postHeaders(),
    body: "{}",
  });
  if (!res.ok) throw new Error((await res.text()) || ("取消失败 (" + res.status + ")"));
  return normalizeSnapshot(await res.json());
}

export async function refreshCloudConfig(): Promise<CommercialSnapshot> {
  const res = await fetch("/api/commercial/refresh", {
    method: "POST",
    headers: postHeaders(),
    body: "{}",
  });
  if (!res.ok) throw new Error((await res.text()) || ("刷新失败 (" + res.status + ")"));
  return normalizeSnapshot(await res.json());
}

export const STARTUP_SHOWN_KEY = "kuake-studio:commercial:startup:last";
export const STARTUP_DISMISSED_KEY = "kuake-studio:commercial:startup:dismissed";

export function readStartupState(): { lastShownAt: number | null; dismissed: boolean } {
  try {
    const raw = localStorage.getItem(STARTUP_SHOWN_KEY);
    const n = raw === null ? null : Number(raw);
    return {
      lastShownAt: n !== null && Number.isFinite(n) && n > 0 ? n : null,
      dismissed: localStorage.getItem(STARTUP_DISMISSED_KEY) === "1",
    };
  } catch {
    return { lastShownAt: null, dismissed: false };
  }
}

export function markStartupShown(): void {
  try {
    localStorage.setItem(STARTUP_SHOWN_KEY, String(Date.now()));
  } catch {
    /* 隐私模式下 localStorage 可能不可写，忽略 */
  }
}

export function markStartupDismissed(): void {
  try {
    localStorage.setItem(STARTUP_DISMISSED_KEY, "1");
    markStartupShown();
  } catch {
    /* 同上 */
  }
}
