/**
 * POST /api/account/chat/eve-session — the A3 review fixes. Pins:
 *   - register with `previousSessionId` writes only while the row holds that
 *     session, none, or this one; another window's session wins, and the loser
 *     gets a 409 SESSION_CONFLICT naming the current session; without the
 *     field (an older client) the write is unconditional, as before;
 *   - a database without migration 330 (is_home missing: PostgREST 42703)
 *     reads as "not home": the ordinary mint still answers, never a 500.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/chat/idle-compaction-signal', () => ({ signalChatSessionActivity: vi.fn() }))

type Row = { id: string; user_id: string; workspace_id: string; eve_session_id: string | null; agent_teammate_id: null; focus_area: null }
const db = vi.hoisted(() => ({ row: null as Row | null, noHomeColumn: false, updates: [] as Array<{ patch: unknown; or: string | null }> }))

/** `eve_session_id.is.null,eve_session_id.eq."x",…`, the only or-filter register writes. */
function orAllows(filter: string, value: string | null): boolean {
  return filter.split(',').some((part) => {
    if (part === 'eve_session_id.is.null') return value === null
    const m = /^eve_session_id\.eq\."?([^"]*)"?$/.exec(part)
    if (!m) throw new Error(`unexpected or filter: ${part}`)
    return value === m[1]
  })
}

function chain() {
  const eqs: Array<[string, unknown]> = []
  let op: 'select' | 'update' = 'select'
  let patch: Record<string, unknown> | null = null
  let or: string | null = null
  let cols = ''
  const matches = () => !!db.row && eqs.every(([k, v]) => (db.row as unknown as Record<string, unknown>)[k] === v)
  const c: Record<string, unknown> = {}
  c.select = (s: string) => ((cols = s), c)
  c.eq = (k: string, v: unknown) => (eqs.push([k, v]), c)
  c.or = (f: string) => ((or = f), c)
  c.update = (p: Record<string, unknown>) => ((op = 'update'), (patch = p), c)
  c.maybeSingle = async () => {
    if (db.noHomeColumn && cols.includes('is_home')) return { data: null, error: { code: '42703', message: 'column chat_conversations.is_home does not exist' } }
    return { data: matches() ? { ...db.row } : null, error: null }
  }
  c.then = (resolve: (v: unknown) => unknown) => {
    let count = 0
    if (op === 'update' && matches() && (or === null || orAllows(or, db.row!.eve_session_id))) {
      Object.assign(db.row!, patch)
      count = 1
    }
    db.updates.push({ patch, or })
    return Promise.resolve({ data: null, error: null, count }).then(resolve)
  }
  return c
}

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: async () => ({ supabase: { from: () => chain() }, user: { id: 'user-1' }, workspaceId: 'ws-1' }),
}))
vi.mock('@/lib/chat/chat-run-token', () => ({ mintChatRunToken: () => 'signed.token', internalSecret: () => 'test-secret' }))
vi.mock('@/lib/ai/auth', () => ({ checkUsageLimits: async () => undefined }))
vi.mock('@/lib/chat/chat-run-credential', () => ({ sealRunCredential: () => 'sealed' }))
vi.mock('@/lib/chat/conversation-history', () => ({ renderConversationPrimer: async () => 'PRIMER', renderHomePrimer: async () => 'HOME' }))

import { POST } from '../route'
import type { NextRequest } from 'next/server'

const req = (body: Record<string, unknown>) =>
  new Request('http://localhost/api/account/chat/eve-session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest

beforeEach(() => {
  db.row = { id: 'home-1', user_id: 'user-1', workspace_id: 'ws-1', eve_session_id: 'wrun_A', agent_teammate_id: null, focus_area: null }
  db.noHomeColumn = false
  db.updates.length = 0
})

describe('register — two windows on one conversation (A3)', () => {
  it('writes over the session the transport knew', async () => {
    const res = await POST(req({ action: 'register', conversationId: 'home-1', sessionId: 'wrun_B', previousSessionId: 'wrun_A' }))
    expect(res.status).toBe(200)
    expect(db.row!.eve_session_id).toBe('wrun_B')
  })

  it('a second window that forked from the same session loses: 409 SESSION_CONFLICT naming the current one, nothing overwritten', async () => {
    await POST(req({ action: 'register', conversationId: 'home-1', sessionId: 'wrun_B', previousSessionId: 'wrun_A' }))
    const res = await POST(req({ action: 'register', conversationId: 'home-1', sessionId: 'wrun_C', previousSessionId: 'wrun_A' }))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body).toMatchObject({ code: 'SESSION_CONFLICT', details: { eveSessionId: 'wrun_B' } })
    expect(db.row!.eve_session_id).toBe('wrun_B')
  })

  it('a fresh session (previous none) registers only on an empty row; re-registering the same session is fine', async () => {
    db.row!.eve_session_id = null
    expect((await POST(req({ action: 'register', conversationId: 'home-1', sessionId: 'wrun_B', previousSessionId: null }))).status).toBe(200)
    expect((await POST(req({ action: 'register', conversationId: 'home-1', sessionId: 'wrun_B', previousSessionId: null }))).status).toBe(200)
    expect((await POST(req({ action: 'register', conversationId: 'home-1', sessionId: 'wrun_C', previousSessionId: null }))).status).toBe(409)
  })

  it('without previousSessionId (an older client) the write is unconditional, as before', async () => {
    expect((await POST(req({ action: 'register', conversationId: 'home-1', sessionId: 'wrun_Z' }))).status).toBe(200)
    expect(db.row!.eve_session_id).toBe('wrun_Z')
    expect(db.updates[0].or).toBeNull()
  })

  it('a conversation not the caller’s is still a 404', async () => {
    const res = await POST(req({ action: 'register', conversationId: 'nope', sessionId: 'wrun_B', previousSessionId: 'wrun_A' }))
    expect(res.status).toBe(404)
  })
})

describe('the mint without migration 330', () => {
  it('reads a missing is_home column as not home and mints as before', async () => {
    db.noHomeColumn = true
    const res = await POST(req({ action: 'mint', conversationId: 'home-1', wantHistory: true }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ conversationId: 'home-1', eveSessionId: 'wrun_A', historyPrimer: 'PRIMER' })
    expect(body).not.toHaveProperty('home')
  })
})
