/**
 * indexCapture embeds FIRST and swaps after (like indexDocument): an embedding
 * failure must leave the capture's old chunks in place rather than delete them
 * and leave the capture out of search until the reconciler heals it. The swap
 * is one replace_capture_chunks call (migration 416), with the old
 * delete-then-insert as the fallback before that function exists.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({ embedManySpy: vi.fn() }))

vi.mock('ai', () => ({
  embed: vi.fn(async () => ({ embedding: new Array(1536).fill(0), usage: { tokens: 1 }, providerMetadata: {} })),
  embedMany: (...args: unknown[]) => hoisted.embedManySpy(...args),
}))

vi.mock('@/lib/ai/auth', () => ({
  logUsage: vi.fn(async () => {}),
  extractGatewayCost: vi.fn(() => undefined),
}))

import { indexCapture } from '@/lib/ai/embeddings'
import type { SupabaseClient } from '@supabase/supabase-js'

type RpcResult = { data: unknown; error: { code?: string; message?: string } | null }

function fake(rpcResult: RpcResult = { data: 1, error: null }) {
  const ops: string[] = []
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = []
  const inserted: unknown[] = []
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      ops.push(`rpc:${fn}`)
      rpcCalls.push({ fn, args })
      return rpcResult
    },
    from: (table: string) => {
      if (table !== 'capture_chunks') throw new Error(`unexpected table ${table}`)
      return {
        delete: () => ({
          eq: async () => {
            ops.push('delete')
            return { error: null }
          },
        }),
        insert: async (rows: unknown) => {
          ops.push('insert')
          inserted.push(rows)
          return { error: null }
        },
      }
    },
  }
  return { client: client as unknown as SupabaseClient, ops, rpcCalls, inserted }
}

const MISSING_FUNCTION = { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.replace_capture_chunks' } }

function embedOk() {
  hoisted.embedManySpy.mockImplementation(async ({ values }: { values: string[] }) => ({
    embeddings: values.map(() => new Array(1536).fill(0)),
    usage: { tokens: 1 },
  }))
}

beforeEach(() => {
  hoisted.embedManySpy.mockReset()
})

describe('indexCapture', () => {
  it('leaves the old chunks alone when embedding fails', async () => {
    hoisted.embedManySpy.mockRejectedValue(new Error('429 rate limited'))
    const { client, ops } = fake()

    await expect(indexCapture(client, 'cap-1', 'user-1', null, 'Some meeting summary text.', 'ws-1')).rejects.toThrow(
      /429/,
    )
    expect(ops).toEqual([])
  })

  it('swaps the chunks through replace_capture_chunks after the embeddings are in hand', async () => {
    embedOk()
    const { client, ops, rpcCalls } = fake()

    const result = await indexCapture(
      client,
      'cap-1',
      'user-1',
      'proj-1',
      [
        { text: 'The summary.', source: 'summary' },
        { text: 'The transcript.', source: 'transcript' },
      ],
      'ws-1',
    )
    expect(result.chunksCreated).toBe(2)
    expect(ops).toEqual(['rpc:replace_capture_chunks'])
    expect(rpcCalls).toHaveLength(1)
    const args = rpcCalls[0].args
    expect(args.p_capture_id).toBe('cap-1')
    expect(args.p_workspace_id).toBe('ws-1')
    const rows = args.p_rows as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      capture_id: 'cap-1',
      user_id: 'user-1',
      project_id: 'proj-1',
      workspace_id: 'ws-1',
      chunk_index: 0,
      chunk_text: 'The summary.',
      source: 'summary',
    })
    expect(rows[1]).toMatchObject({ chunk_index: 1, chunk_text: 'The transcript.', source: 'transcript' })
    // The embedding travels as a JSON array string (cast to vector in SQL).
    expect(typeof rows[0].embedding).toBe('string')
    expect(JSON.parse(rows[0].embedding as string)).toHaveLength(1536)
  })

  it('falls back to delete-then-insert when the function is not there yet', async () => {
    embedOk()
    const { client, ops, inserted } = fake(MISSING_FUNCTION)

    const result = await indexCapture(client, 'cap-1', 'user-1', null, 'Some meeting summary text.', 'ws-1')
    expect(result.chunksCreated).toBe(1)
    expect(ops).toEqual(['rpc:replace_capture_chunks', 'delete', 'insert'])
    expect(inserted[0]).toEqual([expect.objectContaining({ capture_id: 'cap-1', chunk_index: 0, workspace_id: 'ws-1' })])
  })

  it('throws the swap error and touches nothing else', async () => {
    embedOk()
    const refused = { data: null, error: { code: '42501', message: 'capture cap-1 is not in workspace ws-2' } }
    const { client, ops } = fake(refused)

    await expect(indexCapture(client, 'cap-1', 'user-1', null, 'Some meeting summary text.', 'ws-2')).rejects.toMatchObject({
      code: '42501',
    })
    expect(ops).toEqual(['rpc:replace_capture_chunks'])
  })

  it('clears the chunks of a capture whose text is now empty through the swap', async () => {
    const { client, ops, rpcCalls } = fake()
    const result = await indexCapture(client, 'cap-1', 'user-1', null, '', 'ws-1')
    expect(result.chunksCreated).toBe(0)
    expect(ops).toEqual(['rpc:replace_capture_chunks'])
    expect(rpcCalls[0].args).toEqual({ p_capture_id: 'cap-1', p_workspace_id: 'ws-1', p_rows: [] })
    expect(hoisted.embedManySpy).not.toHaveBeenCalled()
  })

  it('still clears an emptied capture with the old delete when the function is not there yet', async () => {
    const { client, ops } = fake(MISSING_FUNCTION)
    const result = await indexCapture(client, 'cap-1', 'user-1', null, '', 'ws-1')
    expect(result.chunksCreated).toBe(0)
    expect(ops).toEqual(['rpc:replace_capture_chunks', 'delete'])
    expect(hoisted.embedManySpy).not.toHaveBeenCalled()
  })
})
