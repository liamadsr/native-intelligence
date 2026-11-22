/**
 * The spreadsheet routes: list and make, read one, save against a revision
 * (409 when it moved on), rename, archive, change who sees it, delete. The
 * database is an in-memory stand-in; the row policies and the revision
 * trigger are migration 675's and are pinned in migration-675.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { memoryDb } from '@/test/memory-db'
import { loadModel } from '@/lib/spreadsheets/engine-server'
import { blankWorkbook } from '@/lib/spreadsheets/store'
import { saveWorkbook } from '@/lib/spreadsheets/workbook'

const WS = 'ws-1'
const ME = 'm-1'
const S = '33333333-3333-4333-8333-333333333333'

const hoisted = vi.hoisted(() => ({ requireWorkspaceMember: vi.fn(), requireUser: vi.fn() }))
vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: hoisted.requireWorkspaceMember,
  requireUser: hoisted.requireUser,
}))

const { GET: list, POST: create } = await import('@/app/api/account/spreadsheets/route')
const { GET: read, PATCH: patch, DELETE: remove } = await import('@/app/api/account/spreadsheets/[id]/route')
const { GET: engine } = await import('@/app/api/account/spreadsheets/engine/route')

type Row = Record<string, unknown>
let rows: Row[]
let tables: { spreadsheet: Row[] }
/** 688's spreadsheet_editable_by, as the database would answer it for the caller. */
let editable: boolean
const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
  if (name !== 'spreadsheet_editable_by') return { data: null, error: { message: `no rpc ${name}` } }
  return { data: args.p_user_id === 'u-1' && args.p_spreadsheet_id === S ? editable : false, error: null }
})

function seed(extra: Row = {}) {
  rows = [
    {
      id: S, workspace_id: WS, title: 'Hiring plan', created_by: ME, last_edited_by: ME, visibility: 'workspace',
      status: 'active', revision: 4, sheet_names: ['Sheet1'], digest: '', workbook: blankWorkbook(), extras: {},
      created_at: '2026-11-20T10:00:00Z', updated_at: '2026-11-20T10:00:00Z', ...extra,
    },
  ]
  tables = { spreadsheet: rows }
  editable = true
  hoisted.requireWorkspaceMember.mockResolvedValue({
    supabase: Object.assign(memoryDb(tables), { rpc }),
    user: { id: 'u-1' },
    workspaceId: WS,
    member: { id: ME },
  })
}

const get = (url: string) => ({ nextUrl: new URL(url) }) as unknown as NextRequest
const send = (url: string, method: string, body: unknown) => buildRequest({ url, method, body }) as unknown as NextRequest
const ctx = (id = S) => ({ params: Promise.resolve({ id }) })
const base = 'https://x.test/api/account/spreadsheets'

function workbookWith(cells: Array<[number, number, string]>): string {
  const m = loadModel(null)
  for (const [r, c, v] of cells) m.setUserInput(0, r, c, v)
  const saved = saveWorkbook(m)
  m.free()
  return saved
}

beforeEach(() => seed())

describe('GET and POST /api/account/spreadsheets', () => {
  it('lists the active ones without their workbooks', async () => {
    rows.push({ ...rows[0], id: 'other', title: 'Old', status: 'archived' })
    const res = await list(get(base))
    const json = await readJson<{ spreadsheets: Row[] }>(res)
    expect(json.spreadsheets.map((s) => s.title)).toEqual(['Hiring plan'])
    const archived = await readJson<{ spreadsheets: Row[] }>(await list(get(`${base}?archived=1`)))
    expect(archived.spreadsheets.map((s) => s.title)).toEqual(['Old'])
  })

  it('makes one with a blank workbook, as the caller', async () => {
    const res = await create(send(base, 'POST', { title: '  Q1   budget ' }))
    expect(res.status).toBe(201)
    const made = rows[1]
    expect(made).toMatchObject({ title: 'Q1 budget', created_by: ME, workspace_id: WS, visibility: 'workspace', sheet_names: ['Sheet1'] })
    const m = loadModel(made.workbook as string)
    expect(m.getWorksheetsProperties()).toHaveLength(1)
    m.free()
  })

  it('names it when no name is given, and refuses a visibility that does not exist', async () => {
    expect((await create(send(base, 'POST', {}))).status).toBe(201)
    expect(rows[1].title).toBe('Untitled spreadsheet')
    expect((await create(send(base, 'POST', { title: 'X', visibility: 'everyone' }))).status).toBe(400)
    expect((await create(send(base, 'POST', { title: 'x'.repeat(301) }))).status).toBe(400)
  })
})

