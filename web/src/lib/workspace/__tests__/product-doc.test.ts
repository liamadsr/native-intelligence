import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  PRODUCT_DOC_TTL_MS,
  clearProductDocCache,
  isProductDocEligible,
  loadProductDoc,
  loadProductDocForTurn,
  productDocIneligibility,
  readProductDocPointer,
  setWorkspaceProductDoc,
} from '../product-doc'

const POINTER = { document_id: 'doc-1', set_by: 'mem-1', set_at: '2026-10-01T00:00:00.000Z' }
const ROW = {
  id: 'doc-1',
  title: 'Product facts',
  content: '  # Pricing\nPro is $20.  ',
  updated_at: '2026-10-02T00:00:00Z',
  status: 'active',
  published_status: 'published',
  type: 'note',
  frontmatter: {},
}

/** A fake client whose document read answers `row` (or `error`) and records its filters. */
function docClient(answer: () => { data: unknown; error: { message: string } | null }) {
  const reads: Array<Array<[string, unknown]>> = []
  const client = {
    from: (table: string) => {
      const filters: Array<[string, unknown]> = []
      const chain = {
        select: () => chain,
        eq: (c: string, v: unknown) => {
          filters.push([c, v])
          return chain
        },
        maybeSingle: async () => {
          expect(table).toBe('document')
          reads.push(filters)
          return answer()
        },
      }
      return chain
    },
  }
  return { client: client as unknown as SupabaseClient, reads }
}

describe('readProductDocPointer', () => {
  it('reads a well-formed pointer', () => {
    expect(readProductDocPointer({ edition: 'sales', product_doc: POINTER })).toEqual(POINTER)
  })

  it.each([
    ['null settings', null],
    ['a string', 'x'],
    ['an array', [POINTER]],
    ['no key', { edition: 'sales' }],
    ['a string pointer', { product_doc: 'doc-1' }],
    ['an array pointer', { product_doc: [POINTER] }],
    ['no document_id', { product_doc: { set_by: 'mem-1' } }],
    ['a numeric document_id', { product_doc: { document_id: 42 } }],
    ['an empty document_id', { product_doc: { document_id: '' } }],
    ['a document_id with a filter injection', { product_doc: { document_id: 'a,workspace_id.eq.x' } }],
  ])('treats %s as no product doc', (_name, settings) => {
    expect(readProductDocPointer(settings)).toBeNull()
  })

  it('keeps the document id and drops junk side fields', () => {
    expect(readProductDocPointer({ product_doc: { document_id: 'doc-1', set_by: { x: 1 }, set_at: 'not a date' } })).toEqual({
      document_id: 'doc-1',
      set_by: null,
      set_at: null,
    })
  })
})

describe('eligibility', () => {
  it('an active, published, shared note qualifies', () => {
    expect(isProductDocEligible(ROW)).toBe(true)
  })
  it.each([
    ['archived', { status: 'archived' }],
    ['draft', { published_status: 'draft' }],
    ['spec', { type: 'spec' }],
    // Someone's "Only me" document (migration 369).
    ['private', { visibility: 'private' }],
    ['personal', { frontmatter: { meeting_prep: { userId: 'u-1' } } }],
  ])('refuses a %s document', (reason, patch) => {
    expect(productDocIneligibility({ ...ROW, ...patch })).toBe(reason)
  })
})

describe('loadProductDoc', () => {
  it('is ONE read by (id, workspace) and returns the trimmed text', async () => {
    const { client, reads } = docClient(() => ({ data: ROW, error: null }))
    const doc = await loadProductDoc(client, { workspaceId: 'ws-1', documentId: 'doc-1' })
    expect(doc).toEqual({ documentId: 'doc-1', title: 'Product facts', text: '# Pricing\nPro is $20.', updatedAt: '2026-10-02T00:00:00Z' })
    expect(reads).toEqual([[['id', 'doc-1'], ['workspace_id', 'ws-1']]])
  })

  it('null for a missing, ineligible or empty document', async () => {
    for (const data of [null, { ...ROW, status: 'archived' }, { ...ROW, frontmatter: { meeting_prep: {} } }, { ...ROW, content: '   ' }, { ...ROW, content: null }]) {
      const { client } = docClient(() => ({ data, error: null }))
      expect(await loadProductDoc(client, { workspaceId: 'ws-1', documentId: 'doc-1' })).toBeNull()
    }
  })

  it('throws on a failed read', async () => {
    const { client } = docClient(() => ({ data: null, error: { message: 'boom' } }))
    await expect(loadProductDoc(client, { workspaceId: 'ws-1', documentId: 'doc-1' })).rejects.toThrow('boom')
  })
})

