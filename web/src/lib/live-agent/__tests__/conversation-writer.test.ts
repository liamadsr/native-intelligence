import { describe, it, expect, vi, beforeEach } from 'vitest'
import { appendAgentMessage, syncProposalsCard, hasPendingLiveQuestion } from '../conversation-writer'

/**
 * Locks the conversation-writer's security + idempotency contract (plan D4/D5):
 *   - user_id/workspace_id are always the CAPTURE OWNER's, never the caller's
 *     (the desktop path runs service-role — RLS is not a backstop);
 *   - a capture with no conversation is a clean no-op (feature-off captures);
 *   - a say_to_user row is written however recent the last one (no throttle).
 */

// A tiny recording query builder: records the last upsert payload + resolves
// reads by table via a per-test script.
function makeSupabase(script: {
  captureOwner?: { user_id: string; workspace_id: string } | null
  conversationId?: string | null
  lastSayToUserAt?: string | null
  /** proposed_change list rows (for syncProposalsCard). */
  proposalRows?: Array<{ id: string }>
  /** chat_messages list rows (for hasPendingLiveQuestion). */
  messageRows?: Array<{ ui_message: unknown }>
}) {
  const upserts: Array<{ table: string; row: Record<string, unknown>; opts?: unknown }> = []

  const from = vi.fn((table: string) => {
    const builder: Record<string, unknown> = {}
    const proxy: Record<string, unknown> = new Proxy(builder, {
      get(target, prop: string) {
        if (prop in target) return target[prop]
        const fn = (...args: unknown[]) => {
          if (prop === 'upsert') {
            upserts.push({ table, row: args[0] as Record<string, unknown>, opts: args[1] })
          }
          return proxy
        }
        target[prop] = fn
        return fn
      },
    }) as Record<string, unknown>

    builder.maybeSingle = () => {
      if (table === 'captures') {
        return Promise.resolve({ data: script.captureOwner ?? null, error: null })
      }
      if (table === 'chat_conversations') {
        return Promise.resolve({
          data: script.conversationId ? { id: script.conversationId } : null,
          error: null,
        })
      }
      if (table === 'chat_messages') {
        return Promise.resolve({
          data: script.lastSayToUserAt ? { created_at: script.lastSayToUserAt } : null,
          error: null,
        })
      }
      return Promise.resolve({ data: null, error: null })
    }
    // List reads (no maybeSingle) resolve via `then` — proposed_change for the
    // proposals card, chat_messages for the pending-question scan.
    builder.then = (resolve?: (r: unknown) => unknown) => {
      let data: unknown = null
      if (table === 'proposed_change') data = script.proposalRows ?? []
      else if (table === 'chat_messages') data = script.messageRows ?? []
      return Promise.resolve({ data, error: null }).then(resolve)
    }
    // upsert(...).returns nothing to await → resolve to no error.
    builder.select = () => proxy
    return proxy
  })

  // upsert returns a thenable resolving to { error: null }
  const wrappedFrom = vi.fn((table: string) => {
    const p = from(table) as Record<string, unknown>
    const origUpsert = p.upsert as (...a: unknown[]) => unknown
    p.upsert = (...args: unknown[]) => {
      origUpsert(...args)
      return Promise.resolve({ error: null })
    }
    return p
  })

  return { from: wrappedFrom, _upserts: upserts }
}

beforeEach(() => vi.clearAllMocks())

