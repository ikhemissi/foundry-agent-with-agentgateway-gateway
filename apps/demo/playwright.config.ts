import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:3007", browserName: "chromium", trace: "off" },
  webServer: {
    command: "npm run start -- --port 3007",
    url: "http://127.0.0.1:3007",
    reuseExistingServer: false,
    env: { NEXT_TELEMETRY_DISABLED: "1", COPILOTKIT_TELEMETRY_DISABLED: "true" },
  },
});
