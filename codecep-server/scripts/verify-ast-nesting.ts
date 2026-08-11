/**
 * Live verification for the AST checker's nested-construct reporting (gap #67)
 * and for the Tier-1 raw alert log. Run against a RUNNING server (npm run dev):
 *
 *   npx tsx scripts/verify-ast-nesting.ts
 *
 * Covers three things the unit tests cannot:
 *   1. the LIVE route (`POST /api/ast/validate`) resolves a real class allowlist
 *      and reports the nested construct;
 *   2. the raw alert log actually RECORDS AST violations (it is fire-and-forget
 *      off the socket relay, so a silent failure there would be invisible);
 *   3. the submit-time audit's count matches the constructs it lists.
 *
 * Fixture accounts go through scripts/lib/harness.ts and are deleted BY ID
 * (gap #81) — this script never touches an account it did not create.
 */
import { loadEnv } from '../src/env'
loadEnv()
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import { signToken } from '../src/auth'
import { createFixtureUser, deleteFixtureUsers, hashFixturePassword, makeTag } from './lib/harness'

// socket.io-client lives only in the CLIENT's node_modules (CLAUDE.md §5).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { io } = require('/home/seezy/repos/CoDecep/codecep-client/node_modules/socket.io-client')

const API = 'http://localhost:3001'
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) })

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const tag = makeTag('ast')

// A forbidden class containing a forbidden loop — the gap #67 shape. Week 1
// teaches neither, so both are violations, at their own lines.
const CLASS_WITH_LOOP = `#include <iostream>
class Dog {
  public:
    void run() {
      for (int i = 0; i < 3; i++) { std::cout << i; }
    }
};
int main() { Dog d; d.run(); return 0; }
`

