"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

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

  if (error) return <main className="shared-artifact-page"><section><span className="eyebrow">ZMZAI 成果分享</span><h1>此分享不可用</h1><p>{error}</p></section></main>;
  if (!artifact || !token) return <main className="shared-artifact-page"><section>正在打开成果…</section></main>;
  const contentUrl = `/api/shared/artifacts/${encodeURIComponent(token)}`;
  return <main className="shared-artifact-page"><header><span className="eyebrow">ZMZAI 成果分享</span><h1>{artifact.title}</h1><p>{artifact.path} · v{artifact.version} · {formatBytes(artifact.bytes)}</p></header>{artifact.previewable ? <iframe src={contentUrl} title={artifact.title} sandbox="allow-scripts allow-same-origin" /> : <a className="shared-artifact-download" href={`${contentUrl}?download=1`}>下载成果</a>}</main>;
}
