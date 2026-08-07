-- Feature 1 — timed submission window (session-relative).
-- NULL = untimed, which is every existing assignment, so nothing already in the
-- database changes behavior. The deadline is DERIVED (session.createdAt +
-- windowMinutes) and never stored; enforcement is server-side on submit.
ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "windowMinutes" INTEGER;

-- Feature 2 — network restriction, course-wide policy on the class.
-- The toggle defaults to FALSE so every existing class is unrestricted, and the
-- allowlist is separate from the toggle so an instructor can switch enforcement
-- off for a work-from-home week without losing their lab's addresses.
ALTER TABLE "classes" ADD COLUMN IF NOT EXISTS "ipRestrictionEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "classes" ADD COLUMN IF NOT EXISTS "allowedIps" JSONB;

-- Feature 3 — behavioral-metric accuracy review (calibration data only).
-- Rich per-judgment rows, never counters: `predictedFlag` (what the metric said)
-- beside `instructorJudgment` (whether the instructor agreed) is what lets a
-- later query separate true positives from false positives and false negatives.
-- Nothing reads this table to tune a threshold; tuning is a manual pass.
--
-- `taskId` is '' (not NULL) for a session-level judgment because Postgres treats
-- NULLs as DISTINCT in a unique index — with NULL, the "one judgment per
-- instructor per session-metric" constraint would silently allow duplicate
-- session-level rows, which is precisely what the idempotency requires.
CREATE TABLE IF NOT EXISTS "metric_reviews" (
    "id"                 TEXT NOT NULL,
    "sessionId"          TEXT NOT NULL,
    "taskId"             TEXT NOT NULL DEFAULT '',
    "metric"             TEXT NOT NULL,
    "predictedFlag"      BOOLEAN NOT NULL,
    "instructorJudgment" TEXT NOT NULL,
    "instructorId"       TEXT NOT NULL,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "metric_reviews_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "metric_reviews_sessionId_taskId_metric_instructorId_key"
    ON "metric_reviews" ("sessionId", "taskId", "metric", "instructorId");

-- Supports the calibration query this table exists for: for metric X, how often
-- did it flag and the instructor agree (true positive) vs disagree (false
-- positive), and how often did it NOT flag and the instructor disagree (false
-- negative).
CREATE INDEX IF NOT EXISTS "metric_reviews_metric_predictedFlag_instructorJudgment_idx"
    ON "metric_reviews" ("metric", "predictedFlag", "instructorJudgment");

ALTER TABLE "metric_reviews"
    ADD CONSTRAINT "metric_reviews_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "metric_reviews"
    ADD CONSTRAINT "metric_reviews_instructorId_fkey"
    FOREIGN KEY ("instructorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
