/**
 * The agent reads what is shared with its person (FU-C, migration 506). A
 * per-item grant (492) opens another member's private document or capture
 * to a member; the read POLICIES learned it in 493, but the agent's tools
 * read on a service-role client and restate each rule themselves, so until
 * now a shared record stayed invisible to the person's agent (it failed
 * closed). These pin both directions:
 *   - every READ tool sees a record shared with the person, and says it is
 *     shared and view-only;
 *   - every WRITE tool still refuses it (a grant is view-only, 494);
 *   - an unattended run reads no grant; a grant in another workspace, or one
 *     that reaches someone else, opens nothing; a failed grant read opens
 *     nothing (fails closed);
 *   - someone's Now file stays theirs alone, shared or not;
 *   - a shared capture's review queue (proposed_change, which never followed
 *     grants) stays its owner's.
 */
import { describe, expect, it } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { createDocumentTools } from '../documents'
import { createCaptureTools } from '../captures'
import { createCommentTools } from '../comments'
import { createDecisionTools } from '../decisions'
import { createProjectTools } from '../projects'
import { applyCaptureVisibility, applyDocumentVisibility, isCaptureVisible, isDocumentVisible } from '../_shared'

const WS = 'ws-1'
const OTHER_WS = 'ws-2'
const ME = 'user-me'
const MY_MEMBER = 'm-me'
const ZOE_USER = 'user-zoe'
const ZOE = 'm-zoe'
const OPTS = { toolCallId: 't', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

// Ids that pass the uuid check the list filter applies.
const DOC_SHARED = '00000000-0000-4000-8000-0000000000d1'
const DOC_PRIVATE = '00000000-0000-4000-8000-0000000000d2'
const DOC_TEAM = '00000000-0000-4000-8000-0000000000d3'
const DOC_NOW = '00000000-0000-4000-8000-0000000000d4'
const DOC_ELSEWHERE_GRANT = '00000000-0000-4000-8000-0000000000d5'
const DOC_MINE = '00000000-0000-4000-8000-0000000000d6'
const CAP_SHARED = '00000000-0000-4000-8000-0000000000c1'
const CAP_PRIVATE = '00000000-0000-4000-8000-0000000000c2'
const CAP_TEAM = '00000000-0000-4000-8000-0000000000c3'
const PROJECT = '00000000-0000-4000-8000-0000000000a1'

const doc = (id: string, over: Record<string, unknown>) => ({
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
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  ...over,
})

const capture = (id: string, over: Record<string, unknown>) => ({
  id,
  workspace_id: WS,
  project_id: PROJECT,
  title: `Meeting ${id.slice(-2)}`,
  content: null,
  summary: null,
  ai_summary: `summary of ${id}`,
  ai_processed: true,
  transcript: `line one of ${id}\nline two`,
  tags: [],
  duration_seconds: 60,
  is_pinned: false,
  is_eval: false,
  status: 'complete',
  started_at: '2026-10-02T10:00:00Z',
  ended_at: '2026-10-02T11:00:00Z',
  created_at: '2026-10-02T10:00:00Z',
  ...over,
})

const grant = (type: 'document' | 'capture', id: string, over: Record<string, unknown> = {}) => ({
  id: `g-${id}`,
  workspace_id: WS,
  entity_type: type,
  entity_id: id,
  grantee_kind: 'member',
  grantee_member_id: MY_MEMBER,
  grantee_team_id: null,
  grantee_channel_id: null,
  level: 'view',
  created_at: '2026-10-03T00:00:00Z',
  ...over,
})

/** entity_grant_ids_for (506) over the seeded grants: the member arm, one workspace, the asker's own. */
function grantIdsFor(db: ReturnType<typeof makeFakeSupabase>) {
  return (args: Record<string, unknown>) => {
    const me = db.rows('member').find((m) => m.user_id === args.p_user && m.workspace_id === args.p_workspace)
    if (!me) return { data: [], error: null }
    const ids = db
      .rows('entity_access')
      .filter((g) => g.workspace_id === args.p_workspace && g.entity_type === args.p_type && g.grantee_member_id === me.id)
      .map((g) => g.entity_id)
    return { data: ids, error: null }
  }
}

function world(opts: { rpcFails?: boolean } = {}) {
  let db: ReturnType<typeof makeFakeSupabase>
  db = makeFakeSupabase({
    rpc: {
      entity_grant_ids_for: (args) =>
        opts.rpcFails ? { data: null, error: { message: 'boom' } } : grantIdsFor(db)(args),
    },
  })
  db.seed('member', [
    { id: MY_MEMBER, user_id: ME, workspace_id: WS, role: 'member', display_name: 'Avery Fernhill' },
    { id: ZOE, user_id: ZOE_USER, workspace_id: WS, role: 'member', display_name: 'Zoe Quill' },
    { id: 'm-me-2', user_id: ME, workspace_id: OTHER_WS, role: 'member', display_name: 'Avery Fernhill' },
  ])
  db.seed('projects', [{ id: PROJECT, workspace_id: WS, name: 'Harbor launch', status: 'active', custom_fields: {} }])
  db.seed('document', [
    doc(DOC_TEAM, { visibility: 'workspace', created_by: ZOE }),
    doc(DOC_SHARED, { visibility: 'private', created_by: ZOE }),
    doc(DOC_PRIVATE, { visibility: 'private', created_by: ZOE }),
    doc(DOC_NOW, { visibility: 'private', created_by: ZOE, frontmatter: { now: { user_id: ZOE_USER } } }),
    doc(DOC_ELSEWHERE_GRANT, { visibility: 'private', created_by: ZOE }),
    doc(DOC_MINE, { visibility: 'private', created_by: MY_MEMBER }),
  ])
  db.seed('captures', [
    capture(CAP_TEAM, { visibility: 'workspace', user_id: ZOE_USER }),
    capture(CAP_SHARED, { visibility: 'private', user_id: ZOE_USER }),
    capture(CAP_PRIVATE, { visibility: 'private', user_id: ZOE_USER }),
  ])
  db.seed('entity_access', [
    grant('document', DOC_SHARED),
    grant('document', DOC_NOW),
    grant('capture', CAP_SHARED),
    // A grant that names someone else, and one written in another workspace: neither opens anything to me.
    grant('document', DOC_PRIVATE, { id: 'g-zoe', grantee_member_id: ZOE }),
    grant('document', DOC_ELSEWHERE_GRANT, { id: 'g-elsewhere', workspace_id: OTHER_WS, grantee_member_id: 'm-me-2' }),
  ])
  db.seed('proposed_change', [
    { id: 'pc-1', workspace_id: WS, capture_id: CAP_SHARED, entity_type: 'action', change_type: 'create', title: 'Send the deck', status: 'pending', sort_order: 0 },
  ])
  db.seed('decision', [{ id: 'dec-1', capture_id: CAP_SHARED, content: 'Ship on Friday', confirmation: 'confirmed', created_at: '2026-10-02T11:00:00Z' }])
  db.seed('comment', [
    { id: 'cm-1', commentable_type: 'document', commentable_id: DOC_SHARED, body: 'Looks right', parent_id: null, author_id: ZOE, created_at: '2026-10-03T00:00:00Z' },
  ])
  return db
}

/** The fake, with `.single()` reading one row as PostgREST's does (the fake's returns a list). */
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

const docTools = (db: ReturnType<typeof world>, omitPrivate = false) => createDocumentTools(ME, client(db), WS, false, 'session', omitPrivate)
const captureTools = (db: ReturnType<typeof world>, omitPrivate = false) =>
  createCaptureTools(ME, client(db), WS, undefined, false, omitPrivate)

describe('documents shared with the person', () => {
  it('get_document reads one, and says it is shared and view-only', async () => {
    const res = await run(docTools(world()).get_document, { document_id: DOC_SHARED })
    expect(res.success).toBe(true)
    const header = res.document as Record<string, unknown>
    expect(header.content).toBe(`body of ${DOC_SHARED}`)
    expect(header.shared_with_you).toBe(true)
    expect(header.access).toBe('view')
  })

  it("someone else's unshared private document is still not found", async () => {
    const res = await run(docTools(world()).get_document, { document_id: DOC_PRIVATE })
    expect(res.success).toBe(false)
    expect(JSON.stringify(res)).not.toContain(`body of ${DOC_PRIVATE}`)
  })

  it('a grant written in another workspace opens nothing here', async () => {
    const res = await run(docTools(world()).get_document, { document_id: DOC_ELSEWHERE_GRANT })
    expect(res.success).toBe(false)
  })

  it("someone's Now file stays theirs alone, shared or not", async () => {
    const res = await run(docTools(world()).get_document, { document_id: DOC_NOW })
    expect(res.success).toBe(false)
    expect(JSON.stringify(res)).not.toContain(`body of ${DOC_NOW}`)
  })

  it('list_documents lists it, marked shared, beside the workspace ones, and nothing else private', async () => {
    const res = await run(docTools(world()).list_documents, { limit: 20 })
    const rows = res.documents as Array<{ id: string; shared_with_you?: boolean }>
    const ids = rows.map((r) => r.id)
    expect(ids).toContain(DOC_TEAM)
    expect(ids).toContain(DOC_SHARED)
    expect(ids).not.toContain(DOC_PRIVATE)
    expect(ids).not.toContain(DOC_ELSEWHERE_GRANT)
    expect(rows.find((r) => r.id === DOC_SHARED)?.shared_with_you).toBe(true)
    expect(rows.find((r) => r.id === DOC_TEAM)?.shared_with_you).toBeUndefined()
  })

  it('a failed grant read opens nothing (fails closed)', async () => {
    const db = world({ rpcFails: true })
    const rows = (await run(docTools(db).list_documents, { limit: 20 })).documents as Array<{ id: string }>
    expect(rows.map((r) => r.id)).not.toContain(DOC_SHARED)
  })

  it('an unattended run reads no grant, and never asks', async () => {
    const db = world()
    const t = docTools(db, true)
    expect((await run(t.get_document, { document_id: DOC_SHARED })).success).toBe(false)
    const rows = (await run(t.list_documents, { limit: 20 })).documents as Array<{ id: string }>
    expect(rows.map((r) => r.id)).toEqual([DOC_TEAM])
    expect(db.rpcCalls.filter((c) => c.fn === 'entity_grant_ids_for')).toHaveLength(0)
  })

  it('reads its history', async () => {
    const res = await run(docTools(world()).list_document_revisions, { document_id: DOC_SHARED })
    expect(res.success).toBe(true)
  })

  it('every write still refuses it: update, edit, propose, link', async () => {
    const db = world()
    const t = docTools(db)
    expect((await run(t.update_document, { document_id: DOC_SHARED, title: 'Mine now', base_revision: 1 })).success).toBe(false)
    expect((await run(t.edit_document_content, { document_id: DOC_SHARED, old_text: 'body', new_text: 'bodies' })).success).toBe(false)
    expect((await run(t.propose_document_edit, { document_id: DOC_SHARED, base_revision: 1, content: 'rewritten' })).success).toBe(false)
    const doc = db.rows('document').find((d) => d.id === DOC_SHARED)
    expect(doc?.title).toBe(`Title ${DOC_SHARED.slice(-2)}`)
    expect(doc?.content).toBe(`body of ${DOC_SHARED}`)
    // The control: the same call on the person's own private document lands.
    expect((await run(t.update_document, { document_id: DOC_MINE, title: 'Mine now', base_revision: 1 })).success).toBe(true)
    expect(db.rows('document').find((d) => d.id === DOC_MINE)?.title).toBe('Mine now')
  })

  it('its comments read; adding one is still refused', async () => {
    const db = world()
    const t = createCommentTools(ME, client(db), WS)
    const listed = await run(t.list_comments, { commentable_type: 'document', commentable_id: DOC_SHARED })
    expect(listed.success).toBe(true)
    expect(JSON.stringify(listed)).toContain('Looks right')
    const added = await run(t.add_comment, { commentable_type: 'document', commentable_id: DOC_SHARED, body: 'Mine too' })
    expect(added.success).toBe(false)
    expect(db.rows('comment')).toHaveLength(1)
    // The control: on a workspace document the same call lands.
    expect((await run(t.add_comment, { commentable_type: 'document', commentable_id: DOC_TEAM, body: 'Mine too' })).success).toBe(true)
  })
})

describe('captures shared with the person', () => {
  it('get_capture_content and get_capture_transcript read one, marked shared and view-only', async () => {
    const t = captureTools(world())
    const content = await run(t.get_capture_content, { capture_id: CAP_SHARED })
    expect(content.success).toBe(true)
    const cap = content.capture as Record<string, unknown>
    expect(cap.summary).toBe(`summary of ${CAP_SHARED}`)
    expect(cap.shared_with_you).toBe(true)
    expect(cap.access).toBe('view')
    const transcript = await run(t.get_capture_transcript, { capture_id: CAP_SHARED })
    expect(transcript.success).toBe(true)
    expect(String(transcript.transcript)).toContain(`line one of ${CAP_SHARED}`)
  })

  it("someone else's unshared private capture is still not found", async () => {
    const t = captureTools(world())
    expect((await run(t.get_capture_content, { capture_id: CAP_PRIVATE })).success).toBe(false)
    expect((await run(t.get_capture_transcript, { capture_id: CAP_PRIVATE })).success).toBe(false)
  })

  it('list_captures lists it, marked shared, and nothing else private', async () => {
    const res = await run(captureTools(world()).list_captures, {})
    const rows = res.captures as Array<{ id: string; shared_with_you?: boolean }>
    expect(rows.map((r) => r.id).sort()).toEqual([CAP_SHARED, CAP_TEAM].sort())
    expect(rows.find((r) => r.id === CAP_SHARED)?.shared_with_you).toBe(true)
  })

  it("extractions show what was kept, never the owner's review queue", async () => {
    const res = await run(captureTools(world()).get_capture_extractions, { capture_id: CAP_SHARED })
    expect(res.success).toBe(true)
    expect(JSON.stringify(res)).not.toContain('Send the deck')
    expect(JSON.stringify(res)).toContain('Ship on Friday')
  })

  it('updating, archiving or editing it is still refused', async () => {
    const db = world()
    const t = captureTools(db)
    expect((await run(t.update_capture, { capture_id: CAP_SHARED, title: 'Mine now' })).success).toBe(false)
    expect((await run(t.archive_capture, { capture_id: CAP_SHARED })).success).toBe(false)
    expect((await run(t.edit_capture_content, { capture_id: CAP_SHARED, content: 'rewritten' })).success).toBe(false)
    const row = db.rows('captures').find((c) => c.id === CAP_SHARED)
    expect(row?.title).toBe(`Meeting ${CAP_SHARED.slice(-2)}`)
    expect(row?.status).toBe('complete')
    // The control: the same call on a workspace capture lands.
    expect((await run(t.update_capture, { capture_id: CAP_TEAM, title: 'Renamed' })).success).toBe(true)
    expect(db.rows('captures').find((c) => c.id === CAP_TEAM)?.title).toBe('Renamed')
  })

  it('an unattended run reads no grant', async () => {
    const t = captureTools(world(), true)
    expect((await run(t.get_capture_content, { capture_id: CAP_SHARED })).success).toBe(false)
    const rows = (await run(t.list_captures, {})).captures as Array<{ id: string }>
    expect(rows.map((r) => r.id)).toEqual([CAP_TEAM])
  })

  it('its decisions list; confirming one is still refused', async () => {
    const db = world()
    const t = createDecisionTools(ME, client(db), WS)
    const listed = await run(t.list_decisions, { capture_id: CAP_SHARED })
    expect(listed.success).toBe(true)
    expect(JSON.stringify(listed)).toContain('Ship on Friday')
    expect((await run(t.list_decisions, { capture_id: CAP_PRIVATE })).success).toBe(false)
    expect((await run(t.confirm_decision, { decision_id: 'dec-1' })).success).toBe(false)
  })

  it("a project's recent notes include it", async () => {
    const res = await run(createProjectTools(ME, client(world()), WS).get_project_context, { project_id: PROJECT })
    const ids = (res.recent_notes as Array<{ id: string }>).map((n) => n.id)
    expect(ids).toContain(CAP_SHARED)
    expect(ids).not.toContain(CAP_PRIVATE)
  })
})

describe('the predicates', () => {
  type Call = [string, ...unknown[]]
  const recorder = () => {
    const calls: Call[] = []
    const q: Record<string, (...a: unknown[]) => unknown> = {}
    for (const m of ['or', 'eq', 'neq']) q[m] = (...a: unknown[]) => (calls.push([m, ...a]), q)
    return { q, calls }
  }

  it('a grant arm joins the OR only with a requester, and only well-formed ids', () => {
    const a = recorder()
    applyCaptureVisibility(a.q, ME, undefined, [CAP_SHARED, 'not-a-uuid),visibility.eq.private'])
    expect(a.calls).toContainEqual(['or', `visibility.eq.workspace,user_id.eq.${ME},id.in.(${CAP_SHARED})`])
    const b = recorder()
    applyCaptureVisibility(b.q, null, undefined, [CAP_SHARED])
    expect(b.calls).toContainEqual(['eq', 'visibility', 'workspace'])
    expect(JSON.stringify(b.calls)).not.toContain(CAP_SHARED)
    const c = recorder()
    applyDocumentVisibility(c.q, MY_MEMBER, [])
    expect(c.calls).toEqual([['or', `visibility.eq.workspace,created_by.eq.${MY_MEMBER}`]])
  })

  it('the row checks honour a grant only with a requester; eval captures never', () => {
    const granted = new Set([CAP_SHARED])
    const row = { id: CAP_SHARED, visibility: 'private', user_id: ZOE_USER, is_eval: false }
    expect(isCaptureVisible(row, ME)).toBe(false)
    expect(isCaptureVisible(row, ME, undefined, granted)).toBe(true)
    expect(isCaptureVisible(row, null, undefined, granted)).toBe(false)
    expect(isCaptureVisible({ ...row, is_eval: true }, ME, undefined, granted)).toBe(false)
    const d = { id: DOC_SHARED, visibility: 'private', created_by: ZOE }
    expect(isDocumentVisible(d, MY_MEMBER)).toBe(false)
    expect(isDocumentVisible(d, MY_MEMBER, new Set([DOC_SHARED]))).toBe(true)
    expect(isDocumentVisible(d, null, new Set([DOC_SHARED]))).toBe(false)
  })
})
