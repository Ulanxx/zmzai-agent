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

  it("defaults approvalMode to ask and accepts the auto tier", async () => {
    const defaulted = new WorkspaceModel({ workspaceId: "ws_a", userId: "u", name: "a", defaultModel: "m" });
    await expect(defaulted.validate()).resolves.toBeUndefined();
    expect(defaulted.approvalMode).toBe("ask");

    const auto = new WorkspaceModel({ workspaceId: "ws_b", userId: "u", name: "b", defaultModel: "m", approvalMode: "auto" });
    await expect(auto.validate()).resolves.toBeUndefined();

    const invalid = new WorkspaceModel({ workspaceId: "ws_c", userId: "u", name: "c", defaultModel: "m", approvalMode: "yolo" });
    await expect(invalid.validate()).rejects.toThrow();
  });
});
