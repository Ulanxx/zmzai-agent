import { describe, expect, it } from "vitest";

import * as p0 from "@/lib/p0-acceptance-fixture";

describe("P0 CSV to web_app acceptance fixture", () => {
  it("keeps the input, deliverable and zip manifest stable", () => {
    expect(p0.salesCsvFixture).toContain("date,region,revenue,orders");
    expect(p0.webAppArtifactFixture.type).toBe("web_app");
    expect(p0.webAppArtifactFixture.files.map((file) => file.path)).toEqual(["index.html", "styles.css", "app.js"]);
    expect(p0.webAppZipManifestFixture.requiredFiles).toEqual(["index.html"]);
  });

  it("accepts both quality outcomes and requires desktop/mobile viewports", () => {
    expect(p0.qaCheckResultSchema.safeParse(p0.qaCheckPassFixture).success).toBe(true);
    expect(p0.qaCheckResultSchema.safeParse(p0.qaCheckFailureFixture).success).toBe(true);
    expect(p0.qaCheckPassFixture.viewports).toEqual([{ width: 1280, height: 800, overflow: false }, { width: 390, height: 844, overflow: false }]);
  });
});
