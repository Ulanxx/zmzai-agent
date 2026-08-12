"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { FrameworkEventType } from "@/framework/core/events/manifest";
import type { MessageWithParts, Part, SessionInfo, SessionStatus } from "@/framework/core/session/types";
import type { PermissionRequest, Reply } from "@/framework/core/permission/engine";

/** Client-side mirror of the framework wire types (spec §2/§4). The web
 *  workbench renders purely from these — no hand-rolled projection. */

export type { MessageWithParts, Part, SessionInfo, SessionStatus, PermissionRequest, Reply };

export type AgentSummary = { id?: string; name: string; description: string; mode?: "primary" | "subagent" | "all"; icon?: string; publishedVersionId?: string | null };

export type TodoItem = { content: string; status: "pending" | "in_progress" | "completed" | "cancelled"; priority?: "high" | "medium" | "low" };

export type ArtifactCard = { artifactId: string; path: string; bytes: number; contentType: string; downloadUrl: string; previewUrl?: string };

export type FileEdit = { path: string; revisionId: string; diff: string; at: string };

export type SessionSnapshot = {
  session: SessionInfo;
  messages: MessageWithParts[];
};

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const body = (await response.json().catch(() => null)) as ({ error?: string } | T) | null;
  if (!response.ok) {
    throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "请求失败，请稍后重试");
  }
  return body as T;
}

