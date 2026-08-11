import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

import { AgentRegistry } from "@/framework/core/agent/registry";
import { leaseDurationMs } from "@/framework/core/runtime/lease-recovery";
import { publishFrameworkEvent } from "@/framework/core/events/bus";
import type { FrameworkEvent } from "@/framework/core/events/manifest";
import { PermissionEngine, RejectedError, type Reply } from "@/framework/core/permission/engine";
import { PartProjector, serializeEmit } from "@/framework/core/runtime/pi-bridge";
import { mongoSessionStore } from "@/framework/core/session/mongo-store";
import type { SessionStore } from "@/framework/core/session/store";
import { newSessionId } from "@/framework/core/session/ids";
import type { ModelRef, Part, SessionInfo } from "@/framework/core/session/types";
import { adaptTool, permissionForCall } from "@/framework/core/tools/adapter";
import { builtinTools } from "@/framework/core/tools/builtins";
import type { ToolContext } from "@/framework/core/tools/context";
import type { ToolDef } from "@/framework/core/tools/def";
import { createMongoWorkspaceFiles } from "@/framework/core/tools/mongo-workspace";

/** SessionRunner (spec §8.1): owns one session's full lifecycle — prompt →
 *  PI agent loop → persisted parts + framework events → terminal settlement
 *  → queued prompt continuation. Permission checks happen only in
 *  beforeToolCall (spec §5.4). */

export type RunnerDeps = {
  store: SessionStore;
  registry: AgentRegistry;
  /** Built per run so multi-tenant deployments bind the right billing
   *  identity (relay stream is keyed by userId). */
  streamFnFor: (session: SessionInfo) => ConstructorParameters<typeof Agent>[0]["streamFn"];
  modelFor: (ref: ModelRef) => Model<Api>;
  tools?: ToolDef[];
  buildToolContext?: (input: { session: SessionInfo; engine: PermissionEngine }) => ToolContext;
};

type ActiveRun = {
  agent: Agent;
  engine: PermissionEngine;
  settled: () => Promise<void>;
  abort: () => void;
};

const globalRunners = globalThis as typeof globalThis & { __zmzaiFrameworkRuns?: Map<string, ActiveRun> };
const activeRuns = globalRunners.__zmzaiFrameworkRuns ?? new Map<string, ActiveRun>();
globalRunners.__zmzaiFrameworkRuns = activeRuns;

function defaultToolContext(input: { session: SessionInfo; engine: PermissionEngine }): ToolContext {
  const { session, engine } = input;
  const workspace = createMongoWorkspaceFiles({ userId: session.userId, workspaceId: session.workspaceId });
  return {
    sessionId: session.id,
    userId: session.userId,
    workspaceId: session.workspaceId,
    agent: session.agent,
    abort: new AbortController().signal,
    ask: engine.ask.bind(engine),
    workspace,
    buildSnapshot: async () => {
      const { buildExecSnapshot } = await import("@/lib/sandbox-snapshot");
      const built = await buildExecSnapshot({ userId: session.userId, workspaceId: session.workspaceId, runId: session.id });
      return built.snapshot;
    },
    runSandbox: async (execInput) => {
      const { runSandboxCommandAndStream } = await import("@/lib/sandbox-execution");
      const result = await runSandboxCommandAndStream({
        userId: session.userId,
        runId: session.id,
        workspaceId: session.workspaceId,
        toolCallId: execInput.toolCallId,
        snapshot: execInput.snapshot,
        command: execInput.command,
      });
      return {
        ok: result.ok,
        exitCode: result.exitCode,
        outputText: result.outputText,
        durationMs: result.durationMs,
        artifacts: result.artifacts.map((artifact) => {
          const previewable = /^(text\/html|image\/(png|jpeg|gif|svg\+xml|webp)|application\/pdf|text\/(plain|markdown|css))/.test(artifact.contentType.toLowerCase());
          const base = artifact.artifactId ? `/api/fw/sessions/${session.id}/artifacts/${artifact.artifactId}` : null;
          return {
            path: artifact.path,
            bytes: artifact.bytes,
            contentType: artifact.contentType,
            downloadUrl: base ? `${base}/download` : "",
            ...(base && previewable ? { previewUrl: `${base}/preview` } : {}),
          };
        }),
      };
    },
    setTodos: async (todos) => {
      await publishFrameworkEvent({ sessionId: session.id, type: "todo.updated", data: { todos } });
    },
    emitFileEdited: async (payload) => {
      await publishFrameworkEvent({ sessionId: session.id, type: "file.edited", data: payload });
    },
    emitArtifact: async (payload) => {
      await publishFrameworkEvent({ sessionId: session.id, type: "artifact.created", data: payload });
    },
  };
}

export class SessionRunner {
  constructor(private readonly deps: RunnerDeps) {}

