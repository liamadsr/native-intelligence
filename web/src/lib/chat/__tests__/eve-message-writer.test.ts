import { describe, it, expect, vi, beforeEach } from 'vitest'
import { persistEveMessage, EVE_WRITTEN_METADATA_KEY } from '../eve-message-writer'

/**
 * Locks the eve message-writer's projection + security contract (Phase 4):
 *   - user_id/workspace_id come from the CONVERSATION OWNER row, and a token
 *     whose tenancy doesn't match the owner is refused (owner_mismatch) — the
 *     internal caller runs service-role, so this is the tenancy backstop;
 *   - a missing conversation is a clean no-op;
 *   - the message's top-level id (→ ui_message_id) is preserved for dedup, and
 *     the eve_written discriminant is stamped so the client autosave skips it;
 *   - conversationActivityFired mirrors whether a NEW row landed (so the
 *     knowledge hook fires once per persisted turn, never on a dedup no-op).
 */

/** Records the last upsert payload + drives the upsert().select() return shape
 *  by whether the row was a fresh insert (didInsert) or a dedup no-op. */
function makeSupabase(script: {
  owner?: { user_id: string; workspace_id: string } | null
  /** upsert(...).select() rows: non-empty ⇒ a new row landed; [] ⇒ dedup no-op. */
  insertedRows?: Array<{ id: string }>
  upsertError?: { message: string } | null
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
      if (table === 'chat_conversations') {
        return Promise.resolve({ data: script.owner ?? null, error: null })
      }
      return Promise.resolve({ data: null, error: null })
    }
    // `select` must CHAIN (read path: .select().eq().maybeSingle()) yet also be
    // AWAITABLE (upsert path: .upsert().select('id')). Return the proxy so
    // chaining works, and make the proxy itself thenable so awaiting the
    // upsert().select() resolves to { data, error }.
    builder.select = () => proxy
    builder.then = (resolve?: (r: unknown) => unknown) =>
      Promise.resolve({
        data: script.upsertError ? null : (script.insertedRows ?? []),
        error: script.upsertError ?? null,
      }).then(resolve)
    return proxy
  })

  return { from, _upserts: upserts }
}

const OWNER = { user_id: 'owner-1', workspace_id: 'ws-1' }
const basePart = [{ type: 'text', text: 'hello from eve' }]

beforeEach(() => vi.clearAllMocks())

describe('persistEveMessage', () => {
  it('writes user_id + workspace_id from the CONVERSATION OWNER row', async () => {
    const supabase = makeSupabase({ owner: OWNER, insertedRows: [{ id: 'row-1' }] })
    const res = await persistEveMessage(supabase as never, {
      conversationId: 'conv-1',
      userId: 'owner-1',
      workspaceId: 'ws-1',
      parts: basePart,
      messageId: 'm-eve-1',
    })
    expect(res.written).toBe(true)
    const upsert = supabase._upserts.find((u) => u.table === 'chat_messages')
    expect(upsert?.row.user_id).toBe('owner-1')
    expect(upsert?.row.workspace_id).toBe('ws-1')
    expect(upsert?.row.role).toBe('assistant')
  })

  it('preserves the top-level id (→ ui_message_id) and stamps eve_written', async () => {
    const supabase = makeSupabase({ owner: OWNER, insertedRows: [{ id: 'row-1' }] })
    await persistEveMessage(supabase as never, {
      conversationId: 'conv-1',
      userId: 'owner-1',
      workspaceId: 'ws-1',
      parts: basePart,
      messageId: 'm-eve-1',
      metadata: { model: 'claude-haiku-4-5-20251001' },
    })
    const upsert = supabase._upserts.find((u) => u.table === 'chat_messages')
    const ui = upsert?.row.ui_message as {
      id: string
      metadata: Record<string, unknown>
    }
    expect(ui.id).toBe('m-eve-1')
    expect(ui.metadata[EVE_WRITTEN_METADATA_KEY]).toBe(true)
    // Caller metadata is merged alongside the discriminant.
    expect(ui.metadata.model).toBe('claude-haiku-4-5-20251001')
    // Dedup path is intact: conflict on the identity index + ignoreDuplicates.
    expect(upsert?.opts).toMatchObject({
      onConflict: 'conversation_id,ui_message_id',
      ignoreDuplicates: true,
    })
  })

  it('no-ops (no_conversation) when the conversation is missing', async () => {
    const supabase = makeSupabase({ owner: null })
    const res = await persistEveMessage(supabase as never, {
      conversationId: 'gone',
      userId: 'owner-1',
      workspaceId: 'ws-1',
      parts: basePart,
      messageId: 'm-1',
    })
    expect(res.written).toBe(false)
    expect(res.reason).toBe('no_conversation')
    expect(res.conversationActivityFired).toBe(false)
    expect(supabase._upserts.some((u) => u.table === 'chat_messages')).toBe(false)
  })

  it('refuses (owner_mismatch) when the token tenancy is not the conversation owner', async () => {
    const supabase = makeSupabase({ owner: OWNER, insertedRows: [{ id: 'row-1' }] })
    const res = await persistEveMessage(supabase as never, {
      conversationId: 'conv-1',
      userId: 'attacker', // token minted for a different user
      workspaceId: 'ws-1',
      parts: basePart,
      messageId: 'm-1',
    })
    expect(res.written).toBe(false)
    expect(res.reason).toBe('owner_mismatch')
    expect(res.conversationActivityFired).toBe(false)
    // Nothing was written into the victim's thread.
    expect(supabase._upserts.some((u) => u.table === 'chat_messages')).toBe(false)
  })

  it('fires conversation activity exactly once — on a NEW row, not a dedup no-op', async () => {
    // New row lands → activity fires.
    const fresh = makeSupabase({ owner: OWNER, insertedRows: [{ id: 'row-1' }] })
    const inserted = await persistEveMessage(fresh as never, {
      conversationId: 'conv-1',
      userId: 'owner-1',
      workspaceId: 'ws-1',
      parts: basePart,
      messageId: 'm-1',
    })
    expect(inserted.written).toBe(true)
    expect(inserted.conversationActivityFired).toBe(true)

    // Same id replayed → upsert dedups (select returns []) → NO activity.
    const replay = makeSupabase({ owner: OWNER, insertedRows: [] })
    const deduped = await persistEveMessage(replay as never, {
      conversationId: 'conv-1',
      userId: 'owner-1',
      workspaceId: 'ws-1',
      parts: basePart,
      messageId: 'm-1',
    })
    expect(deduped.written).toBe(false)
    expect(deduped.conversationActivityFired).toBe(false)
  })

  it('returns error (not throw) when the upsert fails', async () => {
    const supabase = makeSupabase({ owner: OWNER, upsertError: { message: 'boom' } })
    const res = await persistEveMessage(supabase as never, {
      conversationId: 'conv-1',
      userId: 'owner-1',
      workspaceId: 'ws-1',
      parts: basePart,
      messageId: 'm-1',
    })
    expect(res.written).toBe(false)
    expect(res.reason).toBe('error')
    expect(res.conversationActivityFired).toBe(false)
  })
})
