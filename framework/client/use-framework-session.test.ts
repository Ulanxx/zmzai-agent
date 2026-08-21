import { describe, expect, it } from "vitest";

import { latestFrameworkEventSeq } from "@/framework/client/use-framework-session";

describe("latestFrameworkEventSeq", () => {
  it("starts the live stream after the loaded snapshot", () => {
    expect(latestFrameworkEventSeq([{ seq: 4 }, { seq: 9 }, { seq: 7 }])).toBe(9);
    expect(latestFrameworkEventSeq(undefined)).toBe(0);
  });
});
