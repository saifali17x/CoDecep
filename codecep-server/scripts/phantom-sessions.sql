-- ── Gap #71: the empty phantom duplicates left by overlapping creates ───────
--
-- Two `POST /api/session/create` requests that overlap (React StrictMode's dev
-- double-mount fires them ~1-3ms apart) both SELECT "no row exists" and both
-- INSERT, leaving an EMPTY phantom beside the session the student actually
-- worked in. `POST /api/session/create` is now serialized per identity behind a
-- Postgres advisory lock, so no new pairs are written; this file is the ONE-TIME
-- cleanup of the rows that already exist.
--
-- Run the SELECT first and read it. It lists exactly the rows the DELETE would
-- remove, beside the sibling being kept, so the pairs can be eyeballed before
-- anything is destroyed.
--
--   psql -h localhost -U codecep -d codecep -f scripts/phantom-sessions.sql
--
-- The predicate is deliberately hard to satisfy and mirrors `isDeletablePhantom`
-- in src/lib/sessionResolution.ts clause for clause — the same rule that hides a
-- row from the instructor view, so nothing an instructor can see is deleted and
-- nothing deleted was ever shown. A row is deletable ONLY IF:
--
--   * it is not SUBMITTED (a submitted row is a record of an attempt, always),
--   * it has zero flush windows (no telemetry ever reached it),
--   * its tier1_log is recorded AND empty (NULL means "predates the feature",
--     which is not proof that nothing fired — those rows are left alone),
--   * it has no forensics result and a runCount of 0, and
--   * ANOTHER row for the SAME (studentId, assignmentId) is a real session.
--
-- That last clause is the whole safety property: a genuinely fresh session — the
-- student who opened the exam thirty seconds ago and has not typed yet — looks
-- identical to a phantom and is never touched, because it has no real sibling.
-- A pair where BOTH rows are empty is likewise left alone: nothing proves which
-- one the student would have used.

\set ON_ERROR_STOP on

CREATE OR REPLACE TEMP VIEW phantom_candidates AS
WITH rows AS (
  SELECT s.id,
         s."studentId",
         s."assignmentId",
         s.status,
         jsonb_array_length(s.playback_log)          AS windows,
         jsonb_array_length(s.tier1_log)             AS tier1,     -- NULL = not recorded
         (s."forensicsResults" IS NOT NULL)          AS has_forensics,
         s."runCount",
         s."createdAt",
         s."updatedAt"
  FROM sessions s
)
SELECT c.*,
       (SELECT r.id     FROM rows r
         WHERE r.id <> c.id
           AND r."studentId" = c."studentId"
           AND r."assignmentId" IS NOT DISTINCT FROM c."assignmentId"
           AND (r.status = 'SUBMITTED' OR r.windows > 0)
         ORDER BY (r.status = 'SUBMITTED') DESC, r.windows DESC
         LIMIT 1)                                    AS kept_sibling_id,
       (SELECT r.status  FROM rows r
         WHERE r.id <> c.id
           AND r."studentId" = c."studentId"
           AND r."assignmentId" IS NOT DISTINCT FROM c."assignmentId"
           AND (r.status = 'SUBMITTED' OR r.windows > 0)
         ORDER BY (r.status = 'SUBMITTED') DESC, r.windows DESC
         LIMIT 1)                                    AS kept_sibling_status,
       (SELECT r.windows FROM rows r
         WHERE r.id <> c.id
           AND r."studentId" = c."studentId"
           AND r."assignmentId" IS NOT DISTINCT FROM c."assignmentId"
           AND (r.status = 'SUBMITTED' OR r.windows > 0)
         ORDER BY (r.status = 'SUBMITTED') DESC, r.windows DESC
         LIMIT 1)                                    AS kept_sibling_windows
FROM rows c
WHERE c.status <> 'SUBMITTED'
  AND c.windows = 0
  AND c.tier1 IS NOT NULL AND c.tier1 = 0
  AND NOT c.has_forensics
  AND c."runCount" = 0
  AND EXISTS (
    SELECT 1 FROM rows r
     WHERE r.id <> c.id
       AND r."studentId" = c."studentId"
       AND r."assignmentId" IS NOT DISTINCT FROM c."assignmentId"
       AND (r.status = 'SUBMITTED' OR r.windows > 0)
  );

-- ── 1. REVIEW: exactly what the DELETE below would remove ───────────────────
\echo '=== Phantom rows that WOULD be deleted (with the sibling kept) ==='
SELECT id AS phantom_id, "studentId", left("assignmentId", 8) AS assignment,
       status, windows, tier1, has_forensics, "runCount", "createdAt",
       left(kept_sibling_id, 8) AS keeps, kept_sibling_status, kept_sibling_windows
FROM phantom_candidates
ORDER BY "studentId", "assignmentId";

\echo '=== Count ==='
SELECT count(*) AS phantoms_to_delete FROM phantom_candidates;

-- ── 2. FK safety: nothing may reference a row about to disappear ────────────
-- metric_reviews.sessionId restricts deletes, so an orphan would abort the
-- DELETE rather than corrupt anything — but a phantom that somehow carries an
-- instructor's judgment is not a phantom, and would need looking at by hand.
\echo '=== metric_reviews referencing a would-be-deleted row (expect 0) ==='
SELECT count(*) AS metric_reviews_on_phantoms
FROM metric_reviews mr
WHERE mr."sessionId" IN (SELECT id FROM phantom_candidates);

-- ── 3. DELETE — uncomment to run, after reading the list above ──────────────
-- BEGIN;
-- DELETE FROM metric_reviews WHERE "sessionId" IN (SELECT id FROM phantom_candidates);
-- DELETE FROM sessions       WHERE id IN (SELECT id FROM phantom_candidates);
-- COMMIT;
