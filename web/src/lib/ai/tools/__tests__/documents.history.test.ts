/**
 * The history tools (documents phase 1, item 2): list_document_revisions and
 * get_document_revision read; restore_document_revision puts a version back
 * as a new revision, with edit access, and is attended-only (registry). An
 * agent edit is undoable through them: restore the revision before it.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createFakeSupabase, type FakeQuery, type FakeResult } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'
import { isAttendedOnlyTool } from '@/lib/ai/tool-registry'
import { createDocumentTools } from '../documents'

vi.mock('@/lib/ai/embeddings', () => ({ indexDocument: vi.fn(async () => ({ chunksCreated: 0 })) }))

const USER = 'user-1'
const WS = 'ws-1'
const DOC = '11111111-1111-4111-8111-111111111111'
const OPTS = { toolCallId: 't', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>
type Result = Record<string, unknown> & { success: boolean; error?: string }

const BEFORE = '# Plan\n\n## Risks\nNone yet.'
const AFTER = '# Plan\n\n## Risks\nVendor delay.'

function store(opts: { role?: string; content?: string } = {}) {
  const state = { content: opts.content ?? AFTER, revision: 5 }
  const history = [
    { revision_number: 4, title: 'Plan', author_kind: 'human', author_id: 'mem-1', change_summary: null, created_at: 't4', updated_at: 't4', author: { display_name: 'Ana' }, content: BEFORE, frontmatter: {} },
    { revision_number: 5, title: 'Plan', author_kind: 'agent', author_id: 'mem-1', change_summary: 'Replaced section Risks', created_at: 't5', updated_at: 't5', author: { display_name: 'Ana' }, content: AFTER, frontmatter: {} },
  ]
  const fake = createFakeSupabase((q: FakeQuery): FakeResult => {
    if (q.table === 'member') return { data: { id: 'mem-1', role: opts.role ?? 'owner', workspace_id: WS, user_id: USER, workspace: { settings: {} } }, error: null }
    if (q.table === 'document_revision') {
      const lte = q.filters.find((f) => f[0] === 'lte')?.[2] as number | undefined
      return { data: [...history].reverse().filter((r) => lte === undefined || r.revision_number <= lte), error: null }
    }
    if (q.table === 'document' && q.op === 'select') {
      return {
        data: { id: DOC, workspace_id: WS, created_by: 'mem-9', type: 'note', slug: null, published_status: 'published', frontmatter: {}, project_id: null, status: 'active', title: 'Plan', content: state.content, revision: state.revision },
        error: null,
      }
    }
    if (q.table === 'document' && q.op === 'update') {
      state.content = (q.payload as { content: string }).content
      state.revision++
      return { data: [{ id: DOC, title: 'Plan', content: state.content, revision: state.revision }], error: null }
    }
    return { data: null, error: null }
  })
  return { ...fake, state, tools: createDocumentTools(USER, fake.client, WS) }
}

describe('list_document_revisions', () => {
  it('lists newest first, the current one marked, with who each change was for', async () => {
    const s = store()
    const r = (await s.tools.list_document_revisions.execute!({ document_id: DOC }, OPTS)) as Result & { revisions: Array<Record<string, unknown>> }
    expect(r.current_revision).toBe(5)
    expect(r.revisions[0]).toMatchObject({ revision: 5, by: 'Native Intelligence (for Ana)', summary: 'Replaced section Risks', current: true })
    expect(r.revisions[1]).toMatchObject({ revision: 4, by: 'Ana' })
  })
})

describe('get_document_revision', () => {
  it('shows what a change did as a line diff against the version before it', async () => {
    const s = store()
    const r = (await s.tools.get_document_revision.execute!({ document_id: DOC, revision: 5 }, OPTS)) as Result
    expect(r).toMatchObject({ revision: 5, diff_against: 'revision 4', lines_added: 1, lines_removed: 1, content: AFTER })
    expect(r.diff).toContain('- None yet.')
    expect(r.diff).toContain('+ Vendor delay.')
  })

  it('against the document now: what restoring it would change', async () => {
    const s = store()
    const r = (await s.tools.get_document_revision.execute!({ document_id: DOC, revision: 4, compare_to: 'current' }, OPTS)) as Result
    expect(r.diff_direction).toBe('this version → now')
    expect(r.diff).toContain('+ Vendor delay.')
  })

  it('a long version returns only the diff unless asked', async () => {
    const long = `${'x'.repeat(13_000)}\nend`
    const r = (await createDocumentTools(
      USER,
      createFakeSupabase((q) =>
        q.table === 'document_revision'
          ? { data: [{ revision_number: 5, title: 'Plan', author_kind: 'agent', author_id: null, change_summary: null, created_at: 't', updated_at: 't', author: null, content: long, frontmatter: {} }], error: null }
          : q.table === 'member'
            ? { data: { id: 'mem-1', role: 'owner', workspace: { settings: {} } }, error: null }
            : { data: { id: DOC, workspace_id: WS }, error: null },
      ).client,
      WS,
    ).get_document_revision.execute!({ document_id: DOC, revision: 5 }, OPTS)) as Result
    expect(r).not.toHaveProperty('content')
    expect(String(r.content_omitted)).toMatch(/include_content/)
  })
})

describe('restore_document_revision: an agent edit is undoable', () => {
  it('puts revision 4 back as revision 6', async () => {
    const s = store()
    const r = (await s.tools.restore_document_revision.execute!({ document_id: DOC, revision: 4, base_revision: 5 }, OPTS)) as Result
    expect(r).toMatchObject({ success: true, revision: 6, restored_from: 4 })
    expect(s.state.content).toBe(BEFORE)
    const update = s.log.find((q) => q.table === 'document' && q.op === 'update')!
    expect(update.payload).toMatchObject({ edit_source: 'agent', edit_summary: 'Restored revision 4' })
    expect(update.filters).toContainEqual(['eq', 'revision', 5])
  })

  it('refused without edit access, nothing written', async () => {
    const s = store({ role: 'member' })
    const r = (await s.tools.restore_document_revision.execute!({ document_id: DOC, revision: 4 }, OPTS)) as Result
    expect(r.success).toBe(false)
    expect(s.log.filter((q) => q.table === 'document' && q.op === 'update')).toHaveLength(0)
  })

  it('the document moved on since the agent looked: a conflict', async () => {
    const s = store()
    const r = (await s.tools.restore_document_revision.execute!({ document_id: DOC, revision: 4, base_revision: 3 }, OPTS)) as Result
    expect(r).toMatchObject({ success: false, conflict: true, current_revision: 5 })
  })

  it('is attended-only: no unattended run can roll a document back', () => {
    expect(isAttendedOnlyTool('restore_document_revision')).toBe(true)
    expect(isAttendedOnlyTool('list_document_revisions')).toBe(false)
  })
})
