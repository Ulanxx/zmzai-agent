"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { Button, Icon, ModelSelector, Navbar, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, navItemClass, type ModelSelectorData, type ModelSelectorValue } from "@zmzai/theme";

type WorkspaceDetail = {
  id: string;
  name: string;
  description: string;
  defaultModel: string;
  approvalMode: "ask" | "auto" | "always";
  prompt: string;
  steps: number;
  skillIds: string[];
  pluginIds: string[];
};

type WorkspaceSkill = { id: string; name: string; description: string; repository: string; path: string };
type WorkspacePlugin = { id: string; name: string; description: string; version: string; skillCount: number; errors: string[] };
type WorkspaceBudget = { maxConcurrentRuns: number; monthlyTokenBudget: number; usedTokens: number; reservedRuns: number; usagePeriod: string };

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const body = (await response.json().catch(() => null)) as { error?: string } | T | null;
  if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "请求失败");
  return body as T;
}

export function WorkspaceConfig({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [detail, setDetail] = useState<WorkspaceDetail | null>(null);
  const [modelSelectorData, setModelSelectorData] = useState<ModelSelectorData | null>(null);
  const [modelValue, setModelValue] = useState<ModelSelectorValue>({ model: "" });
  const model = modelValue.model;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [steps, setSteps] = useState(12);
  const [approvalMode, setApprovalMode] = useState<"ask" | "auto">("ask");
  const [skills, setSkills] = useState<WorkspaceSkill[]>([]);
  const [plugins, setPlugins] = useState<WorkspacePlugin[]>([]);
  const [repository, setRepository] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [capabilityBusy, setCapabilityBusy] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [budget, setBudget] = useState<WorkspaceBudget | null>(null);
  const [budgetBusy, setBudgetBusy] = useState(false);

  const remove = useCallback(async () => {
    if (!detail || deleting) return;
    setDeleting(true);
    try {
      await json(`/api/workspaces/${encodeURIComponent(detail.id)}`, { method: "DELETE" });
      router.push("/fw");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除失败");
      setDeleting(false);
    }
  }, [detail, deleting, router]);

  const applyDetail = useCallback((ws: WorkspaceDetail) => {
    setDetail(ws);
    setName(ws.name);
    setDescription(ws.description);
    setPrompt(ws.prompt);
    setModelValue({ model: ws.defaultModel });
    setSteps(ws.steps);
    // 历史值 "always" 等同逐项审批，归入 ask 档显示。
    setApprovalMode(ws.approvalMode === "auto" ? "auto" : "ask");
  }, []);

  useEffect(() => {
    void Promise.all([
      json<{ workspace: WorkspaceDetail }>(`/api/workspaces/${encodeURIComponent(workspaceId)}`).then((body) => applyDetail(body.workspace)),
      fetch("/api/models", { cache: "no-store" }).then((r) => r.ok ? r.json() as Promise<{ modelSelectorData: ModelSelectorData }> : Promise.reject(new Error("failed"))).then((body) => setModelSelectorData(body.modelSelectorData)),
      json<{ skills: WorkspaceSkill[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/skills`).then((body) => setSkills(body.skills)),
      json<{ plugins: WorkspacePlugin[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/plugins`).then((body) => setPlugins(body.plugins)),
      json<{ budget: WorkspaceBudget }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/budget`).then((body) => setBudget(body.budget)),
    ]).catch((cause) => setError(cause instanceof Error ? cause.message : "无法加载智能体配置"));
  }, [workspaceId, applyDetail]);

  const saveBudget = useCallback(async () => {
    if (!budget || budgetBusy) return;
    setBudgetBusy(true);
    setError(null);
    try {
      const result = await json<{ budget: WorkspaceBudget }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/budget`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxConcurrentRuns: budget.maxConcurrentRuns, monthlyTokenBudget: budget.monthlyTokenBudget }) });
      setBudget(result.budget);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存预算失败"); }
    finally { setBudgetBusy(false); }
  }, [budget, budgetBusy, workspaceId]);

  const updateCapabilities = useCallback(async (patch: Partial<Pick<WorkspaceDetail, "skillIds" | "pluginIds">>) => {
    const body = await json<{ workspace: WorkspaceDetail }>(`/api/workspaces/${encodeURIComponent(workspaceId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
    applyDetail(body.workspace);
  }, [applyDetail, workspaceId]);

  const toggleCapability = useCallback(async (kind: "skill" | "plugin", id: string, enabled: boolean) => {
    if (!detail) return;
    const key = `${kind}:${id}`;
    setCapabilityBusy(key);
    setError(null);
    try {
      const current = kind === "skill" ? detail.skillIds : detail.pluginIds;
      const ids = enabled ? [...current, id] : current.filter((value) => value !== id);
      await updateCapabilities(kind === "skill" ? { skillIds: ids } : { pluginIds: ids });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "更新能力失败");
    } finally {
      setCapabilityBusy(null);
    }
  }, [detail, updateCapabilities]);

  const importCapability = useCallback(async (kind: "skill" | "plugin") => {
    if (!repository.trim() || capabilityBusy) return;
    setCapabilityBusy(`import:${kind}`);
    setError(null);
    try {
      const endpoint = `/api/workspaces/${encodeURIComponent(workspaceId)}/${kind === "skill" ? "skills" : "plugins"}`;
      const payload = kind === "skill" ? { repository: repository.trim(), path: sourcePath.trim() } : { repository: repository.trim(), path: sourcePath.trim() };
      const result = await json<{ skill?: WorkspaceSkill; plugin?: WorkspacePlugin }>(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      if (kind === "skill" && result.skill) {
        setSkills((current) => current.some((item) => item.id === result.skill!.id) ? current : [result.skill!, ...current]);
        await updateCapabilities({ skillIds: detail?.skillIds.includes(result.skill.id) ? detail.skillIds : [...(detail?.skillIds ?? []), result.skill.id] });
      }
      if (kind === "plugin" && result.plugin) {
        setPlugins((current) => current.some((item) => item.id === result.plugin!.id) ? current : [result.plugin!, ...current]);
        await updateCapabilities({ pluginIds: detail?.pluginIds.includes(result.plugin.id) ? detail.pluginIds : [...(detail?.pluginIds ?? []), result.plugin.id] });
      }
      setRepository("");
      setSourcePath("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "导入失败");
    } finally {
      setCapabilityBusy(null);
    }
  }, [capabilityBusy, detail, repository, sourcePath, updateCapabilities, workspaceId]);

  const save = useCallback(async () => {
    if (!detail || saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, description, prompt, steps, defaultModel: model, approvalMode, skillIds: detail.skillIds, pluginIds: detail.pluginIds }),
      });
      const body = (await response.json()) as { workspace?: WorkspaceDetail; error?: string };
      if (!response.ok) throw new Error(body.error ?? "保存失败");
      if (body.workspace) applyDetail(body.workspace);
      setSavedAt(new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }, [detail, saving, workspaceId, name, description, prompt, model, steps, approvalMode, applyDetail]);

  if (!detail) return <main className="workbench-loading">{error ?? "加载中…"}</main>;

  return (
    <main className="agent-workbench">
      <Navbar
        sublabel="agent"
        badge={<span className="rounded-full border border-line px-2 py-0.5 font-mono text-[11px] text-ink-3">a.zmzai.cloud</span>}
        actions={<span className="flex items-center gap-2 text-sm text-ink-2"><span className="status-dot" />智能体配置</span>}
      >
        <Link href="/fw" className={navItemClass(pathname === "/fw")}>任务</Link>
        <Link href="/audit" className={navItemClass(pathname === "/audit")}>运行审计</Link>
      </Navbar>
      {error && <div className="workbench-alert">{error}</div>}

      <div className="agent-config-grid">
        <section className="agent-config-editor">
          <div className="agent-config-titlebar">
            <div><span className="eyebrow">智能体配置</span><h1>{detail.name}</h1></div>
            <div className="agent-config-actions">
              {savedAt && <span className="agent-saved-hint">已保存 {savedAt}</span>}
              <button type="button" className="command-button quiet" onClick={() => void save()} disabled={saving}>{saving ? "保存中" : "保存配置"}</button>
            </div>
          </div>
          <div className="agent-form">
            <label><span>名称</span><input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} /></label>
            <label><span>描述</span><input value={description} maxLength={2_000} onChange={(event) => setDescription(event.target.value)} /></label>
            <div className="agent-form-row">
              <label><span>默认模型</span><ModelSelector data={modelSelectorData ?? { featured: [], channels: [] }} value={modelValue} onChange={setModelValue} placeholder="跟随任务选择" /></label>
              <label>
                <span>自治档位</span>
                <Select value={approvalMode} onValueChange={(value) => setApprovalMode(value === "auto" ? "auto" : "ask")}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ask">逐项确认</SelectItem>
                    <SelectItem value="auto">自动执行</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label><span>最大步骤</span><input type="number" min="1" max="64" value={steps} onChange={(event) => setSteps(Math.min(64, Math.max(1, Number(event.target.value) || 1)))} /></label>
            </div>
            <p className="agent-approval-hint">{approvalMode === "auto" ? "自动执行：任务内的命令不再逐项询问，适合可信任的沙箱任务。" : "逐项确认：执行命令前会弹出审批，可随时在会话中放行。"}</p>
            <label className="agent-prompt-label"><span>系统提示词（AGENT.md）</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} spellCheck={false} /></label>
          </div>
        </section>

        <aside className="agent-config-meta">
          <section className="agent-version-panel">
            <span className="eyebrow">智能体</span>
            <strong>{detail.name}</strong>
            <small>创建于 {new Date(detail.id ? "" : "").toLocaleDateString("zh-CN") || "—"}</small>
          </section>
          {budget && <section className="workspace-budget-panel">
            <div className="mb-3 flex items-center justify-between"><div><span className="eyebrow">运行预算</span><strong className="mt-1 block text-ink">Workspace 限制</strong></div><span className="font-mono text-xs text-ink-3">{budget.usagePeriod}</span></div>
            <div className="workspace-budget-grid"><label>最大并发<input type="number" min="1" max="64" value={budget.maxConcurrentRuns} onChange={(event) => setBudget((current) => current ? { ...current, maxConcurrentRuns: Math.min(64, Math.max(1, Number(event.target.value) || 1)) } : current)} /></label><label>月度 Token 上限<input type="number" min="0" max="1000000000" value={budget.monthlyTokenBudget} onChange={(event) => setBudget((current) => current ? { ...current, monthlyTokenBudget: Math.min(1_000_000_000, Math.max(0, Number(event.target.value) || 0)) } : current)} /></label></div>
            <div className="workspace-budget-stats"><span>本月已用 <strong>{budget.usedTokens.toLocaleString()}</strong></span><span>当前运行 <strong>{budget.reservedRuns}</strong></span></div>
            <Button type="button" size="sm" variant="secondary" disabled={budgetBusy} onClick={() => void saveBudget()}><Icon name="check" size={13} />{budgetBusy ? "保存中" : "保存预算"}</Button>
            <small className="workspace-budget-note">月度上限为 0 表示不限制。项目预算仍可设置更严格的限制。</small>
          </section>}
          <section className="mt-5 border-t border-line pt-4 text-sm">
            <div className="mb-3 flex items-center justify-between"><div><span className="eyebrow">可用能力</span><strong className="mt-1 block text-ink">Skills 与 Plugins</strong></div><span className="font-mono text-xs text-ink-3">{detail.skillIds.length + detail.pluginIds.length} 已启用</span></div>
            <div className="space-y-2">
              {skills.map((skill) => <label className="flex cursor-pointer items-start gap-2 border-b border-line pb-2" key={skill.id}><input className="mt-1" type="checkbox" checked={detail.skillIds.includes(skill.id)} disabled={capabilityBusy === `skill:${skill.id}`} onChange={(event) => void toggleCapability("skill", skill.id, event.target.checked)} /><span className="min-w-0 flex-1"><strong className="block truncate text-xs text-ink">{skill.name}</strong><small className="block truncate text-ink-3">{skill.description || `${skill.repository}/${skill.path}`}</small></span></label>)}
              {plugins.map((plugin) => <label className="flex cursor-pointer items-start gap-2 border-b border-line pb-2" key={plugin.id}><input className="mt-1" type="checkbox" checked={detail.pluginIds.includes(plugin.id)} disabled={capabilityBusy === `plugin:${plugin.id}`} onChange={(event) => void toggleCapability("plugin", plugin.id, event.target.checked)} /><span className="min-w-0 flex-1"><strong className="block truncate text-xs text-ink">{plugin.name}</strong><small className="block truncate text-ink-3">Plugin · {plugin.skillCount} Skills{plugin.version ? ` · v${plugin.version}` : ""}</small></span></label>)}
              {!skills.length && !plugins.length && <p className="text-xs text-ink-3">还没有导入能力。</p>}
            </div>
            <div className="mt-3 grid gap-2"><input value={repository} onChange={(event) => setRepository(event.target.value)} placeholder="owner/repository" aria-label="GitHub 仓库" /><input value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} placeholder="Skill 或 Plugin 路径" aria-label="仓库路径" /><div className="flex gap-2"><Button type="button" size="sm" variant="secondary" disabled={!repository.trim() || !sourcePath.trim() || Boolean(capabilityBusy)} onClick={() => void importCapability("skill")}>导入 Skill</Button><Button type="button" size="sm" variant="secondary" disabled={!repository.trim() || Boolean(capabilityBusy)} onClick={() => void importCapability("plugin")}>导入 Plugin</Button></div></div>
          </section>
          <button type="button" className="agent-back-button" onClick={() => router.push("/fw")}><Icon name="arrow-down" size={12} />返回任务</button>
          <div className="mt-6 border-t border-line pt-4">
            {confirmDelete ? (
              <div className="flex flex-col gap-2 text-sm text-ink-2">
                <span>删除后会话、产物、文件版本全部清除，不可恢复。</span>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="danger" size="sm" disabled={deleting} onClick={() => void remove()}>{deleting ? "删除中…" : "确认删除"}</Button>
                  <Button type="button" variant="secondary" size="sm" onClick={() => setConfirmDelete(false)}>取消</Button>
                </div>
              </div>
            ) : (
              <Button type="button" variant="ghost" size="sm" className="font-mono text-xs text-danger underline" onClick={() => setConfirmDelete(true)}>
                <Icon name="trash" size={12} />删除此智能体
              </Button>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}
