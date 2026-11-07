/**
 * Safe document writes from the agent tools (migration 364): every text write
 * is conditional on the revision read. A targeted edit that loses the race
 * re-reads and re-applies itself once; a whole-body write needs the revision
 * the agent read and is refused as a conflict when the document moved on; a
 * draft records the revision it was based on, and publishing one the document
 * has moved past asks first.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'

// Re-indexing is best-effort and covered elsewhere: no embedding calls here.
vi.mock('@/lib/ai/embeddings', () => ({ indexDocument: vi.fn(async () => ({ chunksCreated: 0 })) }))
vi.mock('@/lib/wiki/wikilinks', () => ({ syncDocumentLinks: vi.fn(async () => {}) }))
import { createFakeSupabase, type FakeQuery, type FakeResult } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'
import { createDocumentTools } from '../documents'

const USER = 'user-1'
const WS = 'ws-1'
const DOC = '11111111-1111-4111-8111-111111111111'
const OPTS = { toolCallId: 't', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

type Result = Record<string, unknown> & { success: boolean; error?: string }

/**
 * A store with one document. `concurrent` lists writes that land between a
 * tool's read and its write (one per conditional update, in order): each
 * replaces the body and bumps the revision, so that update matches nothing.
 */
function store(opts: { content?: string; revision?: number; concurrent?: string[]; draft?: Record<string, unknown> | null } = {}) {
  const state = { content: opts.content ?? 'Intro.\n\n## Risks\nNone yet.', revision: opts.revision ?? 3 }
  const concurrent = [...(opts.concurrent ?? [])]
  const fake = createFakeSupabase((q: FakeQuery): FakeResult => {
    if (q.table === 'member') return { data: { id: 'mem-1', role: 'owner', workspace_id: WS, user_id: USER, workspace: { settings: {} } }, error: null }
    if (q.table === 'document' && q.op === 'select') {
      return {
        data: {
          id: DOC,
          workspace_id: WS,
          created_by: 'mem-1',
          type: 'note',
          slug: null,
          published_status: 'published',
          frontmatter: {},
          project_id: null,
          status: 'active',
          title: 'Plan',
          content: state.content,
          content_json: null,
          tags: [],
          revision: state.revision,
        },
        error: null,
      }
    }
    if (q.table === 'document' && q.op === 'update') {
      const base = q.filters.find((f) => f[0] === 'eq' && f[1] === 'revision')?.[2]
      const next = concurrent.shift()
      if (next !== undefined) {
        state.content = next
        state.revision++
      }
      if (base !== undefined && base !== state.revision) return { data: [], error: null }
      const payload = q.payload as Record<string, unknown>
      if (typeof payload.content === 'string') state.content = payload.content
      state.revision++
      return { data: [{ id: DOC, title: 'Plan', content: state.content, revision: state.revision }], error: null }
    }
    if (q.table === 'document_draft' && q.op === 'select') return { data: opts.draft ?? null, error: null }
    return { data: null, error: null }
  })
  return { ...fake, state, tools: createDocumentTools(USER, fake.client, WS) }
}

const updates = (s: ReturnType<typeof store>) => s.log.filter((q) => q.table === 'document' && q.op === 'update')

