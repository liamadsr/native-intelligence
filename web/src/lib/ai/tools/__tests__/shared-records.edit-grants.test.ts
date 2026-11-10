/**
 * Edit-level grants and the agent's WRITE tools (FU-E, migration 512). A
 * grant is now view or edit. The agent's tools write on a service-role
 * client, where no policy applies, so each write gate restates the rule:
 * its own rule, or an EDIT grant that reaches the person. For every write
 * path that takes a grant, both directions:
 *   - a VIEW grant is still refused (494's rule, kept);
 *   - an EDIT grant lets the same change land, as the owner's would;
 * and what an edit grant never does: archive or delete the record, change
 * who sees it, or work for a guest or an unattended run.
 */
import { describe, expect, it } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { createDocumentTools } from '../documents'
import { createCaptureTools } from '../captures'
import { createCommentTools } from '../comments'
import { createDecisionTools } from '../decisions'

const WS = 'ws-1'
const ME = 'user-me'
const MY_MEMBER = 'm-me'
const ZOE_USER = 'user-zoe'
const ZOE = 'm-zoe'
const OPTS = { toolCallId: 't', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

const DOC_VIEW = '00000000-0000-4000-8000-0000000000e1'
const DOC_EDIT = '00000000-0000-4000-8000-0000000000e2'
const DOC_NONE = '00000000-0000-4000-8000-0000000000e3'
const CAP_VIEW = '00000000-0000-4000-8000-0000000000f1'
const CAP_EDIT = '00000000-0000-4000-8000-0000000000f2'

const doc = (id: string) => ({
  id,
  workspace_id: WS,
  title: `Title ${id.slice(-2)}`,
  content: `body of ${id}`,
  kind: 'doc',
  type: 'note',
  status: 'active',
  slug: null,
  published_status: 'draft',
  frontmatter: {},
  project_id: null,
  canon_key: null,
  tags: [],
  revision: 1,
  is_pinned: false,
  custom_fields: {},
  visibility: 'private',
  created_by: ZOE,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
})

const capture = (id: string) => ({
  id,
  workspace_id: WS,
  project_id: null,
  title: `Meeting ${id.slice(-2)}`,
  content: 'notes',
  summary: null,
  ai_summary: `summary of ${id}`,
  ai_processed: true,
  transcript: 'line one',
  tags: [],
  is_pinned: false,
  is_eval: false,
  status: 'complete',
  visibility: 'private',
  user_id: ZOE_USER,
  created_at: '2026-10-02T10:00:00Z',
})

const grant = (type: 'document' | 'capture', id: string, level: 'view' | 'edit') => ({
  id: `g-${id}`,
  workspace_id: WS,
  entity_type: type,
  entity_id: id,
  grantee_kind: 'member',
  grantee_member_id: MY_MEMBER,
  grantee_team_id: null,
  grantee_channel_id: null,
  level,
  created_at: '2026-10-03T00:00:00Z',
})

function world(opts: { myRole?: string } = {}) {
  const db = makeFakeSupabase({
    rpc: {
      entity_grant_ids_for: (args) => {
        const ids = db
          .rows('entity_access')
          .filter((g) => g.workspace_id === args.p_workspace && g.entity_type === args.p_type && g.grantee_member_id === MY_MEMBER)
          .map((g) => g.entity_id)
        return { data: args.p_user === ME ? ids : [], error: null }
      },
    },
  })
  db.seed('member', [
    { id: MY_MEMBER, user_id: ME, workspace_id: WS, role: opts.myRole ?? 'member', display_name: 'Avery Fernhill' },
    { id: ZOE, user_id: ZOE_USER, workspace_id: WS, role: 'member', display_name: 'Zoe Quill' },
  ])
  db.seed('document', [doc(DOC_VIEW), doc(DOC_EDIT), doc(DOC_NONE)])
  db.seed('captures', [capture(CAP_VIEW), capture(CAP_EDIT)])
  db.seed('entity_access', [
    grant('document', DOC_VIEW, 'view'),
    grant('document', DOC_EDIT, 'edit'),
    grant('capture', CAP_VIEW, 'view'),
    grant('capture', CAP_EDIT, 'edit'),
  ])
  db.seed('decision', [
    { id: 'dec-view', capture_id: CAP_VIEW, content: 'Ship on Friday', confirmation: 'suggested', created_at: '2026-10-02T11:00:00Z' },
    { id: 'dec-edit', capture_id: CAP_EDIT, content: 'Ship on Monday', confirmation: 'suggested', created_at: '2026-10-02T11:00:00Z' },
  ])
  return db
}

function client(db: ReturnType<typeof world>) {
  return {
    ...db,
    from: (table: string) => {
      const q = db.from(table) as unknown as Record<string, unknown>
      q.single = q.maybeSingle
      return q
    },
  } as never
}

type Result = Record<string, unknown> & { success: boolean; error?: string }
const run = (t: { execute?: unknown }, args: Record<string, unknown>) =>
  (t as { execute: (a: unknown, o: unknown) => Promise<Result> }).execute(args, OPTS)

const docTools = (db: ReturnType<typeof world>, omitPrivate = false, omitGrants = false) =>
  createDocumentTools(ME, client(db), WS, false, 'session', omitPrivate, undefined, { omitGrants })
const captureTools = (db: ReturnType<typeof world>, omitPrivate = false, omitGrants = false) =>
  createCaptureTools(ME, client(db), WS, undefined, false, omitPrivate, 'session', omitGrants)
const docRow = (db: ReturnType<typeof world>, id: string) => db.rows('document').find((d) => d.id === id)
const capRow = (db: ReturnType<typeof world>, id: string) => db.rows('captures').find((c) => c.id === id)

describe('documents: a view grant still refuses every write, an edit grant edits', () => {
  it('update_document: view refused, edit lands', async () => {
    const db = world()
    const t = docTools(db)
    expect((await run(t.update_document, { document_id: DOC_VIEW, title: 'Changed', base_revision: 1 })).success).toBe(false)
    expect(docRow(db, DOC_VIEW)?.title).toBe(`Title ${DOC_VIEW.slice(-2)}`)
    const res = await run(t.update_document, { document_id: DOC_EDIT, title: 'Changed', base_revision: 1 })
    expect(res.success).toBe(true)
    expect(docRow(db, DOC_EDIT)?.title).toBe('Changed')
    // No grant at all: as before, not found.
    expect((await run(t.update_document, { document_id: DOC_NONE, title: 'Changed', base_revision: 1 })).success).toBe(false)
  })

  it('edit_document_content: view refused, edit lands', async () => {
    const db = world()
    const t = docTools(db)
    expect((await run(t.edit_document_content, { document_id: DOC_VIEW, old_text: 'body', new_text: 'bodies' })).success).toBe(false)
    expect(docRow(db, DOC_VIEW)?.content).toBe(`body of ${DOC_VIEW}`)
    expect((await run(t.edit_document_content, { document_id: DOC_EDIT, old_text: 'body', new_text: 'bodies' })).success).toBe(true)
    expect(docRow(db, DOC_EDIT)?.content).toBe(`bodies of ${DOC_EDIT}`)
  })

  it('an edit grant never changes who sees it, nor archives or deletes it', async () => {
    const db = world()
    const t = docTools(db)
    const vis = await run(t.update_document, { document_id: DOC_EDIT, visibility: 'workspace' })
    expect(vis.success).toBe(false)
    expect(docRow(db, DOC_EDIT)?.visibility).toBe('private')
    expect((await run(t.archive_document, { document_ids: [DOC_EDIT] })).success).not.toBe(true)
    expect(docRow(db, DOC_EDIT)?.status).toBe('active')
    expect((await run(t.delete_document, { document_id: DOC_EDIT })).success).toBe(false)
    expect(docRow(db, DOC_EDIT)).toBeDefined()
  })

  it('get_document says how it is shared: to edit, or to read', async () => {
    const t = docTools(world())
    const edit = (await run(t.get_document, { document_id: DOC_EDIT })).document as Record<string, unknown>
    expect(edit.shared_with_you).toBe(true)
    expect(edit.access).toBe('edit')
    const view = (await run(t.get_document, { document_id: DOC_VIEW })).document as Record<string, unknown>
    expect(view.access).toBe('view')
  })

  it('a guest never edits through a grant', async () => {
    const db = world({ myRole: 'guest' })
    expect((await run(docTools(db).update_document, { document_id: DOC_EDIT, title: 'Changed', base_revision: 1 })).success).toBe(false)
    expect(docRow(db, DOC_EDIT)?.title).toBe(`Title ${DOC_EDIT.slice(-2)}`)
  })

  it('an unattended run never edits through a grant', async () => {
    const db = world()
    expect((await run(docTools(db, true).update_document, { document_id: DOC_EDIT, title: 'Changed', base_revision: 1 })).success).toBe(false)
    expect(docRow(db, DOC_EDIT)?.title).toBe(`Title ${DOC_EDIT.slice(-2)}`)
  })

  it('add_comment: view refused, edit lands', async () => {
    const db = world()
    const t = createCommentTools(ME, client(db), WS)
    expect((await run(t.add_comment, { commentable_type: 'document', commentable_id: DOC_VIEW, body: 'Hi' })).success).toBe(false)
    expect((await run(t.add_comment, { commentable_type: 'document', commentable_id: DOC_EDIT, body: 'Hi' })).success).toBe(true)
    expect(db.rows('comment').map((c) => c.commentable_id)).toEqual([DOC_EDIT])
  })
})

describe('captures: a view grant still refuses every write, an edit grant edits', () => {
  it('update_capture: view refused, edit lands', async () => {
    const db = world()
    const t = captureTools(db)
    expect((await run(t.update_capture, { capture_id: CAP_VIEW, title: 'Changed' })).success).toBe(false)
    expect(capRow(db, CAP_VIEW)?.title).toBe(`Meeting ${CAP_VIEW.slice(-2)}`)
    expect((await run(t.update_capture, { capture_id: CAP_EDIT, title: 'Changed' })).success).toBe(true)
    expect(capRow(db, CAP_EDIT)?.title).toBe('Changed')
  })

  it('edit_capture_content: view refused, edit lands', async () => {
    const db = world()
    const t = captureTools(db)
    expect((await run(t.edit_capture_content, { capture_id: CAP_VIEW, field: 'content', old_text: 'notes', new_text: 'more notes' })).success).toBe(false)
    expect(capRow(db, CAP_VIEW)?.content).toBe('notes')
    expect((await run(t.edit_capture_content, { capture_id: CAP_EDIT, field: 'content', old_text: 'notes', new_text: 'more notes' })).success).toBe(true)
    expect(capRow(db, CAP_EDIT)?.content).toBe('more notes')
  })

  it('archive_capture: never through a grant, view or edit', async () => {
    const db = world()
    const t = captureTools(db)
    expect((await run(t.archive_capture, { capture_id: CAP_VIEW })).success).toBe(false)
    expect((await run(t.archive_capture, { capture_id: CAP_EDIT })).success).toBe(false)
    expect(capRow(db, CAP_EDIT)?.status).toBe('complete')
  })

  it('get_capture_content says it is shared to edit', async () => {
    const cap = (await run(captureTools(world()).get_capture_content, { capture_id: CAP_EDIT })).capture as Record<string, unknown>
    expect(cap.shared_with_you).toBe(true)
    expect(cap.access).toBe('edit')
  })

  it('decisions: confirming on a view-shared capture is refused, on an edit-shared one it lands', async () => {
    const db = world()
    const t = createDecisionTools(ME, client(db), WS)
    expect((await run(t.confirm_decision, { decision_id: 'dec-view' })).success).toBe(false)
    expect(db.rows('decision').find((d) => d.id === 'dec-view')?.confirmation).toBe('suggested')
    // (The double answers an update with its patch, so the tool's echo of the
    // decision's text can throw here; the row is what the gate let through.)
    await run(t.confirm_decision, { decision_id: 'dec-edit' }).catch(() => null)
    expect(db.rows('decision').find((d) => d.id === 'dec-edit')?.confirmation).toBe('confirmed')
  })

  it('add_comment on a capture: view refused, edit lands', async () => {
    const db = world()
    const t = createCommentTools(ME, client(db), WS)
    expect((await run(t.add_comment, { commentable_type: 'capture', commentable_id: CAP_VIEW, body: 'Hi' })).success).toBe(false)
    expect((await run(t.add_comment, { commentable_type: 'capture', commentable_id: CAP_EDIT, body: 'Hi' })).success).toBe(true)
  })

  it('a guest, or an unattended run, never edits through a grant', async () => {
    const guest = world({ myRole: 'guest' })
    expect((await run(captureTools(guest).update_capture, { capture_id: CAP_EDIT, title: 'Changed' })).success).toBe(false)
    const unattended = world()
    expect((await run(captureTools(unattended, true).update_capture, { capture_id: CAP_EDIT, title: 'Changed' })).success).toBe(false)
    expect(capRow(unattended, CAP_EDIT)?.title).toBe(`Meeting ${CAP_EDIT.slice(-2)}`)
  })
})

describe('a guest’s or a linked agent’s turn (omitGrants): no grant of the owner’s ever edits', () => {
  it('documents: update, edit text and comment are all refused, and nothing changes', async () => {
    const db = world()
    const t = docTools(db, false, true)
    expect((await run(t.update_document, { document_id: DOC_EDIT, title: 'Changed', base_revision: 1 })).success).toBe(false)
    expect((await run(t.edit_document_content, { document_id: DOC_EDIT, old_text: 'body', new_text: 'bodies' })).success).toBe(false)
    const c = createCommentTools(ME, client(db), WS, false, false, 'session', true)
    expect((await run(c.add_comment, { commentable_type: 'document', commentable_id: DOC_EDIT, body: 'Hi' })).success).toBe(false)
    expect(docRow(db, DOC_EDIT)?.title).toBe(`Title ${DOC_EDIT.slice(-2)}`)
    expect(docRow(db, DOC_EDIT)?.content).toBe(`body of ${DOC_EDIT}`)
    expect(db.rows('comment')).toHaveLength(0)
  })

  it('captures: update, edit text, decisions and comments are all refused', async () => {
    const db = world()
    const t = captureTools(db, false, true)
    expect((await run(t.update_capture, { capture_id: CAP_EDIT, title: 'Changed' })).success).toBe(false)
    expect((await run(t.edit_capture_content, { capture_id: CAP_EDIT, field: 'content', old_text: 'notes', new_text: 'more notes' })).success).toBe(false)
    const d = createDecisionTools(ME, client(db), WS, false, 'session', false, undefined, true)
    expect((await run(d.confirm_decision, { decision_id: 'dec-edit' })).success).toBe(false)
    const c = createCommentTools(ME, client(db), WS, false, false, 'session', true)
    expect((await run(c.add_comment, { commentable_type: 'capture', commentable_id: CAP_EDIT, body: 'Hi' })).success).toBe(false)
    expect(capRow(db, CAP_EDIT)?.title).toBe(`Meeting ${CAP_EDIT.slice(-2)}`)
    expect(db.rows('decision').find((x) => x.id === 'dec-edit')?.confirmation).toBe('suggested')
  })
})
