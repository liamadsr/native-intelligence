/**
 * Who may change a document (src/lib/documents/access.ts), the app mirror of
 * migration 359. A truth table over the people (owner, admin, creator member,
 * other member, guest, outsider) and the kinds of document (a plain note, the
 * product doc, a meeting prep, a spec page, a shared wiki page, a project
 * doc, an unpublished draft), plus the update guard and the loader.
 */
import { describe, expect, it } from 'vitest'
import { createFakeSupabase, type FakeQuery, type FakeResult } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'
import {
  canDeleteDocument,
  canEditDocument,
  canSetDocumentProject,
  documentUpdateRefusal,
  hasMeetingPrepStamp,
  isSharedPage,
  loadDocumentAccess,
  loadDocumentsAccess,
  EDIT_REFUSAL,
  PRODUCT_DOC_EDIT_REFUSAL,
  type DocumentAccess,
  type DocumentAccessRow,
  isSystemDocument,
  systemDocumentDeleteRefusal,
  SYSTEM_DOCUMENT_REFUSAL,
} from '../access'

const WS = 'ws-1'
const DOC = '11111111-1111-4111-8111-111111111111'
const CREATOR = 'mem-creator'
const OTHER = 'mem-other'
const PREP = { startIso: '2026-10-18T15:00:00.000Z', meetingKey: 'a'.repeat(40), userId: 'user-c' }

const base: DocumentAccessRow = {
  id: DOC,
  workspace_id: WS,
  created_by: CREATOR,
  type: 'note',
  slug: null,
  published_status: 'published',
  frontmatter: {},
  project_id: null,
  status: 'active',
}

const KINDS: Record<string, { row: Partial<DocumentAccessRow>; productDoc?: boolean }> = {
  note: { row: {} },
  productDoc: { row: { slug: 'product' }, productDoc: true },
  prep: { row: { slug: 'prep', frontmatter: { meeting_prep: PREP } } },
  spec: { row: { type: 'spec', slug: 'api-ref' } },
  sharedPage: { row: { slug: 'onboarding' } },
  sharedTyped: { row: { type: 'analysis' } },
  projectDoc: { row: { slug: 'plan', project_id: 'proj-1' } },
  draft: { row: { slug: 'wip', published_status: 'draft' } },
  // A system document by its canon key (migration 366): edited by the usual rule, never deleted.
  canon: { row: { slug: 'brand', canon_key: 'brand' } },
}

const PEOPLE: Record<string, { role: string | null; memberId: string | null }> = {
  owner: { role: 'owner', memberId: 'mem-owner' },
  admin: { role: 'admin', memberId: 'mem-admin' },
  creator: { role: 'member', memberId: CREATOR },
  other: { role: 'member', memberId: OTHER },
  guest: { role: 'guest', memberId: 'mem-guest' },
  guestCreator: { role: 'guest', memberId: CREATOR },
  outsider: { role: null, memberId: null },
}

function access(person: string, kind: string): DocumentAccess {
  const k = KINDS[kind]
  return { ...PEOPLE[person], row: { ...base, ...k.row }, isProductDoc: k.productDoc === true }
}

