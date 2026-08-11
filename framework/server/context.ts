import { AgentRegistry } from "@/framework/core/agent/registry";
import { loadCustomAgents } from "@/framework/core/agent/loader";
import { SessionRunner, defaultStore } from "@/framework/core/runtime/runner";
import { createMongoWorkspaceFiles } from "@/framework/core/tools/mongo-workspace";
import { createRelayModel, createRelayStreamFunction } from "@/lib/relay-agent-stream";
import type { ModelRef } from "@/framework/core/session/types";

/** Process-wide runner singleton (globalThis guard against Next.js HMR
 *  module re-instantiation). */

type RunnerHolder = { runner: SessionRunner | null };

const globalHolder = globalThis as typeof globalThis & { __zmzaiFrameworkRunner?: RunnerHolder };
const holder = globalHolder.__zmzaiFrameworkRunner ?? { runner: null };
globalHolder.__zmzaiFrameworkRunner = holder;

export function getFrameworkRunner(): SessionRunner {
  if (!holder.runner) {
    holder.runner = new SessionRunner({
      store: defaultStore,
      registry: new AgentRegistry(),
      streamFnFor: (session) => createRelayStreamFunction({ userId: session.userId, taskRunId: session.id }),
      modelFor: (ref: ModelRef) => createRelayModel(ref.modelId),
      loadWorkspaceAgents: async (session) => {
        const workspace = createMongoWorkspaceFiles({ userId: session.userId, workspaceId: session.workspaceId });
        const { agents } = await loadCustomAgents(workspace);
        return agents;
      },
      subagentDepth: 1,
      // v0: reuse the relay model for summaries (no dedicated cheap-model
      // catalog entry yet). contextWindow matches createRelayModel's 128k.
      compaction: { enabled: true, contextWindow: 128_000, summaryModel: createRelayModel("gpt-5.6-luna") },
    });
  }
  return holder.runner;
}

export function getFrameworkRegistry(): AgentRegistry {
  return new AgentRegistry();
}
