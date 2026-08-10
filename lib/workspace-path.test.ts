import { describe, expect, it } from "vitest";

import { canonicalWorkspacePath } from "@/lib/workspace-path";

describe("canonicalWorkspacePath", () => {
  it("accepts normalized relative text paths", () => {
    expect(canonicalWorkspacePath("./src/app.ts")).toBe("src/app.ts");
  });

  it("rejects escapes and sensitive roots", () => {
    expect(canonicalWorkspacePath("../secret")).toBeNull();
    expect(canonicalWorkspacePath(".env")).toBeNull();
    expect(canonicalWorkspacePath("/etc/passwd")).toBeNull();
  });
});
