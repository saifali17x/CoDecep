/**
 * verify-connection-config.ts — can this process actually REACH its services?
 *
 * The guard for the 2026-08-12 production outage (CLAUDE.md §7.12). The deploy
 * pipeline was green — build, release, all 12 migrations applied — and the
 * running app could not open a single database connection, because
 * `prisma migrate deploy` and the runtime PrismaClient use different drivers
 * with different TLS defaults. Every other harness here assumes a working
 * connection; this one tests the connection itself, through the SAME resolvers
 * `server.ts` and `prisma.config.ts` use.
 *
 * READ-ONLY against Postgres (`SELECT 1`, one `findUnique`). The BullMQ check
 * uses a UNIQUELY-NAMED throwaway queue and obliterates it afterwards, so it
 * never touches `telemetryQueue` or any real job.
 *
 * Point it at whatever you want to verify — it reads the ambient environment:
 *   npx tsx scripts/verify-connection-config.ts                        # local
 *   DATABASE_URL=$(heroku config:get DATABASE_URL -a codecep) \
 *   REDIS_URL=$(heroku config:get REDIS_URL -a codecep) \
 *     npx tsx scripts/verify-connection-config.ts                      # Heroku
 */
import { Pool } from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { Queue, Worker } from 'bullmq'
import {
  databaseUrl,
  databaseSsl,
  describeDatabaseTarget,
  describeDatabaseSsl,
  redisConnectionOptions,
  describeRedisTarget,
  trustProxySetting,
} from '../src/env'

let passed = 0
let failed = 0

function check(label: string, ok: boolean, detail = '') {
  if (ok) {
    passed++
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed++
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

async function main() {
  console.log('\n=== Connection configuration ===')
  console.log(`  database: ${describeDatabaseTarget()} — ${describeDatabaseSsl()}`)
  console.log(`  redis:    ${describeRedisTarget()}`)
  console.log(`  trust proxy: ${trustProxySetting()}`)

  // ── Postgres, exactly as server.ts builds it ─────────────────────────────
  console.log('\n=== Postgres (runtime path) ===')
  const pool = new Pool({ connectionString: databaseUrl(), ssl: databaseSsl(), keepAlive: true })
  pool.on('error', () => {})
  try {
    const result = await pool.query('SELECT 1 as ok')
    check('pg pool connects', result.rows[0].ok === 1)

    // Is the wire actually encrypted? A local target must answer "no" and a
    // managed one "yes" — the distinction this whole fix is about.
    const ssl = await pool.query(
      "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
    )
    const encrypted = ssl.rows[0]?.ssl === true
    const wantEncrypted = databaseSsl() !== false
    check(
      `connection encryption matches policy (${encrypted ? 'encrypted' : 'plaintext'})`,
      encrypted === wantEncrypted,
    )

    // The precise call that returned P1010 in production.
    const prisma = new PrismaClient({ adapter: new PrismaPg(pool) })
    await prisma.user.findUnique({ where: { username: '__connection_probe_does_not_exist__' } })
    check('prisma.user.findUnique() — the call that raised P1010', true)
    const users = await prisma.user.count()
    check('prisma reads through the adapter', true, `${users} user account(s) visible`)
    await prisma.$disconnect()
  } catch (err) {
    const e = err as { code?: string; message?: string }
    check('postgres reachable', false, `code=${e.code ?? '-'} :: ${e.message?.split('\n')[0]}`)
    if (e.code === 'P1010' || e.code === '28000') {
      console.log('        → plaintext connection refused by pg_hba: TLS is not being applied.')
    }
  } finally {
    await pool.end().catch(() => {})
  }

  // ── Redis / BullMQ, exactly as server.ts builds it ───────────────────────
  console.log('\n=== Redis (BullMQ path) ===')
  const connection = redisConnectionOptions()
  // No colons — BullMQ reserves them as its own key separator.
  const queueName = `connectionProbe-${process.pid}-${Date.now()}`
  let queue: Queue | undefined
  let worker: Worker | undefined
  try {
    queue = new Queue(queueName, { connection })
    const processed = new Promise<string>((resolve, reject) => {
      worker = new Worker(queueName, async (job) => job.data.token as string, { connection })
      worker.on('completed', (_job, result) => resolve(result as string))
      worker.on('failed', (_job, err) => reject(err))
      setTimeout(() => reject(new Error('no job processed within 20s')), 20_000)
    })

    const token = `probe-${Date.now()}`
    await queue.add('probe', { token })
    check('bullmq enqueues a job', true)
    const result = await processed
    check('bullmq WORKER processes it', result === token, `round-tripped ${result}`)
  } catch (err) {
    const e = err as { code?: string; message?: string }
    check('redis reachable for bullmq', false, `code=${e.code ?? '-'} :: ${e.message}`)
    if (e.code === 'ECONNRESET') {
      console.log('        → reset before AUTH: a rediss:// endpoint needs TLS, which this connection is not using.')
    }
  } finally {
    // Leave nothing behind: the probe queue is removed entirely.
    await worker?.close().catch(() => {})
    await queue?.obliterate({ force: true }).catch(() => {})
    await queue?.close().catch(() => {})
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main()