  private async persist(event: FrameworkEvent): Promise<void> {
    if (event.type === "message.updated") {
      const message = event.data.message;
      const exists = await this.deps.store.getMessages(message.sessionId).then((entries) => entries.some((entry) => entry.info.id === message.id));
      if (exists) await this.deps.store.updateMessage(message.id, message);
      else await this.deps.store.appendMessage(message);
    } else if (event.type === "message.part.updated") {
      await this.deps.store.appendPart(event.data.part).catch(async () => this.deps.store.updatePart(event.data.part));
    } else if (event.type === "session.updated") {
      await this.deps.store.updateSession(event.data.session.id, event.data.session);
    }
    await publishFrameworkEvent({ sessionId: this.sessionIdOf(event), ...event });
  }

  private sessionIdOf(event: FrameworkEvent): string {
    if (event.type === "message.updated") return event.data.message.sessionId;
    if (event.type === "message.part.updated") return event.data.part.sessionId;
    if (event.type === "message.part.delta") return this.currentSessionId;
    if (event.type === "session.updated") return event.data.session.id;
    return this.currentSessionId;
  }

  private currentSessionId = "";

  private async publish(event: FrameworkEvent, sessionId: string): Promise<void> {
    await publishFrameworkEvent({ sessionId, ...event });
  }

  private async stampLease(sessionId: string): Promise<void> {
    const { FrameworkSessionModel } = await import("@/framework/core/session/mongo-models");
    await FrameworkSessionModel.updateOne(
      { sessionId },
      { $set: { leaseOwner: `node:${process.pid}`, leaseExpiresAt: new Date(Date.now() + leaseDurationMs) } },
    ).catch(() => undefined);
  }

  private async clearLease(sessionId: string): Promise<void> {
    const { FrameworkSessionModel } = await import("@/framework/core/session/mongo-models");
    await FrameworkSessionModel.updateOne({ sessionId }, { $set: { leaseOwner: null, leaseExpiresAt: null } }).catch(() => undefined);
  }

  async prompt(sessionId: string, input: { text: string; agent?: string; model?: ModelRef }): Promise<{ queued: boolean }> {
    const session = await this.deps.store.getSession(sessionId);
    if (!session) throw new Error("SESSION_NOT_FOUND");

    if (activeRuns.has(sessionId)) {
      await this.deps.store.enqueuePrompt(sessionId, { text: input.text, ...(input.agent ? { agent: input.agent } : {}), enqueuedAt: new Date().toISOString() });
      return { queued: true };
    }

    void this.runLoop(session, input);
    return { queued: false };
  }

  async replyPermission(sessionId: string, requestId: string, reply: Reply, feedback?: string): Promise<boolean> {
    const active = activeRuns.get(sessionId);
    if (!active) return false;
    return active.engine.reply(requestId, reply, feedback);
  }

  async abort(sessionId: string): Promise<void> {
    const active = activeRuns.get(sessionId);
    await this.deps.store.clearQueuedPrompts(sessionId);
    if (!active) return;
    active.abort();
  }

