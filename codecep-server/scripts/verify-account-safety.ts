/**
 * Regression guard for gap #81 — real user accounts must never be deleted by
 * test/seed/cleanup code. Run against a RUNNING server (npm run dev):
 *
 *   npx tsx scripts/verify-account-safety.ts
 *
 * The bug: a harness created fixture students named `stud_<timestamp>` and tore
 * them down with `user.deleteMany({ where: { username: { startsWith: 'stud' } } })`
 * against the real dev database. The user's own student_a / student_b /
 * student_c matched that prefix and were destroyed with them, repeatedly.
 *
 * Section 1 fires the hostile statements directly at the database and asserts
 * they are REFUSED. Section 2 then sits a full exam with a protected (non-
 * fixture) account, so "accounts are safe" and "the app still works" are proven
 * by the same run rather than argued separately.
 */
import { loadEnv } from '../src/env'
loadEnv()
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import { signToken } from '../src/auth'
import { createFixtureUser, deleteFixtureUsers, hashFixturePassword, makeTag } from './lib/harness'

const API = 'http://localhost:3001'
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) })

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const refused = async (fn: () => Promise<unknown>) => {
  try {
    await fn()
    return false
  } catch {
    return true
  }
}

const tag = makeTag('as')

async function main() {
  const hash = await hashFixturePassword()

  // A stand-in for one of the user's OWN accounts: created directly, NOT
  // registered as a harness fixture — exactly the status student_a has.
  const canary = await prisma.user.create({
    data: { username: `${tag}_canary`, passwordHash: hash, role: 'STUDENT' },
  })

  console.log('\n1. A REAL ACCOUNT CANNOT BE DELETED BY CLEANUP CODE')
  check(
    'the ORIGINAL bug — a prefix deleteMany on username is refused',
    await refused(() => prisma.user.deleteMany({ where: { username: { startsWith: tag } } }))
  )
  check(
    'a bare DELETE FROM users is refused',
    await refused(() => prisma.$executeRawUnsafe('DELETE FROM users'))
  )
  check(
    'deleting that one account by its own id is refused too',
    await refused(() => prisma.user.delete({ where: { id: canary.id } }))
  )
  check(
    'the account is still there afterwards',
    Boolean(await prisma.user.findUnique({ where: { id: canary.id } })),
    canary.username
  )
  const survivors = await prisma.user.count()
  check('and so is every other account', survivors > 1, `${survivors} accounts intact`)

  // A harness must still be able to clean up after ITSELF.
  const throwaway = await createFixtureUser(prisma, {
    username: `${tag}_fixture`,
    role: 'STUDENT',
    passwordHash: hash,
  })
  const removed = await deleteFixtureUsers(prisma, [throwaway])
  check('a registered fixture IS deletable, by id', removed === 1)
  check(
    'and its registry row goes with it',
    (await prisma.harnessFixtureUser.count({ where: { userId: throwaway.id } })) === 0
  )

  console.log('\n2. A PROTECTED ACCOUNT CAN STILL SIT A FULL EXAM')
  const instructor = await createFixtureUser(prisma, {
    username: `${tag}_inst`,
    role: 'INSTRUCTOR',
    passwordHash: hash,
  })
  const klass = await prisma.class.create({
    data: { name: `${tag} class`, joinCode: tag.slice(-6).toUpperCase(), instructorId: instructor.id },
  })
  await prisma.classMembership.create({ data: { userId: canary.id, classId: klass.id } })
  const assignment = await prisma.assignment.create({
    data: { classId: klass.id, title: `${tag} exam`, type: 'LIVE_LAB', week: 1 },
  })

  const stuToken = signToken({ userId: canary.id, role: 'STUDENT' })
  const instToken = signToken({ userId: instructor.id, role: 'INSTRUCTOR' })
  const post = (path: string, token: string, body: unknown) =>
    fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })

  const created = await post('/api/session/create', stuToken, {
    studentId: canary.username,
    userId: canary.id,
    assignmentId: assignment.id,
  }).then((r) => r.json())
  check('the student opens the exam', Boolean(created.sessionId), created.status)

  const code = '#include <iostream>\nint main(){ std::cout << 42; return 0; }'
  const ingest = await post('/api/telemetry/submit', stuToken, {
    sessionId: created.sessionId,
    // `chunk` is the ARRAY of events; the snapshots ride at top level.
    chunk: Array.from({ length: 40 }, (_, i) => ({
      timestamp: Date.now() + i * 90,
      actionType: 'type',
      charDelta: 1,
      textLength: i + 1,
      taskId: 'task1',
      fileName: 'main.cpp',
      timeSinceLastKeystrokeMs: 90,
    })),
    codeSnapshot: code,
    fileSnapshots: { 'main.cpp': code },
    taskSnapshots: { task1: { 'main.cpp': code } },
  })
  check('telemetry is ingested', ingest.status === 202, `HTTP ${ingest.status}`)

  const submitted = await post(`/api/session/${created.sessionId}/submit`, stuToken, {})
  check('the exam submits', submitted.status === 200, `HTTP ${submitted.status}`)

  // The forensics worker fires once on SUBMITTED; give it a moment to land.
  let forensics: unknown = null
  for (let i = 0; i < 20 && !forensics; i++) {
    await new Promise((r) => setTimeout(r, 500))
    forensics = (
      await prisma.session.findUnique({
        where: { id: created.sessionId },
        select: { forensicsResults: true },
      })
    )?.forensicsResults
  }
  check('forensics ran on it', Boolean(forensics), forensics ? 'stored' : 'still null after 10s')

  const list = await fetch(`${API}/api/assignments/${assignment.id}/sessions`, {
    headers: { Authorization: `Bearer ${instToken}` },
  }).then((r) => r.json())
  check(
    'the instructor sees the submitted session',
    list.some((s: { id: string; status: string }) => s.id === created.sessionId && s.status === 'SUBMITTED'),
    `${list.length} row(s)`
  )
  const roster = await fetch(`${API}/api/assignments/${assignment.id}/roster`, {
    headers: { Authorization: `Bearer ${instToken}` },
  }).then((r) => r.json())
  check(
    'and the student on the roster grid',
    roster.some((t: { username: string; status: string }) => t.username === canary.username && t.status === 'SUBMITTED')
  )

  check(
    'the account SURVIVED the whole run',
    Boolean(await prisma.user.findUnique({ where: { id: canary.id } }))
  )

  // ── Cleanup ─────────────────────────────────────────────────────────────
  await prisma.session.deleteMany({ where: { assignmentId: assignment.id } })
  await prisma.assignment.delete({ where: { id: assignment.id } })
  await prisma.classMembership.deleteMany({ where: { classId: klass.id } })
  await prisma.class.delete({ where: { id: klass.id } })
  await deleteFixtureUsers(prisma, [instructor])
  // The canary is deliberately NOT a fixture, so removing it takes the same
  // explicit, transaction-scoped opt-in a human would use on a real account.
  await prisma.$transaction([
    prisma.$executeRawUnsafe(`SET LOCAL codecep.allow_user_delete = 'on'`),
    prisma.$executeRaw`DELETE FROM users WHERE id = ${canary.id}`,
  ])

  console.log(`\n=== ${pass} passed, ${fail} failed ===`)
  await prisma.$disconnect()
  await pool.end()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})
