import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    // Mirror the tsconfig "@/*" -> "./src/*" alias for the app modules under test.
    alias: { "@": path.resolve(process.cwd(), "src") },
  },
  test: {
    // Every test runs against an isolated SQLite file, migrated once in global-setup
    // and reseeded per-test. Never touches the dev/demo database.
    env: { DATABASE_URL: "file:./prisma/test.db" },
    globalSetup: ["./test/global-setup.ts"],
    // better-sqlite3 is a native module and the tests share one SQLite file, so run
    // in a single forked process, serially.
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    hookTimeout: 30000,
    testTimeout: 30000,
  },
});