export const fwApi = {
  listSessions: (workspaceId?: string) => requestJson<{ sessions: SessionInfo[] }>(`/api/fw/sessions${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`),
  createSession: (input: { workspaceId: string; agentId?: string; model: { providerId: string; modelId: string }; prompt?: string }) =>
    requestJson<{ session: SessionInfo }>("/api/fw/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  getSession: (sessionId: string) => requestJson<SessionSnapshot>(`/api/fw/sessions/${encodeURIComponent(sessionId)}`),
  prompt: (sessionId: string, input: { text: string }) =>
    requestJson<{ accepted: boolean; queued: boolean }>(`/api/fw/sessions/${encodeURIComponent(sessionId)}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  abort: (sessionId: string) => requestJson<{ aborted: boolean }>(`/api/fw/sessions/${encodeURIComponent(sessionId)}/abort`, { method: "POST" }),
  replyPermission: (sessionId: string, requestId: string, reply: Reply, feedback?: string) =>
    requestJson<{ resolved: boolean }>(`/api/fw/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reply, ...(feedback ? { feedback } : {}) }),
    }),
  listAgents: () => requestJson<{ agents: AgentSummary[] }>("/api/fw/agents"),
  listWorkspaceAgents: (workspaceId: string) => requestJson<{ agents: AgentSummary[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/agents`),
};

export type LiveState = {
  status: SessionStatus;
  todos: TodoItem[];
  artifacts: ArtifactCard[];
  edits: FileEdit[];
  pendingPermission: PermissionRequest | null;
  error: string | null;
  streamState: "idle" | "live" | "reconnecting";
};

const initialLive: LiveState = {
  status: "idle",
  todos: [],
  artifacts: [],
  edits: [],
  pendingPermission: null,
  error: null,
  streamState: "idle",
};

/** Applies one framework event to the message/part list (spec §8.2 client
 *  projection): part snapshots replace by id, deltas append text. */
export function applyEventToMessages(messages: MessageWithParts[], event: { type: FrameworkEventType; data: Record<string, unknown> }): MessageWithParts[] {
  if (event.type === "message.updated") {
    const message = (event.data as { message: MessageWithParts["info"] }).message;
    const index = messages.findIndex((entry) => entry.info.id === message.id);
    if (index === -1) return [...messages, { info: message, parts: [] }];
    const next = [...messages];
    next[index] = { ...next[index]!, info: message };
    return next;
  }
  if (event.type === "message.part.updated") {
    const part = (event.data as { part: Part }).part;
    return messages.map((entry) => {
      if (entry.info.id !== part.messageId) return entry;
      const partIndex = entry.parts.findIndex((candidate) => candidate.id === part.id);
      if (partIndex === -1) return { ...entry, parts: [...entry.parts, part] };
      const nextParts = [...entry.parts];
      nextParts[partIndex] = part;
      return { ...entry, parts: nextParts };
    });
  }
  if (event.type === "message.part.delta") {
    const { messageId, partId, delta } = event.data as { messageId: string; partId: string; delta: string };
    return messages.map((entry) => {
      if (entry.info.id !== messageId) return entry;
      return {
        ...entry,
        parts: entry.parts.map((part) => (part.id === partId && (part.type === "text" || part.type === "reasoning") ? { ...part, text: part.text + delta } : part)),
      };
    });
  }
  return messages;
}

/** Subscribes to a session's SSE stream and folds events into live state.
 *  Messages/parts flow through `onMessages`; session-level projections
 *  (status, todos, artifacts, edits, pending permission) live in LiveState. */
export function useFrameworkSession(sessionId: string | null) {
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [live, setLive] = useState<LiveState>(initialLive);
  const [loading, setLoading] = useState(Boolean(sessionId));
  const [loadError, setLoadError] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const lastSeqRef = useRef(0);

  const close = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    lastSeqRef.current = 0;
    // Reset + load asynchronously so the effect body stays free of setState.
    queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
      setLive(initialLive);
    });
    void fwApi
      .getSession(sessionId)
      .then((result) => {
        if (cancelled) return;
        setSnapshot(result);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(cause instanceof Error ? cause.message : "无法加载会话");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !snapshot) return;
    close();
    const source = new EventSource(`/api/fw/sessions/${encodeURIComponent(sessionId)}/events?since=${lastSeqRef.current}`);
    sourceRef.current = source;
    source.onopen = () => setLive((current) => ({ ...current, streamState: "live" }));

    const handle = (raw: MessageEvent<string>) => {
      let frame: { _seq?: number; [key: string]: unknown };
      try {
        frame = JSON.parse(raw.data) as { _seq?: number };
      } catch {
        return;
      }
      if (typeof frame._seq === "number") lastSeqRef.current = Math.max(lastSeqRef.current, frame._seq);
      const type = raw.type as FrameworkEventType;

      setSnapshot((current) => (current ? { ...current, messages: applyEventToMessages(current.messages, { type, data: frame }) } : current));
      setLive((current) => {
        if (type === "session.status") {
          const status = (frame as { status: SessionStatus }).status;
          // A session error belongs to one run. Once a new run starts, do not
          // keep rendering the previous run's failure under its new response.
          return { ...current, status, ...(status === "running" || status === "waiting_permission" ? { error: null } : {}) };
        }
        if (type === "session.error") return { ...current, error: (frame as { message: string }).message, status: "idle" };
        if (type === "todo.updated") return { ...current, todos: (frame as { todos: TodoItem[] }).todos };
        if (type === "permission.asked") return { ...current, pendingPermission: (frame as { request: PermissionRequest }).request };
        if (type === "permission.replied") return { ...current, pendingPermission: null };
        if (type === "artifact.created") return { ...current, artifacts: [...current.artifacts, frame as unknown as ArtifactCard] };
        if (type === "file.edited") return { ...current, edits: [...current.edits, { ...(frame as unknown as Omit<FileEdit, "at">), at: new Date().toISOString() }] };
        return current;
      });
    };

    for (const type of [
      "session.updated",
      "session.status",
      "session.error",
      "message.updated",
      "message.part.updated",
      "message.part.delta",
      "permission.asked",
      "permission.replied",
      "todo.updated",
      "file.edited",
      "artifact.created",
    ]) {
      source.addEventListener(type, handle);
    }
    source.onerror = () => {
      setLive((current) => ({ ...current, streamState: current.status === "idle" ? "idle" : "reconnecting" }));
    };
    return close;
  }, [sessionId, snapshot?.session.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return { snapshot, live, loading, loadError, setSnapshot };
}
