import express, { Request, Response } from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import { createServer } from 'http'
import { Server as SocketServer } from 'socket.io'
import { Queue, Worker } from 'bullmq'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import bcrypt from 'bcryptjs'
import multer from 'multer'
import rateLimit from 'express-rate-limit'
import { PDFParse } from 'pdf-parse'
import { validateAST } from './ast/parser'
import { computeMetricA, computeLinearInjection, computeRoboticVariance } from './forensics/metrics'
import { signToken, requireAuth, requireRole } from './auth'
import { parseSyllabusToAllowlist } from './gemini'
import {
  validate,
  registerSchema,
  loginSchema,
  createClassSchema,
  joinClassSchema,
  createAssignmentSchema,
  astValidateSchema,
  sessionCreateSchema,
  telemetrySubmitSchema,
} from './validation'

dotenv.config()

const app = express()
const PORT = process.env.PORT ?? 3001

// ── Debug logging gate ─────────────────────────────────────────────────────
// Per-request traces ([SESSION]/[INGEST]/[AST]/[EXECUTE]/[RELAY]/[SOCKET])
// only print with DEBUG=true. Operational logs (startup, [FORENSICS],
// [GEMINI], [AUTH], [CLASS], [ASSIGNMENT], [ERROR]) always print.
const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1'
function debugLog(...args: unknown[]) {
  if (DEBUG) console.log(...args)
}

// ── DB retry helper (Neon serverless drops idle connections) ──────────────
// Retries Prisma calls on connection-level errors only, with light backoff.
// Used ONLY on the exam hot paths (session create, telemetry ingest, submit)
// where a transient drop would harm an exam in progress.
const TRANSIENT_CODES = [
  'P1001', 'P1002', 'P1008', 'P1017', 'P2024', // Prisma connection/pool codes
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', // raw socket codes
  '57P01', // postgres admin_shutdown (Neon killing a pooled connection)
]
const TRANSIENT_MESSAGE = /connection|closed|terminated|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|timeout/i

function isTransientDbError(err: unknown): boolean {
  // Prisma driver-adapter errors wrap the underlying pg error — walk the
  // cause chain so the real connection error is seen wherever it hides.
  let current: unknown = err
  for (let depth = 0; depth < 5 && current; depth++) {
    const code = (current as { code?: string }).code
    if (code && TRANSIENT_CODES.includes(code)) return true
    const message = current instanceof Error ? current.message : typeof current === 'string' ? current : ''
    if (TRANSIENT_MESSAGE.test(message)) return true
    const meta = (current as { meta?: { message?: unknown } }).meta
    if (typeof meta?.message === 'string' && TRANSIENT_MESSAGE.test(meta.message)) return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 150): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!isTransientDbError(err) || attempt === attempts - 1) throw err
      await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** attempt))
    }
  }
  throw lastErr
}

// ── Auth rate limiter (register + login ONLY) ─────────────────────────────
// Telemetry/session/AST routes are never rate-limited — a real exam produces
// many rapid calls.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later' },
})

// ── Parse REDIS_URL into plain host/port options ───────────────────────────
const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379')
const redisConnection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port) || 6379,
}

// ── Prisma 7 client (adapter-pg pattern) ──────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL, keepAlive: true })
// Neon kills idle pooled connections; without this listener an idle-client
// 'error' event would crash the whole process.
pool.on('error', (err) => console.error('[DB] idle client error:', err.message))
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

// ── BullMQ queue ───────────────────────────────────────────────────────────
const telemetryQueue = new Queue('telemetryQueue', { connection: redisConnection })

// ── BullMQ forensics worker (Phase 5 — fires ONCE per submission) ─────────
// Constraint 2: this worker is NEVER in the ingest path. It only runs after
// POST /api/session/:id/submit transitions the session to SUBMITTED.
const forensicsWorker = new Worker(
  'telemetryQueue',
  async (job) => {
    const { sessionId } = job.data as { sessionId: string }
    console.log(`[FORENSICS] Processing session ${sessionId}`)

    const session = await prisma.session.findUnique({ where: { id: sessionId } })
    if (!session) {
      console.error(`[FORENSICS] Session ${sessionId} not found — skipping`)
      return
    }

    const runCount = session.runCount ?? 0
    const metricA = computeMetricA(runCount)
    const metricB = computeLinearInjection(session.playback_log)
    const metricC = computeRoboticVariance(session.burst_history)

    await prisma.session.update({
      where: { id: sessionId },
      data: { forensicsResults: { metricA, metricB, metricC } },
    })

    console.log(`[FORENSICS] Session ${sessionId} processed — metricA runCount=${runCount} flag=${metricA.flag}`)
    console.log(`[FORENSICS] session ${sessionId} metricB flag=${metricB.flag} deleteRatio=${metricB.stats.deleteRatio.toFixed(3)} singleCharRatio=${metricB.stats.singleCharTypeRatio.toFixed(3)}`)
    console.log(`[FORENSICS] session ${sessionId} metricC flag=${metricC.flag} cv=${metricC.stats.cv} sampleCount=${metricC.stats.sampleCount}`)
  },
  { connection: redisConnection },
)

forensicsWorker.on('failed', (job, err) => {
  console.error(`[FORENSICS] Job ${job?.id} failed:`, err.message)
})

// ── Express setup ──────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || origin.startsWith('http://localhost')) {
      callback(null, true)
    } else {
      callback(new Error('CORS: origin not allowed'))
    }
  },
}))

