import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The eval runner's door (eval-auth.ts, P3). Pinned:
 *   - it skips every request without a `Bearer d8eval_…` token, so the other
 *     entries see exactly what they saw before;
 *   - an eval bearer is refused unless EVE_EVAL_AUTH_ENABLED is exactly '1', the
 *     deployment is provably not production, the database is DEV's by hostname,
 *     the secret is set (32+ chars) and matches, and the fixture ids are set;
 *     the 401 never echoes why;
 *   - "provably not production" off Vercel is a dev server: EVE_DEV exactly '1'
 *     and NODE_ENV not 'production'. Our own server sets no Vercel variable, so
 *     its live copy and a rehearsal copy (NI_LIVE empty, production's database)
 *     are refused whatever NI_LIVE says, and so is any built agent. Where a
 *     Vercel variable is set, only preview/development pass (an unknown env, or
 *     VERCEL without VERCEL_ENV, is production);
 *   - the principal must be the fixture's auth user (by email, service role), in
 *     a marked, single-member fixture workspace with its user's conversation (a
 *     query error refuses; a failure is never cached);
 *   - a session registered to anyone else is 403, an unregistered one is
 *     admitted, a lookup error is 403;
 *   - success grants allowToolStubs and a chat-run token the APP verifies for
 *     the fixture's conversation (no surface, no server claim);
 *   - it runs first on the channel, and no other chat-agent file grants stubs.
 */

const CHAT_SECRET = 'chat-internal-secret-0123456789'
const EVAL_SECRET = 'eval-secret-0123456789abcdef0123456789'
const USER = '11111111-1111-4111-8111-111111111111'
const WS = '22222222-2222-4222-8222-222222222222'
const CONV = '33333333-3333-4333-8333-333333333333'
const OTHER = '44444444-4444-4444-8444-444444444444'

const db = {
  authEmail: 'evals@dial8-evals.test' as string | null,
  workspace: { id: WS, settings: { eval_fixture: true } } as { id: string; settings: Record<string, unknown> } | null,
  members: [{ user_id: USER }] as Array<{ user_id: string }>,
  conversation: { id: CONV, user_id: USER, workspace_id: WS } as { id: string; user_id: string; workspace_id: string } | null,
  /** eve_session_id → owning conversation row. */
  sessions: {} as Record<string, { id: string; user_id: string; workspace_id: string }>,
  error: null as null | 'auth' | 'workspace' | 'member' | 'chat_conversations' | 'session',
  calls: 0,
}

function query(table: string) {
  db.calls++
  const eqs: Array<[string, unknown]> = []
  const result = () => {
    if (table === 'member') {
      return db.error === 'member' ? { data: null, error: { message: 'boom' } } : { data: db.members, error: null }
    }
    throw new Error(`unexpected list read of ${table}`)
  }
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: (c: string, v: unknown) => {
      eqs.push([c, v])
      return chain
    },
    limit: () => chain,
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(result).then(resolve, reject),
    maybeSingle: async () => {
      if (table === 'workspace') return db.error === 'workspace' ? { data: null, error: { message: 'boom' } } : { data: db.workspace, error: null }
      if (table === 'chat_conversations') {
        const session = eqs.find(([c]) => c === 'eve_session_id')?.[1] as string | undefined
        if (session !== undefined) {
          if (db.error === 'session') return { data: null, error: { message: 'boom' } }
          return { data: db.sessions[session] ?? null, error: null }
        }
        return db.error === 'chat_conversations' ? { data: null, error: { message: 'boom' } } : { data: db.conversation, error: null }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return chain
}

const admin = {
  getUserById: async (id: string) => {
    db.calls++
    if (db.error === 'auth') return { data: { user: null }, error: { message: 'boom' } }
    return { data: { user: id === USER && db.authEmail !== null ? { id, email: db.authEmail } : null }, error: null }
  },
}

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => ({ from: query, auth: { admin } })) }))
vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { getUser: async () => ({ data: { user: null } }) }, from: query })),
}))
vi.mock('eve/channels/eve', () => ({ eveChannel: (cfg: unknown) => cfg }))

