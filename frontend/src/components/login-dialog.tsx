import * as React from "react";
import { CheckCircle2, Copy, Loader2, QrCode, RefreshCw, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { loginCancel, loginStart, loginStatus } from "@/lib/api";
import type { LoginStatus as LoginStatusData } from "@/lib/api";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 登录成功后让账号页重新拉一次 user/version */
  onSuccess: () => void;
}

export function LoginDialog({ open, onOpenChange, onSuccess }: Props) {
  const [round, setRound] = React.useState(0);
  const [qrData, setQrData] = React.useState("");
  const [qrUrl, setQrUrl] = React.useState("");
  const [state, setState] = React.useState<"loading" | "waiting" | "success" | "failed" | "cancelled">("loading");
  const [message, setMessage] = React.useState("");
  const [result, setResult] = React.useState<LoginStatusData["data"] | null>(null);
  const [copied, setCopied] = React.useState(false);
  const successRef = React.useRef(onSuccess);
  const openRef = React.useRef(onOpenChange);
  successRef.current = onSuccess;
  openRef.current = onOpenChange;

  React.useEffect(() => {
    if (!open) return;
    let alive = true;
    let sid = "";
    let finished = false;
    let timer: number | undefined;
    setState("loading");
    setMessage("正在向夸克申请二维码…");
    setQrData("");
    setQrUrl("");
    setResult(null);
    setCopied(false);

    const stop = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
    };

    const poll = async () => {
      if (!alive || !sid || finished) return;
      try {
        const s = await loginStatus(sid);
        if (!alive || finished) return;
        setMessage(s.message ?? "");
        if (s.state === "waiting") return;
        finished = true;
        stop();
        setState(s.state);
        if (s.state === "success") {
          setResult(s.data ?? null);
          successRef.current();
        } else if (s.state === "failed") {
          setMessage(s.message ?? "登录失败");
        }
      } catch (e) {
        if (!alive || finished) return;
        finished = true;
        stop();
        setState("failed");
        setMessage(e instanceof Error ? e.message : String(e));
      }
    };

    (async () => {
      try {
        const s = await loginStart();
        if (!alive) return;
        sid = s.sid;
        setQrData(s.qr_data);
        setQrUrl(s.qr_url);
        setState("waiting");
        setMessage("等待夸克 App 扫码…");
        timer = window.setInterval(() => void poll(), 1500);
      } catch (e) {
        if (!alive) return;
        finished = true;
        setState("failed");
        setMessage(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      alive = false;
      stop();
      if (sid && !finished) void loginCancel(sid).catch(() => {});
    };
  }, [open, round]);

  const close = () => openRef.current(false);
  const retry = () => setRound((r) => r + 1);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(qrUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setMessage("复制失败，请手动选中下方链接");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) close(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <QrCode className="size-4" />
            夸克扫码登录
          </DialogTitle>
          <DialogDescription>
            用夸克 App 扫描二维码并确认。成功后凭据只写入本机 .env，不会回传到页面。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-3">
          {qrData ? (
            <img
              src={qrData}
              alt="夸克登录二维码"
              className="size-56 rounded-lg border bg-white p-2 shadow-sm"
            />
          ) : (
            <div className="flex size-56 items-center justify-center rounded-lg border bg-white">
              {state === "loading" ? (
                <Loader2 className="size-7 animate-spin text-muted-foreground" />
              ) : (
                <XCircle className="size-7 text-destructive" />
              )}
            </div>
          )}

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {state === "waiting" && <Loader2 className="size-3.5 animate-spin" />}
            {state === "success" && <CheckCircle2 className="size-3.5 text-success" />}
            {(state === "failed" || state === "cancelled") && <XCircle className="size-3.5 text-destructive" />}
            <span>{message || (state === "success" ? "登录成功" : "准备二维码…")}</span>
          </div>

          {state === "success" && result && (
            <div className="w-full rounded-lg border bg-muted/30 p-3 text-xs">
              <p className="font-medium">已登录：{result.nickname ?? "夸克账号"}</p>
              <p className="mt-1 text-muted-foreground">
                凭据 {result.cookie_len ?? 0} 字符 · {result.cookie_names?.length ?? 0} 个 cookie
              </p>
              <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                {result.env_path ?? "~/.config/kuake/.env"}
              </p>
              <p className="mt-2 text-muted-foreground">无需重启，后续网盘操作立即使用新登录态。</p>
            </div>
          )}

          {qrUrl && state !== "success" && (
            <details className="w-full">
              <summary className="cursor-pointer text-[11px] text-muted-foreground">
                扫不出来？查看二维码原始链接
              </summary>
              <p className="mt-1 break-all rounded-md bg-muted/40 p-2 font-mono text-[10px] leading-relaxed">
                {qrUrl}
              </p>
            </details>
          )}
        </div>

        <DialogFooter>
          {qrUrl && state !== "success" && (
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => void copy()}>
              <Copy className="size-3.5" />
              {copied ? "已复制" : "复制链接"}
            </Button>
          )}
          {(state === "failed" || state === "cancelled") && (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={retry}>
              <RefreshCw className="size-3.5" />
              重新生成
            </Button>
          )}
          <Button size="sm" onClick={close}>
            {state === "success" ? "完成" : "关闭"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
