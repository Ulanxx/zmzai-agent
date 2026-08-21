"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { Badge, Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState, Icon, IconButton, Logo, Wordmark } from "@zmzai/theme";

export type RailTask = { task: { taskId: string; title: string; status: "draft" | "active" | "succeeded" | "failed" | "cancelled" }; latestRun: { status: string } | null };

/** 当前登录用户（me 401 → loggedIn=false）。 */
export function useLoggedIn() {
  const [user, setUser] = useState<{ name: string; email: string } | null>(null);
  const [loggedIn, setLoggedIn] = useState(true);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    void fetch("/api/fw/me", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) { setLoggedIn(false); setUser(null); return null; }
        return response.json() as Promise<{ user: { name: string; email: string } }>;
      })
      .then((body) => { if (body?.user) setUser(body.user); })
      .catch(() => setLoggedIn(false))
      .finally(() => setLoading(false));
  }, []);
  return { user, loggedIn, loading };
}

/** 未登录门帘：整页登录引导，代替残缺的"假空态/可交互表单"。 */
export function LoginGate({ title = "登录后继续" }: { title?: string }) {
  const href = process.env.NODE_ENV === "development" ? "/dev/login" : "https://auth.zmzai.cloud/login";
  return (
    <div className="grid min-h-dvh place-items-center bg-bg px-4">
      <EmptyState
        icon={<Icon name="user" size={28} />}
        title={title}
        description="此页面需要 zmzai cloud 账号。登录后任务、项目和成果都会在这里。"
        action={<a href={href}><Button><Icon name="arrow-up-right" size={14} />登录 zmzai cloud</Button></a>}
      />
    </div>
  );
}

function railStatusLabel(status: string) {
  return ({ succeeded: "已完成", failed: "需要处理", active: "进行中", running: "执行中", waiting_input: "等待补充", waiting_approval: "等待审批", paused: "已暂停", cancelled: "已取消", draft: "草稿", created: "准备中" } as Record<string, string>)[status] ?? status;
}
function railDotClass(status: string) {
  if (status === "succeeded") return "bg-success";
  if (status === "failed") return "bg-danger";
  if (status === "active" || status === "running" || status === "waiting_input" || status === "waiting_approval") return "bg-accent";
  return "bg-ink-3";
}

const NAV_LINKS = [
  { href: "/fw", label: "新任务", icon: "message", match: (path: string) => path === "/fw" || path.startsWith("/fw/s") || path.startsWith("/fw/t") },
  { href: "/fw/research", label: "广泛研究", icon: "search", match: (path: string) => path.startsWith("/fw/research") },
  { href: "/projects", label: "项目", icon: "folder", match: (path: string) => path.startsWith("/projects") },
  { href: "/artifacts", label: "成果", icon: "archive", match: (path: string) => path.startsWith("/artifacts") },
  { href: "/automations", label: "自动化", icon: "clock", match: (path: string) => path.startsWith("/automations") },
  { href: "/connectors", label: "连接器", icon: "link", match: (path: string) => path.startsWith("/connectors") },
  { href: "/developers", label: "开发者", icon: "key", match: (path: string) => path.startsWith("/developers") },
] as const;

/** 工作台统一左侧栏：品牌 + 导航 + 最近任务 + 登录状态。
 *  结构自由、控件全部走 @zmzai/theme（Logo/Wordmark/Badge/Icon/IconButton）。 */
