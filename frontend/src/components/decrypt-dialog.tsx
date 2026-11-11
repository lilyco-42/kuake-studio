import * as React from "react";
import { toast } from "sonner";
import { Eye, EyeOff, KeyRound, Unlock } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { useRunner } from "@/lib/store";
import type { CommandSchema } from "@/lib/types";
import type { KuakeFile } from "@/lib/types";

/**
 * 解密网盘上的 .kcrypt：两步
 * 1) download 到本机临时目录，拿到 local_path
 * 2) decrypt 用口令还原成原名，落到用户指定的目录
 *
 * 为什么不在网盘上解密：密文必须先落到本机才有 CPU 去算 KDF，
 * 而且这样明文永远不会经过网盘接口。
 */
export function DecryptDialog({
  open,
  onOpenChange,
  target,
  cloudPath,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  target: KuakeFile | null;
  cloudPath: string;
}) {
  const { run, progress, schemas, info } = useRunner();

  /**
   * 参数名以 schema 为准：后端字段 out_dir 经派生宏转成 kebab 的 "out-dir"，
   * 前端若写死 out_dir 会被当成未知键丢掉（validate_args 只校验不拒绝多余键），
   * 于是静默退回「与密文同目录」。这里两种写法都兼容一下。
   */
  const outDirKey = React.useMemo(() => {
    const sch: CommandSchema | undefined = schemas.find((c) => c.name === "decrypt");
    const names = (sch?.args ?? []).map((a) => a.name);
    return names.find((n) => n === "out-dir" || n === "out_dir") ?? "out-dir";
  }, [schemas]);
  const [pass, setPass] = React.useState("");
  const [showPass, setShowPass] = React.useState(false);
  const [outDir, setOutDir] = React.useState("~/Downloads");
  const [phase, setPhase] = React.useState<"idle" | "downloading" | "decrypting">("idle");
  const [result, setResult] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setPass("");
      setShowPass(false);
      setOutDir("~/Downloads");
      setPhase("idle");
      setResult(null);
    }
  }, [open]);

  const pending = phase !== "idle";

  const submit = async () => {
    if (!target) return;
    if (!pass.trim()) {
      toast.error("请输入口令");
      return;
    }
    try {
      setPhase("downloading");
      // 密文先落到本机临时目录（每次一个新目录，避免同名覆盖）。
      // 目录前缀由后端给：Windows 上没有 /tmp，硬编码会落到盘符根目录。
      const tmpBase = info?.temp || "";
      const tmp = `${tmpBase}/kuake-decrypt-${Date.now().toString(36)}`;
      const dl = await run<{ local_path?: string }>(
        "download",
        { path: cloudPath, dest: tmp },
        "下载密文 " + target.file_name,
      );
      const local = dl?.local_path;
      if (!local) throw new Error("下载完成但没拿到本机路径");

      setPhase("decrypting");
      const dec = await run<{ output: string; name: string; size: number }>(
        "decrypt",
        { file: local, [outDirKey]: outDir.trim() || undefined, passphrase: pass },
        "解密 " + target.file_name,
      );
      setResult(dec?.output ?? "");
      toast.success("解密完成", { description: dec?.output });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setPhase("idle");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Unlock className="size-4 text-primary" /> 解密到本机
          </DialogTitle>
          <DialogDescription className="break-all">
            {target ? target.file_name : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <label className="text-xs text-muted-foreground">口令</label>
            <div className="relative">
              <Input
                type={showPass ? "text" : "password"}
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                placeholder="加密时设的口令"
                disabled={pending}
                autoComplete="current-password"
                className="pr-9"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !pending) void submit();
                }}
              />
              <button
                type="button"
                onClick={() => setShowPass((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                tabIndex={-1}
              >
                {showPass ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>

          <div className="grid gap-1.5">
            <label className="text-xs text-muted-foreground">解压到</label>
            <Input
              value={outDir}
              onChange={(e) => setOutDir(e.target.value)}
              placeholder="~/Downloads"
              disabled={pending}
              className="font-mono text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              目录不存在会自动创建，支持 ~。解密出的文件名取自密文里记录的原名。
            </p>
          </div>

          {pending && (
            <div className="grid gap-1">
              <Progress value={phase === "downloading" ? 8 : (progress ?? 40)} />
              <p className="text-[11px] text-muted-foreground">
                {phase === "downloading" ? "正在把密文下载到本机…" : "正在本机解密…"}
              </p>
            </div>
          )}

          {result && (
            <div className="rounded-lg border bg-muted/40 p-2.5">
              <p className="text-[11px] text-muted-foreground">已还原到</p>
              <p className="break-all font-mono text-[11.5px]">{result}</p>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            关闭
          </Button>
          <Button onClick={submit} disabled={pending || !pass.trim()} className="gap-1.5">
            <KeyRound className="size-4" />
            {pending ? "进行中…" : "下载并解密"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
