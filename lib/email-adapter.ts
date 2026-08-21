import { createHmac, timingSafeEqual } from "node:crypto";

import { decryptConnectorHeaders } from "@/lib/connector-secrets";

const maxSkewMs = 5 * 60_000;

export function emailSignature(secret: string, timestamp: string, messageId: string, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${messageId}.${body}`, "utf8").digest("hex")}`;
}

export function validateEmailRequest(input: { encryptedSecret: string | null | undefined; timestamp: string | null; messageId: string | null; signature: string | null; body: string; now?: Date }): string | null {
  if (!input.encryptedSecret || !input.timestamp || !input.messageId || !input.signature) return "邮件入口缺少签名字段";
  if (!/^[A-Za-z0-9._:@<>+-]{1,320}$/.test(input.messageId)) return "邮件 message id 格式不正确";
  const date = new Date(input.timestamp);
  if (Number.isNaN(date.getTime()) || Math.abs((input.now ?? new Date()).getTime() - date.getTime()) > maxSkewMs) return "邮件请求时间戳已过期";
  let secret = "";
  try { secret = decryptConnectorHeaders(input.encryptedSecret).secret ?? ""; } catch { return "邮件签名密钥无效"; }
  const expected = Buffer.from(emailSignature(secret, input.timestamp, input.messageId, input.body));
  const supplied = Buffer.from(input.signature);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected) ? null : "邮件签名无效";
}

export type EmailInbound = { messageId: string; from: string; to: string; subject: string; text: string; inReplyTo?: string | null; references?: string[] };

export function normalizeEmailRequest(body: string): EmailInbound | null {
  let value: Record<string, unknown>;
  try { value = JSON.parse(body) as Record<string, unknown>; } catch { return null; }
  const messageId = typeof value.message_id === "string" ? value.message_id.trim() : typeof value.messageId === "string" ? value.messageId.trim() : "";
  const from = typeof value.from === "string" ? value.from.trim() : "";
  const to = typeof value.to === "string" ? value.to.trim() : "";
  const subject = typeof value.subject === "string" ? value.subject.trim() : "(无主题)";
  const text = typeof value.text === "string" ? value.text.trim() : typeof value.text_body === "string" ? value.text_body.trim() : "";
  if (!messageId || !from || !to || !text) return null;
  const references = Array.isArray(value.references) ? value.references.filter((item): item is string => typeof item === "string").slice(0, 20) : undefined;
  return { messageId, from, to, subject, text, inReplyTo: typeof value.in_reply_to === "string" ? value.in_reply_to : null, ...(references?.length ? { references } : {}) };
}
