import * as React from "react";
import { toast } from "sonner";
import {
  ArrowDownUp,
  ChevronRight,
  Copy,
  CornerUpLeft,
  Download,
  FolderPlus,
  Lock,
  Unlock,
  Home,
  Info,
  Link2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Scissors,
  Trash2,
  Upload as UploadIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CommandDialog } from "@/components/command-dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { InfoDialog } from "@/components/info-dialog";
import { UploadDialog } from "@/components/upload-dialog";
import { DropUpload } from "@/components/drop-upload";
import { DecryptDialog } from "@/components/decrypt-dialog";
import { fileIcon } from "@/components/file-icon";
import { useRunner } from "@/lib/store";
import { formatBytes, formatTime, joinPath, relativeTime, splitPath } from "@/lib/format";
import type { ArgSchema, CommandSchema, KuakeFile } from "@/lib/types";
import { cn } from "@/lib/utils";

/** 是否是本客户端加密出来的容器（.kcrypt） */
function isEncrypted(name: string): boolean {
  return name.toLowerCase().endsWith(".kcrypt");
}

/** 多选身份：优先 fid，缺失时退回路径（与 pathOf 一致） */
function itemId(item: KuakeFile, baseDir: string): string {
  return item.fid || item.path || joinPath(baseDir, item.file_name);
}

type SortKey = "name" | "size" | "mtime";
type SortDir = "asc" | "desc";

interface DirState {
  path: string;
  items: KuakeFile[];
  loading: boolean;
  error: string | null;
}

type DialogState =
  | { kind: "none" }
  | { kind: "create" }
  | { kind: "rename"; target: KuakeFile }
  | { kind: "move"; target: KuakeFile }
  | { kind: "copy"; target: KuakeFile }
  | { kind: "share"; target: KuakeFile }
  | { kind: "info"; target: KuakeFile }
  | { kind: "download"; target: KuakeFile }
  | { kind: "upload" }
  | { kind: "decrypt"; target: KuakeFile }
  | { kind: "batch-move" }
  | { kind: "batch-copy" };

