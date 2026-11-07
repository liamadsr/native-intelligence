import { describe, it, expect, vi, beforeEach } from 'vitest'

// The idle-compaction signal is covered in route.idle-compaction.test.ts: no Inngest here.
vi.mock('@/lib/chat/idle-compaction-signal', () => ({ signalChatSessionActivity: vi.fn() }))

/**
 * POST /api/account/chat/eve-session — the browser-facing mint + register
 * companion the EveChatTransport calls. Locks:
 *   - mint refuses 503 CHAT_RUNTIME_UNCONFIGURED when the internal secret is
 *     unset (there is no runtime flag — eve is the only chat runtime);
 *   - tenancy comes from the VERIFIED session, never the body (the token is
 *     minted from requireWorkspace's user/workspace);
 *   - a client-supplied conversationId is trusted only after it resolves to the
 *     caller's OWN row; a foreign/unknown id → a fresh conversation is created;
 *   - register writes eve_session_id owner-scoped and 404s a 0-row update.
 */

// ── Supabase chain mock (from().select/insert/update().eq()...maybeSingle/count) ─
let ownedRow: { id: string; eve_session_id?: string | null; capture_id?: string | null; is_home?: boolean } | null = null // resolveOwnedConversation result
/** The captures read (ownsCapture): the caller's own capture, or null. */
let captureRow: { id: string } | null = { id: 'cap-1' }
let insertedId: string | null = 'conv-created'
let updateCount = 1
const eqCalls: Array<[string, unknown]> = []
let lastTable = ''
let lastOp: 'select' | 'insert' | 'update' | null = null
let lastInsert: Record<string, unknown> | null = null

function chain(table: string) {
  lastTable = table
  const b: Record<string, unknown> = {}
  const proxy = new Proxy(b, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      const fn = (...args: unknown[]) => {
        if (prop === 'eq') eqCalls.push([String(args[0]), args[1]])
        if (prop === 'insert') {
          lastOp = 'insert'
          lastInsert = args[0] as Record<string, unknown>
        }
        if (prop === 'update') lastOp = 'update'
        if (prop === 'select' && lastOp === null) lastOp = 'select'
        if (prop === 'maybeSingle') {
          return Promise.resolve({ data: table === 'captures' ? captureRow : ownedRow, error: null })
        }
        if (prop === 'single') {
          return Promise.resolve({ data: insertedId ? { id: insertedId } : null, error: null })
        }
        return proxy
      }
      target[prop] = fn
      return fn
    },
  }) as Record<string, unknown>
  // UPDATE resolves with a count via then().
  b.then = (resolve?: (r: unknown) => unknown) =>
    Promise.resolve({ data: null, error: null, count: updateCount }).then(resolve)
  return proxy
}

const supabaseMock = { from: vi.fn((t: string) => chain(t)) }
const user = { id: 'user-1' }

const requireWorkspace = vi.fn(async () => ({
  supabase: supabaseMock,
  user,
  workspaceId: 'ws-1',
}))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: () => requireWorkspace() }))

const mintChatRunToken = vi.fn((_c: unknown) => 'signed.token')
let secretConfigured = true
vi.mock('@/lib/chat/chat-run-token', () => ({
  mintChatRunToken: (c: unknown) => mintChatRunToken(c),
  internalSecret: () => (secretConfigured ? 'test-secret' : null),
}))

// ── Usage gate (the PRIMARY billing block for the eve path) ──────────────────
// checkUsageLimits THROWS a Response on 429/503; set usageLimitThrow to
// simulate a blocked user. Default (null) = allowed, mint proceeds.
let usageLimitThrow: Response | null = null
// The usage row the check answers with (undefined: allowed, no row).
let usageRow: { allowed: boolean; reason?: string } | undefined
const checkUsageLimits = vi.fn(async (_userId: string, _signal?: AbortSignal, _opts?: { chatgptPlan?: boolean }) => {
  if (usageLimitThrow) throw usageLimitThrow
  return usageRow
})
vi.mock('@/lib/ai/auth', () => ({
  checkUsageLimits: (userId: string, signal?: AbortSignal, opts?: { chatgptPlan?: boolean }) => checkUsageLimits(userId, signal, opts),
}))
/** The mint's usage check: it opts in to the ChatGPT free tier. */
const MINT_USAGE_CHECK = ['user-1', undefined, { chatgptPlan: true }] as const

