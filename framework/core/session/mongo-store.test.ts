import { beforeEach, describe, expect, it, vi } from "vitest";

import { mongoSessionStore } from "@/framework/core/session/mongo-store";
import type { SessionInfo } from "@/framework/core/session/types";

vi.mock("@/framework/core/session/mongo-models", () => ({
  FrameworkSessionModel: {
    create: vi.fn(),
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    updateOne: vi.fn(),
    find: vi.fn(),
  },
  FrameworkMessageModel: {
    create: vi.fn(),
    findOne: vi.fn(),
    updateOne: vi.fn(),
    find: vi.fn(),
  },
  FrameworkPartModel: {
    create: vi.fn(),
    updateOne: vi.fn(),
    find: vi.fn(),
  },
}));

import { FrameworkMessageModel, FrameworkPartModel, FrameworkSessionModel } from "@/framework/core/session/mongo-models";

const sessionModel = vi.mocked(FrameworkSessionModel);
const messageModel = vi.mocked(FrameworkMessageModel);
const partModel = vi.mocked(FrameworkPartModel);

function lean(value: unknown) {
  return { lean: vi.fn().mockResolvedValue(value) } as never;
}

function findChain(records: unknown[]) {
  return {
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(records),
  } as never;
}

function sessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "ses_1",
    workspaceId: "ws_1",
    userId: "user_1",
    title: "测试会话",
    agent: "default",
    model: { providerId: "relay", modelId: "kimi-k3" },
    permission: [],
    queuedPrompts: [],
    time: { created: "2026-08-11T00:00:00.000Z", updated: "2026-08-11T00:00:00.000Z" },
    ...overrides,
  };
}

function sessionRecord(overrides: Record<string, unknown> = {}) {
  const info = sessionInfo();
  return {
    sessionId: info.id,
    workspaceId: info.workspaceId,
    userId: info.userId,
    title: info.title,
    agent: info.agent,
    model: info.model,
    permission: info.permission,
    queuedPrompts: info.queuedPrompts,
    time: info.time,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("mongoSessionStore sessions", () => {
  it("createSession persists the wire shape", async () => {
    await mongoSessionStore.createSession(sessionInfo());
    expect(sessionModel.create).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "ses_1", workspaceId: "ws_1", title: "测试会话" }));
  });

  it("getSession maps the record back to SessionInfo", async () => {
    sessionModel.findOne.mockReturnValue(lean(sessionRecord()));
    const session = await mongoSessionStore.getSession("ses_1");
    expect(session).toEqual(sessionInfo());
  });

  it("getSession returns null when missing", async () => {
    sessionModel.findOne.mockReturnValue(lean(null));
    expect(await mongoSessionStore.getSession("ses_x")).toBeNull();
  });

  it("updateSession only sets provided fields and bumps time.updated", async () => {
    await mongoSessionStore.updateSession("ses_1", { title: "新标题" });
    const update = sessionModel.updateOne.mock.calls[0]![1] as { $set: Record<string, unknown> };
    expect(sessionModel.updateOne).toHaveBeenCalledWith({ sessionId: "ses_1" }, expect.anything());
    expect(update.$set.title).toBe("新标题");
    expect(update.$set["time.updated"]).toEqual(expect.any(String));
    expect(update.$set.agent).toBeUndefined();
  });

  it("updateSession persists parentId (subagent child stamping)", async () => {
    await mongoSessionStore.updateSession("ses_child", { parentId: "ses_parent", title: "子代理" });
    const update = sessionModel.updateOne.mock.calls[0]![1] as { $set: Record<string, unknown> };
    expect(update.$set.parentId).toBe("ses_parent");
    expect(update.$set.title).toBe("子代理");
  });

  it("listSessions filters by userId and optional workspaceId", async () => {
    sessionModel.find.mockReturnValue(findChain([sessionRecord()]));
    const sessions = await mongoSessionStore.listSessions({ userId: "user_1", workspaceId: "ws_1" });
    expect(sessionModel.find).toHaveBeenCalledWith({ userId: "user_1", workspaceId: "ws_1" });
    expect(sessions).toHaveLength(1);
  });
});