describe('loadProductDocForTurn (the cache)', () => {
  beforeEach(() => clearProductDocCache())
  const settings = { product_doc: POINTER }

  it('no pointer → null and NO read', async () => {
    const { client, reads } = docClient(() => ({ data: ROW, error: null }))
    expect(await loadProductDocForTurn(client, { workspaceId: 'ws-1', settings: { edition: 'full' } })).toBeNull()
    expect(await loadProductDocForTurn(client, { workspaceId: 'ws-1', settings: null })).toBeNull()
    expect(reads).toHaveLength(0)
  })

  it('reads once per 15 s per (workspace, document), then again after', async () => {
    const { client, reads } = docClient(() => ({ data: ROW, error: null }))
    const t0 = 1_000_000
    await loadProductDocForTurn(client, { workspaceId: 'ws-1', settings }, t0)
    await loadProductDocForTurn(client, { workspaceId: 'ws-1', settings }, t0 + 3_000)
    await loadProductDocForTurn(client, { workspaceId: 'ws-1', settings }, t0 + PRODUCT_DOC_TTL_MS - 1)
    expect(reads).toHaveLength(1)
    await loadProductDocForTurn(client, { workspaceId: 'ws-1', settings }, t0 + PRODUCT_DOC_TTL_MS)
    expect(reads).toHaveLength(2)
  })

  it('another workspace or a re-pointed doc is its own key (read at once)', async () => {
    const { client, reads } = docClient(() => ({ data: ROW, error: null }))
    const t0 = 2_000_000
    await loadProductDocForTurn(client, { workspaceId: 'ws-1', settings }, t0)
    await loadProductDocForTurn(client, { workspaceId: 'ws-2', settings }, t0)
    await loadProductDocForTurn(client, { workspaceId: 'ws-1', settings: { product_doc: { document_id: 'doc-2' } } }, t0)
    expect(reads).toHaveLength(3)
  })

  it('keeps a "nothing to render" answer too (an empty doc is not re-read every tick)', async () => {
    const { client, reads } = docClient(() => ({ data: { ...ROW, content: '' }, error: null }))
    expect(await loadProductDocForTurn(client, { workspaceId: 'ws-1', settings }, 10)).toBeNull()
    expect(await loadProductDocForTurn(client, { workspaceId: 'ws-1', settings }, 20)).toBeNull()
    expect(reads).toHaveLength(1)
  })

  it('a failed read is null, logged once, and NOT kept (the next turn retries)', async () => {
    let fail = true
    const { client, reads } = docClient(() => (fail ? { data: null, error: { message: 'boom' } } : { data: ROW, error: null }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await loadProductDocForTurn(client, { workspaceId: 'ws-1', settings }, 10)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    fail = false
    expect((await loadProductDocForTurn(client, { workspaceId: 'ws-1', settings }, 20))?.text).toContain('Pro is $20.')
    expect(reads).toHaveLength(2)
    warn.mockRestore()
  })
})

describe('setWorkspaceProductDoc', () => {
  function wsClient(stored: unknown, updatedRows: unknown[] = [{ id: 'ws-1' }]) {
    const writes: unknown[] = []
    const client = {
      from: () => {
        const chain: Record<string, unknown> = {}
        chain.select = () => chain
        chain.eq = () => chain
        chain.maybeSingle = async () => ({ data: { settings: stored }, error: null })
        chain.update = (vals: { settings: unknown }) => {
          writes.push(vals.settings)
          return { eq: () => ({ select: async () => ({ data: updatedRows, error: null }) }) }
        }
        return chain
      },
    }
    return { client: client as unknown as SupabaseClient, writes }
  }

  it('sets only product_doc and keeps every sibling key', async () => {
    const { client, writes } = wsClient({ edition: 'sales', trust_policy: { x: 1 } })
    expect(await setWorkspaceProductDoc(client, 'ws-1', POINTER)).toEqual({ ok: true })
    expect(writes).toEqual([{ edition: 'sales', trust_policy: { x: 1 }, product_doc: POINTER }])
  })

  it('clears only product_doc', async () => {
    const { client, writes } = wsClient({ edition: 'sales', product_doc: POINTER })
    expect(await setWorkspaceProductDoc(client, 'ws-1', null)).toEqual({ ok: true })
    expect(writes).toEqual([{ edition: 'sales' }])
  })

  it('a 0-row update is an error, never a silent ok', async () => {
    const { client } = wsClient({}, [])
    expect(await setWorkspaceProductDoc(client, 'ws-1', POINTER)).toMatchObject({ ok: false })
  })
})
