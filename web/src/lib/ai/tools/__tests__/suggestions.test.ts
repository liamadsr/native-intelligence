import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolExecutionOptions } from 'ai'

/**
 * suggest_changes picks its home from where it runs, never from the model,
 * except an explicit document_id the person can reach.
 */
const hoisted = vi.hoisted(() => ({ stageSuggestions: vi.fn() }))
vi.mock('@/lib/suggestions/stage', () => ({ stageSuggestions: hoisted.stageSuggestions }))

const { createSuggestionTools } = await import('../suggestions')

const EXEC = { toolCallId: 't', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>
const CHANGE = { change: 'update', entity: 'action', target: 'GEN-1', summary: 'Close GEN-1', set: { status: 'Done' }, why: 'shipped' }

function db(rows: Record<string, unknown>) {
  return {
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      for (const k of ['select', 'eq']) chain[k] = () => chain
      chain.maybeSingle = async () => ({ data: rows[table] ?? null, error: null })
      return chain
    },
  } as never
}

beforeEach(() => {
  hoisted.stageSuggestions.mockReset()
  hoisted.stageSuggestions.mockResolvedValue([{ id: 'pc-1', marker: '<!-- proposal:pc-1 -->', summary: 'Close GEN-1', result: 'staged' }])
})

async function run(supabase: never, input: Record<string, unknown>, ctx?: Parameters<typeof createSuggestionTools>[3]) {
  const tools = createSuggestionTools('u-1', supabase, 'ws-1', ctx)
  return (await tools.suggest_changes.execute!(input as never, EXEC)) as Record<string, unknown>
}

describe('suggest_changes', () => {
  it('stages into the chat conversation the person owns', async () => {
    const r = await run(db({ chat_conversations: { id: 'conv-1' } }), { changes: [CHANGE] }, { origin: 'chat', conversationId: 'conv-1' })
    expect(r).toMatchObject({ success: true, staged: 1, refused: 0 })
    expect(hoisted.stageSuggestions.mock.calls[0][0]).toMatchObject({
      userId: 'u-1',
      workspaceId: 'ws-1',
      origin: 'chat',
      home: { kind: 'conversation', id: 'conv-1' },
      trackedJobId: null,
    })
  })

  it('a document_id the person can reach wins', async () => {
    await run(db({ document: { id: 'doc-1', workspace_id: 'ws-2' }, member: { id: 'm' } }), { document_id: 'b1a7c9d2-0000-4000-8000-000000000001', changes: [CHANGE] }, { origin: 'chat', conversationId: 'conv-1' })
    expect(hoisted.stageSuggestions.mock.calls[0][0].home).toEqual({ kind: 'document', id: 'doc-1' })
  })

  it('refuses a document in a workspace the person is not in', async () => {
    const r = await run(db({ document: { id: 'doc-1', workspace_id: 'ws-x' } }), { document_id: 'b1a7c9d2-0000-4000-8000-000000000001', changes: [CHANGE] })
    expect(r.success).toBe(false)
    expect(hoisted.stageSuggestions).not.toHaveBeenCalled()
  })

  it('a run stages against its work-ledger row, resolved lazily', async () => {
    const resolve = vi.fn(async () => 'job-1')
    const r = await run(db({}), { changes: [CHANGE] }, { origin: 'work_run', trackedJobId: resolve })
    expect(resolve).toHaveBeenCalledOnce()
    expect(hoisted.stageSuggestions.mock.calls[0][0]).toMatchObject({ home: null, trackedJobId: 'job-1', origin: 'work_run' })
    expect(r.note).toContain('document this run delivers')
  })

  it('with nowhere to show them (MCP, no document_id) it asks for one', async () => {
    const r = await run(db({}), { changes: [CHANGE] })
    expect(r).toMatchObject({ success: false })
    expect(String(r.error)).toContain('document_id')
  })

  it('a conversation that is not the person’s is not a home', async () => {
    const r = await run(db({ chat_conversations: null }), { changes: [CHANGE] }, { origin: 'chat', conversationId: 'conv-x' })
    expect(r.success).toBe(false)
  })
})