describe('edit_document_content: compare-and-swap with one targeted retry', () => {
  it('writes conditional on the revision it read and returns the new one', async () => {
    const s = store()
    const r = (await s.tools.edit_document_content.execute!({ document_id: DOC, old_text: 'None yet.', new_text: 'Vendor delay.' }, OPTS)) as Result
    expect(r).toMatchObject({ success: true, revision: 4 })
    expect(r).not.toHaveProperty('rebased')
    expect(updates(s)[0].filters).toContainEqual(['eq', 'revision', 3])
    expect(s.state.content).toBe('Intro.\n\n## Risks\nVendor delay.')
  })

  it('finds old_text in a CRLF body (read as LF, as the line tools read it), and writes LF', async () => {
    const s = store({ content: 'Intro.\r\n\r\n## Risks\r\nNone yet.' })
    const r = (await s.tools.edit_document_content.execute!({ document_id: DOC, old_text: '## Risks\nNone yet.', new_text: '## Risks\nVendor delay.' }, OPTS)) as Result
    expect(r.success).toBe(true)
    expect(s.state.content).toBe('Intro.\n\n## Risks\nVendor delay.')
  })

  it('a write that lands in between: re-reads and applies the same edit to the new text', async () => {
    const s = store({ concurrent: ['Intro, edited by someone.\n\n## Risks\nNone yet.'] })
    const r = (await s.tools.edit_document_content.execute!({ document_id: DOC, old_text: 'None yet.', new_text: 'Vendor delay.' }, OPTS)) as Result
    expect(r).toMatchObject({ success: true, rebased: true, revision: 5 })
    expect(updates(s)).toHaveLength(2)
    expect(updates(s)[1].filters).toContainEqual(['eq', 'revision', 4])
    // Both edits survive.
    expect(s.state.content).toBe('Intro, edited by someone.\n\n## Risks\nVendor delay.')
  })

  it('the other write removed the text: a conflict, nothing overwritten', async () => {
    const s = store({ concurrent: ['Intro.\n\n## Risks\nShipping slipped.'] })
    const r = (await s.tools.edit_document_content.execute!({ document_id: DOC, old_text: 'None yet.', new_text: 'Vendor delay.' }, OPTS)) as Result
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Text not found/)
    expect(s.state.content).toBe('Intro.\n\n## Risks\nShipping slipped.')
  })

  it('a second write lands during the retry too: a conflict naming both revisions', async () => {
    const s = store({ concurrent: ['Intro 2.\n\n## Risks\nNone yet.', 'Intro 3.\n\n## Risks\nNone yet.'] })
    const r = (await s.tools.edit_document_content.execute!({ document_id: DOC, old_text: 'None yet.', new_text: 'X' }, OPTS)) as Result
    expect(r).toMatchObject({ success: false, conflict: true, current_revision: 5 })
    expect(r.error).toMatch(/changed since you read it/)
    expect(s.state.content).toBe('Intro 3.\n\n## Risks\nNone yet.')
  })

  it('an agent that read an older revision: applied to the current text, and told so', async () => {
    const s = store({ revision: 7 })
    const r = (await s.tools.edit_document_content.execute!({ document_id: DOC, old_text: 'None yet.', new_text: 'Y', base_revision: 5 }, OPTS)) as Result
    expect(r).toMatchObject({ success: true, rebased: true, revision: 8 })
    expect(String(r.note)).toMatch(/you read revision 5/)
  })

  it('new_text is inserted literally ($ patterns are not replacement syntax)', async () => {
    const s = store()
    await s.tools.edit_document_content.execute!({ document_id: DOC, old_text: 'None yet.', new_text: 'Costs $& more' }, OPTS)
    expect(s.state.content).toBe('Intro.\n\n## Risks\nCosts $& more')
  })
})

describe('update_document: a whole-body write names the revision it read', () => {
  it('refuses to replace the body without base_revision', async () => {
    const s = store()
    const r = (await s.tools.update_document.execute!({ document_id: DOC, content: 'Blind.' }, OPTS)) as Result
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/base_revision/)
    expect(updates(s)).toHaveLength(0)
  })

  it('a document that moved on is a conflict, never retried', async () => {
    const s = store({ revision: 6 })
    const r = (await s.tools.update_document.execute!({ document_id: DOC, content: 'Old copy.', base_revision: 5 }, OPTS)) as Result
    expect(r).toMatchObject({ success: false, conflict: true, base_revision: 5, current_revision: 6 })
    expect(updates(s)).toHaveLength(1)
    expect(s.state.content).toBe('Intro.\n\n## Risks\nNone yet.')
  })

  it('a rename alone is checked against the revision read just now', async () => {
    const s = store()
    const r = (await s.tools.update_document.execute!({ document_id: DOC, title: 'Plan v2' }, OPTS)) as Result
    expect(r).toMatchObject({ success: true, revision: 4 })
    expect(updates(s)[0].filters).toContainEqual(['eq', 'revision', 3])
    expect(updates(s)[0].payload).toMatchObject({ title: 'Plan v2', edit_source: 'agent', edit_summary: 'Renamed to "Plan v2"' })
  })
})

