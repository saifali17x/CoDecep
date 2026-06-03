import { defineConfig } from 'prisma/config'
import dotenv from 'dotenv'

dotenv.config()

export default defineConfig({
  earlyAccess: true,
  migrate: {
    db: {
      url: process.env.DATABASE_URL!,
    },
  },
})
