import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Device-token principals on the user-facing chat-agent channel
 * (/api/device/ask's one-shot task sessions).
 *
 * The device relays its OWN `d8d_` token; the channel resolves it to the owning
 * user + active workspace (twin of src/lib/device-tokens.ts) and runs the SAME
 * session-ownership ACL the Supabase entry runs. Pinned here:
 *   - resolution: unknown / expired / non-device bearers skip; the token's active
 *     workspace wins, else the owner's OLDEST membership;
 *   - the ACL: a device session registered to (user-1, ws-1) can be streamed /
 *     cancelled / continued by that principal only — another user's device, the
 *     same user pointed at another workspace, an unregistered id (the row is
 *     deleted when the ask ends) and a lookup error are all 403;
 *   - no bypass: the internal secret as a bearer is not a principal here, and
 *     the channel's only secret entry is the narrow server principal
 *     (server-compaction-auth.test.ts: compact + stream read only).
 */

const SECRET = 'chat-internal-secret-0123456789'
const hashOf = (t: string) => createHash('sha256').update(t).digest('hex')

interface DeviceRow {
  user_id: string
  active_workspace_id: string | null
  expires_at: string | null
}
const state: {
  devices: Record<string, DeviceRow>
  oldestMembership: Record<string, string>
  /** eve_session_id → owner (chat_conversations rows). */
  sessions: Record<string, { id: string; user_id: string; workspace_id: string }>
  sessionLookupError: boolean
  queries: Array<{ table: string; eqs: Array<[string, unknown]>; order?: [string, unknown]; limit?: number }>
} = { devices: {}, oldestMembership: {}, sessions: {}, sessionLookupError: false, queries: [] }

function query(table: string) {
  const eqs: Array<[string, unknown]> = []
  const recorded: { table: string; eqs: Array<[string, unknown]>; order?: [string, unknown]; limit?: number } = { table, eqs }
  state.queries.push(recorded)
  const val = (col: string) => eqs.find(([c]) => c === col)?.[1] as string
  const resolve = async () => {
    if (table === 'device_token') return { data: state.devices[val('token_hash')] ?? null, error: null }
    if (table === 'member') {
      const ws = state.oldestMembership[val('user_id')]
      return { data: ws ? { workspace_id: ws } : null, error: null }
    }
    if (table === 'chat_conversations') {
      if (state.sessionLookupError) return { data: null, error: { message: 'db down' } }
      return { data: state.sessions[val('eve_session_id')] ?? null, error: null }
    }
    throw new Error(`unexpected table ${table}`)
  }
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: (c: string, v: unknown) => {
      eqs.push([c, v])
      return chain
    },
    order: (col: string, opts: unknown) => {
      recorded.order = [col, opts]
      return chain
    },
    limit: (n: number) => {
      recorded.limit = n
      return chain
    },
    maybeSingle: resolve,
  }
  return chain
}

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => ({ from: query })) }))
vi.mock('@supabase/ssr', () => ({ createServerClient: vi.fn() }))

import { ForbiddenError } from 'eve/channels/auth'
import { createServerClient } from '@supabase/ssr'
import {
  resolveDeviceTokenSession,
  deviceTokenAuthWithAcl,
  isSessionOwnedByOther,
  resolveSupabaseSession,
  verifyDeviceAskRunToken,
} from '../auth'
import { mintChatRunToken } from '@/lib/chat/chat-run-token'

const MOUNT = 'https://app/eve/chat-agent/v1'
const DEVICE_A = 'd8d_device-of-user-1'
const DEVICE_B = 'd8d_device-of-user-2'

const req = (path: string, bearer?: string, extra: Record<string, string> = {}) =>
  new Request(`${MOUNT}${path}`, {
    method: 'POST',
    headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...extra },
  })

/** A real device-ask run token (the ask mints one per question, for its own row). */
const askToken = (over: Partial<{ conversationId: string; userId: string; workspaceId: string }> = {}) =>
  mintChatRunToken({ conversationId: 'conv-dev', userId: 'user-1', workspaceId: 'ws-1', surface: 'device_ask', ...over })
