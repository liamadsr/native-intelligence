/**
 * Sentry reports only from production, and only to the DSN in
 * NEXT_PUBLIC_SENTRY_DSN: no DSN, no Sentry. The build plugin (source-map
 * upload) wraps the Next config only with a DSN, and uploads only with
 * SENTRY_ORG and SENTRY_PROJECT too. No Sentry address is built in.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { withSentryConfig } = vi.hoisted(() => ({
  withSentryConfig: vi.fn((config: object, options: object) => ({ ...config, sentry: options })),
}))
vi.mock('@sentry/nextjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sentry/nextjs')>()),
  withSentryConfig,
}))

import { withSentry } from '../../../next.config.mjs'
import { getSentryDsn, isSentryEnabled } from '../sentry-env'

const DSN = 'https://publickey@o0.ingest.sentry.example/1'

afterEach(() => {
  vi.unstubAllEnvs()
  withSentryConfig.mockClear()
})

describe('isSentryEnabled', () => {
  it('is off in production without a DSN', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', '')
    expect(getSentryDsn()).toBeUndefined()
    expect(isSentryEnabled()).toBe(false)
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', '   ')
    expect(isSentryEnabled()).toBe(false)
  })

  it('is on in production with a DSN', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', ` ${DSN} `)
    expect(getSentryDsn()).toBe(DSN)
    expect(isSentryEnabled()).toBe(true)
  })

  it('stays off outside production, DSN or not', () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', DSN)
    expect(isSentryEnabled()).toBe(false)
  })
})

describe('withSentry (next.config.mjs)', () => {
  it('leaves the config alone without a DSN: no plugin, no upload', () => {
    const config = { reactStrictMode: true }
    expect(withSentry(config, {})).toBe(config)
    expect(withSentry(config, { NEXT_PUBLIC_SENTRY_DSN: ' ', SENTRY_ORG: 'org', SENTRY_PROJECT: 'proj' })).toBe(config)
    expect(withSentryConfig).not.toHaveBeenCalled()
  })

  it('wraps with the org and project from the environment', () => {
    withSentry({}, { NEXT_PUBLIC_SENTRY_DSN: DSN, SENTRY_ORG: 'acme', SENTRY_PROJECT: 'web' })
    expect(withSentryConfig).toHaveBeenCalledOnce()
    expect(withSentryConfig.mock.calls[0][1]).toMatchObject({
      org: 'acme',
      project: 'web',
      sourcemaps: { disable: false },
    })
  })

  it('reports but uploads no source maps without an org and project', () => {
    withSentry({}, { NEXT_PUBLIC_SENTRY_DSN: DSN })
    expect(withSentryConfig.mock.calls[0][1]).toMatchObject({
      org: undefined,
      project: undefined,
      sourcemaps: { disable: true },
    })
  })
})

describe('no built-in Sentry project', () => {
  it('names no DSN, org or project in code', () => {
    const root = path.join(__dirname, '..', '..', '..')
    for (const file of ['sentry.server.config.ts', 'sentry.edge.config.ts', 'src/instrumentation-client.ts', 'next.config.mjs']) {
      const source = readFileSync(path.join(root, file), 'utf8')
      expect(source, file).not.toMatch(/ingest(\.[a-z]+)?\.sentry\.io/)
      expect(source, file).not.toMatch(/\b(org|project):\s*['"]/)
    }
  })
})
