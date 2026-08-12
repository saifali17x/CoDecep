import { defineConfig } from 'prisma/config'
import { loadEnv, describeDatabaseTarget, describeDatabaseSsl, prismaCliDatabaseUrl } from './src/env'

// The Prisma CLI (`migrate deploy`, `migrate status`, `generate`) resolves
// DATABASE_URL through this file, so it must load config exactly the way the
// server does — otherwise the CLI and the running app could point at different
// databases. Same loader, same precedence: .env.local locally, real config vars
// in production.
loadEnv()

// eslint-disable-next-line no-console
console.log(`[PRISMA] DATABASE_URL ${describeDatabaseTarget()} — ${describeDatabaseSsl()}`)

export default defineConfig({
  datasource: {
    // NOT a bare process.env read. Sharing the URL was never enough: the CLI and
    // the runtime agreed on the database and still disagreed about TLS, because
    // each driver applied its own default (P1010 — see src/env.ts). Both sides
    // now derive the connection from ONE policy, so the next divergence has to
    // be introduced deliberately rather than inherited from a driver.
    url: prismaCliDatabaseUrl(),
  },
})
