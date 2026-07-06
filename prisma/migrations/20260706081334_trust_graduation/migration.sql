-- CreateTable
CREATE TABLE "TrustState" (
    "shapeKey" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "appId" TEXT,
    "level" TEXT,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'supervised',
    "cleanStreak" INTEGER NOT NULL DEFAULT 0,
    "threshold" INTEGER NOT NULL,
    "streakTicketNumbers" TEXT NOT NULL DEFAULT '[]',
    "totalApproved" INTEGER NOT NULL DEFAULT 0,
    "totalDenied" INTEGER NOT NULL DEFAULT 0,
    "autonomousRuns" INTEGER NOT NULL DEFAULT 0,
    "graduatedPolicyId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GraduationProposal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shapeKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "appId" TEXT,
    "level" TEXT,
    "role" TEXT NOT NULL,
    "policyName" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "impactPreview" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decidedBy" TEXT,
    "deciderNote" TEXT,
    "decidedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "TrustState_graduatedPolicyId_idx" ON "TrustState"("graduatedPolicyId");

-- CreateIndex
CREATE INDEX "GraduationProposal_shapeKey_idx" ON "GraduationProposal"("shapeKey");

-- CreateIndex
CREATE INDEX "GraduationProposal_status_idx" ON "GraduationProposal"("status");
