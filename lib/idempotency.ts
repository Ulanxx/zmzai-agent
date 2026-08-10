import { createHash } from "node:crypto";

import { IdempotencyModel } from "@/models/idempotency";

const keyPattern = /^[\x21-\x7e]{16,128}$/;

export class IdempotencyError extends Error {
  constructor(public readonly code: "IDEMPOTENCY_KEY_REQUIRED" | "IDEMPOTENCY_CONFLICT") {
    super(code);
    this.name = "IdempotencyError";
  }
}

export function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function claimIdempotency(input: {
  userId: string;
  scope: string;
  key: string | null;
  body: unknown;
  resourceId: string;
}): Promise<{ resourceId: string; replayed: boolean }> {
  if (!input.key || !keyPattern.test(input.key)) throw new IdempotencyError("IDEMPOTENCY_KEY_REQUIRED");

  const hash = requestHash(input.body);
  const existing = await IdempotencyModel.findOne({ userId: input.userId, scope: input.scope, key: input.key }).lean();
  if (existing) {
    if (existing.requestHash !== hash) throw new IdempotencyError("IDEMPOTENCY_CONFLICT");
    return { resourceId: existing.resourceId, replayed: true };
  }

  try {
    await IdempotencyModel.create({
      userId: input.userId,
      scope: input.scope,
      key: input.key,
      requestHash: hash,
      resourceId: input.resourceId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    return { resourceId: input.resourceId, replayed: false };
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("duplicate key")) throw error;
    const raced = await IdempotencyModel.findOne({ userId: input.userId, scope: input.scope, key: input.key }).lean();
    if (!raced || raced.requestHash !== hash) throw new IdempotencyError("IDEMPOTENCY_CONFLICT");
    return { resourceId: raced.resourceId, replayed: true };
  }
}
