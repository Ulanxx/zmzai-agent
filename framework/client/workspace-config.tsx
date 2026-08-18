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
};

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
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
    ]).catch((cause) => setError(cause instanceof Error ? cause.message : "无法加载智能体配置"));
  }, [workspaceId, applyDetail]);

  const save = useCallback(async () => {
    if (!detail || saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, description, prompt, steps, defaultModel: model, approvalMode }),
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
