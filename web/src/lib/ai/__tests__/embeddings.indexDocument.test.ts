/**
 * Tests for indexDocument and chunkDocument (src/lib/ai/embeddings.ts).
 *
 * indexDocument is the write half of document embeddings: it chunks a
 * document's markdown by section, embeds what changed, and swaps the
 * document's chunks in one transaction (replace_document_chunks, migration
 * 365) that hybrid_search's document_vec branch reads. Locked in here, without
 * the embedding gateway:
 *   - embed first, swap after: an embedding failure touches nothing, so a
 *     document never ends up with no vectors;
 *   - only new or changed chunks are embedded; the rest keep their vectors
 *     (the RPC copies them: embedding null in the row);
 *   - every chunk carries its heading path, embedded with its text;
 *   - an emptied body clears the chunks; a body that never had any is a no-op;
 *   - before migration 365 (no RPC) it falls back to delete-then-insert,
 *     still after embedding;
 *   - a reuse that misses (another re-index swapped in between) re-embeds
 *     everything and swaps once more.
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

import { chunkDocument, documentChunkEmbeddingText, indexDocument } from '@/lib/ai/embeddings'
import type { SupabaseClient } from '@supabase/supabase-js'

const WORKSPACE_ID = 'ws-1'
const DOC_ID = 'doc-1'
const USER_ID = 'user-1'
const PROJECT_ID = 'proj-1'

type Row = { chunk_index: number; chunk_text: string; heading: string | null; embedding: string | null }

/** A supabase double: the chunks the document has, the RPC's answers in order, and what was written. */
function fake(opts: { existing?: Array<{ chunk_text: string; heading: string | null }>; rpc?: Array<{ error: { code?: string; message: string } | null }> } = {}) {
  const rpcCalls: Array<{ name: string; args: { p_rows: Row[] } & Record<string, unknown> }> = []
  const answers = [...(opts.rpc ?? [])]
  const deletes: unknown[] = []
  const inserts: unknown[] = []
  const reads: Array<Array<[string, unknown]>> = []
  const client = {
    from: (table: string) => {
      if (table !== 'document_chunks') throw new Error(`unexpected table ${table}`)
      return {
        select: () => {
          const filters: Array<[string, unknown]> = []
          reads.push(filters)
          const q = {
            eq: (k: string, v: unknown) => (filters.push([k, v]), q),
            then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: opts.existing ?? [], error: null }).then(resolve),
          }
          return q
        },
        delete: () => ({
          eq: async (...args: unknown[]) => {
            deletes.push(args)
            return { error: null }
          },
        }),
        insert: async (rows: unknown) => {
          inserts.push(rows)
          return { error: null }
        },
      }
    },
    rpc: async (name: string, args: { p_rows: Row[] }) => {
      rpcCalls.push({ name, args })
      return { data: args.p_rows.length, ...(answers.shift() ?? { error: null }) }
    },
  }
  return { client: client as unknown as SupabaseClient, rpcCalls, deletes, inserts, reads }
}

const BODY = '# Product\n\nNative Intelligence captures meetings and files the follow-ups.\n\n## Positioning\nFor founders who run their own sales calls.\n\n### Real alternative\nGranola plus Linear plus a CRM.'

describe('chunkDocument', () => {
  it('chunks by section, each chunk with its heading path, headings not repeated as text', () => {
    expect(chunkDocument(BODY)).toEqual([
      { text: 'Native Intelligence captures meetings and files the follow-ups.', heading: 'Product' },
      { text: 'For founders who run their own sales calls.', heading: 'Product > Positioning' },
      { text: 'Granola plus Linear plus a CRM.', heading: 'Product > Positioning > Real alternative' },
    ])
  })

  it('text before the first heading has no heading; a long section splits on sentences', () => {
    const long = Array.from({ length: 30 }, (_, i) => `Sentence ${i} is here.`).join(' ')
    const chunks = chunkDocument(`Preamble text.\n\n## Notes\n${long}`)
    expect(chunks[0]).toEqual({ text: 'Preamble text.', heading: null })
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.slice(1).every((c) => c.heading === 'Notes' && c.text.length <= 500)).toBe(true)
  })

  it('the section is part of what is embedded', () => {
    expect(documentChunkEmbeddingText({ text: 'x', heading: 'A > B' })).toBe('A > B\n\nx')
    expect(documentChunkEmbeddingText({ text: 'x', heading: null })).toBe('x')
  })
})