describe("mongoSessionStore messages & parts", () => {
  it("appendMessage and appendPart persist docs", async () => {
    await mongoSessionStore.appendMessage({
      id: "msg_1",
      sessionId: "ses_1",
      role: "user",
      agent: "default",
      model: { providerId: "relay", modelId: "kimi-k3" },
      time: { created: "2026-08-11T00:00:01.000Z" },
    });
    expect(messageModel.create).toHaveBeenCalledWith(expect.objectContaining({ messageId: "msg_1", sessionId: "ses_1" }));

    await mongoSessionStore.appendPart({ id: "prt_1", sessionId: "ses_1", messageId: "msg_1", type: "text", text: "你好" });
    expect(partModel.create).toHaveBeenCalledWith(expect.objectContaining({ partId: "prt_1", messageId: "msg_1" }));
  });

  it("updateMessage merges the patch into the stored info", async () => {
    const info = {
      id: "msg_2",
      sessionId: "ses_1",
      role: "assistant",
      parentId: "msg_1",
      agent: "default",
      model: { providerId: "relay", modelId: "kimi-k3" },
      time: { created: "2026-08-11T00:00:02.000Z" },
    };
    messageModel.findOne.mockReturnValue(lean({ messageId: "msg_2", sessionId: "ses_1", info }));
    await mongoSessionStore.updateMessage("msg_2", { tokens: { input: 10, output: 20 } } as never);
    const update = messageModel.updateOne.mock.calls[0]![1] as { $set: { info: Record<string, unknown> } };
    expect(update.$set.info.tokens).toEqual({ input: 10, output: 20 });
    expect(update.$set.info.role).toBe("assistant");
  });

  it("getMessages groups parts under their message, ordered by creation time", async () => {
    const userInfo = { id: "msg_1", sessionId: "ses_1", role: "user", agent: "default", model: { providerId: "relay", modelId: "kimi-k3" }, time: { created: "2026-08-11T00:00:01.000Z" } };
    const assistantInfo = { id: "msg_2", sessionId: "ses_1", role: "assistant", parentId: "msg_1", agent: "default", model: { providerId: "relay", modelId: "kimi-k3" }, time: { created: "2026-08-11T00:00:02.000Z" } };
    messageModel.find.mockReturnValue(findChain([{ messageId: "msg_2", sessionId: "ses_1", info: assistantInfo }, { messageId: "msg_1", sessionId: "ses_1", info: userInfo }]));
    partModel.find.mockReturnValue(
      findChain([{ partId: "prt_1", sessionId: "ses_1", messageId: "msg_2", part: { id: "prt_1", sessionId: "ses_1", messageId: "msg_2", type: "text", text: "回复" } }]),
    );
    const messages = await mongoSessionStore.getMessages("ses_1");
    expect(messages.map((entry) => entry.info.id)).toEqual(["msg_1", "msg_2"]);
    expect(messages[1]!.parts).toHaveLength(1);
    expect(messages[0]!.parts).toHaveLength(0);
  });
});

describe("mongoSessionStore prompt queue", () => {
  it("enqueuePrompt pushes and returns the queue length", async () => {
    sessionModel.findOneAndUpdate.mockReturnValue(lean(sessionRecord({ queuedPrompts: [{ text: "第一条", enqueuedAt: "t1" }, { text: "第二条", enqueuedAt: "t2" }] })));
    const length = await mongoSessionStore.enqueuePrompt("ses_1", { text: "第二条", enqueuedAt: "t2" });
    expect(length).toBe(2);
    const update = sessionModel.findOneAndUpdate.mock.calls[0]![1] as { $push: { queuedPrompts: unknown } };
    expect(update.$push.queuedPrompts).toEqual({ text: "第二条", enqueuedAt: "t2" });
  });

  it("dequeuePrompt pops the oldest prompt FIFO", async () => {
    sessionModel.findOne.mockReturnValue(lean({ queuedPrompts: [{ text: "第一条", agent: "default", enqueuedAt: "t1" }] }));
    const prompt = await mongoSessionStore.dequeuePrompt("ses_1");
    expect(prompt).toEqual({ text: "第一条", agent: "default", enqueuedAt: "t1" });
    expect(sessionModel.updateOne).toHaveBeenCalledWith({ sessionId: "ses_1" }, expect.objectContaining({ $pop: { queuedPrompts: -1 } }));
  });

  it("dequeuePrompt returns null on an empty queue", async () => {
    sessionModel.findOne.mockReturnValue(lean({ queuedPrompts: [] }));
    expect(await mongoSessionStore.dequeuePrompt("ses_1")).toBeNull();
  });

  it("clearQueuedPrompts empties the queue", async () => {
    await mongoSessionStore.clearQueuedPrompts("ses_1");
    expect(sessionModel.updateOne).toHaveBeenCalledWith({ sessionId: "ses_1" }, expect.objectContaining({ $set: expect.objectContaining({ queuedPrompts: [] }) }));
  });
});
