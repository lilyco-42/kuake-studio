import type { CommandSchema, KuakeEnvelope, RunEvent } from "@/lib/types";

let token = "";

/** 启动握手：令牌只在回环 + 同源下拿得到（后端不设 CORS 头） */
export async function boot(): Promise<{ token: string; name: string; version: string; kuake: string; temp?: string; backend?: "native" | "cli" }> {
  const res = await fetch("/api/boot", { cache: "no-store" });
  if (!res.ok) throw new Error(`无法连接后端 (${res.status})`);
  const data = await res.json();
  token = data.token;
  return data;
}

export function getToken() {
  return token;
}

export async function fetchSchemas(): Promise<CommandSchema[]> {
  const res = await fetch("/api/schema", { cache: "no-store" });
  if (!res.ok) throw new Error(`拉取 schema 失败 (${res.status})`);
  const json = await res.json();
  return json.commands as CommandSchema[];
}

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", "X-Kuake-Token": token };
}

/** 提交命令，拿 session id；事件流随后从 SSE 取 */
export async function startRun(cmd: string, args: Record<string, unknown>): Promise<string> {
  const res = await fetch("/api/run", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ cmd, args }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `运行失败 (${res.status})`);
  }
  const json = await res.json();
  return json.session_id as string;
}

export async function cancelRun(sid: string): Promise<void> {
  await fetch(`/api/cancel/${sid}`, { method: "POST", headers: authHeaders() });
}

/** 把 base64 内容交给后端落盘，返回本地绝对路径（供 upload 命令使用） */
export async function uploadTemp(name: string, dataB64: string): Promise<{ path: string; name: string; size: number }> {
  const res = await fetch("/api/upload", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ name, dataB64 }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/** UTF-8 字符串 → 标准 base64（HTTP 头只能放 ASCII，中文文件名必须编码后再传） */
export function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * 拖拽上传专用：把文件原始二进制直接 POST 到 /api/upload/raw。
 * 旧 uploadTemp 走 base64 JSON，受 axum 默认 2 MiB body 限制；这条路由自带 2 GiB 上限。
 * 文件名只用于生成暂存路径，网盘目标名由调用方用原始文件名单独拼。
 */
export async function uploadTempRaw(
  name: string,
  file: Blob,
  signal?: AbortSignal,
): Promise<{ path: string; name: string; size: number }> {
  const res = await fetch("/api/upload/raw", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Kuake-Token": token,
      "X-Kuake-File": base64Utf8(name),
    },
    body: file,
    signal,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/** 浏览器没有真实文件路径，只能 base64 上传到后端暂存目录 */
export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

export interface LoginStart {
  sid: string;
  qr_url: string;
  qr_data: string;
}

export interface LoginStatus {
  state: "waiting" | "success" | "failed" | "cancelled";
  message?: string | null;
  data?: {
    nickname?: string;
    cookie_len?: number;
    cookie_names?: string[];
    env_path?: string;
  };
}

/** 开一次扫码登录（受令牌保护）；二维码是 data:image/svg+xml;base64 */
export async function loginStart(): Promise<LoginStart> {
  const res = await fetch("/api/login/start", {
    method: "POST",
    headers: authHeaders(),
    body: "{}",
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function loginStatus(sid: string): Promise<LoginStatus> {
  const res = await fetch(`/api/login/status/${sid}`, { cache: "no-store" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function loginCancel(sid: string): Promise<void> {
  await fetch(`/api/login/cancel/${sid}`, {
    method: "POST",
    headers: authHeaders(),
    body: "{}",
  });
}

export interface RunHandle {
  /** 事件回调 */
  onEvent: (fn: (e: RunEvent) => void) => void;
  /** 等终态 */
  done: Promise<KuakeEnvelope | null>;
  cancel: () => Promise<void>;
  sid: string;
}

/** 订阅一次运行的事件流。EventSource 不能带自定义头 —— 后端只对 POST 验令牌，GET 只验 Host 回环。 */
export function subscribe(sid: string): RunHandle {
  const listeners: ((e: RunEvent) => void)[] = [];
  const es = new EventSource(`/api/progress/${sid}`);

  const done = new Promise<KuakeEnvelope | null>((resolve) => {
    let settled = false;
    const finish = (value: KuakeEnvelope | null) => {
      if (settled) return;
      settled = true;
      es.close();
      resolve(value);
    };
    es.onmessage = (msg) => {
      let event: RunEvent;
      try {
        event = JSON.parse(msg.data) as RunEvent;
      } catch {
        return;
      }
      listeners.forEach((fn) => fn(event));
      if (event.type === "done") {
        finish((event.result ?? null) as KuakeEnvelope | null);
      } else if (event.type === "error") {
        finish(null);
      }
    };
    es.onerror = () => {
      // 服务端流结束会触发 onerror；只要没收到终态就当作连接断开
      finish(null);
    };
  });

  return {
    sid,
    onEvent: (fn) => listeners.push(fn),
    done,
    cancel: () => cancelRun(sid),
  };
}

/** 统一解包：把 kuake 信封里的 data 取出来，失败时抛出中文原因 */
export function unwrap<T>(envelope: KuakeEnvelope<T> | null): T {
  if (!envelope) throw new Error("没有拿到返回结果");
  if (!envelope.success) throw new Error(envelope.message || envelope.code || "操作失败");
  return envelope.data;
}
