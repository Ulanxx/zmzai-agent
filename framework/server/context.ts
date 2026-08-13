import { AgentRegistry, SessionRunner, type SessionInfo, type ModelRef, type ToolContext, type PermissionEngine, type Ruleset } from "@zmzai/agent-framework";
import { loadCustomAgents } from "@zmzai/agent-framework";
import { mongoEventLog } from "@/framework/core/events/mongo-event-log";
import { mongoSessionStore } from "@/framework/core/session/mongo-store";
import { createMongoWorkspaceFiles } from "@/framework/core/tools/mongo-workspace";
import { createRelayModel, createRelayStreamFunction } from "@/lib/relay-agent-stream";
import { buildExecSnapshot } from "@/lib/sandbox-snapshot";
import { runSandboxCommandAndStream } from "@/lib/sandbox-execution";
import { FrameworkSessionModel } from "@/framework/core/session/mongo-models";
import { getWorkspace } from "@/lib/workspaces";

/** Process-wide runner singleton assembled from the framework package + the
 *  product's Mongo/relay/OpenSandbox adapters (M5 §3). */

const globalHolder = globalThis as typeof globalThis & { __zmzaiFrameworkRunner?: SessionRunner | null };

function getOrCreateRunner(): SessionRunner {
  if (globalHolder.__zmzaiFrameworkRunner) return globalHolder.__zmzaiFrameworkRunner;

  const runner = new SessionRunner({
    store: mongoSessionStore,
    registry: new AgentRegistry(),
    eventLog: mongoEventLog,
    streamFnFor: (session) => createRelayStreamFunction({ userId: session.userId, taskRunId: session.id }),
    modelFor: (ref: ModelRef) => createRelayModel(ref.modelId),
    workspaceFor: (session) => createMongoWorkspaceFiles({ userId: session.userId, workspaceId: session.workspaceId }),
    sandbox: {
      buildSnapshot: async (input) => (await buildExecSnapshot({ userId: input.userId, workspaceId: input.workspaceId, runId: input.runId })).snapshot,
      run: async (input) => {
        const result = await runSandboxCommandAndStream({
          userId: input.userId,
          runId: input.runId,
          workspaceId: input.workspaceId,
          toolCallId: input.toolCallId,
          snapshot: input.snapshot,
          command: input.command,
        });
        return {
          ok: result.ok,
          exitCode: result.exitCode,
          outputText: result.outputText,
          durationMs: result.durationMs,
          ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
          artifacts: result.artifacts.map((artifact) => {
            const previewable = /^(text\/html|image\/(png|jpeg|gif|svg\+xml|webp)|application\/pdf|text\/(plain|markdown|css))/.test(artifact.contentType.toLowerCase());
            const base = artifact.artifactId ? `/api/fw/sessions/${input.runId}/artifacts/${artifact.artifactId}` : null;
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
    },
    leaseStore: {
      stamp: async (sessionId, owner, expiresAt) => {
        await FrameworkSessionModel.updateOne({ sessionId }, { $set: { leaseOwner: owner, leaseExpiresAt: expiresAt } }).catch(() => undefined);
      },
      clear: async (sessionId) => {
        await FrameworkSessionModel.updateOne({ sessionId }, { $set: { leaseOwner: null, leaseExpiresAt: null } }).catch(() => undefined);
      },
    },
    loadWorkspaceAgents: async (session: SessionInfo) => {
      const workspace = createMongoWorkspaceFiles({ userId: session.userId, workspaceId: session.workspaceId });
      const { agents } = await loadCustomAgents(workspace);
      return agents;
    },
    agentResolver: {
      // Workspace = 智能体：从 workspace 文档读 prompt/steps/permission，
      // 返回 ResolvedAgent。不再走 AgentVersion（已废弃）。
      resolve: async (session) => {
        const ws = await getWorkspace(session.userId, session.workspaceId);
        if (!ws) return null;
        return {
          agent: {
            name: ws.name || "default",
            description: ws.description || undefined,
            mode: "primary",
            model: { providerId: "relay", modelId: ws.defaultModel },
            prompt: ws.prompt || undefined,
            steps: ws.steps,
            permission: ws.permission as Ruleset,
          },
        };
      },
    },
    subagentDepth: 1,
    compaction: { enabled: true, contextWindow: 128_000, summaryModel: createRelayModel("gpt-5.6-luna") },
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
