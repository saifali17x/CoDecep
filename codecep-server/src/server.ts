import express, { Request, Response } from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
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

// ── BullMQ worker (decoupled DB writer) ────────────────────────────────────
const telemetryWorker = new Worker(
  'telemetryQueue',
  async (job) => {
    const events: TelemetryEvent[] = job.data

    await prisma.telemetryPacket.createMany({
      data: events.map((ev) => ({
        timestamp: BigInt(ev.timestamp),
        timeSinceLastKeystrokeMs: ev.timeSinceLastKeystrokeMs,
        actionType: ev.actionType,
        charDelta: ev.charDelta,
        textLength: ev.textLength,
      })),
    })

    console.log(`[WORKER] Wrote ${events.length} event(s) to PostgreSQL`)
  },
  { connection: redisConnection }
)

telemetryWorker.on('failed', (job, err) => {
  console.error(`[WORKER] Job ${job?.id} failed:`, err.message)
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

interface TelemetryEvent {
  timestamp: number
  timeSinceLastKeystrokeMs: number
  actionType: 'type' | 'delete' | 'paste'
  charDelta: number
  textLength: number
}

// ── POST /api/telemetry/submit ─────────────────────────────────────────────
app.post('/api/telemetry/submit', async (req: Request, res: Response) => {
  const payload: TelemetryEvent[] = req.body

  if (!Array.isArray(payload) || payload.length === 0) {
    res.status(400).json({ error: 'Payload must be a non-empty array of telemetry events.' })
    return
  }

  await telemetryQueue.add('process-chunk', payload)
  console.log(`[INGESTION] Queued chunk of ${payload.length} event(s) → Redis`)

  res.status(202).json({ accepted: payload.length })
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
  const { code, lang } = req.body

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
    res.status(200).json({ output: output.trimEnd() })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(502).json({ output: `Failed to reach Judge0 — ${message}` })
  }
})

app.listen(PORT, () => {
  console.log(`CoDecep Ingestion Gateway → http://localhost:${PORT}`)
})
