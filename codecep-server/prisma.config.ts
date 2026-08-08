import { defineConfig } from 'prisma/config'
import { loadEnv, describeDatabaseTarget } from './src/env'

// The Prisma CLI (`migrate deploy`, `migrate status`, `generate`) resolves
// DATABASE_URL through this file, so it must load config exactly the way the
// server does — otherwise the CLI and the running app could point at different
// databases. Same loader, same precedence: .env.local locally, real config vars
// in production.
loadEnv()

// eslint-disable-next-line no-console
console.log(`[PRISMA] DATABASE_URL ${describeDatabaseTarget()}`)

export default defineConfig({
  datasource: {
    url: process.env.DATABASE_URL!,
  },
})
