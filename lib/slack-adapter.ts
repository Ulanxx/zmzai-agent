import { createHmac, timingSafeEqual } from "node:crypto";

import { decryptConnectorHeaders } from "@/lib/connector-secrets";

const maxSkewMs = 5 * 60_000;

export function slackSignature(secret: string, timestamp: string, body: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`, "utf8").digest("hex")}`;
}

export function validateSlackRequest(input: { encryptedSecret: string | null | undefined; timestamp: string | null; signature: string | null; body: string; now?: Date }): string | null {
  if (!input.encryptedSecret || !input.timestamp || !input.signature) return "Slack 请求缺少签名字段";
  const timestampSeconds = Number(input.timestamp);
  if (!Number.isSafeInteger(timestampSeconds) || Math.abs((input.now ?? new Date()).getTime() - timestampSeconds * 1_000) > maxSkewMs) return "Slack 请求时间戳已过期";
  let secret = "";
  try { secret = decryptConnectorHeaders(input.encryptedSecret).secret ?? ""; } catch { return "Slack 签名密钥无效"; }
  const expected = Buffer.from(slackSignature(secret, input.timestamp, input.body));
  const supplied = Buffer.from(input.signature);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected) ? null : "Slack 签名无效";
}

export type SlackInbound = { eventId: string; text: string; actor: string; channel: string; responseUrl?: string };

export function normalizeSlackRequest(body: string, headers: { eventId?: string | null }): { challenge: string } | SlackInbound | null {
  const contentType = headers.eventId === "urlencoded" ? "application/x-www-form-urlencoded" : "application/json";
  let value: Record<string, unknown>;
  if (contentType === "application/x-www-form-urlencoded") {
    const form = new URLSearchParams(body);
    value = Object.fromEntries(form.entries());
  } else {
    try { value = JSON.parse(body) as Record<string, unknown>; } catch { return null; }
  }
  if (value.type === "url_verification" && typeof value.challenge === "string") return { challenge: value.challenge };
  const event = value.type === "event_callback" && value.event && typeof value.event === "object" ? value.event as Record<string, unknown> : value;
  const text = typeof event.text === "string" ? event.text.trim() : "";
  if (!text) return null;
  const eventId = typeof value.event_id === "string" ? value.event_id : typeof value.trigger_id === "string" ? value.trigger_id : headers.eventId && headers.eventId !== "urlencoded" ? headers.eventId : null;
  if (!eventId) return null;
  return { eventId, text, actor: String(event.user ?? value.user_id ?? "unknown"), channel: String(event.channel ?? value.channel_id ?? "unknown"), ...(typeof value.response_url === "string" ? { responseUrl: value.response_url } : {}) };
}
