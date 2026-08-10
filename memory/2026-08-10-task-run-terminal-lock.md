# Task Run terminal lock incident

- Symptom: a Plan run emitted `message.delta` but remained `running` forever in the UI.
- Root cause: `activeWorkspaceKey` used a sparse unique index while terminal updates wrote the field as `null`. MongoDB indexes explicit `null` values in sparse indexes, so every later terminal update collided with the first terminal run.
- Fix: terminal and cancellation paths now unset the lock field; the database migration replaces the index with a unique partial index covering only string Workspace IDs.
- Regression: `models/task-run.test.ts` asserts new terminal-capable documents omit the lock field and the schema has the partial index.
- Production verification: two consecutive Plan runs reached `succeeded`; each SSE stream included `run.queued`, `run.started`, one or more `message.delta`, and `run.completed`. Relay usage for the first run completed successfully.
