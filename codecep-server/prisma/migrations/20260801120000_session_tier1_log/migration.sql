-- Session 22 (part 2) — per-session Tier-1 alert record.
--
-- One small nullable JSONB column, no new table.
--
-- DRIFT RECONCILIATION: an earlier ABANDONED attempt at this feature applied a
-- migration named `20260801000000_session_tier1_log` directly to Neon and was
-- then reverted from the repo — the migration is recorded in `_prisma_migrations`
-- but its SQL exists nowhere in git. It left `sessions.tier1_log` as
-- `JSONB NOT NULL DEFAULT '[]'`. This migration therefore uses IF NOT EXISTS and
-- reshapes the column rather than assuming a clean slate.
--
-- Why NULLABLE with NO DEFAULT: NULL means "this session predates the Tier-1
-- record" and an empty array means "recorded, nothing fired". Backfilling every
-- old row with '[]' erases that distinction and makes an unrecorded session
-- report zero tab-outs and zero AST violations — a claim the data does not
-- support. In a forensic report "not recorded" and "none happened" must never
-- look the same.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "tier1_log" JSONB;
ALTER TABLE "sessions" ALTER COLUMN "tier1_log" DROP DEFAULT;
ALTER TABLE "sessions" ALTER COLUMN "tier1_log" DROP NOT NULL;

-- Only rows still holding the inherited empty default are cleared: an empty
-- array carries no information, so nothing is lost. Any row that somehow holds
-- real recorded alerts is left untouched.
UPDATE "sessions" SET "tier1_log" = NULL WHERE "tier1_log" = '[]'::jsonb;