app.use(express.json())

// ── POST /api/session/create ──────────────────────────────────────────────
app.post('/api/session/create', validate(sessionCreateSchema), async (req: Request, res: Response) => {
  const { studentId, userId, assignmentId } = req.body

  try {
    const existing = await withRetry(() =>
      prisma.session.findFirst({ where: { studentId, status: 'IN_PROGRESS' } })
    )
    if (existing) {
      debugLog(`[SESSION] Returning existing session ${existing.id} for ${studentId}`)
      res.json({ sessionId: existing.id })
      return
    }

    const session = await withRetry(() =>
      prisma.session.create({
        data: {
          studentId,
          status: 'IN_PROGRESS',
          // Backward compatible: the hardcoded student-001 dev flow sends neither.
          ...(typeof userId === 'string' && userId.length > 0 ? { userId } : {}),
          ...(typeof assignmentId === 'string' && assignmentId.length > 0 ? { assignmentId } : {}),
        },
      })
    )
    debugLog(`[SESSION] Created new session ${session.id} for ${studentId}`)
    res.json({ sessionId: session.id })
  } catch (err) {
    if (isTransientDbError(err)) {
      res.status(503).json({ error: 'Service temporarily unavailable, please retry' })
      return
    }
    throw err
  }
})

// ── POST /api/telemetry/submit ─────────────────────────────────────────────
interface KeystrokeEvent {
  timestamp: number
  timeSinceLastKeystrokeMs: number
  actionType: 'type' | 'paste' | 'delete'
  charDelta: number
  textLength: number
}

app.post('/api/telemetry/submit', validate(telemetrySubmitSchema), async (req: Request, res: Response) => {
  const { sessionId, chunk, codeSnapshot, engagedTimeMs } = req.body

  if (!Array.isArray(chunk) || chunk.length === 0) {
    res.status(400).json({ error: 'Invalid payload: sessionId and non-empty chunk are required.' })
    return
  }

  const events: KeystrokeEvent[] = chunk

  const playbackEntry = {
    flushedAt: Date.now(),
    codeSnapshot: codeSnapshot ?? '',
    events,
  }

  const deltas = events.map((e) => e.timeSinceLastKeystrokeMs).filter((d) => d > 0)
  const mean = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0
  const burstEntry = {
    flushedAt: Date.now(),
    eventCount: events.length,
    meanTimeBetweenKeystrokes: Math.round(mean),
    pasteCount: events.filter((e) => e.actionType === 'paste').length,
    deleteCount: events.filter((e) => e.actionType === 'delete').length,
    totalCharDelta: events.reduce((sum, e) => sum + e.charDelta, 0),
    engagedTimeMs: typeof engagedTimeMs === 'number' ? Math.round(engagedTimeMs) : null,
  }

  try {
    await withRetry(() => prisma.$executeRaw`
      UPDATE sessions
      SET playback_log  = playback_log  || ${JSON.stringify([playbackEntry])}::jsonb,
          burst_history = burst_history || ${JSON.stringify([burstEntry])}::jsonb,
          "updatedAt"   = NOW()
      WHERE id = ${sessionId}
    `)
  } catch (err) {
    if (isTransientDbError(err)) {
      res.status(503).json({ error: 'Service temporarily unavailable, please retry' })
      return
    }
    throw err
  }

  debugLog(`[INGEST] session=${sessionId} +${events.length} events appended`)
  res.status(202).json({ accepted: events.length })
})

// ── POST /api/session/:id/submit ──────────────────────────────────────────
app.post('/api/session/:id/submit', async (req: Request, res: Response) => {
  const sessionId = String(req.params.id)
  try {
    const session = await withRetry(() =>
      prisma.session.update({
        where: { id: sessionId, status: 'IN_PROGRESS' },
        data: { status: 'SUBMITTED' },
      })
    )
    await telemetryQueue.add('forensics', { sessionId: session.id })
    console.log(`[SUBMIT] Session ${session.id} → SUBMITTED, forensics job enqueued`)
    res.status(200).json({ status: 'SUBMITTED' })
  } catch (err) {
    // P2025 = no IN_PROGRESS row matched — the true idempotency case.
    if ((err as { code?: string } | null)?.code === 'P2025') {
      res.status(200).json({ status: 'ALREADY_SUBMITTED' })
      return
    }
    if (isTransientDbError(err)) {
      res.status(503).json({ error: 'Service temporarily unavailable, please retry' })
      return
    }
    throw err
  }
})

// ── GET /api/session/:id/playback ─────────────────────────────────────────
// DVR playback reader (Phase 4.2/4.3). Pure reader of existing JSONB — returns
// one codeSnapshot + metadata per 30s flush, never the raw events arrays.
// TODO: requireAuth + requireRole('INSTRUCTOR') — unprotected in dev to match
// the tokenless /dashboard flow; lock down in the hardening pass.
app.get('/api/session/:id/playback', async (req: Request, res: Response) => {
  const sessionId = String(req.params.id)

  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  if (!session) {
    res.status(404).json({ error: 'Session not found' })
    return
  }

  const playbackLog = Array.isArray(session.playback_log) ? session.playback_log : []

  res.status(200).json({
    sessionId: session.id,
    studentId: session.studentId,
    status: session.status,
    snapshotCount: playbackLog.length,
    forensicsResults: session.forensicsResults, // null until submitted + worker runs
    snapshots: playbackLog.map((entry: any) => ({
      flushedAt: entry.flushedAt,
      codeSnapshot: entry.codeSnapshot,
      eventCount: entry.events?.length ?? 0,
    })),
  })
})

