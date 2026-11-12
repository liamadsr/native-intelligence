/**
 * GET /api/account/files: the Files page (Liam, 11-11: "a new page that shows
 * all available files that were uploaded anywhere in the app, uploaded to
 * captures or action items or projects").
 *
 * The session client is a fake that answers each read as the database's RLS
 * would for the viewer (the attachments and captures read policies, as the
 * newest migrations define them; the last test holds the fake to them), so
 * the privacy tests run both fences: RLS, and the label read of each file's
 * record (lib/attachments/workspace-files.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { migrationsInOrder } from '@/test/migration-sql'

type Row = Record<string, unknown>

const hoisted = vi.hoisted(() => ({ auth: null as unknown }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: async () => hoisted.auth }))

import { GET } from '../route'

const WS = 'ws-1'
const OTHER_WS = 'ws-2'
const ME = 'user-me'
const BEN = 'user-ben'

/**
 * The viewer's session, as RLS answers it: a capture they may read (shared or
 * their own), a file on one (or any file they uploaded: attachments_user_select).
 * `leakAttachments` turns the attachments policy off, to prove the second
 * fence holds alone.
 */
function sessionDb(tables: Record<string, Row[]>, viewer: string, opts: { leakAttachments?: boolean } = {}) {
  const reads: string[] = []
  const captureVisible = (c: Row) => c.visibility === 'workspace' || c.user_id === viewer
  const visible = (table: string, row: Row): boolean => {
    if (table === 'captures') return captureVisible(row)
    if (table === 'attachments') {
      if (opts.leakAttachments || row.user_id === viewer || row.note_id == null) return true
      const capture = (tables.captures ?? []).find((c) => c.id === row.note_id)
      return !!capture && captureVisible(capture)
    }
    return true
  }
  const likeRe = (pattern: string) => {
    let re = ''
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i]
      if (c === '\\') re += (pattern[++i] ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      else if (c === '%') re += '.*'
      else if (c === '_') re += '.'
      else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
    return new RegExp(`^${re}$`, 'i')
  }
  const client = {
    from(table: string) {
      reads.push(table)
      const filters: Array<(r: Row) => boolean> = []
      const orders: Array<{ col: string; asc: boolean }> = []
      let range: [number, number] | null = null
      const run = () => {
        let rows = (tables[table] ?? []).filter((r) => visible(table, r) && filters.every((f) => f(r)))
        rows = [...rows].sort((a, b) => {
          for (const o of orders) {
            const cmp = String(a[o.col]).localeCompare(String(b[o.col]))
            if (cmp) return o.asc ? cmp : -cmp
          }
          return 0
        })
        if (range) rows = rows.slice(range[0], range[1] + 1)
        return { data: rows, error: null }
      }
      const builder = {
        select: () => builder,
        eq: (col: string, v: unknown) => (filters.push((r) => r[col] === v), builder),
        in: (col: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[col])), builder),
        ilike: (col: string, p: string) => (filters.push((r) => typeof r[col] === 'string' && likeRe(p).test(r[col] as string)), builder),
        order: (col: string, o?: { ascending?: boolean }) => (orders.push({ col, asc: o?.ascending !== false }), builder),
        range: (from: number, to: number) => ((range = [from, to]), builder),
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
      }
      return builder
    },
  }
  return { client, reads }
}

const at = (n: number) => `2026-11-${String(n).padStart(2, '0')}T10:00:00Z`
const file = (id: string, day: number, parent: Partial<Row>, extra: Partial<Row> = {}): Row => ({
  id,
  workspace_id: WS,
  user_id: ME,
  file_name: `${id}.pdf`,
  file_size_bytes: 2048,
  mime_type: 'application/pdf',
  file_extension: 'pdf',
  file_category: 'document',
  storage_path: `${ME}/x/${id}.pdf`,
  thumbnail_path: null,
  note_id: null,
  action_id: null,
  project_id: null,
  created_at: at(day),
  ...parent,
  ...extra,
})

