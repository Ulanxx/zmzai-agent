import { describe, expect, it } from "vitest";

import { applySingleEdit, createUnifiedDiff, mergeProposedChange } from "@/lib/proposals";

describe("proposal helpers", () => {
  it("creates an inspectable diff for a new file", () => {
    expect(createUnifiedDiff({ path: "src/app.ts", operation: "create", before: null, after: "export const value = 1;" })).toBe("--- /dev/null\n+++ b/src/app.ts\n@@ -1,0 +1,1 @@\n+export const value = 1;");
  });

  it("only edits a unique target", () => {
    expect(applySingleEdit("const value = 1;", "1", "2")).toEqual({ content: "const value = 2;" });
    expect(applySingleEdit("1 + 1", "1", "2")).toEqual({ error: "EDIT_TARGET_AMBIGUOUS" });
    expect(applySingleEdit("const value = 1;", "missing", "2")).toEqual({ error: "EDIT_TARGET_NOT_FOUND" });
  });

  it("keeps one proposal change per path with the original base content", () => {
    const initial = { path: "src/app.ts", operation: "update" as const, before: "one", after: "two" };
    const merged = mergeProposedChange([initial], { path: "src/app.ts", operation: "update", before: "two", after: "three" });

    expect(merged).toEqual([{ path: "src/app.ts", operation: "update", before: "one", after: "three" }]);
  });
});
