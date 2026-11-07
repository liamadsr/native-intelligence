import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Locks the get-or-create + greeting contract for the live capture conversation
 * (plan WS-1b): owner-only, idempotent (concurrent creates → one conversation,
 * one greeting), greeting only on the row that actually got created — and the
 * agent the conversation is pinned to (plan D2): the one actually listening in
 * on the call, which the chat tab then talks as.
 */

const appendAgentMessage = vi.fn(async () => ({ written: true }))
const resolveDefaultRecipeForCapture = vi.fn(async () => null as { id: string } | null)

// Scriptable per test.
let captureRow: Record<string, unknown> | null = null
let upsertReturnsRow: { id: string } | null = null // non-null = this call created the row
let existingConversation: { id: string; recipe_id: string | null } | null = null
/** Recipes the caller can see under RLS, by id. */
let recipes: Record<string, { id: string; name: string }> = {}
let upserts: Array<Record<string, unknown>> = []
let updates: Array<Record<string, unknown>> = []

function chain(table: string) {
  const b: Record<string, unknown> = {}
  const eqs: Record<string, unknown> = {}
  const proxy: Record<string, unknown> = new Proxy(b, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      const fn = () => proxy
      target[prop] = fn
      return fn
    },
  }) as Record<string, unknown>
  b.eq = (col: string, val: unknown) => {
    eqs[col] = val
    return proxy
  }
  b.maybeSingle = () => {
    if (table === 'captures') return Promise.resolve({ data: captureRow, error: null })
    if (table === 'recipe') {
      return Promise.resolve({ data: recipes[eqs.id as string] ?? null, error: null })
    }
    if (table === 'chat_conversations') {
      // The .upsert(...).select().maybeSingle() path returns the created row (or
      // null for the ignored-duplicate loser); the later plain SELECT returns the
      // existing conversation.
      return Promise.resolve({
        data: upsertConsumed ? existingConversation : upsertReturnsRow,
        error: null,
      })
    }
    return Promise.resolve({ data: null, error: null })
  }
  b.upsert = (row: Record<string, unknown>) => {
    upserts.push(row)
    upsertConsumed = false // next maybeSingle is the upsert result
    return proxy
  }
  b.update = (row: Record<string, unknown>) => {
    updates.push(row)
    return proxy
  }
  b.then = (resolve?: (r: unknown) => unknown) =>
    Promise.resolve({ data: null, error: null }).then(resolve)
  return proxy
}
let upsertConsumed = true

const supabaseMock = {
  auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'owner-1' } } })) },
  from: vi.fn((t: string) => {
    const p = chain(t) as Record<string, unknown>
    // After the upsert path's maybeSingle resolves once, subsequent SELECTs on
    // chat_conversations should return the existing row.
    const origMaybe = p.maybeSingle as () => Promise<unknown>
    p.maybeSingle = () => origMaybe().then((r) => { upsertConsumed = true; return r })
    return p
  }),
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => supabaseMock }))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: vi.fn(async () => 'ws-1') }))
vi.mock('@/lib/live-agent/conversation-writer', () => ({
  appendAgentMessage: (...a: unknown[]) => appendAgentMessage(...(a as [])),
}))
vi.mock('@/lib/live-agent/default-agent', () => ({
  resolveDefaultRecipeForCapture: (...a: unknown[]) => resolveDefaultRecipeForCapture(...(a as [])),
}))

import { POST } from '../route'

