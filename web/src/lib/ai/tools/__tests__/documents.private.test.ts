/**
 * Private documents in the document tools (migration 369, "Only me", the
 * private-capture rule). The tools run on service-role clients, so these
 * app-layer checks are the real gate:
 *   - someone else's private document does not exist for you: not listed, not
 *     read, not edited; an owner or admin gets no override;
 *   - your own private document is yours to list, read and edit;
 *   - an unattended run (omitPrivate) reads none, not even its person's;
 *   - create_document writes 'workspace' unless asked or the run writes for
 *     one person (defaultVisibility 'private');
 *   - only the creator changes who can see a document, and a system document
 *     is never private.
 */
import { describe, expect, it } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { createDocumentTools, type DocumentVisibility } from '../documents'
import { createTools } from '../index'
import { SYSTEM_DOCUMENT_PRIVATE_REFUSAL, VISIBILITY_REFUSAL } from '@/lib/documents/access'

const WS = 'ws-1'
const ME = 'user-me'
const MY_MEMBER = 'm-me'
const ZOE = 'm-zoe'
const OPTS = { toolCallId: 't', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

const doc = (id: string, over: Record<string, unknown>) => ({
  id,
  workspace_id: WS,
  title: id,
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
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  ...over,
})

function world() {
  const db = makeFakeSupabase()
  db.seed('member', [
    // An admin: still no way into someone else's private document.
    { id: MY_MEMBER, user_id: ME, workspace_id: WS, role: 'admin' },
    { id: ZOE, user_id: 'user-zoe', workspace_id: WS, role: 'member' },
  ])
  db.seed('document', [
    doc('doc-team', { visibility: 'workspace', created_by: ZOE }),
    doc('doc-mine', { visibility: 'private', created_by: MY_MEMBER }),
    doc('doc-zoe', { visibility: 'private', created_by: ZOE }),
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
  }
}

function tools(db: ReturnType<typeof world>, opts: { omitPrivate?: boolean; defaultVisibility?: DocumentVisibility } = {}) {
  return createDocumentTools(ME, client(db) as never, WS, false, 'session', opts.omitPrivate ?? false, opts.defaultVisibility ?? 'workspace')
}

type Result = Record<string, unknown> & { success: boolean; error?: string }
const run = (t: { execute?: unknown }, args: Record<string, unknown>) =>
  (t as { execute: (a: unknown, o: unknown) => Promise<Result> }).execute(args, OPTS)

describe('document tools and private documents (369)', () => {
  it("lists workspace documents and my own private ones, never someone else's, and marks mine", async () => {
    const res = await run(tools(world()).list_documents, { limit: 20 })
    const rows = res.documents as Array<{ id: string; visibility?: string }>
    expect(rows.map((r) => r.id).sort()).toEqual(['doc-mine', 'doc-team'])
    expect(rows.find((r) => r.id === 'doc-mine')?.visibility).toBe('private')
    expect(JSON.stringify(res)).not.toContain('doc-zoe')
  })

  it("reads my own private document; someone else's is not found, even for an admin", async () => {
    const t = tools(world())
    expect((await run(t.get_document, { document_id: 'doc-mine' })).success).toBe(true)
    const theirs = await run(t.get_document, { document_id: 'doc-zoe' })
    expect(theirs.success).toBe(false)
    expect(JSON.stringify(theirs)).not.toContain('body of doc-zoe')
  })

  it('an unattended run reads no private document, not even its person’s own', async () => {
    const t = tools(world(), { omitPrivate: true })
    const rows = (await run(t.list_documents, { limit: 20 })).documents as Array<{ id: string }>
    expect(rows.map((r) => r.id)).toEqual(['doc-team'])
    expect((await run(t.get_document, { document_id: 'doc-mine' })).success).toBe(false)
  })

  it("never edits someone else's private document", async () => {
    const db = world()
    const res = await run(tools(db).update_document, { document_id: 'doc-zoe', title: 'Mine now', base_revision: 1 })
    expect(res.success).toBe(false)
    expect(db.rows('document').find((d) => d.id === 'doc-zoe')?.title).toBe('doc-zoe')
  })

  it('creates a workspace document by default, a private one when asked, and a private one by default in a run for one person', async () => {
    const db = world()
    await run(tools(db).create_document, { title: 'Shared plan', content: '' })
    await run(tools(db).create_document, { title: 'My notes', content: '', visibility: 'private' })
    await run(tools(db, { defaultVisibility: 'private' }).create_document, { title: 'Prep', content: '' })
    const byTitle = (title: string) => db.rows('document').find((d) => d.title === title)
    expect(byTitle('Shared plan')?.visibility ?? 'workspace').toBe('workspace')
    expect(byTitle('My notes')).toMatchObject({ visibility: 'private', created_by: MY_MEMBER })
    expect(byTitle('Prep')).toMatchObject({ visibility: 'private', created_by: MY_MEMBER })
  })

  it('only the creator changes who can see a document', async () => {
    const db = world()
    const refused = await run(tools(db).update_document, { document_id: 'doc-team', visibility: 'private' })
    expect(refused.success).toBe(false)
    expect(refused.error).toContain(VISIBILITY_REFUSAL)
    expect(db.rows('document').find((d) => d.id === 'doc-team')?.visibility).toBe('workspace')

    const mine = await run(tools(db).update_document, { document_id: 'doc-mine', visibility: 'workspace' })
    expect(mine.success).toBe(true)
    expect(db.rows('document').find((d) => d.id === 'doc-mine')?.visibility).toBe('workspace')
  })

  it('a system document is never private', async () => {
    const db = world()
    db.rows('document').push(doc('doc-canon', { visibility: 'workspace', created_by: MY_MEMBER, canon_key: 'handbook' }))
    const res = await run(tools(db).update_document, { document_id: 'doc-canon', visibility: 'private' })
    expect(res.success).toBe(false)
    expect(res.error).toContain(SYSTEM_DOCUMENT_PRIVATE_REFUSAL)
  })

  it("a run that writes for one person (a meeting prep) reads that person's own private documents, and still no one else's", async () => {
    const all = createTools(ME, client(world()) as never, WS, undefined, {
      strictWorkspace: true,
      omitPrivateCaptures: true,
      defaultDocumentVisibility: 'private',
    }) as unknown as Record<string, { execute?: unknown }>
    expect((await run(all.get_document, { document_id: 'doc-mine' })).success).toBe(true)
    expect((await run(all.get_document, { document_id: 'doc-zoe' })).success).toBe(false)

    const plain = createTools(ME, client(world()) as never, WS, undefined, { strictWorkspace: true, omitPrivateCaptures: true }) as unknown as Record<
      string,
      { execute?: unknown }
    >
    expect((await run(plain.get_document, { document_id: 'doc-mine' })).success).toBe(false)
  })
})