function seed(): Record<string, Row[]> {
  return {
    captures: [
      { id: 'cap-shared', workspace_id: WS, title: 'Kickoff with Fernhill', visibility: 'workspace', user_id: BEN },
      { id: 'cap-ben-private', workspace_id: WS, title: 'Ben’s 1:1 notes', visibility: 'private', user_id: BEN },
    ],
    actions: [{ id: 'act-1', workspace_id: WS, title: 'Send the quote' }],
    projects: [{ id: 'proj-1', workspace_id: WS, name: 'Website refresh' }],
    attachments: [
      file('f-capture', 9, { note_id: 'cap-shared', project_id: 'proj-1' }),
      file('f-action', 8, { action_id: 'act-1', project_id: 'proj-1' }, { file_name: 'quote_v2.xlsx', file_extension: 'xlsx' }),
      file('f-project', 7, { project_id: 'proj-1' }, { file_name: 'logo.png', file_category: 'image', mime_type: 'image/png', file_extension: 'png' }),
      // Ben's private capture: his file on it.
      file('f-private', 10, { note_id: 'cap-ben-private' }, { user_id: BEN, file_name: 'salary review.pdf' }),
      // Another workspace's file.
      file('f-elsewhere', 11, { project_id: 'proj-1' }, { workspace_id: OTHER_WS }),
    ],
  }
}

const req = (qs = '') => new NextRequest(`http://localhost/api/account/files${qs}`)
async function list(db: ReturnType<typeof sessionDb>, qs = '') {
  hoisted.auth = { supabase: db.client, user: { id: 'x' }, workspaceId: WS }
  const res = await GET(req(qs))
  return { status: res.status, body: await res.json() }
}

beforeEach(() => {
  hoisted.auth = null
})

