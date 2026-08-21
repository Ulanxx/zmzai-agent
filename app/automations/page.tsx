"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Badge, Button, Card, EmptyState, Icon, IconButton, Input, Navbar, Select as ThemeSelect, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@zmzai/theme";

type Workspace = { id: string; name: string };
type Automation = { automationId: string; workspaceId: string; projectId?: string | null; sourceTaskId?: string | null; name: string; goal: string; schedule: string; timezone: string; status: "active" | "paused"; lastRunAt: string | null; nextRunAt: string | null; lastRunStatus: "idle" | "running" | "succeeded" | "failed"; lastError: string | null; webhookSecretPrefix?: string | null };
type AutomationExecution = { executionId: string; taskId: string; source: "manual" | "schedule" | "webhook"; status: "queued" | "running" | "succeeded" | "failed" | "cancelled"; error: string | null; startedAt: string | null; finishedAt: string | null; createdAt: string };
type TriggerSecret = { secret: string; prefix: string; webhookUrl: string; emailUrl: string };

async function json<T>(url: string, init?: RequestInit): Promise<T> { const response = await fetch(url, { ...init, cache: "no-store" }); const body = await response.json().catch(() => null) as { error?: string } | T | null; if (!response.ok) throw new Error(body && typeof body === "object" && body !== null && "error" in body ? String(body.error) : "请求失败"); return body as T; }

function executionVariant(status: AutomationExecution["status"]) {
  if (status === "succeeded") return "success" as const;
  if (status === "failed") return "danger" as const;
  if (status === "running" || status === "queued") return "accent" as const;
  return "outline" as const;
}

const schedulePresets = ["手动运行", "每天 09:00", "工作日 09:00", "每小时", "*/15 * * * *"];