/** A device request as the ask's eve Client sends it: the device token + its run token. */
const devReq = (path: string, bearer: string, token: string = askToken(), extra: Record<string, string> = {}) =>
  req(path, bearer, { 'x-chat-run-token': token, ...extra })

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
  process.env.CHAT_INTERNAL_SECRET = SECRET
  state.devices = {
    [hashOf(DEVICE_A)]: { user_id: 'user-1', active_workspace_id: 'ws-1', expires_at: null },
    [hashOf(DEVICE_B)]: { user_id: 'user-2', active_workspace_id: 'ws-1', expires_at: null },
  }
  state.oldestMembership = { 'user-1': 'ws-oldest' }
  // The ask's ownership row: device session `wrun_DEV` belongs to (user-1, ws-1).
  state.sessions = { wrun_DEV: { id: 'conv-dev', user_id: 'user-1', workspace_id: 'ws-1' } }
  state.sessionLookupError = false
  state.queries = []
})

describe('resolveDeviceTokenSession', () => {
  it('maps a live device token to its owner + active workspace (looked up by SHA-256 hash, never plaintext)', async () => {
    expect(await resolveDeviceTokenSession(req('/session', DEVICE_A))).toEqual({ userId: 'user-1', workspaceId: 'ws-1' })
    const lookup = state.queries.find((q) => q.table === 'device_token')!
    expect(lookup.eqs).toEqual([['token_hash', hashOf(DEVICE_A)]])
  })

  it('no active workspace → the owner’s oldest membership (same fallback as the Next side)', async () => {
    state.devices[hashOf(DEVICE_A)].active_workspace_id = null
    expect(await resolveDeviceTokenSession(req('/session', DEVICE_A))).toEqual({ userId: 'user-1', workspaceId: 'ws-oldest' })
    // "Oldest" is the query's job, not the mock's: ORDER BY created_at ASC LIMIT 1.
    const member = state.queries.find((q) => q.table === 'member')!
    expect(member.eqs).toEqual([['user_id', 'user-1']])
    expect(member.order).toEqual(['created_at', { ascending: true }])
    expect(member.limit).toBe(1)
  })

  it('skips (null): no bearer, a Supabase JWT, an unknown token, an expired token', async () => {
    expect(await resolveDeviceTokenSession(req('/session'))).toBeNull()
    expect(await resolveDeviceTokenSession(req('/session', 'eyJhbGciOi.jwt.sig'))).toBeNull()
    expect(state.queries).toHaveLength(0) // a JWT never costs a device_token lookup
    expect(await resolveDeviceTokenSession(req('/session', 'd8d_unknown'))).toBeNull()
    state.devices[hashOf(DEVICE_A)].expires_at = '2020-01-01T00:00:00Z'
    expect(await resolveDeviceTokenSession(req('/session', DEVICE_A))).toBeNull()
  })
})