/** 当前浏览目录 + 文件列表。所有操作完成后都回到这里刷新。 */
export function FilesView({
  schemas,
  jump,
}: {
  schemas: CommandSchema[];
  jump?: { path: string; nonce: number } | null;
}) {
  const { run, booted } = useRunner();
  const [dir, setDir] = React.useState<DirState>({
    path: "/",
    items: [],
    loading: true,
    error: null,
  });
  const [sort, setSort] = React.useState<{ key: SortKey; dir: SortDir }>({
    key: "name",
    dir: "asc",
  });
  const [dialog, setDialog] = React.useState<DialogState>({ kind: "none" });
  const [confirmDelete, setConfirmDelete] = React.useState<KuakeFile | null>(null);
  const [confirmBatchDelete, setConfirmBatchDelete] = React.useState(false);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [history, setHistory] = React.useState<string[]>([]);

  const argsOf = React.useCallback(
    (name: string): ArgSchema[] => schemas.find((s) => s.name === name)?.args ?? [],
    [schemas],
  );

  const load = React.useCallback(
    async (path: string, opts?: { pushHistory?: boolean }) => {
      setDir((d) => ({ ...d, loading: true, error: null }));
      if (opts?.pushHistory) {
        const from = dir.path;
        setHistory((h) => (h[h.length - 1] === from ? h : [...h, from].slice(-50)));
      }
      try {
        const data = await run<{ list: KuakeFile[] }>("list", { path }, "列出目录");
        const list = data?.list ?? [];
        const alive = new Set(list.map((it) => itemId(it, path)));
        setSelected((cur) => cur.filter((id) => alive.has(id)));
        setDir({ path, items: list, loading: false, error: null });
      } catch (e) {
        setSelected([]);
        setDir({
          path,
          items: [],
          loading: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [run, dir.path],
  );

  // 搜索页「跳到所在目录」会带一个递增 nonce；初始挂载仍从根开始。
  const navNonce = jump?.nonce ?? 0;
  const navPath = jump?.path ?? "/";

  React.useEffect(() => {
    if (booted) void load(navPath, navNonce > 0 ? { pushHistory: true } : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booted, navNonce]);

  const sorted = React.useMemo(() => {
    const items = [...dir.items];
    const factor = sort.dir === "asc" ? 1 : -1;
    items.sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1; // 目录恒在前
      if (sort.key === "size") return (a.size - b.size) * factor;
      if (sort.key === "mtime") return ((a.mtime ?? 0) - (b.mtime ?? 0)) * factor;
      return a.file_name.localeCompare(b.file_name, "zh-CN") * factor;
    });
    return items;
  }, [dir.items, sort]);

  const crumbs = splitPath(dir.path);
  const counts = {
    dirs: dir.items.filter((i) => i.dir).length,
    files: dir.items.filter((i) => !i.dir).length,
    bytes: dir.items.reduce((s, i) => (i.dir ? s : s + (i.size || 0)), 0),
  };

  const pathOf = (item: KuakeFile) => item.path || joinPath(dir.path, item.file_name);
  const idOf = (item: KuakeFile) => itemId(item, dir.path);

  const selectedItems = dir.items.filter((it) => selected.includes(idOf(it)));
  const selectedPaths = selectedItems.map(pathOf);
  const allChecked = dir.items.length > 0 && selected.length === dir.items.length;
  const toggleAll = () => setSelected(allChecked ? [] : dir.items.map(idOf));
  const toggleOne = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const openItem = (item: KuakeFile) => {
    if (item.dir) void load(pathOf(item), { pushHistory: true });
    else setDialog({ kind: "info", target: item });
  };

  const goUp = () => {
    const last = history[history.length - 1];
    if (last !== undefined) {
      setHistory((h) => h.slice(0, -1));
      void load(last);
    }
  };

  const close = () => setDialog({ kind: "none" });
  const targetPath = (d: DialogState) =>
    d.kind === "rename" ||
      d.kind === "move" ||
      d.kind === "copy" ||
      d.kind === "share" ||
      d.kind === "download" ||
      d.kind === "decrypt"
      ? pathOf(d.target)
      : "";

  return (
    <DropUpload dirPath={dir.path} onDone={() => void load(dir.path)}>
      {/* 工具条：面包屑 + 排序 + 新建/上传 */}
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          <Button variant="ghost" size="icon-sm" onClick={() => void load("/")} title="根目录">
            <Home className="size-4" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={goUp} disabled={history.length === 0} title="上一级">
            <CornerUpLeft className="size-4" />
          </Button>
          <nav className="flex min-w-0 flex-wrap items-center gap-0.5 text-sm">
            {crumbs.map((c, i) => (
              <React.Fragment key={c.path}>
                {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />}
                <button
                  className={cn(
                    "max-w-[16rem] truncate rounded px-1.5 py-0.5 hover:bg-accent",
                    i === crumbs.length - 1 && "font-medium",
                  )}
                  onClick={() => void load(c.path, { pushHistory: true })}
                >
                  {c.label}
                </button>
              </React.Fragment>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="icon-sm" onClick={() => void load(dir.path)} title="刷新">
            <RefreshCw className={cn("size-4", dir.loading && "animate-spin")} />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" title="排序">
                <ArrowDownUp className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>排序</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => setSort({ key: "name", dir: "asc" })}>名称 升序</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setSort({ key: "name", dir: "desc" })}>名称 降序</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setSort({ key: "mtime", dir: "desc" })}>修改时间 最新</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setSort({ key: "mtime", dir: "asc" })}>修改时间 最旧</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setSort({ key: "size", dir: "desc" })}>大小 从大到小</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setDialog({ kind: "create" })}
            disabled={!booted}
          >
            <FolderPlus className="size-4" />
            新建文件夹
          </Button>
          <Button size="sm" className="gap-1.5" onClick={() => setDialog({ kind: "upload" })} disabled={!booted}>
            <UploadIcon className="size-4" />
            上传
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-3 border-b px-4 py-1.5 text-[11.5px] text-muted-foreground">
        <span>{counts.dirs} 个文件夹</span>
        <span>{counts.files} 个文件</span>
        <span>共 {formatBytes(counts.bytes)}</span>
        <span className="ml-auto truncate font-mono">{dir.path}</span>
      </div>

      {selected.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b bg-accent/30 px-4 py-2">
          <span className="text-xs font-medium">已选 {selected.length} 项</span>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setDialog({ kind: "batch-move" })}>
            <Scissors className="size-4" /> 批量移动
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setDialog({ kind: "batch-copy" })}>
            <Copy className="size-4" /> 批量复制
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-destructive hover:text-destructive"
            onClick={() => setConfirmBatchDelete(true)}
          >
            <Trash2 className="size-4" /> 批量删除
          </Button>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setSelected([])}>
            清空选择
          </Button>
        </div>
      ) : null}

      <ScrollArea className="min-h-0 flex-1">
        {dir.error ? (
          <div className="m-4 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
            <p className="text-sm font-medium text-destructive">读取失败</p>
            <p className="mt-1 break-all text-xs text-muted-foreground">{dir.error}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void load(dir.path)}>
              重试
            </Button>
          </div>
        ) : dir.loading ? (
          <div className="grid gap-2 p-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <div className="grid place-items-center gap-2 py-24 text-center">
            <span className="text-sm text-muted-foreground">这个目录是空的</span>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setDialog({ kind: "upload" })}>
              <UploadIcon className="size-4" /> 上传第一个文件
            </Button>
          </div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-background/95 backdrop-blur">
              <tr className="border-b text-left text-[11.5px] text-muted-foreground">
                <th className="w-10 px-2 py-2">
                  <Checkbox checked={allChecked} onCheckedChange={() => toggleAll()} aria-label="全选本页" />
                </th>
                <th
                  className="cursor-pointer px-4 py-2 font-medium"
                  onClick={() =>
                    setSort((s) => ({ key: "name", dir: s.key === "name" && s.dir === "asc" ? "desc" : "asc" }))
                  }
                >
                  名称
                </th>
                <th
                  className="w-24 cursor-pointer px-2 py-2 text-right font-medium"
                  onClick={() =>
                    setSort((s) => ({ key: "size", dir: s.key === "size" && s.dir === "desc" ? "asc" : "desc" }))
                  }
                >
                  大小
                </th>
                <th
                  className="w-32 cursor-pointer px-2 py-2 font-medium"
                  onClick={() =>
                    setSort((s) => ({ key: "mtime", dir: s.key === "mtime" && s.dir === "desc" ? "asc" : "desc" }))
                  }
                >
                  修改时间
                </th>
                <th className="w-12 px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((item) => {
                const itemPath = pathOf(item);
                const id = idOf(item);
                const checked = selected.includes(id);
                return (
                  <tr
                    key={item.fid || itemPath}
                    className={cn(
                      "group border-b border-border/50 transition-colors hover:bg-accent/50",
                      checked && "bg-accent/30",
                    )}
                    onDoubleClick={() => openItem(item)}
                  >
                    <td className="w-10 px-2 py-2">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggleOne(id)}
                        aria-label={"选择 " + item.file_name}
                      />
                    </td>
                    <td className="max-w-0 px-4 py-2">
                      <button className="flex w-full min-w-0 items-center gap-2 text-left" onClick={() => openItem(item)}>
                        {fileIcon(item.file_name, item.dir)}
                        <span className="truncate">{item.file_name}</span>
                        {!item.dir && isEncrypted(item.file_name) && (
                          <Lock className="size-3 shrink-0 text-primary/70" aria-label="已加密" />
                        )}
                        {item.dir && (
                          <Badge variant="muted" className="ml-1 hidden shrink-0 group-hover:inline-flex">
                            文件夹
                          </Badge>
                        )}
                      </button>
                    </td>
                    <td className="px-2 py-2 text-right text-xs tabular text-muted-foreground">
                      {item.dir ? "—" : formatBytes(item.size)}
                    </td>
                    <td className="px-2 py-2 text-xs text-muted-foreground">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>{relativeTime(item.mtime || item.updated_at)}</span>
                        </TooltipTrigger>
                        <TooltipContent>{formatTime(item.mtime || item.updated_at)}</TooltipContent>
                      </Tooltip>
                    </td>
                    <td className="px-2 py-2">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="size-7 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
                          >
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          {item.dir && (
                            <DropdownMenuItem onClick={() => openItem(item)}>
                              <ChevronRight className="size-4" /> 打开
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onClick={() => setDialog({ kind: "info", target: item })}>
                            <Info className="size-4" /> 详情
                          </DropdownMenuItem>
                          {!item.dir && (
                            <DropdownMenuItem onClick={() => setDialog({ kind: "download", target: item })}>
                              <Download className="size-4" /> 下载
                            </DropdownMenuItem>
                          )}
                          {!item.dir && isEncrypted(item.file_name) && (
                            <DropdownMenuItem onClick={() => setDialog({ kind: "decrypt", target: item })}>
                              <Unlock className="size-4" /> 解密到本机…
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onClick={() => setDialog({ kind: "share", target: item })}>
                            <Link2 className="size-4" /> 创建分享
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => setDialog({ kind: "rename", target: item })}>
                            <Pencil className="size-4" /> 重命名
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setDialog({ kind: "move", target: item })}>
                            <Scissors className="size-4" /> 移动
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setDialog({ kind: "copy", target: item })}>
                            <Copy className="size-4" /> 复制
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(item)}>
                            <Trash2 className="size-4" /> 删除
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </ScrollArea>

      <CommandDialog
        open={dialog.kind === "create"}
        onOpenChange={(o) => !o && close()}
        title="新建文件夹"
        description={'在 ' + dir.path + ' 下创建'}
        cmd="create"
        args={argsOf("create")}
        preset={{ pdir: dir.path }}
        hide={["pdir"]}
        submitLabel="创建"
        onSuccess={() => void load(dir.path)}
      />

      <CommandDialog
        open={dialog.kind === "rename"}
        onOpenChange={(o) => !o && close()}
        title="重命名"
        cmd="rename"
        args={argsOf("rename")}
        preset={
          dialog.kind === "rename"
            ? { path: targetPath(dialog), "new-name": dialog.target.file_name }
            : undefined
        }
        hide={["path"]}
        submitLabel="重命名"
        onSuccess={() => void load(dir.path)}
      />

      <CommandDialog
        open={dialog.kind === "move"}
        onOpenChange={(o) => !o && close()}
        title="移动到…"
        description="目标目录必须已存在"
        cmd="move"
        args={argsOf("move")}
        preset={dialog.kind === "move" ? { src: targetPath(dialog), dest: dir.path } : undefined}
        hide={["src"]}
        submitLabel="移动"
        onSuccess={() => void load(dir.path)}
      />

      <CommandDialog
        open={dialog.kind === "copy"}
        onOpenChange={(o) => !o && close()}
        title="复制到…"
        description="目标目录必须已存在"
        cmd="copy"
        args={argsOf("copy")}
        preset={dialog.kind === "copy" ? { src: targetPath(dialog), dest: dir.path } : undefined}
        hide={["src"]}
        submitLabel="复制"
        onSuccess={() => void load(dir.path)}
      />

      <CommandDialog
        open={dialog.kind === "share"}
        onOpenChange={(o) => !o && close()}
        title="创建分享链接"
        cmd="share"
        args={argsOf("share")}
        preset={dialog.kind === "share" ? { path: targetPath(dialog) } : undefined}
        submitLabel="创建分享"
        onSuccess={(data) => {
          const url = (data as { share_url?: string } | null)?.share_url;
          if (url) {
            void navigator.clipboard?.writeText(url).catch(() => {});
            toast.success("分享链接已复制到剪贴板", { description: url });
          }
        }}
      />

      <CommandDialog
        open={dialog.kind === "download"}
        onOpenChange={(o) => !o && close()}
        title="下载到本机"
        description="填本机目录（不存在会自动创建）；留空则用 kuake 的默认下载位置"
        cmd="download"
        args={argsOf("download")}
        preset={dialog.kind === "download" ? { path: targetPath(dialog) } : undefined}
        hide={["path"]}
        submitLabel="下载"
      />

      <DecryptDialog
        open={dialog.kind === "decrypt"}
        onOpenChange={(o) => !o && close()}
        target={dialog.kind === "decrypt" ? dialog.target : null}
        cloudPath={dialog.kind === "decrypt" ? targetPath(dialog) : ""}
      />

      <InfoDialog
        item={dialog.kind === "info" ? dialog.target : null}
        baseDir={dir.path}
        onClose={close}
      />

      <UploadDialog
        open={dialog.kind === "upload"}
        onOpenChange={(o) => !o && close()}
        dirPath={dir.path}
        args={argsOf("upload")}
        onDone={() => void load(dir.path)}
      />

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title="确认删除？"
        description={
          <>
            <span className="break-all font-mono">
              {confirmDelete ? pathOf(confirmDelete) : ""}
            </span>
            <br />
            目录会连同内容一起进回收站，客户端内无法恢复。
          </>
        }
        confirmLabel="删除"
        onConfirm={async () => {
          if (!confirmDelete) return;
          try {
            await run("delete", { path: pathOf(confirmDelete) }, "删除");
            toast.success("已删除");
            await load(dir.path);
          } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
          }
          setConfirmDelete(null);
        }}
      />

      <CommandDialog
        open={dialog.kind === "batch-move"}
        onOpenChange={(o) => !o && close()}
        title="批量移动到…"
        description={"将已选 " + selected.length + " 项移动到目标目录（须已存在）"}
        cmd="batch-move"
        args={argsOf("batch-move")}
        preset={{ paths: selectedPaths, dest: dir.path }}
        hide={["paths"]}
        submitLabel="批量移动"
        onSuccess={() => {
          setSelected([]);
          void load(dir.path);
        }}
      />

      <CommandDialog
        open={dialog.kind === "batch-copy"}
        onOpenChange={(o) => !o && close()}
        title="批量复制到…"
        description={"将已选 " + selected.length + " 项复制到目标目录（须已存在）"}
        cmd="batch-copy"
        args={argsOf("batch-copy")}
        preset={{ paths: selectedPaths, dest: dir.path }}
        hide={["paths"]}
        submitLabel="批量复制"
        onSuccess={() => {
          setSelected([]);
          void load(dir.path);
        }}
      />

      <ConfirmDialog
        open={confirmBatchDelete}
        onOpenChange={(o) => !o && setConfirmBatchDelete(false)}
        title="确认批量删除？"
        description={
          <>
            <span>共 {selected.length} 项：</span>
            <ul className="mt-1 max-h-32 overflow-auto font-mono text-xs">
              {selectedPaths.slice(0, 8).map((p) => (
                <li key={p} className="break-all">{p}</li>
              ))}
              {selectedPaths.length > 8 ? <li>… 还有 {selectedPaths.length - 8} 项</li> : null}
            </ul>
            <br />
            会一次性全部放进回收站，目录会连同内容一起删除。
          </>
        }
        confirmLabel="批量删除"
        onConfirm={async () => {
          const paths = selectedPaths;
          if (paths.length === 0) return;
          try {
            await run("batch-delete", { paths }, "批量删除");
            toast.success("已删除 " + paths.length + " 项");
            setSelected([]);
            await load(dir.path);
          } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
          }
        }}
      />
    </DropUpload>
  );
}
