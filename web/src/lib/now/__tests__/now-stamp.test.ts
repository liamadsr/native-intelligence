/**
 * The Now file's stamp on the app side (migration 440 guards it in the
 * database): isNowDocument reads it as `frontmatter ? 'now'` does; every
 * outside frontmatter write keeps the stored stamp and drops an incoming one
 * (withServerFrontmatter, as for meeting_prep); and the update rule refuses a
 * stamp change, a flip to workspace and a canon key, as the guard does.
 */
import { describe, expect, it } from 'vitest'
import { withServerFrontmatter } from '@/lib/agent-events/prep-ref'
import { documentUpdateRefusal, type DocumentAccess } from '@/lib/documents/access'
import { NOW_PRIVATE_REFUSAL, isNowDocument } from '../now-stamp'

const STAMP = { tracks: [{ kind: 'work', id: 'job-1', hash: 'a'.repeat(16), added_at: 't' }] }

const access = (frontmatter: unknown, extra: Partial<DocumentAccess['row']> = {}): DocumentAccess => ({
  role: 'member',
  memberId: 'mem-1',
  isProductDoc: false,
  row: {
    id: 'doc-1',
    workspace_id: 'ws-1',
    created_by: 'mem-1',
    type: 'note',
    slug: null,
    published_status: 'published',
    frontmatter,
    project_id: null,
    status: 'active',
    canon_key: null,
    visibility: 'private',
    ...extra,
  },
})

describe('isNowDocument', () => {
  it('reads the key as the SQL does', () => {
    expect(isNowDocument({ now: STAMP })).toBe(true)
    expect(isNowDocument({ now: null })).toBe(true)
    expect(isNowDocument(['now'])).toBe(true)
    expect(isNowDocument('now')).toBe(true)
    for (const v of [{}, { meeting_prep: {} }, null, undefined, 'x', ['x']]) expect(isNowDocument(v), JSON.stringify(v)).toBe(false)
  })
})

describe('withServerFrontmatter keeps the Now stamp the server wrote', () => {
  it('drops an incoming stamp and keeps the stored one, beside a meeting prep’s', () => {
    expect(withServerFrontmatter({ a: 1, now: { tracks: [] } })).toEqual({ a: 1 })
    expect(withServerFrontmatter({ a: 1, now: { tracks: [] } }, { now: STAMP })).toEqual({ a: 1, now: STAMP })
    expect(withServerFrontmatter({}, { now: STAMP, meeting_prep: { x: 1 } })).toEqual({ now: STAMP, meeting_prep: { x: 1 } })
  })
})

describe('documentUpdateRefusal on the Now file', () => {
  it('lets its creator edit its text and keep its stamp', () => {
    expect(documentUpdateRefusal(access({ now: STAMP }), { content: '## Focus', frontmatter: { now: STAMP } })).toBeNull()
  })

  it('refuses a change to the stamp, from anyone outside the server', () => {
    expect(documentUpdateRefusal(access({ now: STAMP }), { frontmatter: { now: { tracks: [] } } })).toMatch(/Now file stamp/)
    expect(documentUpdateRefusal(access({ now: STAMP }), { frontmatter: {} })).toMatch(/Now file stamp/)
    expect(documentUpdateRefusal(access({}), { frontmatter: { now: STAMP } })).toMatch(/Now file stamp/)
  })

  it('refuses sharing it with the workspace or making it canon', () => {
    expect(documentUpdateRefusal(access({ now: STAMP }), { visibility: 'workspace' })).toBe(NOW_PRIVATE_REFUSAL)
    expect(documentUpdateRefusal({ ...access({ now: STAMP }), role: 'owner' }, { canon_key: 'person:voice' })).toBe(NOW_PRIVATE_REFUSAL)
    expect(documentUpdateRefusal(access({ now: STAMP }), { visibility: 'private' })).toBeNull()
  })
})
