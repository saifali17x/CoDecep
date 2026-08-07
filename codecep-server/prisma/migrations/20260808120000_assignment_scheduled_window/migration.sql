-- Scheduled submission window (wall-clock) — replaces the session-relative model.
--
-- Both columns are NULLABLE with no default, so every existing assignment stays
-- untimed and every existing session's behavior is unchanged. `windowMinutes`
-- is kept but demoted to an instructor-UI convenience derived from the schedule;
-- it is no longer read by the enforcement path, so pre-existing values simply
-- stop having an effect rather than needing a data migration (back-filling a
-- wall-clock schedule from one would mean inventing an opening time nobody set).

ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "opensAt" TIMESTAMP(3);
ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "closesAt" TIMESTAMP(3);
