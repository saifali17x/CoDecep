import express, { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import fs from 'fs'
import path from 'path'
import { createServer } from 'http'
import { Server as SocketServer } from 'socket.io'
import { Queue, Worker } from 'bullmq'
import { PrismaClient, Prisma } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import bcrypt from 'bcryptjs'
import multer from 'multer'
import rateLimit from 'express-rate-limit'
import { PDFParse } from 'pdf-parse'
// First local import: every other module that reads process.env at import time
// loads it too, but keeping it first makes the ordering intentional rather than
// accidental. Local dev = .env.local; production = Heroku config vars.
import { loadEnv, describeEnvSource } from './env'
import { validateAST } from './ast/parser'
import {
  BASELINE_ALLOWLIST,
  withBaseline,
  summariseViolations,
  describeViolations,
} from './ast/allowlist'
import { buildZip } from './lib/zip'
import { decideSessionAction, buildRestorePayload } from './lib/sessionLifecycle'
// Gap #71 — which of several rows for one (student, assignment) is the REAL
// session, and which is an empty phantom left by two overlapping creates. PURE.
import { pickRealSession, dropPhantomDuplicates } from './lib/sessionResolution'
import {
  windowStatusFor,
  isSubmitAllowed,
  minutesLate,
  minutesUntilOpen,
  closesAtFrom,
  windowMinutesBetween,
} from './lib/examWindow'
import { isNetworkAllowed, normalizeIp, validateIpRule } from './lib/ipAccess'
import { parseReviewInput, reviewOut } from './lib/metricReview'
// Instructor review runs: which stored task workspace goes up to Judge0. PURE —
// the execution itself is the student path, unchanged.
import { selectTaskWorkspace } from './lib/instructorRun'
import {
  validateWorkspace,
  buildCompileScript,
  buildRunScript,
  splitCapturedFiles,
  selectWrittenFiles,
  type WorkspaceFile,
  type CapturedFile,
} from './lib/multiFile'
import {
  computeMetricA,
  computeLinearInjection,
  computeRoboticVariance,
  computeAuthorship,
  finalCodeLengthOf,
  finalFileSnapshots,
  isCodeFileName,
  markInconclusiveIfSubstantial,
  LINEAR_INSUFFICIENT_REASON,
  ROBOTIC_INSUFFICIENT_REASON,
  // Multi-task exams (Prompt 1) — tasks are a dimension inside the session
  // JSONB, so these are all pure selectors over playback_log/burst_history.
  taskIdsIn,
  taskLabel,
  finalTaskSnapshots,
  codeLengthOfFiles,
  playbackLogForTask,
  burstHistoryForTask,
  // Prompt 2 — per-task Metric A (gap #29) and the any-task-flagged merged
  // review signal (gap #31). Both are pure selectors/derivations too.
  runCountForTask,
  computeMergedReview,
  // How many characters an event INSERTED, independent of what it replaced —
  // the paste-replace fix. See forensics/metrics.ts.
  insertedCharsOf,
  type AuthorshipResult,
} from './forensics/metrics'
import { signToken, requireAuth, requireRole, verifyToken } from './auth'
import { parseSyllabusToAllowlist } from './gemini'
import { WatchRegistry } from './live/watchRegistry'
import {
  registerLiveHandlers,
  announceFlush,
  announceSessionEnd,
  type LiveSocket,
} from './live/liveRelay'
import {
  validate,
  registerSchema,
  loginSchema,
  createClassSchema,
  joinClassSchema,
  createAssignmentSchema,
  updateAssignmentSchema,
  astValidateSchema,
  sessionCreateSchema,
  telemetrySubmitSchema,
} from './validation'

loadEnv()

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

// ── Live DVR watch registry (Session 28) ──────────────────────────────────
// Which instructors are watching which sessions right now. In-memory and
// process-local ON PURPOSE: it describes live socket connections, which do not
// outlive the process either, so persisting it would only create state that can
// disagree with reality. Nothing durable depends on it — if the server
// restarts, every DVR reconnects and re-registers.
const watchRegistry = new WatchRegistry()

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

    // Which signals mean anything here depends on the KIND of exam this was: a
    // take-home ASSESSMENT makes Metric A (compile count) and tab-outs
    // meaningless, so they must not drive the review flag. Read once, stored on
    // the result so every reader gates the same way without another lookup.
    // Unknown/absent → treated as LIVE_LAB, i.e. the pre-existing behavior.
    const assignmentType = session.assignmentId
      ? (
          await prisma.assignment.findUnique({
            where: { id: session.assignmentId },
            select: { type: true },
          })
        )?.type ?? null
      : null

    const runCount = session.runCount ?? 0
    // The submitted program's length — the denominator authorship reasons in,
    // and the test for whether a sparse B/C result is "nothing happened" or
    // "a whole program appeared without being typed".
    const finalCodeLength = finalCodeLengthOf(session.playback_log)

    const metricA = computeMetricA(runCount)
    const authorship = computeAuthorship(session.playback_log, finalCodeLength)
    // B and C keep their own math untouched; only a tripped too-little-data
    // guard on a substantial program gets re-worded so it can't read as a pass.
    const metricB = markInconclusiveIfSubstantial(
      computeLinearInjection(session.playback_log),
      LINEAR_INSUFFICIENT_REASON,
      finalCodeLength,
    )
    // The playback log is passed so Metric C can tell "a rhythm we measured" from
    // "no typing to measure a rhythm in". A fully-pasted session still produces
    // flush windows, so it still produced a CV — reported as green "human-like
    // variance" on exactly the session authorship flags hardest.
    const metricC = markInconclusiveIfSubstantial(
      computeRoboticVariance(session.burst_history, session.playback_log),
      ROBOTIC_INSUFFICIENT_REASON,
      finalCodeLength,
    )

    // ── Multi-task exams (Prompt 1) ─────────────────────────────────────────
    // Tasks are separate programs, so the sharp reading is PER TASK: a student
    // who hand-writes Task 1 and pastes Task 3 shows up as one flagged task,
    // where a session-wide average would dilute it into nothing. Every metric
    // below is the EXISTING function run over one task's slice — no metric math
    // changed, only which events and which files it is handed.
    const taskIds = taskIdsIn(session.playback_log)
    const taskSnaps = finalTaskSnapshots(session.playback_log)
    const isMultiTask = taskIds.length > 1

    // Qualify file names by task ONLY when there is more than one, so a
    // single-task session's audit reads exactly as it always did.
    const sessionFiles: Record<string, string> = isMultiTask
      ? Object.fromEntries(
          taskIds.flatMap((taskId) =>
            Object.entries(taskSnaps[taskId] ?? {}).map(([name, text]) => [`${taskId}/${name}`, text]),
          ),
        )
      : taskSnaps[taskIds[0]] ?? finalFileSnapshots(session.playback_log)

    // Change B2 (Session 24): every code file in the final workspace is parsed
    // here, so a forbidden construct can no longer hide in a file that was
    // never the active buffer. Prompt 1 widens "workspace" to every task.
    const astAudit = await auditCodeFiles(sessionFiles, session.assignmentId)

    const tasks: Record<string, Prisma.InputJsonObject> = {}
    for (const taskId of taskIds) {
      const taskLog = playbackLogForTask(session.playback_log, taskId)
      const taskBursts = burstHistoryForTask(session.playback_log, session.burst_history, taskId)
      const taskFiles = taskSnaps[taskId] ?? {}
      const taskCodeLength = codeLengthOfFiles(taskFiles)

      // Prompt 2 (gap #29) — Metric A is now REAL per task: /api/execute
      // records which task each Run belonged to in `runCountByTask`. The
      // selector carries the fallbacks, so a session recorded before per-task
      // tracking still reports the session total, labelled `scope: 'session'`
      // rather than pretending it was measured per task.
      const taskRuns = runCountForTask(
        session.runCountByTask,
        taskId,
        runCount,
        taskIds.length,
      )

      tasks[taskId] = {
        label: taskLabel(taskId),
        metricA: { ...computeMetricA(taskRuns.runCount), scope: taskRuns.scope },
        metricB: markInconclusiveIfSubstantial(
          computeLinearInjection(taskLog),
          LINEAR_INSUFFICIENT_REASON,
          taskCodeLength,
        ),
        metricC: markInconclusiveIfSubstantial(
          computeRoboticVariance(taskBursts, taskLog),
          ROBOTIC_INSUFFICIENT_REASON,
          taskCodeLength,
        ),
        // Denominator is THIS task's whole program (its .cpp/.h files); data
        // files are excluded exactly as in v2.
        authorship: computeAuthorship(taskLog, taskCodeLength),
        astAudit: await auditCodeFiles(taskFiles, session.assignmentId),
      }
    }

    // ── Merged review signal (Prompt 2 — closes gap #31) ────────────────────
    // The five session-level keys below are computed over ALL events, which on
    // a multi-task exam makes them an AVERAGE: a fully-pasted task beside two
    // hand-typed ones can pull the session's typedRatio back over the threshold
    // and the whole session reads clean. The REVIEW signal is therefore
    // any-task-flagged, never the average — a flagged task can no longer hide.
    //
    // On an ASSESSMENT the merged signal deliberately IGNORES Metric A: a
    // take-home has no sitting to compare a compile count against, so letting it
    // flag would train instructors to dismiss the flag that does matter.
    const merged = computeMergedReview(
      tasks,
      { metricA, metricB, metricC, authorship, astAudit },
      taskIds.length,
      assignmentType,
    )

    await prisma.session.update({
      where: { id: sessionId },
      data: {
        forensicsResults: {
          // The session-level result is the UNCHANGED computation over ALL
          // events — not a roll-up of the per-task numbers — so every existing
          // reader (ClassPage's Auth column, the DVR pills, the three
          // flags-only routes) keeps working with no shape change at all.
          metricA,
          metricB,
          metricC,
          authorship,
          astAudit,
          // Additive.
          taskCount: taskIds.length,
          // The exam type this session was sat under, so every reader gates the
          // display of type-irrelevant signals identically without a lookup.
          assignmentType,
          tasks,
          // Prompt 2: the cross-task review signal. Additive too — every
          // existing reader that only knows the five keys above is unaffected.
          merged,
        },
      },
    })

    console.log(`[FORENSICS] Session ${sessionId} processed — metricA runCount=${runCount} flag=${metricA.flag}`)
    console.log(`[FORENSICS] session ${sessionId} metricB flag=${metricB.flag} deleteRatio=${metricB.stats.deleteRatio.toFixed(3)} singleCharRatio=${metricB.stats.singleCharTypeRatio.toFixed(3)}${metricB.inconclusive ? ' inconclusive=true' : ''}`)
    console.log(`[FORENSICS] session ${sessionId} metricC flag=${metricC.flag} cv=${metricC.stats.cv} sampleCount=${metricC.stats.sampleCount}${metricC.inconclusive ? ' inconclusive=true' : ''}`)
    console.log(`[FORENSICS] session ${sessionId} authorship flag=${authorship.flag} finalCodeLength=${finalCodeLength} typedRatio=${authorship.stats.typedRatio} pastedRatio=${authorship.stats.pastedRatio}`)
    console.log(`[FORENSICS] session ${sessionId} astAudit flag=${astAudit.flag} files=[${astAudit.checkedFiles.join(', ')}] violations=${astAudit.violations.length} (allowlist: ${astAudit.allowlistSource})`)
    if (isMultiTask) {
      for (const taskId of taskIds) {
        const t = tasks[taskId] as {
          authorship: AuthorshipResult
          astAudit: { flag: boolean }
          metricA: { runCount: number; flag: boolean; scope: string }
        }
        console.log(`[FORENSICS] session ${sessionId} ${taskId} authorship flag=${t.authorship.flag} typedRatio=${t.authorship.stats.typedRatio} finalCodeLength=${t.authorship.stats.finalCodeLength} astFlag=${t.astAudit.flag} runs=${t.metricA.runCount}(${t.metricA.scope}) metricAFlag=${t.metricA.flag}`)
      }
    }
    console.log(`[FORENSICS] session ${sessionId} merged flag=${merged.flag} (${merged.flaggedTaskCount}/${merged.taskCount} task(s) flagged) — ${merged.reason ?? 'no flags for review'}`)
  },
  { connection: redisConnection },
)