  private async runLoop(session: SessionInfo, input: { text: string; agent?: string; model?: ModelRef }): Promise<void> {
    this.currentSessionId = session.id;
    const registry = this.deps.registry;
    const agentName = input.agent ?? session.agent;
    const agentInfo = registry.get(agentName) ?? registry.get("default");
    const model = input.model ?? agentInfo?.model ?? session.model;

    const engine = new PermissionEngine(session.id, registry.rulesetsFor(agentInfo?.name ?? "default"), session.permission, {
      onAsked: async (request) => {
        await this.publish({ type: "session.status", data: { status: "waiting_permission" } }, session.id);
        await this.publish({ type: "permission.asked", data: { request } }, session.id);
      },
      onReplied: async (request, reply) => {
        await this.publish({ type: "permission.replied", data: { id: request.id, reply } }, session.id);
        await this.publish({ type: "session.status", data: { status: "running" } }, session.id);
      },
      onSessionRuleAdded: async (sessionId, rule) => {
        const latest = await this.deps.store.getSession(sessionId);
        if (!latest) return;
        await this.deps.store.updateSession(sessionId, { permission: [...latest.permission, rule] });
      },
    });

    const { emit, settled } = serializeEmit(async (event) => {
      await this.persist(event);
    });

    const projector = new PartProjector({ sessionId: session.id, agent: agentInfo?.name ?? "default", model });
    const toolDefs = new Map<string, ToolDef>((this.deps.tools ?? builtinTools).map((def) => [def.id, def]));
    const toolContext = (this.deps.buildToolContext ?? defaultToolContext)({ session, engine });
    const piTools = [...toolDefs.values()].map((def) => adaptTool(def, toolContext));

    const agent = new Agent({
      initialState: {
        systemPrompt: agentInfo?.prompt ?? "",
        model: this.deps.modelFor(model),
        tools: piTools,
        messages: await this.rebuildMessages(session.id),
      },
      streamFn: this.deps.streamFnFor(session),
      toolExecution: "sequential",
      shouldStopAfterTurn: ({ newMessages }) => newMessages.filter((message) => message.role === "assistant").length >= (agentInfo?.steps ?? 12),
    });

    const abortController = new AbortController();
    const abort = () => {
      abortController.abort();
      agent.abort();
    };
    activeRuns.set(session.id, { agent, engine, settled, abort });
    await this.stampLease(session.id);

    agent.beforeToolCall = async ({ toolCall, args }) => {
      const mapped = permissionForCall(toolDefs, toolCall.name, args);
      if (!mapped) return undefined;
      try {
        await engine.ask({
          sessionId: session.id,
          permission: mapped.permission,
          patterns: mapped.patterns,
          always: mapped.always,
          metadata: mapped.metadata,
          tool: { messageId: projector.currentAssistantMessageId ?? "", callId: toolCall.id },
        });
        return undefined;
      } catch (error) {
        if (error instanceof RejectedError) return { block: true, reason: error.message, terminate: false };
        throw error;
      }
    };

    agent.subscribe((event) => {
      switch (event.type) {
        case "message_start":
          if (event.message.role === "assistant") projector.onAssistantStart(emit);
          break;
        case "message_update": {
          const streamEvent = event.assistantMessageEvent;
          if (streamEvent.type === "text_delta") projector.onTextDelta(emit, streamEvent.contentIndex, streamEvent.delta);
          if (streamEvent.type === "thinking_delta") projector.onThinkingDelta(emit, streamEvent.contentIndex, streamEvent.delta);
          break;
        }
        case "message_end":
          if (event.message.role === "assistant") projector.onAssistantEnd(emit, event.message);
          break;
        case "tool_execution_start":
          projector.onToolExecutionStart(emit, event.toolCallId, event.toolName, event.args);
          break;
        case "tool_execution_update":
          projector.onToolExecutionUpdate(emit, event.toolCallId, event.partialResult);
          break;
        case "tool_execution_end":
          projector.onToolExecutionEnd(emit, event.toolCallId, event.result, event.isError);
          break;
      }
    });

    await this.publish({ type: "session.status", data: { status: "running" } }, session.id);

    try {
      projector.onUserPrompt(emit);
      await agent.prompt(input.text);
      await settled();
      const failed = agent.state.errorMessage;
      if (failed) {
        await this.publish({ type: "session.error", data: { name: "APIError", message: failed } }, session.id);
      }
      await this.publish({ type: "session.status", data: { status: "idle" } }, session.id);
    } catch (error) {
      await settled();
      const aborted = abortController.signal.aborted;
      await this.publish(
        aborted
          ? { type: "session.status", data: { status: "idle" } }
          : { type: "session.error", data: { name: "AgentRuntimeError", message: error instanceof Error ? error.message : "Agent 运行失败" } },
        session.id,
      );
      if (aborted) await this.publish({ type: "session.status", data: { status: "idle" } }, session.id);
    } finally {
      activeRuns.delete(session.id);
      engine.dispose();
      await this.clearLease(session.id);
    }

    // FIFO queued prompts (spec §13.3): settle fully, then take the next one.
    const next = await this.deps.store.dequeuePrompt(session.id);
    if (next) {
      const latest = await this.deps.store.getSession(session.id);
      if (latest) await this.runLoop(latest, { text: next.text, ...(next.agent ? { agent: next.agent } : {}) });
    }
  }

  /** Rebuilds PI-visible context from the persisted message log so a session
   *  survives process restarts (spec §8.2). */
  private async rebuildMessages(sessionId: string): Promise<AgentMessage[]> {
    const entries = await this.deps.store.getMessages(sessionId);
    const messages: AgentMessage[] = [];
    for (const { info, parts } of entries) {
      if (info.role === "user") {
        const text = parts
          .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        messages.push({ role: "user", content: text || "（空消息）", timestamp: Date.parse(info.time.created) || Date.now() });
      } else {
        const text = parts
          .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        if (!text) continue;
        messages.push({
          role: "assistant",
          content: [{ type: "text", text }],
          api: "openai-completions",
          provider: info.model.providerId,
          model: info.model.modelId,
          usage: { input: info.tokens?.input ?? 0, output: info.tokens?.output ?? 0, cacheRead: 0, cacheWrite: 0, totalTokens: (info.tokens?.input ?? 0) + (info.tokens?.output ?? 0) },
          stopReason: info.error ? "error" : "stop",
          ...(info.error ? { errorMessage: info.error.message } : {}),
          timestamp: Date.parse(info.time.created) || Date.now(),
        } as AgentMessage);
      }
    }
    return messages;
  }
}

export async function createFrameworkSession(input: {
  store: SessionStore;
  userId: string;
  workspaceId: string;
  agent?: string;
  model: ModelRef;
  prompt?: string;
}): Promise<SessionInfo> {
  const session: SessionInfo = {
    id: newSessionId(),
    workspaceId: input.workspaceId,
    userId: input.userId,
    title: (input.prompt ?? "新会话").slice(0, 40),
    agent: input.agent ?? "default",
    model: input.model,
    permission: [],
    queuedPrompts: [],
    time: { created: new Date().toISOString(), updated: new Date().toISOString() },
  };
  await input.store.createSession(session);
  return session;
}

export function isSessionActive(sessionId: string): boolean {
  return activeRuns.has(sessionId);
}

/** Test seam: the default store is Mongo; tests inject an in-memory one. */
export const defaultStore: SessionStore = mongoSessionStore;
