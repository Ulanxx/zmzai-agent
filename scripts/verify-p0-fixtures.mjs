import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const fixtureDirectory = new URL("./fixtures/", import.meta.url);
const samples = JSON.parse(await readFile(new URL("p0-task-samples.json", fixtureDirectory), "utf8"));
const requiredKinds = ["file_analysis", "web_app", "code_change", "data_dashboard", "long_research"];

if (!Array.isArray(samples) || samples.length !== requiredKinds.length) {
  throw new Error(`Expected ${requiredKinds.length} P0 task samples`);
}

const kinds = new Set();
for (const sample of samples) {
  if (!sample || typeof sample !== "object" || typeof sample.kind !== "string" || typeof sample.goal !== "string" || !sample.goal.trim()) {
    throw new Error("Each P0 sample needs a kind and a non-empty goal");
  }
  kinds.add(sample.kind);
  if (!Array.isArray(sample.fixtureFiles)) throw new Error(`${sample.kind} must declare fixtureFiles`);
  await Promise.all(sample.fixtureFiles.map(async (name) => {
    if (typeof name !== "string" || !/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`Invalid fixture file: ${name}`);
    await access(new URL(name, fixtureDirectory));
  }));
}

for (const kind of requiredKinds) {
  if (!kinds.has(kind)) throw new Error(`Missing required P0 task kind: ${kind}`);
}

console.log(JSON.stringify({ samples: samples.map(({ id, kind }) => ({ id, kind })), fixtureDirectory: fileURLToPath(fixtureDirectory) }));
