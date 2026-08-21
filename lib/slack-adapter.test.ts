import { describe, expect, it } from "vitest";

import { encryptConnectorHeaders } from "@/lib/connector-secrets";
import { normalizeSlackRequest, slackSignature, validateSlackRequest } from "@/lib/slack-adapter";

process.env.AUTH_SECRET ??= "slack-adapter-test-secret-that-is-long-enough";

describe("Slack inbound adapter", () => {
  it("validates Slack signatures and normalizes event payloads", () => {
    const secret = "slack-signing-secret";
    const encrypted = encryptConnectorHeaders({ secret });
    const timestamp = "1787223600";
    const body = JSON.stringify({ type: "event_callback", event_id: "Ev_123", event: { text: "@zmzai 做一份周报", user: "U_1", channel: "C_1" } });
    const now = new Date(Number(timestamp) * 1_000);
    expect(validateSlackRequest({ encryptedSecret: encrypted, timestamp, signature: slackSignature(secret, timestamp, body), body, now })).toBeNull();
    expect(normalizeSlackRequest(body, { eventId: "request-1" })).toEqual({ eventId: "Ev_123", text: "@zmzai 做一份周报", actor: "U_1", channel: "C_1" });
  });

  it("supports Slack URL verification and rejects stale requests", () => {
    const secret = "slack-signing-secret";
    const encrypted = encryptConnectorHeaders({ secret });
    const timestamp = "1787223600";
    const body = JSON.stringify({ type: "url_verification", challenge: "challenge-1" });
    expect(normalizeSlackRequest(body, { eventId: "request-1" })).toEqual({ challenge: "challenge-1" });
    expect(validateSlackRequest({ encryptedSecret: encrypted, timestamp, signature: slackSignature(secret, timestamp, body), body, now: new Date(Number(timestamp) * 1_000 + 6 * 60_000) })).toBe("Slack 请求时间戳已过期");
  });

  it("uses Slack's trigger id as the stable slash-command idempotency key", () => {
    const body = "command=%2Fzmzai&trigger_id=1337.42&user_id=U_1&channel_id=C_1&text=%E5%81%9A%E5%91%A8%E6%8A%A5&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2F1";
    expect(normalizeSlackRequest(body, { eventId: "urlencoded" })).toEqual({ eventId: "1337.42", text: "做周报", actor: "U_1", channel: "C_1", responseUrl: "https://hooks.slack.com/commands/1" });
  });
});
