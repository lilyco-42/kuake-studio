import * as React from "react";
import { toast } from "sonner";

import { boot, fetchSchemas, startRun, subscribe } from "@/lib/api";
import type { CommandSchema, KuakeEnvelope, RunEvent } from "@/lib/types";

export interface LogLine {
  id: number;
  kind: "info" | "ok" | "err" | "tick";
  text: string;
  at: number;
}

interface BootInfo {
  name: string;
  version: string;
  kuake: string;
  /** 后端认定的临时目录（Windows 上是 %TEMP%，不是 /tmp） */
  temp: string;
  /** "native" = 内置自研夸克 API；"cli" = 回退到本机 kuake 子进程 */
  backend?: "native" | "cli";
}

interface RunnerCtx {
  booted: boolean;
  bootError: string | null;
  info: BootInfo | null;
  schemas: CommandSchema[];
  logs: LogLine[];
  busy: string | null;
  progress: number | null;
  clearLogs: () => void;
  /** 跑一条命令；成功返回 data，失败抛错（并已记进日志） */
  run: <T = unknown>(cmd: string, args: Record<string, unknown>, label?: string) => Promise<T>;
  cancel: () => Promise<void>;
}

const Ctx = React.createContext<RunnerCtx | null>(null);

let seq = 0;

export function RunnerProvider({ children }: { children: React.ReactNode }) {
  const [booted, setBooted] = React.useState(false);
  const [bootError, setBootError] = React.useState<string | null>(null);
  const [info, setInfo] = React.useState<BootInfo | null>(null);
  const [schemas, setSchemas] = React.useState<CommandSchema[]>([]);
  const [logs, setLogs] = React.useState<LogLine[]>([]);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState<number | null>(null);
  const cancelRef = React.useRef<(() => Promise<void>) | null>(null);

  const push = React.useCallback((kind: LogLine["kind"], text: string) => {
    setLogs((prev) => {
      const next = [...prev, { id: ++seq, kind, text, at: Date.now() }];
      // 日志只保留最近 500 行，避免长跑任务把内存吃满
      return next.length > 500 ? next.slice(next.length - 500) : next;
    });
  }, []);

  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const b = await boot();
        const s = await fetchSchemas();
        if (!alive) return;
        setInfo({
          name: b.name,
          version: b.version,
          kuake: b.kuake,
          temp: b.temp ?? "",
          backend: b.backend ?? "native",
        });
        setSchemas(s);
        setBooted(true);
        push(
          "info",
          b.backend === "cli"
            ? `后端就绪 · kuake CLI @ ${b.kuake}`
            : "后端就绪 · 内置原生夸克 API",
        );
      } catch (e) {
        if (!alive) return;
        const msg = e instanceof Error ? e.message : String(e);
        setBootError(msg);
        push("err", `启动握手失败: ${msg}`);
      }
    })();
    return () => {
      alive = false;
    };
  }, [push]);

  const run = React.useCallback(
    async <T,>(cmd: string, args: Record<string, unknown>, label?: string): Promise<T> => {
      const title = label ?? cmd;
      setBusy(title);
      setProgress(null);
      push("info", `▶ ${title}`);
      try {
        const sid = await startRun(cmd, args);
        const handle = subscribe(sid);
        cancelRef.current = handle.cancel;
        let final: KuakeEnvelope | null = null;
        let failure: string | null = null;

        handle.onEvent((e: RunEvent) => {
          if (e.type === "log") {
            push(e.level === "error" ? "err" : "info", e.message);
          } else if (e.type === "tick") {
            setProgress(e.percent ?? null);
            if (e.message) push("tick", e.message);
          } else if (e.type === "started" && e.message) {
            push("info", e.message);
          } else if (e.type === "telemetry") {
            {
              // 二维码 SVG / token 等大值只记 key，绝不灌进控制台日志
              if (e.key.startsWith("qr_")) {
                push("info", `${e.key} 已更新`);
              } else {
                const text = JSON.stringify(e.value);
                const shown = text.length > 200 ? `${text.slice(0, 200)}…` : text;
                push("info", `${e.key} = ${shown}`);
              }
            }
          } else if (e.type === "error") {
            failure = e.message;
          }
        });

        final = await handle.done;
        setProgress(null);
        const env = final as unknown as { success?: boolean; message?: string; code?: string; data?: T } | null;

        if (failure && !env) throw new Error(failure);
        if (!env) throw new Error("会话中断：没有收到结果（后端可能已退出）");
        if (!env.success) {
          throw new Error(env.message || env.code || "操作失败");
        }
        push("ok", `✔ ${title} 完成`);
        return env.data as T;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        push("err", `✘ ${title}: ${msg}`);
        throw e;
      } finally {
        cancelRef.current = null;
        setBusy(null);
        setProgress(null);
      }
    },
    [push],
  );

  const cancel = React.useCallback(async () => {
    if (cancelRef.current) {
      await cancelRef.current();
      push("err", "已请求取消");
      toast.message("已请求取消");
    }
  }, [push]);

  const value: RunnerCtx = {
    booted,
    bootError,
    info,
    schemas,
    logs,
    busy,
    progress,
    clearLogs: () => setLogs([]),
    run,
    cancel,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRunner(): RunnerCtx {
  const v = React.useContext(Ctx);
  if (!v) throw new Error("useRunner 必须在 RunnerProvider 内使用");
  return v;
}
