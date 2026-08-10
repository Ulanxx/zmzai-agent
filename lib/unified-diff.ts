export type DiffLine =
  | { type: "hunk"; oldStart: number; newStart: number; text: string }
  | { type: "context"; text: string }
  | { type: "add"; text: string }
  | { type: "remove"; text: string }
  | { type: "meta"; text: string };

export type DiffFile = {
  oldPath: string | null;
  newPath: string | null;
  additions: number;
  deletions: number;
  hunks: Array<{ oldStart: number; newStart: number; lines: DiffLine[] }>;
};

export type UnifiedDiff = {
  files: DiffFile[];
  additions: number;
  deletions: number;
};

function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!match) return null;
  return { oldStart: Number.parseInt(match[1], 10), newStart: Number.parseInt(match[2], 10) };
}

/**
 * Parses a unified diff (as produced by the server's `createUnifiedDiff`)
 * into structured files/hunks/lines so the workbench can render Codex-style
 * colored changes instead of a raw <pre>. Unknown lines degrade to context.
 */
export function parseUnifiedDiff(input: string): UnifiedDiff {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let currentHunk: { oldStart: number; newStart: number; lines: DiffLine[] } | null = null;
  let additions = 0;
  let deletions = 0;

  for (const raw of input.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("diff --git ") || (line.startsWith("--- ") && current !== null && current.oldPath !== null)) {
      // A new file section: either an explicit diff --git marker or a second
      // --- header following a complete file block.
      if (current && currentHunk) {
        current.hunks.push(currentHunk);
        currentHunk = null;
      }
      current = { oldPath: null, newPath: null, additions: 0, deletions: 0, hunks: [] };
      files.push(current);
      if (line.startsWith("diff --git ")) continue;
    }
    if (line.startsWith("--- ")) {
      if (!current) {
        current = { oldPath: null, newPath: null, additions: 0, deletions: 0, hunks: [] };
        files.push(current);
      }
      current.oldPath = line.slice(4).replace(/^(a|b)\//, "");
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (!current) {
        current = { oldPath: null, newPath: null, additions: 0, deletions: 0, hunks: [] };
        files.push(current);
      }
      current.newPath = line.slice(4).replace(/^(a|b)\//, "");
      continue;
    }
    if (line.startsWith("@@")) {
      const header = parseHunkHeader(line);
      if (current && header) {
        if (currentHunk) current.hunks.push(currentHunk);
        currentHunk = { oldStart: header.oldStart, newStart: header.newStart, lines: [] };
        currentHunk.lines.push({ type: "hunk", oldStart: header.oldStart, newStart: header.newStart, text: line });
      }
      continue;
    }
    if (!current || !currentHunk) continue;
    if (line.startsWith("+")) {
      currentHunk.lines.push({ type: "add", text: line.slice(1) });
      current.additions += 1;
      additions += 1;
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({ type: "remove", text: line.slice(1) });
      current.deletions += 1;
      deletions += 1;
    } else if (line.startsWith("\\")) {
      currentHunk.lines.push({ type: "meta", text: line });
    } else {
      currentHunk.lines.push({ type: "context", text: line.startsWith(" ") ? line.slice(1) : line });
    }
  }

  if (current && currentHunk) current.hunks.push(currentHunk);
  return { files, additions, deletions };
}