import { ForbiddenError, UnauthenticatedError, type AuthFn } from 'eve/channels/auth'
import {
  EVAL_TOKEN_TTL_MS,
  evalAuthDisabledReason,
  evalRunnerAuth,
  isNonProductionDeployment,
  mintEvalRunToken,
  resetEvalFixtureCache,
} from '../eval-auth'
import channel from '../../channels/eve'
import { verifyChatRunToken } from '@/lib/chat/chat-run-token'

const MOUNT = 'https://app/eve/chat-agent/v1'
const entry = evalRunnerAuth()
const evalReq = (method: string, path: string, over: { secret?: string; headers?: Record<string, string> } = {}) =>
  new Request(`${MOUNT}${path}`, {
    method,
    headers: { authorization: `Bearer d8eval_${over.secret ?? EVAL_SECRET}`, ...over.headers },
  })

async function rejection(p: unknown): Promise<{ status: number; code: string; err: unknown }> {
  try {
    await p
  } catch (err) {
    const res = (err as ForbiddenError | UnauthenticatedError).response
    return { status: res.status, code: ((await res.json()) as { code: string }).code, err }
  }
  throw new Error('expected a rejection')
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://edrjddsxjoigpbecqgfb.supabase.co'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'
  process.env.CHAT_INTERNAL_SECRET = CHAT_SECRET
  delete process.env.RUN_SKILL_INTERNAL_SECRET
  process.env.EVE_EVAL_AUTH_ENABLED = '1'
  process.env.EVE_EVAL_SECRET = EVAL_SECRET
  process.env.EVE_EVAL_USER_ID = USER
  process.env.EVE_EVAL_WORKSPACE_ID = WS
  process.env.EVE_EVAL_CONVERSATION_ID = CONV
  delete process.env.VERCEL_ENV
  delete process.env.VERCEL_TARGET_ENV
  delete process.env.VERCEL
  delete process.env.NI_LIVE
  // A local dev server, as `next dev` boots it: `eve dev` sets EVE_DEV=1.
  process.env.EVE_DEV = '1'
  db.authEmail = 'evals@dial8-evals.test'
  db.workspace = { id: WS, settings: { eval_fixture: true } }
  db.members = [{ user_id: USER }]
  db.conversation = { id: CONV, user_id: USER, workspace_id: WS }
  db.sessions = {}
  db.error = null
  db.calls = 0
  resetEvalFixtureCache()
})

afterEach(() => {
  vi.unstubAllEnvs()
  delete process.env.EVE_DEV
  delete process.env.NI_LIVE
})

/** Our own server's containers: the image sets NODE_ENV=production, the entrypoint refuses EVE_DEV=1, no Vercel variable. */
function onOurServer(live: boolean) {
  vi.stubEnv('NODE_ENV', 'production')
  delete process.env.EVE_DEV
  if (live) process.env.NI_LIVE = '1'
}

describe('evalRunnerAuth: skips everything that is not an eval bearer', () => {
  it.each([
    ['no auth header', {}],
    ['a Supabase JWT', { authorization: 'Bearer eyJhbGciOi.payload.sig' }],
    ['a device token', { authorization: 'Bearer nid_abc' }],
    ['basic auth', { authorization: 'Basic dXNlcjpwYXNz' }],
    ['the chat secret header', { 'x-chat-run-secret': CHAT_SECRET }],
  ])('%s → null, without touching the database', async (_label, headers) => {
    expect(await entry(new Request(`${MOUNT}/session`, { method: 'POST', headers }))).toBeNull()
    expect(db.calls).toBe(0)
  })

  it('skips even when the eval path is off', async () => {
    delete process.env.EVE_EVAL_AUTH_ENABLED
    expect(await entry(new Request(`${MOUNT}/session`, { method: 'POST' }))).toBeNull()
  })
})

