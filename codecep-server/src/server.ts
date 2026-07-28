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
import { PDFParse } from 'pdf-parse'
import { validateAST } from './ast/parser'
import { computeMetricA, computeLinearInjection, computeRoboticVariance } from './forensics/metrics'
import { signToken, requireAuth, requireRole } from './auth'
import { parseSyllabusToAllowlist } from './gemini'

dotenv.config()

const app = express()
const PORT = process.env.PORT ?? 3001

// ── Parse REDIS_URL into plain host/port options ───────────────────────────
const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379')
const redisConnection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port) || 6379,
}

// ── Prisma 7 client (adapter-pg pattern) ──────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
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
app.post('/api/session/create', async (req: Request, res: Response) => {
  const { studentId, userId, assignmentId } = req.body

  if (typeof studentId !== 'string' || studentId.trim().length === 0) {
    res.status(400).json({ error: 'studentId is required.' })
    return
  }

  const existing = await prisma.session.findFirst({
    where: { studentId, status: 'IN_PROGRESS' },
  })
  if (existing) {
    console.log(`[SESSION] Returning existing session ${existing.id} for ${studentId}`)
    res.json({ sessionId: existing.id })
    return
  }

  const session = await prisma.session.create({
    data: {
      studentId,
      status: 'IN_PROGRESS',
      // Backward compatible: the hardcoded student-001 dev flow sends neither.
      ...(typeof userId === 'string' && userId.length > 0 ? { userId } : {}),
      ...(typeof assignmentId === 'string' && assignmentId.length > 0 ? { assignmentId } : {}),
    },
  })
  console.log(`[SESSION] Created new session ${session.id} for ${studentId}`)
  res.json({ sessionId: session.id })
})

// ── POST /api/telemetry/submit ─────────────────────────────────────────────
interface KeystrokeEvent {
  timestamp: number
  timeSinceLastKeystrokeMs: number
  actionType: 'type' | 'paste' | 'delete'
  charDelta: number
  textLength: number
}

