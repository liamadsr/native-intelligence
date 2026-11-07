/**
 * Every cloud agent's channel walk (security review 2026-10-31):
 *
 *   - no vercelOidc(). eve's accepts any token minted for this Vercel project,
 *     a preview or development deployment's included, and its `subjects` only
 *     add other projects, so it cannot be narrowed to production. Nothing calls
 *     these agents with one (the app presents each family's internal secret);
 *   - the walk ends in localDevOffVercel(): eve's localDev() goes by
 *     environment flags (EVE_DEV=1, or VERCEL=1 with VERCEL_ENV=development),
 *     never by the caller, so it must not admit anyone where VERCEL or
 *     VERCEL_ENV is set, whatever NODE_ENV says. `eve dev` (what `next dev`
 *     boots) keeps it.
 *
 * The Mac body's channel (local-agent) has neither entry: its launcher's
 * per-launch secret is its only verifier.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthFn } from 'eve/channels/auth'

// Capture each channel's config instead of building a real eve channel.
vi.mock('eve/channels/eve', async (importOriginal) => ({
  ...(await importOriginal<typeof import('eve/channels/eve')>()),
  eveChannel: (cfg: unknown) => cfg,
}))

import chatAgent from '../../channels/eve'
import codingAgent from '../../../coding-agent/channels/eve'
import liveAgent from '../../../live-agent/channels/eve'
import onboardingResearcher from '../../../onboarding-researcher/channels/eve'
import skillRunner from '../../../skill-runner/channels/eve'
import utility from '../../../utility/channels/eve'
import webResearch from '../../../web-research/channels/eve'
import workAgent from '../../../work-agent/channels/eve'

const AGENTS = join(__dirname, '../../..')

const WALKS: Record<string, unknown> = {
  'chat-agent': chatAgent,
  'coding-agent': codingAgent,
  'live-agent': liveAgent,
  'onboarding-researcher': onboardingResearcher,
  'skill-runner': skillRunner,
  utility,
  'web-research': webResearch,
  'work-agent': workAgent,
}

const walkOf = (name: string) => (WALKS[name] as { auth: AuthFn<Request>[] }).auth
const lastEntry = (name: string) => walkOf(name).at(-1)!
const channelSource = (name: string) => readFileSync(join(AGENTS, name, 'channels', 'eve.ts'), 'utf8')
/** The `auth: [...]` list as written. */
const authList = (src: string) => /auth:\s*\[([^\]]*)\]/.exec(src)?.[1].trim() ?? null

const request = () => new Request('http://localhost:3000/eve/x/v1/session', { method: 'POST' })

beforeEach(() => {
  // Off Vercel, not an eve dev server: the test runner's own env decides nothing.
  vi.stubEnv('VERCEL', undefined)
  vi.stubEnv('VERCEL_ENV', undefined)
  vi.stubEnv('EVE_DEV', undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the cloud agents’ channel walks', () => {
  it('cover every agent with a channel but the Mac body', () => {
    const withChannel = readdirSync(AGENTS).filter((name) => existsSync(join(AGENTS, name, 'channels', 'eve.ts')))
    expect(withChannel.filter((name) => name !== 'local-agent').sort()).toEqual(Object.keys(WALKS).sort())
  })

  it.each(Object.keys(WALKS))('%s: no vercelOidc(), and localDevOffVercel() last', (name) => {
    const src = channelSource(name)
    const list = authList(src)
    expect(list).not.toBeNull()
    expect(list).not.toMatch(/vercelOidc|localDev\(\)/)
    expect(list!.endsWith('localDevOffVercel()')).toBe(true)
    expect(src).not.toMatch(/import\s*\{[^}]*\b(vercelOidc|localDev)\b[^}]*\}\s*from\s*'eve\/channels\/auth'/)
    expect(walkOf(name).length).toBe(list!.split(',').length)
  })

  it('the Mac body’s walk is its secret alone', () => {
    const src = channelSource('local-agent')
    expect(authList(src)).toBe('macChannelAuth()')
    expect(src).not.toMatch(/import\s*\{[^}]*\b(vercelOidc|localDev)\b[^}]*\}\s*from\s*'eve\/channels\/auth'/)
  })
})

describe('localDevOffVercel, as each walk runs it', () => {
  it.each(Object.keys(WALKS))('%s: admits the local-dev principal on an eve dev server off Vercel', async (name) => {
    vi.stubEnv('EVE_DEV', '1')
    expect(await lastEntry(name)(request())).toMatchObject({ authenticator: 'local-dev', principalType: 'local-dev' })
  })

  it.each(Object.keys(WALKS))('%s: admits nobody without a dev flag', async (name) => {
    expect(await lastEntry(name)(request())).toBeNull()
  })

  const onVercel: Array<[string, Record<string, string>]> = [
    ['VERCEL=1 on an eve dev server', { EVE_DEV: '1', VERCEL: '1' }],
    ['VERCEL_ENV=production on an eve dev server', { EVE_DEV: '1', VERCEL_ENV: 'production' }],
    ['VERCEL_ENV=preview with NODE_ENV=development', { EVE_DEV: '1', VERCEL_ENV: 'preview', NODE_ENV: 'development' }],
    ['`vercel dev` (VERCEL=1, VERCEL_ENV=development), which eve itself admits', { VERCEL: '1', VERCEL_ENV: 'development' }],
    ['an empty VERCEL (set is set)', { EVE_DEV: '1', VERCEL: '' }],
  ]
  for (const [label, env] of onVercel) {
    it.each(Object.keys(WALKS))(`%s: refuses ${label}`, async (name) => {
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
      expect(await lastEntry(name)(request())).toBeNull()
    })
  }
})
