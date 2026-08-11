import { Readable } from "node:stream";

import mongoose from "mongoose";
import { GridFSBucket, type ObjectId } from "mongodb";

import { connectMongo } from "@/lib/database/mongodb";
import { SandboxArtifactModel } from "@/models/sandbox-artifact";

export const artifactBucketName = "sandboxArtifacts";
// Per-run total deliverable budget enforced at pull time (spec §5.1).
export const maxRunArtifactTotalBytes = 100 * 1024 * 1024;

function gridfsBucket(): GridFSBucket {
  const db = mongoose.connection.db as unknown as import("mongodb").Db | undefined;
  if (!db) throw new Error("Mongo 连接未就绪");
  return new GridFSBucket(db, { bucketName: artifactBucketName, chunkSizeBytes: 255 * 1024 });
}

/** Stores artifact bytes in GridFS and returns the created file id. */
export async function storeArtifactBytes(input: { content: Buffer; contentType: string; filename: string }): Promise<{ fileId: ObjectId; length: number }> {
  await connectMongo();
  const fs = gridfsBucket();
  return new Promise((resolve, reject) => {
    const upload = fs.openUploadStream(input.filename);
    upload.on("error", reject);
    upload.on("finish", () => resolve({ fileId: upload.id, length: upload.length }));
    upload.end(input.content);
  });
}

export async function deleteArtifactFiles(fileIds: ObjectId[]): Promise<void> {
  await connectMongo();
  const fs = gridfsBucket();
  await Promise.all(fileIds.map((id) => fs.delete(id).catch(() => undefined)));
}

export function openArtifactStream(fileId: ObjectId): Readable {
  return gridfsBucket().openDownloadStream(fileId);
}

/** Deletes all artifacts of a run (model docs + GridFS chunks). */
export async function deleteRunArtifacts(runId: string): Promise<void> {
  await connectMongo();
  const docs = await SandboxArtifactModel.find({ runId }).select({ gridFsFileId: 1 }).lean();
  const fileIds = docs.map((doc) => doc.gridFsFileId).filter((id): id is ObjectId => Boolean(id));
  if (fileIds.length) await deleteArtifactFiles(fileIds);
  await SandboxArtifactModel.deleteMany({ runId });
}
