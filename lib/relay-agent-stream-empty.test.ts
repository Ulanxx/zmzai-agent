import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRelayModel, createRelayStreamFunction } from "@/lib/relay-agent-stream";

const envBackup: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ["MONGODB_URI", "AUTH_SECRET", "RELAY_AGENT_URL", "RELAY_AGENT_SERVICE_SECRET_CURRENT"]) envBackup[key] = process.env[key];
  process.env.MONGODB_URI = "mongodb://localhost/zmzai_test";
  process.env.AUTH_SECRET = "a".repeat(32);
  process.env.RELAY_AGENT_URL = "http://relay.test";
  process.env.RELAY_AGENT_SERVICE_SECRET_CURRENT = "test-secret";
});

afterEach(() => {
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
});

async function collect(stream: AsyncIterable<{ type: string; reason?: string }>): Promise<Array<{ type: string; reason?: string }>> {
  const events: Array<{ type: string; reason?: string }> = [];
  for await (const event of stream) events.push(event);
  return events;
}

function minimalContext() {
  return { systemPrompt: "", messages: [], tools: [] } as never;
}

describe("relay stream empty-response handling", () => {
  it("emits an error instead of an empty successful turn when the relay returns an empty stream", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200, headers: { "content-type": "text/event-stream" } })));
    const streamFn = createRelayStreamFunction({ userId: "user_1", taskRunId: "run_1" });
    const events = await collect(streamFn(createRelayModel("deepseek-v4-flash"), minimalContext(), {}) as never);
    const errors = events.filter((event) => event.type === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  it("passes a normal completion through", async () => {
    const sse = "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })));
    const streamFn = createRelayStreamFunction({ userId: "user_1", taskRunId: "run_1" });
    const events = await collect(streamFn(createRelayModel("deepseek-v4-flash"), minimalContext(), {}) as never);
    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("forwards OpenAI-compatible reasoning deltas before the visible response", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"reasoning_content":"先检查当前任务。"}}]}',
      'data: {"choices":[{"delta":{"reasoning":"然后执行工具。"}}]}',
      'data: {"choices":[{"delta":{"content":"开始处理。"},"finish_reason":"stop"}]}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })));
    const streamFn = createRelayStreamFunction({ userId: "user_1", taskRunId: "run_1" });
    const events = await collect(streamFn(createRelayModel("deepseek-v4-flash"), minimalContext(), { reasoning: "low" } as never) as never);

    expect(events.map((event) => event.type)).toContain("thinking_start");
    expect(events.map((event) => event.type)).toContain("thinking_delta");
    expect(events.some((event) => event.type === "done")).toBe(true);
  });

  it("normalizes PI's minimal reasoning level for Relay's strict API contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"好的"}}]}\n\ndata: [DONE]\n\n', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const streamFn = createRelayStreamFunction({ userId: "user_1", taskRunId: "run_1" });

    await collect(streamFn(createRelayModel("deepseek-v4-flash"), minimalContext(), { reasoning: "minimal" } as never) as never);

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { reasoning_effort?: string };
    expect(request.reasoning_effort).toBe("low");
  });
});
