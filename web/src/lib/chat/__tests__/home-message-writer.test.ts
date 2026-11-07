import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Locks the home-message-writer contract (conversational onboarding, F1/P1):
 *   - the home conversation is resolved via the DDL-free pointer resolver
 *     (home-conversation-pointer.ts), re-exported from this module — mocked here
 *     so this file only asserts the MESSAGE-write contract;
 *   - the message upsert carries onConflict='conversation_id,ui_message_id' +
 *     ignoreDuplicates so a re-run/resync converges on ONE bubble;
 *   - tenancy on the message row is the caller-supplied (userId, workspaceId);
 *   - best-effort: an unresolved conversation / upsert error is a discriminated
 *     result, not a throw.
 */

const resolveHomeConversation = vi.fn(
  async (
    ..._a: unknown[]
  ): Promise<{ conversationId: string; created: boolean } | null> => ({
    conversationId: 'home-1',
    created: true,
  }),
)

vi.mock('@/lib/onboarding/home-conversation-pointer', () => ({
  resolveHomeConversation: (...a: unknown[]) => resolveHomeConversation(...(a as [])),
}))

import { appendHomeMessage } from '../home-message-writer'

interface Recorded {
  table: string
  op: 'upsert' | 'update'
  payload?: Record<string, unknown>
  options?: Record<string, unknown>
}

function makeSupabase(script: { messageUpsertError?: { message: string } | null }) {
  const recorded: Recorded[] = []
  function makeQuery(table: string) {
    const q: Record<string, unknown> = {
      upsert(payload: Record<string, unknown>, options?: Record<string, unknown>) {
        recorded.push({ table, op: 'upsert', payload, options })
        return Promise.resolve({ error: script.messageUpsertError ?? null })
      },
      update(payload: Record<string, unknown>) {
        recorded.push({ table, op: 'update', payload })
        const chain: Record<string, unknown> = {
          eq: () => chain,
          then: (onFulfilled?: (v: { error: unknown }) => unknown) =>
            Promise.resolve({ error: null }).then(onFulfilled),
        }
        return chain
      },
    }
    return q
  }
  return { from: (table: string) => makeQuery(table), _recorded: recorded }
}

beforeEach(() => {
  vi.clearAllMocks()
  resolveHomeConversation.mockResolvedValue({ conversationId: 'home-1', created: true })
})

describe('appendHomeMessage', () => {
  it('writes the message with caller tenancy + idempotent upsert options', async () => {
    const supabase = makeSupabase({})
    const res = await appendHomeMessage(supabase as never, {
      userId: 'u1',
      workspaceId: 'w1',
      parts: [{ type: 'text', text: 'hi' }],
      messageId: 'onboarding-brief-w1',
      metadata: { onboarding_brief: true },
    })
    expect(res.written).toBe(true)
    expect(res.conversationId).toBe('home-1')
    expect(res.created).toBe(true)

    // Tenancy was forwarded to the resolver, never read from elsewhere.
    expect(resolveHomeConversation).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ userId: 'u1', workspaceId: 'w1' }),
    )

    const msgUpsert = supabase._recorded.find(
      (r) => r.table === 'chat_messages' && r.op === 'upsert',
    )
    expect(msgUpsert?.payload).toMatchObject({
      conversation_id: 'home-1',
      user_id: 'u1',
      workspace_id: 'w1',
      role: 'assistant',
    })
    const ui = msgUpsert?.payload?.ui_message as { id: string; metadata: Record<string, unknown> }
    expect(ui.id).toBe('onboarding-brief-w1')
    expect(ui.metadata).toMatchObject({ onboarding_home: true, onboarding_brief: true })
    expect(msgUpsert?.options).toMatchObject({
      onConflict: 'conversation_id,ui_message_id',
      ignoreDuplicates: true,
    })
  })

  it('no-ops (written:false) when the home conversation cannot be resolved', async () => {
    resolveHomeConversation.mockResolvedValueOnce(null)
    const supabase = makeSupabase({})
    const res = await appendHomeMessage(supabase as never, {
      userId: 'u1',
      workspaceId: 'w1',
      parts: [{ type: 'text', text: 'hi' }],
      messageId: 'onboarding-brief-w1',
    })
    expect(res.written).toBe(false)
    expect(res.reason).toBe('no_conversation')
    expect(supabase._recorded.some((r) => r.table === 'chat_messages')).toBe(false)
  })

  it('returns error (not throw) when the message upsert fails', async () => {
    const supabase = makeSupabase({ messageUpsertError: { message: 'nope' } })
    const res = await appendHomeMessage(supabase as never, {
      userId: 'u1',
      workspaceId: 'w1',
      parts: [{ type: 'text', text: 'hi' }],
      messageId: 'onboarding-brief-w1',
    })
    expect(res.written).toBe(false)
    expect(res.reason).toBe('error')
  })
})