// ── GET /api/session/:id/replay ────────────────────────────────────────────
// Session 19 keystroke replay: full reconstruction data — snapshots (sync
// anchors) plus the FLATTENED, in-order keystroke events. Instructor-only;
// ownership-checked via the session's assignment→class when linked (legacy
// sessions with no assignment are dev data — instructor role suffices).
// Events can be large; that's fine — replay is an on-demand instructor
// action, never a hot path.
app.get(
  '/api/session/:id/replay',
  requireAuth,
  requireRole('INSTRUCTOR'),
  async (req: Request, res: Response) => {
    const session = await prisma.session.findUnique({
      where: { id: String(req.params.id) },
      include: { assignment: { include: { class: true } } },
    })
    if (!session) {
      res.status(404).json({ error: 'Session not found' })
      return
    }
    if (session.assignment && session.assignment.class.instructorId !== req.user!.userId) {
      res.status(403).json({ error: 'You do not own this class.' })
      return
    }

    const log = Array.isArray(session.playback_log) ? (session.playback_log as any[]) : []
    // eventCount per snapshot lets the replay engine partition the flattened
    // events back into flush windows without relying on clock comparisons.
    const snapshots = log.map((entry) => ({
      flushedAt: entry.flushedAt,
      codeSnapshot: entry.codeSnapshot ?? '',
      eventCount: Array.isArray(entry.events) ? entry.events.length : 0,
    }))
    const events = log.flatMap((entry) => (Array.isArray(entry.events) ? entry.events : []))

    res.json({
      sessionId: session.id,
      studentId: session.studentId,
      status: session.status,
      forensicsResults: session.forensicsResults,
      startedAt: events[0]?.timestamp ?? session.createdAt.getTime(),
      endedAt: events[events.length - 1]?.timestamp ?? session.updatedAt.getTime(),
      snapshots,
      events,
    })
  }
)

// ── POST /api/ast/validate ─────────────────────────────────────────────────
// Baseline C++ node types every minimal valid program contains. Control-flow
// constructs (for_statement / while_statement / do_statement) are deliberately
// ABSENT — they must still flag. ERROR/MISSING are not listed: the walker in
// ast/parser.ts drops them so mid-typing parse states never raise violations.
const week1Allowlist = [
  // Structural / translation unit
  'translation_unit',
  'preproc_include',      // #include
  'preproc_arg',
  'system_lib_string',    // <iostream>
  'string_literal',       // "..."
  'string_content',       // text inside a string_literal
  'escape_sequence',      // "\n" inside a string_literal
  'using_declaration',    // using namespace std;
  'namespace_identifier',
  'qualified_identifier', // std::cout

  // Function structure
  'function_definition',
  'function_declarator',
  'primitive_type',       // int, void, char, ...
  'type_identifier',      // string, and other non-primitive type names
  'compound_statement',   // { ... }
  'parameter_list',

  // Basic statements & expressions (cout / cin / return / assignment)
  'declaration',
  'init_declarator',
  'expression_statement',
  'return_statement',
  'identifier',
  'number_literal',
  'char_literal',
  'character',            // the char inside a char_literal
  'binary_expression',    // << chaining and arithmetic
  'assignment_expression',
  'call_expression',
  'argument_list',
  'field_expression',
  'field_identifier',     // the member name in a field_expression
]

// Given the CLASS's { weeks: {...} } allowlist, pick the list for an
// assignment's week. Falls back to the highest available week <= that week,
// else null (caller then uses the hardcoded week1Allowlist).
// Weeks are generated CUMULATIVE by the Gemini prompt (week N includes 1..N),
// so a single week lookup already yields the cumulative construct set.
function resolveWeekAllowlist(
  allowlist: unknown,
  assignmentWeek: number,
): string[] | null {
  const weeks = (allowlist as { weeks?: Record<string, unknown> } | null)?.weeks
  if (!weeks || typeof weeks !== 'object') return null

  const exact = weeks[`week${assignmentWeek}`]
  if (Array.isArray(exact) && exact.every((x) => typeof x === 'string')) {
    return exact as string[]
  }

  let bestWeek = -1
  let bestList: string[] | null = null
  for (const [key, list] of Object.entries(weeks)) {
    const match = /^week(\d+)$/.exec(key)
    if (!match) continue
    const n = Number(match[1])
    if (n <= assignmentWeek && n > bestWeek &&
        Array.isArray(list) && list.every((x) => typeof x === 'string')) {
      bestWeek = n
      bestList = list as string[]
    }
  }
  return bestList
}

app.post('/api/ast/validate', validate(astValidateSchema), async (req: Request, res: Response) => {
  const { code, assignmentId } = req.body

  if (typeof code !== 'string' || code.trim().length === 0) {
    res.status(400).json({ error: 'Request body must contain a non-empty "code" string.' })
    return
  }

  // CLASS-level allowlist looked up by the assignment's week (Session 20 —
  // the syllabus belongs to the course, not to one assignment). Falls back to
  // the hardcoded week1Allowlist when there is no assignment / the class has
  // no syllabus yet — keeps the /legacy dev flow byte-for-byte compatible.
  // Failures here must never break validation, so lookup errors degrade too.
  let allowlist = week1Allowlist
  let allowlistSource = 'default'
  if (typeof assignmentId === 'string' && assignmentId.length > 0) {
    try {
      const assignment = await prisma.assignment.findUnique({
        where: { id: assignmentId },
        include: { class: true },
      })
      if (assignment?.class?.allowlist) {
        const resolved = resolveWeekAllowlist(assignment.class.allowlist, assignment.week)
        if (resolved) {
          allowlist = resolved
          allowlistSource = `class allowlist week${assignment.week}`
        }
      }
    } catch (err) {
      console.error('[AST] Allowlist lookup failed — using default:', err instanceof Error ? err.message : err)
    }
  }

  const result = await validateAST(code, allowlist)
  debugLog(`[AST] Validated ${result.violations.length} violation(s) — isValid: ${result.isValid} (allowlist: ${allowlistSource})`)
  res.status(200).json(result)
})

