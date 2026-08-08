import fs from 'fs'
import dotenv from 'dotenv'

// ── Environment configuration: ONE codebase, switched by config ────────────
// Local dev/demo reads `.env.local` — it holds the real local Postgres password
// and is gitignored. Production (Heroku) ships NO env file at all and supplies
// the same variable names as config vars in the process environment.
//
// Two dotenv behaviours make that work and neither is incidental:
//   1. A variable already present in process.env is NEVER overwritten, so
//      Heroku's config vars always win over anything a stray file might hold.
//   2. Given a LIST of paths, the first file to define a key wins and a missing
//      file is skipped silently — so `.env` survives as a fallback for an older
//      checkout that has not been renamed yet.
//
// Every module that reads process.env at import time must import this module
// (imports are hoisted, so the load runs before any module body reads a value).
export const ENV_FILES = ['.env.local', '.env']

const loaded: string[] = []
let done = false

/**
 * Load the local env files, once per process. Returns the files that actually
 * existed — an empty list is the normal, correct state in production.
 */
export function loadEnv(): string[] {
  if (done) return loaded
  done = true

  const present = ENV_FILES.filter((file) => fs.existsSync(file))
  if (present.length > 0) {
    // quiet: dotenv's own tip line names every path it was GIVEN, including the
    // ones that do not exist, which reads as an error. We log what was actually
    // loaded ourselves instead — see describeEnvSource().
    dotenv.config({ path: present, quiet: true })
  }
  loaded.push(...present)
  return loaded
}

/**
 * One startup line naming where config came from and which database it points
 * at. The password is NEVER printed — same discipline as the Gemini key.
 */
export function describeEnvSource(): string {
  const source = loaded.length > 0 ? loaded.join(' + ') : 'process environment (no env file)'
  return `${source} → DATABASE_URL ${describeDatabaseTarget()}`
}

/** `host:port/database` with credentials stripped, or a reason it is unreadable. */
export function describeDatabaseTarget(): string {
  const raw = process.env.DATABASE_URL
  if (!raw) return 'NOT SET'
  try {
    const url = new URL(raw)
    const host = url.hostname
    const port = url.port || '5432'
    const database = url.pathname.replace(/^\//, '') || '(default)'
    const locality = host === 'localhost' || host === '127.0.0.1' ? 'local' : 'remote'
    return `${host}:${port}/${database} (${locality})`
  } catch {
    return '(unparseable)'
  }
}

loadEnv()
