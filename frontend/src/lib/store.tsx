import * as React from "react";
import { toast } from "sonner";

import { boot, fetchSchemas, startRun, subscribe } from "@/lib/api";
import { fetchCommercial } from "@/lib/commercial";
import { useI18n } from "@/lib/i18n";
import { OFFLINE_SNAPSHOT, type CommercialSnapshot } from "@/lib/commercial-core";
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
  /** 新版后端才有；旧版 / 失联时前端走 OFFLINE_SNAPSHOT 兜底 */
  commercial?: boolean;
}

interface RunnerCtx {
  booted: boolean;
  bootError: string | null;
  info: BootInfo | null;
  schemas: CommandSchema[];
  commercial: CommercialSnapshot;
  setCommercial: (s: CommercialSnapshot) => void;
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
  const [commercial, setCommercial] = React.useState<CommercialSnapshot>(OFFLINE_SNAPSHOT);
  const [logs, setLogs] = React.useState<LogLine[]>([]);
  const { t } = useI18n();
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
        // 商业化配置失败不影响网盘主功能：始终退回同源图片 + 联系方式的离线兜底。
        const c = await fetchCommercial(Boolean(b.commercial));
        if (!alive) return;
        setCommercial(c);
        setInfo({
          name: b.name,
          version: b.version,
          kuake: b.kuake,
          temp: b.temp ?? "",
          backend: b.backend ?? "native",
          commercial: b.commercial,
        });
        setSchemas(s);
        setBooted(true);
        push(
          "info",
          b.backend === "cli"
            ? t("store.readyCli", { kuake: b.kuake })
            : t("store.readyNative"),
        );
      } catch (e) {
        if (!alive) return;
        const msg = e instanceof Error ? e.message : String(e);
        setBootError(msg);
        push("err", t("store.handshakeFail", { msg }));
      }
    })();
    return () => {
      alive = false;
    };
  }, [push, t]);

  const run = React.useCallback(
    async <T,>(cmd: string, args: Record<string, unknown>, label?: string): Promise<T> => {
      const title = label ?? cmd;
      setBusy(title);
      setProgress(null);
      push("info", t("store.start", { title }));
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
                push("info", t("store.qrUpdated", { key: e.key }));
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
        if (!env) throw new Error(t("store.noResult"));
        if (!env.success) {
          throw new Error(env.message || env.code || t("store.opFailed"));
        }
        push("ok", t("store.done", { title }));
        return env.data as T;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        push("err", t("store.fail", { title, msg }));
        throw e;
      } finally {
        cancelRef.current = null;
        setBusy(null);
        setProgress(null);
      }
    },
    [push, t],
  );

  const cancel = React.useCallback(async () => {
    if (cancelRef.current) {
      await cancelRef.current();
      push("err", t("store.cancelled"));
      toast.message(t("store.cancelled"));
    }
  }, [push, t]);

  const value: RunnerCtx = {
    booted,
    bootError,
    info,
    schemas,
    commercial,
    setCommercial,
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
