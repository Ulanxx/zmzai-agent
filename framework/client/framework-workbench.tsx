"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { Icon } from "@/components/icon";
import { Seal } from "@/components/seal";
import {
  fwApi,
  useFrameworkSession,
  type AgentSummary,
  type ArtifactCard,
  type Reply,
  type SessionInfo,
} from "@/framework/client/use-framework-session";
import { ArtifactPreviewCard, EditCard, MessageView, PermissionCard, TodoChecklist } from "@/framework/client/parts";

type Model = { model: string; maxOutputTokens: number };
type Workspace = { id: string; name: string; defaultModel: string };

type CanvasTab = "artifacts" | "edits";

export function FrameworkWorkbench({ sessionId }: { sessionId: string | null }) {
  const router = useRouter();
  const { snapshot, live, loading, loadError } = useFrameworkSession(sessionId);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [prompt, setPrompt] = useState("");
  const [agent, setAgent] = useState("default");
  const [model, setModel] = useState("");
  const [sending, setSending] = useState(false);
  const [replying, setReplying] = useState(false);
  const [canvasTab, setCanvasTab] = useState<CanvasTab>("artifacts");
  const [preview, setPreview] = useState<ArtifactCard | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [followScroll, setFollowScroll] = useState(true);

  const busy = live.status !== "idle";
  const queuedCount = snapshot?.session.queuedPrompts.length ?? 0;

  // Bootstrap: agents, models, workspaces, and this workspace's session list.
  useEffect(() => {
    void (async () => {
      const [agentResult, modelResult, workspaceResult] = await Promise.allSettled([fwApi.listAgents(), fetch("/api/models").then((r) => r.json() as Promise<{ models: Model[] }>), fetch("/api/workspaces").then((r) => r.json() as Promise<{ workspaces: Workspace[] }>)]);
      if (agentResult.status === "fulfilled") setAgents(agentResult.value.agents.filter((item) => item.mode !== "subagent"));
      if (modelResult.status === "fulfilled") setModels(modelResult.value.models);
      if (workspaceResult.status === "fulfilled") {
        setWorkspaces(workspaceResult.value.workspaces);
        const first = workspaceResult.value.workspaces[0];
        if (first) setWorkspaceId((current) => current ?? first.id);
      }
    })();
  }, []);

  // Align workspace with the loaded session, then list its sessions. The
  // setState calls are deferred so the effect body stays free of sync updates.
  useEffect(() => {
    const id = snapshot?.session.workspaceId;
    if (id) queueMicrotask(() => setWorkspaceId(id));
  }, [snapshot?.session.workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    void fwApi.listSessions(workspaceId).then((result) => setSessions(result.sessions)).catch(() => undefined);
  }, [workspaceId, snapshot?.session.time.updated]);  

  useEffect(() => {
    if (snapshot && models.length && !model) {
      queueMicrotask(() => {
        const workspace = workspaces.find((item) => item.id === snapshot.session.workspaceId);
        setModel(snapshot.session.model.modelId || workspace?.defaultModel || models[0]?.model || "");
      });
    }
  }, [snapshot, models, workspaces, model]);

  // Auto-scroll the conversation while following.
  useEffect(() => {
    const element = scrollRef.current;
    if (element && followScroll) element.scrollTop = element.scrollHeight;
  }, [snapshot?.messages, live.todos, followScroll]);

  const send = useCallback(async () => {
    const text = prompt.trim();
    if (!text || sending) return;
    setActionError(null);

    // No session yet: create one bound to the workspace (§13.1), carrying the
    // first prompt so the runner starts immediately.
    if (!snapshot) {
      if (!workspaceId || !model) return;
      setSending(true);
      try {
        const result = await fwApi.createSession({ workspaceId, agent, model: { providerId: "relay", modelId: model }, prompt: text });
        setPrompt("");
        router.push(`/fw/s/${result.session.id}`);
      } catch (cause) {
        setActionError(cause instanceof Error ? cause.message : "无法创建会话");
      } finally {
        setSending(false);
      }
      return;
    }

    setSending(true);
    try {
      await fwApi.prompt(snapshot.session.id, { text, agent });
      setPrompt("");
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "发送失败");
    } finally {
      setSending(false);
    }
  }, [prompt, sending, snapshot, workspaceId, model, agent, router]);

  const replyPermission = useCallback(
    async (reply: Reply, feedback?: string) => {
      if (!snapshot || !live.pendingPermission || replying) return;
      setReplying(true);
      try {
        await fwApi.replyPermission(snapshot.session.id, live.pendingPermission.id, reply, feedback);
      } catch (cause) {
        setActionError(cause instanceof Error ? cause.message : "审批操作失败");
      } finally {
        setReplying(false);
      }
    },
    [snapshot, live.pendingPermission, replying],
  );

  const stop = useCallback(async () => {
    if (!snapshot) return;
    await fwApi.abort(snapshot.session.id).catch(() => undefined);
  }, [snapshot]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const openArtifact = useCallback((artifact: ArtifactCard) => {
    setPreview(artifact);
    setCanvasTab("artifacts");
  }, []);

  const messages = useMemo(() => snapshot?.messages ?? [], [snapshot]);

  if (loading) return <main className="workbench-loading">正在建立工作台…</main>;
  if (loadError) return <main className="workbench-loading">{loadError}</main>;

  return (
    <main className="workbench fw-workbench">
      <header className="workbench-header">
        <div className="flex items-center gap-3">
          <Seal size={26} className="agent-seal" />
          <span className="font-mono text-sm font-bold tracking-[0.08em]">ZMZAI AGENT</span>
        </div>
        <nav className="workbench-nav" aria-label="主导航">
          <a href="/fw">新任务</a>
          <a href="/audit">运行审计</a>
        </nav>
        <div className="workbench-status">
          <span className="status-dot" />
          AGENT <span className="header-domain">a.zmzai.cloud</span>
        </div>
      </header>
      {actionError && <div className="workbench-alert">{actionError}</div>}

      <div className="fw-grid">
        <aside className="fw-sidebar">
          <div className="pane-heading">
            <span>WORKSPACE</span>
          </div>
          <nav className="workspace-list" aria-label="Workspace 列表">
            {workspaces.map((item) => (
              <button type="button" key={item.id} className={item.id === workspaceId ? "workspace-item active" : "workspace-item"} onClick={() => setWorkspaceId(item.id)}>
                <span>{item.name}</span>
              </button>
            ))}
          </nav>
          <section className="run-history">
            <div className="pane-heading">
              <span>会话</span>
              <small>{sessions.length}</small>
            </div>
            <nav className="run-history-list" aria-label="会话列表">
              {sessions.map((item) => (
                <button type="button" key={item.id} className={item.id === sessionId ? "run-history-item active" : "run-history-item"} onClick={() => router.push(`/fw/s/${item.id}`)}>
                  <strong>{item.title}</strong>
                  <small>{item.agent}</small>
                </button>
              ))}
              {!sessions.length && <p className="empty-state">此 Workspace 还没有会话。</p>}
            </nav>
          </section>
        </aside>

        <section className="fw-conversation">
          <div className="run-toolbar">
            <div>
              <span className="eyebrow">会话</span>
              <h1>{snapshot?.session.title ?? "新任务"}</h1>
            </div>
            <div className="run-toolbar-meta">
              <span className={`run-phase ${live.status === "idle" ? "succeeded" : "running"}`}>{live.status === "idle" ? "空闲" : live.status === "waiting_permission" ? "等待审批" : "进行中"}</span>
              {live.streamState === "live" && busy && <span className="stream-state live">实时</span>}
              {live.streamState === "reconnecting" && <span className="stream-state reconnecting">连接恢复中</span>}
              {queuedCount > 0 && <span className="stream-state">排队 {queuedCount}</span>}
              <span>{snapshot?.session.model.modelId || model}</span>
              {busy && (
                <button type="button" className="icon-command" title="停止" onClick={() => void stop()}>
                  <Icon name="stop" />
                </button>
              )}
            </div>
          </div>

          <div
            className="conversation-scroll"
            ref={scrollRef}
            onScroll={() => {
              const element = scrollRef.current;
              if (!element) return;
              setFollowScroll(element.scrollHeight - element.scrollTop - element.clientHeight < 160);
            }}
          >
            {!snapshot && (
              <div className="agent-intro">
                <span className="eyebrow">ZMZAI AGENT</span>
                <h1>描述任务，Agent 直接交付</h1>
                <p>读取、改文件、跑命令都在隔离沙箱中自动进行；文件改动生成可回滚版本，命令执行首次需要一次授权。左侧选择 Workspace，下方直接开始。</p>
              </div>
            )}
            <TodoChecklist todos={live.todos} />
            {messages.map((entry) => (
              <MessageView key={entry.info.id} entry={entry} />
            ))}
            {live.pendingPermission && <PermissionCard request={live.pendingPermission} busy={replying} onReply={(reply, feedback) => void replyPermission(reply, feedback)} />}
            {live.error && <div className="run-note">{live.error}</div>}
            {!followScroll && (
              <button
                type="button"
                className="jump-to-latest"
                onClick={() => {
                  const element = scrollRef.current;
                  if (element) {
                    element.scrollTop = element.scrollHeight;
                    setFollowScroll(true);
                  }
                }}
              >
                <Icon name="arrow-down" size={12} />
                跳至最新
              </button>
            )}
          </div>

          <form
            className="prompt-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <div className="composer-controls">
              <select value={agent} onChange={(event) => setAgent(event.target.value)} aria-label="Agent">
                {(agents.length ? agents : [{ name: "default", description: "", mode: "primary" as const }]).map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </select>
              <select value={model} onChange={(event) => setModel(event.target.value)} aria-label="模型" disabled={!models.length}>
                {models.length ? models.map((item) => <option key={item.model} value={item.model}>{item.model}</option>) : <option>模型目录不可用</option>}
              </select>
            </div>
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={snapshot ? (busy ? "Agent 正在执行，发送将排队…" : "继续这条对话…（Enter 发送，Shift+Enter 换行）") : "描述要完成的任务…"}
              rows={3}
            />
            <div className="composer-actions">
              <span>{busy ? (queuedCount > 0 ? `执行中 · ${queuedCount} 条排队` : "执行中") : "就绪"}</span>
              {busy ? (
                <button type="button" className="command-button quiet" onClick={() => void stop()}>
                  停止
                </button>
              ) : (
                <button type="submit" className="command-button" disabled={!prompt.trim() || sending || (!snapshot && !workspaceId)}>
                  {sending ? "发送中" : busy ? "排队" : "发送"}
                </button>
              )}
            </div>
          </form>
        </section>

        <aside className="fw-canvas">
          <div className="canvas-tabs">
            <button type="button" className={canvasTab === "artifacts" ? "active" : ""} onClick={() => setCanvasTab("artifacts")}>
              产物 <span>{live.artifacts.length}</span>
            </button>
            <button type="button" className={canvasTab === "edits" ? "active" : ""} onClick={() => setCanvasTab("edits")}>
              改动 <span>{live.edits.length}</span>
            </button>
          </div>
          {canvasTab === "artifacts" && (
            <div className="fw-canvas-body">
              {preview?.previewUrl ? (
                <div className="fw-preview-wrap">
                  <div className="fw-preview-head">
                    <span>{preview.path}</span>
                    <button type="button" className="icon-command" title="关闭预览" onClick={() => setPreview(null)}>
                      <Icon name="cross" />
                    </button>
                  </div>
                  <iframe className="fw-preview-frame" src={preview.previewUrl} title={preview.path} sandbox="allow-scripts allow-same-origin" />
                </div>
              ) : null}
              {live.artifacts.length ? (
                live.artifacts.map((artifact) => <ArtifactPreviewCard key={artifact.artifactId} artifact={artifact} onOpen={openArtifact} />)
              ) : (
                <p className="empty-state">沙箱生成的文件会出现在这里，可预览或下载。</p>
              )}
            </div>
          )}
          {canvasTab === "edits" && (
            <div className="fw-canvas-body">
              {live.edits.length ? live.edits.map((edit) => <EditCard key={`${edit.revisionId}-${edit.path}`} edit={edit} />) : <p className="empty-state">Agent 的文件改动（含差异）会出现在这里。</p>}
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
