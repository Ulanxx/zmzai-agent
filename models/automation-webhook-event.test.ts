import { describe, expect, it } from "vitest";

import { AutomationWebhookEventModel } from "@/models/automation-webhook-event";

describe("automation webhook event projection", () => {
  it("allows the claimed event to receive its launched task and session", () => {
    expect(AutomationWebhookEventModel.schema.path("taskId").options.immutable).not.toBe(true);
    expect(AutomationWebhookEventModel.schema.path("sessionId").options.immutable).not.toBe(true);
  });
});
