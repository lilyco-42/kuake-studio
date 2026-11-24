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
  Search as SearchIcon,
  Trash2,
  Upload as UploadIcon,
  X,
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
import { ShareResultDialog } from "@/components/share-result-dialog";
import { SearchView } from "@/components/views/search-view";
import { UploadDialog } from "@/components/upload-dialog";
import { DropUpload } from "@/components/drop-upload";
import { DecryptDialog } from "@/components/decrypt-dialog";
import { fileIcon } from "@/components/file-icon";
import { useRunner } from "@/lib/store";
import { formatBytes, formatTime, joinPath, relativeTime, splitPath } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { extractShareLinks } from "@/lib/share-links";
import type { Lang } from "@/lib/i18n-core";
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
  searchEnabled = false,
  initialSearchOpen = false,
  onOpenShares,
}: {
  schemas: CommandSchema[];
  jump?: { path: string; nonce: number } | null;
  searchEnabled?: boolean;
  initialSearchOpen?: boolean;
  onOpenShares?: () => void;
}) {
  const { run, booted } = useRunner();
  const { t, lang } = useI18n();
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
  const [searchOpen, setSearchOpen] = React.useState(initialSearchOpen && searchEnabled);
  const [searchRefreshKey, setSearchRefreshKey] = React.useState(0);
  const [shareResult, setShareResult] = React.useState<{ links: string[]; target: KuakeFile } | null>(null);

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
        const data = await run<{ list: KuakeFile[] }>("list", { path }, t("op.list"));
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
    [run, dir.path, t],
  );

  // 搜索页「跳到所在目录」会带一个递增 nonce；初始挂载仍从根开始。
  const navNonce = jump?.nonce ?? 0;
  const navPath = jump?.path ?? "/";

  React.useEffect(() => {
    if (booted) void load(navPath, navNonce > 0 ? { pushHistory: true } : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booted, navNonce]);

  React.useEffect(() => {
    if (initialSearchOpen && searchEnabled) setSearchOpen(true);
  }, [initialSearchOpen, searchEnabled]);

  const sorted = React.useMemo(() => {
    const items = [...dir.items];
    const factor = sort.dir === "asc" ? 1 : -1;
    const loc: Lang = lang === "en" ? "en" : "zh-CN";
    items.sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1; // 目录恒在前
      if (sort.key === "size") return (a.size - b.size) * factor;
      if (sort.key === "mtime") return ((a.mtime ?? 0) - (b.mtime ?? 0)) * factor;
      return a.file_name.localeCompare(b.file_name, loc) * factor;
    });
    return items;
  }, [dir.items, sort, lang]);

  const crumbs = splitPath(dir.path, lang);
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

  const close = () => {
    setDialog({ kind: "none" });
    setSearchRefreshKey((n) => n + 1);
  };
  const infoTarget = dialog.kind === "info" ? dialog.target : null;
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
          <Button variant="ghost" size="icon-sm" onClick={() => void load("/")} title={t("format.root")}>
            <Home className="size-4" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={goUp} disabled={history.length === 0} title={t("files.up")}>
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

        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="ghost" size="icon-sm" onClick={() => void load(dir.path)} title={t("common.refresh")}>
            <RefreshCw className={cn("size-4", dir.loading && "animate-spin")} />
          </Button>
          {searchEnabled ? (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 px-2 md:px-3"
              onClick={() => setSearchOpen((v) => !v)}
              title={t("files.searchInline")}
            >
              <SearchIcon className={cn("size-4", searchOpen && "text-primary")} />
              <span className="hidden lg:inline">{t("files.searchInline")}</span>
            </Button>
          ) : null}
          {onOpenShares ? (
            <Button variant="ghost" size="icon-sm" onClick={onOpenShares} title={t("files.openShares")}>
              <Link2 className="size-4" />
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" title={t("files.sort")}>
                <ArrowDownUp className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{t("files.sort")}</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => setSort({ key: "name", dir: "asc" })}>{t("files.sortNameAsc")}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setSort({ key: "name", dir: "desc" })}>{t("files.sortNameDesc")}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setSort({ key: "mtime", dir: "desc" })}>{t("files.sortMtimeNewest")}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setSort({ key: "mtime", dir: "asc" })}>{t("files.sortMtimeOldest")}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setSort({ key: "size", dir: "desc" })}>{t("files.sortSizeDesc")}</DropdownMenuItem>
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
            {t("files.newFolder")}
          </Button>
          <Button size="sm" className="gap-1.5" onClick={() => setDialog({ kind: "upload" })} disabled={!booted}>
            <UploadIcon className="size-4" />
            {t("files.upload")}
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-3 border-b px-4 py-1.5 text-[11.5px] text-muted-foreground">
        <span>{t("files.countDirs", { n: counts.dirs })}</span>
        <span>{t("files.countFiles", { n: counts.files })}</span>
        <span>{t("files.total", { size: formatBytes(counts.bytes) })}</span>
        <span className="ml-auto truncate font-mono">{dir.path}</span>
      </div>

      {searchOpen && searchEnabled ? (
        <div className="min-h-0 flex-1 overflow-hidden border-b bg-muted/20">
          <div className="flex items-center gap-2 px-4 pt-2 text-[11px] text-muted-foreground">
            <span className="truncate">{t("files.searchHint")}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-auto size-6"
              onClick={() => setSearchOpen(false)}
              title="关闭"
            >
              <X className="size-4" />
            </Button>
          </div>
          <SearchView
            compact
            schemas={schemas}
            refreshKey={searchRefreshKey}
            onOpenDir={(path) => {
              setSearchOpen(false);
              void load(path, { pushHistory: true });
            }}
            onOpenItem={(item) => setDialog({ kind: "info", target: item })}
            onShare={(item) => setDialog({ kind: "share", target: item })}
            onDownload={(item) => setDialog({ kind: "download", target: item })}
            onRename={(item) => setDialog({ kind: "rename", target: item })}
            onMove={(item) => setDialog({ kind: "move", target: item })}
            onCopy={(item) => setDialog({ kind: "copy", target: item })}
            onDelete={(item) => setConfirmDelete(item)}
            onDecrypt={(item) => setDialog({ kind: "decrypt", target: item })}
          />
        </div>
      ) : null}

      {selected.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b bg-accent/30 px-4 py-2">
          <span className="text-xs font-medium">{t("common.selected", { n: selected.length })}</span>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setDialog({ kind: "batch-move" })}>
            <Scissors className="size-4" /> {t("files.batchMove")}
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setDialog({ kind: "batch-copy" })}>
            <Copy className="size-4" /> {t("files.batchCopy")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-destructive hover:text-destructive"
            onClick={() => setConfirmBatchDelete(true)}
          >
            <Trash2 className="size-4" /> {t("files.batchDelete")}
          </Button>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setSelected([])}>
            {t("common.clearSelection")}
          </Button>
        </div>
      ) : null}

      <ScrollArea className="min-h-0 flex-1">
        {dir.error ? (
          <div className="m-4 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
            <p className="text-sm font-medium text-destructive">{t("common.readError")}</p>
            <p className="mt-1 break-all text-xs text-muted-foreground">{dir.error}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void load(dir.path)}>
              {t("common.retry")}
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
            <span className="text-sm text-muted-foreground">{t("files.emptyDir")}</span>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setDialog({ kind: "upload" })}>
              <UploadIcon className="size-4" /> {t("files.uploadFirst")}
            </Button>
          </div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-background/95 backdrop-blur">
              <tr className="border-b text-left text-[11.5px] text-muted-foreground">
                <th className="w-10 px-2 py-2">
                  <Checkbox checked={allChecked} onCheckedChange={() => toggleAll()} aria-label={t("files.selectAll")} />
                </th>
                <th
                  className="cursor-pointer px-4 py-2 font-medium"
                  onClick={() =>
                    setSort((s) => ({ key: "name", dir: s.key === "name" && s.dir === "asc" ? "desc" : "asc" }))
                  }
                >
                  {t("files.colName")}
                </th>
                <th
                  className="w-24 cursor-pointer px-2 py-2 text-right font-medium"
                  onClick={() =>
                    setSort((s) => ({ key: "size", dir: s.key === "size" && s.dir === "desc" ? "asc" : "desc" }))
                  }
                >
                  {t("files.colSize")}
                </th>
                <th
                  className="w-32 cursor-pointer px-2 py-2 font-medium"
                  onClick={() =>
                    setSort((s) => ({ key: "mtime", dir: s.key === "mtime" && s.dir === "desc" ? "asc" : "desc" }))
                  }
                >
                  {t("files.colMtime")}
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
                        aria-label={t("files.selectItem", { name: item.file_name })}
                      />
                    </td>
                    <td className="max-w-0 px-4 py-2">
                      <button className="flex w-full min-w-0 items-center gap-2 text-left" onClick={() => openItem(item)}>
                        {fileIcon(item.file_name, item.dir)}
                        <span className="truncate">{item.file_name}</span>
                        {!item.dir && isEncrypted(item.file_name) && (
                          <Lock className="size-3 shrink-0 text-primary/70" aria-label={t("files.encrypted")} />
                        )}
                        {item.dir && (
                          <Badge variant="muted" className="ml-1 hidden shrink-0 group-hover:inline-flex">
                            {t("common.folder")}
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
                          <span>{relativeTime(item.mtime || item.updated_at, lang)}</span>
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
                              <ChevronRight className="size-4" /> {t("files.open")}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onClick={() => setDialog({ kind: "info", target: item })}>
                            <Info className="size-4" /> {t("files.details")}
                          </DropdownMenuItem>
                          {!item.dir && (
                            <DropdownMenuItem onClick={() => setDialog({ kind: "download", target: item })}>
                              <Download className="size-4" /> {t("files.download")}
                            </DropdownMenuItem>
                          )}
                          {!item.dir && isEncrypted(item.file_name) && (
                            <DropdownMenuItem onClick={() => setDialog({ kind: "decrypt", target: item })}>
                              <Unlock className="size-4" /> {t("files.decryptLocal")}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onClick={() => setDialog({ kind: "share", target: item })}>
                            <Link2 className="size-4" /> {t("files.createShare")}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => setDialog({ kind: "rename", target: item })}>
                            <Pencil className="size-4" /> {t("files.rename")}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setDialog({ kind: "move", target: item })}>
                            <Scissors className="size-4" /> {t("files.move")}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setDialog({ kind: "copy", target: item })}>
                            <Copy className="size-4" /> {t("files.copy")}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(item)}>
                            <Trash2 className="size-4" /> {t("files.delete")}
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
        title={t("files.newFolder")}
        description={t("files.createUnder", { path: dir.path })}
        cmd="create"
        args={argsOf("create")}
        preset={{ pdir: dir.path }}
        hide={["pdir"]}
        submitLabel={t("files.create")}
        onSuccess={() => void load(dir.path)}
      />

      <CommandDialog
        open={dialog.kind === "rename"}
        onOpenChange={(o) => !o && close()}
        title={t("files.rename")}
        cmd="rename"
        args={argsOf("rename")}
        preset={
          dialog.kind === "rename"
            ? { path: targetPath(dialog), "new-name": dialog.target.file_name }
            : undefined
        }
        hide={["path"]}
        submitLabel={t("files.rename")}
        onSuccess={() => {
          void load(dir.path);
          setSearchRefreshKey((n) => n + 1);
        }}
      />

      <CommandDialog
        open={dialog.kind === "move"}
        onOpenChange={(o) => !o && close()}
        title={t("files.moveTo")}
        description={t("files.targetMustExist")}
        cmd="move"
        args={argsOf("move")}
        preset={dialog.kind === "move" ? { src: targetPath(dialog), dest: dir.path } : undefined}
        hide={["src"]}
        submitLabel={t("files.move")}
        onSuccess={() => {
          void load(dir.path);
          setSearchRefreshKey((n) => n + 1);
        }}
      />

      <CommandDialog
        open={dialog.kind === "copy"}
        onOpenChange={(o) => !o && close()}
        title={t("files.copyTo")}
        description={t("files.targetMustExist")}
        cmd="copy"
        args={argsOf("copy")}
        preset={dialog.kind === "copy" ? { src: targetPath(dialog), dest: dir.path } : undefined}
        hide={["src"]}
        submitLabel={t("files.copy")}
        onSuccess={() => {
          void load(dir.path);
          setSearchRefreshKey((n) => n + 1);
        }}
      />

      <CommandDialog
        open={dialog.kind === "share"}
        onOpenChange={(o) => !o && close()}
        title={t("files.createShareLink")}
        cmd="share"
        args={argsOf("share")}
        preset={dialog.kind === "share" ? { path: targetPath(dialog) } : undefined}
        submitLabel={t("files.createShare")}
        onSuccess={(data) => {
          const links = extractShareLinks(data);
          if (dialog.kind === "share") setShareResult({ links, target: dialog.target });
          if (links[0]) void navigator.clipboard?.writeText(links[0]).catch(() => {});
          setSearchRefreshKey((n) => n + 1);
        }}
      />

      <CommandDialog
        open={dialog.kind === "download"}
        onOpenChange={(o) => !o && close()}
        title={t("files.downloadToLocal")}
        description={t("files.downloadHint")}
        cmd="download"
        args={argsOf("download")}
        preset={dialog.kind === "download" ? { path: targetPath(dialog) } : undefined}
        hide={["path"]}
        submitLabel={t("files.download")}
      />

      <DecryptDialog
        open={dialog.kind === "decrypt"}
        onOpenChange={(o) => !o && close()}
        target={dialog.kind === "decrypt" ? dialog.target : null}
        cloudPath={dialog.kind === "decrypt" ? targetPath(dialog) : ""}
      />

      <ShareResultDialog
        open={shareResult !== null}
        onOpenChange={(o) => !o && setShareResult(null)}
        links={shareResult?.links ?? []}
        title={shareResult ? t("files.createShareLink") : ""}
        onCreateAnother={
          shareResult
            ? () => {
                const target = shareResult.target;
                setShareResult(null);
                setDialog({ kind: "share", target });
              }
            : undefined
        }
        onViewShares={
          onOpenShares
            ? () => {
                setShareResult(null);
                onOpenShares();
              }
            : undefined
        }
      />

      <InfoDialog
        item={infoTarget}
        baseDir={dir.path}
        schemas={schemas}
        onCreateShare={infoTarget ? () => setDialog({ kind: "share", target: infoTarget }) : undefined}
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
        title={t("files.confirmDelete")}
        description={
          <>
            <span className="break-all font-mono">
              {confirmDelete ? pathOf(confirmDelete) : ""}
            </span>
            <br />
            {t("files.deleteHint")}
          </>
        }
        confirmLabel={t("files.delete")}
        onConfirm={async () => {
          if (!confirmDelete) return;
          try {
            await run("delete", { path: pathOf(confirmDelete) }, t("op.delete"));
            toast.success(t("files.deleted"));
            await load(dir.path);
            setSearchRefreshKey((n) => n + 1);
          } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
          }
          setConfirmDelete(null);
        }}
      />

      <CommandDialog
        open={dialog.kind === "batch-move"}
        onOpenChange={(o) => !o && close()}
        title={t("files.batchMoveTo")}
        description={t("files.batchMoveDesc", { n: selected.length })}
        cmd="batch-move"
        args={argsOf("batch-move")}
        preset={{ paths: selectedPaths, dest: dir.path }}
        hide={["paths"]}
        submitLabel={t("files.batchMove")}
        onSuccess={() => {
          setSelected([]);
          void load(dir.path);
        }}
      />

      <CommandDialog
        open={dialog.kind === "batch-copy"}
        onOpenChange={(o) => !o && close()}
        title={t("files.batchCopyTo")}
        description={t("files.batchCopyDesc", { n: selected.length })}
        cmd="batch-copy"
        args={argsOf("batch-copy")}
        preset={{ paths: selectedPaths, dest: dir.path }}
        hide={["paths"]}
        submitLabel={t("files.batchCopy")}
        onSuccess={() => {
          setSelected([]);
          void load(dir.path);
        }}
      />

      <ConfirmDialog
        open={confirmBatchDelete}
        onOpenChange={(o) => !o && setConfirmBatchDelete(false)}
        title={t("files.confirmBatchDelete")}
        description={
          <>
            <span>{t("files.batchCount", { n: selected.length })}</span>
            <ul className="mt-1 max-h-32 overflow-auto font-mono text-xs">
              {selectedPaths.slice(0, 8).map((p) => (
                <li key={p} className="break-all">{p}</li>
              ))}
              {selectedPaths.length > 8 ? <li>{t("files.moreItems", { n: selectedPaths.length - 8 })}</li> : null}
            </ul>
            <br />
            {t("files.batchDeleteHint")}
          </>
        }
        confirmLabel={t("files.batchDelete")}
        onConfirm={async () => {
          const paths = selectedPaths;
          if (paths.length === 0) return;
          try {
            await run("batch-delete", { paths }, t("op.batchDelete"));
            toast.success(t("files.deletedN", { n: paths.length }));
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
