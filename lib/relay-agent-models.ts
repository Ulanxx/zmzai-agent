import { getServerEnvironment } from "@/config/env";

export type AgentModelSelectorData = {
  featured: { id: string; name: string; description: string; channel?: string; maxInputTokens: number; maxOutputTokens: number; allowedReasoningEfforts: string[] }[];
  channels: { id: string; name: string; models: { id: string; name: string; channel?: string; meta?: Record<string, string>; maxInputTokens: number; maxOutputTokens: number; allowedReasoningEfforts: string[] }[] }[];
};

export async function listRelayAgentModels(userId: string): Promise<AgentModelSelectorData> {
  const environment = getServerEnvironment();
  const secret = environment.RELAY_AGENT_SERVICE_SECRET_CURRENT;
  if (!secret) throw new Error("RELAY_AGENT_SERVICE_SECRET_CURRENT 未配置");

  const response = await fetch(`${environment.RELAY_AGENT_URL.replace(/\/$/, "")}/api/internal/agent/models`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ userId }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => null) as { modelSelectorData?: AgentModelSelectorData; error?: unknown } | null;
  if (!response.ok || !body?.modelSelectorData) {
    throw new Error(typeof body?.error === "string" ? body.error : "无法读取可用模型目录");
  }
  return body.modelSelectorData;
}
