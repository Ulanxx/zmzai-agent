"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Button, Icon, IconButton } from "@zmzai/theme";

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

  return <main className="product-page developer-page">
    <header className="product-page-head"><div><Link href="/fw" className="product-back"><Icon name="arrow-left" size={14} />返回工作台</Link><span className="eyebrow">集成与 API</span><h1>开发者</h1><p>让内部服务或外部系统安全地创建任务、接收结果。</p></div><Link href="/fw" className="product-action-link">新对话 <Icon name="arrow-up-right" size={14} /></Link></header>
    {error && <div className="product-error" role="status">{error}</div>}
    {revealedSecret && <section className="developer-secret" aria-live="polite"><div><span className="eyebrow">仅显示一次</span><strong>{revealedSecret.kind}</strong><p>请立即保存。离开此页面后无法再次查看完整值。</p></div><div className="developer-secret-value"><code>{revealedSecret.value}</code><IconButton size="sm" label={`复制${revealedSecret.kind}`} onClick={() => void copy(revealedSecret.value)}><Icon name="copy" size={13} /></IconButton></div><IconButton size="sm" label="关闭密钥提示" onClick={() => setRevealedSecret(null)}><Icon name="cross" size={13} /></IconButton></section>}

    <section className="developer-section"><div className="developer-section-head"><div><span className="eyebrow">认证</span><h2>API Key</h2><p>每个 Key 都限定工作区与权限范围，可随时撤销。</p></div></div>
      <div className="developer-form developer-key-form"><input value={keyName} onChange={(event) => setKeyName(event.target.value)} placeholder="例如：数据同步服务" aria-label="API Key 名称" /><div className="developer-check-grid" role="group" aria-label="允许访问的工作区">{workspaces.map((workspace) => <label key={workspace.id}><input type="checkbox" checked={keyWorkspaces.includes(workspace.id)} onChange={() => setKeyWorkspaces((current) => toggle(current, workspace.id))} /><span>{workspace.name}</span></label>)}</div><div className="developer-scope-grid" role="group" aria-label="API Key 权限范围">{scopeOptions.map((scope) => <label key={scope.id}><input type="checkbox" checked={keyScopes.includes(scope.id)} onChange={() => setKeyScopes((current) => toggle(current, scope.id))} /><span><strong>{scope.label}</strong><small>{scope.detail}</small></span></label>)}</div><Button type="button" disabled={busy === "create-key" || !keyName.trim() || !keyWorkspaces.length || !keyScopes.length} onClick={() => void createKey()}><Icon name="key" size={14} />{busy === "create-key" ? "创建中" : "创建 API Key"}</Button></div>
      <div className="developer-list">{keys.length ? keys.map((key) => <article className="developer-row" key={key.id}><div className="developer-row-copy"><div className="developer-row-title"><Icon name="key" size={14} /><h3>{key.name}</h3><span className={`developer-state ${key.status}`}>{key.status === "active" ? "有效" : "已撤销"}</span></div><code>{key.prefix}...</code><p>{key.workspaceIds.map((id) => workspaceNames.get(id) ?? id).join(" · ")} · {key.scopes.map(scopeLabel).join(" · ")}</p><small>创建于 {time(key.createdAt)} · 最近使用 {time(key.lastUsedAt)}</small></div>{key.status === "active" && <IconButton size="sm" label={`撤销 ${key.name}`} disabled={busy === key.id} onClick={() => void revokeKey(key)}><Icon name="trash" size={13} /></IconButton>}</article>) : <div className="developer-empty">还没有 API Key。</div>}</div>
    </section>

    <section className="developer-section"><div className="developer-section-head"><div><span className="eyebrow">事件通知</span><h2>Webhook</h2><p>任务完成、失败或取消时，向你的服务发送已签名事件。</p></div><select value={workspaceId} onChange={(event) => selectWorkspace(event.target.value)} aria-label="选择 Webhook 工作区">{workspaces.map((workspace) => <option value={workspace.id} key={workspace.id}>{workspace.name}</option>)}</select></div>
      <div className="developer-form developer-webhook-form"><input value={webhookName} onChange={(event) => setWebhookName(event.target.value)} placeholder="Webhook 名称" aria-label="Webhook 名称" /><input value={webhookUrl} onChange={(event) => setWebhookUrl(event.target.value)} placeholder="https://example.com/hooks/zmzai" aria-label="Webhook 地址" /><div className="developer-event-row" role="group" aria-label="Webhook 事件">{eventOptions.map((event) => <label key={event.id}><input type="checkbox" checked={webhookEvents.includes(event.id)} onChange={() => setWebhookEvents((current) => toggle(current, event.id))} />{event.label}</label>)}</div><Button type="button" disabled={busy === "create-webhook" || !workspaceId || !webhookName.trim() || !webhookUrl.trim() || !webhookEvents.length} onClick={() => void createWebhook()}><Icon name="link" size={14} />{busy === "create-webhook" ? "创建中" : "添加 Webhook"}</Button></div>
      <div className="developer-list">{subscriptions.length ? subscriptions.map((subscription) => <article className="developer-row developer-webhook-row" key={subscription.id}><div className="developer-row-copy"><div className="developer-row-title"><span className={`developer-dot ${subscription.status}`} /><h3>{subscription.name}</h3><span className={`developer-state ${subscription.status}`}>{subscription.status === "active" ? "启用中" : "已暂停"}</span></div><code>{subscription.url}</code><p>{subscription.events.map((event) => eventOptions.find((option) => option.id === event)?.label ?? event).join(" · ")} · 签名 {subscription.secretPrefix}...</p><small>最近投递 {time(subscription.lastDeliveredAt)}</small>{subscription.lastError && <em>{subscription.lastError}</em>}{openDeliveries === subscription.id && <div className="developer-deliveries">{deliveries[subscription.id] ? deliveries[subscription.id].length ? deliveries[subscription.id].map((delivery) => <div className="developer-delivery" key={delivery.deliveryId}><span className={`developer-dot ${delivery.status}`} /><div><strong>{eventOptions.find((option) => option.id === delivery.eventType)?.label ?? delivery.eventType}</strong><small>{delivery.status === "delivered" ? `已投递 · HTTP ${delivery.responseStatus ?? "-"}` : `${delivery.status} · 第 ${delivery.attempts} 次尝试`}{delivery.lastError ? ` · ${delivery.lastError}` : ""}</small></div><time>{time(delivery.createdAt)}</time></div>) : <div className="developer-empty">还没有投递记录。</div> : <div className="developer-empty">正在加载投递记录…</div>}</div>}</div><div className="developer-row-actions"><Button type="button" variant="secondary" size="sm" disabled={busy === subscription.id} onClick={() => void toggleDeliveries(subscription)}><Icon name="activity" size={13} />投递记录</Button><IconButton size="sm" label={subscription.status === "active" ? "暂停 Webhook" : "恢复 Webhook"} disabled={busy === subscription.id} onClick={() => void updateWebhook(subscription)}><Icon name={subscription.status === "active" ? "pause" : "play"} size={13} /></IconButton><IconButton size="sm" label={`删除 ${subscription.name}`} disabled={busy === subscription.id} onClick={() => void deleteWebhook(subscription)}><Icon name="trash" size={13} /></IconButton></div></article>) : <div className="developer-empty">当前工作区还没有 Webhook。</div>}</div>
    </section>
  </main>;
}
