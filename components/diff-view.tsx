"use client";

import { useMemo } from "react";

import { parseUnifiedDiff, type DiffFile, type DiffLine } from "@/lib/unified-diff";

function DiffLineRow({ line, index }: { line: DiffLine; index: number }) {
  if (line.type === "hunk") {
    return <div className="diff-line hunk" key={index}><span className="diff-gutter">@@</span><span className="diff-text">{line.text.replace(/^@@ /, "").replace(/ @@$/, "")}</span></div>;
  }
  if (line.type === "meta") {
    return <div className="diff-line meta" key={index}><span className="diff-gutter" /><span className="diff-text">{line.text}</span></div>;
  }
  const gutter = line.type === "add" ? "+" : line.type === "remove" ? "−" : " ";
  return (
    <div className={`diff-line ${line.type}`} key={index}>
      <span className="diff-gutter">{gutter}</span>
      <span className="diff-text">{line.text || " "}</span>
    </div>
  );
}

function DiffFileBlock({ file }: { file: DiffFile }) {
  return (
    <section className="diff-file">
      <header className="diff-file-head">
        <span className="diff-file-path">{file.newPath ?? file.oldPath ?? "(未知文件)"}</span>
        <span className="diff-file-stats">
          {file.additions > 0 && <em className="diff-add-count">+{file.additions}</em>}
          {file.deletions > 0 && <em className="diff-del-count">−{file.deletions}</em>}
        </span>
      </header>
      {file.hunks.map((hunk, hunkIndex) => (
        <div className="diff-hunk" key={hunkIndex}>
          {hunk.lines.map((line, lineIndex) => <DiffLineRow line={line} index={lineIndex} key={lineIndex} />)}
        </div>
      ))}
    </section>
  );
}

/**
 * Codex-style colored unified diff renderer. Falls back to a plain block when
 * the diff text cannot be parsed into known structure.
 */
export function DiffView({ diff }: { diff: string }) {
  const parsed = useMemo(() => parseUnifiedDiff(diff), [diff]);
  if (!parsed.files.length) {
    return <pre className="diff-preview">{diff}</pre>;
  }
  return (
    <div className="diff-canvas">
      <div className="diff-summary">
        <span>{parsed.files.length} 个文件</span>
        <span className="diff-summary-stats">
          {parsed.additions > 0 && <em className="diff-add-count">+{parsed.additions}</em>}
          {parsed.deletions > 0 && <em className="diff-del-count">−{parsed.deletions}</em>}
        </span>
      </div>
      {parsed.files.map((file, index) => <DiffFileBlock file={file} key={index} />)}
    </div>
  );
}
