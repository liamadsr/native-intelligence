import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'

vi.mock('@/lib/tables/store', () => ({
  createTable: vi.fn(async () => ({ ok: true, value: { table_id: '99999999-0000-0000-0000-000000000001', version: 1 } })),
  applyOps: vi.fn(async () => ({ ok: true, value: { version: 2 } })),
}))
import { applyOps, createTable } from '@/lib/tables/store'
import { applyImport } from '../apply'
import { loadImport, loadItems, stageImport, alreadyImported } from '../journal'
import { undoImport, undoSummary } from '../undo'
import { applySummary } from '../run'
import { planTaskImport } from '../tasks/plan'
import { guessMapping } from '../tasks/columns'
import { planNotionImport } from '../notion/plan'
import type { NotionExport } from '../notion/export'

const WS = 'ws-1'
const USER = 'user-1'
const MEMBER = 'member-1'

type Tables = Record<string, Record<string, unknown>[]>

function setup() {
  const tables: Tables = {
    work_import: [],
    work_import_item: [],
    actions: [],
    action_assignee: [],
    action_label: [],
    label: [{ id: 'l-bug', workspace_id: WS, name: 'Bug' }],
    project_label: [],
    projects: [],
    workflow_state: [],
    drive_folder: [],
    drive_folder_item: [],
    document: [],
    data_change: [],
  }
  const base = memoryDb(tables, { label: (a, b) => a.workspace_id === b.workspace_id && String(a.name).toLowerCase() === String(b.name).toLowerCase() })
  const uploads: string[] = []
  const removed: string[] = []
  const storage = {
    from: () => ({
      upload: async (path: string) => {
        uploads.push(path)
        return { error: null }
      },
      remove: async (paths: string[]) => {
        removed.push(...paths)
        return { error: null }
      },
    }),
  }
  const db = Object.assign(Object.create(base), { from: base.from.bind(base), storage }) as unknown as SupabaseClient
  return { tables, db, uploads, removed }
}

const context = {
  teamId: 'team-1',
  states: [
    { id: 's-todo', name: 'Todo', category: 'unstarted' as const, is_default: true, sort_order: 0 },
    { id: 's-done', name: 'Done', category: 'completed' as const, sort_order: 1 },
  ],
  members: [{ id: 'm-ava', name: 'Ava Stone', email: 'ava@example.com' }],
  labels: [{ id: 'l-bug', name: 'Bug' }],
  projects: [],
}

async function stagedCsv(db: SupabaseClient) {
  const headers = ['Title', 'Status', 'Assignee', 'Labels', 'Project']
  const rows = [
    ['One', 'Done', 'ava@example.com', 'Bug, New', 'Site'],
    ['Two', '', '', 'New', ''],
    ['Three', '', '', '', 'Site'],
  ]
  const plan = planTaskImport({ headers, rows, mapping: guessMapping(headers), context })
  return stageImport(db, { workspaceId: WS, userId: USER, memberId: MEMBER, source: 'task_csv', label: 'tasks.csv', destination: {}, plan })
}

