import { AgentRegistry, SessionRunner, type SessionInfo, type ModelRef, type ToolContext, type PermissionEngine, type Ruleset } from "@zmzai/agent-framework";
import { loadCustomAgents } from "@zmzai/agent-framework";
import { productEventLog } from "@/framework/core/events/product-event-log";
import { mongoSessionStore } from "@/framework/core/session/mongo-store";
import { createMongoWorkspaceFiles, createWorkspaceAggregateFiles } from "@/framework/core/tools/mongo-workspace";
import { createRelayModel, createRelayStreamFunction } from "@/lib/relay-agent-stream";
import { buildExecSnapshot } from "@/lib/sandbox-snapshot";
import { runSandboxCommandAndStream } from "@/lib/sandbox-execution";
import { activeRunIdForSession } from "@/lib/task-run-control";
import { FrameworkSessionModel } from "@/framework/core/session/mongo-models";
import { defaultRelayModel, getWorkspace } from "@/lib/workspaces";
import { resolveWorkspaceConnectorTools } from "@/lib/mcp-connector-tools";
import { combineAgentInstructions } from "@/lib/project-agent-context";
import { getWorkspaceSkillsByIds } from "@/lib/workspace-skills";
import { getWorkspacePluginSkillsByIds } from "@/lib/workspace-plugins";
import { taskForSession } from "@/lib/task-run-control";
import { ProjectModel } from "@/models/project";
import { ProjectContextItemModel } from "@/models/project-context-item";

/** Process-wide runner singleton assembled from the framework package + the
 *  product's Mongo/relay/OpenSandbox adapters (M5 §3). */

const globalHolder = globalThis as typeof globalThis & { __zmzaiFrameworkRunner?: SessionRunner | null };

