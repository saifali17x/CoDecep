import { z } from 'zod'
import { Request, Response, NextFunction } from 'express'

// ── Zod schemas for every JSON/text request body the API accepts ───────────
// Multipart routes (assignment create) validate AFTER multer has populated
// req.body with the text fields.

// Password policy (NIST 800-63B-aligned): length over forced symbol
// complexity — 8–72 chars (72 = bcrypt's byte limit) with at least one letter
// and one number. No symbol requirement.
export const registerSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, 'Username must be 3–20 characters')
    .max(20, 'Username must be 3–20 characters')
    .regex(/^[a-zA-Z0-9_]+$/, 'Username may only contain letters, numbers, and underscores'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(72, 'Password must be at most 72 characters')
    .regex(/[a-zA-Z]/, 'Password must contain at least one letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
  role: z.enum(['INSTRUCTOR', 'STUDENT']),
})

// Login stays deliberately loose — never reveal the password rules here, and
// the route keeps its generic 401 to prevent user enumeration.
export const loginSchema = z.object({
  username: z.string().min(1, 'username is required'),
  password: z.string().min(1, 'password is required'),
})

export const createClassSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(100, 'name must be at most 100 characters'),
})

export const joinClassSchema = z.object({
  // Codes are generated as 6 uppercase alphanumerics; accept lowercase input
  // (the route uppercases) but enforce length + charset.
  joinCode: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9]{6}$/, 'joinCode must be 6 letters/numbers'),
})

export const createAssignmentSchema = z.looseObject({
  title: z.string().trim().min(1, 'title is required').max(200, 'title must be at most 200 characters'),
  type: z.enum(['LIVE_LAB', 'ASSESSMENT']),
  // Multipart text fields arrive as strings — coerce. Optional keeps the
  // pre-existing default-to-week-1 behavior when the field is absent.
  week: z.coerce.number().int('week must be an integer').min(1, 'week must be 1–20').max(20, 'week must be 1–20').optional(),
  allowlist: z
    .string()
    .optional()
    .refine((s) => {
      if (s === undefined || s.length === 0) return true
      try {
        const parsed = JSON.parse(s)
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      } catch {
        return false
      }
    }, 'allowlist must be a JSON object string'),
})

export const astValidateSchema = z.looseObject({
  // Empty/short code is normal mid-typing — do not reject here.
  code: z.string(),
  assignmentId: z.string().min(1).optional(),
})

export const sessionCreateSchema = z.looseObject({
  studentId: z.string().trim().min(1, 'studentId is required'),
  userId: z.string().min(1).optional(),
  assignmentId: z.string().min(1).optional(),
})

// Deliberately permissive on chunk internals — over-validating telemetry
// risks dropping real exam data. Only the top-level shape is enforced, and
// unknown fields (present + future) pass through untouched.
export const telemetrySubmitSchema = z.looseObject({
  sessionId: z.string().min(1, 'sessionId is required'),
  studentId: z.string().optional(),
  chunk: z.array(z.unknown()),
  codeSnapshot: z.string().optional(),
  engagedTimeMs: z.number().optional(),
})

// ── Reusable middleware ────────────────────────────────────────────────────
// 400 { error: 'Validation failed', details: [{ field, message }] } on
// failure; on success req.body is replaced with the parsed (trimmed/coerced)
// data. looseObject schemas preserve unknown fields.
export function validate(schema: z.ZodType) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body ?? {})
    if (!result.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: result.error.issues.map((issue) => ({
          field: issue.path.join('.') || '(body)',
          message: issue.message,
        })),
      })
      return
    }
    req.body = result.data
    next()
  }
}
