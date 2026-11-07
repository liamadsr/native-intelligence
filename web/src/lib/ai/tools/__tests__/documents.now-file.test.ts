/**
 * The person's Now file through the ordinary document tools (migration 440,
 * docs/plans/now-file.md): every tool that would change it refuses and points
 * at update_now, writing nothing (they aren't attended-only, so otherwise a
 * background turn could write it through them). get_document and the history
 * tools read it only in the person's own main chat (nowReadable); everywhere
 * else they refuse. An ordinary document is untouched by all of it.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createFakeSupabase, type FakeQuery, type FakeResult } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'
import { createDocumentTools } from '../documents'
import { NOW_EDIT_REFUSAL, NOW_READ_REFUSAL } from '@/lib/now/now-stamp'

vi.mock('@/lib/ai/embeddings', () => ({ indexDocument: vi.fn(async () => ({ chunksCreated: 0 })) }))

const USER = 'user-1'
const WS = 'ws-1'
const DOC = '22222222-2222-4222-8222-222222222222'
const OPTS = { toolCallId: 't', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>
type Result = Record<string, unknown> & { success: boolean; error?: string; use_instead?: string; code?: string }

const BODY = ['## Focus', '- Guest access to PROD (Oct 24)', '', '## In flight', '- A helper is drafting the Acme follow-up (Oct 26)'].join('\n')

function store(opts: { nowFile?: boolean; readable?: boolean } = {}) {
  let writes = 0
  const frontmatter = opts.nowFile === false ? {} : { now: { tracks: [] } }
  const fake = createFakeSupabase((q: FakeQuery): FakeResult => {
    if (q.table === 'member') return { data: { id: 'mem-1', role: 'owner', workspace_id: WS, user_id: USER, workspace: { settings: {} } }, error: null }
    if (q.table === 'document_revision') return { data: [{ revision_number: 2, title: 'Now', content: 'old', frontmatter, created_at: 't', updated_at: 't' }], error: null }
    if (q.table === 'document_draft') return { data: { document_id: DOC, title: null, content: 'draft', base_revision: 3, updated_at: 't' }, error: null }
    if (q.table === 'entity_link') return { data: [], error: null }
    if (q.table === 'document' && q.op === 'select') {
      return {
        data: { id: DOC, workspace_id: WS, created_by: 'mem-1', type: 'note', slug: null, published_status: 'published', frontmatter, project_id: null, status: 'active', canon_key: null, visibility: 'private', title: 'Now', content: BODY, revision: 3, outside_derived: false },
        error: null,
      }
    }
    if (q.table === 'document' && q.op === 'update') {
      writes++
      return { data: [{ id: DOC, title: 'Now', content: (q.payload as { content?: string }).content ?? BODY, revision: 4 }], error: null }
    }
    return { data: null, error: null }
  })
  return { tools: createDocumentTools(USER, fake.client, WS, false, 'session', false, 'workspace', { nowReadable: opts.readable === true }), writes: () => writes }
}

const run = (s: ReturnType<typeof store>, name: string, input: Record<string, unknown>) =>
  (s.tools as unknown as Record<string, { execute: (i: unknown, o: unknown) => Promise<Result> }>)[name].execute(input, OPTS)

const WRITES: Array<[string, Record<string, unknown>]> = [
  ['update_document', { document_id: DOC, content: 'all new', base_revision: 3 }],
  ['update_document', { document_id: DOC, visibility: 'workspace' }],
  ['update_document', { document_id: DOC, title: 'Not now' }],
  ['edit_document_content', { document_id: DOC, old_text: 'Guest access', new_text: 'Guests' }],
  ['edit_document_lines', { document_id: DOC, base_revision: 3, from: 2, to: 2, new_text: '- x' }],
  ['replace_section', { document_id: DOC, section: 'Focus', new_text: '- x' }],
  ['append_to_section', { document_id: DOC, section: 'Focus', text: '- x' }],
  ['remove_section', { document_id: DOC, section: 'In flight' }],
  ['insert_section_after', { document_id: DOC, after: 'Focus', heading: 'Later', text: '- x' }],
  ['restore_document_revision', { document_id: DOC, revision: 2, base_revision: 3 }],
  ['propose_document_edit', { document_id: DOC, base_revision: 3, content: 'x' }],
  ['publish_draft', { document_id: DOC }],
]

describe('the document tools never change the Now file', () => {
  it.each(WRITES)('%s refuses it and points at update_now, writing nothing (%j)', async (name, input) => {
    for (const readable of [false, true]) {
      const s = store({ readable })
      const r = await run(s, name, input)
      expect(r).toMatchObject({ success: false, use_instead: 'update_now', error: NOW_EDIT_REFUSAL })
      expect(s.writes()).toBe(0)
    }
  })

  it('an ordinary document is edited as before', async () => {
    const s = store({ nowFile: false })
    const r = await run(s, 'replace_section', { document_id: DOC, section: 'Focus', new_text: '- x' })
    expect(r.success).toBe(true)
    expect(s.writes()).toBe(1)
  })
})

describe('reading the Now file', () => {
  const READS: Array<[string, Record<string, unknown>]> = [
    ['get_document', { document_id: DOC }],
    ['get_document', { document_id: DOC, lines: { from: 1, to: 2 } }],
    ['list_document_revisions', { document_id: DOC }],
    ['get_document_revision', { document_id: DOC, revision: 2 }],
  ]

  it.each(READS)('%s refuses it outside the person’s main chat (%j)', async (name, input) => {
    const r = await run(store(), name, input)
    expect(r).toMatchObject({ success: false, code: 'NOW_FILE_PRIVATE', error: NOW_READ_REFUSAL })
    expect(JSON.stringify(r)).not.toContain('Guest access')
  })

  it.each(READS)('%s reads it in the person’s main chat (%j)', async (name, input) => {
    const r = await run(store({ readable: true }), name, input)
    expect(r.success).toBe(true)
  })

  it('an ordinary private document reads as before anywhere', async () => {
    const r = await run(store({ nowFile: false }), 'get_document', { document_id: DOC })
    expect(r.success).toBe(true)
  })
})
