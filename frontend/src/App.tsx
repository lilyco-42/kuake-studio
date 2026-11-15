import * as React from "react";
import {
  Cloud,
  FolderTree,
  Info,
  Link2,
  Loader2,
  Moon,
  Search as SearchIcon,
  Trash2,
  Sun,
  User,
  Heart,
  Languages,
} from "lucide-react";

import { ConsolePanel } from "@/components/console-panel";
import { StartupDialog } from "@/components/commercial/startup-dialog";
import { AboutView } from "@/components/views/about-view";
import { AccountView } from "@/components/views/account-view";
import { FilesView } from "@/components/views/files-view";
import { SearchView } from "@/components/views/search-view";
import { RecycleView } from "@/components/views/recycle-view";
import { SharesView } from "@/components/views/shares-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/lib/i18n";
import { useRunner } from "@/lib/store";
import { cn } from "@/lib/utils";

type Tab = "files" | "search" | "shares" | "recycle" | "account" | "about";

function readHash(): Tab {
  const h = location.hash.replace(/^#/, "");
  return h === "search" || h === "shares" || h === "recycle" || h === "account" || h === "about" ? h : "files";
}

const NAV: { id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "files", label: "文件", icon: FolderTree },
  { id: "search", label: "搜索", icon: SearchIcon },
  { id: "shares", label: "分享", icon: Link2 },
  { id: "recycle", label: "回收站", icon: Trash2 },
  { id: "account", label: "账号", icon: User },
  { id: "about", label: "关于 / 赞助", icon: Heart },
];

export default function App() {
  const { booted, bootError, info, schemas, logs } = useRunner();
  const { t, lang, setLang } = useI18n();
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
    const onTabRequest = (e: Event) => {
      const next = (e as CustomEvent<string>).detail;
      if (next === "about") setTab("about");
    };
    window.addEventListener("hashchange", onHash);
    window.addEventListener("kuake-studio:set-tab", onTabRequest);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("kuake-studio:set-tab", onTabRequest);
    };
  }, [setTab]);

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
  // 回收站同样只在原生后端有（cli 回退模式没有 recycle-* 命令）
  const hasRecycle = schemas.some((s) => s.name === "recycle-list");

  if (bootError) {
    return (
      <div className="grid h-full place-items-center bg-background p-6">
        <div className="w-full max-w-lg rounded-xl border border-destructive/40 bg-card p-6">
          <div className="flex items-center gap-2 text-destructive">
            <Info className="size-4" />
            <h1 className="text-sm font-semibold">{t("boot.title")}</h1>
          </div>
          <p className="mt-2 break-all text-xs text-muted-foreground">{bootError}</p>
          <ul className="mt-4 grid gap-1 text-[11.5px] text-muted-foreground">
            <li>· {t("boot.hint1")}</li>
            <li>· {t("boot.hint2")}</li>
            <li>· {t("boot.hint3")}</li>
          </ul>
          <div className="mt-4 flex gap-2">
            <Button size="sm" onClick={() => location.reload()}>
              {t("boot.reload")}
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
              <p className="truncate text-[10.5px] text-muted-foreground">{t("brand.subtitle")}</p>
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
                (n.id === "shares" && !hasShares) ||
                (n.id === "search" && !hasSearch) ||
                (n.id === "recycle" && !hasRecycle);
              return (
                <button
                  key={n.id}
                  disabled={disabled}
                  onClick={() => setTab(n.id)}
                  title={
                    n.id === "search" && !hasSearch
                      ? t("cap.searchNative")
                      : n.id === "recycle" && !hasRecycle
                        ? t("cap.recycleNative")
                        : t("nav." + n.id)
                  }
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
                  <span className="hidden md:inline">{t("nav." + n.id)}</span>
                </button>
              );
            })}
          </nav>

          <div className="mt-auto grid gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="justify-center gap-2 px-2 text-xs text-muted-foreground md:justify-start"
              onClick={() => setLang(lang === "zh-CN" ? "en" : "zh-CN")}
              title={t("lang.toggle")}
            >
              <Languages className="size-4" />
              <span className="hidden md:inline">{t("lang.name")}</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="justify-center gap-2 px-2 text-xs text-muted-foreground md:justify-start"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              title={t("theme.toggle")}
            >
              {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
              <span className="hidden md:inline">{theme === "dark" ? t("theme.toLight") : t("theme.toDark")}</span>
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
            <h1 className="text-sm font-medium">{t("nav." + tab)}</h1>
            {booted ? (
              <Badge variant="muted" className="font-mono text-[10px]">
                {t("header.commands", { n: schemas.length })}
              </Badge>
            ) : null}
            <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
              {booted ? (
                <>
                  <span className="size-1.5 rounded-full bg-success" />
                  {t("header.connected")}
                </>
              ) : (
                <>
                  <Loader2 className="size-3 animate-spin" />
                  {t("header.connecting")}
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
          ) : tab === "recycle" ? (
            <RecycleView />
          ) : tab === "account" ? (
            <AccountView />
          ) : (
            <AboutView />
          )}
        </main>
      </div>

      <ConsolePanel />
      <StartupDialog />
    </div>
  );
}
