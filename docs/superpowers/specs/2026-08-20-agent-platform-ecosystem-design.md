# Agent Platform Ecosystem Design

## Objective

P2 extends the Chat-first Agent core into other products without creating a
second execution system. Every external request becomes a normal `Task` and
`Run`; every completion, approval, artifact, and failure remains visible in the
existing workbench.

## Boundary

The first P2 foundation consists of:

- scoped Agent API keys, shown once and revocable;
- a versioned public Task API with idempotent creation and Task/Artifact reads;
- structured output contracts for API-created Tasks;
- signed outbound events with durable delivery records and retry;
- signed inbound Automation webhooks.

Slack, email, project events, and wide research are adapters over that
foundation. They must not invoke the runner or Mongo models directly.

## Authentication and authorization

`AgentApiKey` belongs to a user, has a fixed list of workspace ids and a list
of scopes. Empty workspace scopes are invalid. The plaintext format is
`zma_...`, generated from 256 bits of randomness, SHA-256 hashed before
persistence, and only returned at creation time.

The public API accepts `Authorization: Bearer zma_...`. A key may act only as
its owner, and a project operation also requires the key owner to retain the
same Project role required by the first-party API. Minimum scopes are:

- `tasks:write` to create a Task;
- `tasks:read` to fetch Task state and output;
- `artifacts:read` to enumerate a Task's artifacts;
- `webhooks:write` to manage outbound subscriptions.

All mutating endpoints require an `Idempotency-Key`. Public authorization
failures return a generic 404 for resources outside the key's visibility.

## Public API

`POST /api/v1/tasks` creates a Framework Session, Task, and Run using the
workspace's configured default model, then starts the normal runner. The body
contains `workspace_id`, optional `project_id`, `prompt`, optional `title`,
and optional `output_schema` (a JSON Schema object). The response is `202` and
includes the stable task/run/session identifiers.

`GET /api/v1/tasks/{taskId}` returns a compact public projection: task/run
status, terminal reason, final assistant text, optional schema-validated
`structured_output`, and artifacts. Internal event logs, reasoning, secrets,
and sandbox paths are never returned.

`POST /api/v1/tasks/{taskId}/cancel` reuses the existing cancellation control
path and has the same idempotency semantics.

## Structured output

For a schema-bound Task, the system instruction asks the Agent to end with one
JSON object in a fenced `json` block. On terminal completion the final
assistant text is extracted, parsed, and validated with a bounded JSON Schema
subset. Valid data is persisted on the Task. Invalid data keeps the Task's
normal result and records an output-contract error instead of misrepresenting
the result as structured.

## Webhooks

Inbound Automation webhooks use a per-automation random secret. The caller
sends a timestamp, event id, and HMAC-SHA256 signature. The event id is an
idempotency key, stale timestamps are rejected, and accepted events create a
new Automation execution with `source: webhook`.

Outbound subscriptions belong to a workspace, are explicitly scoped to event
types, and have a signing secret shown once. Event payloads are compact task
or artifact projections. Every delivery is stored before dispatch, delivered
with exponential retry, and has its response status/error retained for audit.

## Follow-on adapters

- Slack: verifies Slack signatures, normalizes a mention or slash command into
  an inbound request, then posts the terminal event back to the originating
  thread through an outbound adapter.
- Email: verifies provider webhooks, maps a reply chain to an external task,
  and only sends artifacts through time-limited links.
- Wide research: creates a bounded collection of child Tasks, each with a
  task budget and a named research role, then writes a parent synthesis.
- Team budgets: Project policies cap concurrent runs and aggregate Relay token
  use. Reservation happens before a child Run starts, not after it spends.

## Verification gates

1. A key cannot access a workspace outside its fixed scope.
2. Repeating an API create request creates one Task/Run only.
3. A Task created through the API appears in the first-party workbench and can
   still be paused, approved, and resumed there.
4. Valid and invalid structured outputs are distinguished deterministically.
5. A webhook replay cannot create a second Automation execution.
6. An outbound webhook never includes credentials, reasoning, or internal
   sandbox paths and retries from durable state after a service restart.
