// 本地全链路 E2E 种子：在共享 MongoDB 中创建 admin 用户、会话和余额。
// 用法：node scripts/seed-local-e2e.mjs <token>   （token 默认随机生成并打印）
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import mongoose from "mongoose";

const root = path.resolve(import.meta.dirname, "..");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    process.env[key] ??= value;
  }
}

loadEnvFile(path.join(root, ".env.local"));

const MONGODB_URI = process.env.MONGODB_URI;
const AUTH_SECRET = process.env.AUTH_SECRET;
if (!MONGODB_URI || !AUTH_SECRET) throw new Error("MONGODB_URI / AUTH_SECRET 未配置");

const token = process.argv[2] ?? randomBytes(32).toString("base64url");
const tokenHash = createHash("sha256").update(`${AUTH_SECRET}:${token}`).digest("hex");

await mongoose.connect(MONGODB_URI);

const result = await mongoose.connection.collection("users").findOneAndUpdate(
  { email: "local-e2e@zmzai.cloud" },
  { $setOnInsert: { name: "本地 E2E", email: "local-e2e@zmzai.cloud", role: "admin", status: "active", emailVerified: true } },
  { upsert: true, returnDocument: "after" },
);

// MongoDB driver >= 6 returns the document directly; older shapes wrap in { value }.
const user = result && typeof result === "object" && "value" in result ? result.value : result;
const userId = user._id;
await mongoose.connection.collection("sessions").findOneAndUpdate(
  { tokenHash },
  { $setOnInsert: { userId, tokenHash, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), lastSeenAt: new Date() } },
  { upsert: true },
);
await mongoose.connection.collection("balanceaccounts").findOneAndUpdate(
  { userId },
  { $setOnInsert: { userId, balanceMicros: 100_000_000_000, reservedMicros: 0 } },
  { upsert: true },
);

console.log(JSON.stringify({ userId: String(userId), cookieToken: token, cookie: `muzhi_session=${token}`, mongo: MONGODB_URI }, null, 2));
await mongoose.disconnect();