describe('appendAgentMessage', () => {
  it('writes user_id + workspace_id from the CAPTURE OWNER, not the caller', async () => {
    const supabase = makeSupabase({
      captureOwner: { user_id: 'owner-1', workspace_id: 'ws-1' },
      conversationId: 'conv-1',
    })
    const res = await appendAgentMessage(supabase as never, {
      captureId: 'c1',
      parts: [{ type: 'text', text: 'hi' }],
    })
    expect(res.written).toBe(true)
    const msgUpsert = supabase._upserts.find((u) => u.table === 'chat_messages')
    expect(msgUpsert?.row.user_id).toBe('owner-1')
    expect(msgUpsert?.row.workspace_id).toBe('ws-1')
    expect(msgUpsert?.row.role).toBe('assistant')
  })

  it('no-ops (written:false) when the capture has no conversation', async () => {
    const supabase = makeSupabase({
      captureOwner: { user_id: 'owner-1', workspace_id: 'ws-1' },
      conversationId: null,
    })
    const res = await appendAgentMessage(supabase as never, {
      captureId: 'c1',
      parts: [{ type: 'text', text: 'hi' }],
    })
    expect(res.written).toBe(false)
    expect(res.reason).toBe('no_conversation')
    expect(supabase._upserts.some((u) => u.table === 'chat_messages')).toBe(false)
  })

  it('no-ops when the capture is missing entirely', async () => {
    const supabase = makeSupabase({ captureOwner: null })
    const res = await appendAgentMessage(supabase as never, {
      captureId: 'gone',
      parts: [{ type: 'text', text: 'hi' }],
    })
    expect(res.written).toBe(false)
    expect(res.reason).toBe('no_conversation')
  })

  it('writes a say_to_user row even when the last one is 2 s old (no throttle: every delivered nudge has its row)', async () => {
    const supabase = makeSupabase({
      captureOwner: { user_id: 'owner-1', workspace_id: 'ws-1' },
      conversationId: 'conv-1',
      lastSayToUserAt: new Date(Date.now() - 2_000).toISOString(), // 2s ago
    })
    const res = await appendAgentMessage(supabase as never, {
      captureId: 'c1',
      messageId: 'nudge-id-2',
      parts: [{ type: 'text', text: 'ping' }],
      metadata: { kind: 'say_to_user', nudge_kind: 'insight' },
    })
    expect(res).toMatchObject({ written: true, messageId: 'nudge-id-2' })
    const msgUpsert = supabase._upserts.find((u) => u.table === 'chat_messages')
    expect((msgUpsert?.row.ui_message as { id: string }).id).toBe('nudge-id-2')
  })

  it('uses a stable messageId when provided (greeting idempotency)', async () => {
    const supabase = makeSupabase({
      captureOwner: { user_id: 'owner-1', workspace_id: 'ws-1' },
      conversationId: 'conv-1',
    })
    await appendAgentMessage(supabase as never, {
      captureId: 'c1',
      messageId: 'greeting-c1',
      parts: [{ type: 'text', text: 'hi' }],
    })
    const msgUpsert = supabase._upserts.find((u) => u.table === 'chat_messages')
    expect((msgUpsert?.row.ui_message as { id: string }).id).toBe('greeting-c1')
    expect(msgUpsert?.opts).toMatchObject({ onConflict: 'conversation_id,ui_message_id' })
  })
})

describe('syncProposalsCard', () => {
  it('writes a rolling data-proposals card with a stable per-capture id', async () => {
    const supabase = makeSupabase({
      captureOwner: { user_id: 'owner-1', workspace_id: 'ws-1' },
      conversationId: 'conv-1',
      proposalRows: [{ id: 'p1' }, { id: 'p2' }],
    })
    const res = await syncProposalsCard(supabase as never, 'c1')
    expect(res.written).toBe(true)
    const upsert = supabase._upserts.find((u) => u.table === 'chat_messages')
    const ui = upsert?.row.ui_message as { id: string; parts: Array<Record<string, unknown>> }
    expect(ui.id).toBe('proposals-c1') // stable → grows in place, no new bubbles
    const dataPart = ui.parts.find((p) => p.type === 'data-proposals') as
      | { data: { capture_id: string; proposal_ids: string[] } }
      | undefined
    expect(dataPart?.data.proposal_ids).toEqual(['p1', 'p2'])
    // Update-on-conflict (NOT ignoreDuplicates) so the card refreshes.
    expect(upsert?.opts).toMatchObject({ onConflict: 'conversation_id,ui_message_id' })
    expect((upsert?.opts as { ignoreDuplicates?: boolean }).ignoreDuplicates).toBeUndefined()
  })

  it('no-ops when the capture has zero non-dismissed proposals', async () => {
    const supabase = makeSupabase({
      captureOwner: { user_id: 'owner-1', workspace_id: 'ws-1' },
      conversationId: 'conv-1',
      proposalRows: [],
    })
    const res = await syncProposalsCard(supabase as never, 'c1')
    expect(res.written).toBe(false)
    expect(supabase._upserts.some((u) => u.table === 'chat_messages')).toBe(false)
  })
})

describe('hasPendingLiveQuestion', () => {
  const pendingMsg = {
    ui_message: {
      metadata: { kind: 'ask_user' },
      parts: [{ type: 'tool-ask_user', state: 'input-available' }],
    },
  }
  const answeredMsg = {
    ui_message: {
      metadata: { kind: 'ask_user' },
      parts: [{ type: 'tool-ask_user', state: 'output-available' }],
    },
  }

  it('is true while an ask_user part is still input-available', async () => {
    const supabase = makeSupabase({ conversationId: 'conv-1', messageRows: [pendingMsg] })
    expect(await hasPendingLiveQuestion(supabase as never, 'c1')).toBe(true)
  })

  it('is false when the only question has been answered', async () => {
    const supabase = makeSupabase({ conversationId: 'conv-1', messageRows: [answeredMsg] })
    expect(await hasPendingLiveQuestion(supabase as never, 'c1')).toBe(false)
  })

  it('is false when there is no conversation', async () => {
    const supabase = makeSupabase({ conversationId: null })
    expect(await hasPendingLiveQuestion(supabase as never, 'c1')).toBe(false)
  })
})