forensicsWorker.on('failed', (job, err) => {
  console.error(`[FORENSICS] Job ${job?.id} failed:`, err.message)
})

// ── Express setup ──────────────────────────────────────────────────────────
// Network restriction (Feature 2) reads the client address from `req.ip`, whose
// meaning depends on this setting. OFF (the default, and how the demo runs
// locally) means `req.ip` is the direct socket address — the honest value. ON
// makes Express trust `X-Forwarded-For`, which is correct behind a reverse proxy
// and DANGEROUS without one, because any client can then set its own apparent
// address by sending that header. So it is opt-in via env, never assumed.
if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', true)
  console.log('[STARTUP] trust proxy ENABLED — client IP will be read from X-Forwarded-For')
}

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || origin.startsWith('http://localhost')) {
      callback(null, true)
    } else {
      callback(new Error('CORS: origin not allowed'))
    }
  },
}))

// Session 24 — the default 100kb JSON limit is no longer enough. Telemetry
// Capture v2 stores the exact inserted text per keystroke, so a 30s flush is
// now tens of kilobytes of events plus a full per-file snapshot of the
// workspace, and a single large paste can be ~100kb on its own. Exceeding the
// limit was silent from the student's side: Express answered 413 and the whole
// window of exam evidence was dropped. Sized well above the realistic worst
// case (a fast typist for 30s, plus the biggest paste the capture engine will
// store) rather than tuned to the average.
app.use(express.json({ limit: '5mb' }))

// ── Network restriction (Feature 2) ────────────────────────────────────────
// Gates ENTERING an exam: the assignment load, session create/resume and the
// code restore. Policy lives on the CLASS, so the check resolves
// assignment → class and asks one question.
//
// Deliberately NOT on `POST /api/telemetry/submit`. Constraint 2 makes the
// ingest path O(1) — receive chunk, append, return 202 — and adding a class
// lookup to every 30s flush of every student would put a database read on the
// one path that exists to avoid them. The honest consequence, stated in the UI
// and in §7: this stops a student from OPENING an exam off-network; it does not
// evict one whose network changes mid-exam. It is a deterrent, not a perimeter.
//
// `where` is only used for the log line, so a blocked attempt is diagnosable
// (the usual cause is an instructor who forgot to allowlist their own address).
function networkGuard(resolveClassId: (req: Request) => Promise<string | null>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const classId = await resolveClassId(req)
      if (!classId) return next() // nothing to restrict against (legacy/dev flows)

      const klass = await withRetry(() =>
        prisma.class.findUnique({
          where: { id: classId },
          select: { ipRestrictionEnabled: true, allowedIps: true },
        })
      )
      // Toggle OFF short-circuits inside isNetworkAllowed, so an unrestricted
      // class costs one cached lookup and nothing else.
      if (isNetworkAllowed(klass, req.ip)) return next()

      console.log(
        `[NETWORK] blocked ${normalizeIp(req.ip) ?? 'unknown'} on class ${classId} (${req.method} ${req.path})`
      )
      res.status(403).json({
        error: 'Access not permitted from this network',
        detail:
          'This class is restricted to your institution\'s network. ' +
          'If you are on campus and still see this, ask your instructor to add this address.',
        yourIp: normalizeIp(req.ip),
      })
    } catch (err) {
      // A lookup failure must not become a lockout: an outage is not a policy
      // decision, and failing closed here would block an entire cohort from
      // starting an exam because of a transient database blip.
      console.error('[NETWORK] check failed, allowing through:', (err as Error).message)
      next()
    }
  }
}

const classIdOfAssignment = async (assignmentId: unknown): Promise<string | null> => {
  if (typeof assignmentId !== 'string' || assignmentId.length === 0) return null
  const a = await withRetry(() =>
    prisma.assignment.findUnique({ where: { id: assignmentId }, select: { classId: true } })
  )
  return a?.classId ?? null
}

// ── GET /api/network/my-ip ─────────────────────────────────────────────────
// What the server sees this request coming from. Exists so an instructor
// setting up a restriction can add THEIR OWN network without guessing — the
// most common way to lock yourself out is to allowlist the wrong address.
app.get('/api/network/my-ip', requireAuth, (req: Request, res: Response) => {
  res.json({ ip: normalizeIp(req.ip), raw: req.ip ?? null })
})

// ── POST /api/session/create ──────────────────────────────────────────────
// Session identity is (student, ASSIGNMENT) — gap #12.
//
// This used to key on `studentId` alone: any lingering IN_PROGRESS row was
// reused for whatever assignment the student opened next, so their telemetry
// was filed under the WRONG assignmentId, the new assignment's roster read
// NOT_STARTED, and a reload landed on a row that already held a whole other
// exam — the "phantom duplicate" that repeatedly made correct builds look buggy
// during testing.
//
// The rule now, decided by `decideSessionAction` (unit-tested, lib/sessionLifecycle):
//   same student + same assignment, SUBMITTED    → ALREADY_SUBMITTED (locked, never a second attempt)
//   same student + same assignment, IN_PROGRESS  → RESUME the same row (reopen/reload)
//   otherwise                                    → a fresh session
// A row belonging to a DIFFERENT assignment is never a candidate: the lookup
// filters on assignmentId, so it simply isn't in the list. Different assignment
// = different session, always.
//
// ── Race safety (gap #71) ──────────────────────────────────────────────────
// The rule above runs AFTER a SELECT, so it cannot stop two creates that
// overlap: both read "no row exists", both INSERT, and the pair ends up with an
// empty phantom beside the real session. React StrictMode's dev double-mount
// fires exactly that, ~1-3ms apart (observed in the local database as pairs
// sharing createdAt to the millisecond), and a double-clicked link or a retried
// request does the same in production.
//
// The check-and-create is therefore serialized per identity by a Postgres
// ADVISORY transaction lock. Why this and not the alternatives:
//
// - A unique constraint is out (see the schema): live rows already violate
//   one-session-per-pair and they are forensic records of real exams.
// - SERIALIZABLE would work but resolves the conflict by ABORTING one
//   transaction (40001), so it needs a retry loop on top and turns a race into
//   a user-visible failure mode on the exam-open path.
// - An in-process mutex would not survive more than one server process.
//
// An advisory lock is scoped to exactly the pair being created, held only for
// this transaction, released on commit or crash, invisible to every other row,
// and adds nothing to any other path — session create happens once per exam
// open. The second request blocks for the microseconds the first needs, then
// SELECTs again inside the lock, finds the row, and RESUMES it.
app.post(
  '/api/session/create',
  validate(sessionCreateSchema),
  networkGuard((req) => classIdOfAssignment(req.body?.assignmentId)),
  async (req: Request, res: Response) => {
  const { studentId, userId, assignmentId } = req.body
  const hasAssignment = typeof assignmentId === 'string' && assignmentId.length > 0
  const hasUserId = typeof userId === 'string' && userId.length > 0

  // `assignmentId: null` is deliberate on the no-assignment (/legacy) path:
  // "no assignment" is its own bucket, so the dev flow can never adopt a real
  // exam's row — which is the other half of gap #12. The same split applies to
  // the lock key below, so /legacy creates never contend with a real exam's.
  const assignmentClause = hasAssignment
    ? Prisma.sql`"assignmentId" = ${assignmentId}`
    : Prisma.sql`"assignmentId" IS NULL`
  // Who this student is, tolerant of every row shape in the database: a session
  // opened through ExamPage carries userId AND studentId (the username), while
  // the oldest dev rows carry studentId only. Usernames are unique, so matching
  // either identifier is safe and no legacy row is stranded.
  const identityClause = hasUserId
    ? Prisma.sql`("userId" = ${userId} OR "studentId" = ${studentId})`
    : Prisma.sql`"studentId" = ${studentId}`
  // Keyed on studentId rather than userId because studentId is present on EVERY
  // request and every row shape, so two concurrent creates for one student
  // always take the same lock even if one of them omits the userId.
  const createLockKey = `codecep:session-create:${hasAssignment ? assignmentId : ''}:${studentId}`

  try {
    // Scheduled window (Feature 1, wall-clock): the deadline is the assignment's
    // OWN `closesAt` — the same instant for every student — handed back so the
    // exam UI can count down to it instead of doing arithmetic on its own clock.
    // It is display data; the submit route re-derives and re-checks this
    // independently, so a client that ignores or fakes it gains nothing.
    //
    // Note the student's start time is NOT an input any more. That is the whole
    // change: a student who opens the paper late gets less time, exactly as they
    // would in a room with a clock on the wall.
    const schedule = hasAssignment
      ? await withRetry(() =>
          prisma.assignment.findUnique({
            where: { id: assignmentId },
            select: { opensAt: true, closesAt: true },
          })
        )
      : null
    const windowFor = (startedAt: Date) => {
      const w = windowStatusFor(schedule?.opensAt, schedule?.closesAt, Date.now())
      return {
        startedAt: startedAt.getTime(),
        opensAt: w.opensAt,
        closesAt: w.closesAt,
        deadlineAt: w.deadlineAt,
        windowState: w.state,
        windowMinutes: w.windowMinutes,
        // Lets the countdown correct for a skewed client clock (see WindowStatus).
        serverNow: w.serverNow,
      }
    }

    // Everything that decides WHICH row this student is opening happens inside
    // one transaction, behind the advisory lock, so a concurrent create for the
    // same pair waits and then sees this one's row instead of writing a second.
    const outcome = await withRetry(() =>
      prisma.$transaction(async (tx) => {
        // Serialize on the identity, not on the table: two DIFFERENT students
        // creating at the same instant never contend. Released at commit.
        // `$executeRaw`, not `$queryRaw`: the lock function returns void, which
        // Prisma cannot deserialize as a result column.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${createLockKey}, 0))`

        // Raw rather than `findMany` so the telemetry counts come back without
        // dragging every candidate's whole playback_log into Node — the JSONB
        // column holds an entire exam. These counts are what let
        // `decideSessionAction` resume the REAL row rather than a phantom
        // duplicate that happens to sort first (gap #71).
        const existing = await tx.$queryRaw<
          {
            id: string
            status: string
            createdAt: Date
            updatedAt: Date
            windowCount: number
            tier1Count: number
            hasForensics: boolean
            runCount: number
          }[]
        >`
          SELECT id, status, "createdAt", "updatedAt", "runCount",
                 COALESCE(jsonb_array_length(playback_log), 0)::int AS "windowCount",
                 COALESCE(jsonb_array_length(tier1_log), 0)::int    AS "tier1Count",
                 ("forensicsResults" IS NOT NULL)                   AS "hasForensics"
          FROM sessions
          WHERE ${assignmentClause} AND ${identityClause}
          ORDER BY "updatedAt" DESC
        `

        // ALREADY_SUBMITTED applies to real assignments only. The /legacy dev
        // flow has years of submitted student-001 rows behind it, so treating
        // those as a lock would make the dev exam permanently unopenable;
        // there, only an open session is a candidate and the behavior is
        // exactly what it always was.
        const candidates = hasAssignment
          ? existing
          : existing.filter((s) => s.status === 'IN_PROGRESS')
        const decision = decideSessionAction(candidates)

        if (decision.action !== 'CREATE') {
          const row = candidates.find((s) => s.id === decision.sessionId)!
          return { action: decision.action, sessionId: row.id, createdAt: row.createdAt }
        }

        const session = await tx.session.create({
          data: {
            studentId,
            status: 'IN_PROGRESS',
            // Session 22 (part 2): an EMPTY log means "Tier-1 alerts are being
            // recorded for this session, none fired yet". NULL (the column's
            // state for pre-feature rows) means "not recorded" — the report must
            // never confuse the two.
            tier1_log: [],
            // Backward compatible: the hardcoded student-001 dev flow sends neither.
            ...(hasUserId ? { userId } : {}),
            ...(hasAssignment ? { assignmentId } : {}),
          },
          select: { id: true, createdAt: true },
        })
        return { action: 'CREATE' as const, sessionId: session.id, createdAt: session.createdAt }
      })
    )

    if (outcome.action === 'ALREADY_SUBMITTED') {
      debugLog(`[SESSION] ${studentId} already submitted assignment ${assignmentId} (${outcome.sessionId})`)
      res.json({ sessionId: outcome.sessionId, status: 'ALREADY_SUBMITTED', resumed: false })
      return
    }
    if (outcome.action === 'RESUME') {
      debugLog(
        `[SESSION] Resuming session ${outcome.sessionId} for ${studentId}` +
          (hasAssignment ? ` on assignment ${assignmentId}` : ' (no assignment / legacy)')
      )
      // A resumed session keeps its ORIGINAL start, so a refresh cannot restart
      // the clock — reloading the page must never buy a student more time.
      res.json({
        sessionId: outcome.sessionId,
        status: 'RESUMED',
        resumed: true,
        ...windowFor(outcome.createdAt),
      })
      return
    }

    debugLog(
      `[SESSION] Created new session ${outcome.sessionId} for ${studentId}` +
        (hasAssignment ? ` on assignment ${assignmentId}` : '')
    )
    res.json({
      sessionId: outcome.sessionId,
      status: 'CREATED',
      resumed: false,
      ...windowFor(outcome.createdAt),
    })
  } catch (err) {
    if (isTransientDbError(err)) {
      res.status(503).json({ error: 'Service temporarily unavailable, please retry' })
      return
    }
    throw err
  }
  }
)

