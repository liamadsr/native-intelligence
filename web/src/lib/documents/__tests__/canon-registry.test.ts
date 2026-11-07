/**
 * The canon registry for one reader (D1): workspace canon for everyone, a
 * person's own personal canon for them only, nothing they can't see, the
 * product doc pointer as `product` while it has no key, kept 30 s per reader,
 * and never a failed spec (a failed read is an empty registry).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { canonEntriesFor, canonRegistrySection, clearCanonRegistryCache, loadCanonRegistry } from '../canon-registry'

const WS = '11111111-1111-1111-1111-111111111111'
const ME = 'user-me'
const OTHER = 'user-other'

function row(key: string, owner: string, extra: Record<string, unknown> = {}) {
  return { id: `doc-${key}-${owner}`, title: key, canon_key: key, updated_at: '2026-10-19T10:00:00Z', visibility: 'workspace', owner: { user_id: owner }, ...extra }
}

/** A client whose document reads answer from `rows` (canon) and `byId` (the pointer read). */
function client(rows: unknown[], opts: { settings?: unknown; byId?: unknown; fail?: boolean } = {}) {
  const calls: string[] = []
  return {
    calls,
    from(table: string) {
      calls.push(table)
      const result =
        table === 'workspace'
          ? { data: { settings: opts.settings ?? null }, error: null }
          : opts.fail
            ? { data: null, error: { message: 'boom' } }
            : { data: rows, error: null }
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'not', 'neq', 'order', 'limit', 'or', 'like']) chain[m] = () => chain
      chain.maybeSingle = async () => (table === 'workspace' ? result : { data: opts.byId ?? null, error: null })
      chain.then = (resolve: (r: unknown) => unknown) => Promise.resolve(result).then(resolve)
      return chain
    },
  }
}

beforeEach(() => clearCanonRegistryCache())

describe('canonEntriesFor', () => {
  it('lists workspace canon for everyone and personal canon only for its owner', () => {
    const rows = [row('product', OTHER), row('content-brief:x', ME), row('content-brief:x', OTHER), row('person:voice', OTHER)]
    const mine = canonEntriesFor(rows, ME)
    expect(mine.map((e) => [e.key, e.owner])).toEqual([
      ['content-brief:x', 'you'],
      ['product', 'admins'],
    ])
    expect(canonEntriesFor(rows, null).map((e) => e.key)).toEqual(['product'])
  })

  it('never lists a document the reader cannot see', () => {
    const rows = [row('product', OTHER, { visibility: 'private' }), row('team-playbook', ME, { visibility: 'private' })]
    expect(canonEntriesFor(rows, ME).map((e) => e.key)).toEqual(['team-playbook'])
  })
})

describe('loadCanonRegistry', () => {
  it('a workspace with no canon has no section (hide empty)', async () => {
    const c = client([])
    expect(await canonRegistrySection(c as never, { workspaceId: WS, userId: ME, settings: null })).toBe('')
  })

  it('the product doc pointer counts as `product` while it has no key', async () => {
    const c = client([row('team-playbook', OTHER)], {
      settings: { product_doc: { document_id: 'doc-p' } },
      byId: { id: 'doc-p', title: 'Dial8', updated_at: '2026-10-02T00:00:00Z', status: 'active', published_status: 'published', type: 'note', frontmatter: {}, visibility: 'workspace' },
    })
    const entries = await loadCanonRegistry(c as never, { workspaceId: WS, userId: ME })
    expect(entries.map((e) => [e.key, e.title])).toEqual([
      ['product', 'Dial8'],
      ['team-playbook', 'team-playbook'],
    ])
  })

  it('a pointer at an ineligible document (archived) is not listed', async () => {
    const c = client([], {
      settings: { product_doc: { document_id: 'doc-p' } },
      byId: { id: 'doc-p', title: 'Old', status: 'archived', published_status: 'published', type: 'note', frontmatter: {}, visibility: 'workspace' },
    })
    expect(await loadCanonRegistry(c as never, { workspaceId: WS, userId: ME })).toEqual([])
  })

  it('is kept per reader: a second build within the TTL reads nothing', async () => {
    const c = client([row('product', OTHER)])
    await loadCanonRegistry(c as never, { workspaceId: WS, userId: ME, settings: null }, 1_000)
    const reads = c.calls.length
    await loadCanonRegistry(c as never, { workspaceId: WS, userId: ME, settings: null }, 20_000)
    expect(c.calls.length).toBe(reads)
    await loadCanonRegistry(c as never, { workspaceId: WS, userId: ME, settings: null }, 40_000)
    expect(c.calls.length).toBeGreaterThan(reads)
  })

  it('a failed read is an empty registry, never a throw', async () => {
    const c = client([], { fail: true })
    await expect(canonRegistrySection(c as never, { workspaceId: WS, userId: ME, settings: null })).resolves.toBe('')
  })

  it('reads workspace canon and the reader’s own personal canon apart, each capped on its own (S1)', async () => {
    const queries: Array<{ filters: unknown[][] }> = []
    const c = {
      from() {
        const q = { filters: [] as unknown[][] }
        queries.push(q)
        const chain: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'not', 'neq', 'order', 'limit', 'or', 'like']) chain[m] = (...a: unknown[]) => (q.filters.push([m, ...a]), chain)
        chain.then = (resolve: (r: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve)
        return chain
      },
    }
    await loadCanonRegistry(c as never, { workspaceId: WS, userId: ME, settings: null })
    const [shared, mine] = queries
    expect(shared.filters).toEqual(expect.arrayContaining([['not', 'canon_key', 'like', 'person:%'], ['not', 'canon_key', 'like', 'content-brief:%'], ['limit', 40]]))
    expect(mine.filters).toEqual(expect.arrayContaining([['eq', 'owner.user_id', ME], ['or', 'canon_key.like.person:*,canon_key.like.content-brief:*'], ['limit', 40]]))
  })

  it('the section starts with a blank line, so it appends after skills', async () => {
    const c = client([row('product', OTHER)])
    const section = await canonRegistrySection(c as never, { workspaceId: WS, userId: ME, settings: null })
    expect(section.startsWith('\n\n## Canon documents\n')).toBe(true)
  })
})