describe('evalRunnerAuth: every switch must be on (fail closed)', () => {
  it.each([
    ['the flag unset', () => delete process.env.EVE_EVAL_AUTH_ENABLED, 'flag_off'],
    ['the flag "true", not "1"', () => (process.env.EVE_EVAL_AUTH_ENABLED = 'true'), 'flag_off'],
    ['a production deployment', () => (process.env.VERCEL_ENV = 'production'), 'production'],
    ['a production target env', () => (process.env.VERCEL_TARGET_ENV = 'production'), 'production'],
    ['an unknown deployment env', () => (process.env.VERCEL_ENV = 'staging'), 'production'],
    ['an unknown target env on a preview', () => ((process.env.VERCEL_ENV = 'preview'), (process.env.VERCEL_TARGET_ENV = 'qa')), 'production'],
    ['VERCEL set without VERCEL_ENV', () => (process.env.VERCEL = '1'), 'production'],
    ['our server, the live copy (NI_LIVE=1)', () => onOurServer(true), 'production'],
    ['our server, a rehearsal copy (NI_LIVE empty, production’s database)', () => onOurServer(false), 'production'],
    ['our server with a stray EVE_DEV=1', () => (onOurServer(true), (process.env.EVE_DEV = '1')), 'production'],
    ['a rehearsal copy with a stray EVE_DEV=1', () => (onOurServer(false), (process.env.EVE_DEV = '1')), 'production'],
    ['a built agent on a developer’s machine (`eve start`: no EVE_DEV)', () => delete process.env.EVE_DEV, 'production'],
    ['a built agent with NODE_ENV=production and EVE_DEV=1', () => vi.stubEnv('NODE_ENV', 'production'), 'production'],
    ['EVE_DEV "true", not "1"', () => (process.env.EVE_DEV = 'true'), 'production'],
    ['an empty EVE_DEV', () => (process.env.EVE_DEV = ''), 'production'],
    ['the PROD database', () => (process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://bzfthjzyzevjokbuhqci.supabase.co'), 'not_dev_database'],
    ['another Supabase host', () => (process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'), 'not_dev_database'],
    ['a host that only contains the DEV ref', () => (process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://edrjddsxjoigpbecqgfb.supabase.co.evil.example'), 'not_dev_database'],
    ['no database URL', () => delete process.env.NEXT_PUBLIC_SUPABASE_URL, 'not_dev_database'],
    ['no secret', () => delete process.env.EVE_EVAL_SECRET, 'secret_missing'],
    ['a short secret', () => (process.env.EVE_EVAL_SECRET = 'short-secret'), 'secret_missing'],
    ['no user id', () => delete process.env.EVE_EVAL_USER_ID, 'principal_missing'],
    ['a workspace id that is not a uuid', () => (process.env.EVE_EVAL_WORKSPACE_ID = 'ws-1'), 'principal_missing'],
    ['no conversation id', () => delete process.env.EVE_EVAL_CONVERSATION_ID, 'principal_missing'],
  ])('%s → 401 eval_auth_disabled, without saying why', async (_label, mutate, reason) => {
    mutate()
    expect(evalAuthDisabledReason()).toBe(reason)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const r = await rejection(entry(evalReq('POST', '/session')))
      expect(r.err).toBeInstanceOf(UnauthenticatedError)
      expect([r.status, r.code]).toEqual([401, 'eval_auth_disabled'])
      const body = (r.err as Error).message
      expect(body).toBe('Eval access is off on this deployment.')
      expect(body).not.toContain(reason as string)
      expect(warn).toHaveBeenCalledWith('[eval-auth] refused an eval bearer', { reason })
    } finally {
      warn.mockRestore()
    }
    expect(db.calls).toBe(0)
  })

  it('a local dev server (EVE_DEV=1, NODE_ENV development or unset) with every switch on is enabled', () => {
    expect(evalAuthDisabledReason()).toBeNull()
    vi.stubEnv('NODE_ENV', 'development')
    expect(evalAuthDisabledReason()).toBeNull()
    vi.stubEnv('NODE_ENV', undefined)
    expect(evalAuthDisabledReason()).toBeNull()
  })

  it('a Vercel preview or development deployment is judged by its Vercel variables alone', () => {
    delete process.env.EVE_DEV
    vi.stubEnv('NODE_ENV', 'production')
    for (const env of ['preview', 'development']) {
      process.env.VERCEL = '1'
      process.env.VERCEL_ENV = env
      process.env.VERCEL_TARGET_ENV = env
      expect(evalAuthDisabledReason()).toBeNull()
    }
  })

  it('NI_LIVE opens nothing and shuts nothing: a dev server is one with or without it', () => {
    process.env.NI_LIVE = '1'
    expect(evalAuthDisabledReason()).toBeNull()
    expect(isNonProductionDeployment({ NODE_ENV: 'production' })).toBe(false)
    expect(isNonProductionDeployment({ NODE_ENV: 'production', NI_LIVE: '' })).toBe(false)
    expect(isNonProductionDeployment({ NODE_ENV: 'production', NI_LIVE: '1' })).toBe(false)
    expect(isNonProductionDeployment({} as NodeJS.ProcessEnv)).toBe(false)
  })

  it.each([['a wrong secret', 'eval-secret-0123456789abcdef0123456788'], ['an empty secret', ''], ['a longer secret', `${EVAL_SECRET}x`]])(
    '%s → 401 eval_auth_invalid',
    async (_label, secret) => {
      const r = await rejection(entry(evalReq('POST', '/session', { secret })))
      expect([r.status, r.code]).toEqual([401, 'eval_auth_invalid'])
      expect(db.calls).toBe(0)
    },
  )
})

describe('evalRunnerAuth: only a marked, single-member fixture', () => {
  it.each([
    ['the user is not the fixture’s auth user (the marker alone is forgeable)', () => (db.authEmail = 'owner@example.com')],
    ['the auth user is missing', () => (db.authEmail = null)],
    ['the auth user read fails', () => (db.error = 'auth')],
    ['the workspace is not marked', () => (db.workspace = { id: WS, settings: {} })],
    ['the marker is not literally true', () => (db.workspace = { id: WS, settings: { eval_fixture: 'true' } })],
    ['the workspace is missing', () => (db.workspace = null)],
    ['a real person is also a member', () => (db.members = [{ user_id: USER }, { user_id: OTHER }])],
    ['the eval user is not the member', () => (db.members = [{ user_id: OTHER }])],
    ['nobody is a member', () => (db.members = [])],
    ['the conversation is someone else’s', () => (db.conversation = { id: CONV, user_id: OTHER, workspace_id: WS })],
    ['the conversation is in another workspace', () => (db.conversation = { id: CONV, user_id: USER, workspace_id: OTHER })],
    ['the conversation is missing', () => (db.conversation = null)],
    ['the workspace read fails', () => (db.error = 'workspace')],
    ['the member read fails', () => (db.error = 'member')],
    ['the conversation read fails', () => (db.error = 'chat_conversations')],
  ])('%s → 403 eval_fixture_invalid', async (_label, mutate) => {
    mutate()
    const r = await rejection(entry(evalReq('POST', '/session')))
    expect(r.err).toBeInstanceOf(ForbiddenError)
    expect([r.status, r.code]).toEqual([403, 'eval_fixture_invalid'])
  })

  it('a failed check is not cached: the next request checks again', async () => {
    db.workspace = { id: WS, settings: {} }
    await rejection(entry(evalReq('POST', '/session')))
    db.workspace = { id: WS, settings: { eval_fixture: true } }
    expect(await entry(evalReq('POST', '/session'))).toMatchObject({ allowToolStubs: true })
  })
})

describe('evalRunnerAuth: sessions', () => {
  it('a session registered to another user or workspace is 403', async () => {
    db.sessions.sess_THEIRS = { id: 'conv-x', user_id: OTHER, workspace_id: WS }
    db.sessions.sess_OTHER_WS = { id: 'conv-y', user_id: USER, workspace_id: OTHER }
    for (const path of ['/session/sess_THEIRS', '/session/sess_THEIRS/stream', '/session/sess_OTHER_WS/cancel']) {
      const r = await rejection(entry(evalReq(path.endsWith('stream') ? 'GET' : 'POST', path)))
      expect([r.status, r.code]).toEqual([403, 'session_forbidden'])
    }
  })

  it('the fixture’s own registered session and an unregistered one are admitted', async () => {
    db.sessions.sess_MINE = { id: CONV, user_id: USER, workspace_id: WS }
    expect(await entry(evalReq('POST', '/session/sess_MINE'))).toMatchObject({ principalId: USER })
    expect(await entry(evalReq('GET', '/session/sess_EVAL_NEW/stream'))).toMatchObject({ principalId: USER })
  })

  it('a lookup error is 403', async () => {
    db.error = 'session'
    const r = await rejection(entry(evalReq('POST', '/session/sess_ANY')))
    expect([r.status, r.code]).toEqual([403, 'session_forbidden'])
  })
})

describe('evalRunnerAuth: what an admitted eval gets', () => {
  it('the fixture principal, tool stubs, and a token the app verifies for its conversation', async () => {
    const before = Date.now()
    const auth = await entry(evalReq('POST', '/session', { headers: { 'x-chat-run-ctx': 'eyJ0eiI6IlVUQyJ9' } }))
    expect(auth).toMatchObject({
      authenticator: 'eval',
      principalId: USER,
      principalType: 'user',
      allowToolStubs: true,
      attributes: { workspaceId: WS, chatRunCtx: 'eyJ0eiI6IlVUQyJ9' },
    })
    const token = (auth as unknown as { attributes: { chatRunToken: string } }).attributes.chatRunToken
    const claims = verifyChatRunToken(token)
    expect(claims).toMatchObject({ conversationId: CONV, userId: USER, workspaceId: WS })
    // The in-app chat: no surface, no server principal, no relay, no teammate.
    for (const key of ['surface', 'server', 'relay', 'teammateId', 'cred']) expect(claims).not.toHaveProperty(key)
    expect(claims!.exp).toBeGreaterThanOrEqual(before + EVAL_TOKEN_TTL_MS)
    expect(claims!.exp).toBeLessThanOrEqual(Date.now() + EVAL_TOKEN_TTL_MS)
  })

  it('the RUN_SKILL fallback secret mints too; no chat secret at all is 403', async () => {
    delete process.env.CHAT_INTERNAL_SECRET
    process.env.RUN_SKILL_INTERNAL_SECRET = CHAT_SECRET
    expect(verifyChatRunToken(mintEvalRunToken({ userId: USER, workspaceId: WS, conversationId: CONV })!)).not.toBeNull()
    delete process.env.RUN_SKILL_INTERNAL_SECRET
    const r = await rejection(entry(evalReq('POST', '/session')))
    expect([r.status, r.code]).toEqual([403, 'chat_run_token_required'])
  })
})

describe('the channel', () => {
  const walk = (channel as unknown as { auth: AuthFn<Request>[] }).auth

  it('runs the eval entry first, end to end', async () => {
    expect(walk).toHaveLength(5)
    expect(await walk[0](evalReq('POST', '/session'))).toMatchObject({ authenticator: 'eval', allowToolStubs: true })
    delete process.env.EVE_EVAL_AUTH_ENABLED
    await expect(walk[0](evalReq('POST', '/session'))).rejects.toThrow(UnauthenticatedError)
  })

  it('no other chat-agent file grants tool stubs', () => {
    const root = join(__dirname, '../..')
    const files: string[] = []
    const walkDir = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === '__tests__' || name === 'node_modules' || name.startsWith('.')) continue
        const full = join(dir, name)
        if (statSync(full).isDirectory()) walkDir(full)
        else if (name.endsWith('.ts')) files.push(full)
      }
    }
    walkDir(root)
    const granting = files.filter((f) => /allowToolStubs/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(root.length + 1))
    expect(granting).toEqual(['lib/eval-auth.ts'])
  })
})