// ── POST /api/execute ─────────────────────────────────────────────────────
// Judge0 is a SUBMISSION model: source + all stdin go up together and the
// program runs to completion. That is why the exam console takes batch stdin
// (Session 21) — a reactive TTY would need a persistent sandboxed VM per
// student, which is out of scope. Returns the Judge0 streams SEPARATELY so the
// client console can style stdout / stderr / compile output distinctly.
const STDIN_MAX_CHARS = 100_000

app.post('/api/execute', async (req: Request, res: Response) => {
  const { code, lang, sessionId, stdin } = req.body

  if (typeof code !== 'string' || code.trim().length === 0) {
    res.status(400).json({ error: 'Request body must contain a non-empty "code" string.' })
    return
  }
  if (stdin !== undefined && typeof stdin !== 'string') {
    res.status(400).json({ error: '"stdin" must be a string when present.' })
    return
  }
  if (typeof stdin === 'string' && stdin.length > STDIN_MAX_CHARS) {
    res.status(400).json({ error: `"stdin" exceeds ${STDIN_MAX_CHARS} characters.` })
    return
  }

  const languageId = lang === 'c' ? 50 : 54

  try {
    // base64_encoded=true is REQUIRED, not cosmetic: g++ diagnostics contain
    // bytes Judge0 cannot round-trip as plain UTF-8, and the plain-text mode
    // answers 400 for exactly the compile errors students most need to see.
    const judge0Res = await fetch(
      'https://ce.judge0.com/submissions?base64_encoded=true&wait=true',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_code: Buffer.from(code, 'utf8').toString('base64'),
          language_id: languageId,
          // Judge0 feeds these lines to the program's cin/scanf reads in order.
          ...(typeof stdin === 'string' && stdin.length > 0
            ? { stdin: Buffer.from(stdin, 'utf8').toString('base64') }
            : {}),
        }),
      }
    )

    if (!judge0Res.ok) {
      const message = `Judge0 error — HTTP ${judge0Res.status}. Try again shortly.`
      res.status(502).json({ output: message, stderr: message, status: 'Execution service error' })
      return
    }

    const raw = await judge0Res.json() as {
      stdout?: string | null
      stderr?: string | null
      compile_output?: string | null
      message?: string | null
      time?: string | null
      memory?: number | null
      exit_code?: number | null
      status?: { id?: number; description?: string } | null
    }

    const decode = (b64: string | null | undefined): string =>
      typeof b64 === 'string' && b64.length > 0
        ? Buffer.from(b64, 'base64').toString('utf8')
        : ''

    const data = {
      ...raw,
      stdout: decode(raw.stdout),
      stderr: decode(raw.stderr),
      compile_output: decode(raw.compile_output),
      message: decode(raw.message),
    }

    // Legacy single-string field kept for backward compatibility.
    const output = data.compile_output || data.stderr || data.stdout || '(no output)'
    debugLog(
      `[EXECUTE] lang=${lang ?? 'cpp'} id=${languageId} stdin=${typeof stdin === 'string' ? stdin.length : 0}ch ` +
      `→ status=${data.status?.description ?? 'unknown'}`
    )

    // Increment runCount so Metric A has an accurate compile count
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      await prisma.session.update({
        where: { id: sessionId },
        data: { runCount: { increment: 1 } },
      }).catch(() => { /* session may not exist in tests — silently ignore */ })
    }

    res.status(200).json({
      output: output.trimEnd(),
      stdout: data.stdout ?? '',
      stderr: data.stderr ?? '',
      compileOutput: data.compile_output ?? '',
      message: data.message ?? '',
      status: data.status?.description ?? 'Unknown',
      statusId: data.status?.id ?? null,
      time: data.time ?? null,
      memory: data.memory ?? null,
      exitCode: data.exit_code ?? null,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({
      output: `Failed to reach Judge0 — ${message}`,
      stderr: `Failed to reach Judge0 — ${message}`,
      status: 'Execution service unreachable',
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// Auth + LMS routes (Track A)
// ═══════════════════════════════════════════════════════════════════════════

// ── POST /api/auth/register ────────────────────────────────────────────────
app.post('/api/auth/register', authLimiter, validate(registerSchema), async (req: Request, res: Response) => {
  // validate(registerSchema) has already enforced username format and the
  // password policy (8–72 chars, letter + number) before any DB access.
  const { username, password, role } = req.body

  const existing = await prisma.user.findUnique({ where: { username } })
  if (existing) {
    res.status(409).json({ error: 'Username already taken.' })
    return
  }

  const passwordHash = await bcrypt.hash(password, 12)
  const user = await prisma.user.create({ data: { username, passwordHash, role } })
  const token = signToken({ userId: user.id, role: user.role })
  console.log(`[AUTH] Registered ${user.role} ${user.username} (${user.id})`)
  res.status(201).json({ token, user: { id: user.id, username: user.username, role: user.role } })
})

// ── POST /api/auth/login ───────────────────────────────────────────────────
app.post('/api/auth/login', authLimiter, validate(loginSchema), async (req: Request, res: Response) => {
  const { username, password } = req.body

  // Same message for unknown user and wrong password — prevents username enumeration.
  const user = await prisma.user.findUnique({ where: { username } })
  if (!user) {
    res.status(401).json({ error: 'Invalid credentials' })
    return
  }
  const valid = await bcrypt.compare(password, user.passwordHash)
  if (!valid) {
    res.status(401).json({ error: 'Invalid credentials' })
    return
  }

  const token = signToken({ userId: user.id, role: user.role })
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } })
})

// ── GET /api/auth/me ───────────────────────────────────────────────────────
app.get('/api/auth/me', requireAuth, async (req: Request, res: Response) => {
  // Fetch fresh from DB (not just from token) so role changes are reflected.
  const user = await prisma.user.findUnique({ where: { id: req.user!.userId } })
  if (!user) {
    res.status(401).json({ error: 'User no longer exists.' })
    return
  }
  res.json({ id: user.id, username: user.username, role: user.role })
})

// ── POST /api/classes ──────────────────────────────────────────────────────
const JOIN_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
function generateJoinCode(): string {
  return Array.from({ length: 6 }, () =>
    JOIN_CODE_CHARS[Math.floor(Math.random() * JOIN_CODE_CHARS.length)]
  ).join('')
}

app.post('/api/classes', requireAuth, requireRole('INSTRUCTOR'), validate(createClassSchema), async (req: Request, res: Response) => {
  const { name } = req.body

  // Retry on join-code collision (unique constraint on classes.joinCode)
  for (let attempt = 0; attempt < 5; attempt++) {
    const joinCode = generateJoinCode()
    try {
      const created = await prisma.class.create({
        data: { name: name.trim(), joinCode, instructorId: req.user!.userId },
      })
      console.log(`[CLASS] Created "${created.name}" joinCode=${created.joinCode}`)
      res.status(201).json(created)
      return
    } catch (err) {
      const isUniqueViolation = err instanceof Error && 'code' in err && (err as { code?: string }).code === 'P2002'
      if (!isUniqueViolation) throw err
    }
  }
  res.status(500).json({ error: 'Could not generate a unique join code — try again.' })
})

// ── GET /api/classes ───────────────────────────────────────────────────────
app.get('/api/classes', requireAuth, async (req: Request, res: Response) => {
  const { userId, role } = req.user!
  const classes = role === 'INSTRUCTOR'
    ? await prisma.class.findMany({ where: { instructorId: userId } })
    : await prisma.class.findMany({ where: { memberships: { some: { userId } } } })
  res.json(classes)
})

// ── POST /api/classes/join ─────────────────────────────────────────────────
app.post('/api/classes/join', requireAuth, requireRole('STUDENT'), validate(joinClassSchema), async (req: Request, res: Response) => {
  const { joinCode } = req.body

  const klass = await prisma.class.findUnique({ where: { joinCode: joinCode.trim().toUpperCase() } })
  if (!klass) {
    res.status(404).json({ error: 'No class found for that join code.' })
    return
  }

  const userId = req.user!.userId
  const existing = await prisma.classMembership.findUnique({
    where: { userId_classId: { userId, classId: klass.id } },
  })
  if (existing) {
    res.status(409).json({ error: 'Already a member of this class.' })
    return
  }

  await prisma.classMembership.create({ data: { userId, classId: klass.id } })
  console.log(`[CLASS] Student ${userId} joined "${klass.name}"`)
  res.status(201).json(klass)
})

// Shared guard: is this user the instructor of, or a member of, this class?
async function canAccessClass(userId: string, classId: string): Promise<boolean> {
  const klass = await prisma.class.findUnique({ where: { id: classId } })
  if (!klass) return false
  if (klass.instructorId === userId) return true
  const membership = await prisma.classMembership.findUnique({
    where: { userId_classId: { userId, classId } },
  })
  return membership !== null
}

// ── GET /api/classes/:id ───────────────────────────────────────────────────
app.get('/api/classes/:id', requireAuth, async (req: Request, res: Response) => {
  const classId = String(req.params.id)
  const klass = await prisma.class.findUnique({
    where: { id: classId },
    include: { assignments: true },
  })
  if (!klass) {
    res.status(404).json({ error: 'Class not found.' })
    return
  }
  if (!(await canAccessClass(req.user!.userId, classId))) {
    res.status(403).json({ error: 'Not the instructor or a member of this class.' })
    return
  }
  // Session 16: which of this class's assignments has THIS user already
  // submitted — lets the student ClassPage badge them. Additive field.
  const submitted = await prisma.session.findMany({
    where: { userId: req.user!.userId, status: 'SUBMITTED', assignment: { classId } },
    select: { assignmentId: true },
  })
  const mySubmissions = [...new Set(submitted.map((s) => s.assignmentId).filter(Boolean))]
  res.json({ ...klass, mySubmissions })
})

// multer disk storage for both uploads (syllabus + assignment task PDF).
// multer creates uploads/ automatically when destination is a string.
const upload = multer({
  storage: multer.diskStorage({
    destination: 'uploads/',
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
})

// ── POST /api/classes/:classId/syllabus ────────────────────────────────────
// Session 20: the COURSE syllabus is uploaded once per class (re-uploadable
// mid-semester), stored on the Class, and parsed by Gemini into a per-week
// allowlist. PREVIEW-THEN-CONFIRM is preserved: the parsed weeks are RETURNED
// for the instructor to review/edit, and only persisted when they call
// PUT /api/classes/:classId/allowlist. The PDF itself is saved immediately so
// the instructor can re-view it.
app.post(
  '/api/classes/:classId/syllabus',
  requireAuth,
  requireRole('INSTRUCTOR'),
  upload.single('syllabus'),
  async (req: Request, res: Response) => {
    const classId = String(req.params.classId)
    const klass = await prisma.class.findUnique({ where: { id: classId } })
    if (!klass) {
      res.status(404).json({ error: 'Class not found.' })
      return
    }
    if (klass.instructorId !== req.user!.userId) {
      res.status(403).json({ error: 'You do not own this class.' })
      return
    }
    if (!req.file) {
      res.status(400).json({ error: "A PDF file field named 'syllabus' is required." })
      return
    }

    let text = ''
    try {
      const buffer = fs.readFileSync(path.join(process.cwd(), 'uploads', path.basename(req.file.filename)))
      const parser = new PDFParse({ data: new Uint8Array(buffer) })
      try {
        const parsed = await parser.getText()
        text = parsed.text?.trim() ?? ''
      } finally {
        await parser.destroy()
      }
    } catch (err) {
      console.error('[GEMINI] pdf-parse failed:', err instanceof Error ? err.message : err)
    }
    if (text.length < 50) {
      res.status(400).json({ error: 'Could not extract text from PDF (is it a scanned image?)' })
      return
    }

    // The document is the class's syllabus from now on, whatever Gemini does.
    await prisma.class.update({
      where: { id: classId },
      data: { syllabusFilename: req.file.filename },
    })

    try {
      const result = await parseSyllabusToAllowlist(text)
      console.log(`[GEMINI] parsed ${Object.keys(result.weeks).length} weeks for class ${classId}`)
      res.status(200).json({ weeks: result.weeks, syllabusFilename: req.file.filename })
    } catch {
      // Gemini failure must never block the instructor — they can still build
      // the allowlist by hand, and AST validation falls back to the baseline.
      res.status(200).json({
        weeks: null,
        syllabusFilename: req.file.filename,
        warning: 'Gemini could not parse this syllabus. You can build the allowlist manually below, or the default baseline list will be used.',
      })
    }
  }
)

// ── PUT /api/classes/:classId/allowlist ────────────────────────────────────
// Persists the instructor-CONFIRMED (possibly hand-edited) allowlist. Gemini
// is never re-run here — this stores only what a human approved.
app.put(
  '/api/classes/:classId/allowlist',
  requireAuth,
  requireRole('INSTRUCTOR'),
  async (req: Request, res: Response) => {
    const classId = String(req.params.classId)
    const klass = await prisma.class.findUnique({ where: { id: classId } })
    if (!klass) {
      res.status(404).json({ error: 'Class not found.' })
      return
    }
    if (klass.instructorId !== req.user!.userId) {
      res.status(403).json({ error: 'You do not own this class.' })
      return
    }

    const incoming = req.body?.allowlist
    const weeks = incoming?.weeks
    if (!incoming || typeof incoming !== 'object' || !weeks || typeof weeks !== 'object' || Array.isArray(weeks)) {
      res.status(400).json({ error: 'Body must be { allowlist: { weeks: { week1: [...], ... } } }.' })
      return
    }
    for (const [key, list] of Object.entries(weeks)) {
      if (!Array.isArray(list) || !list.every((x) => typeof x === 'string')) {
        res.status(400).json({ error: `Week "${key}" must be an array of node-type strings.` })
        return
      }
    }

    const updated = await prisma.class.update({
      where: { id: classId },
      data: { allowlist: { weeks } },
    })
    console.log(`[ALLOWLIST] Class ${classId} allowlist saved (${Object.keys(weeks).length} weeks)`)
    res.status(200).json({ allowlist: updated.allowlist })
  }
)

// ── GET /api/classes/:classId/syllabus/pdf ─────────────────────────────────
// Lets the instructor re-view the syllabus they uploaded. Same traversal guard
// as the assignment PDF route.
app.get(
  '/api/classes/:classId/syllabus/pdf',
  requireAuth,
  requireRole('INSTRUCTOR'),
  async (req: Request, res: Response) => {
    const classId = String(req.params.classId)
    const klass = await prisma.class.findUnique({ where: { id: classId } })
    if (!klass) {
      res.status(404).json({ error: 'Class not found.' })
      return
    }
    if (klass.instructorId !== req.user!.userId) {
      res.status(403).json({ error: 'You do not own this class.' })
      return
    }
    if (!klass.syllabusFilename) {
      res.status(404).json({ error: 'No syllabus uploaded for this class' })
      return
    }
    const filePath = path.join(process.cwd(), 'uploads', path.basename(klass.syllabusFilename))
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Syllabus file missing from storage.' })
      return
    }
    res.setHeader('Content-Type', 'application/pdf')
    fs.createReadStream(filePath)
      .on('error', () => {
        if (!res.headersSent) res.status(500).json({ error: 'Failed to read PDF.' })
        else res.end()
      })
      .pipe(res)
  }
)

// ── POST /api/classes/:classId/assignments ─────────────────────────────────
// multipart/form-data: title, type, week, assignmentPdf? (the TASK/QUESTION
// document shown in the exam split-pane). Session 20: no syllabus parsing here
// any more — the allowlist lives on the Class and is keyed by `week`.

app.post(
  '/api/classes/:classId/assignments',
  requireAuth,
  requireRole('INSTRUCTOR'),
  upload.single('assignmentPdf'),
  // Multipart: multer populates req.body with the text fields FIRST, then the
  // schema validates them (title/type/week).
  validate(createAssignmentSchema),
  async (req: Request, res: Response) => {
    const classId = String(req.params.classId)
    const { title, type } = req.body
    const week = Number.parseInt(req.body.week, 10)

    const klass = await prisma.class.findUnique({ where: { id: classId } })
    if (!klass) {
      res.status(404).json({ error: 'Class not found.' })
      return
    }
    if (klass.instructorId !== req.user!.userId) {
      res.status(403).json({ error: 'You do not own this class.' })
      return
    }

    const assignment = await prisma.assignment.create({
      data: {
        classId,
        title: title.trim(),
        type,
        week: Number.isFinite(week) && week > 0 ? week : 1,
        assignmentPdfFilename: req.file?.filename ?? null,
      },
    })
    console.log(`[ASSIGNMENT] Created "${assignment.title}" (${assignment.type}, week ${assignment.week}) in class ${classId}`)
    res.status(201).json(assignment)
  }
)

// ── GET /api/classes/:classId/assignments ──────────────────────────────────
app.get('/api/classes/:classId/assignments', requireAuth, async (req: Request, res: Response) => {
  const classId = String(req.params.classId)
  if (!(await canAccessClass(req.user!.userId, classId))) {
    res.status(403).json({ error: 'Not the instructor or a member of this class.' })
    return
  }
  const assignments = await prisma.assignment.findMany({ where: { classId } })
  res.json(assignments)
})

// ── GET /api/assignments/:id ───────────────────────────────────────────────
// Called by the student IDE on load to get week/type/allowlist.
app.get('/api/assignments/:id', requireAuth, async (req: Request, res: Response) => {
  // withRetry: this load is how a student OPENS an exam — a transient Neon
  // drop here must not block the exam from starting.
  const assignment = await withRetry(() =>
    prisma.assignment.findUnique({
      where: { id: String(req.params.id) },
      include: { class: true },
    })
  )
  if (!assignment) {
    res.status(404).json({ error: 'Assignment not found.' })
    return
  }
  // Session 16: tell the requester whether THEY already submitted this
  // assignment, so ExamPage can show the locked state instead of silently
  // creating a fresh session. Additive — existing consumers are unaffected.
  const submitted = await withRetry(() =>
    prisma.session.findFirst({
      where: { assignmentId: assignment.id, userId: req.user!.userId, status: 'SUBMITTED' },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, status: true },
    })
  )
  res.json({ ...assignment, mySubmittedSession: submitted })
})

// ── Instructor session discovery (Session 16 — READ-ONLY) ─────────────────
// Flags-only summary: never the full forensics stats, never raw event data.
// Framing rule: flags mean "flagged for instructor review", never "cheating".
type SessionRow = {
  id: string
  studentId: string
  status: string
  runCount: number | null
  createdAt: Date
  updatedAt: Date
  forensicsResults: unknown
}

function sessionSummary(s: SessionRow) {
  const fr = s.forensicsResults as
    | {
        metricA?: { flag?: boolean }
        metricB?: { flag?: boolean }
        metricC?: { flag?: boolean; stats?: { cv?: number | null } }
      }
    | null
  return {
    id: s.id,
    studentId: s.studentId,
    status: s.status,
    runCount: s.runCount ?? 0,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    forensicsResults: fr
      ? {
          metricA: { flag: fr.metricA?.flag ?? null },
          metricB: { flag: fr.metricB?.flag ?? null },
          // cv is a single derived scalar (needed for the severity color
          // scale) — still no full stats and never raw events.
          metricC: { flag: fr.metricC?.flag ?? null, cv: fr.metricC?.stats?.cv ?? null },
        }
      : null,
  }
}

// ── GET /api/assignments/:assignmentId/sessions ────────────────────────────
app.get(
  '/api/assignments/:assignmentId/sessions',
  requireAuth,
  requireRole('INSTRUCTOR'),
  async (req: Request, res: Response) => {
    const assignmentId = String(req.params.assignmentId)
    const assignment = await prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: { class: true },
    })
    if (!assignment) {
      res.status(404).json({ error: 'Assignment not found.' })
      return
    }
    if (assignment.class.instructorId !== req.user!.userId) {
      res.status(403).json({ error: 'You do not own this class.' })
      return
    }
    const sessions = await prisma.session.findMany({
      where: { assignmentId },
      orderBy: { updatedAt: 'desc' },
    })
    res.json(sessions.map(sessionSummary))
  }
)

