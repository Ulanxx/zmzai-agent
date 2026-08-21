"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Badge, Button, Card, EmptyState, Icon, IconButton, Input, Navbar, Select as ThemeSelect, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@zmzai/theme";

type Workspace = { id: string; name: string };
type ApiKeyScope = "tasks:write" | "tasks:read" | "artifacts:read" | "webhooks:write";
type ApiKey = { id: string; prefix: string; name: string; workspaceIds: string[]; scopes: ApiKeyScope[]; status: "active" | "revoked"; lastUsedAt: string | null; revokedAt: string | null; createdAt: string };
type WebhookEvent = "task.succeeded" | "task.failed" | "task.cancelled";
type Subscription = { id: string; workspaceId: string; name: string; url: string; events: WebhookEvent[]; status: "active" | "paused"; secretPrefix: string; lastDeliveredAt: string | null; lastError: string | null; createdAt: string };
type Delivery = { deliveryId: string; eventType: WebhookEvent; taskId: string; runId: string; status: "pending" | "delivering" | "delivered" | "failed"; attempts: number; nextAttemptAt: string; responseStatus: number | null; lastError: string | null; deliveredAt: string | null; createdAt: string };

const scopeOptions: Array<{ id: ApiKeyScope; label: string; detail: string }> = [
  { id: "tasks:write", label: "创建任务", detail: "通过 API 发起 Agent 任务" },
  { id: "tasks:read", label: "读取任务", detail: "查询状态和结构化结果" },
  { id: "artifacts:read", label: "读取成果", detail: "下载任务生成的文件" },
  { id: "webhooks:write", label: "管理 Webhook", detail: "保留给服务端集成管理" },
];
const eventOptions: Array<{ id: WebhookEvent; label: string }> = [
  { id: "task.succeeded", label: "任务完成" },
  { id: "task.failed", label: "任务失败" },
  { id: "task.cancelled", label: "任务取消" },
];

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const body = await response.json().catch(() => null) as { error?: string } | T | null;
  if (!response.ok) throw new Error(body && typeof body === "object" && body !== null && "error" in body ? String(body.error) : "请求失败");
  return body as T;
}

function time(value: string | null) {
  return value ? new Date(value).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" }) : "尚未使用";
}

function scopeLabel(scope: ApiKeyScope) {
  return scopeOptions.find((option) => option.id === scope)?.label ?? scope;
}

function deliveryVariant(status: Delivery["status"]) {
  if (status === "delivered") return "success" as const;
  if (status === "failed") return "danger" as const;
  return "warning" as const;
}

