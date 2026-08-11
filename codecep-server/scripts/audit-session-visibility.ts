/**
 * Diagnostic: for EVERY assignment that has sessions, compare what the database
 * holds against what the instructor API returns — the decisive test for whether
 * the gap #71 resolution hides real sessions.
 *
 *   npx tsx scripts/audit-session-visibility.ts
 */
import { loadEnv } from '../src/env'
loadEnv()
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import { signToken } from '../src/auth'

const API = 'http://localhost:3001'
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) })

async function main() {
  const assignments = await prisma.assignment.findMany({ include: { class: true } })
  let hiddenReal = 0
  let hiddenPhantom = 0
  console.log(
    'class / assignment                          | db | api | roster | hidden'
  )
  console.log('-'.repeat(96))
  for (const a of assignments) {
    const db = await prisma.session.findMany({
      where: { assignmentId: a.id },
      select: { id: true, studentId: true, status: true, playback_log: true, userId: true },
    })
    if (db.length === 0) continue
    const token = signToken({ userId: a.class.instructorId, role: 'INSTRUCTOR' })
    const h = { Authorization: `Bearer ${token}` }
    const api = await fetch(`${API}/api/assignments/${a.id}/sessions`, { headers: h }).then((r) => r.json())
    const roster = await fetch(`${API}/api/assignments/${a.id}/roster`, { headers: h }).then((r) => r.json())
    const shown = new Set(api.map((s: { id: string }) => s.id))
    const missing = db.filter((s) => !shown.has(s.id))
    const missingReal = missing.filter(
      (s) => s.status === 'SUBMITTED' || (s.playback_log as unknown[]).length > 0
    )
    hiddenReal += missingReal.length
    hiddenPhantom += missing.length - missingReal.length
    const label = `${a.class.name} / ${a.title}`.slice(0, 42).padEnd(42)
    const rosterWith = roster.filter((r: { sessionId: string | null }) => r.sessionId).length
    console.log(
      `${label} | ${String(db.length).padStart(2)} | ${String(api.length).padStart(3)} |` +
        ` ${String(rosterWith).padStart(6)} | ${
          missing.length === 0
            ? '-'
            : missing
                .map(
                  (s) =>
                    `${s.id.slice(0, 8)}(${s.status[0]}${(s.playback_log as unknown[]).length}w)${
                      missingReal.includes(s) ? ' ** REAL **' : ' phantom'
                    }`
                )
                .join(', ')
        }`
    )
  }
  console.log('-'.repeat(96))
  console.log(`hidden REAL sessions: ${hiddenReal}   hidden phantoms: ${hiddenPhantom}`)
  console.log(hiddenReal === 0 ? 'VERDICT: no real session is hidden by the API.' : 'VERDICT: REGRESSION.')

  // Roster coverage: a student with a session who is NOT a class member.
  console.log('\nStudents holding a session for an assignment but NOT enrolled in its class:')
  const rows = await prisma.session.findMany({
    where: { assignmentId: { not: null } },
    select: { id: true, studentId: true, userId: true, assignment: { select: { classId: true, title: true } } },
  })
  let unenrolled = 0
  for (const s of rows) {
    const classId = s.assignment!.classId
    const member = s.userId
      ? await prisma.classMembership.findFirst({ where: { classId, userId: s.userId } })
      : await prisma.classMembership.findFirst({
          where: { classId, user: { username: s.studentId } },
        })
    if (!member) {
      unenrolled++
      console.log(`  ${s.studentId} (userId ${s.userId ? 'set' : 'NULL'}) — ${s.assignment!.title}`)
    }
  }
  console.log(`  → ${unenrolled} of ${rows.length} sessions belong to a non-member`)

  await prisma.$disconnect()
  await pool.end()
}
main()
