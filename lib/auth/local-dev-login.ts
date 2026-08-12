import { randomBytes } from "node:crypto";

import { SessionModel, hashToken } from "@zmzai/db";
import mongoose from "mongoose";

import { getServerEnvironment } from "@/config/env";
import { connectMongo } from "@/lib/database/mongodb";

const LOCAL_EMAIL = "local-e2e@zmzai.cloud";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export function isLocalDevLoginEnabled(): boolean {
  return process.env.NODE_ENV === "development";
}

export async function createLocalDevSession(): Promise<{ token: string; expiresAt: Date }> {
  if (!isLocalDevLoginEnabled()) throw new Error("LOCAL_DEV_LOGIN_DISABLED");

  const environment = getServerEnvironment();
  await connectMongo();

  const result = await mongoose.connection.collection("users").findOneAndUpdate(
    { email: LOCAL_EMAIL },
    {
      $set: { name: "本地开发", role: "admin", status: "active", emailVerified: true },
      $setOnInsert: { email: LOCAL_EMAIL, passwordHash: "local-development-only" },
    },
    { upsert: true, returnDocument: "after" },
  );
  if (!result) throw new Error("LOCAL_DEV_USER_UNAVAILABLE");

  const user = result && typeof result === "object" && "value" in result ? result.value : result;
  if (!user?._id) throw new Error("LOCAL_DEV_USER_UNAVAILABLE");

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await SessionModel.create({
    userId: user._id,
    tokenHash: hashToken(environment.AUTH_SECRET, token),
    expiresAt,
    lastSeenAt: new Date(),
  });

  await mongoose.connection.collection("balanceaccounts").updateOne(
    { userId: user._id },
    { $setOnInsert: { userId: user._id, balanceMicros: 100_000_000_000, reservedMicros: 0 } },
    { upsert: true },
  );

  return { token, expiresAt };
}

export const localDevSessionTtlSeconds = SESSION_TTL_SECONDS;
