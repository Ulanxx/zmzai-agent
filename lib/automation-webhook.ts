import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { decryptConnectorHeaders, encryptConnectorHeaders } from "@/lib/connector-secrets";

const maxSkewMs = 5 * 60_000;

export function generateAutomationWebhookSecret(): { plaintext: string; encrypted: string; prefix: string } {
  const plaintext = `whk_${randomBytes(32).toString("base64url")}`;
  return { plaintext, encrypted: encryptConnectorHeaders({ secret: plaintext }), prefix: plaintext.slice(0, 16) };
}

export function webhookPayloadHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function webhookPayloadMatches(payloadHash: string | null | undefined, body: string): boolean {
  return Boolean(payloadHash) && payloadHash === webhookPayloadHash(body);
}

export function webhookSignature(secret: string, timestamp: string, eventId: string, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${eventId}.${body}`, "utf8").digest("hex")}`;
}

export function validateAutomationWebhook(input: { encryptedSecret: string | null | undefined; timestamp: string | null; eventId: string | null; signature: string | null; body: string; now?: Date }): string | null {
  if (!input.encryptedSecret || !input.timestamp || !input.eventId || !input.signature) return "Webhook 缺少签名字段";
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(input.eventId)) return "Webhook event id 格式不正确";
  const date = new Date(input.timestamp);
  if (Number.isNaN(date.getTime()) || Math.abs((input.now ?? new Date()).getTime() - date.getTime()) > maxSkewMs) return "Webhook 时间戳已过期";
  let secret: string;
  try { secret = decryptConnectorHeaders(input.encryptedSecret).secret ?? ""; } catch { return "Webhook 密钥无效"; }
  const expected = webhookSignature(secret, input.timestamp, input.eventId, input.body);
  const supplied = Buffer.from(input.signature);
  const target = Buffer.from(expected);
  return supplied.length === target.length && timingSafeEqual(supplied, target) ? null : "Webhook 签名无效";
}