// ── GET /api/assignments/:id/roster ────────────────────────────────────────
// Session 17 grid dashboard: the full class roster for an assignment's exam —
// every member student, joined with their session (if any) for THIS
// assignment. Read-only, instructor-only, ownership-checked, flags-only.
app.get(
  '/api/assignments/:id/roster',
  requireAuth,
  requireRole('INSTRUCTOR'),
  async (req: Request, res: Response) => {
    const assignmentId = String(req.params.id)
    const assignment = await prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: { class: true },
    })
    if (!assignment) {
      res.status(404).json({ error: 'Assignment not found.' })
      return
    }
    if (assignment.class.instructorId !== req.user!.userId) {
      res.status(403).json({ error: 'You do not own this class.' })
      return
    }

    const [memberships, sessions] = await Promise.all([
      prisma.classMembership.findMany({
        where: { classId: assignment.classId },
        include: { user: { select: { id: true, username: true } } },
      }),
      prisma.session.findMany({
        where: { assignmentId },
        orderBy: { updatedAt: 'desc' },
      }),
    ])

    const roster = memberships
      .map((m) => {
        // Prefer the userId link; fall back to studentId === username (the
        // legacy identity — sessions store the username there). Sessions are
        // updatedAt-desc, so the first match is the latest.
        const session =
          sessions.find((s) => s.userId === m.user.id) ??
          sessions.find((s) => s.studentId === m.user.username) ??
          null
        const summary = session ? sessionSummary(session) : null
        return {
          userId: m.user.id,
          username: m.user.username,
          sessionId: session?.id ?? null,
          status: session?.status ?? 'NOT_STARTED',
          forensicsFlags: summary?.forensicsResults ?? null,
        }
      })
      .sort((a, b) => a.username.localeCompare(b.username))

    res.json(roster)
  }
)

