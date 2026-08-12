# CoDecep — Heroku process types. THIS is the Procfile Heroku reads: the app is
# deployed from the repo ROOT, so a Procfile inside codecep-server/ is ignored.
# See CLAUDE.md §7.11 for the full deploy sequence.
#
# ONE dyno type, deliberately: the BullMQ forensics worker is created INLINE in
# codecep-server/src/server.ts, in the same process as Express, so the web dyno
# already consumes the queue. There is no separate worker entry point, and a
# `worker:` line here would run a SECOND worker against the same queue.
#
# `npm start` at the root delegates to `npm --prefix codecep-server start`
# (node dist/server.js), which runs with cwd=codecep-server — that is what makes
# the server's relative `uploads/` and env-file lookups resolve as they do
# locally. The client build is found by an ABSOLUTE path, so it does not depend
# on cwd at all.
web: npm start

# Runs once per release, before the new dynos boot. `migrate deploy` is the
# non-interactive, pooler-safe command (CLAUDE.md §5) — never `migrate dev`.
# A failed release aborts the deploy and leaves the current version running.
release: npm run migrate:deploy
