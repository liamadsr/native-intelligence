/**
 * GEN-1169: the agent archives, restores and deletes documents.
 *
 *   archive_document  the soft delete (status 'archived'), by the app's
 *                     delete-level rule (creator or admin), never a canon
 *                     document; nothing about the text or its history changes.
 *   restore_document  puts archived ones back (edit-level).
 *   archive_reports   many skill or loop reports in one call, by age, window,
 *                     title or skill; pinned ones are left alone; the result
 *                     hands back the ids restore_document takes.
 *   delete_document   the hard delete: never immediate (the person's card),
 *                     and on the replay of their Accept only while the
 *                     document is still at the revision the card showed.
 *                     Never a canon document, card or not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createFakeSupabase, type FakeQuery, type FakeResult } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'
import { createDocumentTools } from '../documents'
import type { ApprovedCall } from '@/lib/safety/approved-call'

vi.mock('@/lib/ai/embeddings', () => ({ indexDocument: vi.fn(async () => ({ chunksCreated: 0 })) }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({}) }))
const raiseCard = vi.fn(async (..._args: unknown[]) => ({ ok: true, approval_id: '99999999-9999-4999-8999-999999999999' }))
vi.mock('@/lib/documents/delete-card', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/documents/delete-card')>()
  return { ...real, raiseDocumentDeleteCard: (...args: unknown[]) => raiseCard(...args) }
})

const USER = 'user-1'
const WS = 'ws-1'
const ME = 'mem-1'
const OTHER = 'mem-2'
const OPTS = { toolCallId: 't', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>
type Result = Record<string, unknown> & { success: boolean; error?: string; code?: string; message?: string }

const id = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`
const MINE = id(1)
const THEIRS = id(2)
const CANON = id(3)
const ARCHIVED = id(4)

interface Doc {
  id: string
  title: string
  created_by: string | null
  status: 'active' | 'archived'
  canon_key?: string | null
  visibility?: string
  revision?: number
  workspace_id?: string
}

const WS2 = 'ws-2'
const FOREIGN = id(8)
const PRIVATE = id(9)

const DOCS: Doc[] = [
  { id: MINE, title: 'Morning brief — 2026-09-03', created_by: ME, status: 'active', revision: 2 },
  { id: THEIRS, title: 'Their notes', created_by: OTHER, status: 'active' },
  { id: CANON, title: 'Product', created_by: ME, status: 'active', canon_key: 'product' },
  { id: ARCHIVED, title: 'Old prep', created_by: ME, status: 'archived' },
  // Another workspace the caller isn't in, and a teammate's private document.
  { id: FOREIGN, title: 'Secret plan', created_by: 'mem-x', status: 'active', workspace_id: WS2 },
  { id: PRIVATE, title: 'Their diary', created_by: OTHER, status: 'active', visibility: 'private' },
]

interface Report {
  id: string
  title: string
  created_at: string
  is_pinned?: boolean
  created_by?: string | null
}

function store(
  opts: { role?: string; reports?: Report[]; approvedCall?: ApprovedCall; omitPrivate?: boolean; mine?: Doc[] } = {},
) {
  const docs = new Map([...DOCS, ...(opts.mine ?? [])].map((d) => [d.id, { workspace_id: WS, ...d }]))
  const fake = createFakeSupabase((q: FakeQuery): FakeResult => {
    const eq = (column: string) => q.filters.find(([m, c]) => m === 'eq' && c === column)?.[2]
    if (q.table === 'member') {
      // A member of ws-1 only.
      if (eq('workspace_id') !== WS) return { data: null, error: null }
      return { data: { id: ME, role: opts.role ?? 'member', workspace: { settings: {} } }, error: null }
    }
    if (q.table === 'document' && q.op === 'select') {
      // archive_reports' candidate reads (unpinned to archive, pinned to report).
      if (eq('kind') !== undefined) {
        const rows = (opts.reports ?? [])
          .map((r) => ({ is_pinned: false, created_by: ME, ...r }))
          .filter((r) => r.is_pinned === eq('is_pinned'))
          .filter((r) => eq('created_by') === undefined || r.created_by === eq('created_by'))
          .filter((r) => docs.get(r.id)?.status === 'active')
        return { data: rows, error: null }
      }
      const inIds = q.filters.find(([m, c]) => m === 'in' && c === 'id')?.[2] as string[] | undefined
      const eqId = eq('id') as string | undefined
      const ws = eq('workspace_id') as string | undefined
      const picked = [...docs.values()]
        .filter((d) => (inIds ? inIds.includes(d.id) : eqId ? d.id === eqId : true))
        .filter((d) => ws === undefined || d.workspace_id === ws)
      const rows = picked.map((d) => ({
        type: 'note',
        slug: null,
        published_status: 'published',
        frontmatter: {},
        project_id: null,
        canon_key: null,
        visibility: 'workspace',
        revision: 1,
        ...d,
      }))
      return { data: rows, error: null }
    }
    if (q.table === 'document' && q.op === 'update') {
      const ids = (q.filters.find(([m, c]) => m === 'in' && c === 'id')?.[2] as string[]) ?? []
      const next = (q.payload as { status: Doc['status'] }).status
      const written = ids.filter((i) => docs.get(i)?.status === eq('status') && docs.get(i)?.workspace_id === eq('workspace_id'))
      for (const i of written) docs.get(i)!.status = next
      return { data: written.map((i) => ({ id: i })), error: null }
    }
    if (q.table === 'rpc:delete_document_with_knowledge') {
      docs.delete((q.payload as { p_document_id: string }).p_document_id)
      return { data: {}, error: null }
    }
    return { data: null, error: null }
  })
  const tools = createDocumentTools(USER, fake.client, WS, false, 'session', opts.omitPrivate ?? false, 'workspace', {
    conversationId: 'conv-1',
    approvedCall: opts.approvedCall,
  })
  const run = (name: string, input: Record<string, unknown>) =>
    (tools as unknown as Record<string, { execute: (i: unknown, o: unknown) => Promise<Result> }>)[name].execute(input, OPTS)
  const writes = () => fake.log.filter((q) => q.op === 'update' || q.op === 'rpc')
  const reportReads = () => fake.log.filter((q) => q.table === 'document' && q.filters.some(([m, c]) => m === 'eq' && c === 'kind'))
  return { run, docs, log: fake.log, writes, reportReads }
}

beforeEach(() => raiseCard.mockClear())

describe('archive_document', () => {
  it('archives a document its creator holds, keeping it (status only, no text change)', async () => {
    const s = store()
    const r = await run(s, 'archive_document', { document_ids: [MINE] })
    expect(r.success).toBe(true)
    expect(r.archived).toEqual([{ id: MINE, workspace_id: WS, title: 'Morning brief — 2026-09-03' }])
    expect(s.docs.get(MINE)!.status).toBe('archived')
    const update = s.writes()[0]
    expect(update.payload).toEqual({ status: 'archived' })
    expect(r.message).toContain('restore_document')
  })

  it('never archives a canon document, and a member never archives someone else\'s', async () => {
    const s = store()
    const r = await run(s, 'archive_document', { document_ids: [CANON, THEIRS] })
    expect(r.success).toBe(false)
    expect(r.refused).toEqual([
      { id: CANON, reason: expect.stringContaining('system document') },
      { id: THEIRS, reason: 'Only the creator or an admin can archive this document.' },
    ])
    expect(s.writes()).toHaveLength(0)
  })

  it('an admin archives anyone\'s (but still never a canon one)', async () => {
    const s = store({ role: 'admin' })
    const r = await run(s, 'archive_document', { document_ids: [THEIRS, CANON] })
    expect(r.success).toBe(true)
    expect((r.archived as Array<{ id: string }>).map((d) => d.id)).toEqual([THEIRS])
    expect(s.docs.get(CANON)!.status).toBe('active')
  })

  it('reports one already archived, and an id that is nowhere as not found', async () => {
    const s = store()
    const unknown = id(7)
    const r = await run(s, 'archive_document', { document_ids: [ARCHIVED, unknown] })
    expect(r.already_archived).toEqual([{ id: ARCHIVED, workspace_id: WS, title: 'Old prep' }])
    expect(r.refused).toEqual([{ id: unknown, reason: 'Document not found' }])
    expect(s.writes()).toHaveLength(0)
  })

  it("another workspace's document and a teammate's private one read as not found, and their titles appear nowhere", async () => {
    const s = store({ role: 'owner' })
    const r = await run(s, 'archive_document', { document_ids: [FOREIGN, PRIVATE] })
    expect(r.success).toBe(false)
    expect(r.refused).toEqual([
      { id: FOREIGN, reason: 'Document not found' },
      { id: PRIVATE, reason: 'Document not found' },
    ])
    expect(JSON.stringify(r)).not.toMatch(/Secret plan|Their diary/)
    expect(s.writes()).toHaveLength(0)
  })

  it('a run that omits private documents never archives one, even its own', async () => {
    const own: Doc = { id: id(6), title: 'My private draft', created_by: ME, status: 'active', visibility: 'private' }
    const s = store({ omitPrivate: true, mine: [own] })
    const r = await run(s, 'archive_document', { document_ids: [own.id] })
    expect(r.refused).toEqual([{ id: own.id, reason: 'Document not found' }])
    expect(JSON.stringify(r)).not.toContain('My private draft')
    expect(s.writes()).toHaveLength(0)
  })

  it('an id in uppercase is the same document', async () => {
    const hex: Doc = { id: 'abcdef12-3456-4abc-8def-abcdef123456', title: 'Duplicate', created_by: ME, status: 'active' }
    const s = store({ mine: [hex] })
    const r = await run(s, 'archive_document', { document_ids: [hex.id.toUpperCase()] })
    expect((r.archived as Array<{ id: string }>).map((d) => d.id)).toEqual([hex.id])
  })
})

describe('restore_document', () => {
  it('puts an archived document back, naming its editor', async () => {
    const s = store()
    const r = await run(s, 'restore_document', { document_ids: [ARCHIVED, MINE] })
    expect(r.success).toBe(true)
    expect(r.restored).toEqual([{ id: ARCHIVED, workspace_id: WS, title: 'Old prep' }])
    expect(r.not_archived).toEqual([{ id: MINE, workspace_id: WS, title: 'Morning brief — 2026-09-03' }])
    expect(s.docs.get(ARCHIVED)!.status).toBe('active')
    expect(s.writes()[0].payload).toEqual({ status: 'active', last_edited_by: ME })
  })
})

describe('archive_reports', () => {
  const REPORTS: Report[] = [
    { id: id(5), title: 'Morning brief — 2026-09-01', created_at: '2026-09-01T07:00:00Z' },
    { id: id(6), title: 'Morning brief — 2026-09-02', created_at: '2026-09-02T07:00:00Z', is_pinned: true },
    { id: id(7), title: 'Morning brief — 2026-09-03', created_at: '2026-09-03T07:00:00Z' },
    // A teammate's report of the same skill.
    { id: id(2), title: 'Morning brief — 2026-09-04', created_at: '2026-09-04T07:00:00Z', created_by: OTHER },
  ]
  const withReports = (role = 'owner') => {
    const s = store({ role, reports: REPORTS })
    for (const r of REPORTS) s.docs.set(r.id, { id: r.id, title: r.title, created_by: r.created_by ?? ME, status: 'active', workspace_id: WS })
    return s
  }

  afterEach(() => vi.useRealTimers())

  it('needs a filter, archiving nothing without one (a title of only * is none)', async () => {
    const s = withReports()
    for (const input of [{}, { title: '**' }]) {
      const r = await run(s, 'archive_reports', input)
      expect(r.success).toBe(false)
    }
    expect(s.log.filter((q) => q.table === 'document')).toHaveLength(0)
  })

  it('refuses a bound that does not parse rather than widening to everything', async () => {
    const s = withReports()
    const r = await run(s, 'archive_reports', { since: 'the other day', title: 'Morning brief' })
    expect(r.success).toBe(false)
    expect(s.writes()).toHaveLength(0)
  })

  it("archives last month's reports of one skill in one call, the person's own only, leaves the pinned one, and hands back the ids", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 27, 12, 0, 0))
    const s = withReports()
    const r = await run(s, 'archive_reports', { since: 'last_month', until: 'last_month', title: 'Morning brief' })
    expect(r.success).toBe(true)
    expect((r.archived as Array<{ id: string }>).map((d) => d.id)).toEqual([id(5), id(7)])
    expect(r.left_pinned).toEqual([{ id: id(6), title: 'Morning brief — 2026-09-02' }])
    expect(s.docs.get(id(6))!.status).toBe('active')
    // The teammate's report is theirs: untouched.
    expect(s.docs.get(id(2))!.status).toBe('active')

    // Only active, unpinned reports of the person's own, never a canon
    // document, visible to them, in September, by title.
    const [read, pinnedRead] = s.reportReads()
    expect(read.filters).toEqual(
      expect.arrayContaining([
        ['eq', 'kind', 'report'],
        ['eq', 'status', 'active'],
        ['eq', 'is_pinned', false],
        ['eq', 'created_by', ME],
        ['is', 'canon_key', null],
        ['or', `visibility.eq.workspace,created_by.eq.${ME}`],
        ['ilike', 'title', '%Morning brief%'],
        ['gte', 'created_at', new Date(2026, 8, 1).toISOString()],
        ['lte', 'created_at', new Date(2026, 8, 30, 23, 59, 59, 999).toISOString()],
      ]),
    )
    expect(pinnedRead.filters).toContainEqual(['eq', 'is_pinned', true])

    // Undo is one call with those ids.
    const back = await run(s, 'restore_document', { document_ids: [id(5), id(7)] })
    expect((back.restored as unknown[]).length).toBe(2)
    expect(s.docs.get(id(5))!.status).toBe('active')
  })

  it("an owner may include teammates' reports; a member may not", async () => {
    const owner = withReports('owner')
    const r = await run(owner, 'archive_reports', { title: 'Morning brief', include_others: true })
    expect((r.archived as Array<{ id: string }>).map((d) => d.id)).toEqual([id(5), id(7), id(2)])
    expect(owner.reportReads()[0].filters.some(([m, c]) => m === 'eq' && c === 'created_by')).toBe(false)

    const member = withReports('member')
    const refused = await run(member, 'archive_reports', { title: 'Morning brief', include_others: true })
    expect(refused.success).toBe(false)
    expect(member.writes()).toHaveLength(0)
  })

  it('a run that omits private documents reads workspace reports only', async () => {
    const s = store({ role: 'owner', reports: REPORTS, omitPrivate: true })
    await run(s, 'archive_reports', { older_than_days: 30 })
    expect(s.reportReads()[0].filters).toContainEqual(['eq', 'visibility', 'workspace'])
  })

  it('older_than_days reads as created before the cutoff; a skill_id matches its stamp', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-27T12:00:00Z'))
    const s = withReports()
    await run(s, 'archive_reports', { older_than_days: 30, skill_id: id(4) })
    expect(s.reportReads()[0].filters).toEqual(
      expect.arrayContaining([['lt', 'created_at', '2026-09-27T12:00:00.000Z'], ['eq', 'frontmatter->>skill_id', id(4)]]),
    )
  })

  it('escapes LIKE characters in the title, and drops a * (PostgREST would read it as a wildcard)', async () => {
    const s = withReports()
    await run(s, 'archive_reports', { title: '100%_done*' })
    expect(s.reportReads()[0].filters).toContainEqual(['ilike', 'title', '%100\\%\\_done%'])
  })
})

describe('delete_document', () => {
  it('raises the person\'s card and deletes nothing', async () => {
    const s = store()
    const r = await run(s, 'delete_document', { document_id: MINE })
    expect(r).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED', approval_id: '99999999-9999-4999-8999-999999999999' })
    expect(raiseCard).toHaveBeenCalledTimes(1)
    const req = raiseCard.mock.calls[0][1] as { input: Record<string, unknown>; context: unknown; conversationId: string; card: { title: string } }
    expect(req.input).toMatchObject({ document_id: MINE, revision: 2 })
    expect(req.context).toEqual({ kind: 'delete', document_id: MINE, revision: 2 })
    expect(req.conversationId).toBe('conv-1')
    expect(req.card.title).toContain('Morning brief')
    expect(s.writes()).toHaveLength(0)
  })

  it('never offers a card for a canon document', async () => {
    const s = store({ role: 'owner' })
    const r = await run(s, 'delete_document', { document_id: CANON })
    expect(r).toMatchObject({ success: false, code: 'SYSTEM_DOCUMENT' })
    expect(raiseCard).not.toHaveBeenCalled()
  })

  it('refuses a member someone else\'s document, without a card', async () => {
    const s = store()
    const r = await run(s, 'delete_document', { document_id: THEIRS })
    expect(r.success).toBe(false)
    expect(r.error).toBe('Only the creator or an admin can delete this document.')
    expect(raiseCard).not.toHaveBeenCalled()
  })

  it('the accepted card deletes it, through the app\'s own delete', async () => {
    const approvedCall: ApprovedCall = { approvalId: 'a-1', tool: 'delete_document', document: { kind: 'delete', document_id: MINE, revision: 2 } }
    const s = store({ approvedCall })
    const r = await run(s, 'delete_document', { document_id: MINE })
    expect(r.success).toBe(true)
    const rpc = s.log.find((q) => q.op === 'rpc')!
    expect(rpc.table).toBe('rpc:delete_document_with_knowledge')
    expect(rpc.payload).toEqual({ p_document_id: MINE, p_workspace_id: WS, p_user_id: USER })
    expect(raiseCard).not.toHaveBeenCalled()
  })

  it('an accepted card for an older revision deletes nothing', async () => {
    const approvedCall: ApprovedCall = { approvalId: 'a-1', tool: 'delete_document', document: { kind: 'delete', document_id: MINE, revision: 1 } }
    const s = store({ approvedCall })
    const r = await run(s, 'delete_document', { document_id: MINE })
    expect(r).toMatchObject({ success: false, code: 'DOCUMENT_CHANGED' })
    expect(s.writes()).toHaveLength(0)
  })

  it("another tool's approval, or another document's, is no card for this one", async () => {
    const other: ApprovedCall = { approvalId: 'a-1', tool: 'delete_document', document: { kind: 'delete', document_id: THEIRS, revision: 1 } }
    const s = store({ approvedCall: other })
    const r = await run(s, 'delete_document', { document_id: MINE })
    expect(r.code).toBe('APPROVAL_REQUIRED')
    expect(s.writes()).toHaveLength(0)
  })
})

describe('list_documents', () => {
  it('lists archived documents only when asked', async () => {
    const s = store()
    await run(s, 'list_documents', { archived: true, include_reports: true })
    await run(s, 'list_documents', {})
    const lists = s.log.filter((q) => q.table === 'document' && q.columns.includes('kind'))
    expect(lists[0].filters).toContainEqual(['eq', 'status', 'archived'])
    expect(lists[1].filters).toContainEqual(['neq', 'status', 'archived'])
  })
})

function run(s: ReturnType<typeof store>, name: string, input: Record<string, unknown>) {
  return s.run(name, input)
}
