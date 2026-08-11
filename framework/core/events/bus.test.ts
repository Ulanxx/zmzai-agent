import { beforeEach, describe, expect, it, vi } from "vitest";

import { publishFrameworkEvent, readFrameworkEvents, subscribeFrameworkEvents } from "@/framework/core/events/bus";
import { parseFrameworkEvent } from "@/framework/core/events/manifest";

vi.mock("@/framework/core/events/mongo-models", () => ({
  FrameworkEventModel: {
    create: vi.fn(),
    find: vi.fn(),
  },
  FrameworkSeqModel: {
    findOneAndUpdate: vi.fn(),
  },
}));

import { FrameworkEventModel, FrameworkSeqModel } from "@/framework/core/events/mongo-models";

const eventModel = vi.mocked(FrameworkEventModel);
const seqModel = vi.mocked(FrameworkSeqModel);

let seq = 0;

function findChain(records: unknown[]) {
  return {
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(records),
  } as never;
}

function recordOf(overrides: Record<string, unknown>) {
  return {
    eventId: "evt_x",
    sessionId: "ses_1",
    seq: 1,
    type: "session.status",
    data: { status: "running" },
    at: new Date("2026-08-11T00:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
  seqModel.findOneAndUpdate.mockImplementation(() => ({ lean: vi.fn().mockResolvedValue({ sessionId: "ses_1", seq: ++seq }) }) as never);
  eventModel.create.mockResolvedValue({} as never);
  eventModel.find.mockImplementation(() => findChain([]));
});

describe("publishFrameworkEvent", () => {
  it("validates, allocates seq, persists, and returns the persisted event", async () => {
    const event = await publishFrameworkEvent({ sessionId: "ses_1", type: "session.status", data: { status: "running" } });
    expect(event.seq).toBe(1);
    expect(event.id).toMatch(/^evt_/);
    expect(eventModel.create).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "ses_1", seq: 1, type: "session.status" }));

    const second = await publishFrameworkEvent({ sessionId: "ses_1", type: "session.status", data: { status: "idle" } });
    expect(second.seq).toBe(2);
  });

  it("rejects payloads that violate the manifest", async () => {
    await expect(publishFrameworkEvent({ sessionId: "ses_1", type: "session.status", data: { status: "bogus" } as never })).rejects.toThrow(
      "INVALID_FRAMEWORK_EVENT",
    );
    expect(eventModel.create).not.toHaveBeenCalled();
  });
});

describe("subscribeFrameworkEvents", () => {
  it("delivers live events published after subscription", async () => {
    const events: number[] = [];
    const done = (async () => {
      for await (const event of subscribeFrameworkEvents("ses_live", { pollIntervalMs: 5 })) {
        events.push(event.seq);
        if (events.length === 2) break;
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await publishFrameworkEvent({ sessionId: "ses_live", type: "session.status", data: { status: "running" } });
    await publishFrameworkEvent({ sessionId: "ses_live", type: "session.status", data: { status: "idle" } });
    await done;
    expect(events).toEqual([1, 2]);
  });

  it("replays durable events with seq > sinceSeq before going live", async () => {
    eventModel.find.mockImplementationOnce(() =>
      findChain([recordOf({ eventId: "evt_old", seq: 7 }), recordOf({ eventId: "evt_new", seq: 8 })]),
    );
    const seen: string[] = [];
    for await (const event of subscribeFrameworkEvents("ses_replay", { sinceSeq: 6, pollIntervalMs: 5 })) {
      seen.push(event.id);
      break;
    }
    expect(seen).toEqual(["evt_old"]);
  });

  it("stops when the abort signal fires", async () => {
    const controller = new AbortController();
    const seen: number[] = [];
    const done = (async () => {
      for await (const event of subscribeFrameworkEvents("ses_abort", { pollIntervalMs: 5, signal: controller.signal })) {
        seen.push(event.seq);
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await publishFrameworkEvent({ sessionId: "ses_abort", type: "session.status", data: { status: "running" } });
    controller.abort();
    await done;
    expect(seen).toEqual([1]);
  });
});

describe("readFrameworkEvents", () => {
  it("maps records to persisted events", async () => {
    eventModel.find.mockImplementationOnce(() => findChain([recordOf({ eventId: "evt_9", seq: 9 })]));
    const events = await readFrameworkEvents("ses_1", 8);
    expect(events).toEqual([expect.objectContaining({ id: "evt_9", seq: 9, at: "2026-08-11T00:00:00.000Z" })]);
    expect(eventModel.find).toHaveBeenCalledWith({ sessionId: "ses_1", seq: { $gt: 8 } });
  });
});

describe("parseFrameworkEvent", () => {
  it("accepts valid frames and rejects garbage", () => {
    expect(parseFrameworkEvent({ type: "session.status", data: { status: "idle" } })).toEqual({ type: "session.status", data: { status: "idle" } });
    expect(parseFrameworkEvent({ type: "session.status", data: { status: "nope" } })).toBeNull();
    expect(parseFrameworkEvent({ type: "unknown.event", data: {} })).toBeNull();
    expect(parseFrameworkEvent("nope")).toBeNull();
  });
});
