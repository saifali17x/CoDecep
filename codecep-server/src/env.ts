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
    return `${host}:${port}/${database} (${isLocalHostname(host) ? 'local' : 'remote'})`
  } catch {
    return '(unparseable)'
  }
}

// ── Connection policy: ONE place decides how to reach each service ──────────
// Everything below turns a config VARIABLE into the connection SETTINGS a
// driver needs. It lives here, beside the loader, for the reason §7.8 gives for
// the loader itself: the P1010 outage was a split brain, and the cure for a
// split brain is not a second careful implementation, it is one implementation.
//
// The 2026-08-12 outage is the worked example. `prisma migrate deploy` applied
// all 12 migrations against Heroku Postgres, and minutes later, in the SAME
// release and from the SAME DATABASE_URL, the runtime client was refused with
// P1010 "User was denied access". The URL was never the problem — the two paths
// use DIFFERENT DRIVERS with different TLS defaults:
//
//   CLI     → Prisma's Rust query engine, which defaults to sslmode=prefer and
//             therefore negotiates TLS on its own. It worked by luck of default.
//   RUNTIME → node-postgres (`pg`), via PrismaPg. `pg` NEVER enables TLS unless
//             it is told to, and a Heroku URL carries no ssl parameters, so the
//             connection went out in plaintext. Heroku's pg_hba then refused it:
//             `28000: no pg_hba.conf entry for host ..., no encryption`, which
//             Prisma surfaces as P1010 — an authentication error by class, which
//             is why it reads as a credentials problem and is not one.
//
// Measured against the live add-ons, which is how each rule below was chosen
// rather than guessed. See CLAUDE.md §7.12.
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', ''])

function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname)
}

/** Is this URL pointed at something on this machine? Exported for testing. */
export function isLocalTarget(raw: string | undefined): boolean {
  if (!raw) return true
  try {
    return isLocalHostname(new URL(raw).hostname)
  } catch {
    return false
  }
}

/**
 * The ONE read of DATABASE_URL. The Prisma CLI (through prisma.config.ts) and
 * the runtime pool both call this, so they cannot resolve different databases.
 */
export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? ''
}

export type DatabaseSsl = false | { rejectUnauthorized: boolean }

/**
 * The TLS policy for the DATABASE target, in the shape node-postgres wants.
 * Both connection paths derive from this ONE function, so "does this database
 * need TLS?" has exactly one answer per environment.
 *
 * `DATABASE_SSL` overrides the decision (`disable` | `no-verify` | `verify`);
 * otherwise a local host means no TLS and anything remote means TLS.
 *
 * Two measured facts decide the remote default:
 *
 *  1. `rejectUnauthorized: false` is required, not lazy. Heroku Postgres serves
 *     an Amazon RDS certificate whose issuer is not in Node's trust store, so
 *     strict verification fails with UNABLE_TO_GET_ISSUER_CERT_LOCALLY. The
 *     connection is ENCRYPTED but the server is not AUTHENTICATED — a real
 *     residual weakness (gap #93), fixable by shipping the RDS CA bundle and
 *     setting DATABASE_SSL=verify, not by pretending it away here.
 *  2. Appending `?sslmode=require` to the URL is NOT an equivalent fix and was
 *     rejected on evidence: `pg` 8.21 treats `require` as `verify-full`, so it
 *     fails exactly as (1) describes. Only `sslmode=no-verify` works there —
 *     which would hide a security decision inside a secret-bearing string the
 *     platform generates. Keeping it as an explicit object keeps it reviewable.
 */
export function databaseSsl(raw: string | undefined = process.env.DATABASE_URL): DatabaseSsl {
  const override = (process.env.DATABASE_SSL ?? '').trim().toLowerCase()
  if (override === 'disable' || override === 'false' || override === 'off') return false
  if (override === 'verify' || override === 'verify-full') return { rejectUnauthorized: true }
  if (override === 'no-verify' || override === 'require' || override === 'true') {
    return { rejectUnauthorized: false }
  }
  // An unparseable URL is left alone: the driver will report the real problem,
  // and inventing TLS for a string we could not read would only mask it.
  if (!raw) return false
  return isLocalTarget(raw) ? false : { rejectUnauthorized: false }
}

/** One startup line: TLS on or off for the database, and how strict. */
export function describeDatabaseSsl(): string {
  const ssl = databaseSsl()
  if (!ssl) return 'ssl off (local target)'
  return ssl.rejectUnauthorized ? 'ssl on (certificate verified)' : 'ssl on (certificate not verified)'
}

