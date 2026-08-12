import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  isLocalTarget,
  databaseSsl,
  describeDatabaseSsl,
  prismaCliDatabaseUrl,
  redisConnectionOptions,
  describeRedisTarget,
  trustProxySetting,
} from './env'

// The 2026-08-12 production outage in one sentence: the CLI and the runtime
// resolved the same URL and applied different TLS defaults. These tests pin the
// policy that replaced those defaults — including the two cases that were
// measured against the live add-ons and are easy to "simplify" back into an
// outage (a remote target must get TLS; a local one must not).

const HEROKU_PG = 'postgres://u:p@c178s03k039a3f.cluster-czrs8kj4isg7.us-east-1.rds.amazonaws.com:5432/dcpk2olifhg44'
const LOCAL_PG = 'postgresql://codecep:pw@localhost:5432/codecep'

describe('isLocalTarget', () => {
  it('recognises the local database', () => {
    expect(isLocalTarget(LOCAL_PG)).toBe(true)
    expect(isLocalTarget('postgresql://u:p@127.0.0.1:5432/codecep')).toBe(true)
  })

  it('treats a managed host as remote', () => {
    expect(isLocalTarget(HEROKU_PG)).toBe(false)
  })

  it('treats an absent URL as local rather than inventing a remote target', () => {
    expect(isLocalTarget(undefined)).toBe(true)
  })
})

describe('databaseSsl', () => {
  const saved = process.env.DATABASE_SSL

  beforeEach(() => {
    delete process.env.DATABASE_SSL
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.DATABASE_SSL
    else process.env.DATABASE_SSL = saved
  })

  it('LOCAL DEV IS UNCHANGED: no TLS for a local database', () => {
    expect(databaseSsl(LOCAL_PG)).toBe(false)
  })

  it('enables TLS for a remote database, without certificate verification', () => {
    // Heroku Postgres serves an RDS certificate whose issuer is not in Node's
    // trust store: strict verification fails with UNABLE_TO_GET_ISSUER_CERT_LOCALLY.
    expect(databaseSsl(HEROKU_PG)).toEqual({ rejectUnauthorized: false })
  })

  it('lets DATABASE_SSL override the detection in both directions', () => {
    process.env.DATABASE_SSL = 'disable'
    expect(databaseSsl(HEROKU_PG)).toBe(false)

    process.env.DATABASE_SSL = 'verify'
    expect(databaseSsl(HEROKU_PG)).toEqual({ rejectUnauthorized: true })

    process.env.DATABASE_SSL = 'no-verify'
    expect(databaseSsl(LOCAL_PG)).toEqual({ rejectUnauthorized: false })
  })

  it('does not invent TLS for a missing URL', () => {
    expect(databaseSsl(undefined)).toBe(false)
    expect(databaseSsl('')).toBe(false)
  })

  it('describes what it decided, never the credentials', () => {
    process.env.DATABASE_SSL = 'disable'
    expect(describeDatabaseSsl()).toContain('ssl off')
    process.env.DATABASE_SSL = 'no-verify'
    expect(describeDatabaseSsl()).toBe('ssl on (certificate not verified)')
    process.env.DATABASE_SSL = 'verify'
    expect(describeDatabaseSsl()).toBe('ssl on (certificate verified)')
  })
})

