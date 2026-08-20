"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Button, Icon, IconButton } from "@zmzai/theme";

type Artifact = { artifactId: string; title: string; path: string; tags: string[]; version: number; qualityStatus: "not_applicable" | "pending" | "passed" | "failed"; shared: boolean; shareExpiresAt: string | null; bytes: number; contentType: string; createdAt: string; taskId: string | null; taskTitle: string | null; downloadUrl: string | null; previewUrl: string | null };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 104857.6) / 10} MB`;
}

async function loadArtifacts(): Promise<Artifact[]> {
  const response = await fetch("/api/artifacts", { cache: "no-store" });
  const body = await response.json().catch(() => null) as { artifacts?: Artifact[]; error?: string };
  if (!response.ok) throw new Error(body.error ?? "无法加载成果");
  return body.artifacts ?? [];
}

export default function ArtifactsPage() {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [preview, setPreview] = useState<Artifact | null>(null);
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let cancelled = false; void loadArtifacts().then((items) => { if (!cancelled) setArtifacts(items); }).catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "无法加载成果"); }); return () => { cancelled = true; }; }, []);

  const open = (artifact: Artifact) => { setPreview(artifact); setTitle(artifact.title); setTags(artifact.tags.join(", ")); setShareUrl(null); };
  const patchArtifact = async () => {
    if (!preview || !title.trim()) return;
    setBusy("save");
    try {
      const response = await fetch(`/api/artifacts/${encodeURIComponent(preview.artifactId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean) }) });
      const body = await response.json().catch(() => null) as { artifact?: Partial<Artifact>; error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? "保存失败");
      const updated = { ...preview, ...body?.artifact, title: body?.artifact?.title ?? title, tags: body?.artifact?.tags ?? tags.split(",").map((tag) => tag.trim()).filter(Boolean) } as Artifact;
      setPreview(updated); setArtifacts((items) => items.map((artifact) => artifact.artifactId === updated.artifactId ? updated : artifact));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败"); } finally { setBusy(null); }
  };
  const share = async () => {
    if (!preview) return;
    setBusy("share");
    try {
      const response = await fetch(`/api/artifacts/${encodeURIComponent(preview.artifactId)}/share`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expiresInDays: 7 }) });
      const body = await response.json().catch(() => null) as { shareUrl?: string; expiresAt?: string; error?: string } | null;
      if (!response.ok || !body?.shareUrl) throw new Error(body?.error ?? "无法创建分享");
      setShareUrl(body.shareUrl); const updated = { ...preview, shared: true, shareExpiresAt: body.expiresAt ?? null }; setPreview(updated); setArtifacts((items) => items.map((artifact) => artifact.artifactId === updated.artifactId ? updated : artifact));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法创建分享"); } finally { setBusy(null); }
  };
  const revokeShare = async () => {
    if (!preview) return;
    setBusy("revoke");
    try {
      const response = await fetch(`/api/artifacts/${encodeURIComponent(preview.artifactId)}/share`, { method: "DELETE" });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? "无法撤销分享");
      const updated = { ...preview, shared: false, shareExpiresAt: null }; setPreview(updated); setShareUrl(null); setArtifacts((items) => items.map((artifact) => artifact.artifactId === updated.artifactId ? updated : artifact));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法撤销分享"); } finally { setBusy(null); }
  };

  return <main className="product-page"><header className="product-page-head"><div><Link href="/fw" className="product-back"><Icon name="arrow-left" size={14} />返回工作台</Link><span className="eyebrow">可复用交付物</span><h1>成果</h1><p>从任务中生成的文件、网页和报告都会保留在这里。</p></div><Link href="/fw" className="product-action-link">新对话 <Icon name="arrow-up-right" size={14} /></Link></header>{error && <div className="product-error">{error}</div>}{preview ? <section className="artifact-reader"><div className="artifact-reader-head"><div><span className="eyebrow">预览</span><h2>{preview.title} <small>v{preview.version}</small></h2></div><IconButton size="sm" label="关闭预览" onClick={() => setPreview(null)}><Icon name="cross" size={13} /></IconButton></div><div className="artifact-meta-form"><input value={title} onChange={(event) => setTitle(event.target.value)} aria-label="成果标题" /><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="标签，使用逗号分隔" aria-label="成果标签" /><Button type="button" variant="secondary" size="sm" disabled={busy === "save" || !title.trim()} onClick={() => void patchArtifact()}><Icon name="check" size={13} />保存</Button><Button type="button" variant="secondary" size="sm" disabled={busy === "share"} onClick={() => void share()}><Icon name="link" size={13} />分享</Button>{preview.shared && <IconButton size="sm" label="撤销分享" disabled={busy === "revoke"} onClick={() => void revokeShare()}><Icon name="cross" size={13} /></IconButton>}</div>{shareUrl && <input className="artifact-share-url" value={shareUrl} readOnly aria-label="分享链接" />}{preview.qualityStatus !== "not_applicable" && <div className={`artifact-quality ${preview.qualityStatus}`}>质量检查：{preview.qualityStatus === "passed" ? "通过" : preview.qualityStatus === "failed" ? "需要修复" : "等待检查"}</div>}{preview.previewUrl ? <iframe src={preview.previewUrl} title={preview.title} sandbox="allow-scripts allow-same-origin" /> : <div className="product-empty">该文件暂不支持在线预览，请使用下载。</div>}</section> : <section className="artifact-list">{artifacts.length ? artifacts.map((artifact) => <article className="artifact-row" key={artifact.artifactId}><div className="artifact-row-icon"><Icon name={artifact.contentType === "application/zip" ? "archive" : "file"} size={15} /></div><button type="button" className="artifact-row-copy" onClick={() => open(artifact)}><h2>{artifact.title} <small>v{artifact.version}</small></h2><p>{artifact.taskTitle || "独立成果"} · {formatBytes(artifact.bytes)} · {new Date(artifact.createdAt).toLocaleDateString("zh-CN")}{artifact.tags.length ? ` · ${artifact.tags.join(" · ")}` : ""}</p>{artifact.qualityStatus !== "not_applicable" && <span className={`artifact-quality ${artifact.qualityStatus}`}>{artifact.qualityStatus === "passed" ? "质量通过" : artifact.qualityStatus === "failed" ? "质量待修复" : "等待质量检查"}</span>}</button><div className="artifact-row-actions">{artifact.previewUrl && <IconButton size="sm" label="预览" onClick={() => open(artifact)}><Icon name="eye" size={14} /></IconButton>}{artifact.downloadUrl && <a className="artifact-download" href={artifact.downloadUrl} title="下载"><Icon name="download" size={14} /></a>}{artifact.taskId && <Link href={`/fw/t/${artifact.taskId}`} title="回到任务"><Icon name="arrow-up-right" size={14} /></Link>}</div></article>) : <div className="product-empty"><Icon name="archive" size={22} /><strong>还没有成果</strong><p>完成一个任务后，交付文件会出现在这里。</p></div>}</section>}</main>;
}
