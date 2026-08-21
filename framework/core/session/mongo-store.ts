import { FrameworkMessageModel, FrameworkPartModel, FrameworkSessionModel, type FrameworkSessionRecord } from "@/framework/core/session/mongo-models";
import type { SessionStore } from "@/framework/core/session/store";
import type { MessageInfo, MessageWithParts, Part, SessionInfo } from "@/framework/core/session/types";

/** Mongo implementation of SessionStore (spec §3.1, cloud default).
 *  Ordering: getMessages returns messages/parts in insertion order; parts are
 *  applied on top of the persisted snapshot so replay is deterministic. */

function toSessionInfo(record: FrameworkSessionRecord): SessionInfo {
  const model = record.model ?? { providerId: "", modelId: "" };
  const time = record.time ?? { created: "", updated: "" };
  return {
    id: record.sessionId,
    workspaceId: record.workspaceId,
    userId: record.userId,
    ...(record.parentId ? { parentId: record.parentId } : {}),
    title: record.title,
    agent: record.agent,
    ...(record.agentId ? { agentId: record.agentId } : {}),
    ...(record.agentVersionId ? { agentVersionId: record.agentVersionId } : {}),
    model,
    permission: (record.permission ?? []).map((rule) => ({ permission: rule.permission, pattern: rule.pattern, action: rule.action, ...(rule.expiresAt ? { expiresAt: rule.expiresAt } : {}) })),
    queuedPrompts: (record.queuedPrompts ?? []).map((prompt) => ({
      text: prompt.text,
      ...(prompt.agent ? { agent: prompt.agent } : {}),
      enqueuedAt: prompt.enqueuedAt,
    })),
    time: { created: time.created, updated: time.updated, ...(time.archived ? { archived: time.archived } : {}) },
  };
}

function touch(): { "time.updated": string } {
  return { "time.updated": new Date().toISOString() };
}

export const mongoSessionStore: SessionStore = {
  async createSession(info) {
    await FrameworkSessionModel.create({
      sessionId: info.id,
      workspaceId: info.workspaceId,
      userId: info.userId,
      ...(info.parentId ? { parentId: info.parentId } : {}),
      title: info.title,
      agent: info.agent,
      ...(info.agentId ? { agentId: info.agentId } : {}),
      ...(info.agentVersionId ? { agentVersionId: info.agentVersionId } : {}),
      model: info.model,
      permission: info.permission,
      queuedPrompts: info.queuedPrompts,
      time: info.time,
    });
  },

  async getSession(id) {
    const record = await FrameworkSessionModel.findOne({ sessionId: id }).lean();
    return record ? toSessionInfo(record) : null;
  },

  async updateSession(id, patch) {
    const $set: Record<string, unknown> = { ...touch() };
    if (patch.title !== undefined) $set.title = patch.title;
    if (patch.agent !== undefined) $set.agent = patch.agent;
    if (patch.model !== undefined) $set.model = patch.model;
    if (patch.permission !== undefined) $set.permission = patch.permission;
    if (patch.queuedPrompts !== undefined) $set.queuedPrompts = patch.queuedPrompts;
    if (patch.parentId !== undefined) $set.parentId = patch.parentId;
    if (patch.time?.archived !== undefined) $set["time.archived"] = patch.time.archived;
    await FrameworkSessionModel.updateOne({ sessionId: id }, { $set });
  },

  async listSessions(filter) {
    const query: Record<string, unknown> = { userId: filter.userId };
    if (filter.workspaceId) query.workspaceId = filter.workspaceId;
    const records = await FrameworkSessionModel.find(query).sort({ "time.updated": -1 }).limit(200).lean();
    return records.map(toSessionInfo);
  },

  async appendMessage(info) {
    await FrameworkMessageModel.create({ messageId: info.id, sessionId: info.sessionId, info });
  },

  async updateMessage(id, patch) {
    const record = await FrameworkMessageModel.findOne({ messageId: id }).lean();
    if (!record) return;
    const merged = { ...(record.info as object), ...patch } as MessageInfo;
    await FrameworkMessageModel.updateOne({ messageId: id }, { $set: { info: merged } });
  },

  async appendPart(part) {
    await FrameworkPartModel.create({ partId: part.id, sessionId: part.sessionId, messageId: part.messageId, part });
  },

  async updatePart(part) {
    await FrameworkPartModel.updateOne({ partId: part.id }, { $set: { part } });
  },

  async getMessages(sessionId) {
    const [messages, parts] = await Promise.all([
      FrameworkMessageModel.find({ sessionId }).lean(),
      FrameworkPartModel.find({ sessionId }).lean(),
    ]);
    const partsByMessage = new Map<string, Part[]>();
    for (const record of parts) {
      const list = partsByMessage.get(record.messageId) ?? [];
      list.push(record.part as Part);
      partsByMessage.set(record.messageId, list);
    }
    // Creation order: user messages carry time.created; parts arrays were
    // appended in order and Mongo preserves insertion order per query without
    // a sort key on a non-capped collection in practice — but make it explicit.
    const sortedMessages = [...messages].sort((a, b) => {
      const aTime = (a.info as MessageInfo).time.created;
      const bTime = (b.info as MessageInfo).time.created;
      return aTime.localeCompare(bTime);
    });
    const result: MessageWithParts[] = sortedMessages.map((record) => ({
      info: record.info as MessageInfo,
      parts: partsByMessage.get(record.messageId) ?? [],
    }));
    return result;
  },

  async enqueuePrompt(sessionId, prompt) {
    const updated = await FrameworkSessionModel.findOneAndUpdate(
      { sessionId },
      { $push: { queuedPrompts: prompt }, $set: { ...touch() } },
      { new: true },
    ).lean();
    return updated?.queuedPrompts.length ?? 0;
  },

  async dequeuePrompt(sessionId) {
    // Two-step read+shift is safe under the single-writer lease: only the
    // active runner ever dequeues.
    const record = await FrameworkSessionModel.findOne({ sessionId }, { queuedPrompts: 1 }).lean();
    const next = record?.queuedPrompts[0];
    if (!next) return null;
    await FrameworkSessionModel.updateOne({ sessionId }, { $pop: { queuedPrompts: -1 }, $set: { ...touch() } });
    return { text: next.text, ...(next.agent ? { agent: next.agent } : {}), enqueuedAt: next.enqueuedAt };
  },

  async clearQueuedPrompts(sessionId) {
    await FrameworkSessionModel.updateOne({ sessionId }, { $set: { queuedPrompts: [], ...touch() } });
  },
};
