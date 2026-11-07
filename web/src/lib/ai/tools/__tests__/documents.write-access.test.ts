/**
 * The chat and MCP document tools run on a SERVICE-ROLE client, so RLS can't
 * stop them: update_document, edit_document_content and publish_draft check
 * who may change the document themselves (migration 359,
 * src/lib/documents/access.ts). A refusal writes nothing and points at
 * propose_document_edit, which saves the caller's own draft. Every text write
 * is conditional on the revision read and marked as an agent edit, so the
 * change trigger (migration 364) keeps it in history, the product doc and a
 * prep included; edits stamp last_edited_by.
 */
import { describe, expect, it } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createFakeSupabase, type FakeQuery, type FakeResult } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'
import { createDocumentTools } from '../documents'

const USER = 'user-1'
const WS = 'ws-1'
const DOC = '11111111-1111-4111-8111-111111111111'
const CREATOR = 'mem-creator'
const OPTS = { toolCallId: 't', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>
const PREP = { startIso: '2026-10-18T15:00:00.000Z', meetingKey: 'a'.repeat(40), userId: 'user-c' }

interface Setup {
  member: { id: string; role: string }
  doc?: Record<string, unknown>
  settings?: Record<string, unknown>
}

function db({ member, doc = {}, settings = {} }: Setup) {
  const row = {
    id: DOC,
    workspace_id: WS,
    created_by: CREATOR,
    type: 'note',
    slug: null,
    published_status: 'published',
    frontmatter: {},
    project_id: null,
    status: 'active',
    title: 'Plan',
    content: 'The old body.',
    content_json: null,
    tags: [],
    revision: 3,
    ...doc,
  }
  return createFakeSupabase((q: FakeQuery): FakeResult => {
    if (q.table === 'member') return { data: { ...member, workspace_id: WS, user_id: USER, workspace: { settings } }, error: null }
    if (q.table === 'document' && q.op === 'select') return { data: row, error: null }
    if (q.table === 'document' && q.op === 'update') return { data: [{ id: DOC, title: row.title, content: 'new', revision: 4 }], error: null }
    if (q.table === 'document_draft' && q.op === 'select') return { data: { title: null, content: 'Draft body.', content_json: null, frontmatter: null, tags: null }, error: null }
    if (q.table === 'document_revision' && q.op === 'select') return { data: { revision_number: 1 }, error: null }
    return { data: null, error: null }
  })
}

const writes = (fake: ReturnType<typeof db>, table: string, op: string) => fake.log.filter((q) => q.table === table && q.op === op)
type Refusal = { success: boolean; error?: string; use_instead?: string }

describe('a non-creator is refused and pointed at propose_document_edit', () => {
  const other = { id: 'mem-other', role: 'member' }

  it('update_document', async () => {
    const fake = db({ member: other })
    const r = (await createDocumentTools(USER, fake.client, WS).update_document.execute!({ document_id: DOC, content: 'hijack', base_revision: 3 }, OPTS)) as Refusal
    expect(r.success).toBe(false)
    expect(r.use_instead).toBe('propose_document_edit')
    expect(r.error).toMatch(/propose_document_edit/)
    expect(writes(fake, 'document', 'update')).toHaveLength(0)
  })

  it('edit_document_content', async () => {
    const fake = db({ member: other })
    const r = (await createDocumentTools(USER, fake.client, WS).edit_document_content.execute!({ document_id: DOC, old_text: 'old', new_text: 'new' }, OPTS)) as Refusal
    expect(r.success).toBe(false)
    expect(r.use_instead).toBe('propose_document_edit')
    expect(writes(fake, 'document', 'update')).toHaveLength(0)
  })

  it('publish_draft: refused before the revision insert, the draft kept', async () => {
    const fake = db({ member: other })
    const r = (await createDocumentTools(USER, fake.client, WS).publish_draft.execute!({ document_id: DOC }, OPTS)) as Refusal
    expect(r.success).toBe(false)
    expect(r.use_instead).toBe('propose_document_edit')
    expect(writes(fake, 'document_revision', 'insert')).toHaveLength(0)
    expect(writes(fake, 'document', 'update')).toHaveLength(0)
    expect(writes(fake, 'document_draft', 'delete')).toHaveLength(0)
  })

  it('propose_document_edit still saves their own draft', async () => {
    const fake = db({ member: other })
    const r = (await createDocumentTools(USER, fake.client, WS).propose_document_edit.execute!({ document_id: DOC, content: 'My idea.', base_revision: 1 }, OPTS)) as Refusal
    expect(r.success).toBe(true)
    expect(writes(fake, 'document_draft', 'upsert')[0].payload).toMatchObject({ author_id: 'mem-other', content: 'My idea.' })
  })

  it('the creator of the product doc is refused too; the creator of a plain doc is not', async () => {
    const creator = { id: CREATOR, role: 'member' }
    const refused = db({ member: creator, settings: { product_doc: { document_id: DOC } } })
    const r = (await createDocumentTools(USER, refused.client, WS).update_document.execute!({ document_id: DOC, content: 'x', base_revision: 3 }, OPTS)) as Refusal
    expect(r.success).toBe(false)
    // The product doc is canon (canon D2): an agent edits it by section only.
    expect(r.error).toMatch(/canon document \(`product`\)/)

    const fine = db({ member: creator })
    const ok = (await createDocumentTools(USER, fine.client, WS).update_document.execute!({ document_id: DOC, content: 'x', base_revision: 3 }, OPTS)) as Refusal
    expect(ok.success).toBe(true)
    expect(writes(fine, 'document', 'update')[0].payload).toMatchObject({ content: 'x', last_edited_by: CREATOR })
    // History is the trigger's (migration 364): the app never writes it.
    expect(writes(fine, 'document_revision', 'insert')).toHaveLength(0)
  })
})

describe('a write to the product doc or a prep is a tracked agent edit (migration 364)', () => {
  const admin = { id: 'mem-admin', role: 'admin' }
  const update = (fake: ReturnType<typeof db>) => writes(fake, 'document', 'update')[0]

  it('update_document never rewrites the product doc: it is canon, edited by section (canon D2)', async () => {
    const fake = db({ member: admin, settings: { product_doc: { document_id: DOC } } })
    const r = (await createDocumentTools(USER, fake.client, WS).update_document.execute!({ document_id: DOC, content: 'New facts.', base_revision: 3 }, OPTS)) as Refusal & { use_instead?: string }
    expect(r.success).toBe(false)
    expect(r.use_instead).toBe('propose_section_edit')
    expect(writes(fake, 'document', 'update')).toHaveLength(0)
  })

  it('edit_document_content on a meeting prep', async () => {
    const fake = db({ member: admin, doc: { frontmatter: { meeting_prep: PREP } } })
    const r = (await createDocumentTools(USER, fake.client, WS).edit_document_content.execute!({ document_id: DOC, old_text: 'old', new_text: 'new' }, OPTS)) as Refusal
    expect(r.success).toBe(true)
    expect(update(fake).payload).toEqual({ content: 'The new body.', last_edited_by: 'mem-admin', edit_source: 'agent', edit_summary: 'Edited text' })
    expect(update(fake).filters).toContainEqual(['eq', 'revision', 3])
  })

  it('a pin-only update on the product doc is no text change', async () => {
    const fake = db({ member: admin, settings: { product_doc: { document_id: DOC } } })
    await createDocumentTools(USER, fake.client, WS).update_document.execute!({ document_id: DOC, is_pinned: true }, OPTS)
    expect(update(fake).payload).toEqual({ is_pinned: true, last_edited_by: 'mem-admin' })
    expect(update(fake).filters).not.toContainEqual(['eq', 'revision', 3])
  })
})
