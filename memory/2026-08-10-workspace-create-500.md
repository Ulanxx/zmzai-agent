# Workspace Create 500

- Symptom: `POST /api/workspaces` returned `500` for a valid request containing `"description": ""`.
- Root cause: `Workspace` required `description`, while the API contract intentionally allows an empty description.
- Fix: Make `description` optional with an empty-string default. Replayed idempotency records with no Workspace now recover the original create operation.
- Regression test: `models/workspace.test.ts` validates a new Workspace with an empty description.
- Verification: `pnpm test`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run build`, and production deployment workflow `31366539942` succeeded.