// ── GET /api/session/:id/restore ───────────────────────────────────────────
// Put the student's code back after a refresh (gap #4).
//
// The restore reads the last FLUSHED workspace out of `playback_log`, NOT a
// browser copy. The database is the source of truth, so what comes back on
// screen is by construction what the forensic record says the student had —
// there is no second store to drift from it, and nothing to reconcile if the
// two ever disagreed. The honest cost is the up-to-30s of typing since the last
// flush, which the client states plainly rather than hiding.
//
// This is DISPLAY state only. It creates no telemetry, and the client seeds the
// editor before Monaco mounts so the restored text is never captured as input
// (see App.jsx / EditorPane's prevCode anchor). The session keeps appending
// telemetry exactly where it left off.
//
// Student-owned: this returns a student's own source code, so it is
// `requireAuth` plus an explicit ownership check — never readable by guessing a
// session id or a username.
app.get(
  '/api/session/:id/restore',
  requireAuth,
  networkGuard(async (req) => {
    const s = await withRetry(() =>
      prisma.session.findUnique({
        where: { id: String(req.params.id) },
        select: { assignment: { select: { classId: true } } },
      })
    )
    return s?.assignment?.classId ?? null
  }),
  async (req: Request, res: Response) => {
  try {
    // The whole log is read to recover each task's latest snapshot. This runs
    // once per exam open (never on a hot path), the same read the replay route
    // already performs.
    const session = await withRetry(() =>
      prisma.session.findUnique({
        where: { id: String(req.params.id) },
        select: { id: true, studentId: true, status: true, userId: true, playback_log: true },
      })
    )
    if (!session) {
      res.status(404).json({ error: 'Session not found' })
      return
    }

    // Ownership. `userId` is the modern link; the fallback covers rows whose
    // identity is only the username (studentId), so a legacy session is
    // restorable by its real owner and by nobody else.
    let owns = Boolean(session.userId && session.userId === req.user!.userId)
    if (!owns) {
      const me = await withRetry(() =>
        prisma.user.findUnique({ where: { id: req.user!.userId }, select: { username: true } })
      )
      owns = Boolean(me && me.username === session.studentId)
    }
    if (!owns) {
      res.status(403).json({ error: 'This is not your session.' })
      return
    }

    // Immune Phase: a submitted session is never restored into an editable
    // state. The client opens it locked; this is the backstop, not the guard.
    if (session.status !== 'IN_PROGRESS') {
      res.json({
        sessionId: session.id,
        status: session.status,
        restorable: false,
        taskSnapshots: {},
        restoredFrom: null,
        lastActive: null,
        windowCount: 0,
      })
      return
    }

    const payload = buildRestorePayload(session.playback_log)
    debugLog(
      `[RESTORE] session ${session.id} — ${Object.keys(payload.taskSnapshots).length} task(s)` +
        ` from ${payload.windowCount} window(s)`
    )
    res.json({ sessionId: session.id, status: session.status, restorable: true, ...payload })
  } catch (err) {
    if (isTransientDbError(err)) {
      res.status(503).json({ error: 'Service temporarily unavailable, please retry' })
      return
    }
    throw err
  }
  }
)

// ── POST /api/telemetry/submit ─────────────────────────────────────────────
// Session 24 (Telemetry Capture v2) — events now also carry WHAT changed and
// WHERE, plus which file they belong to. The size-only fields are unchanged so
// every existing metric keeps working; the v2 fields are all optional so a
// pre-v2 client, and every session already in the database, stay valid.
interface KeystrokeEvent {
  timestamp: number
  timeSinceLastKeystrokeMs: number
  actionType: 'type' | 'paste' | 'delete'
  charDelta: number
  textLength: number
  fileName?: string | null
  rangeOffset?: number
  rangeLength?: number
  insertedText?: string
  changes?: { o: number; d: number; t: string }[]
  /** Multi-task exams (Prompt 1) — absent means the single default task. */
  taskId?: string | null
}

app.post('/api/telemetry/submit', validate(telemetrySubmitSchema), async (req: Request, res: Response) => {
  const { sessionId, chunk, codeSnapshot, fileSnapshots, taskSnapshots, engagedTimeMs } = req.body

  if (!Array.isArray(chunk) || chunk.length === 0) {
    res.status(400).json({ error: 'Invalid payload: sessionId and non-empty chunk are required.' })
    return
  }

  const events: KeystrokeEvent[] = chunk

  const playbackEntry = {
    flushedAt: Date.now(),
    // The ACTIVE buffer, kept for pre-v2 readers.
    codeSnapshot: codeSnapshot ?? '',
    // The WHOLE workspace — the source of truth from v2 onward. Absent on a
    // pre-v2 payload, which readers treat as a single default file.
    ...(fileSnapshots && typeof fileSnapshots === 'object' ? { fileSnapshots } : {}),
    // Multi-task (Prompt 1): EVERY task's workspace, not just the active one.
    // Without this a task the student left early would only ever be visible
    // through the snapshot of whichever window happened to be active, so its
    // final files — the authorship denominator — could not be recovered.
    // Absent on a single-task/pre-multi-task payload, which readers present as
    // one default task.
    ...(taskSnapshots && typeof taskSnapshots === 'object' ? { taskSnapshots } : {}),
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

  // Live DVR (Session 28): nudge anyone watching to re-read the durable record
  // and reconcile it against their live tail. AFTER the response and only when
  // someone is actually watching, so the ingest path stays the O(1) append
  // Constraint 2 requires — this is a room emit on an in-memory registry, and
  // on the overwhelmingly common unwatched session it is a single Map lookup.
  announceFlush(io, watchRegistry, sessionId)
})

// ── POST /api/session/:id/submit ──────────────────────────────────────────
app.post('/api/session/:id/submit', async (req: Request, res: Response) => {
  const sessionId = String(req.params.id)
  try {
    // ── Scheduled submission window (Feature 1, wall-clock) ────────────────
    // THE security-critical check, and it lives here — before the status flip —
    // for two reasons: a rejected submission must leave the session IN_PROGRESS
    // (the student is not locked out of a window that is still open for an
    // instructor to extend), and the verdict must be computed from the SERVER's
    // clock against the assignment's own scheduled instants. The exam UI's
    // countdown is a convenience; nothing the client sends is consulted here, so
    // a fiddled system clock cannot widen the window.
    //
    // The student's start time is deliberately NOT read: the schedule is shared,
    // so every student sitting this paper is judged against the same close time.
    // Unscheduled assignments (both columns null — every existing one) skip this
    // entirely and behave exactly as before.
    const existing = await withRetry(() =>
      prisma.session.findUnique({
        where: { id: sessionId },
        select: {
          id: true,
          status: true,
          createdAt: true,
          assignment: { select: { opensAt: true, closesAt: true } },
        },
      })
    )
    if (existing?.status === 'IN_PROGRESS') {
      const now = Date.now()
      const window = windowStatusFor(existing.assignment?.opensAt, existing.assignment?.closesAt, now)
      if (!isSubmitAllowed(window)) {
        if (window.state === 'pending') {
          const until = minutesUntilOpen(window, now)
          console.log(
            `[SUBMIT] Session ${sessionId} REJECTED — window not open yet (${until} min away)`
          )
          res.status(403).json({
            error: 'Submission window not open yet',
            detail:
              `This exam opens at ${new Date(window.opensAt!).toLocaleString()}` +
              ` (${until} minute(s) away).`,
            opensAt: window.opensAt,
            closesAt: window.closesAt,
          })
          return
        }
        const late = minutesLate(window, now)
        console.log(
          `[SUBMIT] Session ${sessionId} REJECTED — submission window closed (${late} min late)`
        )
        res.status(403).json({
          error: 'Submission window closed',
          detail:
            `This exam closed at ${new Date(window.closesAt!).toLocaleString()}, ` +
            `${late > 0 ? `${late} minute(s) ago` : 'just now'}. Contact your instructor.`,
          deadlineAt: window.deadlineAt,
          closesAt: window.closesAt,
          windowMinutes: window.windowMinutes,
        })
        return
      }
    }

    const session = await withRetry(() =>
      prisma.session.update({
        where: { id: sessionId, status: 'IN_PROGRESS' },
        data: { status: 'SUBMITTED' },
      })
    )
    await telemetryQueue.add('forensics', { sessionId: session.id })
    console.log(`[SUBMIT] Session ${session.id} → SUBMITTED, forensics job enqueued`)
    res.status(200).json({ status: 'SUBMITTED' })
    // Live DVR (Session 28): an instructor watching this student is now waiting
    // on keystrokes that will never arrive, because the Immune Phase disarmed
    // streaming client-side the moment Submit was pressed. Telling them
    // explicitly is what turns that into a clean transition to the final
    // recorded session instead of a live view that silently stops moving.
    announceSessionEnd(io, watchRegistry, session.id)
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
      // Session 24: the whole workspace at this flush. Undefined on pre-v2
      // sessions — the replay engine falls back to the single codeSnapshot.
      fileSnapshots: entry.fileSnapshots ?? null,
      // Multi-task (Prompt 1): every task's workspace at this flush. Null on
      // single-task and pre-multi-task sessions, which the replay engine reads
      // exactly as it did before.
      taskSnapshots: entry.taskSnapshots ?? null,
      eventCount: Array.isArray(entry.events) ? entry.events.length : 0,
    }))
    const events = log.flatMap((entry) => (Array.isArray(entry.events) ? entry.events : []))

    res.json({
      sessionId: session.id,
      studentId: session.studentId,
      status: session.status,
      forensicsResults: session.forensicsResults,
      // Prompt 2 — the merged report header reads "student · assignment ·
      // N tasks". Both are already loaded for the ownership check above, so
      // this costs nothing. `taskCount` falls back to the forensics record and
      // then to 1, so legacy sessions with no assignment still read sensibly.
      assignmentTitle: session.assignment?.title ?? null,
      // LIVE_LAB vs ASSESSMENT. The DVR gates the signals that carry no meaning
      // on a take-home (tab-outs, compile count) on this. Falls back to the type
      // recorded by the worker, then to null = show everything, which is the
      // pre-existing behavior for a session with no recorded type.
      assignmentType:
        session.assignment?.type ??
        (session.forensicsResults as { assignmentType?: string | null } | null)?.assignmentType ??
        null,
      taskCount:
        session.assignment?.taskCount ??
        (session.forensicsResults as { taskCount?: number } | null)?.taskCount ??
        1,
      startedAt: events[0]?.timestamp ?? session.createdAt.getTime(),
      endedAt: events[events.length - 1]?.timestamp ?? session.updatedAt.getTime(),
      // Session 22 (part 2): when the exam was OPENED, as distinct from when
      // the first keystroke landed. The replay needs it to show an empty
      // document before the first event — otherwise a first-event paste is
      // already on screen at t=0 and is never seen arriving.
      openedAt: session.createdAt.getTime(),
      tier1Summary: summariseTier1(session.tier1_log, session.playback_log),
      // Fix 3 — the raw Tier-1 record, so the DVR scrubber can place a tick at
      // the MOMENT each tab-out / AST violation happened rather than only
      // reporting a count. NULL (not []) when the session predates the log, so
      // the player can say "not recorded" instead of drawing an empty timeline
      // that looks like "nothing happened" — the same discipline tier1Summary
      // already follows.
      tier1Events: tier1EventsFor(session.tier1_log),
      snapshots,
      events,
    })
  }
)

