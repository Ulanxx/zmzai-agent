import { z } from "zod";

const optionalString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().optional(),
);

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  MONGODB_URI: z.string().min(1),
  AUTH_SECRET: z.string().min(32),
  SESSION_COOKIE_NAME: z.string().regex(/^[a-zA-Z0-9_-]+$/).default("muzhi_session"),
  SESSION_COOKIE_DOMAIN: optionalString,
  RELAY_AGENT_URL: z.string().url().default("https://m.zmzai.cloud"),
  RELAY_AGENT_SERVICE_SECRET_CURRENT: optionalString,
  RELAY_AGENT_SERVICE_SECRET_PREVIOUS: optionalString,
  SANDBOX_AGENT_URL: z.string().url().default("https://z.zmzai.cloud"),
  SANDBOX_AGENT_SERVICE_SECRET_CURRENT: optionalString,
  AUTOMATION_SCHEDULER_SECRET: optionalString,
});

export type ServerEnvironment = z.infer<typeof environmentSchema>;

let cachedEnvironment: ServerEnvironment | undefined;

export function getServerEnvironment(): ServerEnvironment {
  cachedEnvironment ??= environmentSchema.parse(process.env);
  return cachedEnvironment;
}

export function resetServerEnvironmentForTest(): void {
  cachedEnvironment = undefined;
}