export default function AutomationsPage() {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]); const [items, setItems] = useState<Automation[]>([]); const [workspaceId, setWorkspaceId] = useState(""); const [name, setName] = useState(""); const [goal, setGoal] = useState(""); const [schedule, setSchedule] = useState("手动运行"); const [histories, setHistories] = useState<Record<string, AutomationExecution[]>>({}); const [secrets, setSecrets] = useState<Record<string, TriggerSecret>>({}); const [openTrigger, setOpenTrigger] = useState<string | null>(null); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState<string | null>(null);
  const fetchPage = () => Promise.all([json<{ workspaces: Workspace[] }>("/api/workspaces"), json<{ automations: Automation[] }>("/api/automations")]);
  const load = async () => { const [ws, automations] = await fetchPage(); setWorkspaces(ws.workspaces); setWorkspaceId((current) => current || ws.workspaces[0]?.id || ""); setItems(automations.automations); };
  useEffect(() => { let cancelled = false; void fetchPage().then(([ws, automations]) => { if (cancelled) return; setWorkspaces(ws.workspaces); setWorkspaceId((current) => current || ws.workspaces[0]?.id || ""); setItems(automations.automations); }).catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "无法加载自动化"); }); return () => { cancelled = true; }; }, []);
  const create = async () => { if (!name.trim() || !goal.trim() || !workspaceId) return; setBusy("create"); try { await json("/api/automations", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ workspaceId, name, goal, schedule, timezone: "Asia/Shanghai" }) }); setName(""); setGoal(""); setSchedule("手动运行"); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : "创建失败"); } finally { setBusy(null); } };
  const run = async (id: string) => { setBusy(id); try { const result = await json<{ session: { id: string } }>(`/api/automations/${id}/run`, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() } }); router.push(`/fw/s/${result.session.id}`); } catch (cause) { setError(cause instanceof Error ? cause.message : "启动失败"); setBusy(null); } };
  const toggle = async (item: Automation) => { setBusy(item.automationId); try { await json(`/api/automations/${item.automationId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: item.status === "active" ? "paused" : "active" }) }); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : "更新失败"); } finally { setBusy(null); } };
  const loadHistory = async (automationId: string) => { if (histories[automationId]) return; try { const result = await json<{ executions: AutomationExecution[] }>(`/api/automations/${automationId}/executions`); setHistories((current) => ({ ...current, [automationId]: result.executions })); } catch (cause) { setError(cause instanceof Error ? cause.message : "无法加载运行记录"); } };
  const generateSecret = async (item: Automation) => { setBusy(`secret:${item.automationId}`); setError(null); try { const result = await json<{ url: string; secret: string; prefix: string }>(`/api/automations/${item.automationId}/webhook-secret`, { method: "POST" }); setSecrets((current) => ({ ...current, [item.automationId]: { secret: result.secret, prefix: result.prefix, webhookUrl: result.url, emailUrl: result.url.replace(/\/webhook$/, "/email") } })); setOpenTrigger(item.automationId); } catch (cause) { setError(cause instanceof Error ? cause.message : "无法生成接入密钥"); } finally { setBusy(null); } };
  const copyValue = async (value: string) => { try { await navigator.clipboard.writeText(value); } catch { setError("复制失败，请手动选择内容"); } };
  const duplicate = async (item: Automation) => { setBusy(item.automationId); try { await json("/api/automations", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ workspaceId: item.workspaceId, ...(item.projectId ? { projectId: item.projectId } : {}), name: `${item.name} · 副本`, goal: item.goal, schedule: "手动运行", timezone: item.timezone }) }); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : "复制失败"); } finally { setBusy(null); } };
  const remove = async (item: Automation) => { if (!window.confirm(`删除自动化“${item.name}”？`)) return; setBusy(item.automationId); try { await json(`/api/automations/${item.automationId}`, { method: "DELETE" }); setItems((current) => current.filter((candidate) => candidate.automationId !== item.automationId)); } catch (cause) { setError(cause instanceof Error ? cause.message : "删除失败"); } finally { setBusy(null); } };

  return <main className="min-h-dvh bg-bg">
    <Navbar sublabel="agent" badge={<span className="rounded-full border border-line px-2 py-0.5 font-mono text-[11px] text-ink-3">a.zmzai.cloud</span>}>
      <Link href="/fw" className="text-xs text-ink-3 transition-colors hover:text-ink"><Icon name="arrow-left" size={12} className="mr-1 inline" />返回工作台</Link>
    </Navbar>
    <div className="mx-auto w-[min(100%-2rem,74rem)] py-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <small className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-3">重复工作</small>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">自动化</h1>
          <p className="mt-1 text-sm text-ink-3">把成功的任务保存成可手动或定时运行的模板。</p>
        </div>
        <Link href="/fw"><Button variant="secondary" size="sm">新对话 <Icon name="arrow-up-right" size={14} /></Button></Link>
      </header>
      {error && <div className="mb-4 rounded-sm border-l-2 border-danger bg-danger/10 px-3 py-2 text-sm text-ink" role="status">{error}</div>}

      <Card padding="md" className="mb-6">
        <div className="mb-3"><strong className="text-sm font-semibold text-ink">保存模板</strong><span className="ml-2 text-xs text-ink-3">每次运行会以新任务执行同一目标。</span></div>
        <div className="flex flex-wrap items-center gap-2">
          <ThemeSelect value={workspaceId} onValueChange={(value: string) => setWorkspaceId(value)}>
            <SelectTrigger className="w-auto" aria-label="选择 Workspace"><SelectValue placeholder="选择 Workspace" /></SelectTrigger>
            <SelectContent>{workspaces.map((workspace) => <SelectItem key={workspace.id} value={workspace.id}>{workspace.name}</SelectItem>)}</SelectContent>
          </ThemeSelect>
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="自动化名称" className="min-w-0 flex-1" />
          <Input value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="每次运行要完成什么" className="min-w-0 flex-1" />
          <Input value={schedule} list="automation-schedules" onChange={(event) => setSchedule(event.target.value)} placeholder="运行计划" aria-label="运行计划" className="w-44" />
          <datalist id="automation-schedules">{schedulePresets.map((preset) => <option key={preset} value={preset} />)}</datalist>
          <Button type="button" onClick={() => void create()} disabled={busy === "create" || !name.trim() || !goal.trim()}><Icon name="plus" size={14} />保存模板</Button>
        </div>
      </Card>

      <section className="flex flex-col gap-3">
        {items.length ? items.map((item) => (
          <Card key={item.automationId} padding="md">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-semibold text-ink">{item.name}</h2>
                  <Badge variant={item.status === "active" ? "success" : "outline"} size="sm">{item.status === "active" ? "已启用" : "已暂停"}</Badge>
                  {item.lastRunStatus === "failed" && <Badge variant="danger" size="sm">上次失败</Badge>}
                </div>
                <p className="mt-1 text-sm text-ink-2">{item.goal}</p>
                <small className="mt-1 block text-xs text-ink-3">{item.projectId ? "项目自动化" : "个人自动化"}{item.sourceTaskId ? ` · 来源任务 ${item.sourceTaskId}` : ""} · {item.schedule}{item.nextRunAt && item.status === "active" ? ` · 下次运行 ${new Date(item.nextRunAt).toLocaleString("zh-CN")}` : ""}{item.lastRunAt ? ` · 上次运行 ${new Date(item.lastRunAt).toLocaleString("zh-CN")}` : ""}</small>
                {item.lastRunStatus === "failed" && <p className="mt-1 text-sm text-danger">{item.lastError ?? "上次运行失败"}</p>}
                <details className="mt-2" onToggle={(event) => { if ((event.target as HTMLDetailsElement).open) void loadHistory(item.automationId); }}>
                  <summary className="cursor-pointer text-xs text-ink-3 hover:text-ink-2">运行记录</summary>
                  <div className="mt-2 flex flex-col gap-1">
                    {histories[item.automationId]?.map((execution) => (
                      <Link href={`/fw/t/${execution.taskId}`} key={execution.executionId} className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-ink-2 hover:bg-surface">
                        <Badge variant={executionVariant(execution.status)} size="sm">{execution.status === "succeeded" ? "成功" : execution.status === "failed" ? "失败" : execution.status}</Badge>
                        <span>{execution.source === "schedule" ? "定时" : "手动"} · {new Date(execution.createdAt).toLocaleString("zh-CN")}{execution.error ? ` · ${execution.error}` : ""}</span>
                      </Link>
                    ))}
                  </div>
                </details>
                {openTrigger === item.automationId && (
                  <div className="mt-3 rounded-sm border border-line bg-surface p-3">
                    <strong className="text-sm font-semibold text-ink">外部接入</strong>
                    <small className="mt-1 block text-xs text-ink-3">{secrets[item.automationId] ? `密钥 ${secrets[item.automationId]!.prefix} · 完整密钥仅本次显示` : `当前密钥前缀：${item.webhookSecretPrefix ?? "尚未生成"}`}</small>
                    {secrets[item.automationId] && <div className="mt-2 flex flex-col gap-1.5">
                      <label className="text-xs text-ink-3">Webhook 地址<Input readOnly value={secrets[item.automationId]!.webhookUrl} className="mt-0.5 font-mono text-xs" /></label>
                      <label className="text-xs text-ink-3">Email 地址<Input readOnly value={secrets[item.automationId]!.emailUrl} className="mt-0.5 font-mono text-xs" /></label>
                      <div className="flex items-end gap-2">
                        <label className="min-w-0 flex-1 text-xs text-ink-3">签名密钥<Input readOnly value={secrets[item.automationId]!.secret} className="mt-0.5 font-mono text-xs" /></label>
                        <IconButton size="sm" label="复制签名密钥" onClick={() => void copyValue(secrets[item.automationId]!.secret)}><Icon name="copy" size={13} /></IconButton>
                      </div>
                    </div>}
                  </div>
                )}
              </div>
              <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
                <Button type="button" variant="secondary" size="sm" disabled={busy === item.automationId || item.status === "paused"} onClick={() => void run(item.automationId)}><Icon name="play" size={13} />{item.lastRunStatus === "failed" ? "重试" : "运行"}</Button>
                <Button type="button" variant="secondary" size="sm" disabled={busy === `secret:${item.automationId}`} onClick={() => void generateSecret(item)}><Icon name="key" size={13} />接入</Button>
                <IconButton size="md" label={item.status === "active" ? "暂停" : "恢复"} onClick={() => void toggle(item)}><Icon name={item.status === "active" ? "pause" : "play"} size={13} /></IconButton>
                <IconButton size="md" label="复制自动化" disabled={busy === item.automationId} onClick={() => void duplicate(item)}><Icon name="copy" size={13} /></IconButton>
                <IconButton size="md" label="删除自动化" disabled={busy === item.automationId} onClick={() => void remove(item)}><Icon name="trash" size={13} /></IconButton>
              </div>
            </div>
          </Card>
        )) : <EmptyState icon={<Icon name="clock" size={24} />} title="还没有自动化" description="先完成一次任务，再把它保存为模板。" />}
      </section>
    </div>
  </main>;
}
