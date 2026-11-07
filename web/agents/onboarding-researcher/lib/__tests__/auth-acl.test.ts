import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the service-role client so isSessionOwnedByOther's ownership lookup is
// controllable. createClient(...).from('member').select(...).eq(...).limit(...)
// .maybeSingle() resolves to whatever we set on `memberLookup`.
let memberLookup: { data: unknown; error: unknown }
const maybeSingle = vi.fn(async () => memberLookup)
const limit = vi.fn(() => ({ maybeSingle }))
const eq = vi.fn(() => ({ limit }))
const select = vi.fn(() => ({ eq }))
const from = vi.fn(() => ({ select }))

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ from })),
}))

// createServerClient (used by resolveSupabaseSession, not exercised here) —
// stub so the module imports cleanly.
vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(),
}))

vi.mock('cookie', () => ({ parse: vi.fn(() => ({})) }))

import { extractTargetedSessionId, isSessionOwnedByOther, isUnvouchedSessionCreate } from '../auth'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
  memberLookup = { data: null, error: null }
})

const req = (url: string) => new Request(url)

describe('extractTargetedSessionId', () => {
  it('extracts the id from a continue route', () => {
    expect(
      extractTargetedSessionId(
        req('https://app/eve/onboarding-researcher/v1/session/wrun_ABC')
      )
    ).toBe('wrun_ABC')
  })
  it('extracts the id from a stream route', () => {
    expect(
      extractTargetedSessionId(
        req('https://app/eve/onboarding-researcher/v1/session/wrun_ABC/stream')
      )
    ).toBe('wrun_ABC')
  })
  it('extracts the id from a stream route with a query string', () => {
    expect(
      extractTargetedSessionId(
        req('https://app/eve/onboarding-researcher/v1/session/wrun_ABC/stream?startIndex=4')
      )
    ).toBe('wrun_ABC')
  })
  it('returns null for the create route (no id)', () => {
    expect(
      extractTargetedSessionId(
        req('https://app/eve/onboarding-researcher/v1/session')
      )
    ).toBeNull()
  })
  it('returns null for the health route', () => {
    expect(
      extractTargetedSessionId(
        req('https://app/eve/onboarding-researcher/v1/health')
      )
    ).toBeNull()
  })
})

describe('isSessionOwnedByOther — the three branches', () => {
  const streamUrl =
    'https://app/eve/onboarding-researcher/v1/session/wrun_ABC/stream'

  it('ALLOWS (false) when the session is registered to THIS caller', async () => {
    memberLookup = { data: { user_id: 'user-1' }, error: null }
    const owned = await isSessionOwnedByOther(req(streamUrl), 'user-1')
    expect(owned).toBe(false)
  })

  it('REJECTS (true) when the session is registered to ANOTHER user', async () => {
    memberLookup = { data: { user_id: 'user-2' }, error: null }
    const owned = await isSessionOwnedByOther(req(streamUrl), 'user-1')
    expect(owned).toBe(true)
  })

  it('DENIES (true) when the session id is unregistered (unknown)', async () => {
    // Fail-closed: the kickoff route registers a run's real sessionId the instant
    // eve mints it, so an id resolving to NO owner is either not ours or a guess.
    memberLookup = { data: null, error: null }
    const owned = await isSessionOwnedByOther(req(streamUrl), 'user-1')
    expect(owned).toBe(true)
  })

  it('ALLOWS (false) when there is no targeted session (create route)', async () => {
    const owned = await isSessionOwnedByOther(
      req('https://app/eve/onboarding-researcher/v1/session'),
      'user-1'
    )
    expect(owned).toBe(false)
    // No DB lookup at all for the create route.
    expect(from).not.toHaveBeenCalled()
  })

  it('FAILS CLOSED (true) on a query error while checking a registered id', async () => {
    memberLookup = { data: null, error: { message: 'db exploded' } }
    const owned = await isSessionOwnedByOther(req(streamUrl), 'user-1')
    expect(owned).toBe(true)
  })
})