describe('deviceTokenAuthWithAcl — a device session is driven only by its owner', () => {
  const auth = deviceTokenAuthWithAcl()

  it('the create route (no session id) admits the device with its ask token and stamps the run token + ctx', async () => {
    const token = askToken()
    const principal = await auth(devReq('/session', DEVICE_A, token, { 'x-chat-run-ctx': 'Y3R4' }))
    expect(principal).toEqual({
      authenticator: 'device',
      principalId: 'user-1',
      principalType: 'user',
      attributes: { workspaceId: 'ws-1', chatRunToken: token, chatRunCtx: 'Y3R4' },
    })
  })

  it.each(['/session/wrun_DEV/stream', '/session/wrun_DEV/cancel', '/session/wrun_DEV'])(
    'the OWNER’s device may use %s with the token minted for that session’s row',
    async (path) => {
      expect(await auth(devReq(path, DEVICE_A))).toMatchObject({ principalId: 'user-1' })
    },
  )

  it.each(['/session/wrun_DEV/stream', '/session/wrun_DEV/cancel', '/session/wrun_DEV'])(
    'ANOTHER user’s device is refused (403) on %s — it cannot continue the device session',
    async (path) => {
      await expect(auth(devReq(path, DEVICE_B, askToken({ userId: 'user-2' })))).rejects.toBeInstanceOf(ForbiddenError)
    },
  )

  it('the same user, device pointed at ANOTHER workspace, is refused (403)', async () => {
    state.devices[hashOf(DEVICE_A)].active_workspace_id = 'ws-2'
    await expect(auth(devReq('/session/wrun_DEV/stream', DEVICE_A, askToken({ workspaceId: 'ws-2' })))).rejects.toBeInstanceOf(
      ForbiddenError,
    )
  })

  it('an UNREGISTERED id — e.g. after the ask ended and its row was deleted — is refused (fail closed)', async () => {
    state.sessions = {}
    await expect(auth(devReq('/session/wrun_DEV/stream', DEVICE_A))).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('an ownership lookup error is refused (fail closed)', async () => {
    state.sessionLookupError = true
    await expect(auth(devReq('/session/wrun_DEV/cancel', DEVICE_A))).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('a browser (Supabase) principal of another user is refused on the device session by the same ACL', async () => {
    expect(await isSessionOwnedByOther(req('/session/wrun_DEV/stream'), 'user-2', 'ws-1')).toBe(true)
    expect(await isSessionOwnedByOther(req('/session/wrun_DEV/stream'), 'user-1', 'ws-1')).toBe(false)
  })
})

describe('deviceTokenAuthWithAcl — a d8d_ token is bound to its own device ask', () => {
  const auth = deviceTokenAuthWithAcl()

  it('no run token: the device may NOT create a (token-less, ungated) session', async () => {
    await expect(auth(req('/session', DEVICE_A))).rejects.toThrow(/its own device ask/)
    await expect(auth(req('/session', DEVICE_A, { 'x-chat-run-token': '' }))).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('a forged / tampered / garbage run token is refused', async () => {
    const good = askToken()
    const tampered = `${good.slice(0, good.indexOf('.'))}.${'A'.repeat(good.length - good.indexOf('.') - 1)}`
    for (const token of ['tok.sig', tampered]) {
      await expect(auth(devReq('/session', DEVICE_A, token))).rejects.toThrow(/its own device ask/)
    }
  })

  it('a BROWSER chat token (no device surface) is refused, even for the same user + workspace', async () => {
    const browser = mintChatRunToken({ conversationId: 'conv-dev', userId: 'user-1', workspaceId: 'ws-1' })
    await expect(auth(devReq('/session', DEVICE_A, browser))).rejects.toThrow(/its own device ask/)
  })

  it('a token minted for another user or another workspace is refused', async () => {
    await expect(auth(devReq('/session', DEVICE_A, askToken({ userId: 'user-2' })))).rejects.toBeInstanceOf(ForbiddenError)
    await expect(auth(devReq('/session', DEVICE_A, askToken({ workspaceId: 'ws-9' })))).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('an expired ask token is refused', async () => {
    vi.useFakeTimers()
    try {
      const token = mintChatRunToken(
        { conversationId: 'conv-dev', userId: 'user-1', workspaceId: 'ws-1', surface: 'device_ask' },
        { ttlMs: 1_000 },
      )
      vi.setSystemTime(Date.now() + 2_000)
      await expect(auth(devReq('/session', DEVICE_A, token))).rejects.toThrow(/its own device ask/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('the device cannot reach the user’s OTHER sessions (their in-app chats) in the same workspace', async () => {
    // A browser chat session of the same user + workspace, on another row.
    state.sessions.wrun_BROWSER = { id: 'conv-browser', user_id: 'user-1', workspace_id: 'ws-1' }
    for (const path of ['/session/wrun_BROWSER/stream', '/session/wrun_BROWSER/cancel', '/session/wrun_BROWSER']) {
      await expect(auth(devReq(path, DEVICE_A))).rejects.toThrow(/another user or workspace/)
    }
    // Even with a (hypothetical) device token minted for that row, it is the row that decides.
    expect(await auth(devReq('/session/wrun_BROWSER/stream', DEVICE_A, askToken({ conversationId: 'conv-browser' })))).toMatchObject({
      principalId: 'user-1',
    })
  })

  it('no secret configured: nothing is admitted (fail closed)', async () => {
    const token = askToken()
    delete process.env.CHAT_INTERNAL_SECRET
    delete process.env.RUN_SKILL_INTERNAL_SECRET
    await expect(auth(devReq('/session', DEVICE_A, token))).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('verifyDeviceAskRunToken accepts exactly what the Next side mints for a device ask', () => {
    expect(verifyDeviceAskRunToken(askToken())).toMatchObject({
      conversationId: 'conv-dev',
      userId: 'user-1',
      workspaceId: 'ws-1',
      surface: 'device_ask',
    })
    expect(verifyDeviceAskRunToken(mintChatRunToken({ conversationId: 'c', userId: 'u', workspaceId: 'w' }))).toBeNull()
    expect(verifyDeviceAskRunToken('')).toBeNull()
  })

  it('secret resolution matches the Next side: RUN_SKILL_INTERNAL_SECRET is the fallback on both', () => {
    delete process.env.CHAT_INTERNAL_SECRET
    process.env.RUN_SKILL_INTERNAL_SECRET = 'run-skill-fallback-secret-0123'
    try {
      expect(verifyDeviceAskRunToken(askToken())).toMatchObject({ surface: 'device_ask' })
    } finally {
      delete process.env.RUN_SKILL_INTERNAL_SECRET
    }
  })
})

describe('a d8d_ bearer walks PAST the Supabase entry to the device entry', () => {
  it('resolveSupabaseSession skips (null) a device token: never forwarded as a JWT, never validated as one', async () => {
    const getUser = vi.fn(async (..._a: unknown[]) => ({ data: { user: null }, error: null }))
    vi.mocked(createServerClient).mockReturnValue({ auth: { getUser } } as never)
    expect(await resolveSupabaseSession(req('/session/wrun_DEV/stream', DEVICE_A))).toBeNull()
    // Not forwarded to PostgREST as an Authorization header (isJwtBearer)…
    const opts = vi.mocked(createServerClient).mock.calls[0][2] as { global?: unknown }
    expect(opts.global).toBeUndefined()
    // …and never handed to auth.getUser(token) (resolveUser's d8d_ skip).
    for (const call of getUser.mock.calls) expect(call).not.toContain(DEVICE_A)
  })

  it('so the channel’s Supabase entry yields nothing and the device entry resolves the device principal', async () => {
    const getUser = vi.fn(async (..._a: unknown[]) => ({ data: { user: null }, error: null }))
    vi.mocked(createServerClient).mockReturnValue({ auth: { getUser } } as never)
    const r = devReq('/session/wrun_DEV/stream', DEVICE_A)
    expect(await resolveSupabaseSession(r)).toBeNull()
    expect(await deviceTokenAuthWithAcl()(r)).toMatchObject({ authenticator: 'device', principalId: 'user-1' })
  })
})

describe('no internal-secret bypass', () => {
  it('the internal secret as a bearer is not a principal on this entry', async () => {
    expect(await deviceTokenAuthWithAcl()(req('/session/wrun_DEV/stream', SECRET))).toBeNull()
  })

  it('the channel’s walk is exactly the eval runner, server compaction, Supabase+ACL, device+ACL, localDev — no broad secret entry', () => {
    const src = readFileSync(join(__dirname, '../../channels/eve.ts'), 'utf8')
    expect(src).toContain('auth: [evalRunnerAuth(), serverCompactionAuth(), supabaseSessionWithAcl(), deviceTokenAuthWithAcl(), localDevOffVercel()]')
    expect(src).not.toMatch(/internalCallerAuth|sharedSecretAuth|vercelOidc/)
  })
})
