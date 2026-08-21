# Scheduler

The Agent service keeps durable work in MongoDB, but scheduled work is
triggered by an external cron or worker. Run `pnpm scheduler:tick` every
30-60 seconds with these server-only variables:

- `AGENT_SCHEDULER_URL` (or `APP_URL`)
- `AUTOMATION_SCHEDULER_SECRET`

Each tick invokes automation dispatch, Wide Research recovery, outbound
webhook delivery, and Relay usage reconciliation. Every endpoint is
idempotent and bounded; a non-2xx response makes the command fail so the
runtime can retry the next interval.

Production should run at least two consecutive ticks during deployment
rollouts and alert when three intervals fail. The secret must never be sent
to browser code or logged.

## Sandbox contract probe

Before a production rollout that changes the Agent-to-Sandbox boundary, run:

```sh
pnpm verify:sandbox-contract
```

The command requires `SANDBOX_AGENT_URL` and
`SANDBOX_AGENT_SERVICE_SECRET_CURRENT`. It checks the configured provider,
runs a no-network disposable HTML artifact probe, reads that artifact through
the protected internal API, and verifies a separate long-running probe reaches
`cancelled`. It does not read project data or call external user systems.

## P0 task samples

`pnpm verify:p0-fixtures` checks the canonical five-task acceptance set under
`scripts/fixtures/p0-task-samples.json`: file analysis, web app generation,
code change, data dashboard, and long research. Run each sample three times
in the product before release, including one rejected approval and one failure
recovery path; record completion, recovery, download, follow-up, and
permission-denial metrics from the audit dashboard.
