import jwt from 'jsonwebtoken'
import { Request, Response, NextFunction } from 'express'

// Imports are hoisted, so this module evaluates before server.ts's own
// loadEnv() call runs — load the env files here so JWT_SECRET is available.
import { loadEnv } from './env'
loadEnv()

// ── JWT helpers ────────────────────────────────────────────────────────────
// JWT_SECRET must be set (.env.local locally, a Heroku config var in
// production). If missing, throw at startup so the error is obvious rather
// than silent.
const secretFromEnv = process.env.JWT_SECRET
if (!secretFromEnv) throw new Error('JWT_SECRET is not set (.env.local locally, config var in production)')
const JWT_SECRET: string = secretFromEnv

export function signToken(payload: { userId: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' })
}

export function verifyToken(token: string): { userId: string; role: string } {
  return jwt.verify(token, JWT_SECRET) as { userId: string; role: string }
}

// ── Express middleware ─────────────────────────────────────────────────────
// Reads the token from the Authorization header (Bearer <token>).
// Attaches { userId, role } to req.user on success.
// Returns 401 if missing or invalid.
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' })
    return
  }
  try {
    const token = header.slice(7)
    req.user = verifyToken(token)
    next()
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' })
  }
}

// ── Role guard ─────────────────────────────────────────────────────────────
export function requireRole(role: 'INSTRUCTOR' | 'STUDENT') {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role !== role) {
      res.status(403).json({ error: `${role} access required` })
      return
    }
    next()
  }
}
