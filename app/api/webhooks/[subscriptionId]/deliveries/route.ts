import { NextResponse } from "next/server";

import { apiError, unauthenticated } from "@/lib/api-error";
import { getCurrentUser } from "@/lib/auth/session";
import { WebhookDeliveryModel } from "@/models/webhook-delivery";
import { WebhookSubscriptionModel } from "@/models/webhook-subscription";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_: Request, context: { params: Promise<{ subscriptionId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { subscriptionId } = await context.params;
  if (!(await WebhookSubscriptionModel.exists({ subscriptionId, userId: user.id }))) return apiError("WEBHOOK_NOT_FOUND", 404, "Webhook 不存在或无权访问");
  const deliveries = await WebhookDeliveryModel.find({ subscriptionId }).sort({ createdAt: -1 }).limit(50).select({ deliveryId: 1, eventType: 1, taskId: 1, runId: 1, status: 1, attempts: 1, nextAttemptAt: 1, responseStatus: 1, lastError: 1, deliveredAt: 1, createdAt: 1 }).lean();
  return NextResponse.json({ deliveries }, { headers: { "cache-control": "no-store" } });
}