const sealRunCredential = vi.fn((jwt: string, bind: unknown) => `sealed(${jwt})@${JSON.stringify(bind)}`)
vi.mock('@/lib/chat/chat-run-credential', () => ({
  sealRunCredential: (jwt: string, bind: unknown) => sealRunCredential(jwt, bind),
}))

const renderConversationPrimer = vi.fn(async (..._a: unknown[]): Promise<string | null> => '<conversation-so-far>…</conversation-so-far>')
vi.mock('@/lib/chat/conversation-history', () => ({
  renderConversationPrimer: (...a: unknown[]) => renderConversationPrimer(...a),
}))

import { POST } from '../route'
import { DEFAULT_CONVERSATION_TITLE } from '@/lib/chat/chat-title'
import type { NextRequest } from 'next/server'

function req(body: Record<string, unknown>, headers: Record<string, string> = {}): NextRequest {
  return new Request('http://localhost/api/account/chat/eve-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }) as unknown as NextRequest
}

const jwtFor = (sub: string) =>
  `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.sig`

beforeEach(() => {
  vi.clearAllMocks()
  ownedRow = null
  captureRow = { id: 'cap-1' }
  lastInsert = null
  insertedId = 'conv-created'
  updateCount = 1
  eqCalls.length = 0
  lastOp = null
  lastInsert = null
  secretConfigured = true
  usageLimitThrow = null
  usageRow = undefined
})

describe("mint — the caller's JWT rides the token sealed (email-draft tools)", () => {
  it("seals the Bearer JWT of THIS user, bound to the token's conversation + tenancy", async () => {
    ownedRow = { id: 'conv-1' }
    const jwt = jwtFor('user-1')
    await POST(req({ action: 'mint', conversationId: 'conv-1' }, { Authorization: `Bearer ${jwt}` }))
    expect(sealRunCredential).toHaveBeenCalledWith(jwt, { conversationId: 'conv-1', workspaceId: 'ws-1', userId: 'user-1' })
    expect(mintChatRunToken).toHaveBeenCalledWith(expect.objectContaining({ cred: expect.stringContaining('sealed(') }))
  })

  it("never seals a device token, another user's JWT, or nothing (cookie caller)", async () => {
    ownedRow = { id: 'conv-1' }
    await POST(req({ action: 'mint', conversationId: 'conv-1' }, { Authorization: 'Bearer d8d_abcdef' }))
    await POST(req({ action: 'mint', conversationId: 'conv-1' }, { Authorization: `Bearer ${jwtFor('user-2')}` }))
    await POST(req({ action: 'mint', conversationId: 'conv-1' }))
    expect(sealRunCredential).not.toHaveBeenCalled()
    for (const call of mintChatRunToken.mock.calls) expect(call[0]).not.toHaveProperty('cred')
  })
})

describe('mint — re-attach + history (a send with no live session handle)', () => {
  it("returns the conversation's registered eve session so the chat re-attaches to it", async () => {
    ownedRow = { id: 'conv-1', eve_session_id: 'wrun_prior' }
    const json = await (await POST(req({ action: 'mint', conversationId: 'conv-1' }))).json()
    expect(json).toMatchObject({ conversationId: 'conv-1', eveSessionId: 'wrun_prior' })
    expect(json).not.toHaveProperty('historyPrimer')
    expect(renderConversationPrimer).not.toHaveBeenCalled()
  })

  it('with wantHistory returns the owner-scoped primer for an existing conversation', async () => {
    ownedRow = { id: 'conv-1', eve_session_id: null }
    const json = await (await POST(req({ action: 'mint', conversationId: 'conv-1', wantHistory: true }))).json()
    expect(json.historyPrimer).toContain('<conversation-so-far>')
    expect(renderConversationPrimer).toHaveBeenCalledWith(supabaseMock, {
      conversationId: 'conv-1',
      userId: 'user-1',
      workspaceId: 'ws-1',
    })
  })

  it('never builds a primer for a freshly created (or foreign) conversation', async () => {
    ownedRow = null
    const json = await (await POST(req({ action: 'mint', conversationId: 'someone-elses', wantHistory: true }))).json()
    expect(json).toMatchObject({ conversationId: 'conv-created', eveSessionId: null, historyPrimer: null })
    expect(renderConversationPrimer).not.toHaveBeenCalled()
  })

  it('a failed history read degrades to no primer, never a failed mint', async () => {
    ownedRow = { id: 'conv-1' }
    renderConversationPrimer.mockRejectedValueOnce(new Error('db down'))
    const res = await POST(req({ action: 'mint', conversationId: 'conv-1', wantHistory: true }))
    expect(res.status).toBe(200)
    expect((await res.json()).historyPrimer).toBeNull()
  })
})

describe('mint', () => {
  it('mints a token from the VERIFIED tenancy for the caller-owned conversation', async () => {
    // The named id resolves to the caller's own row: a live call's (a capture
    // link), the one place a persona may drive the chat (one-chat Slice 2).
    ownedRow = { id: 'conv-1', capture_id: 'cap-1' }
    const res = await POST(req({ action: 'mint', conversationId: 'conv-1', agentId: 'ag-1' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ token: 'signed.token', conversationId: 'conv-1', eveSessionId: null })
    // The token is minted from the session's user/workspace, NOT the body.
    expect(mintChatRunToken).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      agentId: 'ag-1',
    })
  })

  it('refuses a persona outside a live call: the main chat is always the main agent (one-chat Slice 2)', async () => {
    ownedRow = { id: 'conv-1' } // the home thread or any other: no capture link
    const res = await POST(req({ action: 'mint', conversationId: 'conv-1', agentId: 'ag-1' }))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('AGENT_NOT_ALLOWED')
    expect(mintChatRunToken).not.toHaveBeenCalled()
    // Nor on a conversation this call would create, and the refusal makes
    // no conversation at all.
    ownedRow = null
    const fresh = await POST(req({ action: 'mint', agentId: 'ag-1' }))
    expect(fresh.status).toBe(400)
    expect(mintChatRunToken).not.toHaveBeenCalled()
    expect(lastInsert).toBeNull()
  })

  it('a capture conversation unlocks a persona only for the caller’s own capture here', async () => {
    ownedRow = { id: 'conv-1', capture_id: 'cap-1' }
    captureRow = null // not the caller's capture (or not in this workspace)
    const res = await POST(req({ action: 'mint', conversationId: 'conv-1', agentId: 'ag-1' }))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('AGENT_NOT_ALLOWED')
    expect(eqCalls).toEqual(expect.arrayContaining([['id', 'cap-1'], ['user_id', 'user-1'], ['workspace_id', 'ws-1']]))
    expect(mintChatRunToken).not.toHaveBeenCalled()
  })

  it('no persona on the home thread either: onboarding is the main agent (getting started)', async () => {
    ownedRow = { id: 'conv-1', is_home: true }
    const res = await POST(req({ action: 'mint', conversationId: 'conv-1', agentId: '0e5b1c9a-6d2f-4a7b-9c31-8f0a2b4c6d7e' }))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('AGENT_NOT_ALLOWED')
    expect(mintChatRunToken).not.toHaveBeenCalled()
  })

  it('creates a FRESH conversation when the named id is foreign/unknown', async () => {
    ownedRow = null // the named id does NOT resolve to the caller's row
    insertedId = 'conv-fresh'
    const res = await POST(req({ action: 'mint', conversationId: 'someone-elses' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.conversationId).toBe('conv-fresh')
    // Token bound to the freshly-created (caller-owned) conversation, not the foreign id.
    expect(mintChatRunToken).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-fresh', userId: 'user-1', workspaceId: 'ws-1' }),
    )
    // The fresh row carries EXACTLY the title the first-turn backfill
    // (persist-eve-turn.ts) matches on; any other string leaves the chat untitled.
    expect(lastInsert).toEqual({
      user_id: 'user-1',
      workspace_id: 'ws-1',
      title: DEFAULT_CONVERSATION_TITLE,
    })
  })

  it('503s when the internal secret is unset (never mints)', async () => {
    secretConfigured = false
    const res = await POST(req({ action: 'mint', conversationId: 'conv-1' }))
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('CHAT_RUNTIME_UNCONFIGURED')
    expect(mintChatRunToken).not.toHaveBeenCalled()
  })

  // ── The PRIMARY usage-limit gate (blocked users never get a run token) ────
  it('returns the 429 Response body-INTACT when checkUsageLimits throws it (never mints)', async () => {
    const body429 = {
      error: 'Usage limit exceeded',
      reason: 'trial_expired',
      plan: 'free',
      isPaidPlan: false,
      usageResetDate: '2026-08-01T00:00:00+00:00',
      creditBalanceUsd: 0,
    }
    usageLimitThrow = new Response(JSON.stringify(body429), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    })
    ownedRow = { id: 'conv-1' }
    const res = await POST(req({ action: 'mint', conversationId: 'conv-1' }))
    expect(res.status).toBe(429)
    // The thrown Response passes through AS-IS — the transport composes its
    // toast copy from these exact structured fields.
    expect(await res.json()).toEqual(body429)
    expect(checkUsageLimits).toHaveBeenCalledWith(...MINT_USAGE_CHECK)
    expect(mintChatRunToken).not.toHaveBeenCalled()
  })

  it('returns the 503 BILLING_UNAVAILABLE Response likewise (fail-closed, never mints)', async () => {
    usageLimitThrow = new Response(
      JSON.stringify({ error: 'Usage check unavailable', code: 'BILLING_UNAVAILABLE' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    )
    const res = await POST(req({ action: 'mint', conversationId: 'conv-1' }))
    expect(res.status).toBe(503)
    // Distinguishable from the runtime-off 503 by body.code.
    expect((await res.json()).code).toBe('BILLING_UNAVAILABLE')
    expect(mintChatRunToken).not.toHaveBeenCalled()
  })

  it('a normal mint is unaffected: usage check passes and the token mints', async () => {
    ownedRow = { id: 'conv-1' }
    const res = await POST(req({ action: 'mint', conversationId: 'conv-1' }))
    expect(res.status).toBe(200)
    expect((await res.json()).token).toBe('signed.token')
    expect(checkUsageLimits).toHaveBeenCalledWith(...MINT_USAGE_CHECK)
    expect(mintChatRunToken.mock.calls[0][0]).not.toHaveProperty('chatgptPlan')
  })

  it("signs the ChatGPT plan claim for a person the check put on their plan (active or out of credits), and no one else", async () => {
    ownedRow = { id: 'conv-1' }
    for (const reason of ['chatgpt_plan', 'chatgpt_plan_exhausted']) {
      mintChatRunToken.mockClear()
      usageRow = { allowed: true, reason }
      expect((await POST(req({ action: 'mint', conversationId: 'conv-1' }))).status).toBe(200)
      expect(mintChatRunToken.mock.calls[0][0]).toMatchObject({ chatgptPlan: true })
    }
    mintChatRunToken.mockClear()
    usageRow = { allowed: true, reason: 'within_limits' }
    await POST(req({ action: 'mint', conversationId: 'conv-1' }))
    expect(mintChatRunToken.mock.calls[0][0]).not.toHaveProperty('chatgptPlan')
  })

  it('the unconfigured 503 wins over the usage gate (CHAT_RUNTIME_UNCONFIGURED, no usage check)', async () => {
    secretConfigured = false
    usageLimitThrow = new Response(JSON.stringify({ error: 'Usage limit exceeded' }), {
      status: 429,
    })
    const res = await POST(req({ action: 'mint', conversationId: 'conv-1' }))
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('CHAT_RUNTIME_UNCONFIGURED')
    expect(checkUsageLimits).not.toHaveBeenCalled()
  })

  it('register is NOT usage-gated (bookkeeping must still work for a limited user)', async () => {
    usageLimitThrow = new Response(JSON.stringify({ error: 'Usage limit exceeded' }), {
      status: 429,
    })
    const res = await POST(
      req({ action: 'register', conversationId: 'conv-1', sessionId: 'wrun_ABC' }),
    )
    expect(res.status).toBe(200)
    expect(checkUsageLimits).not.toHaveBeenCalled()
  })
})

describe('register', () => {
  it('writes eve_session_id owner-scoped (user_id + workspace_id in the WHERE)', async () => {
    updateCount = 1
    const res = await POST(
      req({ action: 'register', conversationId: 'conv-1', sessionId: 'wrun_ABC' }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    // The UPDATE is scoped to the caller — a cross-user claim is impossible.
    expect(eqCalls).toEqual(
      expect.arrayContaining([
        ['id', 'conv-1'],
        ['user_id', 'user-1'],
        ['workspace_id', 'ws-1'],
      ]),
    )
  })

  it('404s when the update affected 0 rows (not the caller’s conversation)', async () => {
    updateCount = 0
    const res = await POST(
      req({ action: 'register', conversationId: 'not-mine', sessionId: 'wrun_ABC' }),
    )
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('CONVERSATION_NOT_FOUND')
  })

  it('400s when sessionId is missing', async () => {
    const res = await POST(req({ action: 'register', conversationId: 'conv-1' }))
    expect(res.status).toBe(400)
  })
})

describe('validation', () => {
  it('400s on an unknown action', async () => {
    const res = await POST(req({ action: 'frobnicate' as unknown as 'mint' }))
    expect(res.status).toBe(400)
  })
})
