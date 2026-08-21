import { randomUUID } from "node:crypto";

const baseUrl = process.env.SANDBOX_AGENT_URL?.trim().replace(/\/$/, "");
const serviceSecret = process.env.SANDBOX_AGENT_SERVICE_SECRET_CURRENT?.trim();

if (!baseUrl || !serviceSecret) {
  throw new Error("SANDBOX_AGENT_URL and SANDBOX_AGENT_SERVICE_SECRET_CURRENT are required");
}

const headers = {
  authorization: `Bearer ${serviceSecret}`,
  "content-type": "application/json",
  "x-zmzai-contract-version": "v1",
};

const terminalStates = new Set(["succeeded", "failed", "cancelled"]);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, { cache: "no-store", ...init });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} failed (${response.status}): ${JSON.stringify(body)}`);
  return body;
}

async function waitForTerminal(runId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const { run } = await request(`/api/internal/agent/runs/${encodeURIComponent(runId)}`, { headers });
    if (terminalStates.has(run.status)) return run;
    await delay(500);
  }
  throw new Error(`Sandbox run ${runId} did not reach a terminal state within 30 seconds`);
}

function newRunInput(command) {
  const id = randomUUID();
  return {
    userId: "sandbox-contract-check",
    taskRunId: `contract_${id}`,
    requestId: `sandbox_contract_${id}`,
    snapshot: { revisionId: null, files: [] },
    command,
    limits: { timeoutMs: 30000, cpuMillis: 500, memoryMiB: 256 },
  };
}

async function createRun(command) {
  const { run } = await request("/api/internal/agent/runs", {
    method: "POST",
    headers,
    body: JSON.stringify(newRunInput(command)),
  });
  return run.id;
}

const provider = await request("/api/provider");
if (provider.provider !== "opensandbox" || provider.healthy !== true) {
  throw new Error(`OpenSandbox provider is not healthy: ${JSON.stringify(provider)}`);
}

const artifactRunId = await createRun({
  program: "node",
  args: ["-e", "require('node:fs').writeFileSync('index.html', '<!doctype html><title>ZMZAI sandbox check</title><main>sandbox-ok $HOME `literal` \"quoted\"</main>')"],
});
const artifactRun = await waitForTerminal(artifactRunId);
if (artifactRun.status !== "succeeded" || artifactRun.exitCode !== 0) {
  throw new Error(`Artifact probe did not succeed: ${JSON.stringify(artifactRun)}`);
}

const { artifacts } = await request(`/api/internal/agent/runs/${encodeURIComponent(artifactRunId)}/artifacts`, { headers });
const artifact = artifacts.find((item) => item.path === "index.html");
if (!artifact) throw new Error("Artifact probe did not return index.html");

const artifactResponse = await fetch(`${baseUrl}/api/internal/agent/runs/${encodeURIComponent(artifactRunId)}/artifacts/index.html`, { headers });
const artifactContent = await artifactResponse.text();
if (!artifactResponse.ok || !artifactContent.includes('sandbox-ok $HOME `literal` "quoted"')) {
  throw new Error(`Artifact readback failed (${artifactResponse.status})`);
}

const cancellationRunId = await createRun({
  program: "node",
  args: ["-e", "setTimeout(() => process.exit(0), 20000)"],
});
await delay(400);
await request(`/api/internal/agent/runs/${encodeURIComponent(cancellationRunId)}/cancel`, {
  method: "POST",
  headers: { authorization: headers.authorization, "x-zmzai-contract-version": "v1" },
});
const cancellationRun = await waitForTerminal(cancellationRunId);
if (cancellationRun.status !== "cancelled") {
  throw new Error(`Cancellation probe did not cancel: ${JSON.stringify(cancellationRun)}`);
}

console.log(JSON.stringify({
  provider: provider.provider,
  artifactRun: { id: artifactRunId, status: artifactRun.status, path: artifact.path },
  cancellationRun: { id: cancellationRunId, status: cancellationRun.status },
}));