export function WorkbenchRail({ tasks, activeTaskId, onNew, onOpen }: { tasks: RailTask[]; activeTaskId: string | null; onNew: () => void; onOpen: (taskId: string) => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, loggedIn } = useLoggedIn();

  const logout = useCallback(async () => {
    await fetch("/api/fw/logout", { method: "POST" }).catch(() => undefined);
    router.push("/fw");
    router.refresh();
  }, [router]);

  return (
    <>
    {/* 移动端（<md）：侧栏收起为顶部横条——品牌 + 横向导航 + 登录态 */}
    <header className="flex items-center gap-2 border-b border-line bg-surface px-3 py-2 md:hidden">
      <Link href="/fw" className="flex flex-shrink-0 items-center gap-1.5"><Logo size={20} /><Wordmark size={13} sublabel="agent" /></Link>
      <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" aria-label="主导航">
        {NAV_LINKS.map((item) => (
          <Link key={item.href} href={item.href} className={`flex-shrink-0 rounded-md px-2 py-1.5 text-xs ${item.match(pathname) ? "bg-bg font-medium text-ink" : "text-ink-2"}`}>{item.label}</Link>
        ))}
      </nav>
      {loggedIn && user
        ? <IconButton size="sm" label="退出登录" onClick={() => void logout()}><Icon name="logout" size={12} /></IconButton>
        : <a className="flex-shrink-0 rounded-md border border-line px-2 py-1.5 text-xs text-ink-2" href={process.env.NODE_ENV === "development" ? "/dev/login" : "https://auth.zmzai.cloud/login"}>登录</a>}
    </header>
    <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-line bg-surface md:flex">
      <div className="flex items-center justify-between px-4 py-4">
        <Link href="/fw" className="flex items-center gap-2" title="zmzai cloud">
          <Logo size={24} />
          <Wordmark size={15} sublabel="agent" />
        </Link>
        <IconButton size="md" label="新对话" onClick={onNew}><Icon name="plus" size={15} /></IconButton>
      </div>

      <nav className="flex flex-col gap-0.5 px-2" aria-label="主导航">
        {NAV_LINKS.map((item) => {
          const active = item.match(pathname);
          return (
            <Link key={item.href} href={item.href} className={`flex items-center gap-2 rounded-md px-2.5 py-2 text-sm transition-colors ${active ? "bg-bg font-medium text-ink shadow-xs" : "text-ink-2 hover:bg-bg hover:text-ink"}`}>
              <Icon name={item.icon} size={14} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-5 flex min-h-0 flex-1 flex-col px-2">
        <div className="flex items-center justify-between px-2.5 pb-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-ink-3">最近任务</span>
          {tasks.length > 0 && <Badge variant="outline" size="sm">{tasks.length}</Badge>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {tasks.length ? tasks.slice(0, 20).map(({ task, latestRun }) => {
            const status = latestRun?.status ?? task.status;
            return (
              <button key={task.taskId} type="button" className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors ${activeTaskId === task.taskId ? "bg-bg shadow-xs" : "hover:bg-bg"}`} onClick={() => onOpen(task.taskId)}>
                <span className="min-w-0 flex-1"><strong className="block truncate text-xs font-medium text-ink">{task.title || "未命名任务"}</strong><small className="text-[11px] text-ink-3">{railStatusLabel(status)}</small></span>
                <span className={`size-1.5 flex-shrink-0 rounded-full ${railDotClass(status)}`} title={railStatusLabel(status)} aria-label={railStatusLabel(status)} />
              </button>
            );
          }) : <p className="px-2.5 py-2 text-xs text-ink-3">完成的任务会出现在这里。</p>}
        </div>
      </div>

      <div className="border-t border-line px-3 py-3">
        {loggedIn && user ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-bg" title="用户中心">
                <span className="grid size-8 place-items-center rounded-sm border border-line bg-bg font-mono text-xs text-ink-2">{user.name.slice(0, 1).toUpperCase()}</span>
                <span className="min-w-0 flex-1"><strong className="block truncate text-xs font-medium text-ink">{user.name}</strong><small className="block truncate text-[11px] text-ink-3">{user.email}</small></span>
                <Icon name="chevron-up" size={12} className="text-ink-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" className="w-56">
              <DropdownMenuLabel className="font-mono text-[11px] text-ink-3">{user.email}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => window.open("https://zmzai.cloud", "_blank", "noreferrer")}><Icon name="home" size={13} />主站 zmzai.cloud</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => window.open("https://m.zmzai.cloud", "_blank", "noreferrer")}><Icon name="message" size={13} />模型服务 m.zmzai.cloud</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => window.open("https://muzhi.zmzai.cloud", "_blank", "noreferrer")}><Icon name="book" size={13} />课程站 muzhi</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => router.push("/audit")}><Icon name="activity" size={13} />运行记录</DropdownMenuItem>
              <DropdownMenuItem destructive onSelect={() => void logout()}><Icon name="logout" size={13} />退出登录</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <a href={process.env.NODE_ENV === "development" ? "/dev/login" : "https://auth.zmzai.cloud/login"} className="flex items-center justify-center gap-2 rounded-md border border-line bg-bg px-3 py-2 text-xs font-medium text-ink hover:bg-surface-2">
            <Icon name="user" size={13} />登录 zmzai cloud
          </a>
        )}
      </div>
    </aside>
    </>
  );
}
