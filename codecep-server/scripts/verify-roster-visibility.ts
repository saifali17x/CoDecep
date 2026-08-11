/**
 * Live checks for the instructor session-visibility rules (2026-08-11):
 * the roster is members ∪ session-havers, and gap #71 phantom hiding survives.
 *
 *   npx tsx scripts/verify-roster-visibility.ts
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

const tag = makeTag('rv')
const withWindows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ flushedAt: Date.now() + i, codeSnapshot: 'int main(){}', events: [] }))

async function main() {
  const hash = await hashFixturePassword()
  // Every fixture is registered as deletable at creation; cleanup then removes
  // exactly these ids and can reach nothing else (gap #81).
  const instructor = await createFixtureUser(prisma, {
    username: `${tag}_inst`,
    role: 'INSTRUCTOR',
    passwordHash: hash,
  })
  const mk = (n: string) =>
    createFixtureUser(prisma, { username: `${tag}_${n}`, role: 'STUDENT', passwordHash: hash })
  const enrolled = await mk('enrolled')      // member, phantom + real session
  const dupe = await mk('dupe')              // member, TWO real sessions (gap #12 shape)
  const fresh = await mk('fresh')            // member, lone empty session
  const idle = await mk('idle')              // member, no session at all
  const outsider = await mk('outsider')      // NOT a member, has a real session

  const klass = await prisma.class.create({
    data: { name: `${tag}`, joinCode: tag.slice(-6).toUpperCase(), instructorId: instructor.id },
  })
  await prisma.classMembership.createMany({
    data: [enrolled, dupe, fresh, idle].map((u) => ({ userId: u.id, classId: klass.id })),
  })
  const assignment = await prisma.assignment.create({
    data: { classId: klass.id, title: `${tag} lab`, type: 'LIVE_LAB', week: 1 },
  })

  const session = (u: { id: string; username: string } | null, o: Record<string, unknown>) =>
    prisma.session.create({
      data: {
        studentId: u?.username ?? (o.studentId as string),
        ...(u ? { userId: u.id } : {}),
        assignmentId: assignment.id,
        status: 'IN_PROGRESS',
        tier1_log: [],
        ...o,
      },
    })

  const real = await session(enrolled, { status: 'SUBMITTED', playback_log: withWindows(5) })
  const phantom = await session(enrolled, {}) // 0 windows, created AFTER the real one
  const dupeA = await session(dupe, { playback_log: withWindows(2) })
  const dupeB = await session(dupe, { status: 'SUBMITTED', playback_log: withWindows(3) })
  const lone = await session(fresh, {})
  const outsiderSession = await session(outsider, { status: 'SUBMITTED', playback_log: withWindows(4) })
  // The oldest row shape: no userId at all, identity carried by studentId only.
  const legacy = await session(null, {
    studentId: `${tag}_legacyname`,
    status: 'SUBMITTED',
    playback_log: withWindows(2),
  })

  const h = { Authorization: `Bearer ${signToken({ userId: instructor.id, role: 'INSTRUCTOR' })}` }
  const list = await fetch(`${API}/api/assignments/${assignment.id}/sessions`, { headers: h }).then((r) => r.json())
  const roster = await fetch(`${API}/api/assignments/${assignment.id}/roster`, { headers: h }).then((r) => r.json())
  const ids = new Set(list.map((s: { id: string }) => s.id))
  const tile = (name: string) => roster.find((t: { username: string }) => t.username === name)

  console.log('\nGAP #71 PRESERVED — phantoms stay hidden, real sessions never do')
  check('the empty phantom is NOT listed', !ids.has(phantom.id))
  check('its real SUBMITTED sibling IS listed', ids.has(real.id))
  check('the roster tile points at the real session, not the phantom',
    tile(enrolled.username)?.sessionId === real.id)
  check('a LONE empty session is still listed (no real sibling)', ids.has(lone.id))
  check('its student still shows IN_PROGRESS, not NOT_STARTED',
    tile(fresh.username)?.status === 'IN_PROGRESS')
  check('BOTH rows of a real duplicate pair are listed (two forensic records)',
    ids.has(dupeA.id) && ids.has(dupeB.id))

  console.log('\nROSTER = MEMBERS ∪ SESSION-HAVERS')
  check('a member with no session still gets a NOT_STARTED tile',
    tile(idle.username)?.status === 'NOT_STARTED' && tile(idle.username)?.sessionId === null)
  check('a NON-member who sat the exam now appears', Boolean(tile(outsider.username)),
    tile(outsider.username) ? `sessionId ${String(tile(outsider.username).sessionId).slice(0, 8)}` : 'MISSING')
  check('their tile points at their session and is flagged not enrolled',
    tile(outsider.username)?.sessionId === outsiderSession.id && tile(outsider.username)?.enrolled === false)
  check('a member tile is flagged enrolled', tile(enrolled.username)?.enrolled === true)
  check('a legacy NULL-userId session appears under its studentId',
    tile(`${tag}_legacyname`)?.sessionId === legacy.id,
    JSON.stringify(tile(`${tag}_legacyname`) ?? null)?.slice(0, 80))
  check('a member with a duplicate pair gets ONE tile, not two',
    roster.filter((t: { username: string }) => t.username === dupe.username).length === 1)
  check('that tile resolves to the SUBMITTED row', tile(dupe.username)?.sessionId === dupeB.id)
  check('every roster username is unique (safe as a React key)',
    new Set(roster.map((t: { username: string }) => t.username)).size === roster.length,
    `${roster.length} tile(s)`)
  check('no student who has a session is missing from the roster',
    [enrolled, dupe, fresh, outsider].every((u) => tile(u.username)?.sessionId) &&
      Boolean(tile(`${tag}_legacyname`)?.sessionId))

  await prisma.session.deleteMany({ where: { assignmentId: assignment.id } })
  await prisma.assignment.delete({ where: { id: assignment.id } })
  await prisma.classMembership.deleteMany({ where: { classId: klass.id } })
  await prisma.class.delete({ where: { id: klass.id } })
  // BY ID, never by name pattern — see scripts/lib/harness.ts (gap #81).
  await deleteFixtureUsers(prisma, [instructor, enrolled, dupe, fresh, idle, outsider])

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
