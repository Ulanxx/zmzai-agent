"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Icon, IconButton } from "@zmzai/theme";

type Artifact = { artifactId: string; path: string; bytes: number; contentType: string; createdAt: string; taskId: string | null; taskTitle: string | null; downloadUrl: string | null; previewUrl: string | null };

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
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let cancelled = false; void loadArtifacts().then((items) => { if (!cancelled) setArtifacts(items); }).catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "无法加载成果"); }); return () => { cancelled = true; }; }, []);

  return <main className="product-page"><header className="product-page-head"><div><Link href="/fw" className="product-back"><Icon name="arrow-left" size={14} />返回工作台</Link><span className="eyebrow">可复用交付物</span><h1>成果</h1><p>从任务中生成的文件、网页和报告都会保留在这里。</p></div><Link href="/fw" className="product-action-link">新对话 <Icon name="arrow-up-right" size={14} /></Link></header>{error && <div className="product-error">{error}</div>}{preview ? <section className="artifact-reader"><div className="artifact-reader-head"><div><span className="eyebrow">预览</span><h2>{preview.path}</h2></div><IconButton size="sm" label="关闭预览" onClick={() => setPreview(null)}><Icon name="cross" size={13} /></IconButton></div>{preview.previewUrl ? <iframe src={preview.previewUrl} title={preview.path} sandbox="allow-scripts allow-same-origin" /> : <div className="product-empty">该文件暂不支持在线预览，请使用下载。</div>}</section> : <section className="artifact-list">{artifacts.length ? artifacts.map((artifact) => <article className="artifact-row" key={artifact.artifactId}><div className="artifact-row-icon"><Icon name={artifact.contentType === "application/zip" ? "archive" : "file"} size={15} /></div><div className="artifact-row-copy"><h2>{artifact.path}</h2><p>{artifact.taskTitle || "独立成果"} · {formatBytes(artifact.bytes)} · {new Date(artifact.createdAt).toLocaleDateString("zh-CN")}</p></div><div className="artifact-row-actions">{artifact.previewUrl && <IconButton size="sm" label="预览" onClick={() => setPreview(artifact)}><Icon name="eye" size={14} /></IconButton>}{artifact.downloadUrl && <a className="artifact-download" href={artifact.downloadUrl} title="下载"><Icon name="download" size={14} /></a>}{artifact.taskId && <Link href={`/fw/t/${artifact.taskId}`} title="回到任务"><Icon name="arrow-up-right" size={14} /></Link>}</div></article>) : <div className="product-empty"><Icon name="archive" size={22} /><strong>还没有成果</strong><p>完成一个任务后，交付文件会出现在这里。</p></div>}</section>}</main>;
}
