import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiError, unauthenticated } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth/session";
import { WebhookSubscriptionModel } from "@/models/webhook-subscription";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const updateSchema = z.object({ status: z.enum(["active", "paused"]) }).strict();

function summary(record: { subscriptionId: string; workspaceId: string; name: string; url: string; events: string[]; status: string; secretPrefix: string; lastDeliveredAt?: Date | null; lastError?: string | null; createdAt: Date }) {
  return { id: record.subscriptionId, workspaceId: record.workspaceId, name: record.name, url: record.url, events: record.events, status: record.status, secretPrefix: record.secretPrefix, lastDeliveredAt: record.lastDeliveredAt?.toISOString() ?? null, lastError: record.lastError ?? null, createdAt: record.createdAt.toISOString() };
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ subscriptionId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { subscriptionId } = await context.params;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError("INVALID_BODY", 400, "Webhook 更新请求格式不正确");
  const subscription = await WebhookSubscriptionModel.findOneAndUpdate({ subscriptionId, userId: user.id }, { $set: parsed.data }, { new: true }).lean();
  if (!subscription) return apiError("WEBHOOK_NOT_FOUND", 404, "Webhook 不存在或无权访问");
  return NextResponse.json({ subscription: summary(subscription) }, { headers: { "cache-control": "no-store" } });
}

export async function DELETE(_: Request, context: { params: Promise<{ subscriptionId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { subscriptionId } = await context.params;
  const deleted = await WebhookSubscriptionModel.deleteOne({ subscriptionId, userId: user.id });
  if (!deleted.deletedCount) return apiError("WEBHOOK_NOT_FOUND", 404, "Webhook 不存在或无权访问");
  return NextResponse.json({ deleted: true }, { headers: { "cache-control": "no-store" } });
}