function req(body: Record<string, unknown>) {
  return new Request('http://localhost/api/account/chat-history/live', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest
}

/** The greeting text the last created conversation got. */
function greetingText(): string {
  const [, message] = appendAgentMessage.mock.calls.at(-1) as unknown as [
    unknown,
    { parts: Array<{ text: string }> },
  ]
  return message.parts[0].text
}

beforeEach(() => {
  vi.clearAllMocks()
  captureRow = { id: 'c1', user_id: 'owner-1', title: 'Sync', created_at: '2026-07-08T00:00:00Z' }
  upsertReturnsRow = { id: 'conv-1' }
  existingConversation = { id: 'conv-1', recipe_id: null }
  recipes = {}
  upserts = []
  updates = []
  upsertConsumed = true
})

describe('POST /api/account/chat-history/live', () => {
  it('creates the conversation and writes the greeting on first call', async () => {
    const res = await POST(req({ capture_id: 'c1' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.conversationId).toBe('conv-1')
    expect(json.created).toBe(true)
    expect(appendAgentMessage).toHaveBeenCalledTimes(1)
    expect(appendAgentMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ messageId: 'greeting-c1' }),
    )
  })

  it('does NOT write a second greeting when the row already existed (race loser)', async () => {
    upsertReturnsRow = null // ignoreDuplicates → no row returned to this caller
    const res = await POST(req({ capture_id: 'c1' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.conversationId).toBe('conv-1')
    expect(json.created).toBe(false)
    expect(appendAgentMessage).not.toHaveBeenCalled()
  })

  it('403s a non-owner (v1 audience is the recorder only)', async () => {
    captureRow = { id: 'c1', user_id: 'someone-else', title: 'Sync', created_at: '2026-07-08T00:00:00Z' }
    const res = await POST(req({ capture_id: 'c1' }))
    expect(res.status).toBe(403)
    expect(appendAgentMessage).not.toHaveBeenCalled()
  })

  it('404s an unknown / cross-workspace capture', async () => {
    captureRow = null
    const res = await POST(req({ capture_id: 'nope' }))
    expect(res.status).toBe(404)
  })

  it('400s without a capture_id', async () => {
    const res = await POST(req({}))
    expect(res.status).toBe(400)
  })
})

describe('the agent the live conversation is pinned to', () => {
  it("pins and names the workspace's default live agent when the open names none", async () => {
    resolveDefaultRecipeForCapture.mockResolvedValueOnce({ id: 'rec-live' })
    recipes = { 'rec-live': { id: 'rec-live', name: 'Live Sales Copilot' } }

    const json = await (await POST(req({ capture_id: 'c1' }))).json()

    expect(resolveDefaultRecipeForCapture).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1', mode: 'live' }),
    )
    expect(upserts[0]).toEqual(expect.objectContaining({ recipe_id: 'rec-live' }))
    expect(json.recipeId).toBe('rec-live')
    expect(greetingText()).toMatch(/^\*\*Live Sales Copilot\*\* here/)
  })

  it('an explicit agent wins — the default is never consulted', async () => {
    recipes = { 'rec-x': { id: 'rec-x', name: 'Interactive Assistant' } }

    const json = await (await POST(req({ capture_id: 'c1', recipe_id: 'rec-x' }))).json()

    expect(resolveDefaultRecipeForCapture).not.toHaveBeenCalled()
    expect(upserts[0]).toEqual(expect.objectContaining({ recipe_id: 'rec-x' }))
    expect(json.recipeId).toBe('rec-x')
    expect(greetingText()).toMatch(/^\*\*Interactive Assistant\*\* here/)
  })

  it('a bogus or foreign id degrades to the built-in Assistant, not the default', async () => {
    // Mirrors the live-agent route: an id that resolves to nothing runs the
    // built-in Assistant — the edition default only fills in a MISSING id.
    const json = await (await POST(req({ capture_id: 'c1', recipe_id: 'not-visible' }))).json()

    expect(resolveDefaultRecipeForCapture).not.toHaveBeenCalled()
    expect(upserts[0]).toEqual(expect.objectContaining({ recipe_id: null }))
    expect(json.recipeId).toBeNull()
    expect(greetingText()).toMatch(/^I'm listening in on this call\./)
  })

  it('re-points an existing conversation when a different agent arrives mid-call', async () => {
    upsertReturnsRow = null
    existingConversation = { id: 'conv-1', recipe_id: 'rec-old' }
    recipes = { 'rec-new': { id: 'rec-new', name: 'Live Sales Copilot' } }

    const json = await (await POST(req({ capture_id: 'c1', recipe_id: 'rec-new' }))).json()

    expect(updates).toEqual([{ recipe_id: 'rec-new' }])
    expect(json).toEqual({ conversationId: 'conv-1', recipeId: 'rec-new', created: false })
    expect(appendAgentMessage).not.toHaveBeenCalled()
  })

  it('a re-open without an agent never resets the one already pinned', async () => {
    upsertReturnsRow = null
    existingConversation = { id: 'conv-1', recipe_id: 'rec-old' }

    const json = await (await POST(req({ capture_id: 'c1' }))).json()

    expect(updates).toEqual([])
    expect(json.recipeId).toBe('rec-old')
  })

  it('leaves the row alone when the same agent re-opens it', async () => {
    upsertReturnsRow = null
    existingConversation = { id: 'conv-1', recipe_id: 'rec-live' }
    recipes = { 'rec-live': { id: 'rec-live', name: 'Live Sales Copilot' } }

    const json = await (await POST(req({ capture_id: 'c1', recipe_id: 'rec-live' }))).json()

    expect(updates).toEqual([])
    expect(json.recipeId).toBe('rec-live')
  })
})
