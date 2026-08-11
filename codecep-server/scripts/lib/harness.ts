/**
 * Fixture users for verification harnesses — the ONLY supported way a script
 * may create and remove accounts (gap #81, 2026-08-11).
 *
 * WHY THIS EXISTS. A harness used to name its students `stud_<timestamp>` and
 * tear them down with a prefix delete:
 *
 *     prisma.user.deleteMany({ where: { username: { startsWith: 'stud' } } })
 *
 * run against .env.local's REAL database. The user's own manually-created
 * accounts student_a / student_b / student_c matched that prefix and were
 * destroyed as collateral — repeatedly, on Neon and again locally. A prefix is
 * a guess about which rows belong to you; an id is a fact.
 *
 * Two rules, and neither is a style preference:
 *
 *   1. A harness deletes ONLY accounts it created, BY ID. Never a pattern,
 *      never a username, never a hardcoded human-named list, and never
 *      "everything that does not look like a test account".
 *   2. Every fixture is REGISTERED at creation. The `users_guard_delete`
 *      database trigger refuses to delete any user that is not registered, so
 *      rule 1 is enforced below the application rather than trusted — a future
 *      harness that forgets all of this fails loudly instead of destroying
 *      someone's account.
 *
 * Fixture usernames are also uniquely tagged (`makeTag`), which keeps two
 * concurrent runs from colliding. That uniqueness is a convenience; the id
 * discipline above is the actual protection.
 */
import type { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

/** Unique per run, so two harnesses never collide on a username. */
export function makeTag(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

export type FixtureUser = { id: string; username: string; role: string }

/**
 * Creates a throwaway account AND registers it as deletable, in ONE
 * transaction — an account can never exist as a fixture-in-spirit that the
 * guard does not know about, and a registration can never outlive a creation
 * that rolled back.
 */
export async function createFixtureUser(
  prisma: PrismaClient,
  opts: { username: string; role: 'STUDENT' | 'INSTRUCTOR'; passwordHash: string; note?: string },
): Promise<FixtureUser> {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { username: opts.username, passwordHash: opts.passwordHash, role: opts.role },
    })
    await tx.harnessFixtureUser.create({
      data: { userId: user.id, note: opts.note ?? 'verification harness fixture' },
    })
    return { id: user.id, username: user.username, role: user.role }
  })
}

/** bcrypt at the app's own cost, so a fixture can actually log in if needed. */
export function hashFixturePassword(password = 'Passw0rd123'): Promise<string> {
  return bcrypt.hash(password, 12)
}

/**
 * Removes fixture accounts BY ID and nothing else.
 *
 * Deliberately takes the users this run created — not a filter, not a tag —
 * because the argument type is what stops the next person reaching for a
 * pattern. Ids that are not registered fixtures are refused by the database,
 * so even a caller passing the wrong ids cannot destroy a real account.
 */
export async function deleteFixtureUsers(
  prisma: PrismaClient,
  users: ReadonlyArray<{ id: string }>,
): Promise<number> {
  const ids = users.map((u) => u.id).filter(Boolean)
  if (ids.length === 0) return 0
  const { count } = await prisma.user.deleteMany({ where: { id: { in: ids } } })
  return count
}
