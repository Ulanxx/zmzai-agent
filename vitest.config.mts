import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // theme 0.3.0 业务组件自带 CSS import——测试环境 stub 成空模块
      { find: /\.css$/, replacement: path.join(rootDirectory, "lib/__css-stub.js") },
      { find: /^@\//, replacement: rootDirectory + "/" },
      { find: /^@zmzai\/agent-framework$/, replacement: path.join(rootDirectory, "packages/agent-framework/src/index.ts") },
      { find: /^@zmzai\/agent-framework\//, replacement: path.join(rootDirectory, "packages/agent-framework/src/") },
    ],
  },
  test: {
    environment: "node",
    css: false,
    // theme 0.3.0 组件带 CSS import——inline 处理让 vite alias（CSS stub）生效
    server: { deps: { inline: ["@zmzai/theme"] } },
  },
});
