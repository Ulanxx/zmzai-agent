import { describe, expect, it } from "vitest";

import { artifactTitle, qualityStatusFor } from "@/lib/artifact-metadata";

describe("artifact metadata", () => {
  it("derives a stable user-facing title from a sandbox path", () => {
    expect(artifactTitle("deliverables/销售看板.html")).toBe("销售看板.html");
    expect(artifactTitle("/")).toBe("未命名成果");
  });

  it("marks web deliverables pending QA and other files not applicable", () => {
    expect(qualityStatusFor("text/html", "index.html")).toBe("pending");
    expect(qualityStatusFor("application/zip", "web_app.zip")).toBe("pending");
    expect(qualityStatusFor("application/pdf", "report.pdf")).toBe("not_applicable");
  });
});