// ── POST /api/ast/validate ─────────────────────────────────────────────────
// The baseline set moved to ast/allowlist.ts, where it is now UNIONED into
// every resolved week list rather than only used as the no-syllabus fallback.
// Read the header comment there before changing it: a real stored class
// allowlist was missing `namespace_identifier`, which made the perfectly valid
// `std::cout` style raise violations against honest students.
// Control-flow constructs (for_statement / while_statement / do_statement) stay
// deliberately ABSENT from the baseline — they must still flag. ERROR/MISSING
// are not listed either: the walker in ast/parser.ts drops them so mid-typing
// parse states never raise violations.
const week1Allowlist = BASELINE_ALLOWLIST

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

// Shared allowlist resolution — used by the live /api/ast/validate route AND
// by the submit-time audit in the forensics worker, so both judge a file
// against exactly the same construct set.
// A `function` declaration (not a const arrow) so the worker, which is defined
// earlier in this file, can call it; it only reads week1Allowlist at call time.
//
// EVERY return path goes through `withBaseline()`. That is the whole of Fix 1:
// a class allowlist is a set of TAUGHT constructs layered on top of mandatory
// C++ boilerplate, never a replacement for it. Gemini is still asked to include
// the baseline and an instructor still edits the list — but neither is trusted
// to get it right, because in the live database neither did.
async function resolveAllowlistFor(
  assignmentId: string | null | undefined,
): Promise<{ list: string[]; source: string }> {
  if (typeof assignmentId !== 'string' || assignmentId.length === 0) {
    return { list: withBaseline(null), source: 'default' }
  }
  try {
    const assignment = await prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: { class: true },
    })
    if (assignment?.class?.allowlist) {
      const resolved = resolveWeekAllowlist(assignment.class.allowlist, assignment.week)
      if (resolved) {
        return {
          list: withBaseline(resolved),
          source: `class allowlist week${assignment.week} + baseline`,
        }
      }
    }
  } catch (err) {
    console.error('[AST] Allowlist lookup failed — using default:', err instanceof Error ? err.message : err)
  }
  return { list: withBaseline(null), source: 'default' }
}

// ── Submit-time AST audit over EVERY code file (Session 24, Change B2) ──────
// Live validation only ever sees the ACTIVE buffer, so before v2 a forbidden
// construct could sit in an unfocused file and never be checked. EditorPane now
// validates a file when the student switches away from it, and this is the
// backstop: at submit, every .cpp/.h in the final workspace is parsed. Data
// files are never parsed — the C++ grammar would report prose as violations.
// Result is stored on forensicsResults for instructor review; like every other
// metric it is a signal, not a verdict.
//
// Multi-task (Prompt 1): takes a workspace map rather than the raw playback log,
// so the SAME function audits one task's files and the whole session's. All
// tasks share one allowlist (the assignment's week), so nothing about the
// judgement changes — only which files are handed in.
async function auditCodeFiles(snapshots: Record<string, string>, assignmentId: string | null) {
  const codeFiles = Object.entries(snapshots).filter(
    ([name, text]) => isCodeFileName(name) && typeof text === 'string' && text.trim().length > 0,
  )
  if (codeFiles.length === 0) {
    return {
      checkedFiles: [],
      violations: [],
      violationSummary: summariseViolations([]),
      violationCount: 0,
      flag: false,
      allowlistSource: 'none',
      reason: null,
    }
  }

  const { list, source } = await resolveAllowlistFor(assignmentId)
  const violations: { fileName: string; nodeType: string; line: number; column: number; snippet: string }[] = []

  for (const [fileName, text] of codeFiles) {
    try {
      const result = await validateAST(text, list)
      for (const v of result.violations) violations.push({ fileName, ...v })
    } catch (err) {
      console.error(`[FORENSICS] AST audit failed for ${fileName}:`, err instanceof Error ? err.message : err)
    }
  }

  const flag = violations.length > 0
  // Fix 2 — the stored record names the constructs, so an instructor reading a
  // submitted session sees "used for_statement (line 12)" rather than a count
  // they cannot act on. `violations` is unchanged; both fields below are added.
  const violationSummary = summariseViolations(violations)
  // The COUNT an instructor reads must be the number of constructs actually
  // LISTED beside it. The walker now reports one finding per top-most disallowed
  // construct, and `distinct` collapses the remaining case where two of the same
  // construct sit on one line — so this is exactly what `describeViolations`
  // enumerates. Reporting `violations.length` here instead would let the number
  // and the list disagree again, which is the confusion this fix exists to end.
  const violationCount = violationSummary.distinct
  return {
    checkedFiles: codeFiles.map(([name]) => name),
    violations,
    violationSummary,
    violationCount,
    flag,
    allowlistSource: source,
    reason: flag
      ? `Used ${describeViolations(violationSummary)} — ${violationCount} construct(s) across ` +
        `${new Set(violations.map((v) => v.fileName)).size} file(s); construct(s) not permitted for ` +
        `this week. Probabilistic signal requiring instructor review.`
      : null,
  }
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
  // Shared with the submit-time audit so both judge against the same set.
  const { list: allowlist, source: allowlistSource } = await resolveAllowlistFor(assignmentId)

  const result = await validateAST(code, allowlist)

  // Fix 2 — say WHICH construct, and where. `violations` keeps its exact
  // existing shape (full list, every occurrence) so nothing that already reads
  // it changes; `violationSummary` is the de-duplicated, capped version and
  // `violationDetail` is the ready-made sentence the client puts straight into
  // the AST_VIOLATION alert. Formatting lives here so the alert text, the
  // instructor report and the server log cannot word the same finding three
  // different ways.
  const violationSummary = summariseViolations(result.violations)
  const violationDetail = describeViolations(violationSummary)

  debugLog(
    `[AST] Validated ${result.violations.length} violation(s) — isValid: ${result.isValid} ` +
      `(allowlist: ${allowlistSource})${result.isValid ? '' : ` — ${violationDetail}`}`
  )
  res.status(200).json({ ...result, violationSummary, violationDetail })
})

// ── POST /api/execute ─────────────────────────────────────────────────────
// Judge0 is a SUBMISSION model: source + all stdin go up together and the
// program runs to completion. That is why the exam console takes batch stdin
// (Session 21) — a reactive TTY would need a persistent sandboxed VM per
// student, which is out of scope. Returns the Judge0 streams SEPARATELY so the
// client console can style stdout / stderr / compile output distinctly.
//
// Session 23 — TWO shapes are accepted:
//   • { files: [{name, content}], stdin?, sessionId? }  → MULTI-FILE. Packaged
//     as a Judge0 "Multi-file program" (language 89): the workspace goes up as
//     a zip in additional_files, `g++ -std=c++17 -o main *.cpp` links every
//     source together, and data files are present in the working directory for
//     fstream. Files the program WRITES come back in `outputFiles`.
//   • { code, lang?, stdin?, sessionId? }               → LEGACY single source,
//     language 54/50, byte-for-byte the pre-Session-23 behavior. Kept so the
//     /legacy flow and any older caller keep working unchanged.
const STDIN_MAX_CHARS = 100_000

// A run is attributed to a task only when the client names one it could
// actually have produced. Anything else is treated as an unattributed run: it
// still counts in the session total, it just never invents a task key.
const TASK_ID_PATTERN = /^task[1-6]$/