/**
 * The database URL as the PRISMA CLI should receive it. Same URL the runtime
 * uses, with the TLS requirement made EXPLICIT when this target needs it.
 *
 * The CLI has been reaching Heroku on the Rust engine's `sslmode=prefer`
 * default — i.e. it has been opportunistically encrypting rather than being
 * told to. That is precisely the asymmetry this outage was made of, so the
 * requirement is now stated rather than inherited. Prisma's connector reads
 * `sslmode=require` as "encrypt, do not verify the CA", which matches the
 * runtime policy above. An explicit `sslmode` already in the URL always wins.
 */
export function prismaCliDatabaseUrl(): string {
  const raw = databaseUrl()
  if (!raw || !databaseSsl(raw)) return raw
  if (/[?&]sslmode=/i.test(raw)) return raw
  return `${raw}${raw.includes('?') ? '&' : '?'}sslmode=require`
}

export type RedisConnectionOptions = {
  host: string
  port: number
  username?: string
  password?: string
  tls?: { rejectUnauthorized: boolean }
}

/**
 * The connection settings for Redis, from REDIS_URL.
 *
 * The previous version of this read the hostname and port and DROPPED
 * everything else — no password, no TLS. Against local Redis that is exactly
 * right and it is why it survived so long. Against Heroku Redis it produced a
 * permanent reconnect loop: the add-on's TLS listener resets a plaintext
 * socket, so every attempt died with `read ECONNRESET` before authentication
 * was even reached, three connections at a time (BullMQ opens one for the
 * queue and two for the worker) on BullMQ's retry backoff, which saturates at
 * exactly the 20s period seen in the logs.
 *
 * `rediss://` means TLS, and Heroku Redis presents a SELF-SIGNED chain —
 * measured: strict verification fails with SELF_SIGNED_CERT_IN_CHAIN, so
 * `rejectUnauthorized: false` is required to connect at all. Same honest
 * caveat as the database (gap #93): encrypted, not authenticated.
 *
 * A plain `redis://` URL gets NO tls block and no invented credentials, so
 * local Redis is byte-for-byte the connection it always had.
 */
export function redisConnectionOptions(
  raw: string | undefined = process.env.REDIS_URL,
): RedisConnectionOptions {
  const url = new URL(raw && raw.trim().length > 0 ? raw : 'redis://localhost:6379')
  const secure = url.protocol === 'rediss:'
  const options: RedisConnectionOptions = {
    host: url.hostname,
    port: Number(url.port) || 6379,
  }
  // Heroku's URL carries an EMPTY username (`rediss://:password@host`). Sending
  // one would turn a password-only AUTH into an ACL user lookup for a user that
  // does not exist, so an empty value is omitted rather than passed through.
  if (url.username) options.username = decodeURIComponent(url.username)
  if (url.password) options.password = decodeURIComponent(url.password)
  if (secure) options.tls = { rejectUnauthorized: false }
  return options
}

/** `host:port` plus how it will connect. No password, ever. */
export function describeRedisTarget(raw: string | undefined = process.env.REDIS_URL): string {
  const options = redisConnectionOptions(raw)
  const auth = options.password ? 'auth' : 'no auth'
  return `${options.host}:${options.port} (${options.tls ? 'tls, certificate not verified' : 'no tls'}, ${auth})`
}

/**
 * How many proxy hops to trust, for `app.set('trust proxy', ...)`.
 *
 * `true` trusts EVERY hop, which means the left-most X-Forwarded-For entry is
 * whatever the client typed. express-rate-limit refuses to work with that
 * (ERR_ERL_PERMISSIVE_TRUST_PROXY), and it matters more here than for rate
 * limiting: the shipped IP-restriction feature reads `req.ip`, so a spoofable
 * address weakens an access control an instructor was told to rely on.
 *
 * A HOP COUNT is the fix. Heroku's router is exactly one hop, so `1` makes
 * Express take the entry the router itself appended and ignore anything the
 * client prepended. `TRUST_PROXY=true` is kept working and coerced to 1 — the
 * config var already deployed says "there is a proxy", and reading that as
 * "one hop" is both true on Heroku and the safe direction to be wrong in.
 */
export function trustProxySetting(raw: string | undefined = process.env.TRUST_PROXY): number | false {
  const value = (raw ?? '').trim().toLowerCase()
  if (value === '' || value === 'false' || value === 'off' || value === '0') return false
  if (value === 'true' || value === 'on') return 1
  const hops = Number(value)
  return Number.isInteger(hops) && hops > 0 ? hops : 1
}

loadEnv()
