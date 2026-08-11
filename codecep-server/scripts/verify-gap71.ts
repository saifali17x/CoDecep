/**
 * Live verification for gap #71 — run against a RUNNING server (npm run dev).
 *
 *   npx tsx scripts/verify-gap71.ts
 *
 * Seeds through Prisma and signs JWTs directly (the auth rate limiter, 10 per
 * 15 min per IP, would stop a repeated suite dead — see CLAUDE.md §5).
 */
import { loadEnv } from '../src/env'
loadEnv()
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import bcrypt from 'bcryptjs'
import { signToken } from '../src/auth'

const API = 'http://localhost:3001'
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) })

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass++
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const tag = `g71_${Date.now()}`

async function main() {
  // ── Seed ────────────────────────────────────────────────────────────────
  const hash = await bcrypt.hash('Passw0rd123', 12)
  const instructor = await prisma.user.create({
    data: { username: `${tag}_inst`, passwordHash: hash, role: 'INSTRUCTOR' },
  })
  const student = await prisma.user.create({
    data: { username: `${tag}_stu`, passwordHash: hash, role: 'STUDENT' },
  })
  const student2 = await prisma.user.create({
    data: { username: `${tag}_stu2`, passwordHash: hash, role: 'STUDENT' },
  })
  const klass = await prisma.class.create({
    data: { name: `${tag} class`, joinCode: tag.slice(-6).toUpperCase(), instructorId: instructor.id },
  })
  await prisma.classMembership.createMany({
    data: [
      { userId: student.id, classId: klass.id },
      { userId: student2.id, classId: klass.id },
    ],
  })
  const assignment = await prisma.assignment.create({
    data: { classId: klass.id, title: `${tag} exam`, type: 'LIVE_LAB', week: 1 },
  })
  const assignment2 = await prisma.assignment.create({
    data: { classId: klass.id, title: `${tag} exam 2`, type: 'LIVE_LAB', week: 1 },
  })
  const stuToken = signToken({ userId: student.id, role: 'STUDENT' })
  const stu2Token = signToken({ userId: student2.id, role: 'STUDENT' })
  const instToken = signToken({ userId: instructor.id, role: 'INSTRUCTOR' })

  const createSession = (token: string, body: unknown) =>
    fetch(`${API}/api/session/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() }))

  const rowsFor = (studentId: string, assignmentId: string | null) =>
    prisma.session.findMany({
      where: { studentId, assignmentId },
      orderBy: { createdAt: 'asc' },
    })

  // ── 1. Race safety ──────────────────────────────────────────────────────
  console.log('\n1. RACE SAFETY — concurrent creates collapse to one row')
  const body = { studentId: student.username, userId: student.id, assignmentId: assignment.id }
  const pair = await Promise.all([createSession(stuToken, body), createSession(stuToken, body)])
  const after2 = await rowsFor(student.username, assignment.id)
  check('two simultaneous creates → exactly ONE row', after2.length === 1, `${after2.length} row(s)`)
  check(
    'both responses name the same session',
    pair[0].body.sessionId === pair[1].body.sessionId && pair[0].body.sessionId === after2[0]?.id,
    `${pair[0].body.sessionId} / ${pair[1].body.sessionId}`
  )
  check(
    'exactly one CREATED, the loser RESUMED',
    pair.filter((r) => r.body.status === 'CREATED').length === 1 &&
      pair.filter((r) => r.body.status === 'RESUMED').length === 1,
    pair.map((r) => r.body.status).join(' + ')
  )

  const burst = await Promise.all(
    Array.from({ length: 8 }, () =>
      createSession(stu2Token, {
        studentId: student2.username,
        userId: student2.id,
        assignmentId: assignment2.id,
      })
    )
  )
  const after8 = await rowsFor(student2.username, assignment2.id)
  check('eight simultaneous creates → exactly ONE row', after8.length === 1, `${after8.length} row(s)`)
  check(
    'all eight responses name that one row',
    burst.every((r) => r.body.sessionId === after8[0]?.id),
    `${new Set(burst.map((r) => r.body.sessionId)).size} distinct id(s)`
  )

  // Different students must NOT serialize behind each other.
  const t0 = Date.now()
  await Promise.all([
    createSession(stuToken, body),
    createSession(stu2Token, {
      studentId: student2.username,
      userId: student2.id,
      assignmentId: assignment2.id,
    }),
  ])
  check('concurrent creates for DIFFERENT students are not blocked', Date.now() - t0 < 2000, `${Date.now() - t0}ms`)

  // ── 2. Resolution prefers the real session ──────────────────────────────
  console.log('\n2. RESOLUTION — the real session wins over an empty phantom')
  const realId = after2[0].id
  // Give the real row telemetry, then hand-write a phantom NEWER than it — the
  // exact shape the double-mount produced.
  await prisma.$executeRaw`
    UPDATE sessions
    SET playback_log = ${JSON.stringify([
      { flushedAt: Date.now(), codeSnapshot: 'int main(){}', events: [] },
    ])}::jsonb
    WHERE id = ${realId}`
  const phantom = await prisma.session.create({
    data: {
      studentId: student.username,
      userId: student.id,
      assignmentId: assignment.id,
      status: 'IN_PROGRESS',
      tier1_log: [],
    },
  })

  const resumed = await createSession(stuToken, body)
  check(
    'session/create RESUMES the row holding the telemetry, not the newer phantom',
    resumed.body.sessionId === realId,
    `${resumed.body.sessionId === realId ? 'real' : 'phantom'} (${resumed.body.status})`
  )

  const listed = await fetch(`${API}/api/assignments/${assignment.id}/sessions`, {
    headers: { Authorization: `Bearer ${instToken}` },
  }).then((r) => r.json())
  check(
    'instructor session list shows the real row only',
    listed.length === 1 && listed[0].id === realId,
    `${listed.length} row(s): ${listed.map((s: { id: string }) => (s.id === realId ? 'real' : 'phantom')).join(',')}`
  )

  const roster = await fetch(`${API}/api/assignments/${assignment.id}/roster`, {
    headers: { Authorization: `Bearer ${instToken}` },
  }).then((r) => r.json())
  const tile = roster.find((r: { username: string }) => r.username === student.username)
  check('roster tile points at the real session', tile?.sessionId === realId, tile?.sessionId)

  const classList = await fetch(`${API}/api/classes/${klass.id}/sessions`, {
    headers: { Authorization: `Bearer ${instToken}` },
  }).then((r) => r.json())
  check(
    'class-level session list hides the phantom',
    !classList.some((s: { id: string }) => s.id === phantom.id),
    `${classList.length} row(s)`
  )

  // A SUBMITTED real row beside the phantom — the pair that made a submitted
  // exam look like it had recorded nothing.
  await prisma.session.update({ where: { id: realId }, data: { status: 'SUBMITTED' } })
  const reopened = await createSession(stuToken, body)
  check(
    'a submitted pair reports ALREADY_SUBMITTED on the REAL row',
    reopened.body.status === 'ALREADY_SUBMITTED' && reopened.body.sessionId === realId,
    `${reopened.body.status} / ${reopened.body.sessionId === realId ? 'real' : 'phantom'}`
  )
  const listed2 = await fetch(`${API}/api/assignments/${assignment.id}/sessions`, {
    headers: { Authorization: `Bearer ${instToken}` },
  }).then((r) => r.json())
  check(
    'instructor sees the SUBMITTED session with its data, not the phantom',
    listed2.length === 1 && listed2[0].id === realId && listed2[0].status === 'SUBMITTED',
    JSON.stringify(listed2.map((s: { status: string }) => s.status))
  )

  // ── 3. A LONE fresh empty session is never hidden ────────────────────────
  console.log('\n3. SAFETY — a student who has just opened the exam is still visible')
  const fresh = await createSession(stu2Token, {
    studentId: student2.username,
    userId: student2.id,
    assignmentId: assignment.id,
  })
  const listed3 = await fetch(`${API}/api/assignments/${assignment.id}/sessions`, {
    headers: { Authorization: `Bearer ${instToken}` },
  }).then((r) => r.json())
  check(
    'a lone 0-window session is listed (no real sibling to prove it a duplicate)',
    listed3.some((s: { id: string }) => s.id === fresh.body.sessionId),
    `${listed3.length} row(s)`
  )
  const roster3 = await fetch(`${API}/api/assignments/${assignment.id}/roster`, {
    headers: { Authorization: `Bearer ${instToken}` },
  }).then((r) => r.json())
  check(
    'that student shows IN_PROGRESS on the grid, not NOT_STARTED',
    roster3.find((r: { username: string }) => r.username === student2.username)?.status === 'IN_PROGRESS'
  )

  // ── 4. Regression: /legacy and the ingest path ───────────────────────────
  console.log('\n4. REGRESSION — /legacy and telemetry ingest')
  const legacyId = `${tag}_legacy`
  const l1 = await fetch(`${API}/api/session/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ studentId: legacyId }),
  }).then((r) => r.json())
  const l2 = await fetch(`${API}/api/session/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ studentId: legacyId }),
  }).then((r) => r.json())
  check('/legacy (no token, no assignment) creates then RESUMES its own row',
    l1.status === 'CREATED' && l2.status === 'RESUMED' && l1.sessionId === l2.sessionId,
    `${l1.status} → ${l2.status}`)
  const legacyRows = await rowsFor(legacyId, null)
  check('/legacy left exactly one row', legacyRows.length === 1, `${legacyRows.length}`)

  const ingest = await fetch(`${API}/api/telemetry/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: l1.sessionId,
      studentId: legacyId,
      chunk: [
        { timestamp: Date.now(), actionType: 'type', charDelta: 1, textLength: 1, timeSinceLastKeystrokeMs: 120 },
      ],
      codeSnapshot: 'int main(){}',
    }),
  })
  const legacyAfter = await rowsFor(legacyId, null)
  check(
    'telemetry appends to that one session',
    ingest.status === 202 && (legacyAfter[0].playback_log as unknown[]).length === 1,
    `HTTP ${ingest.status}, ${(legacyAfter[0].playback_log as unknown[]).length} window(s)`
  )

  // The /legacy bucket must stay separate from a real assignment's.
  const legacyBleed = await prisma.session.findMany({
    where: { studentId: legacyId, assignmentId: { not: null } },
  })
  check('a /legacy row never adopts a real assignment', legacyBleed.length === 0)

  // ── Cleanup of this run's fixtures ──────────────────────────────────────
  await prisma.session.deleteMany({ where: { studentId: { startsWith: tag } } })
  await prisma.assignment.deleteMany({ where: { classId: klass.id } })
  await prisma.classMembership.deleteMany({ where: { classId: klass.id } })
  await prisma.class.delete({ where: { id: klass.id } })
  await prisma.user.deleteMany({ where: { username: { startsWith: tag } } })

  console.log(`\n=== ${pass} passed, ${fail} failed ===`)
  await prisma.$disconnect()
  await pool.end()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (err) => {
  console.error(err)
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})
