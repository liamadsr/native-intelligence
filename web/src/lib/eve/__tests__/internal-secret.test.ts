import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetInternalSecretLogForTests,
  INTERNAL_SECRET_ENVS,
  internalSecretSource,
  internalSecretStatus,
  resolveInternalSecret,
} from '../internal-secret'
import { internalSecret as chatSecret } from '@/lib/chat/chat-run-token'
import { internalSecret as agentRunSecret } from '@/lib/agent-run/agent-run-token'
import { internalSecret as liveAgentSecret } from '@/lib/live-agent/live-agent-run-token'
import { utilityInternalSecret } from '../utility-run-token'

const ROOT = 'root-secret-value-ROOT'
const OWN = 'own-secret-value-OWN'

describe('resolveInternalSecret', () => {
  let info: ReturnType<typeof vi.spyOn>
  let warn: ReturnType<typeof vi.spyOn>
  /** Every line either level logged, in order. */
  let lines: string[]

  beforeEach(() => {
    __resetInternalSecretLogForTests()
    lines = []
    info = vi.spyOn(console, 'info').mockImplementation((m: unknown) => void lines.push(String(m)))
    warn = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => void lines.push(String(m)))
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  const logged = () => lines

  it('classifies dedicated, shared, fallback and unset', () => {
    vi.stubEnv('RUN_SKILL_INTERNAL_SECRET', ROOT)
    vi.stubEnv('CHAT_INTERNAL_SECRET', OWN)
    expect(internalSecretSource('CHAT_INTERNAL_SECRET')).toBe('dedicated')
    vi.stubEnv('CHAT_INTERNAL_SECRET', ROOT)
    expect(internalSecretSource('CHAT_INTERNAL_SECRET')).toBe('shared')
    vi.stubEnv('CHAT_INTERNAL_SECRET', '')
    expect(internalSecretSource('CHAT_INTERNAL_SECRET')).toBe('fallback')
    vi.stubEnv('RUN_SKILL_INTERNAL_SECRET', '')
    expect(internalSecretSource('CHAT_INTERNAL_SECRET')).toBe('unset')
  })

  it('an EMPTY dedicated value falls back to RUN_SKILL and says so with a warning', () => {
    vi.stubEnv('RUN_SKILL_INTERNAL_SECRET', ROOT)
    vi.stubEnv('CHAT_INTERNAL_SECRET', '')
    expect(resolveInternalSecret('chat', 'CHAT_INTERNAL_SECRET')).toBe(ROOT)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toBe(
      '[internal-secret] {"family":"chat","env":"CHAT_INTERNAL_SECRET","secretSource":"fallback"}',
    )
    expect(info).not.toHaveBeenCalled()
  })

  it('a dedicated value equal to RUN_SKILL is reported as shared', () => {
    vi.stubEnv('RUN_SKILL_INTERNAL_SECRET', ROOT)
    vi.stubEnv('AGENT_RUN_INTERNAL_SECRET', ROOT)
    expect(resolveInternalSecret('agent-run', 'AGENT_RUN_INTERNAL_SECRET')).toBe(ROOT)
    expect(warn.mock.calls[0][0]).toContain('"secretSource":"shared"')
  })

  it('names RUN_SKILL in sharedWith when a dedicated value equals it', () => {
    vi.stubEnv('RUN_SKILL_INTERNAL_SECRET', ROOT)
    vi.stubEnv('AGENT_RUN_INTERNAL_SECRET', ROOT)
    resolveInternalSecret('agent-run', 'AGENT_RUN_INTERNAL_SECRET')
    expect(warn.mock.calls[0][0]).toBe(
      '[internal-secret] {"family":"agent-run","env":"AGENT_RUN_INTERNAL_SECRET","secretSource":"shared","sharedWith":["RUN_SKILL_INTERNAL_SECRET"]}',
    )
  })

  it('two dedicated families holding the same value (distinct from RUN_SKILL) are BOTH shared, naming each other', () => {
    vi.stubEnv('RUN_SKILL_INTERNAL_SECRET', ROOT)
    vi.stubEnv('CHAT_INTERNAL_SECRET', OWN)
    vi.stubEnv('LIVE_AGENT_INTERNAL_SECRET', OWN)
    vi.stubEnv('AGENT_RUN_INTERNAL_SECRET', 'agent-run-own')
    expect(internalSecretStatus('CHAT_INTERNAL_SECRET')).toEqual({
      source: 'shared',
      sharedWith: ['LIVE_AGENT_INTERNAL_SECRET'],
    })
    expect(resolveInternalSecret('chat', 'CHAT_INTERNAL_SECRET')).toBe(OWN)
    expect(resolveInternalSecret('live-agent', 'LIVE_AGENT_INTERNAL_SECRET')).toBe(OWN)
    expect(resolveInternalSecret('agent-run', 'AGENT_RUN_INTERNAL_SECRET')).toBe('agent-run-own')
    expect(logged()).toEqual([
      '[internal-secret] {"family":"chat","env":"CHAT_INTERNAL_SECRET","secretSource":"shared","sharedWith":["LIVE_AGENT_INTERNAL_SECRET"]}',
      '[internal-secret] {"family":"live-agent","env":"LIVE_AGENT_INTERNAL_SECRET","secretSource":"shared","sharedWith":["CHAT_INTERNAL_SECRET"]}',
      '[internal-secret] {"family":"agent-run","env":"AGENT_RUN_INTERNAL_SECRET","secretSource":"dedicated"}',
    ])
    expect(warn).toHaveBeenCalledTimes(2)
    const all = logged().join('\n')
    expect(all).not.toContain(OWN)
    expect(all).not.toContain(ROOT)
  })

  it('agent-run and utility sharing a value are both shared too (every pair is compared)', () => {
    vi.stubEnv('RUN_SKILL_INTERNAL_SECRET', ROOT)
    vi.stubEnv('AGENT_RUN_INTERNAL_SECRET', OWN)
    vi.stubEnv('UTILITY_INTERNAL_SECRET', OWN)
    expect(internalSecretStatus('AGENT_RUN_INTERNAL_SECRET').sharedWith).toEqual(['UTILITY_INTERNAL_SECRET'])
    expect(internalSecretStatus('UTILITY_INTERNAL_SECRET').sharedWith).toEqual(['AGENT_RUN_INTERNAL_SECRET'])
    // A value shared with RUN_SKILL and another family names both.
    vi.stubEnv('CHAT_INTERNAL_SECRET', ROOT)
    vi.stubEnv('LIVE_AGENT_INTERNAL_SECRET', ROOT)
    expect(internalSecretStatus('CHAT_INTERNAL_SECRET').sharedWith).toEqual([
      'RUN_SKILL_INTERNAL_SECRET',
      'LIVE_AGENT_INTERNAL_SECRET',
    ])
  })

  it('logs again when the sharedWith set changes, even if the source stays shared', () => {
    vi.stubEnv('RUN_SKILL_INTERNAL_SECRET', ROOT)
    vi.stubEnv('CHAT_INTERNAL_SECRET', OWN)
    vi.stubEnv('UTILITY_INTERNAL_SECRET', OWN)
    resolveInternalSecret('chat', 'CHAT_INTERNAL_SECRET')
    vi.stubEnv('LIVE_AGENT_INTERNAL_SECRET', OWN)
    resolveInternalSecret('chat', 'CHAT_INTERNAL_SECRET')
    resolveInternalSecret('chat', 'CHAT_INTERNAL_SECRET')
    expect(logged()).toHaveLength(2)
    expect(logged()[1]).toContain('"sharedWith":["UTILITY_INTERNAL_SECRET","LIVE_AGENT_INTERNAL_SECRET"]')
  })

  it('compares against exactly the eight internal-secret env vars the resolvers use', () => {
    expect([...INTERNAL_SECRET_ENVS].sort()).toEqual([
      'AGENT_RUN_INTERNAL_SECRET',
      'BROWSER_INTERNAL_SECRET',
      'CAPTURE_FEED_SECRET',
      'CHAT_INTERNAL_SECRET',
      'LIVE_AGENT_INTERNAL_SECRET',
      'LOCAL_AGENT_TOKEN_SECRET',
      'RUN_SKILL_INTERNAL_SECRET',
      'UTILITY_INTERNAL_SECRET',
    ])
  })

  it("never falls back for the capture feed: its producer must not hold the skill-runner's key", () => {
    vi.stubEnv('RUN_SKILL_INTERNAL_SECRET', ROOT)
    vi.stubEnv('CAPTURE_FEED_SECRET', '')
    expect(internalSecretStatus('CAPTURE_FEED_SECRET', { fallback: false })).toEqual({ source: 'unset', sharedWith: [] })
    expect(resolveInternalSecret('capture-feed', 'CAPTURE_FEED_SECRET', { fallback: false })).toBeNull()
    expect(logged()[0]).toContain('"family":"capture-feed","env":"CAPTURE_FEED_SECRET","secretSource":"unset"')
    vi.stubEnv('CAPTURE_FEED_SECRET', ROOT)
    expect(internalSecretStatus('CAPTURE_FEED_SECRET', { fallback: false })).toEqual({ source: 'shared', sharedWith: ['RUN_SKILL_INTERNAL_SECRET'] })
    vi.stubEnv('CAPTURE_FEED_SECRET', OWN)
    expect(resolveInternalSecret('capture-feed', 'CAPTURE_FEED_SECRET', { fallback: false })).toBe(OWN)
  })

  it("reports a family sharing the local agent's model-token secret (security review 2026-10-31)", () => {
    vi.stubEnv('RUN_SKILL_INTERNAL_SECRET', ROOT)
    vi.stubEnv('CHAT_INTERNAL_SECRET', OWN)
    vi.stubEnv('LOCAL_AGENT_TOKEN_SECRET', OWN)
    expect(internalSecretStatus('CHAT_INTERNAL_SECRET')).toEqual({ source: 'shared', sharedWith: ['LOCAL_AGENT_TOKEN_SECRET'] })
    expect(internalSecretStatus('LOCAL_AGENT_TOKEN_SECRET')).toEqual({ source: 'shared', sharedWith: ['CHAT_INTERNAL_SECRET'] })
    vi.stubEnv('LOCAL_AGENT_TOKEN_SECRET', '')
    expect(resolveInternalSecret('local-agent', 'LOCAL_AGENT_TOKEN_SECRET')).toBe(ROOT)
    expect(logged()[0]).toContain('"family":"local-agent","env":"LOCAL_AGENT_TOKEN_SECRET","secretSource":"fallback"')
  })

  it('a distinct dedicated value is used and logged at info', () => {
    vi.stubEnv('RUN_SKILL_INTERNAL_SECRET', ROOT)
    vi.stubEnv('LIVE_AGENT_INTERNAL_SECRET', OWN)
    expect(resolveInternalSecret('live-agent', 'LIVE_AGENT_INTERNAL_SECRET')).toBe(OWN)
    expect(info.mock.calls[0][0]).toContain('"secretSource":"dedicated"')
    expect(warn).not.toHaveBeenCalled()
  })

  it('unset resolves to null', () => {
    expect(resolveInternalSecret('utility', 'UTILITY_INTERNAL_SECRET')).toBeNull()
    expect(warn.mock.calls[0][0]).toContain('"secretSource":"unset"')
  })

  it('logs once per process per family, and again only when the source changes', () => {
    vi.stubEnv('RUN_SKILL_INTERNAL_SECRET', ROOT)
    vi.stubEnv('CHAT_INTERNAL_SECRET', OWN)
    for (let i = 0; i < 5; i++) resolveInternalSecret('chat', 'CHAT_INTERNAL_SECRET')
    expect(logged()).toHaveLength(1)
    resolveInternalSecret('utility', 'UTILITY_INTERNAL_SECRET')
    expect(logged()).toHaveLength(2)
    vi.stubEnv('CHAT_INTERNAL_SECRET', '')
    resolveInternalSecret('chat', 'CHAT_INTERNAL_SECRET')
    expect(logged()).toHaveLength(3)
  })

  it('never logs a secret value', () => {
    vi.stubEnv('RUN_SKILL_INTERNAL_SECRET', ROOT)
    for (const [family, env] of [
      ['chat', 'CHAT_INTERNAL_SECRET'],
      ['agent-run', 'AGENT_RUN_INTERNAL_SECRET'],
      ['live-agent', 'LIVE_AGENT_INTERNAL_SECRET'],
      ['utility', 'UTILITY_INTERNAL_SECRET'],
    ] as const) {
      vi.stubEnv(env, OWN)
      resolveInternalSecret(family, env)
      vi.stubEnv(env, ROOT)
      resolveInternalSecret(family, env)
      vi.stubEnv(env, '')
      resolveInternalSecret(family, env)
    }
    const all = logged().join('\n')
    expect(logged().length).toBe(12)
    expect(all).not.toContain(ROOT)
    expect(all).not.toContain(OWN)
  })

  it('each run-token family resolves through it, with its own dedicated env var', () => {
    vi.stubEnv('RUN_SKILL_INTERNAL_SECRET', ROOT)
    const cases = [
      ['chat', 'CHAT_INTERNAL_SECRET', chatSecret],
      ['agent-run', 'AGENT_RUN_INTERNAL_SECRET', agentRunSecret],
      ['live-agent', 'LIVE_AGENT_INTERNAL_SECRET', liveAgentSecret],
      ['utility', 'UTILITY_INTERNAL_SECRET', utilityInternalSecret],
    ] as const
    for (const [family, env, resolve] of cases) {
      vi.stubEnv(env, '')
      expect(resolve(), `${family} empty → fallback`).toBe(ROOT)
      expect(logged().at(-1)).toBe(`[internal-secret] {"family":"${family}","env":"${env}","secretSource":"fallback"}`)
      vi.stubEnv(env, `${OWN}-${family}`)
      expect(resolve(), `${family} dedicated`).toBe(`${OWN}-${family}`)
      expect(logged().at(-1)).toContain(`"family":"${family}","env":"${env}","secretSource":"dedicated"`)
    }
  })
})
