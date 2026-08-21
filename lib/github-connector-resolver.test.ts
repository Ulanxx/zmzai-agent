import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMock, decryptMock } = vi.hoisted(() => ({ findMock: vi.fn(), decryptMock: vi.fn() }));

vi.mock("@/models/workspace-connector", () => ({ WorkspaceConnectorModel: { find: findMock, updateOne: vi.fn() } }));
vi.mock("@/lib/connector-secrets", () => ({ decryptConnectorHeaders: decryptMock }));
vi.mock("@/lib/workspace-connectors", () => ({ assertPublicConnectorTarget: vi.fn().mockResolvedValue(undefined) }));

import { resolveWorkspaceConnectorTools } from "@/lib/mcp-connector-tools";

describe("resolveWorkspaceConnectorTools", () => {
  beforeEach(() => {
    decryptMock.mockReturnValue({ authorization: "Bearer encrypted-token" });
    findMock.mockReturnValue({ select: () => ({ lean: async () => [{ connectorId: "gh_demo", name: "GitHub", transport: "github", url: "https://api.github.com/", encryptedHeaders: "encrypted", status: "ready" }] }) });
  });

  it("turns a ready GitHub connector into the four approved read-only tools", async () => {
    const tools = await resolveWorkspaceConnectorTools({ userId: "user_1", workspaceId: "ws_1", connectorIds: ["gh_demo"] });
    expect(tools).toHaveLength(4);
    expect(tools.map((tool) => tool.label)).toEqual(["GitHub · 搜索仓库", "GitHub · 查看仓库", "GitHub · 列出议题", "GitHub · 读取文件"]);
    expect(decryptMock).toHaveBeenCalledWith("encrypted");
  });
});
