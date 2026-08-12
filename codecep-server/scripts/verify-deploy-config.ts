/**
 * Deploy-config regression guard (gap #61, 2026-08-12).
 *
 * The client's server URL and the server's allowed origins are now CONFIG, and
 * config is exactly the kind of thing that breaks silently: a wrong CORS origin
 * is not a server error, it is a browser-console failure with a clean server
 * log. This asserts the two halves still meet.
 *
 * Drives the exact endpoints the CLIENT calls, every request carrying the
 * browser `Origin` header the vite dev server produces, so the configurable
 * CORS rule is exercised the way a real page exercises it — not just by curl.
 *
 * Fixtures follow gap #81: created through scripts/lib/harness.ts (registered
 * in the same transaction) and deleted BY ID at the end. Nothing else is
 * removed.
 */
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import { loadEnv } from '../src/env'
import { signToken } from '../src/auth'
import { createFixtureUser, deleteFixtureUsers, hashFixturePassword, makeTag } from './lib/harness'

loadEnv()

const API = process.env.VERIFY_API ?? 'http://localhost:3001'
// The origin the "browser" claims. Default is the vite dev server (the
// two-origin dev shape); set VERIFY_ORIGIN to the API's own origin to exercise
// the SAME-ORIGIN single-app production shape instead.
const PROGRAM ='#include <iostream>\nint main(){ int a,b; std::cin>>a>>b; std::cout<<a+b; return 0; }'
const ORIGIN = process.env.VERIFY_ORIGIN ?? 'http://localhost:5173'

let passed = 0
let failed = 0
function check(ok: boolean, label: string, detail = '') {
  if (ok) { passed++; console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`) }
  else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}

/** Every call goes out with an Origin, exactly as the browser sends it. */
async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  const text = await res.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { res, body, allowOrigin: res.headers.get('access-control-allow-origin') }
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) })
  const tag = makeTag('dc')
  const created: { id: string }[] = []

  try {
    const hash = await hashFixturePassword()
    const instructor = await createFixtureUser(prisma, {
      username: `${tag}_inst`, role: 'INSTRUCTOR', passwordHash: hash, note: 'deploy-config check',
    })
    const student = await createFixtureUser(prisma, {
      username: `${tag}_stu`, role: 'STUDENT', passwordHash: hash, note: 'deploy-config check',
    })
    created.push(instructor, student)

    const klass = await prisma.class.create({
      data: { name: `${tag} class`, joinCode: tag.slice(-6).toUpperCase(), instructorId: instructor.id },
    })
    await prisma.classMembership.create({ data: { classId: klass.id, userId: student.id } })
    const assignment = await prisma.assignment.create({
      data: { classId: klass.id, title: `${tag} exam`, type: 'LIVE_LAB', week: 1, taskCount: 1 },
    })
    const stuToken = signToken({ userId: student.id, role: 'STUDENT' })
    const instToken = signToken({ userId: instructor.id, role: 'INSTRUCTOR' })
    const stuAuth = { Authorization: `Bearer ${stuToken}` }
    const instAuth = { Authorization: `Bearer ${instToken}` }

    console.log('\n1. THE CLIENT CAN REACH THE SERVER FROM ITS OWN ORIGIN')
    const assign = await call(`/api/assignments/${assignment.id}`, { headers: stuAuth })
    check(assign.res.status === 200, 'assignment loads (ExamPage first call)', `HTTP ${assign.res.status}`)
    check(assign.allowOrigin === ORIGIN, 'and the response is CORS-readable by the page', `allow-origin ${assign.allowOrigin}`)

    console.log('\n2. THE FULL EXAM PATH, EVERY CALL CROSS-ORIGIN')
    const create = await call('/api/session/create', {
      method: 'POST', headers: stuAuth,
      body: JSON.stringify({ studentId: student.username, assignmentId: assignment.id }),
    })
    const sessionId = create.body?.sessionId
    check(create.res.status === 200 && !!sessionId, 'session/create', `${create.body?.status}`)

    const ast = await call('/api/ast/validate', {
      method: 'POST', headers: stuAuth,
      body: JSON.stringify({ code: 'int main(){ return 0; }', assignmentId: assignment.id }),
    })
    check(ast.res.status === 200, 'ast/validate (EditorPane live check)', `isValid=${ast.body?.isValid}`)

    const telemetry = await call('/api/telemetry/submit', {
      method: 'POST', headers: stuAuth,
      // `chunk` is the ARRAY of events; the snapshots ride at TOP level.
      body: JSON.stringify({
        sessionId,
        chunk: Array.from({ length: 40 }, (_, i) => ({
          timestamp: Date.now() + i * 90, actionType: 'type', charDelta: 1, textLength: i + 1,
          taskId: 'task1', fileName: 'main.cpp', timeSinceLastKeystrokeMs: 90,
        })),
        codeSnapshot: PROGRAM,
        fileSnapshots: { 'main.cpp': PROGRAM },
        taskSnapshots: { task1: { 'main.cpp': PROGRAM } },
      }),
    })
    check(telemetry.res.status === 202, 'telemetry/submit', `HTTP ${telemetry.res.status}`)

    const exec = await call('/api/execute', {
      method: 'POST', headers: stuAuth,
      // `files` is an ARRAY of { name, content }.
      body: JSON.stringify({
        files: [{ name: 'main.cpp', content: PROGRAM }],
        stdin: '6\n7', sessionId, taskId: 'task1',
      }),
    })
    check(exec.res.status === 200, 'execute (Run Code → public Judge0)', `HTTP ${exec.res.status}`)
    check(String(exec.body?.stdout ?? '').trim() === '13', 'the program actually ran', `stdout="${String(exec.body?.stdout ?? '').trim()}"`)

    const submit = await call(`/api/session/${sessionId}/submit`, {
      method: 'POST', headers: stuAuth, body: JSON.stringify({}),
    })
    check(submit.res.status === 200, 'session submit', `HTTP ${submit.res.status}`)

    console.log('\n3. THE INSTRUCTOR SURFACES (DVR + review run)')
    await new Promise((r) => setTimeout(r, 3000)) // let the forensics worker finish
    const replay = await call(`/api/session/${sessionId}/replay`, { headers: instAuth })
    check(replay.res.status === 200, 'replay loads (DvrPlayer)', `HTTP ${replay.res.status}`)
    check(!!replay.body?.forensicsResults, 'forensics ran and is in the payload')

    const runIt = await call(`/api/sessions/${sessionId}/run`, {
      method: 'POST', headers: instAuth, body: JSON.stringify({ stdin: '2\n3' }),
    })
    check(runIt.res.status === 200, 'instructor review run', `HTTP ${runIt.res.status}`)

    console.log('\n4. CORS STILL REFUSES WHAT IT SHOULD')
    const evil = await fetch(`${API}/api/assignments/${assignment.id}`, {
      headers: { Origin: 'https://evil.example.com', ...stuAuth },
    })
    check(evil.status === 403, 'a foreign origin is refused even with a valid token', `HTTP ${evil.status}`)
    check(!evil.headers.get('access-control-allow-origin'), 'and gets no allow-origin header')

    await prisma.session.deleteMany({ where: { assignmentId: assignment.id } })
    await prisma.assignment.delete({ where: { id: assignment.id } })
    await prisma.classMembership.deleteMany({ where: { classId: klass.id } })
    await prisma.class.delete({ where: { id: klass.id } })
  } finally {
    await deleteFixtureUsers(prisma, created)
    await prisma.$disconnect()
    await pool.end()
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => { console.error(err); process.exit(1) })
