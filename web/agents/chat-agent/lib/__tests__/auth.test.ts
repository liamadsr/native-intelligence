import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Session-ownership ACL + chat-run header forwarding for the user-facing
 * `chat-agent` eve channel (Phase 4).
 *
 * The ACL half is a twin of agent/lib/__tests__/auth-acl.test.ts (same ownership
 * record: `chat_conversations.eve_session_id`, keyed on user_id + workspace_id).
 * This suite adds the chat-agent-specific `chatRunHeaders` — the transport's
 * token + per-turn ctx headers must be readable so the channel can stamp them
 * onto the principal for the dynamic resolvers.
 */

// Mock the service-role client so isSessionOwnedByOther's ownership lookup is
// controllable: createClient(...).from('chat_conversations').select(...).eq(...)
// .limit(...).maybeSingle() resolves to whatever we set on `convoLookup`.
let convoLookup: { data: unknown; error: unknown }
const maybeSingle = vi.fn(async () => convoLookup)
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

import {
  extractTargetedSessionId,
  isSessionOwnedByOther,
  chatRunHeaders,
  chatReplyIdHeader,
} from '../auth'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
  convoLookup = { data: null, error: null }
})

const req = (url: string, headers?: Record<string, string>) =>
  new Request(url, headers ? { headers } : undefined)

const MOUNT = 'https://app/eve/chat-agent/v1'

describe('extractTargetedSessionId (chat-agent mount)', () => {
  it('extracts the id from a continue route', () => {
    expect(extractTargetedSessionId(req(`${MOUNT}/session/wrun_ABC`))).toBe('wrun_ABC')
  })
  it('extracts the id from a stream route (with query)', () => {
    expect(
      extractTargetedSessionId(req(`${MOUNT}/session/wrun_ABC/stream?startIndex=4`)),
    ).toBe('wrun_ABC')
  })
  it('returns null for the create route (no id → creation never gated)', () => {
    expect(extractTargetedSessionId(req(`${MOUNT}/session`))).toBeNull()
  })
  it('returns null for the health route', () => {
    expect(extractTargetedSessionId(req(`${MOUNT}/health`))).toBeNull()
  })
})

describe('isSessionOwnedByOther — fail-closed ownership', () => {
  const streamUrl = `${MOUNT}/session/wrun_ABC/stream`

  it('ALLOWS (false) when registered to THIS user AND workspace', async () => {
    convoLookup = { data: { user_id: 'user-1', workspace_id: 'ws-1' }, error: null }
    expect(await isSessionOwnedByOther(req(streamUrl), 'user-1', 'ws-1')).toBe(false)
  })

  it('REJECTS (true) when registered to ANOTHER user', async () => {
    convoLookup = { data: { user_id: 'user-2', workspace_id: 'ws-1' }, error: null }
    expect(await isSessionOwnedByOther(req(streamUrl), 'user-1', 'ws-1')).toBe(true)
  })

  it('REJECTS (true) when registered under a DIFFERENT workspace', async () => {
    convoLookup = { data: { user_id: 'user-1', workspace_id: 'ws-1' }, error: null }
    expect(await isSessionOwnedByOther(req(streamUrl), 'user-1', 'ws-2')).toBe(true)
  })

  it('DENIES (true) when the session id is unregistered (fail-closed)', async () => {
    convoLookup = { data: null, error: null }
    expect(await isSessionOwnedByOther(req(streamUrl), 'user-1', 'ws-1')).toBe(true)
  })

  it('ALLOWS (false) with NO DB lookup when there is no targeted session', async () => {
    expect(await isSessionOwnedByOther(req(`${MOUNT}/session`), 'user-1', 'ws-1')).toBe(false)
    expect(from).not.toHaveBeenCalled()
  })

  it('FAILS CLOSED (true) on a query error while checking a registered id', async () => {
    convoLookup = { data: null, error: { message: 'db exploded' } }
    expect(await isSessionOwnedByOther(req(streamUrl), 'user-1', 'ws-1')).toBe(true)
  })
})

describe('chatRunHeaders — token + per-turn ctx forwarding', () => {
  it('reads both headers off the request', () => {
    const r = req(`${MOUNT}/session`, {
      'x-chat-run-token': 'tok.sig',
      'x-chat-run-ctx': 'YmFzZTY0dXJs',
    })
    expect(chatRunHeaders(r)).toEqual({ chatRunToken: 'tok.sig', chatRunCtx: 'YmFzZTY0dXJs' })
  })

  it('defaults each to empty string when absent (never a null attribute)', () => {
    expect(chatRunHeaders(req(`${MOUNT}/session`))).toEqual({
      chatRunToken: '',
      chatRunCtx: '',
    })
  })
})

describe('chatReplyIdHeader — the reply a send names (the reply backup writes under it)', () => {
  it('reads the transport-minted id', () => {
    const id = 'eve-msg-chat_1-1760893086000-k3x9qa'
    expect(chatReplyIdHeader(req(`${MOUNT}/session`, { 'x-chat-reply-id': id }))).toBe(id)
  })

  it("is '' when absent, empty, too long, or not visible ASCII (never a null attribute)", () => {
    expect(chatReplyIdHeader(req(`${MOUNT}/session`))).toBe('')
    expect(chatReplyIdHeader(req(`${MOUNT}/session`, { 'x-chat-reply-id': '' }))).toBe('')
    expect(chatReplyIdHeader(req(`${MOUNT}/session`, { 'x-chat-reply-id': 'a'.repeat(201) }))).toBe('')
    expect(chatReplyIdHeader(req(`${MOUNT}/session`, { 'x-chat-reply-id': 'has space' }))).toBe('')
  })
})

// eve 0.66.3 declares these routes under a session id (dist/src/protocol/
// routes.d.ts) and its handlers call only route auth — never an owner check.
// The matcher must gate EVERY one of them on the (parent) session's owner.
describe('session-scoped control + subagent-stream routes — fail closed on any path under a session id', () => {
  const BASE = 'https://app/eve/chat-agent/v1'
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
    convoLookup = { data: { user_id: 'user-2', workspace_id: 'ws-1' }, error: null }
    expect(await isSessionOwnedByOther(req(url), 'user-1', 'ws-1')).toBe(true)
    // The ownership lookup keyed on the parent id, never the child's.
    expect((eq.mock.calls.at(-1) as unknown[] | undefined)?.[1]).toBe('wrun_ABC')
  })

  it.each(scoped)('%s: an UNREGISTERED id is rejected (403)', async (_label, url) => {
    convoLookup = { data: null, error: null }
    expect(await isSessionOwnedByOther(req(url), 'user-1', 'ws-1')).toBe(true)
  })

  it.each(scoped)('%s: the owner is allowed', async (_label, url) => {
    convoLookup = { data: { user_id: 'user-1', workspace_id: 'ws-1' }, error: null }
    expect(await isSessionOwnedByOther(req(url), 'user-1', 'ws-1')).toBe(false)
  })

  it('a malformed escape in the id fails closed (rejected, never treated as no session)', async () => {
    convoLookup = { data: null, error: null }
    expect(extractTargetedSessionId(req(`${BASE}/session/%E0%A4%A/cancel`))).toBe('%E0%A4%A')
    expect(await isSessionOwnedByOther(req(`${BASE}/session/%E0%A4%A/cancel`), 'user-1', 'ws-1')).toBe(true)
  })

  it('the bare create route (with or without a trailing slash) is still not gated', () => {
    expect(extractTargetedSessionId(req(`${BASE}/session`))).toBeNull()
    expect(extractTargetedSessionId(req(`${BASE}/session/`))).toBeNull()
  })
})