app.post('/api/telemetry/submit', async (req: Request, res: Response) => {
  const { sessionId, studentId, chunk, codeSnapshot, engagedTimeMs } = req.body

  if (!sessionId || !Array.isArray(chunk) || chunk.length === 0) {
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

  await prisma.$executeRaw`
    UPDATE sessions
    SET playback_log  = playback_log  || ${JSON.stringify([playbackEntry])}::jsonb,
        burst_history = burst_history || ${JSON.stringify([burstEntry])}::jsonb,
        "updatedAt"   = NOW()
    WHERE id = ${sessionId}
  `

  console.log(`[INGEST] session=${sessionId} +${events.length} events appended`)
  res.status(202).json({ accepted: events.length })
})

// ── POST /api/session/:id/submit ──────────────────────────────────────────
app.post('/api/session/:id/submit', async (req: Request, res: Response) => {
  const sessionId = String(req.params.id)
  try {
    const session = await prisma.session.update({
      where: { id: sessionId, status: 'IN_PROGRESS' },
      data: { status: 'SUBMITTED' },
    })
    await telemetryQueue.add('forensics', { sessionId: session.id })
    console.log(`[SUBMIT] Session ${session.id} → SUBMITTED, forensics job enqueued`)
    res.status(200).json({ status: 'SUBMITTED' })
  } catch {
    res.status(200).json({ status: 'ALREADY_SUBMITTED' })
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

// Given an assignment's { weeks: {...} } allowlist, pick the list for its week.
// Falls back to the highest available week <= the assignment's week, else null
// (caller then uses the hardcoded week1Allowlist).
function resolveAssignmentAllowlist(
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

app.post('/api/ast/validate', async (req: Request, res: Response) => {
  const { code, assignmentId } = req.body

  if (typeof code !== 'string' || code.trim().length === 0) {
    res.status(400).json({ error: 'Request body must contain a non-empty "code" string.' })
    return
  }

  // Per-assignment allowlist (Phase 6). Falls back to the hardcoded
  // week1Allowlist when there is no assignment / no stored allowlist — keeps
  // the /legacy dev flow byte-for-byte compatible. Failures here must never
  // break validation, so lookup errors degrade to the default list.
  let allowlist = week1Allowlist
  let allowlistSource = 'default'
  if (typeof assignmentId === 'string' && assignmentId.length > 0) {
    try {
      const assignment = await prisma.assignment.findUnique({ where: { id: assignmentId } })
      if (assignment?.allowlist) {
        const resolved = resolveAssignmentAllowlist(assignment.allowlist, assignment.week)
        if (resolved) {
          allowlist = resolved
          allowlistSource = `assignment week${assignment.week}`
        }
      }
    } catch (err) {
      console.error('[AST] Allowlist lookup failed — using default:', err instanceof Error ? err.message : err)
    }
  }

  const result = await validateAST(code, allowlist)
  console.log(`[AST] Validated ${result.violations.length} violation(s) — isValid: ${result.isValid} (allowlist: ${allowlistSource})`)
  res.status(200).json(result)
})

// ── POST /api/execute ─────────────────────────────────────────────────────
app.post('/api/execute', async (req: Request, res: Response) => {
  const { code, lang, sessionId } = req.body

  if (typeof code !== 'string' || code.trim().length === 0) {
    res.status(400).json({ error: 'Request body must contain a non-empty "code" string.' })
    return
  }

  const languageId = lang === 'c' ? 50 : 54

  try {
    const judge0Res = await fetch(
      'https://ce.judge0.com/submissions?base64_encoded=false&wait=true',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_code: code, language_id: languageId }),
      }
    )

    if (!judge0Res.ok) {
      res.status(502).json({ output: `Judge0 error — HTTP ${judge0Res.status}. Try again shortly.` })
      return
    }

    const data = await judge0Res.json() as {
      stdout?: string
      stderr?: string
      compile_output?: string
    }

    const output = data.compile_output ?? data.stderr ?? data.stdout ?? '(no output)'
    console.log(`[EXECUTE] lang=${lang ?? 'cpp'} id=${languageId} → output (${output.length} chars)`)

    // Increment runCount so Metric A has an accurate compile count
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      await prisma.session.update({
        where: { id: sessionId },
        data: { runCount: { increment: 1 } },
      }).catch(() => { /* session may not exist in tests — silently ignore */ })
    }

    res.status(200).json({ output: output.trimEnd() })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ output: `Failed to reach Judge0 — ${message}` })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// Auth + LMS routes (Track A)
// ═══════════════════════════════════════════════════════════════════════════

// ── POST /api/auth/register ────────────────────────────────────────────────
app.post('/api/auth/register', async (req: Request, res: Response) => {
  const { username, password, role } = req.body

  if (typeof username !== 'string' || username.trim().length === 0 ||
      typeof password !== 'string' || password.length === 0) {
    res.status(400).json({ error: 'username and password are required.' })
    return
  }
  if (role !== 'INSTRUCTOR' && role !== 'STUDENT') {
    res.status(400).json({ error: "role must be 'INSTRUCTOR' or 'STUDENT'." })
    return
  }

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
app.post('/api/auth/login', async (req: Request, res: Response) => {
  const { username, password } = req.body

  if (typeof username !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: 'username and password are required.' })
    return
  }

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

app.post('/api/classes', requireAuth, requireRole('INSTRUCTOR'), async (req: Request, res: Response) => {
  const { name } = req.body
  if (typeof name !== 'string' || name.trim().length === 0) {
    res.status(400).json({ error: 'name is required.' })
    return
  }

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
app.post('/api/classes/join', requireAuth, requireRole('STUDENT'), async (req: Request, res: Response) => {
  const { joinCode } = req.body
  if (typeof joinCode !== 'string' || joinCode.trim().length === 0) {
    res.status(400).json({ error: 'joinCode is required.' })
    return
  }

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
  res.json(klass)
})

// ── POST /api/assignments/preview-allowlist ────────────────────────────────
// Phase 6 preview step: parse a syllabus PDF into a per-week allowlist WITHOUT
// saving anything. The instructor reviews/edits the result in the UI, then the
// confirmed version is sent with the normal create-assignment request. Memory
// storage — we only need the text here, the file itself is uploaded on create.
const previewUpload = multer({ storage: multer.memoryStorage() })

app.post(
  '/api/assignments/preview-allowlist',
  requireAuth,
  requireRole('INSTRUCTOR'),
  previewUpload.single('syllabus'),
  async (req: Request, res: Response) => {
    if (!req.file?.buffer) {
      res.status(400).json({ error: "A PDF file field named 'syllabus' is required." })
      return
    }

    let text = ''
    try {
      const parser = new PDFParse({ data: new Uint8Array(req.file.buffer) })
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

    try {
      const result = await parseSyllabusToAllowlist(text)
      console.log(`[GEMINI] preview parsed ${Object.keys(result.weeks).length} weeks for instructor ${req.user!.userId}`)
      res.status(200).json({ weeks: result.weeks })
    } catch {
      // Gemini failure must not block assignment creation — the UI shows the
      // warning and lets the instructor proceed on the default allowlist.
      res.status(200).json({
        weeks: null,
        warning: 'Gemini could not parse this syllabus. You can proceed without it and the default allowlist will be used, or edit manually.',
      })
    }
  }
)

// ── POST /api/classes/:classId/assignments ─────────────────────────────────
// multipart/form-data: title, type, week, syllabus? (PDF file), allowlist?
// (JSON string of the instructor-confirmed { weeks: {...} } from the preview).
// multer creates uploads/ automatically when destination is a string.
const upload = multer({
  storage: multer.diskStorage({
    destination: 'uploads/',
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
})

app.post(
  '/api/classes/:classId/assignments',
  requireAuth,
  requireRole('INSTRUCTOR'),
  upload.single('syllabus'),
  async (req: Request, res: Response) => {
    const classId = String(req.params.classId)
    const { title, type } = req.body
    const week = Number.parseInt(req.body.week, 10)

    if (typeof title !== 'string' || title.trim().length === 0) {
      res.status(400).json({ error: 'title is required.' })
      return
    }
    if (type !== 'LIVE_LAB' && type !== 'ASSESSMENT') {
      res.status(400).json({ error: "type must be 'LIVE_LAB' or 'ASSESSMENT'." })
      return
    }

    const klass = await prisma.class.findUnique({ where: { id: classId } })
    if (!klass) {
      res.status(404).json({ error: 'Class not found.' })
      return
    }
    if (klass.instructorId !== req.user!.userId) {
      res.status(403).json({ error: 'You do not own this class.' })
      return
    }

    // Instructor-confirmed allowlist from the preview step (Phase 6). Gemini is
    // NOT re-run here — this route only persists what the instructor approved.
    // Absent or malformed → null → AST validation falls back to week1Allowlist.
    let allowlist: { weeks: Record<string, string[]> } | null = null
    if (typeof req.body.allowlist === 'string' && req.body.allowlist.length > 0) {
      try {
        const parsed = JSON.parse(req.body.allowlist)
        if (parsed && typeof parsed === 'object' && parsed.weeks && typeof parsed.weeks === 'object') {
          allowlist = parsed
        }
      } catch {
        console.error('[ASSIGNMENT] Ignoring malformed allowlist JSON — storing null')
      }
    }

    const assignment = await prisma.assignment.create({
      data: {
        classId,
        title: title.trim(),
        type,
        week: Number.isFinite(week) && week > 0 ? week : 1,
        pdfFilename: req.file?.filename ?? null,
        ...(allowlist ? { allowlist } : {}),
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
  const assignment = await prisma.assignment.findUnique({
    where: { id: String(req.params.id) },
    include: { class: true },
  })
  if (!assignment) {
    res.status(404).json({ error: 'Assignment not found.' })
    return
  }
  res.json(assignment)
})

// ── GET /api/assignments/:id/pdf ───────────────────────────────────────────
// Streams the assignment's uploaded PDF for the exam split-pane (Phase 1).
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
  if (!assignment.pdfFilename) {
    res.status(404).json({ error: 'No PDF for this assignment' })
    return
  }

  const safeName = path.basename(assignment.pdfFilename)
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
    console.log('[SOCKET] Instructor joined room')
  })

  socket.on('alert', (payload: { type: string; studentId: string; sessionId: string; timestamp: number; detail: string }) => {
    console.log(`[RELAY] ${payload.type} -> instructors | session=${payload.sessionId} detail="${payload.detail}"`)
    io.to('instructors').emit('alert', payload)
  })
})

httpServer.listen(PORT, () => {
  console.log(`CoDecep Ingestion Gateway → http://localhost:${PORT}`)
})
