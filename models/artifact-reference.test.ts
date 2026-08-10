import { describe, expect, it } from "vitest";

import { ArtifactReferenceModel } from "@/models/artifact-reference";

describe("ArtifactReference model", () => {
  it("indexes artifact references by run and tool call", () => {
    const indexes = ArtifactReferenceModel.schema.indexes();
    expect(indexes).toContainEqual([{ runId: 1, artifactId: 1 }, { unique: true }]);
    expect(indexes).toContainEqual([{ runId: 1, toolCallId: 1 }, {}]);
  });
});
