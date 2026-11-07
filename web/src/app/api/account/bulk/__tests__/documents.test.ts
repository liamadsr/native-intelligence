/**
 * POST /api/account/bulk for documents (other than delete): the table is
 * `document` (the mapping said `documents`, a table that doesn't exist, so
 * every bulk archive / pin / move 500'd), and each row goes through migration
 * 359's creator-or-admin rule the way /api/account/documents/[id] applies it:
 *   - archive (and change_status to archived) is delete-level and writes on
 *     the service client after the check (like the single archive); any other
 *     status is an edit, like the single PATCH;
 *   - pin / unpin / set_project are edit-level and write on the session client
 *     (like the single PATCH), so RLS and the guard back the check up.
 * A refused row is reported per id ("Not allowed"); the rest still go through.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import {
  createFakeSupabase,
  type FakeQuery,
  type FakeResult,
} from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'

const WS = 'ws-1'
const USER = 'user-1'
const ME = 'mem-me'
const OTHER = 'mem-other'

type Doc = Record<string, unknown> & { id: string }

const docRow = (id: string, extra: Partial<Doc> = {}): Doc => ({
  id,
  workspace_id: WS,
  created_by: ME,
  type: 'note',
  slug: null,
  published_status: 'published',
  frontmatter: {},
  project_id: null,
  status: 'active',
  ...extra,
})

const DOCS: Record<string, Doc> = {
  mine: docRow('doc-mine'),
  theirs: docRow('doc-theirs', { created_by: OTHER }),
  // A shared wiki page: any member may edit it, only its creator or an admin archive or move it.
  shared: docRow('doc-shared', { created_by: OTHER, slug: 'onboarding' }),
  sharedArchived: docRow('doc-shared-archived', { created_by: OTHER, slug: 'old-onboarding', status: 'archived' }),
  // A spec page: its creator may archive it but not edit it.
  mySpec: docRow('doc-myspec', { type: 'spec', slug: 'api-ref' }),
}

const state = vi.hoisted(() => ({
  member: null as unknown,
  /** Ids an update returns; null means every id it targeted. */
  writtenIds: null as string[] | null,
  session: null as unknown as { client: unknown; log: FakeQuery[] },
  service: null as unknown as { client: unknown; log: FakeQuery[] },
}))

function inIds(q: FakeQuery): string[] {
  const f = q.filters.find(([m, c]) => m === 'in' && c === 'id')
  return f ? (f[2] as string[]) : []
}

function resolver(q: FakeQuery): FakeResult {
  if (q.table === 'member') return { data: state.member, error: null }
  if (q.table === 'document' && q.op === 'select') {
    const ids = inIds(q)
    return { data: Object.values(DOCS).filter((d) => ids.includes(d.id)), error: null }
  }
  if (q.table === 'document' && q.op === 'update') {
    const ids = inIds(q).filter((id) => state.writtenIds === null || state.writtenIds.includes(id))
    return { data: ids.map((id) => ({ id })), error: null }
  }
  return { data: null, error: null }
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    const c = state.session.client as Record<string, unknown>
    return { ...c, auth: { getUser: async () => ({ data: { user: { id: USER } } }) } }
  },
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => state.service.client }))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => WS }))
vi.mock('@/lib/flows/emit-status-change', () => ({ emitStatusChange: vi.fn() }))
vi.mock('@/lib/crm/delete-companies', () => ({ deleteCompaniesWithContacts: vi.fn() }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspaceFeature: vi.fn(async () => null) }))
vi.mock('@/app/api/account/evals/delete-captures', () => ({
  deleteEvalCaptures: vi.fn(),
  collectTrialCaptureIds: vi.fn(async () => []),
}))

const { POST } = await import('@/app/api/account/bulk/route')

function bulk(action: string, ids: string[], value?: unknown): Promise<Response> {
  return POST(
    buildRequest({
      url: 'https://dial8.ai/api/account/bulk',
      method: 'POST',
      body: { entity_type: 'document', ids, action, value },
    }) as unknown as NextRequest,
  )
}

type Result = { success: number; failed: number; errors?: string[] }
const writes = (log: FakeQuery[]) => log.filter((q) => q.op === 'update')

beforeEach(() => {
  state.member = { id: ME, role: 'member', workspace: { settings: {} } }
  state.writtenIds = null
  state.session = createFakeSupabase(resolver) as unknown as typeof state.session
  state.service = createFakeSupabase(resolver) as unknown as typeof state.service
})

describe('the table', () => {
  it('reads and writes `document`, never `documents`', async () => {
    const res = await bulk('pin', [DOCS.mine.id])
    expect(res.status).toBe(200)
    const tables = [...state.session.log, ...state.service.log].map((q) => q.table)
    expect(tables).toContain('document')
    expect(tables).not.toContain('documents')
    expect(writes(state.session.log)[0].table).toBe('document')
  })
})