describe('drafts record their base; publishing a stale one asks', () => {
  it('propose_document_edit needs the revision the agent read, never "now" (that would publish over newer edits)', async () => {
    const s = store()
    const r = (await s.tools.propose_document_edit.execute!({ document_id: DOC, content: 'Idea.' } as never, OPTS)) as Result
    expect(r.success).toBe(false)
    expect(r.error).toContain('base_revision')
    expect(s.log.find((q) => q.table === 'document_draft' && q.op === 'upsert')).toBeUndefined()
  })

  it('propose_document_edit keeps the revision the agent read when it names one', async () => {
    const s = store()
    await s.tools.propose_document_edit.execute!({ document_id: DOC, content: 'Idea.', base_revision: 2 }, OPTS)
    expect(s.log.find((q) => q.table === 'document_draft' && q.op === 'upsert')?.payload).toMatchObject({ base_revision: 2 })
  })

  it('publish_draft refuses a draft the document has moved past, and writes nothing', async () => {
    const s = store({ revision: 5, draft: { title: null, content: 'Draft.', content_json: null, frontmatter: null, tags: null, base_revision: 3 } })
    const r = (await s.tools.publish_draft.execute!({ document_id: DOC }, OPTS)) as Result
    expect(r).toMatchObject({ success: false, stale_draft: true, draft_base_revision: 3, current_revision: 5 })
    expect(r.error).toMatch(/would undo the newer edits/)
    expect(updates(s)).toHaveLength(0)
    expect(s.log.filter((q) => q.table === 'document_draft' && q.op === 'delete')).toHaveLength(0)
  })

  it('publish_draft with overwrite publishes it, conditional on the revision read', async () => {
    const s = store({ revision: 5, draft: { title: null, content: 'Draft.', content_json: null, frontmatter: null, tags: null, base_revision: 3 } })
    const r = (await s.tools.publish_draft.execute!({ document_id: DOC, overwrite: true }, OPTS)) as Result
    expect(r).toMatchObject({ success: true, revision: 6 })
    expect(updates(s)[0].filters).toContainEqual(['eq', 'revision', 5])
    expect(updates(s)[0].payload).toMatchObject({ content: 'Draft.', edit_source: 'agent', edit_summary: 'Published a draft', published_status: 'published' })
    expect(s.log.filter((q) => q.table === 'document_draft' && q.op === 'delete')).toHaveLength(1)
  })

  it('publish_draft of a current draft goes straight through', async () => {
    const s = store({ draft: { title: null, content: 'Draft.', content_json: null, frontmatter: null, tags: null, base_revision: 3 } })
    const r = (await s.tools.publish_draft.execute!({ document_id: DOC, change_summary: 'Tightened the intro' }, OPTS)) as Result
    expect(r).toMatchObject({ success: true, revision: 4 })
    expect(updates(s)[0].payload).toMatchObject({ edit_summary: 'Tightened the intro' })
  })

  it('a draft from before base revisions existed counts as stale', async () => {
    const s = store({ draft: { title: null, content: 'Old draft.', content_json: null, frontmatter: null, tags: null, base_revision: null } })
    const r = (await s.tools.publish_draft.execute!({ document_id: DOC }, OPTS)) as Result
    expect(r).toMatchObject({ success: false, stale_draft: true, draft_base_revision: null })
  })
})