describe('apply and undo a task CSV', () => {
  let env: ReturnType<typeof setup>
  beforeEach(() => {
    env = setup()
  })

  it('makes the tasks, their labels and project, with assignees, in order', async () => {
    const imp = await stagedCsv(env.db)
    const out = await applyImport({ db: env.db, svc: env.db, imp, userId: USER, memberId: MEMBER })
    expect(out).toMatchObject({ status: 'done', failed: 0, counts: { action: 3, label: 1, project: 1 } })
    expect(env.tables.actions.map((a) => a.title)).toEqual(['One', 'Two', 'Three'])
    expect(env.tables.actions[0]).toMatchObject({ status_id: 's-done', assignee_id: 'm-ava', user_id: USER, workspace_id: WS, confirmation: 'confirmed' })
    const newLabel = env.tables.label.find((l) => l.name === 'New')!
    const site = env.tables.projects[0]
    expect(env.tables.actions[0].project_id).toBe(site.id)
    expect(env.tables.action_label.map(({ action_id, label_id }) => ({ action_id, label_id }))).toEqual(
      expect.arrayContaining([
        { action_id: env.tables.actions[0].id, label_id: 'l-bug' },
        { action_id: env.tables.actions[0].id, label_id: newLabel.id },
        { action_id: env.tables.actions[1].id, label_id: newLabel.id },
      ]),
    )
    expect(env.tables.action_assignee.map(({ action_id, member_id }) => ({ action_id, member_id }))).toEqual([{ action_id: env.tables.actions[0].id, member_id: 'm-ava' }])
    expect(applySummary('task_csv', out.counts)).toBe('Imported 3 tasks, 1 label and 1 project from a task CSV.')
  })

  it('carries on after a stop without making anything twice', async () => {
    const imp = await stagedCsv(env.db)
    await applyImport({ db: env.db, svc: env.db, imp, userId: USER, memberId: MEMBER })
    // As if the run died after writing the records but before journalling them.
    for (const i of env.tables.work_import_item) Object.assign(i, { outcome: 'pending', applied_at: null })
    const again = await applyImport({ db: env.db, svc: env.db, imp, userId: USER, memberId: MEMBER })
    expect(again.status).toBe('done')
    expect(env.tables.actions).toHaveLength(3)
    expect(env.tables.label).toHaveLength(2)
    expect(env.tables.projects).toHaveLength(1)
    expect((await loadItems(env.db, imp.id)).every((i) => i.outcome === 'created')).toBe(true)
  })

  it('matches a label someone made meanwhile instead of failing', async () => {
    const imp = await stagedCsv(env.db)
    env.tables.label.push({ id: 'l-new-by-someone', workspace_id: WS, name: 'new' })
    await applyImport({ db: env.db, svc: env.db, imp, userId: USER, memberId: MEMBER })
    const item = (await loadItems(env.db, imp.id)).find((i) => i.kind === 'label')!
    expect(item).toMatchObject({ outcome: 'matched', matched_id: 'l-new-by-someone', entity_id: null })
    expect(env.tables.action_label.filter((l) => l.label_id === 'l-new-by-someone')).toHaveLength(2)
  })

  it('undoes only what it made, keeping what changed since and what others use', async () => {
    const imp = await stagedCsv(env.db)
    await applyImport({ db: env.db, svc: env.db, imp, userId: USER, memberId: MEMBER })
    const [one, two] = env.tables.actions
    // Someone changed "Two" after the import.
    two.updated_at = new Date(Date.now() + 60_000).toISOString()
    // Someone else's task uses the new label.
    const newLabel = env.tables.label.find((l) => l.name === 'New')!
    env.tables.actions.push({ id: 'theirs', workspace_id: WS, title: 'Theirs' })
    env.tables.action_label.push({ action_id: 'theirs', label_id: newLabel.id })

    const result = await undoImport({ db: env.db, svc: env.db, imp: (await loadImport(env.db, imp.id, { userId: USER, workspaceId: WS }))!, userId: USER })
    expect(env.tables.actions.map((a) => a.title).sort()).toEqual(['Theirs', 'Two'])
    expect(env.tables.actions.find((a) => a.id === one.id)).toBeUndefined()
    // The matched label "Bug" and the label someone else uses stay.
    expect(env.tables.label.map((l) => l.name).sort()).toEqual(['Bug', 'New'])
    // The project is still used by the kept task? No: "Two" had none; "Three" is gone, "One" is gone.
    expect(env.tables.projects).toHaveLength(0)
    expect(result.removed).toMatchObject({ action: 2, project: 1 })
    expect(undoSummary(result)).toBe('Removed 2 tasks and 1 project. Kept 1 task: changed since the import. Kept 1 label: other records use it.')
    // A kept task is still known as imported: a second import skips it.
    const items = await loadItems(env.db, imp.id)
    expect(items.find((i) => i.entity_id === two.id)).toMatchObject({ undo_outcome: 'kept' })
  })

  it('knows what an earlier import made and still has', async () => {
    const plan = { items: [{ ref: 'issue:0', external_id: 'lin-1', record: { kind: 'label' as const, name: 'X' } }], counts: {}, notes: [] }
    const imp = await stageImport(env.db, { workspaceId: WS, userId: USER, memberId: MEMBER, source: 'linear', label: null, destination: {}, plan })
    env.tables.work_import_item[0].kind = 'action'
    env.tables.work_import_item[0].outcome = 'created'
    expect(await alreadyImported(env.db, WS, 'action', ['lin-1', 'lin-2'])).toEqual(new Set(['lin-1']))
    Object.assign(env.tables.work_import_item[0], { undone_at: 'x', undo_outcome: 'removed' })
    expect(await alreadyImported(env.db, WS, 'action', ['lin-1'])).toEqual(new Set())
    Object.assign(env.tables.work_import_item[0], { undo_outcome: 'kept' })
    expect(await alreadyImported(env.db, WS, 'action', ['lin-1'])).toEqual(new Set(['lin-1']))
    expect(imp.status).toBe('staged')
  })
})

