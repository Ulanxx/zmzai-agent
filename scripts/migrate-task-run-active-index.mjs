import mongoose from "mongoose";

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error("MONGODB_URI is required");

const collectionName = "zmzaiagenttaskruns";
const indexName = "activeWorkspaceKey_1";
const desiredPartialFilter = { activeWorkspaceKey: { $type: "string" } };

await mongoose.connect(uri, { serverSelectionTimeoutMS: 8_000 });
try {
  const collection = mongoose.connection.db.collection(collectionName);
  const cleanup = await collection.updateMany({ activeWorkspaceKey: null }, { $unset: { activeWorkspaceKey: "" } });
  const current = (await collection.indexes()).find((index) => index.name === indexName);
  const isCurrent = current?.unique === true
    && JSON.stringify(current.partialFilterExpression) === JSON.stringify(desiredPartialFilter);
  if (!isCurrent && current) await collection.dropIndex(indexName);
  if (!isCurrent) {
    await collection.createIndex(
      { activeWorkspaceKey: 1 },
      { name: indexName, unique: true, partialFilterExpression: desiredPartialFilter },
    );
  }
  console.log(`task-run active lock index ready; cleared ${cleanup.modifiedCount} legacy null lock(s)`);
} finally {
  await mongoose.disconnect();
}
