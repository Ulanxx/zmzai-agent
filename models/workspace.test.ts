import { describe, expect, it } from "vitest";

import { WorkspaceModel } from "@/models/workspace";

describe("Workspace model", () => {
  it("allows an empty description for a newly created workspace", async () => {
    const workspace = new WorkspaceModel({
      workspaceId: "ws_test",
      userId: "user_test",
      name: "测试 Workspace",
      description: "",
      defaultModel: "gpt-5.6-luna",
      approvalMode: "always",
    });

    await expect(workspace.validate()).resolves.toBeUndefined();
  });
});
