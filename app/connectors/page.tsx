"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Badge, Button, Card, EmptyState, Icon, IconButton, Input, Navbar, Select as ThemeSelect, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@zmzai/theme";

type Workspace = { id: string; name: string };
type Connector = { id: string; name: string; transport: string; url: string; status: "untested" | "ready" | "error"; enabled: boolean; lastError: string | null };
type GithubStatus = { configured: boolean; connected: boolean; connector: { id: string; status: Connector["status"]; lastError: string | null } | null };
async function json<T>(url: string, init?: RequestInit): Promise<T> { const response = await fetch(url, { ...init, cache: "no-store" }); const body = await response.json().catch(() => null) as { error?: string } | T | null; if (!response.ok) throw new Error(body && typeof body === "object" && body !== null && "error" in body ? String(body.error) : "请求失败"); return body as T; }

function statusVariant(status: Connector["status"]) {
  if (status === "ready") return "success" as const;
  if (status === "error") return "danger" as const;
  return "outline" as const;
}
function statusLabel(status: Connector["status"]) { return status === "ready" ? "可用" : status === "error" ? "异常" : "未测试"; }

export default function ConnectorsPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]); const [workspaceId, setWorkspaceId] = useState(""); const [items, setItems] = useState<Connector[]>([]); const [github, setGithub] = useState<GithubStatus | null>(null); const [name, setName] = useState(""); const [url, setUrl] = useState(""); const [transport, setTransport] = useState<"streamable-http" | "sse">("streamable-http"); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState<string | null>(null);
  const fetchPage = async (id?: string) => { const ws = await json<{ workspaces: Workspace[] }>("/api/workspaces"); const selected = id || workspaceId || ws.workspaces[0]?.id || ""; let connectors: Connector[] = []; let githubStatus: GithubStatus | null = null; if (selected) [{ connectors }, githubStatus] = await Promise.all([json<{ connectors: Connector[] }>(`/api/workspaces/${selected}/connectors`), json<GithubStatus>(`/api/connectors/github/status?workspaceId=${encodeURIComponent(selected)}`)]); return { workspaces: ws.workspaces, selected, connectors, github: githubStatus }; };
  const load = async (id?: string) => { const result = await fetchPage(id); setWorkspaces(result.workspaces); setWorkspaceId(result.selected); setItems(result.connectors); setGithub(result.github); };
  // Load the initial workspace once; workspace selection uses the explicit id path below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { let cancelled = false; void fetchPage().then((result) => { if (cancelled) return; setWorkspaces(result.workspaces); setWorkspaceId(result.selected); setItems(result.connectors); setGithub(result.github); }).catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "无法加载连接器"); }); return () => { cancelled = true; }; }, []);
  const selectWorkspace = (id: string) => { setWorkspaceId(id); void load(id).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "无法加载连接器")); };
  const create = async () => { if (!workspaceId || !name.trim() || !url.trim()) return; setBusy("create"); try { await json(`/api/workspaces/${workspaceId}/connectors`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, url, transport, headers: {} }) }); setName(""); setUrl(""); await load(workspaceId); } catch (cause) { setError(cause instanceof Error ? cause.message : "创建失败"); } finally { setBusy(null); } };
  const test = async (id: string) => { setBusy(id); try { await json(`/api/workspaces/${workspaceId}/connectors/${id}/test`, { method: "POST" }); await load(workspaceId); } catch (cause) { setError(cause instanceof Error ? cause.message : "连接测试失败"); } finally { setBusy(null); } };
  const toggle = async (item: Connector) => { setBusy(item.id); try { const connectorIds = items.filter((candidate) => candidate.enabled !== (candidate.id === item.id)).map((candidate) => candidate.id); await json(`/api/workspaces/${workspaceId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectorIds }) }); await load(workspaceId); } catch (cause) { setError(cause instanceof Error ? cause.message : "更新失败"); } finally { setBusy(null); } };
  const remove = async (item: Connector) => { setBusy(item.id); try { await json(`/api/workspaces/${workspaceId}/connectors/${item.id}`, { method: "DELETE" }); await load(workspaceId); } catch (cause) { setError(cause instanceof Error ? cause.message : "撤销连接失败"); } finally { setBusy(null); } };

  return <main className="min-h-dvh bg-bg">
    <Navbar sublabel="agent" badge={<span className="rounded-full border border-line px-2 py-0.5 font-mono text-[11px] text-ink-3">a.zmzai.cloud</span>}>
      <Link href="/fw" className="text-xs text-ink-3 transition-colors hover:text-ink"><Icon name="arrow-left" size={12} className="mr-1 inline" />返回工作台</Link>
    </Navbar>
    <div className="mx-auto w-[min(100%-2rem,74rem)] py-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <small className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-3">外部能力</small>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">连接器</h1>
          <p className="mt-1 text-sm text-ink-3">管理 Agent 可以访问的 MCP 服务和授权范围。</p>
        </div>
        <Link href="/fw"><Button variant="secondary" size="sm">新对话 <Icon name="arrow-up-right" size={14} /></Button></Link>
      </header>
      {error && <div className="mb-4 rounded-sm border-l-2 border-danger bg-danger/10 px-3 py-2 text-sm text-ink" role="status">{error}</div>}

      <Card padding="md" className="mb-6">
        <div className="mb-3"><strong className="text-sm font-semibold text-ink">添加连接器</strong><span className="ml-2 text-xs text-ink-3">公开 HTTPS MCP 地址，或连接 GitHub。</span></div>
        <div className="flex flex-wrap items-center gap-2">
          <ThemeSelect value={workspaceId} onValueChange={(value: string) => selectWorkspace(value)}>
            <SelectTrigger className="w-auto" aria-label="选择 Workspace"><SelectValue placeholder="选择 Workspace" /></SelectTrigger>
            <SelectContent>{workspaces.map((workspace) => <SelectItem key={workspace.id} value={workspace.id}>{workspace.name}</SelectItem>)}</SelectContent>
          </ThemeSelect>
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="连接器名称" className="min-w-0 flex-1" />
          <ThemeSelect value={transport} onValueChange={(value: string) => setTransport(value === "sse" ? "sse" : "streamable-http")}>
            <SelectTrigger className="w-auto" aria-label="MCP 传输方式"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="streamable-http">Streamable HTTP</SelectItem>
              <SelectItem value="sse">SSE（旧版 MCP）</SelectItem>
            </SelectContent>
          </ThemeSelect>
          <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder={transport === "sse" ? "https://example.com/sse" : "https://example.com/mcp"} className="min-w-[14rem] flex-1" />
          <Button type="button" onClick={() => void create()} disabled={busy === "create" || !name.trim() || !url.trim()}><Icon name="plus" size={14} />添加连接器</Button>
        </div>
      </Card>

      {workspaceId && github && github.configured && (
        <Card padding="md" className="mb-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2"><strong className="text-sm font-semibold text-ink">GitHub</strong><Badge variant={github.connected ? "success" : github.configured ? "warning" : "outline"} size="sm">{github.connected ? "已授权" : github.configured ? "可连接" : "尚未配置"}</Badge></div>
              <p className="mt-1 text-sm text-ink-3">{github.connected ? "Agent 可在每次批准后搜索仓库、查看议题并读取文件。" : github.configured ? "授权后可把 GitHub 的只读信息带入任务。" : "管理员需要设置 GITHUB_OAUTH_CLIENT_ID 和 GITHUB_OAUTH_CLIENT_SECRET。"}</p>
            </div>
            {github.configured && !github.connected && <a href={`/api/connectors/github/start?workspaceId=${encodeURIComponent(workspaceId)}`}><Button variant="secondary" size="sm"><Icon name="link" size={14} />连接 GitHub</Button></a>}
          </div>
        </Card>
      )}

      <section className="flex flex-col gap-3">
        {items.length ? items.map((item) => (
          <Card key={item.id} padding="md">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-semibold text-ink">{item.name}</h2>
                  <Badge variant={statusVariant(item.status)} size="sm">{statusLabel(item.status)}</Badge>
                  {!item.enabled && <Badge variant="outline" size="sm">已停用</Badge>}
                  <small className="font-mono text-xs text-ink-3">{item.transport}</small>
                </div>
                <p className="mt-1 truncate font-mono text-xs text-ink-3">{item.url}</p>
                {item.lastError && <p className="mt-1 text-sm text-danger">{item.lastError}</p>}
              </div>
              <div className="flex flex-shrink-0 items-center gap-2">
                <Button type="button" variant="secondary" size="sm" disabled={busy === item.id} onClick={() => void test(item.id)}><Icon name="refresh" size={13} />测试连接</Button>
                <IconButton size="md" label={item.enabled ? "停用连接器" : "启用连接器"} disabled={busy === item.id} onClick={() => void toggle(item)}><Icon name={item.enabled ? "pause" : "play"} size={13} /></IconButton>
                <IconButton size="md" label={item.transport === "github" ? "撤销 GitHub 授权" : "删除连接器"} disabled={busy === item.id} onClick={() => void remove(item)}><Icon name="trash" size={13} /></IconButton>
              </div>
            </div>
          </Card>
        )) : <EmptyState icon={<Icon name="link" size={24} />} title="还没有连接器" description="添加一个公开 HTTPS MCP 地址，或连接 GitHub。" />}
      </section>
    </div>
  </main>;
}
