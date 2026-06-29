import express, { Request, Response } from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { createServer } from 'http'
import { Server as SocketServer } from 'socket.io'
import { Queue, Worker } from 'bullmq'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import { validateAST } from './ast/parser'

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

// ── Metric B — Linear Injection Detection ─────────────────────────────────
// Thresholds are named constants so they can be tuned without hunting through logic.
const LINEAR_DELETE_RATIO_MAX = 0.02       // flag if fewer than 2% of events are deletions
const LINEAR_SINGLE_CHAR_RATIO_MIN = 0.90  // flag if more than 90% are single-char forward types

interface PlaybackEvent {
  timestamp: number
  timeSinceLastKeystrokeMs: number
  actionType: 'type' | 'paste' | 'delete'
  charDelta: number
  textLength: number
}

interface PlaybackEntry {
  flushedAt: number
  codeSnapshot: string
  events: PlaybackEvent[]
}

function computeLinearInjection(playbackLog: unknown) {
  const entries = (playbackLog as PlaybackEntry[]) ?? []
  const allEvents: PlaybackEvent[] = entries.flatMap((entry) => entry.events ?? [])
  const totalEvents = allEvents.length

  if (totalEvents < 20) {
    return {
      flag: false,
      reason: 'Session too short to assess linearity',
      stats: { totalEvents, deleteCount: 0, deleteRatio: 0, singleCharTypeRatio: 0, pasteCount: 0 },
    }
  }

  const deleteCount = allEvents.filter((e) => e.actionType === 'delete').length
  const deleteRatio = deleteCount / totalEvents
  const singleCharTypeCount = allEvents.filter(
    (e) => e.actionType === 'type' && Math.abs(e.charDelta) <= 2
  ).length
  const singleCharTypeRatio = singleCharTypeCount / totalEvents
  const pasteCount = allEvents.filter((e) => e.actionType === 'paste').length

  const flag = deleteRatio < LINEAR_DELETE_RATIO_MAX && singleCharTypeRatio > LINEAR_SINGLE_CHAR_RATIO_MIN

  return {
    flag,
    reason: flag
      ? 'Highly linear keystroke stream (minimal backtracking) — probabilistic signal of transcription/auto-typing; requires instructor review'
      : null,
    stats: { totalEvents, deleteCount, deleteRatio, singleCharTypeRatio, pasteCount },
  }
}

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

    // Metric A — Trial-and-error: genuine work has many compile attempts;
    // a pasted solution typically has 0–1. This is a probabilistic signal
    // to be reviewed by an instructor, not a definitive verdict.
    const runCount = session.runCount ?? 0
    const metricA = {
      runCount,
      flag: runCount <= 1,
      reason: runCount <= 1
        ? 'Low compile count — probabilistic signal of pasted solution; requires instructor review'
        : null,
    }

    const metricB = computeLinearInjection(session.playback_log)

    await prisma.session.update({
      where: { id: sessionId },
      data: { forensicsResults: { metricA, metricB } },
    })

    console.log(`[FORENSICS] Session ${sessionId} processed — metricA runCount=${runCount} flag=${metricA.flag}`)
    console.log(`[FORENSICS] session ${sessionId} metricB flag=${metricB.flag} deleteRatio=${metricB.stats.deleteRatio.toFixed(3)} singleCharRatio=${metricB.stats.singleCharTypeRatio.toFixed(3)}`)
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
  const { studentId } = req.body

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
    data: { studentId, status: 'IN_PROGRESS' },
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
