-- Session 20: separate the COURSE syllabus (class-level, drives the AST
-- allowlist) from the ASSIGNMENT task PDF (per-assignment, shown in the exam
-- split-pane). Previously one upload did double duty.

-- 1. Class gains the syllabus document + the confirmed per-week allowlist.
ALTER TABLE "classes" ADD COLUMN "syllabusFilename" TEXT;
ALTER TABLE "classes" ADD COLUMN "allowlist" JSONB;

-- 2. Preserve instructor work: lift the most recent non-null per-assignment
--    allowlist in each class up to the class before the column is dropped.
UPDATE "classes" c
SET "allowlist" = sub."allowlist"
FROM (
  SELECT DISTINCT ON ("classId") "classId", "allowlist"
  FROM "assignments"
  WHERE "allowlist" IS NOT NULL
  ORDER BY "classId", "createdAt" DESC
) sub
WHERE c."id" = sub."classId" AND c."allowlist" IS NULL;

-- 3. The assignment's PDF is now unambiguously the task/question document.
ALTER TABLE "assignments" RENAME COLUMN "pdfFilename" TO "assignmentPdfFilename";

-- 4. The allowlist lives on the class now.
ALTER TABLE "assignments" DROP COLUMN "allowlist";
