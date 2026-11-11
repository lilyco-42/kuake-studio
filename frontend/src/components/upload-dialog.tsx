import * as React from "react";
import { toast } from "sonner";
import { Eye, EyeOff, Lock, ShieldCheck, Upload as UploadIcon } from "lucide-react";

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
import { Switch } from "@/components/ui/switch";
import { readFileAsBase64, uploadTemp } from "@/lib/api";
import { formatBytes, joinPath } from "@/lib/format";
import { useRunner } from "@/lib/store";
import type { ArgSchema } from "@/lib/types";
import { cn } from "@/lib/utils";

/** 口令强度：只做提示，不拦人（下限由后端 crypt::MIN_PASSPHRASE 保证） */
function strength(p: string): { score: number; label: string; tone: string } {
  let s = 0;
  if (p.length >= 8) s++;
  if (p.length >= 12) s++;
  if (p.length >= 16) s++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++;
  if (/\d/.test(p)) s++;
  if (/[^A-Za-z0-9]/.test(p)) s++;
  const score = Math.min(4, Math.ceil(s / 1.6));
  const table = [
    { label: "太短", tone: "bg-destructive" },
    { label: "偏弱", tone: "bg-destructive" },
    { label: "一般", tone: "bg-warning" },
    { label: "较强", tone: "bg-success" },
    { label: "很强", tone: "bg-success" },
  ];
  return { score, ...table[score] };
}

/**
 * 上传两步走：
 * 1) 浏览器只能读文件内容 → base64 给后端落盘到暂存目录，拿到真实路径
 * 2) 再用该路径调 upload 命令（kuake 的 dest 必须是完整文件路径，不能是目录）
 *
 * 勾选「上传前加密」时，后端在本机先把暂存文件加密成 .kcrypt 再上传，
 * 网盘上从头到尾没有明文；容器里记的原名就是网盘上的名字（去掉 .kcrypt）。
 */