// ── The ONE Judge0 call ────────────────────────────────────────────────────
// Extracted verbatim from POST /api/execute so a SECOND entry point (the
// instructor running a submitted session's code, below) can feed it stored
// code instead of a live workspace without a second copy of the execution
// logic. Nothing about the execution model changed: same endpoint, same
// language ids, same base64 round-trip, same zip packaging, same sentinel
// peeling, same response shape.
//
// Deliberately does NOT touch the database. Run counting is the CALLER's
// business — that is what keeps a student's run countable and an instructor's
// review run side-effect-free, without either path having to remember a flag.
type ExecutionOutcome = {
  httpStatus: number
  body: Record<string, unknown>
  /** For the caller's log line; null when the call never produced a Judge0 status. */
  statusDescription: string | null
  outputFileCount: number
}

async function executeOnJudge0(input: {
  /** Multi-file workspace (language 89), or null for the legacy single-source path. */
  workspace: WorkspaceFile[] | null
  code?: string
  lang?: string
  stdin?: string
}): Promise<ExecutionOutcome> {
  const { workspace, code, lang, stdin } = input
  const isMultiFile = workspace !== null
  // 89 = "Multi-file program": Judge0 ignores source_code and drives the
  // archive's own compile/run scripts instead.
  const languageId = isMultiFile ? 89 : lang === 'c' ? 50 : 54

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
          source_code: isMultiFile ? '' : Buffer.from(code ?? '', 'utf8').toString('base64'),
          language_id: languageId,
          ...(isMultiFile
            ? {
                additional_files: buildZip([
                  ...workspace,
                  { name: 'compile', content: buildCompileScript() },
                  { name: 'run', content: buildRunScript() },
                ]).toString('base64'),
              }
            : {}),
          // Judge0 feeds these lines to the program's cin/scanf reads in order.
          ...(typeof stdin === 'string' && stdin.length > 0
            ? { stdin: Buffer.from(stdin, 'utf8').toString('base64') }
            : {}),
        }),
      }
    )

    if (!judge0Res.ok) {
      const message = `Judge0 error — HTTP ${judge0Res.status}. Try again shortly.`
      return {
        httpStatus: 502,
        body: { output: message, stderr: message, status: 'Execution service error' },
        statusDescription: null,
        outputFileCount: 0,
      }
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

    // Multi-file runs append the working directory's data files to stdout
    // inside sentinels (that is how written files get out of Judge0 at all).
    // Peel that block off BEFORE anything else looks at stdout, so the student
    // sees only what their program actually printed.
    let outputFiles: CapturedFile[] = []
    if (isMultiFile) {
      const { programStdout, captured } = splitCapturedFiles(data.stdout)
      data.stdout = programStdout
      outputFiles = selectWrittenFiles(workspace, captured)
    }

    // Legacy single-string field kept for backward compatibility.
    const output = data.compile_output || data.stderr || data.stdout || '(no output)'

    return {
      httpStatus: 200,
      body: {
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
        // Files the program created or modified. Always present (empty for the
        // legacy single-source path) so the client needs no shape check.
        outputFiles,
      },
      statusDescription: data.status?.description ?? 'unknown',
      outputFileCount: outputFiles.length,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return {
      httpStatus: 502,
      body: {
        output: `Failed to reach Judge0 — ${message}`,
        stderr: `Failed to reach Judge0 — ${message}`,
        status: 'Execution service unreachable',
      },
      statusDescription: null,
      outputFileCount: 0,
    }
  }
}

app.post('/api/execute', async (req: Request, res: Response) => {
  // Multi-task (Prompt 1): `taskId` names which task's workspace this is — the
  // client only ever sends the ACTIVE task's files, so each task compiles and
  // runs as the separate program it is. Prompt 2 (gap #29): that id is now also
  // what makes Metric A per-task — the run is counted against this task in
  // `runCountByTask` as well as in the session total.
  const { code, lang, sessionId, stdin, files, taskId } = req.body

  const isMultiFile = files !== undefined

  if (isMultiFile) {
    const problem = validateWorkspace(files)
    if (problem) {
      res.status(400).json({ error: problem })
      return
    }
  } else if (typeof code !== 'string' || code.trim().length === 0) {
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

  const workspace: WorkspaceFile[] = isMultiFile ? files : []

  const result = await executeOnJudge0({
    workspace: isMultiFile ? workspace : null,
    code,
    lang,
    stdin,
  })

  debugLog(
    `[EXECUTE] ${typeof taskId === 'string' && taskId.length > 0 ? `${taskId} ` : ''}` +
    `${isMultiFile ? `multi-file(${workspace.length})` : `lang=${lang ?? 'cpp'}`} ` +
    `stdin=${typeof stdin === 'string' ? stdin.length : 0}ch ` +
    `→ status=${result.statusDescription ?? 'unreachable'} outputFiles=${result.outputFileCount}`
  )

  if (result.httpStatus !== 200) {
    res.status(result.httpStatus).json(result.body)
    return
  }

  // Increment runCount so Metric A has an accurate compile count.
  // Prompt 2: also attribute the run to the task it belonged to, in ONE
  // statement so the session total and the per-task breakdown can never drift
  // apart. `runCount` keeps its exact existing meaning (the session total).
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    const runTaskId = typeof taskId === 'string' && TASK_ID_PATTERN.test(taskId) ? taskId : null
    try {
      // Retried like the other exam hot paths: a Neon idle-drop used to make
      // the count silently short, and now that Metric A is assessed PER TASK
      // a lost run is a wrong per-task reading, not just a smaller total.
      // Still non-fatal — the student's program already ran, so a failure is
      // logged and the response is unaffected.
      await withRetry(async () => {
        if (runTaskId) {
          // COALESCE covers both a session that predates the column (NULL)
          // and a task being run for the first time (key absent).
          await prisma.$executeRaw`
            UPDATE sessions
            SET "runCount"       = "runCount" + 1,
                "runCountByTask" = jsonb_set(
                  COALESCE("runCountByTask", '{}'::jsonb),
                  ARRAY[${runTaskId}::text],
                  to_jsonb(COALESCE(("runCountByTask" ->> ${runTaskId}::text)::int, 0) + 1)
                ),
                "updatedAt"      = NOW()
            WHERE id = ${sessionId}
          `
        } else {
          // No usable task id (the /legacy flow, an older client): the run
          // still counts in the session total, but no task key is invented.
          await prisma.session.update({
            where: { id: sessionId },
            data: { runCount: { increment: 1 } },
          })
        }
      })
    } catch (err) {
      // The session may simply not exist (tests, a stale id) — that is not
      // worth a stack trace, but a dropped run must not be invisible either.
      console.warn(
        `[EXECUTE] run count not recorded for session ${sessionId}` +
        `${runTaskId ? ` (${runTaskId})` : ''}: ${err instanceof Error ? err.message : err}`
      )
    }
  }

  res.status(200).json(result.body)
})

// ── POST /api/sessions/:sessionId/run ──────────────────────────────────────
// The instructor runs a SUBMITTED student's code, for review.
//
// A forensic report tells an instructor HOW the code was written; it says
// nothing about whether it works. This is the second question, answered with
// the code the student actually submitted and — optionally — inputs the student
// never tried.
//
// It is a SECOND ENTRY POINT into the existing execution path, not a second
// execution path: the same `executeOnJudge0` the student's Run Code button
// reaches, the same language 89 multi-file packaging, the same stdin model, the
// same sentinel peeling, the same response shape. The only differences are
// where the code comes from (stored snapshots, not a live editor) and what
// happens afterwards (nothing).
//
// READ-ONLY, and deliberately so by CONSTRUCTION rather than by discipline:
// this handler contains no write of any kind. No telemetry, no playback_log, no
// tier1_log, no forensics, and — the one that would silently corrupt a metric —
// no `runCount` / `runCountByTask` increment. Metric A is a count of the
// STUDENT's compiles; an instructor pressing Run five times while marking must
// never move it. The session row is read and never touched.
//
// SUBMITTED only. The stored snapshot of an in-progress session is a partial
// draft up to the last flush, so running it would show the instructor a program
// the student may be mid-way through writing and report its errors as if they
// were the submission's. Same discipline as the recorded replay, which is also
// a post-submission artifact.
app.post(
  '/api/sessions/:sessionId/run',
  requireAuth,
  requireRole('INSTRUCTOR'),
  async (req: Request, res: Response) => {
    const sessionId = String(req.params.sessionId)
    const { taskId, stdin } = req.body ?? {}

    if (stdin !== undefined && stdin !== null && typeof stdin !== 'string') {
      res.status(400).json({ error: '"stdin" must be a string when present.' })
      return
    }
    if (typeof stdin === 'string' && stdin.length > STDIN_MAX_CHARS) {
      res.status(400).json({ error: `"stdin" exceeds ${STDIN_MAX_CHARS} characters.` })
      return
    }

    // The SAME ownership rule as /replay and the metric reviews — an instructor
    // may only act on sessions in a class they own. Reused rather than
    // re-implemented so the three cannot drift into three different answers.
    const { session, owns } = await instructorOwnsSession(sessionId, req.user!.userId)
    if (!session) {
      res.status(404).json({ error: 'Session not found' })
      return
    }
    if (!owns) {
      res.status(403).json({ error: 'You do not own this class.' })
      return
    }
    if (session.status !== 'SUBMITTED') {
      res.status(409).json({
        error: 'Submitted code can only be run after the student submits.',
        status: session.status,
      })
      return
    }

    // The workspaces the session actually recorded. `finalTaskSnapshots` is the
    // SAME selector the forensics worker and the restore route use, so what the
    // instructor runs is by construction what the record says was submitted —
    // including a pre-multi-task session, which it presents as a single `task1`.
    const selection = selectTaskWorkspace(finalTaskSnapshots(session.playback_log), taskId)
    if (!selection.ok) {
      res.status(400).json({ error: selection.error })
      return
    }

    // Re-validated with the student path's own rules. The snapshot is data read
    // back OUT of the database, and a workspace with no main.cpp cannot be
    // compiled by the globbed build — saying that beats a bare linker error.
    const problem = validateWorkspace(selection.files)
    if (problem) {
      res.status(400).json({ error: `Stored workspace cannot be executed — ${problem}` })
      return
    }

    const result = await executeOnJudge0({
      workspace: selection.files,
      stdin: typeof stdin === 'string' ? stdin : undefined,
    })

    // Logged as its own kind so an instructor review run is never mistaken for
    // a student run when reading the logs either.
    debugLog(
      `[INSTRUCTOR-RUN] session ${sessionId} ${selection.taskId} ` +
      `files=${selection.files.length} stdin=${typeof stdin === 'string' ? stdin.length : 0}ch ` +
      `→ status=${result.statusDescription ?? 'unreachable'} outputFiles=${result.outputFileCount} ` +
      `(no telemetry, runCount untouched)`
    )

    // NO database write of any kind here. See the header comment.
    res.status(result.httpStatus).json({
      ...result.body,
      // Echoed so the console can name what it just ran — on a multi-task
      // session the instructor needs to see WHICH task's program produced this.
      taskId: selection.taskId,
      files: selection.files.map((f) => f.name),
      // Stated in the payload as well as the UI: this execution changed nothing
      // about the student's record.
      readOnly: true,
    })
  }
)

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
    // Multi-task exams (Prompt 1). Absent / unparseable → 1, i.e. exactly the
    // single-task exam this route has always created.
    const taskCount = Number.parseInt(req.body.taskCount, 10)
    // ── Scheduled window (Feature 1, wall-clock) ──────────────────────────
    // Absent / blank → NULL = unscheduled, which is what every assignment
    // created before this feature is. The Zod schema has already rejected an
    // unparseable date; this decides present-vs-absent and applies the one
    // convenience: an opening instant plus a duration computes the close.
    const parseWhen = (v: unknown): Date | null => {
      if (typeof v !== 'string' || v.trim() === '') return null
      const ms = Date.parse(v)
      return Number.isFinite(ms) ? new Date(ms) : null
    }
    const windowMinutesIn = Number.parseInt(req.body.windowMinutes, 10)
    const opensAt = parseWhen(req.body.opensAt)
    const closesAt =
      parseWhen(req.body.closesAt) ??
      closesAtFrom(opensAt, Number.isFinite(windowMinutesIn) ? windowMinutesIn : null)

    const klass = await prisma.class.findUnique({ where: { id: classId } })
    if (!klass) {
      res.status(404).json({ error: 'Class not found.' })
      return
    }
    if (klass.instructorId !== req.user!.userId) {
      res.status(403).json({ error: 'You do not own this class.' })
      return
    }

    // Refused rather than silently ignored: an instructor who typed the times the
    // wrong way round means to schedule something, and storing a window that can
    // never be open would close the exam for a whole cohort.
    if (opensAt && closesAt && closesAt.getTime() <= opensAt.getTime()) {
      res.status(400).json({
        error: 'Validation failed',
        details: [{ field: 'closesAt', message: 'The closing time must be after the opening time.' }],
      })
      return
    }

    const assignment = await prisma.assignment.create({
      data: {
        classId,
        title: title.trim(),
        type,
        week: Number.isFinite(week) && week > 0 ? week : 1,
        taskCount: Number.isFinite(taskCount) && taskCount >= 1 && taskCount <= 6 ? taskCount : 1,
        opensAt,
        closesAt,
        // Stored for display only, and DERIVED from the schedule so it can never
        // disagree with the instants that are actually enforced.
        windowMinutes: windowMinutesBetween(opensAt, closesAt),
        assignmentPdfFilename: req.file?.filename ?? null,
      },
    })
    console.log(
      `[ASSIGNMENT] Created "${assignment.title}" (${assignment.type}, week ${assignment.week},` +
        ` ${assignment.taskCount} task(s), ` +
        (assignment.closesAt || assignment.opensAt
          ? `scheduled ${assignment.opensAt?.toISOString() ?? 'any time'} → ` +
            `${assignment.closesAt?.toISOString() ?? 'no close'}`
          : 'unscheduled') +
        `) in class ${classId}`
    )
    res.status(201).json(assignment)
  }
)

