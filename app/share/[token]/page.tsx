"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Button, EmptyState, Icon } from "@zmzai/theme";

type SharedArtifact = { title: string; path: string; contentType: string; bytes: number; version: number; previewable: boolean; expiresAt: string | null };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 104857.6) / 10} MB`;
}

export default function SharedArtifactPage() {
  const params = useParams<{ token: string }>();
  const token = Array.isArray(params.token) ? params.token[0] : params.token;
  const [artifact, setArtifact] = useState<SharedArtifact | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    void fetch(`/api/shared/artifacts/${encodeURIComponent(token)}/meta`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as { artifact?: SharedArtifact; error?: string } | null;
        if (!response.ok || !body?.artifact) throw new Error(body?.error ?? "分享不存在或已过期");
        setArtifact(body.artifact);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "无法打开分享"));
  }, [token]);

  if (error) return <main className="grid min-h-dvh place-items-center bg-bg px-4"><EmptyState icon={<Icon name="warning" size={28} />} title="此分享不可用" description={error} /></main>;
  if (!artifact || !token) return <main className="grid min-h-dvh place-items-center bg-bg px-4"><p className="text-sm text-ink-3">正在打开成果…</p></main>;
  const contentUrl = `/api/shared/artifacts/${encodeURIComponent(token)}`;
  return (
    <main className="flex min-h-dvh flex-col bg-bg">
      <header className="border-b border-line px-6 py-4">
        <small className="text-[10px] font-semibold uppercase tracking-wide text-ink-3">ZMZAI 成果分享</small>
        <h1 className="mt-1 text-lg font-semibold tracking-tight text-ink">{artifact.title}</h1>
        <p className="mt-0.5 font-mono text-xs text-ink-3">{artifact.path} · v{artifact.version} · {formatBytes(artifact.bytes)}</p>
      </header>
      {artifact.previewable
        ? <iframe src={contentUrl} title={artifact.title} sandbox="allow-scripts allow-same-origin" className="min-h-0 flex-1 bg-surface" />
        : <div className="grid flex-1 place-items-center"><a href={`${contentUrl}?download=1`}><Button><Icon name="download" size={14} />下载成果</Button></a></div>}
    </main>
  );
}
