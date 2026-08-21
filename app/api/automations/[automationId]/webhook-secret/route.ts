import { NextResponse } from "next/server";

import { apiError, unauthenticated } from "@/lib/api-error";
import { generateAutomationWebhookSecret } from "@/lib/automation-webhook";
import { getCurrentUser } from "@/lib/auth/session";
import { canEditProject, getProjectAccess } from "@/lib/project-access";
import { AutomationModel } from "@/models/automation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ automationId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthenticated();
  const { automationId } = await context.params;
  const automation = await AutomationModel.findOne({ automationId }).lean();
  if (!automation) return apiError("AUTOMATION_NOT_FOUND", 404, "自动化不存在或无权访问");
  const access = automation.projectId ? await getProjectAccess(automation.projectId, user.id) : automation.userId === user.id ? { role: "owner" as const } : null;
  if (!access || (automation.projectId && !canEditProject(access.role))) return apiError("AUTOMATION_NOT_FOUND", 404, "自动化不存在或无权访问");
  const generated = generateAutomationWebhookSecret();
  await AutomationModel.updateOne({ automationId }, { $set: { webhookSecret: generated.encrypted, webhookSecretPrefix: generated.prefix } });
  return NextResponse.json({ url: new URL(`/api/v1/automations/${encodeURIComponent(automationId)}/webhook`, request.url).toString(), secret: generated.plaintext, prefix: generated.prefix }, { headers: { "cache-control": "no-store" } });
}
