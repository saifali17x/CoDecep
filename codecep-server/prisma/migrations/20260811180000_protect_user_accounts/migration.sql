-- Data-loss fix (gap #81, 2026-08-11): real user accounts must never be
-- deleted by test/seed/cleanup code.
--
-- WHAT HAPPENED. A verification harness created fixture students named
-- "stud_<timestamp>" and tore them down with a PREFIX delete —
-- `user.deleteMany({ where: { username: { startsWith: 'stud' } } })` — run
-- against the real dev database. The user's own manually-created accounts
-- student_a / student_b / student_c shared that prefix and were destroyed as
-- collateral, repeatedly, on Neon and again locally. The evidence is still in
-- this database: "users" records 61 deleted tuples, a surviving session row
-- names a student account ("stud_1786214436915") whose instructor partner is
-- still present, and of 33 surviving accounts EXACTLY ZERO begin with "stud"
-- while four merely contain it (pstud_*, demo_student) and survived — which is
-- what identifies the filter as prefix-anchored rather than a substring match.
--
-- WHY A DATABASE TRIGGER. Every previous safeguard here would have been a
-- convention ("delete by id, not by pattern"), and a convention only protects
-- the scripts that exist today. Harnesses are written fresh in almost every
-- session, they run against .env.local's REAL database, and the one that did
-- the damage is already deleted and unreviewable. A rule that lives BELOW the
-- application protects code that has not been written yet, in any language,
-- including raw SQL — which is the only thing that makes a repeat structurally
-- impossible rather than merely unlikely.
--
-- The application itself contains NO user-deletion path of any kind, so this
-- trigger never fires during normal operation. It is not an account-expiry and
-- it does not delete anything — it is purely a refusal.

-- The allow-list of accounts a harness is permitted to remove. A fixture user
-- must be REGISTERED here by the code that created it, which is what makes
-- "delete only what you created" checkable by the database instead of trusted.
-- ON DELETE CASCADE keeps this table free of orphans: the row disappears with
-- the account it describes.
CREATE TABLE IF NOT EXISTS "harness_fixture_users" (
  "userId"    TEXT PRIMARY KEY,
  "note"      TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "harness_fixture_users_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE OR REPLACE FUNCTION "codecep_guard_user_delete"() RETURNS TRIGGER AS $$
BEGIN
  -- A fixture the harness registered when it created the account. This is the
  -- ONLY route a script is expected to use, and it can never reach an account
  -- the script did not create, whatever WHERE clause it was written with: a
  -- broad `DELETE FROM users` simply fails on the first unregistered row.
  IF EXISTS (SELECT 1 FROM "harness_fixture_users" f WHERE f."userId" = OLD."id") THEN
    RETURN OLD;
  END IF;

  -- The deliberate human escape hatch, for the rare case of genuinely removing
  -- a real account. Transaction-scoped (SET LOCAL), so it cannot be left on:
  --
  --   BEGIN;
  --     SET LOCAL codecep.allow_user_delete = 'on';
  --     DELETE FROM users WHERE username = 'someone';
  --   COMMIT;
  --
  -- A routine harness run does not do this by accident.
  IF current_setting('codecep.allow_user_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION
    'refusing to delete user account "%": it is not a registered harness fixture', OLD."username"
    USING HINT =
      'Tests and harnesses must create their own users and delete ONLY those, by id '
      '(see scripts/lib/harness.ts). To remove a real account deliberately, run '
      'SET LOCAL codecep.allow_user_delete = ''on'' inside an explicit transaction.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "users_guard_delete" ON "users";
CREATE TRIGGER "users_guard_delete"
  BEFORE DELETE ON "users"
  FOR EACH ROW EXECUTE FUNCTION "codecep_guard_user_delete"();