describe('apply and undo a Notion export', () => {
  const PNG = new Uint8Array([137, 80, 78, 71])
  const exp: NotionExport = {
    pages: [
      { path: 'Home aaa.md', notionId: 'a', title: 'Home', markdown: '# Home\n\nSee [Child](Home%20aaa/Child%20bbb.md) and ![pic](Home%20aaa/p.png)\n', parentPath: null },
      { path: 'Home aaa/Child bbb.md', notionId: 'b', title: 'Child', markdown: 'Back to [Home](../Home%20aaa.md)', parentPath: 'Home aaa.md' },
    ],
    databases: [{ path: 'Home aaa/Tasks ccc.csv', notionId: 'c', name: 'Tasks', csv: 'Name,Done\nA,Yes\n', parentPath: 'Home aaa.md' }],
    files: [{ path: 'Home aaa/p.png', fileName: 'p.png', mimeType: 'image/png', bytes: PNG }],
    dropped: [],
  }

  it('makes folders, files, a table and documents whose links point at each other', async () => {
    const env = setup()
    const plan = planNotionImport(exp, { folderName: 'Notion import', visibility: 'private' })
    const imp = await stageImport(env.db, { workspaceId: WS, userId: USER, memberId: MEMBER, source: 'notion', label: 'export.zip', destination: {}, plan })
    const syncLinks = vi.fn(async () => {})
    const out = await applyImport({ db: env.db, svc: env.db, imp, userId: USER, memberId: MEMBER, readFile: async (p) => (p === 'Home aaa/p.png' ? PNG : null), syncLinks })
    expect(out).toMatchObject({ status: 'done', failed: 0, counts: { drive_folder: 2, document: 2, data_table: 1, asset: 1 } })
    expect(vi.mocked(createTable)).toHaveBeenCalledWith(env.db, WS, expect.objectContaining({ name: 'Tasks', visibility: 'private' }), expect.objectContaining({ source: 'import' }))
    expect(vi.mocked(applyOps)).toHaveBeenCalled()
    const [top, homeFolder] = env.tables.drive_folder
    expect(top).toMatchObject({ name: 'Notion import', parent_id: null, created_by: MEMBER })
    expect(homeFolder).toMatchObject({ name: 'Home', parent_id: top.id })
    const home = env.tables.document.find((d) => d.title === 'Home')!
    const child = env.tables.document.find((d) => d.title === 'Child')!
    expect(home).toMatchObject({ visibility: 'private', created_by: MEMBER })
    expect(home.content).toBe(`See [@Child](mention://document/${child.id}) and ![pic](/api/account/imports/assets/${env.tables.work_import_item.find((i) => i.kind === 'asset')!.id})`)
    expect(child.content).toBe(`Back to [@Home](mention://document/${home.id})`)
    expect(syncLinks).toHaveBeenCalledWith(home.id, home.content)
    // Filed: both pages and the table in Home's folder.
    expect(env.tables.drive_folder_item.map((f) => [f.item_type, f.folder_id])).toEqual([
      ['data_table', homeFolder.id],
      ['document', homeFolder.id],
      ['document', homeFolder.id],
    ])
    expect(env.uploads).toHaveLength(1)
    expect(env.uploads[0]).toMatch(new RegExp(`^${USER}/imports/${imp.id}/[0-9a-f-]+-p\\.png$`))

    // Undo: documents archived, the table archived, the file removed, the folders deleted.
    vi.mocked(applyOps).mockClear()
    const result = await undoImport({ db: env.db, svc: env.db, imp, userId: USER })
    expect(env.tables.document.every((d) => d.status === 'archived')).toBe(true)
    expect(vi.mocked(applyOps)).toHaveBeenCalledWith(env.db, WS, '99999999-0000-0000-0000-000000000001', { baseVersion: null, ops: [{ op: 'archive_table' }] }, expect.anything())
    expect(env.removed).toEqual([env.uploads[0]])
    expect(env.tables.drive_folder).toHaveLength(0)
    expect(result.kept).toEqual([])
  })

  it('keeps a folder that holds someone else’s record, and the page someone edited with the file it shows', async () => {
    const env = setup()
    const plan = planNotionImport(exp, { folderName: 'Notion import', visibility: 'workspace' })
    const imp = await stageImport(env.db, { workspaceId: WS, userId: USER, memberId: MEMBER, source: 'notion', label: 'export.zip', destination: {}, plan })
    await applyImport({ db: env.db, svc: env.db, imp, userId: USER, memberId: MEMBER, readFile: async () => PNG })
    const home = env.tables.document.find((d) => d.title === 'Home')!
    home.updated_at = new Date(Date.now() + 60_000).toISOString()
    env.tables.drive_folder_item.push({ item_type: 'document', item_id: 'someone-elses', folder_id: env.tables.drive_folder[0].id, workspace_id: WS })
    env.tables.data_change.push({ table_id: '99999999-0000-0000-0000-000000000001', source: 'person' })
    const result = await undoImport({ db: env.db, svc: env.db, imp, userId: USER })
    expect(home.status).not.toBe('archived')
    expect(env.tables.document.find((d) => d.title === 'Child')!.status).toBe('archived')
    expect(env.removed).toEqual([])
    // Home's folder still holds the kept page and the kept table; the top folder holds someone's record.
    expect(env.tables.drive_folder).toHaveLength(2)
    expect(undoSummary(result)).toMatch(/^Removed 1 document\. Kept 1 document and 1 table: changed since the import\. Kept 1 file: a kept document shows it\. Kept 2 folders: it holds something else\./)
  })
})
