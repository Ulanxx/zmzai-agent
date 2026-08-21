"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Badge, Button, Card, EmptyState, Icon, IconButton, Input, Navbar, Select as ThemeSelect, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@zmzai/theme";

type Artifact = { artifactId: string; title: string; path: string; tags: string[]; version: number; qualityStatus: "not_applicable" | "pending" | "passed" | "failed"; shared: boolean; shareExpiresAt: string | null; bytes: number; contentType: string; createdAt: string; taskId: string | null; taskTitle: string | null; projectIds?: string[]; downloadUrl: string | null; previewUrl: string | null };
type ProjectOption = { projectId: string; name: string };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 104857.6) / 10} MB`;
}

function qualityVariant(status: Artifact["qualityStatus"]) {
  if (status === "passed") return "success" as const;
  if (status === "failed") return "danger" as const;
  return "warning" as const;
}
function qualityLabel(status: Artifact["qualityStatus"]) { return status === "passed" ? "质量通过" : status === "failed" ? "质量待修复" : "等待质量检查"; }

async function loadArtifacts(filters: { projectId?: string; contentType?: string; tag?: string; from?: string } = {}): Promise<Artifact[]> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
  const response = await fetch(`/api/artifacts${query.toString() ? `?${query.toString()}` : ""}`, { cache: "no-store" });
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
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [projectId, setProjectId] = useState("__none__");
  const [filterProjectId, setFilterProjectId] = useState("__all__");
  const [filterType, setFilterType] = useState("__all__");
  const [filterTag, setFilterTag] = useState("");
  const [filterRange, setFilterRange] = useState("__all__");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let cancelled = false; void fetch("/api/projects", { cache: "no-store" }).then(async (response) => { if (!response.ok) throw new Error("无法加载项目"); return response.json() as Promise<{ projects: { project: ProjectOption }[] }>; }).then((result) => { if (!cancelled) setProjects(result.projects.map(({ project }) => project)); }).catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "无法加载项目"); }); return () => { cancelled = true; }; }, []);
  useEffect(() => { let cancelled = false; const from = filterRange !== "__all__" ? new Date(Date.now() - Number(filterRange) * 86_400_000).toISOString() : undefined; void loadArtifacts({ projectId: filterProjectId === "__all__" ? undefined : filterProjectId, contentType: filterType === "__all__" ? undefined : filterType, tag: filterTag.trim(), from }).then((items) => { if (!cancelled) setArtifacts(items); }).catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "无法加载成果"); }); return () => { cancelled = true; }; }, [filterProjectId, filterRange, filterTag, filterType]);

  const open = (artifact: Artifact) => { setPreview(artifact); setTitle(artifact.title); setTags(artifact.tags.join(", ")); setShareUrl(null); setProjectId(artifact.projectIds?.[0] ?? "__none__"); };
  const addToProject = async () => {
    if (!preview || projectId === "__none__") return;
    setBusy("project");
    try {
      const response = await fetch(`/api/artifacts/${encodeURIComponent(preview.artifactId)}/project`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId }) });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? "无法加入项目");
      const updated = { ...preview, projectIds: [...new Set([...(preview.projectIds ?? []), projectId])] }; setPreview(updated); setArtifacts((items) => items.map((artifact) => artifact.artifactId === updated.artifactId ? updated : artifact));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法加入项目"); } finally { setBusy(null); }
  };
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

  const removeArtifact = async () => {
    if (!preview || !window.confirm("删除这个成果及其项目引用？")) return;
    setBusy("delete");
    try {
      const response = await fetch(`/api/artifacts/${encodeURIComponent(preview.artifactId)}`, { method: "DELETE" });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? "删除失败");
      setArtifacts((items) => items.filter((artifact) => artifact.artifactId !== preview.artifactId)); setPreview(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "删除失败"); } finally { setBusy(null); }
  };

  const latestByPath = new Map<string, number>();
  for (const artifact of artifacts) latestByPath.set(artifact.path, Math.max(latestByPath.get(artifact.path) ?? 0, artifact.version));
  const isLatest = (artifact: Artifact) => artifact.version >= (latestByPath.get(artifact.path) ?? 0);

  return <main className="min-h-dvh bg-bg">
    <Navbar sublabel="agent" badge={<span className="rounded-full border border-line px-2 py-0.5 font-mono text-[11px] text-ink-3">a.zmzai.cloud</span>}>
      <Link href="/fw" className="text-xs text-ink-3 transition-colors hover:text-ink"><Icon name="arrow-left" size={12} className="mr-1 inline" />返回工作台</Link>
    </Navbar>
    <div className="mx-auto w-[min(100%-2rem,74rem)] py-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <small className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-3">可复用交付物</small>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">成果</h1>
          <p className="mt-1 text-sm text-ink-3">从任务中生成的文件、网页和报告都会保留在这里。</p>
        </div>
        <Link href="/fw"><Button variant="secondary" size="sm">新对话 <Icon name="arrow-up-right" size={14} /></Button></Link>
      </header>
      {error && <div className="mb-4 rounded-sm border-l-2 border-danger bg-danger/10 px-3 py-2 text-sm text-ink" role="status">{error}</div>}

      {preview ? (
        <Card padding="md">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <small className="block text-xs font-semibold uppercase tracking-wide text-ink-3">预览</small>
              <h2 className="truncate text-lg font-semibold tracking-tight text-ink">{preview.title} <small className="font-mono text-xs text-ink-3">v{preview.version}</small></h2>
            </div>
            <IconButton size="md" label="关闭预览" onClick={() => setPreview(null)}><Icon name="cross" size={13} /></IconButton>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-y border-line py-3">
            <Input value={title} onChange={(event) => setTitle(event.target.value)} aria-label="成果标题" className="min-w-0 flex-1" />
            <Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="标签，逗号分隔" aria-label="成果标签" className="min-w-0 flex-1" />
            <ThemeSelect value={projectId} onValueChange={(value: string) => setProjectId(value)}>
              <SelectTrigger className="w-auto" aria-label="加入项目"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">选择项目</SelectItem>
                {projects.map((project) => <SelectItem key={project.projectId} value={project.projectId}>{project.name}</SelectItem>)}
              </SelectContent>
            </ThemeSelect>
            <Button type="button" variant="secondary" size="sm" disabled={busy === "save" || !title.trim()} onClick={() => void patchArtifact()}><Icon name="check" size={13} />保存</Button>
            <Button type="button" variant="secondary" size="sm" disabled={busy === "share"} onClick={() => void share()}><Icon name="link" size={13} />分享</Button>
            <Button type="button" variant="secondary" size="sm" disabled={busy === "project" || projectId === "__none__"} onClick={() => void addToProject()}><Icon name="folder" size={13} />加入项目</Button>
            {preview.shared && <IconButton size="sm" label="撤销分享" disabled={busy === "revoke"} onClick={() => void revokeShare()}><Icon name="cross" size={13} /></IconButton>}
            <Button type="button" variant="danger" size="sm" disabled={busy === "delete"} onClick={() => void removeArtifact()}><Icon name="trash" size={13} />删除</Button>
          </div>
          {shareUrl && <Input value={shareUrl} readOnly aria-label="分享链接" className="mt-3 font-mono text-xs" />}
          {preview.qualityStatus !== "not_applicable" && <div className="mt-3"><Badge variant={qualityVariant(preview.qualityStatus)} size="sm">质量检查：{qualityLabel(preview.qualityStatus)}</Badge></div>}
          <div className="mt-3 overflow-hidden rounded-sm border border-line">
            {preview.previewUrl ? <iframe src={preview.previewUrl} title={preview.title} sandbox="allow-scripts allow-same-origin" className="h-[70vh] w-full bg-surface" /> : <EmptyState title="该文件暂不支持在线预览" description="请使用下载。" />}
          </div>
        </Card>
      ) : <>
        <Card padding="sm" className="mb-4">
          <div className="flex flex-wrap items-center gap-2">
            <ThemeSelect value={filterProjectId} onValueChange={(value: string) => setFilterProjectId(value)}>
              <SelectTrigger className="w-auto" aria-label="按项目筛选"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">所有项目</SelectItem>
                {projects.map((project) => <SelectItem key={project.projectId} value={project.projectId}>{project.name}</SelectItem>)}
              </SelectContent>
            </ThemeSelect>
            <ThemeSelect value={filterType} onValueChange={(value: string) => setFilterType(value)}>
              <SelectTrigger className="w-auto" aria-label="按类型筛选"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">所有类型</SelectItem>
                <SelectItem value="text/html">网页</SelectItem>
                <SelectItem value="application/pdf">PDF</SelectItem>
                <SelectItem value="image/">图片</SelectItem>
                <SelectItem value="application/zip">压缩包</SelectItem>
              </SelectContent>
            </ThemeSelect>
            <ThemeSelect value={filterRange} onValueChange={(value: string) => setFilterRange(value)}>
              <SelectTrigger className="w-auto" aria-label="按时间筛选"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">全部时间</SelectItem>
                <SelectItem value="7">最近 7 天</SelectItem>
                <SelectItem value="30">最近 30 天</SelectItem>
                <SelectItem value="90">最近 90 天</SelectItem>
              </SelectContent>
            </ThemeSelect>
            <Input value={filterTag} onChange={(event) => setFilterTag(event.target.value)} placeholder="标签筛选" aria-label="按标签筛选" className="w-40" />
          </div>
        </Card>
        <section className="flex flex-col gap-3">
          {artifacts.length ? artifacts.map((artifact) => (
            <Card key={artifact.artifactId} padding="md" variant="interactive">
              <div className="flex flex-wrap items-center gap-3">
                <span className="grid size-8 place-items-center rounded-sm border border-line bg-surface text-ink-2"><Icon name={artifact.contentType === "application/zip" ? "archive" : "file"} size={15} /></span>
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => open(artifact)}>
                  <h2 className="truncate text-base font-semibold text-ink">{artifact.title} <small className="font-mono text-xs text-ink-3">v{artifact.version}</small></h2>
                  <p className="truncate text-sm text-ink-3">{artifact.taskTitle || "独立成果"} · {formatBytes(artifact.bytes)} · {new Date(artifact.createdAt).toLocaleDateString("zh-CN")}{artifact.tags.length ? ` · ${artifact.tags.join(" · ")}` : ""}</p>
                </button>
                {artifact.qualityStatus !== "not_applicable" && <Badge variant={qualityVariant(artifact.qualityStatus)} size="sm">{qualityLabel(artifact.qualityStatus)}</Badge>}
                {!isLatest(artifact) && <Badge variant="outline" size="sm">旧版</Badge>}
                <div className="flex flex-shrink-0 items-center gap-1">
                  {artifact.previewUrl && <IconButton size="sm" label="预览" onClick={() => open(artifact)}><Icon name="eye" size={14} /></IconButton>}
                  {artifact.downloadUrl && <a className="grid size-7 place-items-center rounded-sm border border-line text-ink-3 hover:text-ink" href={artifact.downloadUrl} title="下载"><Icon name="download" size={14} /></a>}
                  {artifact.taskId && <Link className="grid size-7 place-items-center rounded-sm border border-line text-ink-3 hover:text-ink" href={`/fw/t/${artifact.taskId}`} title="回到任务"><Icon name="arrow-up-right" size={14} /></Link>}
                </div>
              </div>
            </Card>
          )) : <EmptyState icon={<Icon name="archive" size={24} />} title="还没有成果" description="完成一个任务后，交付文件会出现在这里。" />}
        </section>
      </>}
    </div>
  </main>;
}