// ── GET /api/classes/:classId/sessions ─────────────────────────────────────
// Class-level overview: all sessions across the class's assignments.
app.get(
  '/api/classes/:classId/sessions',
  requireAuth,
  requireRole('INSTRUCTOR'),
  async (req: Request, res: Response) => {
    const classId = String(req.params.classId)
    const klass = await prisma.class.findUnique({ where: { id: classId } })
    if (!klass) {
      res.status(404).json({ error: 'Class not found.' })
      return
    }
    if (klass.instructorId !== req.user!.userId) {
      res.status(403).json({ error: 'You do not own this class.' })
      return
    }
    const sessions = await prisma.session.findMany({
      where: { assignment: { classId } },
      orderBy: { updatedAt: 'desc' },
      include: { assignment: { select: { id: true, title: true } } },
    })
    res.json(
      sessions.map((s) => ({
        ...sessionSummary(s),
        assignmentId: s.assignment?.id ?? null,
        assignmentTitle: s.assignment?.title ?? null,
      }))
    )
  }
)

// ── GET /api/assignments/:id/pdf ───────────────────────────────────────────
// Streams the assignment's TASK/QUESTION document for the exam split-pane
// (Session 20: this is `assignmentPdfFilename`, never the course syllabus).
// Path-traversal guard: only ever uploads/ + basename of the STORED filename —
// no user-supplied path segment is ever joined.
app.get('/api/assignments/:id/pdf', requireAuth, async (req: Request, res: Response) => {
  const assignment = await prisma.assignment.findUnique({
    where: { id: String(req.params.id) },
  })
  if (!assignment) {
    res.status(404).json({ error: 'Assignment not found.' })
    return
  }
  if (!assignment.assignmentPdfFilename) {
    res.status(404).json({ error: 'No PDF for this assignment' })
    return
  }

  const safeName = path.basename(assignment.assignmentPdfFilename)
  const filePath = path.join(process.cwd(), 'uploads', safeName)
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'PDF file missing from storage.' })
    return
  }

  res.setHeader('Content-Type', 'application/pdf')
  fs.createReadStream(filePath)
    .on('error', () => {
      if (!res.headersSent) res.status(500).json({ error: 'Failed to read PDF.' })
      else res.end()
    })
    .pipe(res)
})