describe('/api/account/spreadsheets/[id]', () => {
  it('reads one with its workbook, and 404s one that is not there', async () => {
    const json = await readJson<{ spreadsheet: Row; member_id: string }>(await read(get(`${base}/${S}`), ctx()))
    expect(json.spreadsheet.workbook).toBe(rows[0].workbook)
    expect(json.member_id).toBe(ME)
    expect((await read(get(`${base}/x`), ctx('44444444-4444-4444-8444-444444444444'))).status).toBe(404)
    expect((await read(get(`${base}/x`), ctx('not-an-id'))).status).toBe(404)
  })

  it('says whether the person may change it: spreadsheet_editable_by, for them (688)', async () => {
    const mine = await readJson<{ can_edit: boolean }>(await read(get(`${base}/${S}`), ctx()))
    expect(mine.can_edit).toBe(true)
    expect(rpc).toHaveBeenLastCalledWith('spreadsheet_editable_by', { p_spreadsheet_id: S, p_user_id: 'u-1' })
    // Shared with them to view: they read it, and the editor is read-only.
    editable = false
    const viewing = await readJson<{ spreadsheet: Row; can_edit: boolean }>(await read(get(`${base}/${S}`), ctx()))
    expect(viewing.spreadsheet.title).toBe('Hiring plan')
    expect(viewing.can_edit).toBe(false)
  })

  it('saves a workbook against the revision it was loaded at, with its sheet names and words', async () => {
    const workbook = workbookWith([[1, 1, 'Northwind Paper'], [2, 1, '=1+1']])
    const res = await patch(send(`${base}/${S}`, 'PATCH', { base_revision: 4, workbook }), ctx())
    expect(res.status).toBe(200)
    expect(rows[0]).toMatchObject({ workbook, digest: 'Sheet1 Northwind Paper', last_edited_by: ME, edit_source: 'human' })
  })

  it('refuses a save made from an older revision and says where the spreadsheet is now', async () => {
    const before = rows[0].workbook
    const res = await patch(send(`${base}/${S}`, 'PATCH', { base_revision: 3, workbook: workbookWith([[1, 1, 'late']]) }), ctx())
    expect(res.status).toBe(409)
    const json = await readJson<{ code: string; details: { current: Row } }>(res)
    expect(json.code).toBe('SPREADSHEET_REVISION_CONFLICT')
    expect(json.details.current.revision).toBe(4)
    expect(rows[0].workbook).toBe(before)
  })

  it('refuses a save that is not a workbook, or carries nothing', async () => {
    expect((await patch(send(`${base}/${S}`, 'PATCH', { base_revision: 4, workbook: 'AAAA' }), ctx())).status).toBe(400)
    expect((await patch(send(`${base}/${S}`, 'PATCH', { base_revision: 4 }), ctx())).status).toBe(400)
    expect((await patch(send(`${base}/${S}`, 'PATCH', { base_revision: 0, title: 'X' }), ctx())).status).toBe(400)
  })

  it('renames, archives and restores without a revision', async () => {
    expect((await patch(send(`${base}/${S}`, 'PATCH', { title: 'Hiring plan 2027' }), ctx())).status).toBe(200)
    expect(rows[0].title).toBe('Hiring plan 2027')
    await patch(send(`${base}/${S}`, 'PATCH', { status: 'archived' }), ctx())
    expect(rows[0].status).toBe('archived')
    expect((await patch(send(`${base}/${S}`, 'PATCH', { status: 'gone' }), ctx())).status).toBe(400)
  })

  it('lets only its maker change who sees it', async () => {
    expect((await patch(send(`${base}/${S}`, 'PATCH', { visibility: 'private' }), ctx())).status).toBe(200)
    expect(rows[0].visibility).toBe('private')
    seed({ created_by: 'm-2' })
    expect((await patch(send(`${base}/${S}`, 'PATCH', { visibility: 'private' }), ctx())).status).toBe(400)
    expect(rows[0].visibility).toBe('workspace')
  })

  it('deletes it, and 404s a second delete', async () => {
    expect((await remove(get(`${base}/${S}`), ctx())).status).toBe(200)
    expect(tables.spreadsheet).toHaveLength(0)
    expect((await remove(get(`${base}/${S}`), ctx())).status).toBe(404)
  })
})

