-- Enforce at most one ACTIVE (revokedAt IS NULL) grant per (userId, appId).
-- Prisma cannot express a partial/filtered unique index declaratively, so it
-- lives here as raw SQL. Postgres supports the identical syntax:
--   CREATE UNIQUE INDEX "Grant_active_unique" ON "Grant"("userId","appId") WHERE "revokedAt" IS NULL;
-- This closes the race where two concurrent grants both see "no active grant"
-- and both insert revokedAt=NULL, leaving a lingering grant + leaked seat.
CREATE UNIQUE INDEX "Grant_active_unique" ON "Grant"("userId", "appId") WHERE "revokedAt" IS NULL;