// [person][kind] → [canEdit, canDelete]. The product doc and a canon doc are
// system documents (migration 366): nobody deletes or archives one.
const TABLE: Record<string, Record<string, [boolean, boolean]>> = {
  owner: { note: [true, true], productDoc: [true, false], prep: [true, true], spec: [true, true], sharedPage: [true, true], sharedTyped: [true, true], projectDoc: [true, true], draft: [true, true], canon: [true, false] },
  admin: { note: [true, true], productDoc: [true, false], prep: [true, true], spec: [true, true], sharedPage: [true, true], sharedTyped: [true, true], projectDoc: [true, true], draft: [true, true], canon: [true, false] },
  creator: { note: [true, true], productDoc: [false, false], prep: [true, true], spec: [false, true], sharedPage: [true, true], sharedTyped: [true, true], projectDoc: [true, true], draft: [true, true], canon: [true, false] },
  other: { note: [false, false], productDoc: [false, false], prep: [false, false], spec: [false, false], sharedPage: [true, false], sharedTyped: [true, false], projectDoc: [false, false], draft: [false, false], canon: [true, false] },
  guest: { note: [false, false], productDoc: [false, false], prep: [false, false], spec: [false, false], sharedPage: [false, false], sharedTyped: [false, false], projectDoc: [false, false], draft: [false, false], canon: [false, false] },
  guestCreator: { note: [false, true], productDoc: [false, false], prep: [false, true], spec: [false, true], sharedPage: [false, true], sharedTyped: [false, true], projectDoc: [false, true], draft: [false, true], canon: [false, false] },
  outsider: { note: [false, false], productDoc: [false, false], prep: [false, false], spec: [false, false], sharedPage: [false, false], sharedTyped: [false, false], projectDoc: [false, false], draft: [false, false], canon: [false, false] },
}

describe('the truth table', () => {
  for (const [person, row] of Object.entries(TABLE)) {
    for (const [kind, [edit, del]] of Object.entries(row)) {
      it(`${person} on ${kind}: edit ${edit}, delete ${del}`, () => {
        expect(canEditDocument(access(person, kind))).toBe(edit)
        expect(canDeleteDocument(access(person, kind))).toBe(del)
      })
    }
  }
})

describe('who may move it between projects', () => {
  it('owner/admin or the creator, with edit access; not a member editing a shared page', () => {
    expect(canSetDocumentProject(access('owner', 'sharedPage'))).toBe(true)
    expect(canSetDocumentProject(access('admin', 'note'))).toBe(true)
    expect(canSetDocumentProject(access('creator', 'note'))).toBe(true)
    expect(canSetDocumentProject(access('creator', 'projectDoc'))).toBe(true)
    expect(canSetDocumentProject(access('other', 'sharedPage'))).toBe(false)
    expect(canSetDocumentProject(access('creator', 'productDoc'))).toBe(false)
    expect(canSetDocumentProject(access('guestCreator', 'note'))).toBe(false)
    expect(canSetDocumentProject(access('outsider', 'note'))).toBe(false)
  })
})

describe('a shared wiki page', () => {
  it('is published, not a spec, unstamped, not in a project, with a slug or a non-note type', () => {
    expect(isSharedPage({ ...base, slug: 'x' })).toBe(true)
    expect(isSharedPage({ ...base, type: 'entity' })).toBe(true)
    expect(isSharedPage({ ...base })).toBe(false) // a plain note: no slug
    expect(isSharedPage({ ...base, slug: 'x', published_status: 'draft' })).toBe(false)
    expect(isSharedPage({ ...base, slug: 'x', type: 'spec' })).toBe(false)
    expect(isSharedPage({ ...base, slug: 'x', project_id: 'p' })).toBe(false)
    expect(isSharedPage({ ...base, slug: 'x', frontmatter: { meeting_prep: null } })).toBe(false)
  })

  it('reads the stamp as the SQL ? operator does', () => {
    expect(hasMeetingPrepStamp({ meeting_prep: PREP })).toBe(true)
    expect(hasMeetingPrepStamp({ meeting_prep: null })).toBe(true)
    expect(hasMeetingPrepStamp({ other: 1 })).toBe(false)
    expect(hasMeetingPrepStamp(['meeting_prep'])).toBe(true)
    expect(hasMeetingPrepStamp(null)).toBe(false)
  })
})

