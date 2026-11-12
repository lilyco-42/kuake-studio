import * as React from "react";
import { Cloud, FolderTree, Info, Link2, Loader2, Moon, Sun, Search as SearchIcon, User } from "lucide-react";

import { ConsolePanel } from "@/components/console-panel";
import { AccountView } from "@/components/views/account-view";
import { FilesView } from "@/components/views/files-view";
import { SearchView } from "@/components/views/search-view";
import { SharesView } from "@/components/views/shares-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useRunner } from "@/lib/store";
import { cn } from "@/lib/utils";

type Tab = "files" | "search" | "shares" | "account";

function readHash(): Tab {
  const h = location.hash.replace(/^#/, "");
  return h === "search" || h === "shares" || h === "account" ? h : "files";
}

const NAV: { id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "files", label: "文件", icon: FolderTree },
  { id: "search", label: "搜索", icon: SearchIcon },
  { id: "shares", label: "分享", icon: Link2 },
  { id: "account", label: "账号", icon: User },
];

export default function App() {
  const { booted, bootError, info, schemas, logs } = useRunner();
  const [tab, setTabState] = React.useState<Tab>(() => readHash());
  // 「搜索 → 跳到所在目录」：用递增 nonce 让 FilesView 重新拉指定目录
  const [filesJump, setFilesJump] = React.useState<{ path: string; nonce: number } | null>(null);
  const jumpSeq = React.useRef(0);

  // 用 location.hash 记住当前页（刷新/直达链接都落在同一页）
  const setTab = React.useCallback((t: Tab) => {
    setTabState(t);
    if (t !== "files") setFilesJump(null);
    if (location.hash !== "#" + t) history.replaceState(null, "", "#" + t);
  }, []);

  const openDir = React.useCallback(
    (path: string) => {
      jumpSeq.current += 1;
      setFilesJump({ path, nonce: jumpSeq.current });
      setTab("files");
    },
    [setTab],
  );

  React.useEffect(() => {
    const onHash = () => setTabState(readHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const [theme, setTheme] = React.useState<"dark" | "light">(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );

  React.useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.style.colorScheme = theme;
  }, [theme]);

  // 切到分享页时给出提示：分享列表依赖 share-list 命令
  const hasShares = schemas.some((s) => s.name === "share-list");
  // cli 回退模式下真 kuake 没有 search，侧栏直接禁用而不是让用户撞一鼻子错误
  const hasSearch = info?.backend !== "cli";

  if (bootError) {
    return (
      <div className="grid h-full place-items-center bg-background p-6">
        <div className="w-full max-w-lg rounded-xl border border-destructive/40 bg-card p-6">
          <div className="flex items-center gap-2 text-destructive">
            <Info className="size-4" />
            <h1 className="text-sm font-semibold">无法连接本地后端</h1>
          </div>
          <p className="mt-2 break-all text-xs text-muted-foreground">{bootError}</p>
          <ul className="mt-4 grid gap-1 text-[11.5px] text-muted-foreground">
            <li>· 确认后端进程仍在运行（终端里没有报错退出）</li>
            <li>· 确认浏览器地址是 http://127.0.0.1 上的端口，不是别的域名</li>
            <li>· 确认 KUAKE_COOKIE 有效，必要时重启程序</li>
          </ul>
          <div className="mt-4 flex gap-2">
            <Button size="sm" onClick={() => location.reload()}>
              重新加载
            </Button>
          </div>
          <pre className="mt-4 max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-[10.5px] text-muted-foreground">
            {logs.map((l) => l.text).join("\n")}
          </pre>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 flex-1">
        {/* 侧栏 */}
        <aside className="flex w-14 shrink-0 flex-col items-center gap-1 border-r bg-sidebar/60 py-2 md:w-52 md:items-stretch md:px-2">
          <div className="mb-2 hidden items-center gap-2 px-2 md:flex">
            <div className="grid size-8 place-items-center rounded-lg bg-primary/15 text-primary">
              <Cloud className="size-4" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold leading-tight">Kuake Studio</p>
              <p className="truncate text-[10.5px] text-muted-foreground">lilyco + shadcn</p>
            </div>
          </div>
          <div className="mb-2 grid size-9 place-items-center rounded-lg bg-primary/15 text-primary md:hidden">
            <Cloud className="size-4" />
          </div>

          <nav className="grid gap-0.5">
            {NAV.map((n) => {
              const Icon = n.icon;
              const active = tab === n.id;
              const disabled =
                (n.id === "shares" && !hasShares) || (n.id === "search" && !hasSearch);
              return (
                <button
                  key={n.id}
                  disabled={disabled}
                  onClick={() => setTab(n.id)}
                  title={n.id === "search" && !hasSearch ? "搜索仅在内置原生后端可用" : n.label}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-2 py-2 text-sm transition-colors",
                    "justify-center md:justify-start",
                    active
                      ? "bg-accent font-medium text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    disabled && "cursor-not-allowed opacity-40",
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="hidden md:inline">{n.label}</span>
                </button>
              );
            })}
          </nav>

          <div className="mt-auto grid gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="justify-center gap-2 px-2 text-xs text-muted-foreground md:justify-start"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              title="切换明暗主题"
            >
              {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
              <span className="hidden md:inline">{theme === "dark" ? "亮色" : "暗色"}</span>
            </Button>
            <div className="hidden px-2 pb-1 text-[10.5px] leading-4 text-muted-foreground md:block">
              <p className="truncate">{info?.name ?? "kuake-studio"}</p>
              <p className="truncate">
                {info?.backend === "cli" ? "kuake CLI 子进程" : "内置原生 API"} · v{info?.version ?? "?"}
              </p>
            </div>
          </div>
        </aside>

        {/* 主区 */}
        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center gap-2 border-b px-4 py-2">
            <h1 className="text-sm font-medium">{NAV.find((n) => n.id === tab)?.label}</h1>
            {booted ? (
              <Badge variant="muted" className="font-mono text-[10px]">
                {schemas.length} 个命令
              </Badge>
            ) : null}
            <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
              {booted ? (
                <>
                  <span className="size-1.5 rounded-full bg-success" />
                  已连接
                </>
              ) : (
                <>
                  <Loader2 className="size-3 animate-spin" />
                  正在握手…
                </>
              )}
            </div>
          </header>

          {!booted ? (
            <div className="grid gap-2 p-4">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-2/3" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : tab === "files" ? (
            <FilesView schemas={schemas} jump={filesJump} />
          ) : tab === "search" ? (
            <SearchView onOpenDir={openDir} />
          ) : tab === "shares" ? (
            <SharesView schemas={schemas} />
          ) : (
            <AccountView />
          )}
        </main>
      </div>

      <ConsolePanel />
    </div>
  );
}
