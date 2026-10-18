import vinext from "vinext";
import { defineConfig } from "vite";
import { execFileSync } from "node:child_process";

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare's non-secret runtime files inside the project.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    define: { __MOTING_BUILD__: JSON.stringify(execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim()) },
    server: {
      host: "0.0.0.0",
    },
    plugins: [
      vinext(),
      cloudflare({
        ...(process.env.MOTING_DEV_STATE ? { persistState: { path: process.env.MOTING_DEV_STATE } } : {}),
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        inspectorPort: false,
      }),
    ],
  };
});
