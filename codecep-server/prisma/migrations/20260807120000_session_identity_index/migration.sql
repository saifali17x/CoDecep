-- Gap-fixes part 2, Fix 1 (gap #12): a session is identified by
-- (student, ASSIGNMENT), not by student alone. These are the lookups
-- POST /api/session/create now performs on every exam open.
--
-- Both identifiers are indexed because a row's identity may be either one:
-- sessions opened through ExamPage carry "userId", while the oldest rows carry
-- only "studentId" (the username).
--
-- Deliberately NOT UNIQUE. Rows predating this fix already violate "one session
-- per student per assignment" — that is exactly the damage gap #12 caused — and
-- they are forensic records of real exams, so a unique constraint could only be
-- applied by destroying or merging them. The invariant is enforced in
-- application logic (src/lib/sessionLifecycle.ts), which resolves a LIST of
-- matching rows by rule so historical duplicates read sensibly instead of
-- crashing the exam-open path.
CREATE INDEX IF NOT EXISTS "sessions_assignmentId_userId_idx"
  ON "sessions" ("assignmentId", "userId");

CREATE INDEX IF NOT EXISTS "sessions_assignmentId_studentId_idx"
  ON "sessions" ("assignmentId", "studentId");
