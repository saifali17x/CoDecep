/**
 * Create your own test student accounts. Run it by hand, whenever you want them:
 *
 *   npx tsx scripts/seed-my-students.ts                  # student_a, student_b, student_c
 *   npx tsx scripts/seed-my-students.ts alice bob        # or name them yourself
 *
 * THIS SCRIPT NEVER DELETES ANYTHING. It only adds accounts that are missing
 * and leaves every existing account — including same-named ones — exactly as it
 * found them. It is deliberately NOT wired to any npm hook, test run or harness:
 * nothing runs it but you.
 *
 * These are YOUR accounts, not harness fixtures, so they are NOT registered in
 * harness_fixture_users — which means the `users_guard_delete` trigger will
 * refuse to let any test or cleanup code delete them (gap #81).
 *
 * Password for every account created here: Passw0rd123
 */
import { loadEnv, describeDatabaseTarget } from '../src/env'
loadEnv()
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import bcrypt from 'bcryptjs'

const PASSWORD = 'Passw0rd123'
const DEFAULT_NAMES = ['student_a', 'student_b', 'student_c']

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) })

async function main() {
  const names = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_NAMES
  console.log(`[SEED] ${describeDatabaseTarget()}`)

  const hash = await bcrypt.hash(PASSWORD, 12)
  for (const username of names) {
    const existing = await prisma.user.findUnique({ where: { username } })
    if (existing) {
      // Left completely alone — an existing account is never touched, never
      // re-hashed, and never recreated. Re-creating it is how a seed silently
      // changes someone's password into a 401.
      console.log(`  kept    ${username} (already exists, ${existing.role}, untouched)`)
      continue
    }
    const user = await prisma.user.create({
      data: { username, passwordHash: hash, role: 'STUDENT' },
    })
    console.log(`  created ${username} (STUDENT, password ${PASSWORD}) — id ${user.id.slice(0, 8)}`)
  }

  await prisma.$disconnect()
  await pool.end()
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})
