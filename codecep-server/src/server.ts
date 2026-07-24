import express, { Request, Response } from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { createServer } from 'http'
import { Server as SocketServer } from 'socket.io'
import { Queue, Worker } from 'bullmq'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import bcrypt from 'bcryptjs'
import multer from 'multer'
import { validateAST } from './ast/parser'
import { computeMetricA, computeLinearInjection, computeRoboticVariance } from './forensics/metrics'
import { signToken, requireAuth, requireRole } from './auth'

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

// ── POST /api/ast/validate ─────────────────────────────────────────────────
const week1Allowlist = [
  'translation_unit',
  'function_definition',
  'function_declarator', // structural sub-node of every function_definition
  'parameter_list',      // structural sub-node of every function_definition
  'compound_statement',
  'expression_statement',
  'return_statement',
  'primitive_type',
  'identifier',
  'number_literal',
  'string_literal',
  'ERROR',
]

app.post('/api/ast/validate', async (req: Request, res: Response) => {
  const { code } = req.body

  if (typeof code !== 'string' || code.trim().length === 0) {
    res.status(400).json({ error: 'Request body must contain a non-empty "code" string.' })
    return
  }

  const result = await validateAST(code, week1Allowlist)
  console.log(`[AST] Validated ${result.violations.length} violation(s) — isValid: ${result.isValid}`)
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

// ── POST /api/classes/:classId/assignments ─────────────────────────────────
// multipart/form-data: title, type, week, syllabus? (PDF file).
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

    // allowlist stays null for now — the Gemini syllabus parser fills it in Phase 6.
    const assignment = await prisma.assignment.create({
      data: {
        classId,
        title: title.trim(),
        type,
        week: Number.isFinite(week) && week > 0 ? week : 1,
        pdfFilename: req.file?.filename ?? null,
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
