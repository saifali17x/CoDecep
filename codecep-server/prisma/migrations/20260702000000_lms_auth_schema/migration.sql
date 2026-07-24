-- LMS + Auth schema expansion (Track A)
-- New tables: users, classes, class_memberships, assignments
-- sessions gains nullable userId / assignmentId (backward compatible with
-- the existing hardcoded student-001 dev flow).

-- ── users ───────────────────────────────────────────────────────────────────
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- ── classes ─────────────────────────────────────────────────────────────────
CREATE TABLE "classes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "joinCode" TEXT NOT NULL,
    "instructorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "classes_pkey" PRIMARY KEY ("id")
);

-- Unique + fast lookup for join-by-code
CREATE UNIQUE INDEX "classes_joinCode_key" ON "classes"("joinCode");

-- ── class_memberships ───────────────────────────────────────────────────────
CREATE TABLE "class_memberships" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "class_memberships_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "class_memberships_userId_classId_key" ON "class_memberships"("userId", "classId");

-- ── assignments ─────────────────────────────────────────────────────────────
CREATE TABLE "assignments" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "week" INTEGER NOT NULL DEFAULT 1,
    "pdfFilename" TEXT,
    "allowlist" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assignments_pkey" PRIMARY KEY ("id")
);

-- ── sessions: nullable ownership columns ────────────────────────────────────
ALTER TABLE "sessions"
  ADD COLUMN "userId" TEXT,
  ADD COLUMN "assignmentId" TEXT;

-- ── Foreign keys ────────────────────────────────────────────────────────────
ALTER TABLE "classes"
  ADD CONSTRAINT "classes_instructorId_fkey" FOREIGN KEY ("instructorId")
  REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "class_memberships"
  ADD CONSTRAINT "class_memberships_userId_fkey" FOREIGN KEY ("userId")
  REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "class_memberships"
  ADD CONSTRAINT "class_memberships_classId_fkey" FOREIGN KEY ("classId")
  REFERENCES "classes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "assignments"
  ADD CONSTRAINT "assignments_classId_fkey" FOREIGN KEY ("classId")
  REFERENCES "classes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId")
  REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_assignmentId_fkey" FOREIGN KEY ("assignmentId")
  REFERENCES "assignments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
