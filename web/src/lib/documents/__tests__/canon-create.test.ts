/**
 * Creating a canon document from its template (D2): who may create which
 * (workspace canon: owners and admins; personal canon: any member), once per
 * key, the product doc pointer's document adopted with its text kept, and a
 * new product doc set as the pointer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  lookup: { ok: false, reason: 'not_found' } as Record<string, unknown>,
  settings: null as unknown,
  pointerSet: [] as unknown[],
}))
vi.mock('../canon-doc', () => ({ resolveCanonDocument: vi.fn(async () => state.lookup) }))
vi.mock('@/lib/workspace-settings', () => ({ fetchWorkspaceSettings: vi.fn(async () => state.settings) }))
vi.mock('@/lib/workspace/product-doc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace/product-doc')>()),
  setWorkspaceProductDoc: vi.fn(async (_s: unknown, _w: string, pointer: unknown) => {
    state.pointerSet.push(pointer)
    return { ok: true }
  }),
}))

import { createCanonDocument, missingTemplateSections } from '../canon-create'

function client(role: string | null) {
  const writes: Array<{ op: string; row: Record<string, unknown>; filters: unknown[] }> = []
  return {
    writes,
    from(table: string) {
      const filters: unknown[] = []
      const chain: Record<string, unknown> = {}
      let op = 'select'
      let row: Record<string, unknown> = {}
      for (const m of ['eq', 'is']) chain[m] = (...a: unknown[]) => (filters.push([m, ...a]), chain)
      chain.select = () => chain
      chain.insert = (r: Record<string, unknown>) => ((op = 'insert'), (row = r), chain)
      chain.update = (r: Record<string, unknown>) => ((op = 'update'), (row = r), chain)
      chain.maybeSingle = async () => ({ data: table === 'member' && role ? { id: 'm1', role } : null, error: null })
      chain.single = async () => {
        writes.push({ op, row, filters })
        return { data: { id: 'doc-new', title: row.title, canon_key: row.canon_key }, error: null }
      }
      chain.then = (resolve: (r: unknown) => unknown) => {
        writes.push({ op, row, filters })
        return Promise.resolve({ data: null, error: null }).then(resolve)
      }
      return chain
    },
  }
}

beforeEach(() => {
  state.lookup = { ok: false, reason: 'not_found' }
  state.settings = null
  state.pointerSet = []
})

describe('createCanonDocument', () => {
  it('a plain member cannot create workspace canon', async () => {
    const r = await createCanonDocument(client('member') as never, { workspaceId: 'w', userId: 'u', key: 'team-playbook' })
    expect(r).toMatchObject({ ok: false, status: 403 })
  })

  it('a plain member creates their own personal canon, with the template sections', async () => {
    const c = client('member')
    const r = await createCanonDocument(c as never, { workspaceId: 'w', userId: 'u', key: 'content-brief:x' })
    expect(r).toMatchObject({ ok: true, outcome: 'created' })
    const insert = c.writes.find((w) => w.op === 'insert')!
    expect(insert.row).toMatchObject({ canon_key: 'content-brief:x', created_by: 'm1', title: 'X: what I post about', visibility: 'workspace', published_status: 'published' })
    expect(insert.row.content).toBe('## Audience\n\n## Themes\n\n## Voice\n\n## Never post\n\n## Cadence\n')
  })

  it('a guest creates nothing', async () => {
    expect(await createCanonDocument(client('guest') as never, { workspaceId: 'w', userId: 'u', key: 'person:voice' })).toMatchObject({ ok: false, status: 403 })
  })

  it('a key that has its document returns it, creating nothing', async () => {
    state.lookup = { ok: true, viaPointer: false, memberId: 'm1', doc: { id: 'doc-1', title: 'Playbook', canon_key: 'team-playbook', content: '## How we work\n' } }
    const c = client('admin')
    const r = await createCanonDocument(c as never, { workspaceId: 'w', userId: 'u', key: 'team-playbook' })
    expect(r).toMatchObject({ ok: true, outcome: 'existing', document: { id: 'doc-1' } })
    expect((r as { missingSections: string[] }).missingSections).toContain('Repos and code')
    expect(c.writes).toHaveLength(0)
  })

  it('the product doc pointer’s document is adopted: keyed, text kept', async () => {
    state.lookup = { ok: true, viaPointer: true, memberId: 'm1', doc: { id: 'doc-p', title: 'Native Intelligence', canon_key: null, content: 'Native Intelligence is a workspace.' } }
    const c = client('owner')
    const r = await createCanonDocument(c as never, { workspaceId: 'w', userId: 'u', key: 'product' })
    expect(r).toMatchObject({ ok: true, outcome: 'adopted', document: { id: 'doc-p' } })
    const update = c.writes.find((w) => w.op === 'update')!
    expect(update.row).toEqual({ canon_key: 'product' })
    expect(update.filters).toContainEqual(['is', 'canon_key', null])
    expect((r as { missingSections: string[] }).missingSections).toHaveLength(6)
  })

  it('a new product doc becomes the workspace product doc', async () => {
    const r = await createCanonDocument(client('admin') as never, { workspaceId: 'w', userId: 'u', key: 'product' })
    expect(r).toMatchObject({ ok: true, outcome: 'created' })
    expect(state.pointerSet).toEqual([expect.objectContaining({ document_id: 'doc-new', set_by: 'm1' })])
  })
})

describe('missingTemplateSections', () => {
  it('lists the template headings a document lacks', () => {
    expect(missingTemplateSections('person:voice', '## How I write\nShort.')).toEqual(['Words I use', 'Words I avoid'])
    expect(missingTemplateSections('brand', 'anything')).toEqual([])
  })
})