export default function DevelopersPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [keyName, setKeyName] = useState("");
  const [keyWorkspaces, setKeyWorkspaces] = useState<string[]>([]);
  const [keyScopes, setKeyScopes] = useState<ApiKeyScope[]>(["tasks:write", "tasks:read", "artifacts:read"]);
  const [webhookName, setWebhookName] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookEvents, setWebhookEvents] = useState<WebhookEvent[]>(["task.succeeded", "task.failed"]);
  const [revealedSecret, setRevealedSecret] = useState<{ kind: "API Key" | "Webhook 签名密钥"; value: string } | null>(null);
  const [deliveries, setDeliveries] = useState<Record<string, Delivery[]>>({});
  const [openDeliveries, setOpenDeliveries] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const workspaceNames = useMemo(() => new Map(workspaces.map((workspace) => [workspace.id, workspace.name])), [workspaces]);
  const fetchPage = async (selectedWorkspaceId?: string) => {
    const ws = await json<{ workspaces: Workspace[] }>("/api/workspaces");
    const selected = selectedWorkspaceId ?? (workspaceId || ws.workspaces[0]?.id || "");
    const [keyResult, webhookResult] = await Promise.all([
      json<{ keys: ApiKey[] }>("/api/api-keys"),
      selected ? json<{ subscriptions: Subscription[] }>(`/api/webhooks?workspaceId=${encodeURIComponent(selected)}`) : Promise.resolve({ subscriptions: [] }),
    ]);
    return { workspaces: ws.workspaces, selected, keys: keyResult.keys, subscriptions: webhookResult.subscriptions };
  };
  const applyPage = (page: Awaited<ReturnType<typeof fetchPage>>) => {
    setWorkspaces(page.workspaces);
    setWorkspaceId(page.selected);
    setKeyWorkspaces((current) => current.length ? current : (page.selected ? [page.selected] : []));
    setKeys(page.keys);
    setSubscriptions(page.subscriptions);
  };
  const load = async (selectedWorkspaceId?: string) => {
    const page = await fetchPage(selectedWorkspaceId);
    applyPage(page);
  };

  useEffect(() => {
    let cancelled = false;
    void fetchPage().then((page) => { if (!cancelled) applyPage(page); }).catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "无法加载开发者设置"); });
    return () => { cancelled = true; };
    // Initial state is intentionally loaded once; later workspace changes call load explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = <T extends string,>(items: T[], item: T) => items.includes(item) ? items.filter((value) => value !== item) : [...items, item];
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); }
    catch { setError("浏览器未允许复制，请手动复制该值"); }
  };
  const selectWorkspace = (nextWorkspaceId: string) => {
    setWorkspaceId(nextWorkspaceId);
    setOpenDeliveries(null);
    void load(nextWorkspaceId).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "无法加载 Webhook"));
  };
  const createKey = async () => {
    if (!keyName.trim() || !keyWorkspaces.length || !keyScopes.length) return;
    setBusy("create-key"); setError(null);
    try {
      const created = await json<{ key: string; record: ApiKey }>("/api/api-keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: keyName, workspaceIds: keyWorkspaces, scopes: keyScopes }) });
      setKeys((current) => [created.record, ...current]); setKeyName(""); setRevealedSecret({ kind: "API Key", value: created.key });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "创建 API Key 失败"); }
    finally { setBusy(null); }
  };
  const revokeKey = async (key: ApiKey) => {
    if (!window.confirm(`撤销 API Key “${key.name}”？该操作无法恢复。`)) return;
    setBusy(key.id); setError(null);
    try {
      await json(`/api/api-keys/${encodeURIComponent(key.id)}`, { method: "DELETE" });
      setKeys((current) => current.map((item) => item.id === key.id ? { ...item, status: "revoked", revokedAt: new Date().toISOString() } : item));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "撤销 API Key 失败"); }
    finally { setBusy(null); }
  };
  const createWebhook = async () => {
    if (!workspaceId || !webhookName.trim() || !webhookUrl.trim() || !webhookEvents.length) return;
    setBusy("create-webhook"); setError(null);
    try {
      const created = await json<{ subscription: Subscription; secret: string }>("/api/webhooks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, name: webhookName, url: webhookUrl, events: webhookEvents }) });
      setSubscriptions((current) => [created.subscription, ...current]); setWebhookName(""); setWebhookUrl(""); setRevealedSecret({ kind: "Webhook 签名密钥", value: created.secret });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "创建 Webhook 失败"); }
    finally { setBusy(null); }
  };
  const updateWebhook = async (subscription: Subscription) => {
    setBusy(subscription.id); setError(null);
    try {
      const result = await json<{ subscription: Subscription }>(`/api/webhooks/${encodeURIComponent(subscription.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: subscription.status === "active" ? "paused" : "active" }) });
      setSubscriptions((current) => current.map((item) => item.id === subscription.id ? result.subscription : item));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "更新 Webhook 失败"); }
    finally { setBusy(null); }
  };
  const deleteWebhook = async (subscription: Subscription) => {
    if (!window.confirm(`删除 Webhook “${subscription.name}”？未投递的事件将停止发送。`)) return;
    setBusy(subscription.id); setError(null);
    try {
      await json(`/api/webhooks/${encodeURIComponent(subscription.id)}`, { method: "DELETE" });
      setSubscriptions((current) => current.filter((item) => item.id !== subscription.id));
      setOpenDeliveries((current) => current === subscription.id ? null : current);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "删除 Webhook 失败"); }
    finally { setBusy(null); }
  };
  const toggleDeliveries = async (subscription: Subscription) => {
    if (openDeliveries === subscription.id) { setOpenDeliveries(null); return; }
    setOpenDeliveries(subscription.id);
    if (deliveries[subscription.id]) return;
    try {
      const result = await json<{ deliveries: Delivery[] }>(`/api/webhooks/${encodeURIComponent(subscription.id)}/deliveries`);
      setDeliveries((current) => ({ ...current, [subscription.id]: result.deliveries }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法加载投递记录"); }
  };

  return <main className="min-h-dvh bg-bg">
    <Navbar sublabel="agent" badge={<span className="rounded-full border border-line px-2 py-0.5 font-mono text-[11px] text-ink-3">a.zmzai.cloud</span>}>
      <Link href="/fw" className="text-xs text-ink-3 transition-colors hover:text-ink"><Icon name="arrow-left" size={12} className="mr-1 inline" />返回工作台</Link>
    </Navbar>
    <div className="mx-auto w-[min(100%-2rem,74rem)] py-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <small className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-3">集成与 API</small>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">开发者</h1>
          <p className="mt-1 text-sm text-ink-3">让内部服务或外部系统安全地创建任务、接收结果。</p>
        </div>
        <Link href="/fw"><Button variant="secondary" size="sm">新对话 <Icon name="arrow-up-right" size={14} /></Button></Link>
      </header>
      {error && <div className="mb-4 rounded-sm border-l-2 border-danger bg-danger/10 px-3 py-2 text-sm text-ink" role="status">{error}</div>}

      {revealedSecret && (
        <Card padding="sm" className="mb-6 border-warning/60">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2"><Badge variant="warning" size="sm">仅显示一次</Badge><strong className="text-sm font-semibold text-ink">{revealedSecret.kind}</strong></div>
              <p className="mt-1 text-xs text-ink-3">请立即保存。离开此页面后无法再次查看完整值。</p>
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-sm border border-line bg-surface px-2 py-1 font-mono text-xs text-ink">{revealedSecret.value}</code>
              <IconButton size="sm" label={`复制${revealedSecret.kind}`} onClick={() => void copy(revealedSecret.value)}><Icon name="copy" size={13} /></IconButton>
              <IconButton size="sm" label="关闭密钥提示" onClick={() => setRevealedSecret(null)}><Icon name="cross" size={13} /></IconButton>
            </div>
          </div>
        </Card>
      )}

      <section className="mb-8">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <small className="block text-[10px] font-semibold uppercase tracking-wide text-ink-3">认证</small>
            <h2 className="text-lg font-semibold tracking-tight text-ink">API Key</h2>
            <p className="text-sm text-ink-3">每个 Key 都限定工作区与权限范围，可随时撤销。</p>
          </div>
        </div>
        <Card padding="md" className="mb-3">
          <div className="flex flex-col gap-3">
            <Input value={keyName} onChange={(event) => setKeyName(event.target.value)} placeholder="例如：数据同步服务" aria-label="API Key 名称" />
            <div role="group" aria-label="允许访问的工作区">
              <small className="mb-1.5 block text-xs font-semibold text-ink-3">工作区范围</small>
              <div className="flex flex-wrap gap-2">
                {workspaces.map((workspace) => {
                  const active = keyWorkspaces.includes(workspace.id);
                  return <Button key={workspace.id} type="button" size="sm" variant={active ? "primary" : "secondary"} onClick={() => setKeyWorkspaces((current) => toggle(current, workspace.id))}><Icon name={active ? "check" : "plus"} size={12} />{workspace.name}</Button>;
                })}
              </div>
            </div>
            <div role="group" aria-label="API Key 权限范围">
              <small className="mb-1.5 block text-xs font-semibold text-ink-3">权限范围</small>
              <div className="flex flex-wrap gap-2">
                {scopeOptions.map((scope) => {
                  const active = keyScopes.includes(scope.id);
                  return <Button key={scope.id} type="button" size="sm" variant={active ? "primary" : "secondary"} title={scope.detail} onClick={() => setKeyScopes((current) => toggle(current, scope.id))}><Icon name={active ? "check" : "plus"} size={12} />{scope.label}</Button>;
                })}
              </div>
            </div>
            <div><Button type="button" disabled={busy === "create-key" || !keyName.trim() || !keyWorkspaces.length || !keyScopes.length} onClick={() => void createKey()}><Icon name="key" size={14} />{busy === "create-key" ? "创建中" : "创建 API Key"}</Button></div>
          </div>
        </Card>
        <div className="flex flex-col gap-3">
          {keys.length ? keys.map((key) => (
            <Card key={key.id} padding="md">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2"><Icon name="key" size={14} className="text-ink-3" /><h3 className="text-base font-semibold text-ink">{key.name}</h3><Badge variant={key.status === "active" ? "success" : "outline"} size="sm">{key.status === "active" ? "有效" : "已撤销"}</Badge></div>
                  <code className="mt-1 block font-mono text-xs text-ink-3">{key.prefix}...</code>
                  <p className="mt-1 text-sm text-ink-2">{key.workspaceIds.map((id) => workspaceNames.get(id) ?? id).join(" · ")} · {key.scopes.map(scopeLabel).join(" · ")}</p>
                  <small className="text-xs text-ink-3">创建于 {time(key.createdAt)} · 最近使用 {time(key.lastUsedAt)}</small>
                </div>
                {key.status === "active" && <IconButton size="md" label={`撤销 ${key.name}`} disabled={busy === key.id} onClick={() => void revokeKey(key)}><Icon name="trash" size={13} /></IconButton>}
              </div>
            </Card>
          )) : <EmptyState icon={<Icon name="key" size={24} />} title="还没有 API Key" description="创建一个限定范围的 Key 开始集成。" />}
        </div>
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <small className="block text-[10px] font-semibold uppercase tracking-wide text-ink-3">事件通知</small>
            <h2 className="text-lg font-semibold tracking-tight text-ink">Webhook</h2>
            <p className="text-sm text-ink-3">任务完成、失败或取消时，向你的服务发送已签名事件。</p>
          </div>
          <ThemeSelect value={workspaceId} onValueChange={(value: string) => selectWorkspace(value)}>
            <SelectTrigger className="w-auto" aria-label="选择 Webhook 工作区"><SelectValue placeholder="选择工作区" /></SelectTrigger>
            <SelectContent>{workspaces.map((workspace) => <SelectItem value={workspace.id} key={workspace.id}>{workspace.name}</SelectItem>)}</SelectContent>
          </ThemeSelect>
        </div>
        <Card padding="md" className="mb-3">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              <Input value={webhookName} onChange={(event) => setWebhookName(event.target.value)} placeholder="Webhook 名称" aria-label="Webhook 名称" className="min-w-0 flex-1" />
              <Input value={webhookUrl} onChange={(event) => setWebhookUrl(event.target.value)} placeholder="https://example.com/hooks/zmzai" aria-label="Webhook 地址" className="min-w-0 flex-1" />
            </div>
            <div role="group" aria-label="Webhook 事件">
              <small className="mb-1.5 block text-xs font-semibold text-ink-3">订阅事件</small>
              <div className="flex flex-wrap gap-2">
                {eventOptions.map((event) => {
                  const active = webhookEvents.includes(event.id);
                  return <Button key={event.id} type="button" size="sm" variant={active ? "primary" : "secondary"} onClick={() => setWebhookEvents((current) => toggle(current, event.id))}><Icon name={active ? "check" : "plus"} size={12} />{event.label}</Button>;
                })}
              </div>
            </div>
            <div><Button type="button" disabled={busy === "create-webhook" || !workspaceId || !webhookName.trim() || !webhookUrl.trim() || !webhookEvents.length} onClick={() => void createWebhook()}><Icon name="link" size={14} />{busy === "create-webhook" ? "创建中" : "添加 Webhook"}</Button></div>
          </div>
        </Card>
        <div className="flex flex-col gap-3">
          {subscriptions.length ? subscriptions.map((subscription) => (
            <Card key={subscription.id} padding="md">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2"><h3 className="text-base font-semibold text-ink">{subscription.name}</h3><Badge variant={subscription.status === "active" ? "success" : "outline"} size="sm">{subscription.status === "active" ? "启用中" : "已暂停"}</Badge></div>
                  <code className="mt-1 block truncate font-mono text-xs text-ink-3">{subscription.url}</code>
                  <p className="mt-1 text-sm text-ink-2">{subscription.events.map((event) => eventOptions.find((option) => option.id === event)?.label ?? event).join(" · ")} · 签名 {subscription.secretPrefix}...</p>
                  <small className="text-xs text-ink-3">最近投递 {time(subscription.lastDeliveredAt)}</small>
                  {subscription.lastError && <p className="mt-1 text-sm text-danger">{subscription.lastError}</p>}
                  {openDeliveries === subscription.id && (
                    <div className="mt-2 flex flex-col gap-1.5 rounded-sm border border-line bg-surface p-3">
                      {deliveries[subscription.id] ? deliveries[subscription.id].length ? deliveries[subscription.id].map((delivery) => (
                        <div className="flex items-center gap-2 text-xs text-ink-2" key={delivery.deliveryId}>
                          <Badge variant={deliveryVariant(delivery.status)} size="sm">{delivery.status === "delivered" ? "已投递" : delivery.status === "failed" ? "失败" : "投递中"}</Badge>
                          <div className="min-w-0"><strong className="block text-ink">{eventOptions.find((option) => option.id === delivery.eventType)?.label ?? delivery.eventType}</strong><small>{delivery.status === "delivered" ? `HTTP ${delivery.responseStatus ?? "-"}` : `第 ${delivery.attempts} 次尝试`}{delivery.lastError ? ` · ${delivery.lastError}` : ""}</small></div>
                          <time className="ml-auto flex-shrink-0 text-ink-3">{time(delivery.createdAt)}</time>
                        </div>
                      )) : <p className="text-xs text-ink-3">还没有投递记录。</p> : <p className="text-xs text-ink-3">正在加载投递记录…</p>}
                    </div>
                  )}
                </div>
                <div className="flex flex-shrink-0 items-center gap-2">
                  <Button type="button" variant="secondary" size="sm" disabled={busy === subscription.id} onClick={() => void toggleDeliveries(subscription)}><Icon name="activity" size={13} />投递记录</Button>
                  <IconButton size="md" label={subscription.status === "active" ? "暂停 Webhook" : "恢复 Webhook"} disabled={busy === subscription.id} onClick={() => void updateWebhook(subscription)}><Icon name={subscription.status === "active" ? "pause" : "play"} size={13} /></IconButton>
                  <IconButton size="md" label={`删除 ${subscription.name}`} disabled={busy === subscription.id} onClick={() => void deleteWebhook(subscription)}><Icon name="trash" size={13} /></IconButton>
                </div>
              </div>
            </Card>
          )) : <EmptyState icon={<Icon name="link" size={24} />} title="当前工作区还没有 Webhook" description="添加一个接收端点，任务事件会签名后推送。" />}
        </div>
      </section>
    </div>
  </main>;
}
