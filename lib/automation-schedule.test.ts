import { describe, expect, it } from "vitest";

import { isManualSchedule, isSupportedSchedule, isSupportedTimeZone, nextScheduledAt, parseCronSchedule } from "@/lib/automation-schedule";

describe("automation schedule", () => {
  it("keeps manual automations unscheduled", () => {
    expect(isManualSchedule("手动运行")).toBe(true);
    expect(nextScheduledAt("手动运行", new Date("2026-08-20T00:00:00.000Z"))).toBeNull();
  });

  it("calculates daily schedules in the requested timezone", () => {
    const next = nextScheduledAt("每天 09:00", new Date("2026-08-20T00:00:00.000Z"), "Asia/Shanghai");
    expect(next?.toISOString()).toBe("2026-08-20T01:00:00.000Z");
  });

  it("skips weekends for weekday schedules", () => {
    const next = nextScheduledAt("工作日 09:00", new Date("2026-08-21T02:00:00.000Z"), "Asia/Shanghai");
    expect(next?.toISOString()).toBe("2026-08-24T01:00:00.000Z");
  });

  it("supports hourly and five-field cron schedules", () => {
    expect(nextScheduledAt("每小时", new Date("2026-08-20T00:15:00.000Z"), "UTC")?.toISOString()).toBe("2026-08-20T01:00:00.000Z");
    expect(parseCronSchedule("*/15 * * * *")).not.toBeNull();
    expect(nextScheduledAt("*/15 * * * *", new Date("2026-08-20T00:16:00.000Z"), "UTC")?.toISOString()).toBe("2026-08-20T00:30:00.000Z");
  });

  it("rejects malformed cron schedules", () => {
    expect(parseCronSchedule("61 * * * *")).toBeNull();
    expect(isSupportedSchedule("not a schedule")).toBe(false);
    expect(isSupportedTimeZone("Asia/Shanghai")).toBe(true);
    expect(isSupportedTimeZone("Mars/Olympus")).toBe(false);
    expect(nextScheduledAt("not a schedule", new Date("2026-08-20T00:00:00.000Z"))).toBeNull();
  });
});