async function main() {
  const hash = await hashFixturePassword()
  const instructor = await createFixtureUser(prisma, {
    username: `${tag}_inst`,
    role: 'INSTRUCTOR',
    passwordHash: hash,
  })
  const student = await createFixtureUser(prisma, {
    username: `${tag}_stu`,
    role: 'STUDENT',
    passwordHash: hash,
  })
  const klass = await prisma.class.create({
    data: {
      name: `${tag} class`,
      joinCode: tag.slice(-6).toUpperCase(),
      instructorId: instructor.id,
      // A realistic week-1 list: cout/cin boilerplate only. Loops and classes
      // are NOT taught yet, which is exactly what makes both a violation.
      allowlist: { weeks: { week1: ['using_declaration', 'namespace_identifier'] } },
    },
  })
  const assignment = await prisma.assignment.create({
    data: { classId: klass.id, title: `${tag} exam`, type: 'LIVE_LAB', week: 1 },
  })
  const stuToken = signToken({ userId: student.id, role: 'STUDENT' })
  const instToken = signToken({ userId: instructor.id, role: 'INSTRUCTOR' })

  // ── 1. The LIVE route ───────────────────────────────────────────────────
  console.log('\n1. LIVE CHECK — POST /api/ast/validate against the class allowlist')
  const live = await fetch(`${API}/api/ast/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${stuToken}` },
    body: JSON.stringify({ code: CLASS_WITH_LOOP, assignmentId: assignment.id }),
  }).then((r) => r.json())
  const liveTypes = (live.violations ?? []).map((v: { nodeType: string }) => v.nodeType)
  check('the nested loop is reported ALONGSIDE the class',
    liveTypes.includes('class_specifier') && liveTypes.includes('for_statement'),
    liveTypes.join(', '))
  check('and its scaffolding is NOT',
    !liveTypes.includes('update_expression') && !liveTypes.includes('field_declaration_list'))
  check('exactly two findings', live.violations.length === 2, `${live.violations.length}`)
  check('the detail names both, with lines',
    /class_specifier \(line 2\)/.test(live.violationDetail) &&
      /for_statement \(line 5\)/.test(live.violationDetail),
    live.violationDetail)
  check('count == constructs listed',
    live.violationSummary.distinct === live.violationDetail.split(', ').length,
    `distinct ${live.violationSummary.distinct}`)

  // ── 2. The raw alert log ────────────────────────────────────────────────
  console.log('\n2. RAW ALERT LOG — the Tier-1 record actually stores AST violations')
  const created = await fetch(`${API}/api/session/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${stuToken}` },
    body: JSON.stringify({ studentId: student.username, userId: student.id, assignmentId: assignment.id }),
  }).then((r) => r.json())

  const socket = io(API, { transports: ['websocket'] })
  await new Promise<void>((resolve) => socket.on('connect', () => resolve()))
  // Exactly what EditorPane emits, once per distinct construct+line.
  for (const [node, line] of [['class_specifier', 2], ['for_statement', 5]] as const) {
    socket.emit('alert', {
      type: 'AST_VIOLATION',
      sessionId: created.sessionId,
      studentId: student.username,
      timestamp: Date.now(),
      detail: `Used ${node} (line ${line}) in main.cpp`,
    })
  }
  await new Promise((r) => setTimeout(r, 1200))
  const logged = (
    await prisma.session.findUnique({ where: { id: created.sessionId }, select: { tier1_log: true } })
  )?.tier1_log as { type: string; detail: string }[] | null
  const astEntries = (logged ?? []).filter((e) => e.type === 'AST_VIOLATION')
  check('both AST violations are recorded in the raw log', astEntries.length === 2, `${astEntries.length} entry(ies)`)
  check('each entry names its construct and line',
    astEntries.some((e) => /class_specifier \(line 2\)/.test(e.detail)) &&
      astEntries.some((e) => /for_statement \(line 5\)/.test(e.detail)),
    astEntries.map((e) => e.detail).join(' | '))
  socket.close()

  // ── 3. The submit-time audit ────────────────────────────────────────────
  console.log('\n3. SUBMIT AUDIT — the stored report, and live-vs-submit counts')
  await fetch(`${API}/api/telemetry/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${stuToken}` },
    body: JSON.stringify({
      sessionId: created.sessionId,
      chunk: Array.from({ length: 30 }, (_, i) => ({
        timestamp: Date.now() + i * 90,
        actionType: 'type',
        charDelta: 1,
        textLength: i + 1,
        taskId: 'task1',
        fileName: 'main.cpp',
        timeSinceLastKeystrokeMs: 90,
      })),
      codeSnapshot: CLASS_WITH_LOOP,
      fileSnapshots: { 'main.cpp': CLASS_WITH_LOOP },
      taskSnapshots: { task1: { 'main.cpp': CLASS_WITH_LOOP } },
    }),
  })
  await fetch(`${API}/api/session/${created.sessionId}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${stuToken}` },
    body: '{}',
  })

  let audit: { violations?: { nodeType: string; line: number }[]; violationCount?: number; reason?: string; flag?: boolean } | null = null
  for (let i = 0; i < 20 && !audit; i++) {
    await new Promise((r) => setTimeout(r, 500))
    const row = await prisma.session.findUnique({
      where: { id: created.sessionId },
      select: { forensicsResults: true },
    })
    audit = (row?.forensicsResults as { astAudit?: typeof audit })?.astAudit ?? null
  }
  const auditTypes = (audit?.violations ?? []).map((v) => v.nodeType)
  check('the submit audit reports BOTH constructs',
    auditTypes.includes('class_specifier') && auditTypes.includes('for_statement'), auditTypes.join(', '))
  check('violationCount equals the constructs listed', audit?.violationCount === 2, `count ${audit?.violationCount}`)
  check('the stored reason names both with lines',
    /class_specifier \(line 2\)/.test(audit?.reason ?? '') && /for_statement \(line 5\)/.test(audit?.reason ?? ''),
    (audit?.reason ?? '').slice(0, 90))
  check('the file is flagged', audit?.flag === true)

  const replay = await fetch(`${API}/api/session/${created.sessionId}/replay`, {
    headers: { Authorization: `Bearer ${instToken}` },
  }).then((r) => r.json())
  check('the instructor payload carries the live count separately from the audit',
    replay.tier1Summary.astViolation === 2 && (replay.forensicsResults.astAudit.violationCount ?? null) === 2,
    `live ${replay.tier1Summary.astViolation} / submit ${replay.forensicsResults.astAudit.violationCount}`)
  check('the raw alert timeline still holds both events',
    (replay.tier1Events ?? []).filter((e: { type: string }) => e.type === 'AST_VIOLATION').length === 2)

  // ── Cleanup (by id / exact scope only) ──────────────────────────────────
  await prisma.session.deleteMany({ where: { assignmentId: assignment.id } })
  await prisma.assignment.delete({ where: { id: assignment.id } })
  await prisma.class.delete({ where: { id: klass.id } })
  await deleteFixtureUsers(prisma, [instructor, student])

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
