"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Icon } from "@/components/icon";
import { Seal } from "@/components/seal";

type AgentSummary = { id: string; name: string; description: string; icon: string; publishedVersionId: string | null };
type Model = { model: string };
type WorkspaceSkill = { id: string; name: string; description: string; repository: string; requestedRef: string; commitSha: string; path: string };
type WorkspacePlugin = { id: string; name: string; version: string; description: string; repository: string; commitSha: string; path: string; skillCount: number; mcpServerCount: number; errors: string[] };
type WorkspaceConnector = { id: string; name: string; transport: "streamable-http" | "sse"; url: string; status: "untested" | "ready" | "error"; lastCheckedAt: string | null; lastError: string | null };
type AgentDetail = {
  agent: AgentSummary;
  draft: {
    agent: { prompt?: string; model?: { providerId: string; modelId: string }; steps?: number };
    capabilities: { tools: string[]; pluginIds: string[]; skillIds: string[]; connectorIds: string[] };
  };
  published: { id: string; version: number; createdAt: string } | null;
  versions: Array<{ id: string; version: number; createdAt: string }>;
};

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const body = await response.json().catch(() => null) as { error?: string } | T | null;
  if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "请求失败");
  return body as T;
}

export function AgentWorkbench({ workspaceId, agentId }: { workspaceId: string; agentId: string }) {
  const router = useRouter();
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [skills, setSkills] = useState<WorkspaceSkill[]>([]);
  const [plugins, setPlugins] = useState<WorkspacePlugin[]>([]);
  const [connectors, setConnectors] = useState<WorkspaceConnector[]>([]);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [selectedPluginIds, setSelectedPluginIds] = useState<string[]>([]);
  const [selectedConnectorIds, setSelectedConnectorIds] = useState<string[]>([]);
  const selectedSkillIdsRef = useRef<string[]>([]);
  const selectedPluginIdsRef = useRef<string[]>([]);
  const selectedConnectorIdsRef = useRef<string[]>([]);
  const [skillRepository, setSkillRepository] = useState("");
  const [skillPath, setSkillPath] = useState("");
  const [importingSkill, setImportingSkill] = useState(false);
  const [pluginRepository, setPluginRepository] = useState("");
  const [pluginPath, setPluginPath] = useState("");
  const [importingPlugin, setImportingPlugin] = useState(false);
  const [connectorName, setConnectorName] = useState("");
  const [connectorUrl, setConnectorUrl] = useState("");
  const [connectorTransport, setConnectorTransport] = useState<WorkspaceConnector["transport"]>("streamable-http");
  const [connectorHeaders, setConnectorHeaders] = useState("");
  const [creatingConnector, setCreatingConnector] = useState(false);
  const [testingConnectorId, setTestingConnectorId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [steps, setSteps] = useState(12);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyDetail = useCallback((next: AgentDetail) => {
    setDetail(next);
    setName(next.agent.name);
    setDescription(next.agent.description);
    setPrompt(next.draft.agent.prompt ?? "");
    setModel(next.draft.agent.model?.modelId ?? "");
    setSteps(next.draft.agent.steps ?? 12);
    selectedSkillIdsRef.current = next.draft.capabilities.skillIds;
    setSelectedSkillIds(next.draft.capabilities.skillIds);
    selectedPluginIdsRef.current = next.draft.capabilities.pluginIds;
    setSelectedPluginIds(next.draft.capabilities.pluginIds);
    selectedConnectorIdsRef.current = next.draft.capabilities.connectorIds;
    setSelectedConnectorIds(next.draft.capabilities.connectorIds);
  }, []);

  useEffect(() => {
    void Promise.all([
      json<{ agents: AgentSummary[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/agents`),
      json<{ models: Model[] }>("/api/models"),
      json<{ skills: WorkspaceSkill[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/skills`),
      json<{ plugins: WorkspacePlugin[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/plugins`),
      json<{ connectors: WorkspaceConnector[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/connectors`),
      json<AgentDetail>(`/api/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}`),
    ]).then(([agentResult, modelResult, skillResult, pluginResult, connectorResult, detailResult]) => {
      setAgents(agentResult.agents);
      setModels(modelResult.models);
      setSkills(skillResult.skills);
      setPlugins(pluginResult.plugins);
      setConnectors(connectorResult.connectors);
      applyDetail(detailResult);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "无法加载 Agent"));
  }, [workspaceId, agentId, applyDetail]);

  const save = useCallback(async (): Promise<AgentDetail | null> => {
    if (!detail || saving) return null;
    setSaving(true);
    setError(null);
    try {
      const next = await json<AgentDetail>(`/api/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          description,
          icon: detail.agent.icon,
          prompt,
          model: model ? { providerId: "relay", modelId: model } : null,
          steps,
          tools: detail.draft.capabilities.tools,
          pluginIds: selectedPluginIdsRef.current,
          skillIds: selectedSkillIdsRef.current,
          connectorIds: selectedConnectorIdsRef.current,
        }),
      });
      applyDetail(next);
      setAgents((current) => current.map((agent) => agent.id === next.agent.id ? next.agent : agent));
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
      return null;
    } finally {
      setSaving(false);
    }
  }, [detail, saving, workspaceId, agentId, name, description, prompt, model, steps, applyDetail]);

  const publish = useCallback(async () => {
    if (!detail || publishing) return;
    setPublishing(true);
    setError(null);
    try {
      if (!(await save())) return;
      const next = await json<AgentDetail>(`/api/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/publish`, { method: "POST" });
      applyDetail(next);
      setAgents((current) => current.map((agent) => agent.id === next.agent.id ? next.agent : agent));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "发布失败");
    } finally {
      setPublishing(false);
    }
  }, [detail, publishing, workspaceId, agentId, save, applyDetail]);

  const toggleSkill = useCallback((skillId: string) => {
    const next = selectedSkillIdsRef.current.includes(skillId)
      ? selectedSkillIdsRef.current.filter((id) => id !== skillId)
      : [...selectedSkillIdsRef.current, skillId];
    selectedSkillIdsRef.current = next;
    setSelectedSkillIds(next);
  }, []);

  const togglePlugin = useCallback((pluginId: string) => {
    const next = selectedPluginIdsRef.current.includes(pluginId)
      ? selectedPluginIdsRef.current.filter((id) => id !== pluginId)
      : [...selectedPluginIdsRef.current, pluginId];
    selectedPluginIdsRef.current = next;
    setSelectedPluginIds(next);
  }, []);

  const toggleConnector = useCallback((connectorId: string) => {
    const next = selectedConnectorIdsRef.current.includes(connectorId)
      ? selectedConnectorIdsRef.current.filter((id) => id !== connectorId)
      : [...selectedConnectorIdsRef.current, connectorId];
    selectedConnectorIdsRef.current = next;
    setSelectedConnectorIds(next);
  }, []);

  const importSkill = useCallback(async () => {
    if (!skillRepository.trim() || !skillPath.trim() || importingSkill) return;
    setImportingSkill(true);
    setError(null);
    try {
      const result = await json<{ skill: WorkspaceSkill }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/skills`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repository: skillRepository, path: skillPath }),
      });
      setSkills((current) => current.some((skill) => skill.id === result.skill.id) ? current : [result.skill, ...current]);
      setSkillRepository("");
      setSkillPath("");
      toggleSkill(result.skill.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Skill 导入失败");
    } finally {
      setImportingSkill(false);
    }
  }, [skillRepository, skillPath, importingSkill, workspaceId, toggleSkill]);

  const importPlugin = useCallback(async () => {
    if (!pluginRepository.trim() || importingPlugin) return;
    setImportingPlugin(true);
    setError(null);
    try {
      const result = await json<{ plugin: WorkspacePlugin }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/plugins`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repository: pluginRepository, path: pluginPath }),
      });
      setPlugins((current) => current.some((plugin) => plugin.id === result.plugin.id) ? current : [result.plugin, ...current]);
      setPluginRepository("");
      setPluginPath("");
      togglePlugin(result.plugin.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Agent Plugin 导入失败");
    } finally {
      setImportingPlugin(false);
    }
  }, [pluginRepository, pluginPath, importingPlugin, workspaceId, togglePlugin]);

  const createConnector = useCallback(async () => {
    if (!connectorName.trim() || !connectorUrl.trim() || creatingConnector) return;
    setCreatingConnector(true);
    setError(null);
    try {
      const headers = connectorHeaders.trim() ? JSON.parse(connectorHeaders) as unknown : {};
      if (!headers || typeof headers !== "object" || Array.isArray(headers)) throw new Error("Header 必须是 JSON 对象");
      const result = await json<{ connector: WorkspaceConnector }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/connectors`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: connectorName, transport: connectorTransport, url: connectorUrl, headers }),
      });
      setConnectors((current) => [result.connector, ...current]);
      setConnectorName("");
      setConnectorUrl("");
      setConnectorHeaders("");
      toggleConnector(result.connector.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法创建 MCP 连接器");
    } finally {
      setCreatingConnector(false);
    }
  }, [connectorName, connectorUrl, connectorHeaders, connectorTransport, creatingConnector, workspaceId, toggleConnector]);

  const testConnector = useCallback(async (connectorId: string) => {
    if (testingConnectorId) return;
    setTestingConnectorId(connectorId);
    setError(null);
    try {
      const result = await json<{ connector: WorkspaceConnector }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/connectors/${encodeURIComponent(connectorId)}/test`, { method: "POST" });
      setConnectors((current) => current.map((connector) => connector.id === connectorId ? result.connector : connector));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "连接测试失败");
    } finally {
      setTestingConnectorId(null);
    }
  }, [testingConnectorId, workspaceId]);

  return (
    <main className="agent-workbench">
      <header className="workbench-header">
        <a href="/fw" className="agent-brand"><Seal size={26} className="agent-seal" /><span>ZMZAI AGENT</span></a>
        <nav className="workbench-nav" aria-label="主导航"><a href="/fw">会话</a><a href="/audit">运行审计</a></nav>
        <span className="workbench-status"><span className="status-dot" />AGENT CONFIG</span>
      </header>
      {error && <div className="workbench-alert">{error}</div>}
      <div className="agent-config-grid">
        <aside className="agent-config-sidebar">
          <div className="pane-heading"><span>AGENTS</span><small>{agents.length}</small></div>
          <nav className="agent-config-list" aria-label="Agent 列表">
            {agents.map((agent) => (
              <button key={agent.id} type="button" className={agent.id === agentId ? "agent-config-item active" : "agent-config-item"} onClick={() => router.push(`/fw/w/${workspaceId}/agents/${agent.id}`)}>
                <span className="agent-config-item-mark"><Seal size={19} /></span>
                <span><strong>{agent.name}</strong><small>{agent.publishedVersionId ? "已发布" : "草稿"}</small></span>
              </button>
            ))}
          </nav>
          <p className="agent-config-note">会话固定使用发布版本。草稿修改不会影响进行中的任务。</p>
        </aside>

        <section className="agent-config-editor">
          <div className="agent-config-titlebar">
            <div><span className="eyebrow">WORKSPACE AGENT</span><h1>{detail?.agent.name ?? "加载中"}</h1></div>
            <div className="agent-config-actions">
              <button type="button" className="command-button quiet" onClick={() => void save()} disabled={!detail || saving}>{saving ? "保存中" : "保存草稿"}</button>
              <button type="button" className="command-button" onClick={() => void publish()} disabled={!detail || saving || publishing}>{publishing ? "发布中" : "发布版本"}</button>
            </div>
          </div>
          <div className="agent-form">
            <label><span>名称</span><input value={name} maxLength={64} onChange={(event) => setName(event.target.value)} /></label>
            <label><span>描述</span><input value={description} maxLength={2_000} onChange={(event) => setDescription(event.target.value)} /></label>
            <div className="agent-form-row">
              <label><span>默认模型</span><select value={model} onChange={(event) => setModel(event.target.value)}><option value="">跟随会话选择</option>{models.map((item) => <option key={item.model} value={item.model}>{item.model}</option>)}</select></label>
              <label><span>最大步骤</span><input type="number" min="1" max="64" value={steps} onChange={(event) => setSteps(Math.min(64, Math.max(1, Number(event.target.value) || 1)))} /></label>
            </div>
            <label className="agent-prompt-label"><span>AGENT.md</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} spellCheck={false} /></label>
          </div>
        </section>

        <aside className="agent-config-meta">
          <section className="agent-version-panel">
            <span className="eyebrow">PUBLISHED VERSION</span>
            <strong>{detail?.published ? `v${detail.published.version}` : "尚未发布"}</strong>
            <small>{detail?.published ? new Date(detail.published.createdAt).toLocaleString("zh-CN") : "发布后才能用于新会话"}</small>
          </section>
          <section className="agent-capability-panel">
            <div className="pane-heading"><span>CAPABILITIES</span></div>
            <div className="agent-capability-row"><span>基础工具</span><b>{detail?.draft.capabilities.tools.length ?? 0}</b></div>
            <div className="agent-capability-row"><span>Skills</span><b>{selectedSkillIds.length}</b></div>
            <div className="agent-capability-row"><span>Agent Plugins</span><b>{selectedPluginIds.length}</b></div>
            <div className="agent-capability-row"><span>MCP 连接器</span><b>{selectedConnectorIds.length}</b><small>仅保存授权配置，工具运行仍未启用</small></div>
          </section>
          <section className="agent-version-history"><div className="pane-heading"><span>版本记录</span><small>{detail?.versions.length ?? 0}</small></div>{detail?.versions.map((version) => <div key={version.id}><strong>v{version.version}</strong><small>{new Date(version.createdAt).toLocaleDateString("zh-CN")}</small></div>)}</section>
          <button type="button" className="agent-back-button" onClick={() => router.push("/fw")}><Icon name="arrow-down" size={12} />返回会话</button>
        </aside>
      </div>
      <details className="agent-skill-drawer">
        <summary className="agent-skill-drawer-head"><div><span className="eyebrow">GITHUB SKILLS</span><h2>为这个 Agent 选择受管技能</h2></div><span>{selectedSkillIds.length} 已启用</span></summary>
        <div className="agent-skill-import"><input value={skillRepository} onChange={(event) => setSkillRepository(event.target.value)} placeholder="owner/repository" aria-label="GitHub 仓库" /><input value={skillPath} onChange={(event) => setSkillPath(event.target.value)} placeholder="skills/example" aria-label="Skill 目录" /><button type="button" className="command-button" onClick={() => void importSkill()} disabled={!skillRepository.trim() || !skillPath.trim() || importingSkill}>{importingSkill ? "导入中" : "从 GitHub 导入"}</button></div>
        <div className="agent-skill-list">{skills.length ? skills.map((skill) => { const selected = selectedSkillIds.includes(skill.id); return <label key={skill.id} className={selected ? "agent-skill-item selected" : "agent-skill-item"}><input type="checkbox" checked={selected} onChange={() => toggleSkill(skill.id)} /><span><strong>{skill.name}</strong><small>{skill.repository} · {skill.commitSha.slice(0, 8)} · {skill.path || "SKILL.md"}</small>{skill.description && <em>{skill.description}</em>}</span></label>; }) : <p className="empty-state">还没有导入 Skill。请填写 GitHub 仓库和包含 `SKILL.md` 的目录。</p>}</div>
      </details>
      <details className="agent-skill-drawer agent-plugin-drawer">
        <summary className="agent-skill-drawer-head"><div><span className="eyebrow">AGENT PLUGINS 1.0</span><h2>导入可移植的能力包</h2></div><span>{selectedPluginIds.length} 已启用</span></summary>
        <div className="agent-skill-import"><input value={pluginRepository} onChange={(event) => setPluginRepository(event.target.value)} placeholder="owner/repository" aria-label="Plugin GitHub 仓库" /><input value={pluginPath} onChange={(event) => setPluginPath(event.target.value)} placeholder="插件目录（仓库根目录可留空）" aria-label="Plugin 目录" /><button type="button" className="command-button" onClick={() => void importPlugin()} disabled={!pluginRepository.trim() || importingPlugin}>{importingPlugin ? "导入中" : "导入 Plugin"}</button></div>
        <div className="agent-skill-list">{plugins.length ? plugins.map((plugin) => { const selected = selectedPluginIds.includes(plugin.id); return <label key={plugin.id} className={selected ? "agent-skill-item selected" : "agent-skill-item"}><input type="checkbox" checked={selected} onChange={() => togglePlugin(plugin.id)} /><span><strong>{plugin.name}{plugin.version ? ` v${plugin.version}` : ""}</strong><small>{plugin.repository} · {plugin.commitSha.slice(0, 8)} · {plugin.path || "仓库根目录"}</small><em>{plugin.skillCount} Skills · {plugin.mcpServerCount} MCP 声明{plugin.description ? ` · ${plugin.description}` : ""}</em>{plugin.errors.map((error) => <em className="agent-plugin-warning" key={error}>{error}</em>)}</span></label>; }) : <p className="empty-state">导入包含 `plugin.json` 的 GitHub 目录后，可选择其 Skills。MCP 声明会等待单独授权。</p>}</div>
      </details>
      <details className="agent-skill-drawer agent-connector-drawer">
        <summary className="agent-skill-drawer-head"><div><span className="eyebrow">MCP CONNECTORS <em className="agent-wip-badge">开发中</em></span><h2>授权外部工具连接</h2></div><span>{selectedConnectorIds.length} 已启用</span></summary>
        <div className="agent-connector-import"><input value={connectorName} onChange={(event) => setConnectorName(event.target.value)} placeholder="连接器名称" aria-label="连接器名称" /><select value={connectorTransport} onChange={(event) => setConnectorTransport(event.target.value as WorkspaceConnector["transport"])} aria-label="连接器传输协议"><option value="streamable-http">Streamable HTTP</option><option value="sse">SSE</option></select><input value={connectorUrl} onChange={(event) => setConnectorUrl(event.target.value)} placeholder="https://example.com/mcp" aria-label="MCP 地址" /><input value={connectorHeaders} onChange={(event) => setConnectorHeaders(event.target.value)} placeholder='Header JSON（可选）' aria-label="连接器 Header JSON" /><button type="button" className="command-button" onClick={() => void createConnector()} disabled={!connectorName.trim() || !connectorUrl.trim() || creatingConnector}>{creatingConnector ? "保存中" : "保存连接器"}</button></div>
        <div className="agent-skill-list">{connectors.length ? connectors.map((connector) => { const selected = selectedConnectorIds.includes(connector.id); return <label key={connector.id} className={selected ? "agent-skill-item selected" : "agent-skill-item"}><input type="checkbox" checked={selected} onChange={() => toggleConnector(connector.id)} /><span><strong>{connector.name}</strong><small>{connector.transport} · {connector.url}</small><em className={`connector-status ${connector.status}`}>{connector.status === "ready" ? "连接可达" : connector.status === "error" ? `连接失败：${connector.lastError ?? "未知错误"}` : "尚未测试"}</em></span><button type="button" className="connector-test-button" onClick={(event) => { event.preventDefault(); void testConnector(connector.id); }} disabled={testingConnectorId === connector.id}>{testingConnectorId === connector.id ? "测试中" : "测试"}</button></label>; }) : <p className="empty-state">连接器凭据会在服务端加密保存。保存后先测试可达性，再勾选给此 Agent；此版本不会执行 MCP 工具。</p>}</div>
      </details>
    </main>
  );
}