describe('GET /api/account/spreadsheets/engine', () => {
  it('serves the engine’s binary to a signed-in person, and a 304 to one who has it', async () => {
    hoisted.requireUser.mockResolvedValue({ supabase: {}, user: { id: 'u-1' } })
    const res = await engine(new Request(`${base}/engine`))
    expect(res.headers.get('content-type')).toBe('application/wasm')
    const bytes = new Uint8Array(await res.arrayBuffer())
    // A WebAssembly module starts with "\0asm".
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0, 97, 115, 109])
    const again = await engine(new Request(`${base}/engine`, { headers: { 'if-none-match': res.headers.get('etag') ?? '' } }))
    expect(again.status).toBe(304)
  })

  it('answers the sign-in refusal to anyone else', async () => {
    hoisted.requireUser.mockResolvedValue(new Response(null, { status: 401 }))
    expect((await engine(new Request(`${base}/engine`))).status).toBe(401)
  })
})

describe('/api/account/spreadsheets/[id]/revisions', () => {
  const R1 = '55555555-5555-4555-8555-555555555555'
  const R2 = '66666666-6666-4666-8666-666666666666'
  let listRevisions: typeof import('@/app/api/account/spreadsheets/[id]/revisions/route').GET
  let oneRevision: typeof import('@/app/api/account/spreadsheets/[id]/revisions/[revisionId]/route').GET
  let restore: typeof import('@/app/api/account/spreadsheets/[id]/revisions/[revisionId]/route').POST
  const rctx = (revisionId: string, id = S) => ({ params: Promise.resolve({ id, revisionId }) })
  let old: string

  beforeEach(async () => {
    ;({ GET: listRevisions } = await import('@/app/api/account/spreadsheets/[id]/revisions/route'))
    ;({ GET: oneRevision, POST: restore } = await import('@/app/api/account/spreadsheets/[id]/revisions/[revisionId]/route'))
    old = workbookWith([[1, 1, 'as it was']])
    const more = tables as unknown as Record<string, Row[]>
    more.spreadsheet_revision = [
      { id: R1, spreadsheet_id: S, revision: 2, title: 'Hiring plan', sheet_names: ['Sheet1'], author_id: ME, author_kind: 'human', change_summary: null, created_at: '2026-11-18T10:00:00Z', updated_at: '2026-11-18T10:05:00Z', workbook: old },
      { id: R2, spreadsheet_id: S, revision: 4, title: 'Hiring plan', sheet_names: ['Sheet1'], author_id: ME, author_kind: 'agent', change_summary: 'Filled the totals', created_at: '2026-11-20T10:00:00Z', updated_at: '2026-11-20T10:00:00Z', workbook: rows[0].workbook },
    ]
    more.member = [{ id: ME, workspace_id: WS, display_name: 'Dana Okafor' }]
    hoisted.requireWorkspaceMember.mockResolvedValue({ supabase: memoryDb(more), user: { id: 'u-1' }, workspaceId: WS, member: { id: ME } })
  })

  it('lists the history newest first, with who and without the workbooks', async () => {
    const json = await readJson<{ revisions: Row[] }>(await listRevisions(get(`${base}/${S}/revisions`), ctx()))
    expect(json.revisions.map((r) => r.revision)).toEqual([4, 2])
    expect(json.revisions[0]).toMatchObject({ author_kind: 'agent', author_name: 'Dana Okafor', change_summary: 'Filled the totals' })
    expect(json.revisions[0].workbook).toBeUndefined()
  })

  it('404s the history of a spreadsheet that is not there', async () => {
    expect((await listRevisions(get(`${base}/x/revisions`), ctx('44444444-4444-4444-8444-444444444444'))).status).toBe(404)
  })

  it('reads one version with its workbook', async () => {
    const json = await readJson<{ revision: Row }>(await oneRevision(get(`${base}/${S}/revisions/${R1}`), rctx(R1)))
    expect(json.revision.workbook).toBe(old)
    expect((await oneRevision(get(`${base}/${S}/revisions/x`), rctx('77777777-7777-4777-8777-777777777777'))).status).toBe(404)
  })

  it('restores a version as an ordinary save, against the revision it was made from', async () => {
    const res = await restore(send(`${base}/${S}/revisions/${R1}`, 'POST', { base_revision: 4 }), rctx(R1))
    expect(res.status).toBe(200)
    expect(rows[0]).toMatchObject({ workbook: old, digest: 'Sheet1 as it was', edit_summary: 'Restored the version of 2026-11-18' })
  })

  it('refuses a restore made from an older revision, or without one', async () => {
    const before = rows[0].workbook
    expect((await restore(send(`${base}/${S}/revisions/${R1}`, 'POST', { base_revision: 3 }), rctx(R1))).status).toBe(409)
    expect((await restore(send(`${base}/${S}/revisions/${R1}`, 'POST', {}), rctx(R1))).status).toBe(400)
    expect(rows[0].workbook).toBe(before)
  })
})