describe('GET /api/account/files', () => {
  it('lists every file in the workspace the person may see, newest first, each with the record it is attached to', async () => {
    const { status, body } = await list(sessionDb(seed(), ME))
    expect(status).toBe(200)
    expect(body.next_offset).toBeNull()
    expect(body.files.map((f: Row) => [f.id, f.parent])).toEqual([
      ['f-capture', { type: 'capture', id: 'cap-shared', label: 'Kickoff with Fernhill' }],
      // An action's file carries its project too: the action is where it is.
      ['f-action', { type: 'action', id: 'act-1', label: 'Send the quote' }],
      ['f-project', { type: 'project', id: 'proj-1', label: 'Website refresh' }],
    ])
    expect(body.files[0]).toMatchObject({ file_name: 'f-capture.pdf', file_size_bytes: 2048, file_category: 'document', storage_path: `${ME}/x/f-capture.pdf`, created_at: at(9) })
    expect(body.files[0]).not.toHaveProperty('workspace_id')
  })

  it('never lists a file on another member’s private capture (RLS); its owner sees it', async () => {
    const mine = await list(sessionDb(seed(), ME))
    expect(mine.body.files.map((f: Row) => f.id)).not.toContain('f-private')
    expect(JSON.stringify(mine.body)).not.toContain('salary review')
    expect(JSON.stringify(mine.body)).not.toContain('1:1 notes')
    const bens = await list(sessionDb(seed(), BEN))
    expect(bens.body.files[0]).toMatchObject({ id: 'f-private', parent: { type: 'capture', id: 'cap-ben-private', label: 'Ben’s 1:1 notes' } })
  })

  it('fences again on the record: a file whose capture the person can’t read is dropped even where the attachments rule lets it through', async () => {
    // Uploaded by me to a capture Ben has since made private: attachments_user_select shows me my own row.
    const tables = seed()
    tables.attachments.push(file('f-mine-on-private', 12, { note_id: 'cap-ben-private' }))
    const mine = await list(sessionDb(tables, ME))
    expect(mine.body.files.map((f: Row) => f.id)).toEqual(['f-capture', 'f-action', 'f-project'])
    // And were the attachments rule to leak every row, the record fence alone still holds.
    const leaked = await list(sessionDb(seed(), ME, { leakAttachments: true }))
    expect(leaked.body.files.map((f: Row) => f.id)).toEqual(['f-capture', 'f-action', 'f-project'])
  })

  it('drops a file whose record is gone, and one attached to nothing', async () => {
    const tables = seed()
    tables.attachments.push(file('f-orphan', 12, { action_id: 'act-deleted' }), file('f-none', 13, {}))
    const { body } = await list(sessionDb(tables, ME))
    expect(body.files.map((f: Row) => f.id)).toEqual(['f-capture', 'f-action', 'f-project'])
  })

  it('pages with limit and offset', async () => {
    const first = await list(sessionDb(seed(), ME), '?limit=2')
    expect(first.body.files.map((f: Row) => f.id)).toEqual(['f-capture', 'f-action'])
    expect(first.body.next_offset).toBe(2)
    const second = await list(sessionDb(seed(), ME), `?limit=2&offset=${first.body.next_offset}`)
    expect(second.body.files.map((f: Row) => f.id)).toEqual(['f-project'])
    expect(second.body.next_offset).toBeNull()
  })

  it('filters by category and by a part of the name (its wildcards taken literally)', async () => {
    const images = await list(sessionDb(seed(), ME), '?category=image')
    expect(images.body.files.map((f: Row) => f.id)).toEqual(['f-project'])
    const docs = await list(sessionDb(seed(), ME), '?category=document')
    expect(docs.body.files.map((f: Row) => f.id)).toEqual(['f-capture', 'f-action'])
    const named = await list(sessionDb(seed(), ME), '?q=QUOTE')
    expect(named.body.files.map((f: Row) => f.id)).toEqual(['f-action'])
    // `_` is a character here, not any one.
    expect((await list(sessionDb(seed(), ME), '?q=quote_')).body.files.map((f: Row) => f.id)).toEqual(['f-action'])
    expect((await list(sessionDb(seed(), ME), '?q=quoteXv2')).body.files).toEqual([])
    expect((await list(sessionDb(seed(), ME), '?q=%25')).body.files).toEqual([])
  })

  it('refuses a bad query', async () => {
    for (const qs of ['?category=video', '?limit=0', '?limit=101', '?offset=-1', '?limit=abc']) {
      const { status, body } = await list(sessionDb(seed(), ME), qs)
      expect(status, qs).toBe(400)
      expect(body.error, qs).toBeTruthy()
    }
  })

  it('reads flat: one read of attachments and one label read per kind of record present', async () => {
    const db = sessionDb(seed(), ME)
    await list(db)
    expect(db.reads.filter((t) => t === 'attachments')).toHaveLength(1)
    expect([...db.reads].sort()).toEqual(['actions', 'attachments', 'captures', 'projects'])
    const images = sessionDb(seed(), ME)
    await list(images, '?category=image')
    expect(images.reads).toEqual(['attachments', 'projects'])
    const none = sessionDb({ attachments: [] }, ME)
    expect((await list(none)).body).toEqual({ files: [], next_offset: null })
    expect(none.reads).toEqual(['attachments'])
  })

  it('answers as requireWorkspace does when there is no session', async () => {
    hoisted.auth = new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
    expect((await GET(req())).status).toBe(401)
  })
})

describe('the read rules the fake stands for', () => {
  it('the newest attachments read policy shows a capture’s file only where the capture is shared, the reader’s own or granted', () => {
    const defining = migrationsInOrder().filter((m) => /create policy attachments_workspace_select/i.test(m.sql))
    const sql = defining.at(-1)!.sql
    const policy = sql.slice(sql.search(/create policy attachments_workspace_select/i)).split(';')[0]
    expect(policy).toMatch(/is_workspace_member\(workspace_id\)/i)
    expect(policy).toMatch(/note_id is null/i)
    expect(policy).toMatch(/c\.id = attachments\.note_id/i)
    expect(policy).toMatch(/c\.visibility = 'workspace'/i)
    expect(policy).toMatch(/c\.user_id = auth\.uid\(\)/i)
  })
})