// ── 404 + global error handling (END of middleware chain) ─────────────────
// Every unmatched route and every uncaught error returns JSON — never the
// Express HTML error page (kills the frontend "Unexpected token '<'" class).
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' })
})

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
  // Malformed JSON body from express.json() → clean 400.
  if ((err as { type?: string } | null)?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Malformed JSON body' })
    return
  }
  if (err instanceof Error && err.message.startsWith('CORS')) {
    res.status(403).json({ error: 'CORS: origin not allowed' })
    return
  }
  // Log name/code/message only — never a stack trace or request body to the client.
  const errName = err instanceof Error ? err.name : typeof err
  const errCode = (err as { code?: string } | null)?.code ?? ''
  console.error('[ERROR]', errName, errCode, err instanceof Error ? err.message.replace(/\s+/g, ' ').slice(0, 300) : err)
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Socket.io setup ───────────────────────────────────────────────────────
// Constraint 3: WebSockets carry ONLY TAB_OUT, ILLEGAL_PASTE, AST_VIOLATION.
// No raw telemetry, no burst data, no keystroke streams go over this channel.
const httpServer = createServer(app)
const io = new SocketServer(httpServer, {
  cors: { origin: 'http://localhost:5173' },
})

io.on('connection', (socket) => {
  socket.on('join_instructor', () => {
    socket.join('instructors')
    debugLog('[SOCKET] Instructor joined room')
  })

  socket.on('alert', (payload: { type: string; studentId: string; sessionId: string; timestamp: number; detail: string }) => {
    debugLog(`[RELAY] ${payload.type} -> instructors | session=${payload.sessionId} detail="${payload.detail}"`)
    io.to('instructors').emit('alert', payload)
  })
})

httpServer.listen(PORT, () => {
  console.log(`CoDecep Ingestion Gateway → http://localhost:${PORT}`)
})