describe('prismaCliDatabaseUrl', () => {
  const savedUrl = process.env.DATABASE_URL
  const savedSsl = process.env.DATABASE_SSL

  beforeEach(() => {
    delete process.env.DATABASE_SSL
  })

  afterEach(() => {
    if (savedUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = savedUrl
    if (savedSsl === undefined) delete process.env.DATABASE_SSL
    else process.env.DATABASE_SSL = savedSsl
  })

  it('states the TLS requirement explicitly for a remote target', () => {
    process.env.DATABASE_URL = HEROKU_PG
    expect(prismaCliDatabaseUrl()).toBe(`${HEROKU_PG}?sslmode=require`)
  })

  it('leaves a local URL exactly as it is', () => {
    process.env.DATABASE_URL = LOCAL_PG
    expect(prismaCliDatabaseUrl()).toBe(LOCAL_PG)
  })

  it('never overrides an sslmode the operator set themselves', () => {
    process.env.DATABASE_URL = `${HEROKU_PG}?sslmode=disable`
    expect(prismaCliDatabaseUrl()).toBe(`${HEROKU_PG}?sslmode=disable`)
  })

  it('appends with & when the URL already carries a query', () => {
    process.env.DATABASE_URL = `${HEROKU_PG}?connection_limit=5`
    expect(prismaCliDatabaseUrl()).toBe(`${HEROKU_PG}?connection_limit=5&sslmode=require`)
  })

  it('passes a missing URL through untouched so the driver reports the real problem', () => {
    delete process.env.DATABASE_URL
    expect(prismaCliDatabaseUrl()).toBe('')
  })
})

describe('redisConnectionOptions', () => {
  it('LOCAL DEV IS UNCHANGED: bare host and port, no tls, no credentials', () => {
    expect(redisConnectionOptions('redis://localhost:6379')).toEqual({
      host: 'localhost',
      port: 6379,
    })
  })

  it('defaults to local Redis when REDIS_URL is unset', () => {
    expect(redisConnectionOptions(undefined)).toEqual({ host: 'localhost', port: 6379 })
    expect(redisConnectionOptions('')).toEqual({ host: 'localhost', port: 6379 })
  })

  it('carries password AND tls for a Heroku rediss:// URL', () => {
    // Dropping either one is a permanent `read ECONNRESET` loop: the add-on's
    // TLS listener resets a plaintext socket before AUTH is ever reached.
    expect(redisConnectionOptions('rediss://:secret@ec2-44-198-245-53.compute-1.amazonaws.com:14400')).toEqual({
      host: 'ec2-44-198-245-53.compute-1.amazonaws.com',
      port: 14400,
      password: 'secret',
      tls: { rejectUnauthorized: false },
    })
  })

  it('omits an EMPTY username rather than sending one', () => {
    // Heroku's URL is `rediss://:password@host`. An empty username would turn a
    // password-only AUTH into an ACL lookup for a user that does not exist.
    const options = redisConnectionOptions('rediss://:secret@redis.example.com:14400')
    expect('username' in options).toBe(false)
  })

  it('keeps a real username when one is present', () => {
    const options = redisConnectionOptions('rediss://alice:secret@redis.example.com:14400')
    expect(options.username).toBe('alice')
  })

  it('url-decodes credentials', () => {
    const options = redisConnectionOptions('rediss://:p%40ss%2Fword@redis.example.com:14400')
    expect(options.password).toBe('p@ss/word')
  })

  it('never puts the password in the description', () => {
    const described = describeRedisTarget('rediss://:supersecret@redis.example.com:14400')
    expect(described).not.toContain('supersecret')
    expect(described).toContain('tls')
    expect(described).toContain('auth')
    expect(describeRedisTarget('redis://localhost:6379')).toContain('no tls')
  })
})

describe('trustProxySetting', () => {
  it('is OFF by default, so local dev reads the real socket address', () => {
    expect(trustProxySetting(undefined)).toBe(false)
    expect(trustProxySetting('')).toBe(false)
    expect(trustProxySetting('false')).toBe(false)
    expect(trustProxySetting('0')).toBe(false)
  })

  it('coerces the already-deployed TRUST_PROXY=true to ONE hop, never `true`', () => {
    // `true` trusts every hop, which lets a client choose its own apparent
    // address — rejected by express-rate-limit and corrosive to the IP
    // restriction. Coercing keeps the existing Heroku config var working.
    expect(trustProxySetting('true')).toBe(1)
    expect(trustProxySetting('TRUE')).toBe(1)
  })

  it('accepts an explicit hop count', () => {
    expect(trustProxySetting('1')).toBe(1)
    expect(trustProxySetting('2')).toBe(2)
  })

  it('falls back to one hop for anything unparseable rather than trusting everything', () => {
    expect(trustProxySetting('yes please')).toBe(1)
    expect(trustProxySetting('-3')).toBe(1)
  })

  it('never returns boolean true', () => {
    for (const value of ['true', '1', '4', 'nonsense', 'on']) {
      expect(trustProxySetting(value)).not.toBe(true)
    }
  })
})