export function UploadDialog({
  open,
  onOpenChange,
  dirPath,
  args,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  dirPath: string;
  args: ArgSchema[];
  onDone: () => void;
}) {
  const { run, progress } = useRunner();
  const [file, setFile] = React.useState<File | null>(null);
  const [destName, setDestName] = React.useState("");
  const [phase, setPhase] = React.useState<"idle" | "staging" | "uploading">("idle");
  const [encrypt, setEncrypt] = React.useState(false);
  const [pass, setPass] = React.useState("");
  const [pass2, setPass2] = React.useState("");
  const [showPass, setShowPass] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const supportsEncrypt = args.some((a) => a.name === "passphrase");

  React.useEffect(() => {
    if (open) {
      setFile(null);
      setDestName("");
      setPhase("idle");
      setEncrypt(false);
      setPass("");
      setPass2("");
      setShowPass(false);
    }
  }, [open]);

  const destPath = React.useMemo(() => {
    const name = destName || file?.name || "";
    if (!name) return dirPath;
    const withExt = encrypt && !name.toLowerCase().endsWith(".kcrypt") ? name + ".kcrypt" : name;
    return joinPath(dirPath, withExt);
  }, [dirPath, destName, file, encrypt]);

  const pending = phase !== "idle";
  const passTooShort = encrypt && pass.length > 0 && pass.length < 8;
  const mismatch = encrypt && pass2.length > 0 && pass !== pass2;
  const encBlocked = encrypt && (pass.length < 8 || pass !== pass2);
  const st = strength(pass);

  const submit = async () => {
    if (!file) {
      toast.error("先选一个文件");
      return;
    }
    if (encrypt) {
      if (pass.length < 8) {
        toast.error("口令至少 8 位", { description: "这是唯一能解开的凭据，丢了文件就废了" });
        return;
      }
      if (pass !== pass2) {
        toast.error("两次输入的口令不一致");
        return;
      }
    }
    setPhase("staging");
    try {
      const b64 = await readFileAsBase64(file);
      const staged = await uploadTemp(file.name, b64);
      setPhase("uploading");
      const allowed = new Set(args.map((a) => a.name));
      const payload: Record<string, unknown> = {};
      if (allowed.has("file")) payload.file = staged.path;
      if (allowed.has("dest")) payload.dest = destPath;
      if (encrypt && allowed.has("passphrase")) payload.passphrase = pass;
      await run("upload", payload, (encrypt ? "加密上传 " : "上传 ") + file.name);
      toast.success(encrypt ? "已加密上传" : "上传完成", {
        description: encrypt ? destPath + " · 口令请自行保管" : destPath,
      });
      onOpenChange(false);
      onDone();
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
          <DialogTitle>上传文件</DialogTitle>
          <DialogDescription className="break-all">目标目录：{dirPath}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <input
            ref={inputRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              if (f) setDestName(f.name);
            }}
          />
          <Button
            variant="outline"
            className="justify-start gap-2 overflow-hidden"
            onClick={() => inputRef.current?.click()}
            disabled={pending}
          >
            <UploadIcon className="size-4 shrink-0" />
            <span className="truncate">
              {file ? file.name + " · " + formatBytes(file.size) : "选择本机文件"}
            </span>
          </Button>

          <div className="grid gap-1.5">
            <label className="text-xs text-muted-foreground">网盘上的文件名</label>
            <Input
              value={destName}
              onChange={(e) => setDestName(e.target.value)}
              placeholder={file?.name ?? "文件名"}
              disabled={pending}
            />
            <p className="break-all font-mono text-[11px] text-muted-foreground">{destPath}</p>
          </div>

          {supportsEncrypt && (
            <div className="grid gap-2 rounded-lg border bg-muted/30 p-3">
              <label className="flex cursor-pointer items-center gap-2.5">
                <Switch checked={encrypt} onCheckedChange={setEncrypt} disabled={pending} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-xs font-medium">
                    <Lock className="size-3.5 text-primary" />
                    上传前加密
                  </div>
                  <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                    AES-256-GCM 分块 + PBKDF2 派生密钥，网盘上只有密文
                  </p>
                </div>
              </label>

              {encrypt && (
                <div className="grid gap-2 pt-1">
                  <div className="relative">
                    <Input
                      type={showPass ? "text" : "password"}
                      value={pass}
                      onChange={(e) => setPass(e.target.value)}
                      placeholder="口令（至少 8 位）"
                      disabled={pending}
                      autoComplete="new-password"
                      className="pr-9"
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

                  {pass.length > 0 && (
                    <div className="flex items-center gap-2">
                      <div className="flex h-1 flex-1 gap-0.5">
                        {[0, 1, 2, 3].map((i) => (
                          <span
                            key={i}
                            className={cn(
                              "h-full flex-1 rounded-full bg-muted",
                              i < st.score && st.tone,
                            )}
                          />
                        ))}
                      </div>
                      <span className="w-8 text-right text-[10.5px] text-muted-foreground">
                        {st.label}
                      </span>
                    </div>
                  )}

                  <Input
                    type={showPass ? "text" : "password"}
                    value={pass2}
                    onChange={(e) => setPass2(e.target.value)}
                    placeholder="再输一次口令"
                    disabled={pending}
                    autoComplete="new-password"
                    className={cn(mismatch && "border-destructive focus-visible:ring-destructive/30")}
                  />
                  {passTooShort && (
                    <p className="text-[11px] text-destructive">口令至少 8 位</p>
                  )}
                  {mismatch && <p className="text-[11px] text-destructive">两次输入不一致</p>}
                  <p className="flex items-start gap-1.5 text-[11px] leading-4 text-muted-foreground">
                    <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-primary/70" />
                    口令不会上传、也不会存盘。丢了就解不开，请自行记牢。
                  </p>
                </div>
              )}
            </div>
          )}

          {pending && (
            <div className="grid gap-1">
              <Progress value={phase === "staging" ? 5 : (progress ?? 10)} />
              <p className="text-[11px] text-muted-foreground">
                {phase === "staging"
                  ? "正在把文件交给本地后端…"
                  : encrypt
                    ? "正在本机加密并上传到网盘…"
                    : "正在上传到网盘…"}
              </p>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            取消
          </Button>
          <Button onClick={submit} disabled={pending || !file || encBlocked}>
            {pending ? "进行中…" : encrypt ? "加密并上传" : "开始上传"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
