-- Add forensicsResults (nullable JSONB, written once by forensics worker post-submission)
-- Add runCount (integer, incremented on each /api/execute call for this session)
ALTER TABLE sessions
  ADD COLUMN "forensicsResults" JSONB,
  ADD COLUMN "runCount" INTEGER NOT NULL DEFAULT 0;
