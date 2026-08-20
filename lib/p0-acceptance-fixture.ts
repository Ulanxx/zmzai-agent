import { z } from "zod";

export const salesCsvFixture = [
  "date,region,revenue,orders",
  "2026-08-01,华东,12000,48",
  "2026-08-02,华南,9800,37",
  "2026-08-03,华北,15400,56",
].join("\n");

export const webAppArtifactFixture = {
  type: "web_app" as const,
  title: "销售数据看板",
  files: [
    { path: "index.html", contentType: "text/html" },
    { path: "styles.css", contentType: "text/css" },
    { path: "app.js", contentType: "text/javascript" },
  ],
};

export const qaCheckResultSchema = z.object({
  version: z.literal("v1"),
  status: z.enum(["passed", "failed"]),
  checks: z.array(z.object({
    id: z.enum(["html_loads", "metrics_present", "desktop_viewport", "mobile_viewport"]),
    status: z.enum(["passed", "failed"]),
    message: z.string(),
  })),
  viewports: z.array(z.object({ width: z.number().int().positive(), height: z.number().int().positive(), overflow: z.boolean() })),
});

export const qaCheckPassFixture = {
  version: "v1" as const,
  status: "passed" as const,
  checks: [
    { id: "html_loads" as const, status: "passed" as const, message: "index.html 可加载" },
    { id: "metrics_present" as const, status: "passed" as const, message: "核心指标已生成" },
    { id: "desktop_viewport" as const, status: "passed" as const, message: "桌面视口无溢出" },
    { id: "mobile_viewport" as const, status: "passed" as const, message: "移动视口无溢出" },
  ],
  viewports: [
    { width: 1280, height: 800, overflow: false },
    { width: 390, height: 844, overflow: false },
  ],
};

export const qaCheckFailureFixture = {
  ...qaCheckPassFixture,
  status: "failed" as const,
  checks: qaCheckPassFixture.checks.map((check) => check.id === "mobile_viewport" ? { ...check, status: "failed" as const, message: "移动视口存在横向溢出" } : check),
  viewports: qaCheckPassFixture.viewports.map((viewport) => viewport.width === 390 ? { ...viewport, overflow: true } : viewport),
};

export const webAppZipManifestFixture = {
  format: "zip" as const,
  artifactType: "web_app" as const,
  files: webAppArtifactFixture.files.map((file) => file.path),
  requiredFiles: ["index.html" as const],
};
