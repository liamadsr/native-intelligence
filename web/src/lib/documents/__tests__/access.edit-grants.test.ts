/**
 * The document EDIT rule with edit grants (migration 512, the app half in
 * src/lib/documents/access.ts). An edit grant lets a member (never a guest)
 * edit a document they otherwise couldn't, as its creator could, and nothing
 * else: no visibility, creator, archive, publish, slug, type, canon key or
 * project change; no delete. A document they can only VIEW through a grant
 * stays read-only. The loaders read edit grants only when asked.
 */
import { describe, expect, it } from 'vitest'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import {
  GRANT_EDIT_REFUSAL,
  canDeleteDocument,
  canEditDocument,
  canSetDocumentProject,
  documentUpdateRefusal,
  editsOnlyByGrant,
  loadDocumentAccess,
  type DocumentAccess,
  type DocumentAccessRow,
} from '../access'

const WS = 'ws-1'
const DOC = '11111111-1111-4111-8111-111111111111'
const CREATOR = 'mem-creator'

const row = (over: Partial<DocumentAccessRow> = {}): DocumentAccessRow => ({
  id: DOC,
  workspace_id: WS,
  created_by: CREATOR,
  type: 'note',
  slug: null,
  published_status: 'draft',
  frontmatter: {},
  project_id: null,
  status: 'active',
  canon_key: null,
  visibility: 'private',
  ...over,
})

const as = (role: string, memberId: string, editGrant: boolean, over: Partial<DocumentAccessRow> = {}, isProductDoc = false): DocumentAccess => ({
  role,
  memberId,
  row: row(over),
  isProductDoc,
  editGrant,
})

describe('canEditDocument with an edit grant', () => {
  it('a member edits a private document shared with them to edit; not with a view grant (no editGrant)', () => {
    expect(canEditDocument(as('member', 'mem-ben', true))).toBe(true)
    expect(canEditDocument(as('member', 'mem-ben', false))).toBe(false)
    expect(editsOnlyByGrant(as('member', 'mem-ben', true))).toBe(true)
  })

  it('a workspace note a plain member could only read becomes editable', () => {
    expect(canEditDocument(as('member', 'mem-ben', false, { visibility: 'workspace' }))).toBe(false)
    expect(canEditDocument(as('member', 'mem-ben', true, { visibility: 'workspace' }))).toBe(true)
  })

  it('never a guest, the product doc or a spec page', () => {
    expect(canEditDocument(as('guest', 'mem-gus', true))).toBe(false)
    expect(canEditDocument(as('member', 'mem-ben', true, {}, true))).toBe(false)
    expect(canEditDocument(as('member', 'mem-ben', true, { type: 'spec' }))).toBe(false)
  })

  it('the creator is not "only by grant"', () => {
    expect(editsOnlyByGrant(as('member', CREATOR, true))).toBe(false)
  })
})

describe('what an edit grant never does', () => {
  it('delete, not even for an admin who sees it only through the grant', () => {
    expect(canDeleteDocument(as('member', 'mem-ben', true))).toBe(false)
    expect(canDeleteDocument(as('admin', 'mem-dee', true))).toBe(false)
    // The control: the creator still deletes their own.
    expect(canDeleteDocument(as('member', CREATOR, false))).toBe(true)
  })

  it('move it into a project', () => {
    expect(canSetDocumentProject(as('admin', 'mem-dee', true))).toBe(false)
  })

  it('change what it is or who has it; its text and title go through', () => {
    const a = as('admin', 'mem-dee', true)
    expect(documentUpdateRefusal(a, { title: 'Q3 pricing, revised', content: 'new body', tags: ['pricing'] })).toBeNull()
    for (const patch of [
      { visibility: 'workspace' },
      { created_by: 'mem-dee' },
      { status: 'archived' },
      { published_status: 'published' },
      { slug: 'q3' },
      { type: 'analysis' },
      { canon_key: 'pricing' },
      { project_id: 'proj-1' },
    ]) {
      expect(documentUpdateRefusal(a, patch), JSON.stringify(patch)).toBe(GRANT_EDIT_REFUSAL)
    }
  })

  it('a view grant (no editGrant) is refused any change', () => {
    expect(documentUpdateRefusal(as('member', 'mem-ben', false), { title: 'x' })).not.toBeNull()
  })
})

describe('loadDocumentAccess and edit grants', () => {
  function db(level: 'view' | 'edit' | null, role = 'member') {
    const fake = makeFakeSupabase()
    fake.seed('member', [{ id: 'mem-ben', user_id: 'user-ben', workspace_id: WS, role, display_name: 'Ben Ortiz' }])
    fake.seed('document', [row()])
    if (level) {
      fake.seed('entity_access', [
        { id: 'g-1', workspace_id: WS, entity_type: 'document', entity_id: DOC, grantee_kind: 'member', grantee_member_id: 'mem-ben', grantee_team_id: null, grantee_channel_id: null, level },
      ])
    }
    return fake as never
  }

  it('without being asked it reads no grant: a private document is not there', async () => {
    const { access } = await loadDocumentAccess(db('edit'), WS, 'user-ben', DOC)
    expect(access).toBeNull()
  })

  it('asked, an edit grant opens it to edit', async () => {
    const { access } = await loadDocumentAccess(db('edit'), WS, 'user-ben', DOC, { editGrants: true })
    expect(access?.editGrant).toBe(true)
    expect(canEditDocument(access!)).toBe(true)
  })

  it('a view grant, or a guest with an edit grant, still finds nothing to edit', async () => {
    expect((await loadDocumentAccess(db('view'), WS, 'user-ben', DOC, { editGrants: true })).access).toBeNull()
    expect((await loadDocumentAccess(db('edit', 'guest'), WS, 'user-ben', DOC, { editGrants: true })).access).toBeNull()
  })
})
