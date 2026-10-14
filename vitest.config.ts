import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      remoteBindings: false,
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          APP_URL: "http://localhost:5173",
          PLATFORM_ADMIN_USER_IDS: "",
          BETTER_AUTH_SECRET: "agentflowing-test-secret-at-least-32-characters",
        },
      },
    }),
  ],
});
