/** Product compatibility layer (M5): re-exports the framework package's
 *  SessionRunner and friends, plus the product's Mongo-backed default store
 *  and the JSONL fallback (FW_MODE=local). The framework package owns the
 *  runner implementation; this file only assembles product defaults. */
export * from "@zmzai/agent-framework";
import { SessionRunner, createFrameworkSession, type SessionStore } from "@zmzai/agent-framework";
import { mongoSessionStore } from "@/framework/core/session/mongo-store";
import { createJsonlSessionStore } from "@/framework/core/session/jsonl-store";

export { SessionRunner, createFrameworkSession };

/** Default store: Mongo (cloud) or JSONL (FW_MODE=local). */
function resolveDefaultStore(): SessionStore {
  if (process.env.FW_MODE?.trim() === "local") {
    return createJsonlSessionStore({ dataDir: process.env.FW_DATA_DIR?.trim() || "./.fw-data" });
  }
  return mongoSessionStore;
}

export const defaultStore: SessionStore = resolveDefaultStore();
