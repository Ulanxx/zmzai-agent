import { z } from "zod";

export const relayAgentContractVersion = "v1" as const;
export const sandboxAgentContractVersion = "v1" as const;

export const sandboxRunStatusSchema = z.enum(["queued", "planning", "running", "waiting_approval", "cancellation_requested", "cleanup_pending", "succeeded", "failed", "cancelled"]);
export type ContractSandboxRunStatus = z.infer<typeof sandboxRunStatusSchema>;

export const sandboxRunViewSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  taskRunId: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
  status: sandboxRunStatusSchema,
  exitCode: z.number().int().optional(),
  events: z.array(z.object({ id: z.string(), at: z.string(), kind: z.string(), message: z.string() }).passthrough()),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
});

export const sandboxRunResponseSchema = z.object({ run: sandboxRunViewSchema });

export const sandboxArtifactMetaSchema = z.object({
  path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  contentType: z.string().min(1),
  sha256: z.string().length(64),
  tooLarge: z.boolean(),
});

export const relayAgentChatRequestSchema = z.object({
  userId: z.string().min(1).max(128),
  taskRunId: z.string().min(1).max(128),
  requestId: z.string().min(1).max(128),
  model: z.string().min(1),
  messages: z.array(z.object({ role: z.string(), content: z.string().nullable() }).passthrough()).min(1),
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional(),
  stream: z.boolean(),
  max_tokens: z.number().int().positive().optional(),
  reasoning_effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
});

export type RelayAgentChatRequest = z.infer<typeof relayAgentChatRequestSchema>;

export function isContractErrorCode(value: unknown): value is "INSUFFICIENT_CREDITS" | "RATE_LIMITED" | "UPSTREAM_ERROR" | "NO_CHANNEL" {
  return value === "INSUFFICIENT_CREDITS" || value === "RATE_LIMITED" || value === "UPSTREAM_ERROR" || value === "NO_CHANNEL";
}
