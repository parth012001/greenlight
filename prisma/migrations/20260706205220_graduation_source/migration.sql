-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_GraduationProposal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shapeKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "appId" TEXT,
    "level" TEXT,
    "role" TEXT NOT NULL,
    "policyName" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'streak',
    "evidence" TEXT NOT NULL,
    "impactPreview" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decidedBy" TEXT,
    "deciderNote" TEXT,
    "decidedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_GraduationProposal" ("appId", "createdAt", "decidedAt", "decidedBy", "deciderNote", "evidence", "id", "impactPreview", "kind", "level", "policyName", "role", "shapeKey", "status") SELECT "appId", "createdAt", "decidedAt", "decidedBy", "deciderNote", "evidence", "id", "impactPreview", "kind", "level", "policyName", "role", "shapeKey", "status" FROM "GraduationProposal";
DROP TABLE "GraduationProposal";
ALTER TABLE "new_GraduationProposal" RENAME TO "GraduationProposal";
CREATE INDEX "GraduationProposal_shapeKey_idx" ON "GraduationProposal"("shapeKey");
CREATE INDEX "GraduationProposal_status_idx" ON "GraduationProposal"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
