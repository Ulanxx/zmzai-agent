import { describe, expect, it } from "vitest";

import { applySingleEdit, createUnifiedDiff } from "@/lib/workspace-edit";

describe("workspace-edit helpers", () => {
  it("creates an inspectable diff for a new file", () => {
    expect(createUnifiedDiff({ path: "src/app.ts", operation: "create", before: null, after: "export const value = 1;" })).toBe(
      "--- /dev/null\n+++ b/src/app.ts\n@@ -1,0 +1,1 @@\n+export const value = 1;",
    );
  });

  it("creates a diff for an update", () => {
    const diff = createUnifiedDiff({ path: "a.ts", operation: "update", before: "old", after: "new" });
    expect(diff).toContain("--- a/a.ts");
    expect(diff).toContain("+++ b/a.ts");
    expect(diff).toContain("-old");
    expect(diff).toContain("+new");
  });

  it("only edits a unique target", () => {
    expect(applySingleEdit("const value = 1;", "1", "2")).toEqual({ content: "const value = 2;" });
    expect(applySingleEdit("1 + 1", "1", "2")).toEqual({ error: "EDIT_TARGET_AMBIGUOUS" });
    expect(applySingleEdit("const value = 1;", "missing", "2")).toEqual({ error: "EDIT_TARGET_NOT_FOUND" });
    expect(applySingleEdit("anything", "", "x")).toEqual({ error: "EDIT_TARGET_REQUIRED" });
  });
});