// eve 0.66.3 declares these routes under a session id (dist/src/protocol/
// routes.d.ts) and its handlers call only route auth — never an owner check.
// The matcher must gate EVERY one of them on the (parent) session's owner.
describe('session-scoped control + subagent-stream routes — fail closed on any path under a session id', () => {
  const BASE = 'https://app/eve/onboarding-researcher/v1'
  const scoped = [
    ['cancel', `${BASE}/session/wrun_ABC/cancel`],
    ['compact', `${BASE}/session/wrun_ABC/compact`],
    ['clear', `${BASE}/session/wrun_ABC/clear`],
    ['reset', `${BASE}/session/wrun_ABC/reset`],
    ['subagent stream (parent id)', `${BASE}/session/wrun_ABC/subagents/call_1/wrun_CHILD/stream`],
    ['a route a future eve adds', `${BASE}/session/wrun_ABC/some-new-control`],
  ] as const

  it.each(scoped)('%s: targets the (parent) session id', (_label, url) => {
    expect(extractTargetedSessionId(req(url))).toBe('wrun_ABC')
  })

  it.each(scoped)('%s: a FOREIGN owner is rejected (403)', async (_label, url) => {
    memberLookup = { data: { user_id: 'user-2' }, error: null }
    expect(await isSessionOwnedByOther(req(url), 'user-1')).toBe(true)
    // The ownership lookup keyed on the parent id, never the child's.
    expect((eq.mock.calls.at(-1) as unknown[] | undefined)?.[1]).toBe('wrun_ABC')
  })

  it.each(scoped)('%s: an UNREGISTERED id is rejected (403)', async (_label, url) => {
    memberLookup = { data: null, error: null }
    expect(await isSessionOwnedByOther(req(url), 'user-1')).toBe(true)
  })

  it.each(scoped)('%s: the owner is allowed', async (_label, url) => {
    memberLookup = { data: { user_id: 'user-1' }, error: null }
    expect(await isSessionOwnedByOther(req(url), 'user-1')).toBe(false)
  })

  it('a malformed escape in the id fails closed (rejected, never treated as no session)', async () => {
    memberLookup = { data: null, error: null }
    expect(extractTargetedSessionId(req(`${BASE}/session/%E0%A4%A/cancel`))).toBe('%E0%A4%A')
    expect(await isSessionOwnedByOther(req(`${BASE}/session/%E0%A4%A/cancel`), 'user-1')).toBe(true)
  })

  it('the bare create route (with or without a trailing slash) is still not gated', () => {
    expect(extractTargetedSessionId(req(`${BASE}/session`))).toBeNull()
    expect(extractTargetedSessionId(req(`${BASE}/session/`))).toBeNull()
  })
})

describe('isUnvouchedSessionCreate — only the app starts research', () => {
  const create = (headers: Record<string, string> = {}, path = '/eve/onboarding-researcher/v1/session') =>
    new Request(`https://app.dial8.ai${path}`, { method: 'POST', headers })

  beforeEach(() => {
    vi.stubEnv('AGENT_RUN_INTERNAL_SECRET', 'agent-run-secret')
  })

  it("refuses a create without the app's internal secret, or with a wrong one", () => {
    expect(isUnvouchedSessionCreate(create())).toBe(true)
    expect(isUnvouchedSessionCreate(create({ 'x-agent-run-secret': 'guess' }))).toBe(true)
    expect(isUnvouchedSessionCreate(create({ 'x-agent-run-secret': 'agent-run-secrets' }))).toBe(true)
    expect(isUnvouchedSessionCreate(create({}, '/eve/onboarding-researcher/v1/session/'))).toBe(true)
  })

  it("admits the kickoff route's create, which carries the secret", () => {
    expect(isUnvouchedSessionCreate(create({ 'x-agent-run-secret': 'agent-run-secret' }))).toBe(false)
  })

  it('leaves every other route to the ownership ACL (streams, sends to a session, health)', () => {
    const get = (path: string) => new Request(`https://app.dial8.ai${path}`)
    expect(isUnvouchedSessionCreate(get('/eve/onboarding-researcher/v1/session/s1/stream'))).toBe(false)
    expect(isUnvouchedSessionCreate(create({}, '/eve/onboarding-researcher/v1/session/s1'))).toBe(false)
    expect(isUnvouchedSessionCreate(get('/eve/onboarding-researcher/v1/health'))).toBe(false)
  })

  it('fails closed with no secret configured', () => {
    vi.stubEnv('AGENT_RUN_INTERNAL_SECRET', '')
    vi.stubEnv('RUN_SKILL_INTERNAL_SECRET', '')
    expect(isUnvouchedSessionCreate(create({ 'x-agent-run-secret': '' }))).toBe(true)
    vi.unstubAllEnvs()
  })
})