// ── PATCH /api/assignments/:id ─────────────────────────────────────────────
// Gap #52. Before this the schedule could only be set at CREATION, so the one
// thing an instructor most plausibly needs mid-sitting — "give the cohort
// another fifteen minutes" — could not be done through the API at all.
//
// This works BECAUSE the window is wall-clock (§7.3b): `closesAt` is a single
// instant shared by the cohort and read from the database on every submit, so
// moving it moves the deadline for every in-progress student at once, with no
// per-session state to update and no notion of a per-student extension being
// introduced. The countdown follows for the same reason — the client re-reads
// the schedule from the server, which is the only authority.
//
// Which fields are editable is a conservative judgement, not a shortcut:
//   - `closesAt` / `title` — always safe; neither changes how a recorded
//     session is interpreted.
//   - `opensAt` — a schedule bound like any other. Moving it does not retime
//     anyone's work, because a student's start time was never an input.
//   - `taskCount` — STRUCTURAL. Telemetry is filed under `task1`…`taskN`, so
//     lowering it would orphan a task's recorded keystrokes and raising it
//     would present a task no session has a workspace for. Refused outright
//     once ANY session exists for the assignment.
//   - `type` — not editable at all (see `updateAssignmentSchema`).
// The PDF is not replaced here either: swapping the question sheet under a
// sitting in progress is a different, riskier operation than adjusting a clock.
app.patch(
  '/api/assignments/:id',
  requireAuth,
  requireRole('INSTRUCTOR'),
  validate(updateAssignmentSchema),
  async (req: Request, res: Response) => {
    const id = String(req.params.id)
    const assignment = await prisma.assignment.findUnique({
      where: { id },
      include: { class: true },
    })
    if (!assignment) {
      res.status(404).json({ error: 'Assignment not found.' })
      return
    }
    // The SAME ownership rule the create route applies, one level up the chain:
    // the assignment's class must belong to the requester.
    if (assignment.class.instructorId !== req.user!.userId) {
      res.status(403).json({ error: 'You do not own this assignment.' })
      return
    }

    const body = req.body as Record<string, unknown>
    const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k)

    // Absent = leave alone. Present-but-empty = clear this bound (un-schedule
    // that side of the window). The two are genuinely different intents, so a
    // PATCH must be able to express both.
    const parseWhen = (v: unknown): Date | null => {
      if (typeof v !== 'string' || v.trim() === '') return null
      const ms = Date.parse(v)
      return Number.isFinite(ms) ? new Date(ms) : null
    }

    const opensAt = has('opensAt') ? parseWhen(body.opensAt) : assignment.opensAt
    const windowMinutesIn = Number.parseInt(String(body.windowMinutes ?? ''), 10)
    let closesAt = has('closesAt') ? parseWhen(body.closesAt) : assignment.closesAt
    // Same convenience as create: a duration with an opening instant computes
    // the close. Only consulted when no explicit close was sent, so an explicit
    // `closesAt` always wins over a derived one.
    if (!has('closesAt') && Number.isFinite(windowMinutesIn)) {
      closesAt = closesAtFrom(opensAt, windowMinutesIn)
    }

    // Refused for exactly the reason the create route refuses it: a window that
    // can never be open would reject every submission for a whole cohort.
    if (opensAt && closesAt && closesAt.getTime() <= opensAt.getTime()) {
      res.status(400).json({
        error: 'Validation failed',
        details: [
          { field: 'closesAt', message: 'The closing time must be after the opening time.' },
        ],
      })
      return
    }

    // Structural guard. Checked against SESSIONS EXISTING, not against sessions
    // being in progress: a submitted session's per-task forensics are already
    // computed against the task ids it recorded, and changing the count would
    // make the stored report describe an exam shape that no longer exists.
    const data: Prisma.AssignmentUpdateInput = {}
    if (has('taskCount')) {
      const taskCount = Number.parseInt(String(body.taskCount), 10)
      if (Number.isFinite(taskCount) && taskCount !== assignment.taskCount) {
        const sessionCount = await prisma.session.count({ where: { assignmentId: id } })
        if (sessionCount > 0) {
          res.status(409).json({
            error: 'Cannot change the number of tasks',
            detail:
              `${sessionCount} session(s) already exist for this assignment. Task telemetry is` +
              ' recorded per task, so changing the count would orphan or invent per-task data.',
            sessionCount,
            taskCount: assignment.taskCount,
          })
          return
        }
        data.taskCount = taskCount
      }
    }

    if (has('title') && typeof body.title === 'string') data.title = body.title.trim()
    if (has('week')) {
      const week = Number.parseInt(String(body.week), 10)
      if (Number.isFinite(week) && week > 0) data.week = week
    }
    if (has('opensAt')) data.opensAt = opensAt
    if (has('closesAt') || (!has('closesAt') && Number.isFinite(windowMinutesIn))) {
      data.closesAt = closesAt
    }
    // Re-DERIVED from the schedule that will actually be enforced, never taken
    // from the request — the displayed duration must not be able to disagree
    // with the stored instants.
    data.windowMinutes = windowMinutesBetween(opensAt, closesAt)

    const updated = await prisma.assignment.update({ where: { id }, data })
    console.log(
      `[ASSIGNMENT] Updated "${updated.title}" (${id}) — ` +
        (updated.closesAt || updated.opensAt
          ? `scheduled ${updated.opensAt?.toISOString() ?? 'any time'} → ` +
            `${updated.closesAt?.toISOString() ?? 'no close'}`
          : 'unscheduled') +
        `, ${updated.taskCount} task(s)`
    )
    // The window state is returned alongside, computed on the SERVER's clock —
    // the same source the submit check uses, so the instructor sees the state
    // their students are actually in.
    const status = windowStatusFor(updated.opensAt, updated.closesAt, Date.now())
    res.json({ ...updated, windowState: status.state, serverNow: status.serverNow })
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
app.get(
  '/api/assignments/:id',
  requireAuth,
  networkGuard((req) => classIdOfAssignment(req.params.id)),
  async (req: Request, res: Response) => {
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
  }
)

// ── PUT /api/classes/:classId/network (Feature 2) ──────────────────────────
// The instructor-confirmed network policy. Instructor-only, ownership-checked,
// same shape as the allowlist route: a human sets it, nothing is inferred.
//
// Two validations exist to stop an instructor locking out their own cohort:
// every entry must parse as an address or CIDR range, and enabling the
// restriction with an EMPTY list is refused outright (that combination denies
// everyone — see `isIpAllowed`, which fails closed by design).
app.put('/api/classes/:classId/network', requireAuth, requireRole('INSTRUCTOR'), async (req: Request, res: Response) => {
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

  const { ipRestrictionEnabled, allowedIps } = req.body ?? {}
  if (typeof ipRestrictionEnabled !== 'boolean') {
    res.status(400).json({ error: 'ipRestrictionEnabled must be true or false.' })
    return
  }
  if (!Array.isArray(allowedIps)) {
    res.status(400).json({ error: 'allowedIps must be an array of addresses or CIDR ranges.' })
    return
  }
  const cleaned: string[] = []
  for (const entry of allowedIps) {
    if (typeof entry !== 'string') {
      res.status(400).json({ error: 'Every allowlist entry must be a string.' })
      return
    }
    const problem = validateIpRule(entry)
    if (problem) {
      res.status(400).json({ error: `"${entry}" — ${problem}` })
      return
    }
    const trimmed = entry.trim()
    if (!cleaned.includes(trimmed)) cleaned.push(trimmed)
  }
  if (ipRestrictionEnabled && cleaned.length === 0) {
    res.status(400).json({
      error: 'Add at least one allowed address before turning the restriction on — an empty list blocks everyone.',
    })
    return
  }

  const updated = await prisma.class.update({
    where: { id: classId },
    data: { ipRestrictionEnabled, allowedIps: cleaned },
    select: { id: true, ipRestrictionEnabled: true, allowedIps: true },
  })
  console.log(
    `[NETWORK] class ${classId} restriction ${ipRestrictionEnabled ? 'ENABLED' : 'disabled'}` +
      ` with ${cleaned.length} allowed entr(ies)`
  )
  res.json({ ...updated, yourIp: normalizeIp(req.ip) })
})

// ── Behavioral-metric accuracy review (Feature 3) ──────────────────────────
// OPTIONAL instructor judgments, collected for a LATER MANUAL tuning pass.
// Nothing reads these rows to adjust a threshold, and nothing should: a
// detector that retunes itself from the opinions of the people it reports to
// would quietly learn to stop reporting.
//
// Ownership is the same rule as /replay — an instructor may only judge sessions
// in a class they own — so a judgment cannot be attached to another
// instructor's cohort.
async function instructorOwnsSession(sessionId: string, userId: string) {
  const session = await withRetry(() =>
    prisma.session.findUnique({
      where: { id: sessionId },
      include: { assignment: { include: { class: true } } },
    })
  )
  if (!session) return { session: null, owns: false }
  // Legacy sessions with no assignment are dev data — instructor role suffices,
  // matching /replay rather than inventing a second, stricter rule.
  const owns = !session.assignment || session.assignment.class.instructorId === userId
  return { session, owns }
}

app.post(
  '/api/sessions/:sessionId/metric-reviews',
  requireAuth,
  requireRole('INSTRUCTOR'),
  async (req: Request, res: Response) => {
    const sessionId = String(req.params.sessionId)
    const parsed = parseReviewInput(req.body ?? {})
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error })
      return
    }
    const { session, owns } = await instructorOwnsSession(sessionId, req.user!.userId)
    if (!session) {
      res.status(404).json({ error: 'Session not found' })
      return
    }
    if (!owns) {
      res.status(403).json({ error: 'You do not own this class.' })
      return
    }

    // UPSERT on (session, task, metric, instructor): re-judging updates the
    // instructor's own prior answer rather than accumulating duplicates, while
    // two instructors judging the same metric stay two separate rows — they may
    // legitimately disagree, and that disagreement is itself calibration data.
    const row = await withRetry(() =>
      prisma.metricReview.upsert({
        where: {
          sessionId_taskId_metric_instructorId: {
            sessionId,
            taskId: parsed.taskId,
            metric: parsed.metric,
            instructorId: req.user!.userId,
          },
        },
        create: {
          sessionId,
          taskId: parsed.taskId,
          metric: parsed.metric,
          predictedFlag: parsed.predictedFlag,
          instructorJudgment: parsed.judgment,
          instructorId: req.user!.userId,
        },
        // `predictedFlag` is refreshed too: forensics may have been recomputed
        // since the last judgment, and a judgment paired with a stale prediction
        // would be miscounted as the wrong kind of error later.
        update: { predictedFlag: parsed.predictedFlag, instructorJudgment: parsed.judgment },
      })
    )
    console.log(
      `[REVIEW] ${parsed.metric}${parsed.taskId ? ` (${parsed.taskId})` : ''} on session ${sessionId}` +
        ` judged ${parsed.judgment} (metric said flag=${parsed.predictedFlag})`
    )
    res.json(reviewOut(row))
  }
)

