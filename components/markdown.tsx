"use client";

import { Children, memo, useMemo, useState, type ReactElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js/lib/core";

import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdownLang from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";

// Curated language set keeps the client bundle small; every other language
// falls back to plain text. The brand theme lives in globals.css.
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("jsx", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdownLang);
hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("text", plaintext);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("tsx", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Streaming deltas re-render frequently; memoize highlight output per exact
// (language, code) pair so only changed blocks pay for highlighting.
const highlightCache = new Map<string, string>();

function highlightCode(code: string, language: string | undefined): string {
  const key = `${language ?? ""}\u0000${code}`;
  const cached = highlightCache.get(key);
  if (cached !== undefined) return cached;
  let html: string;
  if (language && hljs.getLanguage(language)) {
    try {
      html = hljs.highlight(code, { language }).value;
    } catch {
      html = escapeHtml(code);
    }
  } else {
    html = escapeHtml(code);
  }
  if (highlightCache.size > 600) highlightCache.clear();
  highlightCache.set(key, html);
  return html;
}

function CodeBlock({ language, code }: { language: string | undefined; code: string }) {
  const [copied, setCopied] = useState(false);
  const html = useMemo(() => highlightCode(code, language), [code, language]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (e.g. non-secure context); the block stays readable.
    }
  };
  return (
    <div className="md-codeblock">
      <div className="md-codeblock-head">
        <span>{language ?? "text"}</span>
        <button type="button" className="md-copy" onClick={() => void copy()}>{copied ? "已复制" : "复制"}</button>
      </div>
      <pre><code className={language ? `language-${language}` : undefined} dangerouslySetInnerHTML={{ __html: html }} /></pre>
    </div>
  );
}

/**
 * Streaming GFM renderer for Agent replies. `message.delta` chunks are fed as
 * partial markdown; block rendering stays stable while the text grows.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // react-markdown feeds every fenced block through <pre><code>. We
          // intercept the pre to render a highlighted block with a copy button;
          // bare <code> is inline.
          pre({ children }) {
            const child = Children.only(children) as ReactElement<{ className?: string; children?: ReactNode }>;
            const className = typeof child?.props?.className === "string" ? child.props.className : undefined;
            const match = /language-(\w+)/.exec(className ?? "");
            const code = String(child?.props?.children ?? "").replace(/\n$/, "");
            return <CodeBlock language={match?.[1]} code={code} />;
          },
          code({ className, children, ...props }) {
            return <code className={className} {...props}>{children}</code>;
          },
          a({ children, ...props }) {
            return <a {...props} target="_blank" rel="noreferrer">{children}</a>;
          },
        }}
      >{text}</ReactMarkdown>
    </div>
  );
});
