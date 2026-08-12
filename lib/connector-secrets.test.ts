import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decryptConnectorHeaders, encryptConnectorHeaders } from "@/lib/connector-secrets";

const original = process.env.AUTH_SECRET;

beforeEach(() => {
  process.env.AUTH_SECRET = "a".repeat(32);
});

afterEach(() => {
  if (original === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = original;
});

describe("connector credential encryption", () => {
  it("round-trips headers without leaving their values in the stored ciphertext", () => {
    const encrypted = encryptConnectorHeaders({ authorization: "Bearer private-token", "x-tenant": "workspace-a" });
    expect(encrypted).not.toContain("private-token");
    expect(decryptConnectorHeaders(encrypted)).toEqual({ authorization: "Bearer private-token", "x-tenant": "workspace-a" });
  });

  it("rejects tampered credential material", () => {
    const encrypted = encryptConnectorHeaders({ authorization: "Bearer private-token" });
    expect(() => decryptConnectorHeaders(`${encrypted}tampered`)).toThrow();
  });
});
