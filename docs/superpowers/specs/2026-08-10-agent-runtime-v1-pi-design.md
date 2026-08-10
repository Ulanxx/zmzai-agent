# ZMZAI Agent Runtime v1 Final Specification

> Status: final design, approved direction. Repository: `zmzai-agent`. Runtime dependency: `@earendil-works/pi-agent-core@0.84.1` (exact version).

## 1. Purpose

`agent.zmzai.cloud` is ZMZAI's single-user general Agent workspace. A user gives a task in a durable Workspace; the Agent reads approved context, calls only declared tools, proposes file changes, waits for approval where required, and runs code only through `z.zmzai.cloud`.

The product is not a hosted OpenCode, Hermes clone, or Cloudflare OS fork. It owns the ZMZAI-specific trust boundary: Relay, Workspace revisions, Tool Broker, approvals, and Sandbox policy.

## 2. Locked decisions

- **Agent loop:** `@earendil-works/pi-agent-core@0.84.1`; no Pi Coding Agent CLI and no Pi built-in filesystem, bash, network, provider, or credential tools.
- **Model path:** every completion passes through `m.zmzai.cloud`; no OpenAI direct path and no user-supplied provider API key.
- **Execution path:** code runs only through `z.zmzai.cloud/api/v1`; the Agent service never executes user/Agent code or shell commands itself.
- **Authority:** MongoDB records are the source of truth for Workspaces, revisions, task runs, events, proposals, tool calls, budgets, and approvals. PI state is reconstructible working state, never durable authority.
- **v1 deployment:** a modular Next.js/Node service on the existing Hong Kong server. MongoDB is the control and small-text Workspace store. Redis, PostgreSQL, MinIO, multi-node scheduling, and collaborative editing are not v1 prerequisites.
- **Audience:** a signed-in ZMZAI user. Multi-user collaboration, sharing, scheduled runs, webhooks, and connector marketplace work are excluded.

## 3. Architecture

```text
Browser
  -> agent.zmzai.cloud Agent API + SSE
      -> Task Runtime
          -> PI Agent Core (transient multi-turn loop)
              -> Relay Model Adapter
                  -> m.zmzai.cloud internal Agent endpoint
              -> Tool Broker
                  -> Workspace Store + Revision Store
                  -> Proposal / Approval Store
                  -> ZMZAI Sandbox API
                  -> Web Fetch Policy (second rollout)
```

The browser has a normal ZMZAI Auth session. The Agent API validates it and owns all user-facing authorization. The Task Runtime talks to Relay through a new service-authenticated internal endpoint carrying `userId`, `taskRunId`, and selected public model. Relay validates the service credential, applies the user's balance/model policy, and records usage. The Agent Runtime never persists a browser cookie or an upstream credential.

## 4. PI integration contract

PI is limited to the loop: model turn, structured tool-call parsing, tool-result reinjection, cancellation, and bounded turn execution.

The ZMZAI PI adapter provides:

- a Relay-backed model transport;
- a Tool Registry generated from the Workspace policy;
- a durable event sink for text deltas, tool call requests, tool results, errors, and terminal state;
- a context loader that rebuilds a run from persisted messages, tool results, and the current proposal state;
- an abort signal owned by the Task Runtime.

The adapter must reject any PI tool call not registered for the current Workspace. It must enforce schema validation before the Tool Broker sees input. PI's session JSONL, local harness tools, extensions, and provider configuration are not used in production.

## 5. Domain model

```text
Workspace
  -> WorkspaceFile (current text + revision pointer)
  -> WorkspaceRevision (immutable approved snapshot/diff)
  -> AgentSession (durable conversation metadata)
  -> TaskRun
      -> TaskEvent (monotonic sequence)
      -> ToolCall
      -> ChangeProposal
      -> Artifact reference
```

### Workspace

Fields: `id`, `userId`, `name`, `description`, `currentRevisionId`, `defaultModel`, `approvalMode`, `createdAt`, `updatedAt`.

v1 stores UTF-8 text files up to 512 KiB each and 10 MiB per Workspace. Binary files, large artifacts, and object storage are deferred. Every path is canonicalized, must be relative to the Workspace root, and may not target `.env`, `.git`, credentials, or a symlink escape.

### Revision and proposal

`WorkspaceRevision` is immutable and includes parent revision, author, ordered file changes, diff summary, and timestamp. `ChangeProposal` holds `baseRevisionId`, candidate changes, generated diff, and `pending|approved|rejected|superseded` state.

File writes never mutate the current revision directly. A proposal approval performs a compare-and-set on `Workspace.currentRevisionId`; a mismatch returns `REVISION_CONFLICT` and the Agent must reread/replan.

### Task Run

States: `queued -> running -> waiting_approval -> running -> succeeded|failed|cancelled`. A run has a monotonic event sequence, selected model, budget, Workspace base revision, PI context checkpoint, cancellation flag, and stable failure code when failed.

Only one active run is permitted per Workspace in v1. Every run has maximum values: 12 model turns, 20 tool calls, 10 minutes wall time, 64 KiB persisted event text, and a Relay-enforced model budget. Limits are policy values, not model instructions.

## 6. Plan and Build modes

Every task starts in one selected mode:

- **Plan:** `read`, `list`, and `search` only. No proposals, Sandbox, network, or external effects.
- **Build:** read tools plus proposal-producing `write` and `edit`; Sandbox execution is allowed only after a user approval for that execution request.

The UI displays the mode before the task starts. A Plan task can produce a human-readable plan but cannot silently elevate itself to Build.

## 7. Tool Broker

The Tool Broker is the sole implementation boundary. Each tool declares `name`, `version`, JSON input/output schemas, required capability, side-effect class, approval rule, timeout, and event redaction policy.

