import mongoose from "mongoose";

import { getServerEnvironment } from "@/config/env";

type MongoCache = { connection: typeof mongoose | null; pending: Promise<typeof mongoose> | null };

const globalMongo = globalThis as typeof globalThis & { __zmzaiAgentMongo?: MongoCache };
const cache = globalMongo.__zmzaiAgentMongo ?? { connection: null, pending: null };
globalMongo.__zmzaiAgentMongo = cache;

export async function connectMongo(): Promise<typeof mongoose> {
  if (cache.connection) return cache.connection;
  cache.pending ??= mongoose.connect(getServerEnvironment().MONGODB_URI, { serverSelectionTimeoutMS: 8_000 });
  try {
    cache.connection = await cache.pending;
    return cache.connection;
  } finally {
    cache.pending = null;
  }
}
