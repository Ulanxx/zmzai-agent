import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiError, unauthenticated } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth/session";
import { generateOutboundWebhookSecret, outboundWebhookEvents } from "@/lib/outbound-webhooks";
import { assertPublicConnectorTarget, normalizeConnectorUrl } from "@/lib/workspace-connectors";
import { getWorkspace } from "@/lib/workspaces";
import { WebhookSubscriptionModel } from "@/models/webhook-subscription";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({ workspaceId: z.string().trim().min(1).max(64), name: z.string().trim().min(1).max(100), url: z.string().trim().url().max(2_000), events: z.array(z.enum(outboundWebhookEvents)).min(1).max(outboundWebhookEvents.length) }).strict()
  .refine((value) => new Set(value.events).size === value.events.length, { message: "事件不能重复", path: ["events"] });
function summary(record: { subscriptionId: string; workspaceId: string; name: string; url: string; events: string[]; status: string; secretPrefix: string; lastDeliveredAt?: Date | null; lastError?: string | null; createdAt: Date }) {
  return { id: record.subscriptionId, workspaceId: record.workspaceId, name: record.name, url: record.url, events: record.events, status: record.status, secretPrefix: record.secretPrefix, lastDeliveredAt: record.lastDeliveredAt?.toISOString() ?? null, lastError: record.lastError ?? null, createdAt: record.createdAt.toISOString() };
}

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const workspaceId = request.nextUrl.searchParams.get("workspaceId")?.trim();
  const subscriptions = await WebhookSubscriptionModel.find({ userId: user.id, ...(workspaceId ? { workspaceId } : {}) }).sort({ createdAt: -1 }).limit(100).lean();
  return NextResponse.json({ subscriptions: subscriptions.map(summary) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "Webhook 请求格式不正确");
  if (!(await getWorkspace(user.id, parsed.data.workspaceId))) return apiError("WORKSPACE_NOT_FOUND", 404, "Workspace 不存在或无权访问");
  const url = normalizeConnectorUrl(parsed.data.url);
  if (!url) return apiError("INVALID_WEBHOOK_URL", 400, "Webhook 必须使用公开 HTTPS 地址");
  try { await assertPublicConnectorTarget(url); } catch (error) { return apiError("INVALID_WEBHOOK_URL", 422, error instanceof Error ? error.message : "Webhook 地址不可用"); }
  const secret = generateOutboundWebhookSecret();
  const subscription = await WebhookSubscriptionModel.create({ subscriptionId: `whs_${randomUUID().replaceAll("-", "").slice(0, 20)}`, userId: user.id, workspaceId: parsed.data.workspaceId, name: parsed.data.name, url, events: parsed.data.events, encryptedSecret: secret.encrypted, secretPrefix: secret.prefix, status: "active" });
  return NextResponse.json({ subscription: summary(subscription), secret: secret.plaintext }, { status: 201, headers: { "cache-control": "no-store" } });
}
