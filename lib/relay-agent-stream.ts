import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type StreamFunction,
  type Tool,
} from "@earendil-works/pi-ai";

import { getServerEnvironment } from "@/config/env";

export class RelayAgentError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "RelayAgentError";
  }
}

export function createRelayModel(id: string): Model<Api> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "zmzai-relay",
    baseUrl: getServerEnvironment().RELAY_AGENT_URL,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistant(model: Model<Api>, content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function textOf(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

function toOpenAiMessages(context: Context) {
  const messages: Array<Record<string, unknown>> = [];
  if (context.systemPrompt) messages.push({ role: "system", content: context.systemPrompt });
  for (const message of context.messages) {
    if (message.role === "user") messages.push({ role: "user", content: textOf(message.content) });
    if (message.role === "assistant") {
      const text = message.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
      const toolCalls = message.content
        .filter((item) => item.type === "toolCall")
        .map((item) => ({ id: item.id, type: "function", function: { name: item.name, arguments: JSON.stringify(item.arguments) } }));
      messages.push({ role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    }
    if (message.role === "toolResult") messages.push({ role: "tool", tool_call_id: message.toolCallId, content: textOf(message.content) });
  }
  return messages;
}

function toOpenAiTools(tools: Tool[] | undefined) {
  return tools?.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

export function mergeToolCallName(current: string, incoming: string): string {
  if (!current || incoming.startsWith(current)) return incoming;
  if (current.endsWith(incoming)) return current;
  return `${current}${incoming}`;
}

type OpenAiChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

function relayError(status: number, payload: unknown): RelayAgentError {
  const body = payload && typeof payload === "object" ? payload as { code?: unknown; error?: unknown } : {};
  return new RelayAgentError(typeof body.code === "string" ? body.code : `RELAY_HTTP_${status}`, typeof body.error === "string" ? body.error : `Relay 返回 HTTP ${status}`);
}

export function isRetryableRelayStatus(status: number): boolean {
  return [408, 500, 502, 503, 504].includes(status);
}

export function createRelayStreamFunction(identity: { userId: string; taskRunId: string }): StreamFunction {
  return (model, context, options) => streamFromRelay(model, context, options, identity);
}

function streamFromRelay(model: Model<Api>, context: Context, options: SimpleStreamOptions | undefined, identity: { userId: string; taskRunId: string }): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const environment = getServerEnvironment();
    const secret = environment.RELAY_AGENT_SERVICE_SECRET_CURRENT;
    if (!secret) {
      const error = assistant(model, [], "error", "RELAY_AGENT_SERVICE_SECRET_CURRENT 未配置");
      stream.push({ type: "error", reason: "error", error });
      stream.end(error);
      return;
    }

    const partial = assistant(model, [], "pending");
    stream.push({ type: "start", partial });
    try {
      const requestBody = JSON.stringify({
        userId: identity.userId,
        taskRunId: identity.taskRunId,
        requestId: `${identity.taskRunId}_${Date.now()}`,
        model: model.id,
        messages: toOpenAiMessages(context),
        tools: toOpenAiTools(context.tools),
        tool_choice: context.tools?.length ? "auto" : "none",
        stream: true,
        ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
      });
      let response: Response | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          response = await fetch(`${environment.RELAY_AGENT_URL.replace(/\/$/, "")}/api/internal/agent/chat`, {
            method: "POST",
            headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
            body: requestBody,
            cache: "no-store",
            signal: options?.signal,
          });
        } catch (cause) {
          if (attempt === 0 && !options?.signal?.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            continue;
          }
          throw cause;
        }
        if (response.ok && response.body) break;
        const error = relayError(response.status, await response.json().catch(() => null));
        if (attempt === 0 && isRetryableRelayStatus(response.status) && !options?.signal?.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        throw error;
      }
      if (!response?.ok || !response.body) throw relayError(response?.status ?? 500, null);

      let buffer = "";
      let textStarted = false;
      let finishReason: string | null = null;
      const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      const consume = (payload: string) => {
        if (!payload || payload === "[DONE]") return;
        const chunk = JSON.parse(payload) as OpenAiChunk;
        const choice = chunk.choices?.[0];
        if (!choice) return;
        finishReason ??= choice.finish_reason ?? null;
        if (choice.delta?.content) {
          if (!textStarted) {
            partial.content.push({ type: "text", text: "" });
            stream.push({ type: "text_start", contentIndex: partial.content.length - 1, partial });
            textStarted = true;
          }
          const contentIndex = partial.content.length - 1;
          const item = partial.content[contentIndex];
          if (item.type === "text") item.text += choice.delta.content;
          stream.push({ type: "text_delta", contentIndex, delta: choice.delta.content, partial });
        }
        for (const call of choice.delta?.tool_calls ?? []) {
          const index = call.index ?? 0;
          const current = toolCalls.get(index) ?? { id: call.id ?? `call_${index}`, name: call.function?.name ?? "", arguments: "" };
          if (call.id) current.id = call.id;
          if (call.function?.name) current.name = mergeToolCallName(current.name, call.function.name);
          if (call.function?.arguments) current.arguments += call.function.arguments;
          toolCalls.set(index, current);
        }
      };

      while (true) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        const records = buffer.split(/\r?\n\r?\n/);
        buffer = records.pop() ?? "";
        for (const record of records) {
          const data = record.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
          consume(data);
        }
      }
      for (const call of toolCalls.values()) {
        let argumentsValue: Record<string, unknown> = {};
        try { argumentsValue = JSON.parse(call.arguments) as Record<string, unknown>; } catch { /* Pi will surface the invalid tool call as an error. */ }
        const toolCall = { type: "toolCall" as const, id: call.id, name: call.name, arguments: argumentsValue };
        partial.content.push(toolCall);
        stream.push({ type: "toolcall_end", contentIndex: partial.content.length - 1, toolCall, partial });
      }
      partial.stopReason = toolCalls.size || finishReason === "tool_calls" ? "toolUse" : finishReason === "length" ? "length" : "stop";
      partial.usage = emptyUsage();
      stream.push({ type: "done", reason: partial.stopReason as "stop" | "length" | "toolUse", message: partial });
      stream.end(partial);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Relay 调用失败";
      const error = assistant(model, [], options?.signal?.aborted ? "aborted" : "error", message);
      stream.push({ type: "error", reason: error.stopReason === "aborted" ? "aborted" : "error", error });
      stream.end(error);
    }
  })();
  return stream;
}