describe('the update guard', () => {
  it('refuses with the product-doc line for a creator, the generic line for others', () => {
    expect(documentUpdateRefusal(access('creator', 'productDoc'), { content: 'x' })).toBe(PRODUCT_DOC_EDIT_REFUSAL)
    expect(documentUpdateRefusal(access('other', 'note'), { content: 'x' })).toBe(EDIT_REFUSAL)
    expect(documentUpdateRefusal(access('creator', 'note'), { content: 'x' })).toBeNull()
  })

  it('a member on a shared page edits the body but cannot archive, unpublish, re-slug or retype it', () => {
    const a = access('other', 'sharedPage')
    expect(documentUpdateRefusal(a, { content: 'x', title: 't', tags: ['a'] })).toBeNull()
    expect(documentUpdateRefusal(a, { status: 'archived' })).toBe(EDIT_REFUSAL)
    expect(documentUpdateRefusal(a, { published_status: 'draft' })).toBe(EDIT_REFUSAL)
    expect(documentUpdateRefusal(a, { slug: 'mine' })).toBe(EDIT_REFUSAL)
    expect(documentUpdateRefusal(a, { type: 'analysis' })).toBe(EDIT_REFUSAL)
    // Setting a field to what it already is changes nothing.
    expect(documentUpdateRefusal(a, { status: 'active', slug: 'onboarding' })).toBeNull()
  })

  it('the row as it would be must still be editable (WITH CHECK)', () => {
    // Moving a shared page into a project makes it the creator's alone.
    expect(documentUpdateRefusal(access('other', 'sharedPage'), { project_id: 'proj-2' })).toBe(EDIT_REFUSAL)
    // A creator can't turn their page into a spec page.
    expect(documentUpdateRefusal(access('creator', 'note'), { type: 'spec' })).toBe(EDIT_REFUSAL)
    expect(documentUpdateRefusal(access('admin', 'note'), { type: 'spec' })).toBeNull()
  })

  it('created_by changes for an owner or admin only; the workspace and the stamp never', () => {
    expect(documentUpdateRefusal(access('creator', 'note'), { created_by: OTHER })).toMatch(/owner or admin/)
    expect(documentUpdateRefusal(access('admin', 'note'), { created_by: OTHER })).toBeNull()
    expect(documentUpdateRefusal(access('owner', 'note'), { workspace_id: 'ws-2' })).toMatch(/moving/)
    expect(documentUpdateRefusal(access('owner', 'prep'), { frontmatter: { area: 'x' } })).toMatch(/server only/)
    expect(documentUpdateRefusal(access('owner', 'prep'), { frontmatter: { area: 'x', meeting_prep: { ...PREP } } })).toBeNull()
    expect(documentUpdateRefusal(access('creator', 'note'), { frontmatter: { meeting_prep: PREP } })).toMatch(/server only/)
  })
})

describe('loadDocumentAccess', () => {
  function db(member: unknown, doc: unknown) {
    return createFakeSupabase((q: FakeQuery): FakeResult => {
      if (q.table === 'member') return { data: member, error: null }
      if (q.table === 'document') return { data: doc, error: null }
      return { data: null, error: null }
    })
  }

  it('reads the role, the member row, the rule columns and the product-doc pointer, fenced by workspace and user', async () => {
    const fake = db(
      { id: CREATOR, role: 'member', workspace: { settings: { product_doc: { document_id: DOC } } } },
      { ...base, slug: 'product' },
    )
    const { access: a, error } = await loadDocumentAccess(fake.client, WS, 'user-c', DOC)
    expect(error).toBeNull()
    expect(a).toMatchObject({ role: 'member', memberId: CREATOR, isProductDoc: true, row: { id: DOC, created_by: CREATOR } })
    const memberQ = fake.log.find((q) => q.table === 'member')!
    expect(memberQ.filters).toEqual(expect.arrayContaining([['eq', 'workspace_id', WS], ['eq', 'user_id', 'user-c']]))
    const docQ = fake.log.find((q) => q.table === 'document')!
    expect(docQ.filters).toEqual(expect.arrayContaining([['eq', 'id', DOC], ['eq', 'workspace_id', WS]]))
  })

  it('a document elsewhere is null; a non-member gets no role', async () => {
    expect((await loadDocumentAccess(db({ id: 'm', role: 'owner', workspace: null }, null).client, WS, 'u', DOC)).access).toBeNull()
    const { access: a } = await loadDocumentAccess(db(null, base).client, WS, 'u', DOC)
    expect(a).toMatchObject({ role: null, memberId: null, isProductDoc: false })
    expect(canEditDocument(a!)).toBe(false)
  })
})

