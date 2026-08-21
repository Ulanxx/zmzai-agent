import { apiError } from "@/lib/api-error";
import { parseBearerApiKey, resolveAgentApiKey, type AgentApiScope, type ResolvedAgentApiKey } from "@/lib/agent-api-keys";

export async function requireAgentApiKey(request: Request, scope: AgentApiScope): Promise<{ key: ResolvedAgentApiKey } | { response: Response }> {
  const token = parseBearerApiKey(request.headers.get("authorization"));
  const key = token ? await resolveAgentApiKey(token) : null;
  if (!key || !key.scopes.includes(scope)) return { response: apiError("API_KEY_UNAUTHORIZED", 401, "API Key 无效或没有所需权限") };
  return { key };
}

export function workspaceAllowed(key: ResolvedAgentApiKey, workspaceId: string): boolean {
  return key.workspaceIds.includes(workspaceId);
}
