try {
  process.loadEnvFile?.(".env.local");
} catch {
  // Production schedulers normally inject environment variables directly.
}

const baseUrl = process.env.AGENT_SCHEDULER_URL || process.env.APP_URL || "http://localhost:3000";
const secret = process.env.AUTOMATION_SCHEDULER_SECRET;

if (!secret) {
  console.error("AUTOMATION_SCHEDULER_SECRET is required");
  process.exitCode = 1;
} else {
  const jobs = [
    ["automations", "/api/internal/automations/tick"],
    ["research", "/api/internal/research/tick"],
    ["webhooks", "/api/internal/webhooks/tick"],
    ["usage", "/api/internal/usage/tick"],
  ];
  for (const [name, path] of jobs) {
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "x-automation-scheduler-secret": secret,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      const body = await response.text();
      if (!response.ok) {
        console.error(`${name}: HTTP ${response.status} ${body.slice(0, 500)}`);
        process.exitCode = 1;
      } else {
        console.log(`${name}: ${body}`);
      }
    } catch (error) {
      console.error(`${name}: ${error instanceof Error ? error.message : "request failed"}`);
      process.exitCode = 1;
    }
  }
}