describe('loadDocumentsAccess', () => {
  it('reads the member row once and the documents over id in (...), fenced by workspace; missing ids are absent', async () => {
    const other = { ...base, id: 'doc-2', created_by: OTHER }
    const fake = createFakeSupabase((q: FakeQuery): FakeResult => {
      if (q.table === 'member') return { data: { id: CREATOR, role: 'member', workspace: { settings: { product_doc: { document_id: 'doc-2' } } } }, error: null }
      if (q.table === 'document') return { data: [base, other], error: null }
      return { data: null, error: null }
    })
    const { access: map, error } = await loadDocumentsAccess(fake.client, WS, 'user-c', [DOC, 'doc-2', 'doc-gone'])
    expect(error).toBeNull()
    expect([...map.keys()]).toEqual([DOC, 'doc-2'])
    expect(map.get(DOC)).toMatchObject({ role: 'member', memberId: CREATOR, isProductDoc: false })
    expect(map.get('doc-2')).toMatchObject({ isProductDoc: true, row: { created_by: OTHER } })
    expect(canDeleteDocument(map.get(DOC)!)).toBe(true)
    expect(canDeleteDocument(map.get('doc-2')!)).toBe(false)
    expect(fake.log.filter((q) => q.table === 'member')).toHaveLength(1)
    const docQ = fake.log.find((q) => q.table === 'document')!
    expect(docQ.filters).toEqual(expect.arrayContaining([['in', 'id', [DOC, 'doc-2', 'doc-gone']], ['eq', 'workspace_id', WS]]))
  })

  it('no ids reads nothing', async () => {
    const fake = createFakeSupabase(() => ({ data: null, error: null }))
    const { access: map } = await loadDocumentsAccess(fake.client, WS, 'u', [])
    expect(map.size).toBe(0)
    expect(fake.log).toHaveLength(0)
  })
})

describe('system documents (migration 366)', () => {
  it('a canon doc or the product doc is a system document; nobody deletes it, and archiving says why', () => {
    expect(isSystemDocument(access('owner', 'canon'))).toBe(true)
    expect(isSystemDocument(access('owner', 'productDoc'))).toBe(true)
    expect(isSystemDocument(access('owner', 'note'))).toBe(false)
    expect(systemDocumentDeleteRefusal(access('owner', 'canon'))).toBe(SYSTEM_DOCUMENT_REFUSAL)
    expect(SYSTEM_DOCUMENT_REFUSAL).toBe('This is a system document. It can be edited, not deleted.')
    expect(documentUpdateRefusal(access('owner', 'canon'), { status: 'archived' })).toBe(SYSTEM_DOCUMENT_REFUSAL)
    expect(documentUpdateRefusal(access('admin', 'productDoc'), { status: 'archived' })).toBe(SYSTEM_DOCUMENT_REFUSAL)
    // Edited as ever.
    expect(documentUpdateRefusal(access('owner', 'canon'), { content: 'x' })).toBeNull()
  })

  it('only an owner or admin sets or clears a canon key', () => {
    expect(documentUpdateRefusal(access('creator', 'note'), { canon_key: 'brand' })).toMatch(/owner or admin/)
    expect(documentUpdateRefusal(access('admin', 'note'), { canon_key: 'brand' })).toBeNull()
    expect(documentUpdateRefusal(access('creator', 'canon'), { canon_key: null })).toMatch(/owner or admin/)
  })
})
