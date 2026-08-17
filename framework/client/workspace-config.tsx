"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { Icon, Navbar, navItemClass } from "@zmzai/theme";

type Model = { model: string };
type WorkspaceDetail = {
  id: string;
  name: string;
  description: string;
  defaultModel: string;
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
  const [models, setModels] = useState<Model[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [steps, setSteps] = useState(12);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applyDetail = useCallback((ws: WorkspaceDetail) => {
    setDetail(ws);
    setName(ws.name);
    setDescription(ws.description);
    setPrompt(ws.prompt);
    setModel(ws.defaultModel);
    setSteps(ws.steps);
  }, []);

  useEffect(() => {
    void Promise.all([
      json<{ workspace: WorkspaceDetail }>(`/api/workspaces/${encodeURIComponent(workspaceId)}`).then((body) => applyDetail(body.workspace)),
      json<{ models: Model[] }>("/api/models").then((body) => setModels(body.models)),
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
        body: JSON.stringify({ name, description, prompt, steps, defaultModel: model }),
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
  }, [detail, saving, workspaceId, name, description, prompt, model, steps, applyDetail]);

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
              <label><span>默认模型</span><select value={model} onChange={(event) => setModel(event.target.value)}><option value="">跟随任务选择</option>{models.map((item) => <option key={item.model} value={item.model}>{item.model}</option>)}</select></label>
              <label><span>最大步骤</span><input type="number" min="1" max="64" value={steps} onChange={(event) => setSteps(Math.min(64, Math.max(1, Number(event.target.value) || 1)))} /></label>
            </div>
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
        </aside>
      </div>
    </main>
  );
}
