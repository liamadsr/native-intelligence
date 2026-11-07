/**
 * Update a specific part (documents phase 1, item 4): edit_document_lines and
 * the section tools change one part and leave the rest byte for byte, go
 * through the same edit access and compare-and-swap as every document write
 * (a concurrent write is re-applied to the new text once: by heading for a
 * section, by finding the same lines again for a line range), are refused on
 * an ambiguous heading, and return the new revision. Classified like the
 * other document writes.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createFakeSupabase, type FakeQuery, type FakeResult } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'
import { getMutatingToolNames, getToolDefinition, getToolSideEffect, isAttendedOnlyTool } from '@/lib/ai/tool-registry'
import { createDocumentTools } from '../documents'

vi.mock('@/lib/ai/embeddings', () => ({ indexDocument: vi.fn(async () => ({ chunksCreated: 0 })) }))

const USER = 'user-1'
const WS = 'ws-1'
const DOC = '11111111-1111-4111-8111-111111111111'
const OPTS = { toolCallId: 't', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>
type Result = Record<string, unknown> & { success: boolean; error?: string }

const BODY = ['# Product', '', 'Intro.', '', '## Positioning', 'For founders.', '', '## Pricing', 'Free in beta.', '', '## Positioning', 'Again.'].join('\n')

function store(opts: { content?: string; role?: string; concurrent?: string[]; history?: Record<number, string> } = {}) {
  const state = { content: opts.content ?? BODY, revision: 3 }
  const concurrent = [...(opts.concurrent ?? [])]
  const fake = createFakeSupabase((q: FakeQuery): FakeResult => {
    if (q.table === 'member') return { data: { id: 'mem-1', role: opts.role ?? 'owner', workspace_id: WS, user_id: USER, workspace: { settings: {} } }, error: null }
    if (q.table === 'document_revision') {
      const n = q.filters.find((f) => f[0] === 'lte')?.[2] as number
      const text = opts.history?.[n]
      return { data: text === undefined ? [] : [{ revision_number: n, title: 'Product', content: text, frontmatter: {}, created_at: 't', updated_at: 't' }], error: null }
    }
    if (q.table === 'document' && q.op === 'select') {
      return {
        data: { id: DOC, workspace_id: WS, created_by: 'mem-9', type: 'note', slug: null, published_status: 'published', frontmatter: {}, project_id: null, status: 'active', title: 'Product', content: state.content, revision: state.revision },
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
      if (base !== state.revision) return { data: [], error: null }
      state.content = (q.payload as { content: string }).content
      state.revision++
      return { data: [{ id: DOC, title: 'Product', content: state.content, revision: state.revision }], error: null }
    }
    return { data: null, error: null }
  })
  return { ...fake, state, tools: createDocumentTools(USER, fake.client, WS) }
}

const NEW_TOOLS = ['edit_document_lines', 'replace_section', 'append_to_section', 'remove_section', 'insert_section_after'] as const

describe('classification', () => {
  it('each is an internal artifact write like edit_document_content, read as a write, not attended-only', () => {
    for (const name of NEW_TOOLS) {
      expect(getToolSideEffect(name), name).toBe('internal-write')
      expect(getToolDefinition(name)?.writeTarget, name).toBe(getToolDefinition('edit_document_content')?.writeTarget)
      expect(getMutatingToolNames().has(name), name).toBe(true)
      expect(isAttendedOnlyTool(name), name).toBe(false)
    }
  })
})

describe('edit_document_lines', () => {
  it('replaces a range, conditional on the revision the numbers came from', async () => {
    const s = store()
    const r = (await s.tools.edit_document_lines.execute!({ document_id: DOC, base_revision: 3, from: 9, to: 9, new_text: 'Paid from January.' }, OPTS)) as Result
    expect(r).toMatchObject({ success: true, revision: 4, from_line: 9, to_line: 9 })
    expect(s.state.content).toBe(BODY.replace('Free in beta.', 'Paid from January.'))
    const update = s.log.find((q) => q.table === 'document' && q.op === 'update')!
    expect(update.filters).toContainEqual(['eq', 'revision', 3])
    expect(update.payload).toMatchObject({ edit_source: 'agent', edit_summary: 'Edited lines 9–9' })
  })

  it('inserts and deletes', async () => {
    const ins = store()
    await ins.tools.edit_document_lines.execute!({ document_id: DOC, base_revision: 3, from: 10, to: 9, new_text: 'Discounts for nonprofits.' }, OPTS)
    expect(ins.state.content).toContain('Free in beta.\nDiscounts for nonprofits.\n\n## Positioning')
    const del = store()
    await del.tools.edit_document_lines.execute!({ document_id: DOC, base_revision: 3, from: 3, to: 4, new_text: '' }, OPTS)
    expect(del.state.content.startsWith('# Product\n\n## Positioning')).toBe(true)
  })

  it('the document moved on: finds the same lines in the new text and edits them there', async () => {
    const moved = `New first line.\n${BODY}`
    const s = store({ content: moved, history: { 2: BODY } })
    s.state.revision = 5
    const r = (await s.tools.edit_document_lines.execute!({ document_id: DOC, base_revision: 2, from: 9, to: 9, new_text: 'Paid.' }, OPTS)) as Result
    expect(r).toMatchObject({ success: true, rebased: true, from_line: 10 })
    expect(s.state.content).toBe(moved.replace('Free in beta.', 'Paid.'))
  })

  it('the lines are gone, or the base is not in history: a conflict, nothing written', async () => {
    const gone = store({ content: '# Product\n\nRewritten.', history: { 2: BODY } })
    gone.state.revision = 5
    const r = (await gone.tools.edit_document_lines.execute!({ document_id: DOC, base_revision: 2, from: 9, to: 9, new_text: 'Paid.' }, OPTS)) as Result
    expect(r).toMatchObject({ success: false, conflict: true, base_revision: 2, current_revision: 5 })
    expect(gone.log.filter((q) => q.op === 'update')).toHaveLength(0)

    const folded = store({ content: `x\n${BODY}` })
    folded.state.revision = 5
    expect(((await folded.tools.edit_document_lines.execute!({ document_id: DOC, base_revision: 2, from: 9, to: 9, new_text: 'P' }, OPTS)) as Result).conflict).toBe(true)
  })

  it('a range outside the document is refused', async () => {
    const r = (await store().tools.edit_document_lines.execute!({ document_id: DOC, base_revision: 3, from: 40, to: 41, new_text: 'x' }, OPTS)) as Result
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/from must be between 1 and 13/)
  })
})

describe('section tools', () => {
  it('replace_section changes that section only and says where it landed', async () => {
    const s = store()
    const r = (await s.tools.replace_section.execute!({ document_id: DOC, section: 'Pricing', new_text: 'Paid from January.' }, OPTS)) as Result
    expect(r).toMatchObject({ success: true, revision: 4, section: { heading: 'Pricing', from_line: 8 } })
    expect(s.state.content).toBe(BODY.replace('Free in beta.', 'Paid from January.'))
    expect(s.log.find((q) => q.op === 'update')!.payload).toMatchObject({ edit_summary: 'Replaced section "Pricing"' })
  })

  it('an ambiguous heading is refused with the candidates; a path picks one', async () => {
    const s = store()
    const r = (await s.tools.replace_section.execute!({ document_id: DOC, section: 'Positioning', new_text: 'x' }, OPTS)) as Result
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/More than one heading matches "Positioning": "Product > Positioning" \(line 5\), "Product > Positioning" \(line 11\)/)
    expect(s.log.filter((q) => q.op === 'update')).toHaveLength(0)
  })

  it('append_to_section and remove_section', async () => {
    const a = store()
    await a.tools.append_to_section.execute!({ document_id: DOC, section: 'Pricing', text: 'Annual plans later.' }, OPTS)
    expect(a.state.content).toContain('## Pricing\nFree in beta.\n\nAnnual plans later.\n\n## Positioning')
    const r = store()
    const out = (await r.tools.remove_section.execute!({ document_id: DOC, section: 'pricing' }, OPTS)) as Result
    expect(out).toMatchObject({ success: true, removed_section: 'Product > Pricing' })
    expect(r.state.content).not.toContain('Pricing')
  })

  it('insert_section_after: after a section, or at the end', async () => {
    const s = store()
    const r = (await s.tools.insert_section_after.execute!({ document_id: DOC, after: 'Pricing', heading: 'Roadmap', text: 'Teams in Q1.' }, OPTS)) as Result
    expect(s.state.content).toContain('Free in beta.\n\n## Roadmap\n\nTeams in Q1.\n\n## Positioning\nAgain.')
    expect(r).toMatchObject({ success: true, section: { heading: 'Roadmap', from_line: 11 } })
    const end = store()
    await end.tools.insert_section_after.execute!({ document_id: DOC, heading: 'FAQ', text: 'None yet.', level: 3 }, OPTS)
    expect(end.state.content.endsWith('Again.\n\n### FAQ\n\nNone yet.')).toBe(true)
  })

  it('a write that lands in between: re-applied by heading to the new text', async () => {
    const s = store({ concurrent: [BODY.replace('Intro.', 'Intro, edited meanwhile.')] })
    const r = (await s.tools.replace_section.execute!({ document_id: DOC, section: 'Pricing', new_text: 'Paid.' }, OPTS)) as Result
    expect(r).toMatchObject({ success: true, rebased: true, revision: 5 })
    expect(s.state.content).toBe(BODY.replace('Intro.', 'Intro, edited meanwhile.').replace('Free in beta.', 'Paid.'))
  })

  it('needs edit access like every document write', async () => {
    const s = store({ role: 'member' })
    const r = (await s.tools.remove_section.execute!({ document_id: DOC, section: 'Pricing' }, OPTS)) as Result
    expect(r).toMatchObject({ success: false, use_instead: 'propose_document_edit' })
    expect(s.log.filter((q) => q.op === 'update')).toHaveLength(0)
  })
})