describe('archive (delete-level)', () => {
  it('archives the rows the caller may delete and reports the rest as Not allowed', async () => {
    const ids = [DOCS.mine.id, DOCS.theirs.id, DOCS.shared.id, DOCS.mySpec.id]
    const res = await bulk('archive', ids)
    expect(res.status).toBe(200)
    const json = await readJson<Result>(res)
    expect(json).toEqual({
      success: 2,
      failed: 2,
      errors: [`${DOCS.theirs.id}: Not allowed`, `${DOCS.shared.id}: Not allowed`],
    })
    // One write, on the service client, for the allowed rows only (the creator
    // of a spec page archives it though they can't edit it).
    const [w] = writes(state.service.log)
    expect(w.table).toBe('document')
    expect(w.payload).toEqual({ status: 'archived' })
    expect(inIds(w)).toEqual([DOCS.mine.id, DOCS.mySpec.id])
    expect(w.filters).toContainEqual(['eq', 'workspace_id', WS])
    expect(writes(state.session.log)).toHaveLength(0)
  })

  it('an admin archives every row', async () => {
    state.member = { id: 'mem-admin', role: 'admin', workspace: { settings: {} } }
    const ids = [DOCS.mine.id, DOCS.theirs.id, DOCS.shared.id]
    const json = await readJson<Result>(await bulk('archive', ids))
    expect(json).toEqual({ success: 3, failed: 0 })
    expect(inIds(writes(state.service.log)[0])).toEqual(ids)
  })

  it('the product doc is a system document: nobody archives it, an owner neither (migration 366)', async () => {
    state.member = { id: ME, role: 'member', workspace: { settings: { product_doc: { document_id: DOCS.mine.id } } } }
    const json = await readJson<Result>(await bulk('archive', [DOCS.mine.id]))
    expect(json).toEqual({ success: 0, failed: 1, errors: [`${DOCS.mine.id}: This is a system document. It can be edited, not deleted.`] })
    expect(writes(state.service.log)).toHaveLength(0)

    state.member = { id: ME, role: 'owner', workspace: { settings: { product_doc: { document_id: DOCS.mine.id } } } }
    const owner = await readJson<Result>(await bulk('archive', [DOCS.mine.id]))
    expect(owner.failed).toBe(1)
    expect(writes(state.service.log)).toHaveLength(0)
  })

  it('a row not in the workspace is reported as not found', async () => {
    const json = await readJson<Result>(await bulk('archive', ['doc-elsewhere', DOCS.mine.id]))
    expect(json).toEqual({ success: 1, failed: 1, errors: ['doc-elsewhere: Document not found'] })
  })

  it('change_status to archived is delete-level, like archive', async () => {
    const json = await readJson<Result>(await bulk('change_status', [DOCS.mySpec.id, DOCS.shared.id], 'archived'))
    expect(json).toEqual({ success: 1, failed: 1, errors: [`${DOCS.shared.id}: Not allowed`] })
    expect(writes(state.service.log)[0].payload).toEqual({ status: 'archived' })
  })

  it('change_status to any other status (un-archiving) is an edit: the PATCH rule on the session client', async () => {
    // The creator of a spec page may archive it, but not edit it back: only an
    // owner/admin edits a spec page. A shared page's status belongs to its creator.
    const json = await readJson<Result>(
      await bulk('change_status', [DOCS.mine.id, DOCS.mySpec.id, DOCS.sharedArchived.id], 'active'),
    )
    expect(json).toEqual({
      success: 1,
      failed: 2,
      errors: [`${DOCS.mySpec.id}: Not allowed`, `${DOCS.sharedArchived.id}: Not allowed`],
    })
    expect(writes(state.service.log)).toHaveLength(0)
    expect(writes(state.session.log)[0].payload).toMatchObject({ status: 'active' })
  })
})

describe('pin (edit-level)', () => {
  it('pins the rows the caller may edit on the session client and reports the rest as Not allowed', async () => {
    const ids = [DOCS.mine.id, DOCS.theirs.id, DOCS.shared.id, DOCS.mySpec.id]
    const res = await bulk('pin', ids)
    expect(res.status).toBe(200)
    const json = await readJson<Result>(res)
    expect(json).toEqual({
      success: 2,
      failed: 2,
      errors: [`${DOCS.theirs.id}: Not allowed`, `${DOCS.mySpec.id}: Not allowed`],
    })
    const [w] = writes(state.session.log)
    expect(w.table).toBe('document')
    expect(w.payload).toEqual({ is_pinned: true, last_edited_by: ME })
    expect(inIds(w)).toEqual([DOCS.mine.id, DOCS.shared.id])
    expect(w.filters).toContainEqual(['eq', 'workspace_id', WS])
    expect(writes(state.service.log)).toHaveLength(0)
  })

  it('a row RLS refuses (not returned by the write) is Not allowed, not a batch failure', async () => {
    state.writtenIds = [DOCS.mine.id]
    const json = await readJson<Result>(await bulk('unpin', [DOCS.mine.id, DOCS.shared.id]))
    expect(json).toEqual({ success: 1, failed: 1, errors: [`${DOCS.shared.id}: Not allowed`] })
  })

  it('a guest pins nothing and nothing is written', async () => {
    state.member = { id: ME, role: 'guest', workspace: { settings: {} } }
    const json = await readJson<Result>(await bulk('pin', [DOCS.mine.id]))
    expect(json).toEqual({ success: 0, failed: 1, errors: [`${DOCS.mine.id}: Not allowed`] })
    expect(writes(state.session.log)).toHaveLength(0)
  })
})

describe('set_project (edit-level, creator or admin)', () => {
  it('a member who may edit a shared page still may not move it into a project', async () => {
    const json = await readJson<Result>(await bulk('set_project', [DOCS.mine.id, DOCS.shared.id], 'proj-1'))
    expect(json).toEqual({ success: 1, failed: 1, errors: [`${DOCS.shared.id}: Not allowed`] })
    const [w] = writes(state.session.log)
    expect(w.payload).toEqual({ project_id: 'proj-1', last_edited_by: ME })
    expect(inIds(w)).toEqual([DOCS.mine.id])
  })
})
