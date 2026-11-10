/**
 * update_now (docs/plans/now-file.md "The tool") and the Now file in the
 * agent's searches. update_now writes only where the tool route said who
 * writes (nowContext.writer, the person's own main chat): anywhere else it
 * refuses and writes nothing, the second fence behind the attended-only set.
 * find and search drop the note outside the person's main chat, and keep it
 * there.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createFakeSupabase, eqValue, type FakeQuery, type FakeResult } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'
import { createNowTools } from '../now'
import { createSearchTools } from '../search'

vi.mock('@/lib/ai/embeddings', () => ({ embed: vi.fn(async () => [0.1, 0.2]) }))
vi.mock('@/lib/agent-events/member-time-zone', () => ({ readMemberTimeZone: vi.fn(async () => ({ timeZone: 'UTC', source: 'utc' })) }))

const USER = 'user-1'
const WS = 'ws-1'
const OPTS = { toolCallId: 't', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

function client() {
  const writes: FakeQuery[] = []
  const inserts: FakeQuery[] = []
  let note: Record<string, unknown> | null = null
  const fake = createFakeSupabase((q): FakeResult => {
    if (q.table === 'member') return { data: { id: 'mem-1' }, error: null }
    if (q.table !== 'document') return { data: null, error: null }
    if (q.op === 'insert') {
      inserts.push(q)
      note = { id: 'doc-now', workspace_id: WS, created_by: 'mem-1', content: '', revision: 1, frontmatter: (q.payload as { frontmatter: unknown }).frontmatter, updated_at: 't' }
      return { data: note, error: null }
    }
    if (q.op === 'update') {
      writes.push(q)
      return { data: [{ id: 'doc-now', revision: 2 }], error: null }
    }
    return { data: note, error: null }
  })
  return { client: fake.client, writes, inserts }
}

const input = { edits: [{ op: 'add', section: 'Focus', text: 'Guest access to PROD this week' }], summary: 'Noted the focus' }
const exec = (tools: ReturnType<typeof createNowTools>, i: unknown) =>
  (tools.update_now as unknown as { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(i, OPTS)

describe('update_now', () => {
  it('refuses where no writer was given, writing and creating nothing', async () => {
    for (const ctx of [undefined, {}, { readable: true }]) {
      const c = client()
      const r = await exec(createNowTools(USER, c.client, WS, ctx), input)
      expect(r).toMatchObject({ success: false, code: 'NOW_NOT_HERE' })
      expect(c.writes).toHaveLength(0)
      expect(c.inserts).toHaveLength(0)
    }
  })

  it('writes as the writer the route named, and returns only the revision and the changed lines', async () => {
    const c = client()
    const r = await exec(createNowTools(USER, c.client, WS, { writer: 'chat', readable: true }), input)
    expect(r).toEqual({
      success: true,
      document_id: 'doc-now',
      revision: 2,
      created: true,
      changed: [{ op: 'add', section: 'Focus', text: expect.stringMatching(/^- Guest access to PROD this week \([A-Z][a-z]{2} \d{1,2}\)$/), line: 2 }],
    })
    expect(c.writes[0].payload).toMatchObject({ edit_meta: { writer: 'chat' }, edit_source: 'agent' })
  })

  it('advertises the six headings and the track kinds in its schema', () => {
    const shape = (createNowTools(USER, client().client, WS).update_now as unknown as { inputSchema: { safeParse: (v: unknown) => { success: boolean } } }).inputSchema
    expect(shape.safeParse({ edits: [{ op: 'add', section: 'In flight', text: 'x', track: { kind: 'work', id: 'job-1' } }], summary: 's' }).success).toBe(true)
    expect(shape.safeParse({ edits: [{ op: 'add', section: 'Someday', text: 'x' }], summary: 's' }).success).toBe(false)
    expect(shape.safeParse({ edits: [{ op: 'add', section: 'Focus', text: 'x', track: { kind: 'email', id: 'x' } }], summary: 's' }).success).toBe(false)
    expect(shape.safeParse({ edits: [] }).success).toBe(false)
  })
})

describe('the Now file in find and search', () => {
  function searchClient() {
    const hits = [
      { result_type: 'document', result_id: 'doc-now', title: 'Now', score: 0.9, event_at: null, fts_rank: 1, vec_rank: null, recency_rank: 1, excerpt: 'Guest access', source_label: 'Document', source_type: 'document', metadata: {} },
      { result_type: 'document', result_id: 'doc-2', title: 'Plan', score: 0.5, event_at: null, fts_rank: 2, vec_rank: 2, recency_rank: 2, excerpt: 'x', source_label: 'Document', source_type: 'document', metadata: {} },
      // A teammate's Now file (a grant could open it): never anyone else's to read, main chat or not.
      { result_type: 'document', result_id: 'doc-their-now', title: 'Now', score: 0.4, event_at: null, fts_rank: 3, vec_rank: null, recency_rank: 3, excerpt: 'y', source_label: 'Document', source_type: 'document', metadata: {} },
    ]
    const fake = createFakeSupabase((q): FakeResult => {
      if (q.table === 'rpc:hybrid_search') return { data: hits, error: null }
      if (q.table === 'rpc:unified_search') return { data: hits.map((h) => ({ result_type: h.result_type, result_id: h.result_id, title: h.title, rank: 1 })), error: null }
      if (q.table === 'document' && eqValue(q, 'kind') === 'now') {
        return { data: [{ id: 'doc-now', created_by: 'mem-1' }, { id: 'doc-their-now', created_by: 'mem-zoe' }], error: null }
      }
      if (q.table === 'member' && eqValue(q, 'user_id') === USER) return { data: [{ id: 'mem-1' }], error: null }
      if (q.table === 'workspace') return { data: { name: 'WS' }, error: null }
      return { data: [], error: null }
    })
    return fake.client
  }
  const ids = (r: unknown) => ((r as { results: Array<{ result_id: string }> }).results ?? []).map((x) => x.result_id)
  const tool = (readable: boolean, name: 'find' | 'search') =>
    (createSearchTools(USER, searchClient(), WS, false, 'all_time', false, readable)[name] as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute

  it('find drops it outside the person’s main chat and keeps it there; never a teammate’s Now file', async () => {
    expect(ids(await tool(false, 'find')({ query: 'guest access' }, OPTS))).toEqual(['doc-2'])
    expect(ids(await tool(true, 'find')({ query: 'guest access' }, OPTS))).toEqual(['doc-now', 'doc-2'])
  })

  it('search does too', async () => {
    expect(ids(await tool(false, 'search')({ query: 'guest access', types: ['document'] }, OPTS))).toEqual(['doc-2'])
    expect(ids(await tool(true, 'search')({ query: 'guest access', types: ['document'] }, OPTS))).toEqual(['doc-now', 'doc-2'])
  })
})
