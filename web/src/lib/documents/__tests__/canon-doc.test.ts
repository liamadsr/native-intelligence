/**
 * resolveCanonDocument (canon D1/D2): `product` is the product doc pointer's
 * document first; a personal key is fenced on the caller's own member row;
 * every read is fenced on the workspace; a non-member resolves nothing.
 */
import { describe, expect, it } from 'vitest'
import { resolveCanonDocument } from '../canon-doc'

type Filter = [string, string, unknown]

function client(opts: { member?: string | null; settings?: unknown; pointerDoc?: unknown; keyed?: unknown }) {
  const queries: Array<{ table: string; filters: Filter[] }> = []
  return {
    queries,
    from(table: string) {
      const q = { table, filters: [] as Filter[] }
      queries.push(q)
      const chain: Record<string, unknown> = {}
      for (const op of ['eq', 'neq']) chain[op] = (col: string, v: unknown) => (q.filters.push([op, col, v]), chain)
      chain.select = () => chain
      chain.limit = () => chain
      chain.maybeSingle = async () => {
        if (table === 'member') return { data: opts.member ? { id: opts.member } : null, error: null }
        if (table === 'workspace') return { data: { settings: opts.settings ?? null }, error: null }
        const byId = q.filters.some(([, col]) => col === 'id')
        return { data: byId ? (opts.pointerDoc ?? null) : (opts.keyed ?? null), error: null }
      }
      return chain
    },
  }
}

const eligible = { id: 'doc-p', workspace_id: 'w', status: 'active', published_status: 'published', type: 'note', frontmatter: {}, visibility: 'workspace', content: 'facts' }

describe('resolveCanonDocument', () => {
  it('product: the pointer document first', async () => {
    const c = client({ member: 'm1', settings: { product_doc: { document_id: 'doc-p' } }, pointerDoc: eligible })
    const r = await resolveCanonDocument(c as never, { workspaceId: 'w', userId: 'u', key: 'product' })
    expect(r).toMatchObject({ ok: true, viaPointer: true, doc: { id: 'doc-p' } })
    const docRead = c.queries.find((q) => q.table === 'document')!
    expect(docRead.filters).toContainEqual(['eq', 'workspace_id', 'w'])
  })

  it('product: the keyed document when the pointer is unset', async () => {
    const c = client({ member: 'm1', settings: {}, keyed: { ...eligible, id: 'doc-k', canon_key: 'product' } })
    const r = await resolveCanonDocument(c as never, { workspaceId: 'w', userId: 'u', key: 'product' })
    expect(r).toMatchObject({ ok: true, viaPointer: false, doc: { id: 'doc-k' } })
  })

  it('a personal key is fenced on the caller', async () => {
    const c = client({ member: 'm1', keyed: { ...eligible, id: 'doc-b', canon_key: 'content-brief:x', created_by: 'm1' } })
    const r = await resolveCanonDocument(c as never, { workspaceId: 'w', userId: 'u', key: 'content-brief:x' })
    expect(r.ok).toBe(true)
    const docRead = c.queries.find((q) => q.table === 'document')!
    expect(docRead.filters).toEqual(
      expect.arrayContaining([
        ['eq', 'workspace_id', 'w'],
        ['eq', 'canon_key', 'content-brief:x'],
        ['eq', 'created_by', 'm1'],
        ['neq', 'status', 'archived'],
      ]),
    )
  })

  it('a workspace key is not fenced on the caller', async () => {
    const c = client({ member: 'm1', keyed: { ...eligible, id: 'doc-t', canon_key: 'team-playbook', created_by: 'm9' } })
    await resolveCanonDocument(c as never, { workspaceId: 'w', userId: 'u', key: 'team-playbook' })
    const docRead = c.queries.find((q) => q.table === 'document')!
    expect(docRead.filters.some(([, col]) => col === 'created_by')).toBe(false)
  })

  it('a non-member resolves nothing, and never reads a document', async () => {
    const c = client({ member: null })
    expect(await resolveCanonDocument(c as never, { workspaceId: 'w', userId: 'u', key: 'team-playbook' })).toEqual({ ok: false, reason: 'not_member' })
    expect(c.queries.some((q) => q.table === 'document')).toBe(false)
  })

  it('a private document someone else made does not exist', async () => {
    const c = client({ member: 'm1', keyed: { ...eligible, canon_key: 'team-playbook', visibility: 'private', created_by: 'm9' } })
    expect(await resolveCanonDocument(c as never, { workspaceId: 'w', userId: 'u', key: 'team-playbook' })).toEqual({ ok: false, reason: 'not_found' })
  })
})
