import { describe, expect, it } from "vitest";

import { selectWebAppSourceFiles } from "@/lib/web-app-artifact";

describe("web app artifact source selection", () => {
  it("keeps the entrypoint and static dependencies in deterministic order", () => {
    const files = selectWebAppSourceFiles([
      { path: "z.js", content: "console.log(1)" },
      { path: "index.html", content: "<html></html>" },
      { path: "assets/icon.svg", content: "<svg />" },
      { path: "styles.css", content: "body{}" },
      { path: "report.pdf", content: "not a web source" },
    ]);

    expect(files.map((file) => file.path)).toEqual(["z.js", "index.html", "assets/icon.svg", "styles.css"]);
    expect(files.find((file) => file.path === "index.html")?.contentType).toBe("text/html");
    expect(files.find((file) => file.path === "assets/icon.svg")?.contentType).toBe("image/svg+xml");
  });

  it("does not turn a data-only workspace into a web app", () => {
    expect(selectWebAppSourceFiles([
      { path: "sales.csv", content: "date,revenue" },
      { path: "notes.md", content: "analysis" },
    ])).toEqual([]);
  });
});