// This instructor's own judgments for a session, so the controls can render in
// the state they were left in. Scoped to the requester: one instructor's
// calibration opinions are not shown to another as if they were a consensus.
app.get(
  '/api/sessions/:sessionId/metric-reviews',
  requireAuth,
  requireRole('INSTRUCTOR'),
  async (req: Request, res: Response) => {
    const sessionId = String(req.params.sessionId)
    const { session, owns } = await instructorOwnsSession(sessionId, req.user!.userId)
    if (!session) {
      res.status(404).json({ error: 'Session not found' })
      return
    }
    if (!owns) {
      res.status(403).json({ error: 'You do not own this class.' })
      return
    }
    const rows = await withRetry(() =>
      prisma.metricReview.findMany({
        where: { sessionId, instructorId: req.user!.userId },
        orderBy: { updatedAt: 'desc' },
      })
    )
    res.json(rows.map(reviewOut))
  }
)

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

// One task's flags-only row (Prompt 2). Same discipline as the session-level
// summary above: flags plus the single derived scalar each severity label
// needs, never full stats and never raw events.
type TaskBundle = {
  label?: string
  metricA?: { flag?: boolean; runCount?: number; scope?: string }
  metricB?: { flag?: boolean; inconclusive?: boolean }
  metricC?: { flag?: boolean; inconclusive?: boolean; stats?: { cv?: number | null } }
  authorship?: { flag?: boolean; stats?: { typedRatio?: number | null } }
  astAudit?: { flag?: boolean; violations?: unknown[]; violationCount?: number }
}

function taskSummary(taskId: string, t: TaskBundle) {
  return {
    taskId,
    label: t.label ?? taskLabel(taskId),
    metricA: {
      flag: t.metricA?.flag ?? null,
      runCount: t.metricA?.runCount ?? null,
      // 'task' = this task's own run count; 'session' = a pre-tracking session
      // where only the session total exists. The UI must not present the
      // second as though it were measured per task.
      scope: t.metricA?.scope ?? 'session',
    },
    metricB: { flag: t.metricB?.flag ?? null, inconclusive: t.metricB?.inconclusive ?? false },
    metricC: {
      flag: t.metricC?.flag ?? null,
      cv: t.metricC?.stats?.cv ?? null,
      inconclusive: t.metricC?.inconclusive ?? false,
    },
    authorship: {
      flag: t.authorship?.flag ?? null,
      typedRatio: t.authorship?.stats?.typedRatio ?? null,
    },
    astAudit: {
      flag: t.astAudit?.flag ?? null,
      // Prefer the stored construct count so the table's number matches the list
      // the report shows. Sessions audited before that field existed fall back to
      // the raw violation length, which is what they always reported.
      violationCount:
        t.astAudit?.violationCount ??
        (Array.isArray(t.astAudit?.violations) ? t.astAudit!.violations!.length : 0),
    },
  }
}

/**
 * `assignmentTypeIn` is passed by routes that already loaded the assignment. It
 * falls back to the type recorded on the forensics result, and to null when the
 * session predates that. The client uses it to gate signals that carry no
 * meaning on a take-home (tab-outs, compile count) — a DISPLAY decision; every
 * metric is still computed and still stored.
 */
// ── Instructor display: resolve duplicates to the REAL session (gap #71) ────
// Two overlapping creates can leave an EMPTY phantom beside the session the
// student actually worked in. Shown side by side, the phantom reads as a second
// attempt with no data — which is exactly how a submitted exam came to look like
// it had recorded nothing.
//
// The evidence a row carries is already in hand here (these routes select the
// whole row), so the counts cost no extra query. `dropPhantomDuplicates` then
// hides ONLY a row that is provably empty AND has a real sibling — the same
// predicate the one-time cleanup deletes on, so an instructor is never shown a
// row that later vanishes, and the historical gap #12 duplicates where both rows
// hold real work are both still shown.
type EvidenceRow = {
  id: string
  status: string
  studentId: string
  assignmentId?: string | null
  playback_log?: unknown
  tier1_log?: unknown
  forensicsResults?: unknown
  runCount?: number | null
  updatedAt?: Date
}
function withEvidence<T extends EvidenceRow>(s: T) {
  return {
    ...s,
    // Not an array should be impossible (the column defaults to []), but -1
    // means "unknown", and unknown never satisfies the phantom predicate.
    windowCount: Array.isArray(s.playback_log) ? s.playback_log.length : -1,
    tier1Count: Array.isArray(s.tier1_log) ? s.tier1_log.length : null,
    hasForensics: s.forensicsResults != null,
  }
}
/** The identity a duplicate is a duplicate of: (student, assignment). */
function sessionPairKey(s: EvidenceRow): string {
  return `${s.assignmentId ?? ''}::${s.studentId}`
}

