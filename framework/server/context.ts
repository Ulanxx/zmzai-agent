import { AgentRegistry } from "@/framework/core/agent/registry";
import { SessionRunner, defaultStore } from "@/framework/core/runtime/runner";
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
    });
  }
  return holder.runner;
}

export function getFrameworkRegistry(): AgentRegistry {
  return new AgentRegistry();
}