function getOrCreateRunner(): SessionRunner {
  if (globalHolder.__zmzaiFrameworkRunner) return globalHolder.__zmzaiFrameworkRunner;

  const runner = new SessionRunner({
    store: mongoSessionStore,
    registry: new AgentRegistry(),
    eventLog: productEventLog,
    streamFnFor: (session) => createRelayStreamFunction({ userId: session.userId, taskRunId: () => activeRunIdForSession(session.id) }),
    modelFor: (ref: ModelRef) => createRelayModel(ref.modelId),
    workspaceFor: (session) => createMongoWorkspaceFiles({ userId: session.userId, workspaceId: session.workspaceId, sessionId: session.id }),
    sandbox: {
      buildSnapshot: async (input) => (await buildExecSnapshot({ userId: input.userId, workspaceId: input.workspaceId, runId: input.runId })).snapshot,
      run: async (input) => {
        const result = await runSandboxCommandAndStream({
          userId: input.userId,
          runId: await activeRunIdForSession(input.runId),
          workspaceId: input.workspaceId,
          toolCallId: input.toolCallId,
          snapshot: input.snapshot,
          command: input.command,
        });
        return {
          ok: result.ok,
          outcome: result.outcome,
          exitCode: result.exitCode,
          outputText: result.outputText,
          durationMs: result.durationMs,
          ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
          artifacts: result.artifacts.map((artifact) => {
            const previewable = /^(text\/html|image\/(png|jpeg|gif|svg\+xml|webp)|application\/pdf|text\/(plain|markdown|css)|application\/vnd\.openxmlformats-officedocument\.presentationml\.presentation)/.test(artifact.contentType.toLowerCase());
            const base = artifact.artifactId ? `/api/fw/sessions/${input.runId}/artifacts/${artifact.artifactId}` : null;
            return {
              ...(artifact.artifactId ? { artifactId: artifact.artifactId } : {}),
              path: artifact.path,
              bytes: artifact.bytes,
              contentType: artifact.contentType,
              downloadUrl: base ? `${base}/download` : "",
              ...(base && previewable ? { previewUrl: `${base}/preview` } : {}),
              ...(artifact.workspaceContent !== undefined ? { workspaceContent: artifact.workspaceContent } : {}),
            };
          }),
        };
      },
    },
    leaseStore: {
      stamp: async (sessionId, owner, expiresAt) => {
        await FrameworkSessionModel.updateOne({ sessionId }, { $set: { leaseOwner: owner, leaseExpiresAt: expiresAt } }).catch(() => undefined);
      },
      clear: async (sessionId) => {
        await FrameworkSessionModel.updateOne({ sessionId }, { $set: { leaseOwner: null, leaseExpiresAt: null } }).catch(() => undefined);
      },
    },
    sessionRuleTtlMs: 24 * 60 * 60_000,
    loadWorkspaceAgents: async (session: SessionInfo) => {
      // .zmzai/agents/*.md 是 workspace 级资产（跨会话共享），走聚合视图而非会话隔离视图
      const workspace = createWorkspaceAggregateFiles(session.workspaceId);
      const { agents } = await loadCustomAgents(workspace);
      return agents;
    },
    agentResolver: {
      // Workspace = 智能体：从 workspace 文档读 prompt/steps/permission，
      // 返回 ResolvedAgent。不再走 AgentVersion（已废弃）。
      resolve: async (session) => {
        // Child sessions must keep their explicit `explore` / `general`
        // identity. Applying the Workspace primary-agent resolver here would
        // silently replace its prompt, steps and permission policy.
        if (session.parentId) return null;
        const ws = await getWorkspace(session.userId, session.workspaceId);
        if (!ws) return null;
        const task = await taskForSession(session.id);
        const project = task?.projectId ? await ProjectModel.findOne({ projectId: task.projectId, userId: session.userId, workspaceId: session.workspaceId }).select({ projectId: 1, instructions: 1 }).lean() : null;
        const projectContext = project ? await ProjectContextItemModel.find({ projectId: project.projectId, userId: session.userId, workspaceId: session.workspaceId, enabled: true }).select({ type: 1, title: 1, content: 1, url: 1 }).sort({ createdAt: 1 }).lean() : [];
        const [skills, pluginSkills] = await Promise.all([
          getWorkspaceSkillsByIds({ userId: session.userId, workspaceId: session.workspaceId, skillIds: ws.skillIds }),
          getWorkspacePluginSkillsByIds({ userId: session.userId, workspaceId: session.workspaceId, pluginIds: ws.pluginIds }),
        ]);
        // 自治档位：auto 档在 workspace 规则前预置 bash 放行；排在后面（last-match-wins）
        // 的显式规则仍可覆盖它，deny/ask 不被绕过。"always" 是历史值，等同 ask。
        const autoAllow: Ruleset = ws.approvalMode === "auto" ? [{ permission: "bash", pattern: "*", action: "allow" }] : [];
        return {
          agent: {
            name: ws.name || "default",
            description: ws.description || undefined,
            mode: "primary",
            model: { providerId: "relay", modelId: ws.defaultModel },
            prompt: combineAgentInstructions(ws.prompt, project?.instructions, projectContext, [...skills, ...pluginSkills]),
            steps: ws.steps,
            permission: [...autoAllow, ...(ws.permission as Ruleset)],
          },
          tools: await resolveWorkspaceConnectorTools({ userId: session.userId, workspaceId: session.workspaceId, connectorIds: ws.connectorIds }),
        };
      },
    },
    subagentDepth: 1,
    compaction: { enabled: true, contextWindow: 128_000, summaryModel: createRelayModel(defaultRelayModel) },
  });

  globalHolder.__zmzaiFrameworkRunner = runner;
  return runner;
}

export function getFrameworkRunner(): SessionRunner {
  return getOrCreateRunner();
}

export function getFrameworkRegistry(): AgentRegistry {
  return new AgentRegistry();
}

export type { SessionInfo, ModelRef, ToolContext, PermissionEngine };
