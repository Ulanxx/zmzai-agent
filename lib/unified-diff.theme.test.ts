import { describe, expect, it } from "vitest";

import { parseUnifiedDiff } from "@zmzai/theme/parse-unified-diff";

describe("parseUnifiedDiff", () => {
  it("parses a created file", () => {
    const diff = parseUnifiedDiff("--- /dev/null\n+++ b/src/app.ts\n@@ -1,0 +1,1 @@\n+export const value = 1;");
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]).toMatchObject({ oldPath: "/dev/null", newPath: "src/app.ts", additions: 1, deletions: 0 });
    expect(diff.files[0].hunks[0].lines.map((line) => [line.type, line.text])).toEqual([["hunk", "@@ -1,0 +1,1 @@"], ["add", "export const value = 1;"]]);
    expect(diff.additions).toBe(1);
  });

  it("parses an update with mixed add/remove/context", () => {
    const diff = parseUnifiedDiff([
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,3 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      " const c = 4;",
    ].join("\n"));
    expect(diff.files[0]).toMatchObject({ oldPath: "src/a.ts", newPath: "src/a.ts", additions: 1, deletions: 1 });
    expect(diff.files[0].hunks[0].lines.map((line) => line.type)).toEqual(["hunk", "context", "remove", "add", "context"]);
  });

  it("parses multiple files and aggregates stats", () => {
    const diff = parseUnifiedDiff([
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1 +1,2 @@",
      " keep",
      "+extra",
    ].join("\n"));
    expect(diff.files).toHaveLength(2);
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(1);
  });

  it("keeps hunk line numbers", () => {
    const diff = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -10,4 +12,5 @@\n context");
    expect(diff.files[0].hunks[0]).toMatchObject({ oldStart: 10, newStart: 12 });
  });

  it("treats a missing trailing newline marker as meta", () => {
    const diff = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file");
    const types = diff.files[0].hunks[0].lines.map((line) => line.type);
    expect(types).toEqual(["hunk", "remove", "meta", "add", "meta"]);
  });

  it("returns empty files for garbage input", () => {
    expect(parseUnifiedDiff("not a diff at all").files).toEqual([]);
  });
});