function sessionSummary(s: SessionRow, assignmentTypeIn?: string | null) {
  const fr = s.forensicsResults as
    | {
        assignmentType?: string | null
        metricA?: { flag?: boolean }
        metricB?: { flag?: boolean; inconclusive?: boolean }
        metricC?: { flag?: boolean; inconclusive?: boolean; stats?: { cv?: number | null } }
        authorship?: { flag?: boolean; stats?: { typedRatio?: number | null } }
        taskCount?: number
        tasks?: Record<string, TaskBundle>
        merged?: {
          flag?: boolean
          flaggedTaskCount?: number
          taskCount?: number
          flaggedTasks?: { taskId: string; label: string; metrics: string[] }[]
          reason?: string | null
          excludedMetrics?: string[]
        }
      }
    | null
  return {
    id: s.id,
    studentId: s.studentId,
    status: s.status,
    assignmentType: assignmentTypeIn ?? fr?.assignmentType ?? null,
    runCount: s.runCount ?? 0,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    forensicsResults: fr
      ? {
          metricA: { flag: fr.metricA?.flag ?? null },
          // `inconclusive` (Session 22) rides along with the flag: without it a
          // guard-tripped metric renders as a green "ok" in the session table,
          // which is exactly the clean-pass misreading part 1 set out to stop.
          metricB: { flag: fr.metricB?.flag ?? null, inconclusive: fr.metricB?.inconclusive ?? false },
          // cv is a single derived scalar (needed for the severity color
          // scale) — still no full stats and never raw events.
          metricC: {
            flag: fr.metricC?.flag ?? null,
            cv: fr.metricC?.stats?.cv ?? null,
            inconclusive: fr.metricC?.inconclusive ?? false,
          },
          // Session 22 (part 2): authorship's flag plus typedRatio — one more
          // derived scalar for the severity label ("54% typed"), consistent
          // with how metricC exposes cv. Absent on sessions processed before
          // the metric existed → null, which renders as "insufficient data".
          authorship: {
            flag: fr.authorship?.flag ?? null,
            typedRatio: fr.authorship?.stats?.typedRatio ?? null,
          },
          // ── Prompt 2 (gap #31) ────────────────────────────────────────────
          // The five keys above are the session-wide computation, i.e. an
          // AVERAGE across tasks on a multi-task exam. `merged` is the review
          // signal: ANY task flagged. A single fully-pasted task can no longer
          // be washed out by clean ones. Absent on sessions processed before
          // this existed → null, which the UI renders as "not assessed", never
          // as a clean pass.
          taskCount: fr.taskCount ?? 1,
          merged: fr.merged
            ? {
                flag: fr.merged.flag ?? null,
                flaggedTaskCount: fr.merged.flaggedTaskCount ?? 0,
                taskCount: fr.merged.taskCount ?? fr.taskCount ?? 1,
                flaggedTasks: fr.merged.flaggedTasks ?? [],
                reason: fr.merged.reason ?? null,
                // Metrics the merged signal deliberately ignored for this exam
                // type (Metric A on a take-home). Stated, never silent.
                excludedMetrics: fr.merged.excludedMetrics ?? [],
              }
            : null,
          // Per-task flags, in exam order. Empty for a legacy session with no
          // per-task record; a single-task session carries exactly one row,
          // which the UI collapses rather than showing pointless chrome.
          tasks: fr.tasks
            ? Object.entries(fr.tasks)
                .map(([taskId, t]) => taskSummary(taskId, t))
                .sort((a, b) => a.taskId.localeCompare(b.taskId, undefined, { numeric: true }))
            : [],
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
    // Gap #71: never list an empty phantom beside the student's real session.
    const visible = dropPhantomDuplicates(sessions.map(withEvidence), sessionPairKey)
    res.json(visible.map((s) => sessionSummary(s, assignment.type)))
  }
)

// ── GET /api/assignments/:id/roster ────────────────────────────────────────
// Session 17 grid dashboard: the full class roster for an assignment's exam —
// every member student, joined with their session (if any) for THIS
// assignment. Read-only, instructor-only, ownership-checked, flags-only.
//
// The roster is the UNION of two groups, and it needs both (2026-08-11):
//
//   * every CLASS MEMBER — which is what produces the NOT_STARTED tiles, and
//     therefore the full grid an instructor watches an exam on. A membership is
//     the only record that a student who has not typed anything exists at all.
//   * every student who HAS A SESSION for this assignment, member or not.
//
// Membership alone was the rule until now, and it silently dropped the second
// group: a student who sat the exam but carries no membership row (unlinked
// telemetry, a student removed from the class after sitting, a session created
// through a path that never joined the class) was invisible on the monitoring
// screen while their session sat in the database and in the session LIST beside
// it. Measured on the dev database: 7 of 18 assignment-linked sessions belonged
// to a non-member. A student who took the exam must appear on the screen the
// exam is watched from — being un-enrolled is a roster problem to notice, not a
// reason to hide their work — so those tiles are added and flagged
// `enrolled: false` rather than quietly omitted.
//
// This does NOT invent memberships: nothing is written, and the class roll is
// unchanged. It only stops a read from hiding a session that exists.
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
        // The linked account, so a session belonging to a non-member still gets
        // a real username on its tile rather than the raw studentId. A session
        // with no userId at all (the oldest rows) falls back to studentId,
        // which IS the username for those.
        include: { user: { select: { id: true, username: true } } },
      }),
    ])

    const rows = sessions.map(withEvidence)
    // Every session accounted for by a member's tile — ALL of that student's
    // rows, not just the one displayed, so a historical duplicate where both
    // rows are real (gap #12) cannot also surface as a second "not enrolled"
    // tile for a student who is plainly enrolled.
    const claimed = new Set<string>()

    const tileFor = (
      mine: typeof rows,
      identity: { userId: string | null; username: string; enrolled: boolean }
    ) => {
      for (const s of mine) claimed.add(s.id)
      // Gap #71: a duplicate pair must resolve to the row holding the
      // student's work. Rows arrive updatedAt-desc, and `pickRealSession`
      // only ever moves a MORE real row ahead of a less real one — so with no
      // duplicates this is still "the latest", and with duplicates the tile
      // shows the real session instead of a phantom created 1ms later.
      const session = pickRealSession(mine)
      const summary = session ? sessionSummary(session, assignment.type) : null
      return {
        ...identity,
        sessionId: session?.id ?? null,
        status: session?.status ?? 'NOT_STARTED',
        // Lets the grid gate signals that mean nothing on a take-home, and it
        // is the assignment's type, so NOT_STARTED tiles carry it too.
        assignmentType: assignment.type,
        forensicsFlags: summary?.forensicsResults ?? null,
      }
    }

    const memberTiles = memberships.map((m) =>
      // Prefer the userId link; fall back to studentId === username (the
      // legacy identity — sessions store the username there).
      tileFor(
        rows.filter((s) => s.userId === m.user.id).length > 0
          ? rows.filter((s) => s.userId === m.user.id)
          : rows.filter((s) => s.studentId === m.user.username),
        { userId: m.user.id, username: m.user.username, enrolled: true }
      )
    )

    // Anyone left holding a session for this assignment: they sat the exam, so
    // they belong on the screen it is watched from, flagged as not enrolled.
    // Grouped by the account when there is one and by studentId otherwise,
    // which is the same identity rule the rest of the session path uses.
    const orphanGroups = new Map<string, typeof rows>()
    for (const s of rows) {
      if (claimed.has(s.id)) continue
      const key = s.userId ?? `name:${s.studentId}`
      const group = orphanGroups.get(key)
      if (group) group.push(s)
      else orphanGroups.set(key, [s])
    }
    const orphanTiles = [...orphanGroups.values()].map((group) =>
      tileFor(group, {
        userId: group[0].userId ?? null,
        username: group[0].user?.username ?? group[0].studentId,
        enrolled: false,
      })
    )

    const roster = [...memberTiles, ...orphanTiles].sort((a, b) =>
      a.username.localeCompare(b.username)
    )

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
      include: { assignment: { select: { id: true, title: true, type: true } } },
    })
    // Gap #71, same rule as the per-assignment list: an empty phantom is never
    // shown next to the real session it duplicates.
    const visible = dropPhantomDuplicates(sessions.map(withEvidence), sessionPairKey)
    res.json(
      visible.map((s) => ({
        ...sessionSummary(s, s.assignment?.type ?? null),
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

// ── Tier-1 alert recording (Session 22, part 2) ───────────────────────────
// The live relay is stateless by design (Constraint 3). This ADDS a durable
// per-session record so the forensic report can say what fired and how often.
// One atomic JSONB append, same pattern as telemetry ingest (Constraint 1) —
// never a read-modify-write of the array in Node.
//
// The `status = 'IN_PROGRESS'` guard means a post-submission alert can never be
// recorded: that is a genuine (partial) server-side Immune Phase for the
// RECORD, though the relay itself is still unguarded (gap #3).
const TIER1_TYPES = new Set(['TAB_OUT', 'ILLEGAL_PASTE', 'AST_VIOLATION'])

// Mirrors PASTE_THRESHOLD in the client's EditorPane — used ONLY to reconstruct
// how many ILLEGAL_PASTE alerts a pre-tier1_log session would have raised.
// Detection itself still lives entirely in the client; this changes nothing
// about what fires.
const PASTE_THRESHOLD = 50

async function recordTier1Alert(payload: {
  type: string
  sessionId: string
  timestamp: number
  detail: string
}) {
  if (!TIER1_TYPES.has(payload.type)) return
  if (typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) return
  const entry = {
    type: payload.type,
    timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : Date.now(),
    detail: typeof payload.detail === 'string' ? payload.detail : '',
  }
  try {
    await prisma.$executeRaw`
      UPDATE sessions
      SET tier1_log = COALESCE(tier1_log, '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb
      WHERE id = ${payload.sessionId} AND status = 'IN_PROGRESS'
    `
  } catch (err) {
    // Never let the record break the live alert path.
    console.error(`[TIER1] Failed to record ${payload.type}:`, (err as Error).message)
  }
}

// Fix 3 — the Tier-1 record as a timeline rather than a tally. Only the three
// fields the scrubber needs are projected, so nothing else the relay ever
// records leaks into an instructor payload by accident.
//
// `tier1_log` has no hard size cap (gap #21) — AST violations are debounced and
// de-duplicated client-side and tab-outs are inherently low-volume, so real
// sessions record a handful. The cap here is purely defensive: it bounds the
// payload without silently pretending the extra events did not happen, which is
// what `truncated` on the reader side would otherwise have no way to know.
const TIER1_EVENT_CAP = 500

function tier1EventsFor(tier1Log: unknown) {
  if (!Array.isArray(tier1Log)) return null // predates the record — not "none"
  return (tier1Log as { type?: string; timestamp?: number; detail?: string }[])
    .filter((e) => e && typeof e.type === 'string' && Number.isFinite(Number(e.timestamp)))
    .slice(0, TIER1_EVENT_CAP)
    .map((e) => ({ type: e.type, timestamp: Number(e.timestamp), detail: e.detail ?? null }))
}

// Counts per Tier-1 type for the report. `recorded: false` means this session
// predates the tier1_log (NULL) — its tab-outs and AST violations are genuinely
// unknown, and must be shown as "not recorded", never as zero. External pastes
// stay recoverable from playback_log either way, so we still report those.
function summariseTier1(tier1Log: unknown, playbackLog: unknown) {
  if (Array.isArray(tier1Log)) {
    const entries = tier1Log as { type?: string }[]
    const count = (type: string) => entries.filter((e) => e?.type === type).length
    return {
      tabOut: count('TAB_OUT'),
      illegalPaste: count('ILLEGAL_PASTE'),
      astViolation: count('AST_VIOLATION'),
      recorded: true,
    }
  }
  // Legacy session: mirror the client's ILLEGAL_PASTE rule (external paste over
  // PASTE_THRESHOLD) against the stored keystroke events.
  const log = Array.isArray(playbackLog) ? (playbackLog as any[]) : []
  // Sized by what each paste INSERTED, matching the client's gate. Using the
  // net delta here under-counted for the same reason it did on the client: a
  // paste over a selection nets its insertion against the text it replaced.
  const pasteAlerts = log
    .flatMap((entry) => (Array.isArray(entry?.events) ? entry.events : []))
    .filter(
      (e: any) =>
        e?.actionType === 'paste' &&
        insertedCharsOf(e) > PASTE_THRESHOLD &&
        e?.provenance !== 'internal'
    ).length
  return { tabOut: null, illegalPaste: pasteAlerts, astViolation: null, recorded: false }
}

// ── Live DVR: who may watch whom (Session 28) ─────────────────────────────
// Deliberately the SAME rule as GET /api/session/:id/replay — an instructor may
// watch a session whose assignment→class they own, and a legacy session with no
// assignment is dev data where the instructor role suffices. Duplicating the
// rule would be one more place for the two to drift apart, so the shape of the
// query is copied verbatim and only the verdict differs.
async function canWatchSession(sessionId: string, userId: string): Promise<boolean> {
  const session = await withRetry(() =>
    prisma.session.findUnique({
      where: { id: sessionId },
      include: { assignment: { include: { class: true } } },
    })
  )
  if (!session) return false
  if (session.assignment) return session.assignment.class.instructorId === userId
  return true
}

io.on('connection', (socket) => {
  socket.on('join_instructor', () => {
    socket.join('instructors')
    debugLog('[SOCKET] Instructor joined room')
  })

  socket.on('alert', (payload: { type: string; studentId: string; sessionId: string; timestamp: number; detail: string }) => {
    debugLog(`[RELAY] ${payload.type} -> instructors | session=${payload.sessionId} detail="${payload.detail}"`)
    io.to('instructors').emit('alert', payload)
    // Session 22 (part 2) — also RECORD it, so the post-submission report can
    // summarise Tier-1 violations instead of them existing only in the live
    // feed. Fire-and-forget: relay latency must not depend on the DB.
    void recordTier1Alert(payload)
  })

  // Live keystroke streaming (Session 28). Everything about the protocol lives
  // in live/liveRelay.ts so it can be driven by mock sockets in tests; nothing
  // it receives is persisted (see that file's header for why).
  registerLiveHandlers(io, socket as unknown as LiveSocket, {
    registry: watchRegistry,
    verifyToken,
    canWatch: canWatchSession,
    log: debugLog,
  })
})

httpServer.listen(PORT, () => {
  console.log(`CoDecep Ingestion Gateway → http://localhost:${PORT}`)
  // Names the config source and the database it resolved to, with credentials
  // stripped — so a run against the wrong database is visible in one line.
  console.log(`[STARTUP] env: ${describeEnvSource()}`)
})
