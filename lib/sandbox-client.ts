import type { SandboxSnapshot, SandboxCommand, SandboxLimits } from "@/lib/sandbox-types";

export type SandboxRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type SandboxRunView = {
  id: string;
  userId: string;
  taskRunId?: string;
  requestId?: string;
  status: SandboxRunStatus;
  exitCode?: number;
  events: Array<{ id: string; at: string; kind: string; message: string }>;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
};

export type SandboxStreamEvent = { sequence: number; type: string; at: string; text: string };

export class AgentSandboxError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "AgentSandboxError";
  }
}

function sandboxConfig() {
  const url = process.env.SANDBOX_AGENT_URL?.trim().replace(/\/$/, "") ?? "";
  const secret = process.env.SANDBOX_AGENT_SERVICE_SECRET_CURRENT?.trim() ?? "";
  if (!url || !secret) throw new AgentSandboxError("SANDBOX_NOT_CONFIGURED", "缺少 SANDBOX_AGENT_URL 或 SANDBOX_AGENT_SERVICE_SECRET_CURRENT 配置");
  return { url, secret };
}

async function parseError(response: Response): Promise<AgentSandboxError> {
  const text = await response.text().catch(() => "");
  let code = "SANDBOX_REQUEST_FAILED";
  let message = text || `Sandbox ${response.status}`;
  try {
    const body = JSON.parse(text) as { code?: unknown; error?: unknown };
    if (typeof body.code === "string") code = body.code;
    if (typeof body.error === "string") message = body.error;
  } catch { /* keep raw text */ }
  if (response.status === 401 || response.status === 403) return new AgentSandboxError("SANDBOX_AUTH_FAILED", "Sandbox 服务认证失败", response.status);
  if (response.status === 429) return new AgentSandboxError("RATE_LIMITED", message, response.status);
  return new AgentSandboxError(code, message, response.status);
}

export async function createAgentSandboxRun(input: { userId: string; taskRunId: string; requestId: string; snapshot: SandboxSnapshot; command: SandboxCommand; limits?: SandboxLimits }): Promise<SandboxRunView> {
  const config = sandboxConfig();
  let response: Response;
  try {
    response = await fetch(`${config.url}/api/internal/agent/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.secret}`, "content-type": "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
    });
  } catch {
    throw new AgentSandboxError("SANDBOX_UNAVAILABLE", "无法连接 Sandbox 服务");
  }
  if (!response.ok) throw await parseError(response);
  const body = (await response.json()) as { run?: SandboxRunView };
  if (!body.run) throw new AgentSandboxError("SANDBOX_INVALID_RESPONSE", "Sandbox 创建响应缺少 run");
  return body.run;
}

export async function getAgentSandboxRun(runId: string): Promise<SandboxRunView | null> {
  const config = sandboxConfig();
  let response: Response;
  try {
    response = await fetch(`${config.url}/api/internal/agent/runs/${encodeURIComponent(runId)}`, {
      headers: { authorization: `Bearer ${config.secret}` },
      cache: "no-store",
    });
  } catch {
    throw new AgentSandboxError("SANDBOX_UNAVAILABLE", "无法连接 Sandbox 服务");
  }
  if (response.status === 404) return null;
  if (!response.ok) throw await parseError(response);
  const body = (await response.json()) as { run?: SandboxRunView };
  return body.run ?? null;
}

export type SandboxArtifactMeta = { path: string; bytes: number; contentType: string; sha256: string; tooLarge: boolean };

export async function getAgentSandboxRunArtifacts(runId: string): Promise<SandboxArtifactMeta[]> {
  const config = sandboxConfig();
  let response: Response;
  try {
    response = await fetch(`${config.url}/api/internal/agent/runs/${encodeURIComponent(runId)}/artifacts`, {
      headers: { authorization: `Bearer ${config.secret}` },
      cache: "no-store",
    });
  } catch {
    throw new AgentSandboxError("SANDBOX_UNAVAILABLE", "无法连接 Sandbox 服务");
  }
  if (response.status === 404) return [];
  if (!response.ok) throw await parseError(response);
  const body = (await response.json()) as { artifacts?: SandboxArtifactMeta[] };
  return body.artifacts ?? [];
}

export async function getAgentSandboxRunArtifact(runId: string, path: string): Promise<{ content: Buffer; contentType: string } | null> {
  const config = sandboxConfig();
  let response: Response;
  try {
    response = await fetch(`${config.url}/api/internal/agent/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(path)}`, {
      headers: { authorization: `Bearer ${config.secret}` },
      cache: "no-store",
    });
  } catch {
    throw new AgentSandboxError("SANDBOX_UNAVAILABLE", "无法连接 Sandbox 服务");
  }
  if (response.status === 404) return null;
  if (!response.ok) throw await parseError(response);
  const arrayBuffer = await response.arrayBuffer();
  return { content: Buffer.from(arrayBuffer), contentType: response.headers.get("content-type") ?? "application/octet-stream" };
}

export async function cancelAgentSandboxRun(runId: string): Promise<void> {
  const config = sandboxConfig();
  let response: Response;
  try {
    response = await fetch(`${config.url}/api/internal/agent/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.secret}` },
      cache: "no-store",
    });
  } catch {
    throw new AgentSandboxError("SANDBOX_UNAVAILABLE", "无法连接 Sandbox 服务");
  }
  if (response.status === 404) return;
  if (!response.ok) throw await parseError(response);
}

/**
 * Streams sandbox events over the internal SSE endpoint. Each parsed frame is
 * passed to `onEvent`; the promise resolves when the stream closes (terminal
 * state or abort).
 */
export async function streamAgentSandboxEvents(runId: string, onEvent: (event: SandboxStreamEvent) => void, signal?: AbortSignal): Promise<void> {
  const config = sandboxConfig();
  let response: Response;
  try {
    response = await fetch(`${config.url}/api/internal/agent/runs/${encodeURIComponent(runId)}/events`, {
      headers: { authorization: `Bearer ${config.secret}` },
      cache: "no-store",
      signal,
    });
  } catch {
    if (signal?.aborted) return;
    throw new AgentSandboxError("SANDBOX_UNAVAILABLE", "无法连接 Sandbox 事件流");
  }
  if (!response.ok) throw await parseError(response);
  const reader = response.body?.getReader();
  if (!reader) throw new AgentSandboxError("SANDBOX_STREAM_EMPTY", "Sandbox 事件流为空");
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const records = buffer.split(/\n\n/);
    buffer = records.pop() ?? "";
    for (const record of records) {
      let eventType = "message";
      const dataLines: string[] = [];
      for (const line of record.split("\n")) {
        if (line.startsWith("event:")) eventType = line.slice(6).trim();
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      const data = dataLines.join("\n");
      if (!data) continue;
      try {
        const parsed = JSON.parse(data) as { id?: unknown; runId?: unknown; sequence?: unknown; type?: unknown; at?: unknown; data?: { text?: unknown } };
        onEvent({
          sequence: typeof parsed.sequence === "number" ? parsed.sequence : 0,
          type: typeof parsed.type === "string" ? parsed.type : eventType,
          at: typeof parsed.at === "string" ? parsed.at : "",
          text: typeof parsed.data?.text === "string" ? parsed.data.text : "",
        });
      } catch { /* ignore malformed frames */ }
    }
  }
}