describe('indexDocument', () => {
  beforeEach(() => {
    hoisted.embedManySpy.mockReset()
    hoisted.embedManySpy.mockImplementation(async ({ values }: { values: string[] }) => ({
      embeddings: values.map(() => new Array(1536).fill(0.1)),
      usage: { tokens: 10 },
      providerMetadata: {},
    }))
  })

  it('embeds, then swaps the chunks in one call, indexed 0..n with their headings', async () => {
    const f = fake()
    const res = await indexDocument(f.client, DOC_ID, USER_ID, PROJECT_ID, BODY, WORKSPACE_ID)
    expect(res).toEqual({ chunksCreated: 3, chunksEmbedded: 3 })
    expect(f.rpcCalls).toHaveLength(1)
    const { name, args } = f.rpcCalls[0]
    expect(name).toBe('replace_document_chunks')
    expect(args).toMatchObject({ p_document_id: DOC_ID, p_workspace_id: WORKSPACE_ID, p_project_id: PROJECT_ID })
    expect(args.p_rows.map((r) => [r.chunk_index, r.heading])).toEqual([
      [0, 'Product'],
      [1, 'Product > Positioning'],
      [2, 'Product > Positioning > Real alternative'],
    ])
    expect(args.p_rows.every((r) => typeof r.embedding === 'string' && JSON.parse(r.embedding).length === 1536)).toBe(true)
    // The section went into the embedding input.
    expect(hoisted.embedManySpy.mock.calls[0][0].values[1]).toBe('Product > Positioning\n\nFor founders who run their own sales calls.')
    expect(f.deletes).toHaveLength(0)
  })

  it('an embedding failure touches nothing: the old vectors stay', async () => {
    hoisted.embedManySpy.mockRejectedValue(new Error('gateway down'))
    const f = fake({ existing: [{ chunk_text: 'old', heading: null }] })
    await expect(indexDocument(f.client, DOC_ID, USER_ID, PROJECT_ID, BODY, WORKSPACE_ID)).rejects.toThrow('gateway down')
    expect(f.rpcCalls).toHaveLength(0)
    expect(f.deletes).toHaveLength(0)
  })

  it('re-embeds only what changed; unchanged chunks reuse their vector', async () => {
    const f = fake({
      existing: [
        { chunk_text: 'Native Intelligence captures meetings and files the follow-ups.', heading: 'Product' },
        { chunk_text: 'Granola plus Linear plus a CRM.', heading: 'Product > Positioning > Real alternative' },
      ],
    })
    const res = await indexDocument(f.client, DOC_ID, USER_ID, PROJECT_ID, BODY, WORKSPACE_ID)
    expect(res).toEqual({ chunksCreated: 3, chunksEmbedded: 1 })
    expect(hoisted.embedManySpy.mock.calls[0][0].values).toEqual(['Product > Positioning\n\nFor founders who run their own sales calls.'])
    expect(f.rpcCalls[0].args.p_rows.map((r) => r.embedding === null)).toEqual([true, false, true])
  })

  it('the same text under a new heading is new', async () => {
    const f = fake({ existing: [{ chunk_text: 'For founders who run their own sales calls.', heading: null }] })
    await indexDocument(f.client, DOC_ID, USER_ID, PROJECT_ID, BODY, WORKSPACE_ID)
    expect(hoisted.embedManySpy.mock.calls[0][0].values).toHaveLength(3)
  })

  it('an emptied body clears the chunks; one that never had any is a no-op', async () => {
    const had = fake({ existing: [{ chunk_text: 'old', heading: null }] })
    expect(await indexDocument(had.client, DOC_ID, USER_ID, PROJECT_ID, 'too short', WORKSPACE_ID)).toEqual({ chunksCreated: 0, chunksEmbedded: 0 })
    expect(had.rpcCalls[0].args.p_rows).toEqual([])
    const never = fake()
    expect(await indexDocument(never.client, DOC_ID, USER_ID, PROJECT_ID, null, WORKSPACE_ID)).toEqual({ chunksCreated: 0, chunksEmbedded: 0 })
    expect(never.rpcCalls).toHaveLength(0)
    expect(hoisted.embedManySpy).not.toHaveBeenCalled()
  })

  it('before migration 365 (no RPC): delete-then-insert, still after embedding everything', async () => {
    const f = fake({ existing: [{ chunk_text: 'Native Intelligence captures meetings and files the follow-ups.', heading: 'Product' }], rpc: [{ error: { code: 'PGRST202', message: 'not found' } }] })
    const res = await indexDocument(f.client, DOC_ID, USER_ID, PROJECT_ID, BODY, WORKSPACE_ID)
    expect(res).toEqual({ chunksCreated: 3, chunksEmbedded: 3 })
    expect(f.deletes).toEqual([['document_id', DOC_ID]])
    const rows = f.inserts[0] as Array<Record<string, unknown>>
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => typeof r.embedding === 'string')).toBe(true)
  })

  it('a reuse that misses re-embeds everything and swaps once more', async () => {
    const f = fake({
      existing: [{ chunk_text: 'Native Intelligence captures meetings and files the follow-ups.', heading: 'Product' }],
      rpc: [{ error: { code: '23502', message: 'null value in column "embedding"' } }, { error: null }],
    })
    const res = await indexDocument(f.client, DOC_ID, USER_ID, PROJECT_ID, BODY, WORKSPACE_ID)
    expect(res).toEqual({ chunksCreated: 3, chunksEmbedded: 3 })
    expect(f.rpcCalls).toHaveLength(2)
    expect(f.rpcCalls[1].args.p_rows.every((r) => r.embedding !== null)).toBe(true)
  })

  it('a swap that still fails throws (callers are best-effort)', async () => {
    const f = fake({ rpc: [{ error: { code: '42501', message: 'denied' } }] })
    await expect(indexDocument(f.client, DOC_ID, USER_ID, PROJECT_ID, BODY, WORKSPACE_ID)).rejects.toMatchObject({ message: 'denied' })
  })

  it("reads only the document's chunks in its own workspace (chunks never cross workspaces, 365)", async () => {
    const f = fake()
    await indexDocument(f.client, DOC_ID, USER_ID, PROJECT_ID, BODY, WORKSPACE_ID)
    expect(f.reads[0]).toEqual([['document_id', DOC_ID], ['workspace_id', WORKSPACE_ID]])
  })

  it('a refused swap (the document is not in that workspace) is not retried, even when a reuse was planned', async () => {
    const f = fake({
      existing: [{ chunk_text: 'Native Intelligence captures meetings and files the follow-ups.', heading: 'Product' }],
      rpc: [{ error: { code: '42501', message: 'document is not in workspace' } }],
    })
    await expect(indexDocument(f.client, DOC_ID, USER_ID, PROJECT_ID, BODY, WORKSPACE_ID)).rejects.toMatchObject({ code: '42501' })
    expect(f.rpcCalls).toHaveLength(1)
    expect(f.deletes).toHaveLength(0)
  })
})
