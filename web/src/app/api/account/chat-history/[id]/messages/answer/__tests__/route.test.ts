import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Locks the ask_user answer PATCH authz + part-scoping (plan WS-2b, red-team):
 *   - flips ONLY the targeted tool part (by toolCallId), leaving other parts
 *     untouched and never accepting a client ui_message blob;
 *   - a toolCallId not in this conversation/user's messages 404s;
 *   - the message-list query is scoped to the caller (user_id) + conversation.
 */

let messageRows: Array<{ id: string; ui_message: unknown }> = []
let updatePayload: Record<string, unknown> | null = null
// Rows affected by the UPDATE — the route treats 0 as a failure (a missing
// UPDATE RLS policy makes the write a silent 0-row no-op). Default 1 = success.
let updateCount = 1
const eqCalls: Array<[string, unknown]> = []

function chain(table: string) {
  const b: Record<string, unknown> = {}
  const proxy: Record<string, unknown> = new Proxy(b, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      const fn = (...args: unknown[]) => {
        if (prop === 'eq') eqCalls.push([String(args[0]), args[1]])
        if (prop === 'update') updatePayload = args[0] as Record<string, unknown>
        return proxy
      }
      target[prop] = fn
      return fn
    },
  }) as Record<string, unknown>
  // The SELECT of assistant messages resolves via `then`; the UPDATE (marked by
  // updatePayload being set) resolves with a count.
  b.then = (resolve?: (r: unknown) => unknown) => {
    if (table === 'chat_messages' && !updatePayload) {
      return Promise.resolve({ data: messageRows, error: null }).then(resolve)
    }
    if (table === 'chat_messages' && updatePayload) {
      return Promise.resolve({ data: null, error: null, count: updateCount }).then(resolve)
    }
    return Promise.resolve({ data: null, error: null }).then(resolve)
  }
  return proxy
}

const supabaseMock = {
  auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'owner-1' } } })) },
  from: vi.fn((t: string) => chain(t)),
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => supabaseMock }))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: vi.fn(async () => 'ws-1') }))

import { PATCH } from '../route'

function req(body: Record<string, unknown>, id = 'conv-1') {
  const r = new Request(`http://localhost/api/account/chat-history/${id}/messages/answer`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest
  return { r, params: Promise.resolve({ id }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  messageRows = []
  updatePayload = null
  updateCount = 1
  eqCalls.length = 0
})

describe('PATCH answer route', () => {
  it('flips ONLY the targeted tool part, leaving siblings untouched', async () => {
    messageRows = [
      {
        id: 'm1',
        ui_message: {
          id: 'm1',
          role: 'assistant',
          parts: [
            { type: 'text', text: 'before' },
            { type: 'tool-ask_user', toolCallId: 'tc-1', state: 'input-available' },
          ],
        },
      },
    ]
    const { r, params } = req({ tool_call_id: 'tc-1', output: { answers: { q: 'A' } } })
    const res = await PATCH(r, { params })
    expect(res.status).toBe(200)

    const parts = (updatePayload?.ui_message as { parts: Array<Record<string, unknown>> }).parts
    // Text part untouched.
    expect(parts[0]).toEqual({ type: 'text', text: 'before' })
    // Target part flipped.
    expect(parts[1]).toMatchObject({
      type: 'tool-ask_user',
      toolCallId: 'tc-1',
      state: 'output-available',
      output: { answers: { q: 'A' } },
    })
  })

  it('404s when the toolCallId is not in the caller’s conversation messages', async () => {
    messageRows = [] // no message carries tc-x
    const { r, params } = req({ tool_call_id: 'tc-x', output: {} })
    const res = await PATCH(r, { params })
    expect(res.status).toBe(404)
    expect(updatePayload).toBeNull()
  })

  it('scopes the message lookup to the caller (user_id) + conversation', async () => {
    messageRows = [
      {
        id: 'm1',
        ui_message: {
          parts: [{ type: 'tool-ask_user', toolCallId: 'tc-1', state: 'input-available' }],
        },
      },
    ]
    const { r, params } = req({ tool_call_id: 'tc-1', output: {} })
    await PATCH(r, { params })
    // The SELECT filtered on both the caller and the conversation id.
    expect(eqCalls).toContainEqual(['user_id', 'owner-1'])
    expect(eqCalls).toContainEqual(['conversation_id', 'conv-1'])
    expect(eqCalls).toContainEqual(['workspace_id', 'ws-1'])
  })

  it('400s without a tool_call_id', async () => {
    const { r, params } = req({ output: {} })
    const res = await PATCH(r, { params })
    expect(res.status).toBe(400)
  })

  it('500s when the UPDATE affects 0 rows (silent RLS no-op guard)', async () => {
    // Regression for the missing-UPDATE-policy class: the row is found (SELECT
    // works via the SELECT policy) but the UPDATE matches 0 rows and returns no
    // error. Treating that as success left the DB question input-available
    // forever, permanently tripping the one-pending-question guard.
    messageRows = [
      {
        id: 'm1',
        ui_message: {
          parts: [{ type: 'tool-ask_user', toolCallId: 'tc-1', state: 'input-available' }],
        },
      },
    ]
    updateCount = 0
    const { r, params } = req({ tool_call_id: 'tc-1', output: { answers: { q: 'A' } } })
    const res = await PATCH(r, { params })
    expect(res.status).toBe(500)
  })
})
