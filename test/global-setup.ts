import { execSync } from "node:child_process";
import { rmSync } from "node:fs";

// Create a fresh, migrated test database once before the suite runs. Per-test data
// reset happens via resetDb() (test/helpers.ts).
export default function setup() {
  const DATABASE_URL = "file:./prisma/test.db";
  for (const f of [
    "prisma/test.db",
    "prisma/test.db-journal",
    "prisma/test.db-wal",
    "prisma/test.db-shm",
  ]) {
    rmSync(f, { force: true });
  }
  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL },
    stdio: "inherit",
  });
}
