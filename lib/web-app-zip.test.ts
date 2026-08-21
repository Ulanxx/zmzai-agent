import { describe, expect, it } from "vitest";

import JSZip from "jszip";

import { buildWebAppZip, isWebAppArtifactSet } from "@/lib/web-app-zip";
import { selectWebAppSourceFiles } from "@/lib/web-app-artifact";

describe("web_app zip delivery", () => {
  it("requires index.html", () => {
    expect(isWebAppArtifactSet([{ path: "styles.css" }])).toBe(false);
    expect(isWebAppArtifactSet([{ path: "index.html" }])).toBe(true);
  });

  it("packages the generated web files without changing their bytes", async () => {
    const zip = await buildWebAppZip([
      { path: "index.html", content: Buffer.from("<main>Revenue</main>") },
      { path: "styles.css", content: Buffer.from("body{margin:0}") },
      { path: "app.js", content: Buffer.from("console.log('ok')") },
    ]);
    const loaded = await JSZip.loadAsync(zip);
    expect(Object.keys(loaded.files).sort()).toEqual(["app.js", "index.html", "styles.css"]);
    expect(await loaded.file("index.html")?.async("string")).toBe("<main>Revenue</main>");
  });

  it("selects direct Workspace web files and excludes unrelated source data", () => {
    expect(selectWebAppSourceFiles([
      { path: "index.html", content: "<html></html>" },
      { path: "styles.css", content: "body{}" },
      { path: "app.js", content: "console.log(1)" },
      { path: "sales.csv", content: "date,revenue" },
      { path: "notes.md", content: "internal notes" },
    ]).map((file) => file.path)).toEqual(["index.html", "styles.css", "app.js"]);
  });
});