| Tool | v1 behavior | Approval |
| --- | --- | --- |
| `list` | List Workspace paths and metadata | never |
| `read` | Read a permitted Workspace text file | never |
| `search` | Bounded text search in Workspace files | never |
| `write` | Create/replace text in a staged proposal | always |
| `edit` | Apply a validated patch in a staged proposal | always |
| `exec` | Submit a Sandbox run against a temporary proposal snapshot | always |
| `webfetch` | Deferred to the second rollout; disabled in initial production | n/a |

All results use `{ ok, data, error, metadata }`. Stable errors include `PATH_NOT_ALLOWED`, `REVISION_CONFLICT`, `APPROVAL_REQUIRED`, `SANDBOX_FAILED`, `SANDBOX_TIMEOUT`, `MODEL_BUDGET_EXCEEDED`, `INSUFFICIENT_CREDITS`, and `RUN_CANCELLED`.

Within one Agent turn, the Broker maintains a shadow view of approved files plus the run's staged proposal. A subsequent `read` sees a staged write; other runs only see the current approved revision. This preserves correct reasoning without exposing unapproved changes globally.

## 8. Approval and execution flow

```text
PI requests write/edit/exec
  -> Broker validates capability and budget
  -> durable ToolCall + ChangeProposal/Event
  -> TaskRun: waiting_approval
  -> browser approves or rejects
  -> compare base revision / apply proposal or dispatch Sandbox
  -> durable result event
  -> PI resumes with structured result
```

Approvals are idempotent. A rejected proposal never changes Workspace state. Sandbox receives only a generated temporary snapshot, never the authoritative Workspace store or a database credential. Sandbox outputs and artifacts are copied back as references in the Task Run; they do not directly alter Workspace files.

## 9. Events, recovery, and cancellation

Every event is persisted before it is emitted over SSE. Event fields are `id`, `runId`, `sequence`, `type`, `at`, and `data`. `Last-Event-ID` replays events with a greater sequence and then tails new events. The browser can always recover with `GET /api/runs/:runId`.

On process restart, the Runtime marks an expired active lease as recoverable, reconstructs PI context from persisted run state, and resumes only at a durable tool boundary. It never repeats an acknowledged side-effecting tool call. A pending proposal remains pending; a pending Sandbox call is resolved from the Sandbox run status before PI resumes.

Cancellation is idempotent: it sets a durable cancel request, aborts PI, invokes Sandbox cancellation where needed, and terminates as `cancelled` only after all active tool work is resolved or fenced off.

## 10. Public API v1

```text
GET  /api/workspaces
POST /api/workspaces
GET  /api/workspaces/:workspaceId
GET  /api/workspaces/:workspaceId/files
GET  /api/workspaces/:workspaceId/revisions

POST /api/workspaces/:workspaceId/runs
GET  /api/runs/:runId
GET  /api/runs/:runId/events
POST /api/runs/:runId/cancel

GET  /api/runs/:runId/proposals
POST /api/proposals/:proposalId/approve
POST /api/proposals/:proposalId/reject
POST /api/workspaces/:workspaceId/revisions/:revisionId/rollback
```

Mutating requests require an idempotency key. API errors have `{ code, error }`; authorization does not leak another user's Workspace, run, proposal, or revision existence.

## 11. Security and operational controls

- All model calls go through Relay; no user provider keys are accepted or stored.
- The Agent process has no Docker socket, host project directory, provider credentials, or direct OpenSandbox credential.
- Tool input, URL input, paths, model output, and Relay responses are validated at trust boundaries.
- Logs and events redact secrets, sessions, keys, and file contents flagged as sensitive.
- Model/turn/tool/time/output budgets are enforced in code and recorded for audit.
- Relay `402` becomes a durable `INSUFFICIENT_CREDITS` task failure with a UI link to `m.zmzai.cloud` billing.

## 12. Influences and exclusions

Cloudflare OS informs durable event sequencing, provisional state, approval barriers, shadow edits, and crash reconciliation. Its Durable Objects, Gatekeeper/OAuth platform, Worker Loader, gadget runtime, sharing, and multi-tenant model are excluded.

Hermes Agent informs bounded iterations, context compaction, event redaction, durable memory candidates, and operational diagnostics. Hermes is not PI-based and its provider keys, host-shell toolsets, cron, messaging gateway, autonomous learning loop, and subagent fleet are excluded from v1.

OpenCode informs Plan/Build product modes, visible tool activity, coding-task UX, and future subagent decomposition. Its local filesystem/Shell privileges, built-in provider configuration, CLI/desktop runtime, and internal tool protocol are excluded.

## 13. Delivery order and acceptance criteria

1. **Foundation:** Auth boundary, Mongo schemas, Workspace/revision store, Relay internal Agent adapter, PI model adapter, Task Run events.
2. **Read-only Agent:** Plan mode with `list/read/search`, SSE, cancellation, model/budget errors, restart recovery.
3. **Proposal workflow:** `write/edit`, shadow state, diff UI/API, approve/reject, revision conflict and rollback.
4. **Sandbox tool:** approved temporary snapshot, Sandbox event forwarding, cancellation and artifact references.
5. **Hardening:** audit views, event redaction, lease recovery drill, budget/load tests, developer API documentation.
6. **Second rollout:** webfetch through a dedicated SSRF-safe policy proxy. Memory candidates and Skills begin only after the core audit trail is reliable.

v1 is accepted only when a signed-in user can create a Workspace, complete a read-only Plan task through Relay, produce and approve a file diff in Build mode, run approved code in Sandbox, reconnect to events without loss, cancel safely, and recover a Task Run after an intentional service restart without duplicate side effects.
