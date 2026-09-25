import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Integration tests share one Postgres database; run files sequentially.
    fileParallelism: false,
    sequence: { concurrent: false },
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
    },
  },
});
