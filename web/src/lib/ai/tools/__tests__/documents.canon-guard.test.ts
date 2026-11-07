/**
 * Review blocker B3 (canon D2): an agent's document tools never change a
 * canon document's text (a canon key, or the product doc pointer's document).
 * Every one of them refuses and points at propose_section_edit, where the
 * hold, the budget, the fixed sections, the sources and the digest line
 * apply. Nothing is written. An ordinary document is edited as before, and
 * restoring a version the person asked for still works on a canon document.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createFakeSupabase, type FakeQuery, type FakeResult } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'
import { createDocumentTools } from '../documents'

vi.mock('@/lib/ai/embeddings', () => ({ indexDocument: vi.fn(async () => ({ chunksCreated: 0 })) }))

const USER = 'user-1'
const WS = 'ws-1'
const DOC = '11111111-1111-4111-8111-111111111111'
const OPTS = { toolCallId: 't', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>
type Result = Record<string, unknown> & { success: boolean; error?: string; use_instead?: string }

const BODY = ['## Positioning', 'For founders.', '', '## Voice', 'Plain.'].join('\n')

function store(opts: { canonKey?: string | null; productDoc?: boolean } = {}) {
  let writes = 0
  const fake = createFakeSupabase((q: FakeQuery): FakeResult => {
    if (q.table === 'member') {
      return { data: { id: 'mem-1', role: 'owner', workspace_id: WS, user_id: USER, workspace: { settings: opts.productDoc ? { product_doc: { document_id: DOC } } : {} } }, error: null }
    }
    if (q.table === 'document_revision') return { data: [{ revision_number: 2, title: 'P', content: 'old', frontmatter: {}, created_at: 't', updated_at: 't' }], error: null }
    if (q.table === 'document' && q.op === 'select') {
      return {
        data: { id: DOC, workspace_id: WS, created_by: 'mem-1', type: 'note', slug: null, published_status: 'published', frontmatter: {}, project_id: null, status: 'active', canon_key: opts.canonKey ?? null, visibility: 'workspace', title: 'Product', content: BODY, revision: 3 },
        error: null,
      }
    }
    if (q.table === 'document' && q.op === 'update') {
      writes++
      return { data: [{ id: DOC, title: 'Product', content: (q.payload as { content?: string }).content ?? BODY, revision: 4 }], error: null }
    }
    return { data: null, error: null }
  })
  return { tools: createDocumentTools(USER, fake.client, WS), writes: () => writes }
}

const CALLS: Array<[string, Record<string, unknown>]> = [
  ['update_document', { document_id: DOC, content: 'all new', base_revision: 3 }],
  ['edit_document_content', { document_id: DOC, old_text: 'For founders.', new_text: 'For teams.' }],
  ['edit_document_lines', { document_id: DOC, base_revision: 3, from: 2, to: 2, new_text: 'For teams.' }],
  ['replace_section', { document_id: DOC, section: 'Positioning', new_text: 'For teams.' }],
  ['append_to_section', { document_id: DOC, section: 'Voice', text: 'Short.' }],
  ['remove_section', { document_id: DOC, section: 'Voice' }],
  ['insert_section_after', { document_id: DOC, after: 'Voice', heading: 'Pricing', text: 'Free.' }],
]

const run = (s: ReturnType<typeof store>, name: string, input: Record<string, unknown>) =>
  (s.tools as unknown as Record<string, { execute: (i: unknown, o: unknown) => Promise<Result> }>)[name].execute(input, OPTS)

describe('canon documents are edited by section only', () => {
  it.each(CALLS)('%s refuses a document with a canon key, writing nothing', async (name, input) => {
    const s = store({ canonKey: 'team-playbook' })
    const r = await run(s, name, input)
    expect(r.success).toBe(false)
    expect(r.use_instead).toBe('propose_section_edit')
    expect(r.error).toContain('team-playbook')
    expect(s.writes()).toBe(0)
  })

  it.each(CALLS)('%s refuses the workspace product doc too', async (name, input) => {
    const s = store({ productDoc: true })
    const r = await run(s, name, input)
    expect(r).toMatchObject({ success: false, use_instead: 'propose_section_edit' })
    expect(r.error).toContain('"product"')
    expect(s.writes()).toBe(0)
  })

  it('an ordinary document is edited as before', async () => {
    const s = store()
    const r = await run(s, 'replace_section', { document_id: DOC, section: 'Positioning', new_text: 'For teams.' })
    expect(r.success).toBe(true)
    expect(s.writes()).toBe(1)
  })

  it('update_document may still retitle or pin a canon document (no text change)', async () => {
    const s = store({ canonKey: 'product' })
    const r = await run(s, 'update_document', { document_id: DOC, is_pinned: true })
    expect(r.success).toBe(true)
  })

  it('restoring a version the person asked for still works on a canon document', async () => {
    const s = store({ canonKey: 'product' })
    const r = await run(s, 'restore_document_revision', { document_id: DOC, revision: 2, base_revision: 3 })
    expect(r.success).toBe(true)
  })
})
