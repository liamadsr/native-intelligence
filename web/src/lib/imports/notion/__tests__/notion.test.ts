import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { readNotionExport, safeEntryPath, splitNotionName } from '../export'
import { dropTitleHeading, fillPlaceholders, planNotionImport, resolveTarget } from '../plan'
import type { DataTableRecord, DocumentRecord, DriveFolderRecord } from '../../types'

const ROADMAP = `Roadmap ${'a'.repeat(32)}`
const LAUNCH = `Launch plan ${'b'.repeat(32)}`
const TASKS = `Tasks ${'c'.repeat(32)}`
const ROW = `Write copy ${'d'.repeat(32)}`
const EMPTY_ROW = `Pick date ${'e'.repeat(32)}`

async function exportZip(): Promise<Uint8Array> {
  const inner = new JSZip()
  inner.file(`${ROADMAP}.md`, `# Roadmap\n\nSee [the launch](${encodeURIComponent(ROADMAP)}/${encodeURIComponent(LAUNCH)}.md) and [tasks](${encodeURIComponent(ROADMAP)}/${encodeURIComponent(TASKS)}.csv).\n\n![chart](${encodeURIComponent(ROADMAP)}/chart.png)\n\n[gone](Missing%20${'f'.repeat(32)}.md) and [web](https://example.com)\n`)
  inner.file(`${ROADMAP}/${LAUNCH}.md`, `# Launch plan\n\nBack to [Roadmap](../${encodeURIComponent(ROADMAP)}.md).\n`)
  inner.file(`${ROADMAP}/chart.png`, new Uint8Array([137, 80, 78, 71]))
  inner.file(`${ROADMAP}/unused.pdf`, new Uint8Array([1, 2, 3]))
  inner.file(`${ROADMAP}/${TASKS}.csv`, 'Name,Status,Due\nWrite copy,Done,2026-11-01\nPick date,Todo,\n')
  inner.file(`${ROADMAP}/${TASKS}_all.csv`, 'Name,Status,Due\nWrite copy,Done,2026-11-01\nPick date,Todo,\nArchived one,Done,\n')
  inner.file(`${ROADMAP}/${TASKS}/${ROW}.md`, '# Write copy\n\nStatus: Done\nDue: 2026-11-01\n\nThe draft lives here.\n')
  inner.file(`${ROADMAP}/${TASKS}/${EMPTY_ROW}.md`, '# Pick date\n\nStatus: Todo\n')
  inner.file('__MACOSX/._junk', 'x')
  const outer = new JSZip()
  outer.file('Export-1234.zip', await inner.generateAsync({ type: 'uint8array' }))
  return outer.generateAsync({ type: 'uint8array' })
}

describe('reading paths and names', () => {
  it('splits Notion’s id from a name', () => {
    expect(splitNotionName(ROADMAP)).toEqual({ title: 'Roadmap', notionId: 'a'.repeat(32) })
    expect(splitNotionName('Plain')).toEqual({ title: 'Plain', notionId: null })
  })

  it('refuses a path that climbs out or is absolute', () => {
    expect(safeEntryPath('a/b.md')).toBe('a/b.md')
    expect(safeEntryPath('a/./b.md')).toBe('a/b.md')
    expect(safeEntryPath('../etc/passwd')).toBeNull()
    expect(safeEntryPath('a/../../b')).toBeNull()
    expect(safeEntryPath('/abs.md')).toBeNull()
    expect(safeEntryPath('C:\\x.md')).toBeNull()
    expect(safeEntryPath('__MACOSX/a')).toBeNull()
    expect(safeEntryPath(Array.from({ length: 17 }, () => 'd').join('/'))).toBeNull()
  })

  it('resolves a link against the page’s folder', () => {
    expect(resolveTarget('A/B.md', 'C%20D.md')).toBe('A/C D.md')
    expect(resolveTarget('A/B.md', '../E.md')).toBe('E.md')
    expect(resolveTarget('B.md', '../E.md')).toBeNull()
    expect(resolveTarget('B.md', 'https://x.test/a.md')).toBeNull()
    expect(resolveTarget('B.md', 'mailto:a@b.c')).toBeNull()
  })

  it('drops a heading that repeats the title only', () => {
    expect(dropTitleHeading('# Roadmap\n\nBody', 'Roadmap')).toBe('Body')
    expect(dropTitleHeading('# Other\n\nBody', 'Roadmap')).toBe('# Other\n\nBody')
  })
})

describe('readNotionExport', () => {
  it('opens nested zips and builds the tree', async () => {
    const out = await readNotionExport(await exportZip())
    if (!out.ok) throw new Error(out.error)
    const exp = out.export
    expect(exp.pages.map((p) => p.title).sort()).toEqual(['Launch plan', 'Pick date', 'Roadmap', 'Write copy'])
    const launch = exp.pages.find((p) => p.title === 'Launch plan')!
    expect(launch.parentPath).toBe(`${ROADMAP}.md`)
    expect(exp.databases).toHaveLength(1)
    // The fuller `_all` CSV wins.
    expect(exp.databases[0].csv).toContain('Archived one')
    expect(exp.databases[0].parentPath).toBe(`${ROADMAP}.md`)
    expect(exp.pages.find((p) => p.title === 'Write copy')!.parentPath).toBe(`${ROADMAP}/${TASKS}.csv`)
    expect(exp.files.map((f) => f.fileName).sort()).toEqual(['chart.png', 'unused.pdf'])
  })

  it('says so when the file is not a zip, or holds no pages', async () => {
    expect(await readNotionExport(new TextEncoder().encode('hello'))).toMatchObject({ ok: false })
    const z = new JSZip()
    z.file('a.png', new Uint8Array([1]))
    expect(await readNotionExport(await z.generateAsync({ type: 'uint8array' }))).toMatchObject({ ok: false, error: expect.stringMatching(/No Notion pages/) })
  })
})

describe('planNotionImport', () => {
  it('plans folders, documents, a table, assets and links', async () => {
    const out = await readNotionExport(await exportZip())
    if (!out.ok) throw new Error(out.error)
    const plan = planNotionImport(out.export, { folderName: 'Notion import', visibility: 'private' })
    const byKind = (k: string) => plan.items.filter((i) => i.record.kind === k)

    // Top folder, Roadmap's (it has subpages), and Tasks' (a row page has a body).
    const folders = byKind('drive_folder').map((i) => i.record as DriveFolderRecord)
    expect(folders.map((f) => f.name)).toEqual(['Notion import', 'Roadmap', 'Tasks'])
    expect(folders[1].parent).toEqual({ ref: 'folder:0' })
    expect(folders[2].parent).toEqual({ ref: 'folder:1' })

    const docs = byKind('document')
    const titles = docs.map((d) => (d.record as DocumentRecord).title)
    // The row page with nothing but its properties is just the row.
    expect(titles.sort()).toEqual(['Launch plan', 'Roadmap', 'Write copy'])
    const roadmap = docs.find((d) => (d.record as DocumentRecord).title === 'Roadmap')!.record as DocumentRecord
    expect(roadmap.folder).toEqual({ ref: 'folder:1' })
    expect(roadmap.visibility).toBe('private')
    expect(roadmap.body).toMatch(/\[@the launch\]\(\{\{ref:page:\d\}\}\)/)
    expect(roadmap.body).toMatch(/\[@tasks\]\(\{\{ref:table:0\}\}\)/)
    expect(roadmap.body).toMatch(/!\[chart\]\(\{\{asset:asset:0\}\}\)/)
    expect(roadmap.body).toContain('[web](https://example.com)')
    expect(roadmap.body).toMatch(/^gone and \[web\]/m)
    expect(roadmap.body.startsWith('# Roadmap')).toBe(false)
    const row = docs.find((d) => (d.record as DocumentRecord).title === 'Write copy')!.record as DocumentRecord
    expect(row.body.trim()).toBe('The draft lives here.')
    expect(row.folder).toEqual({ ref: 'folder:2' })

    const table = byKind('data_table')[0].record as DataTableRecord
    expect(table).toMatchObject({ name: 'Tasks', headers: ['Name', 'Status', 'Due'], folder: { ref: 'folder:1' } })
    expect(table.rows).toHaveLength(3)

    expect(byKind('asset')).toHaveLength(1)
    // Items come in the order apply needs: folders, files, tables, documents.
    const order = plan.items.map((i) => i.record.kind)
    expect(order.lastIndexOf('drive_folder')).toBeLessThan(order.indexOf('asset'))
    expect(order.indexOf('data_table')).toBeLessThan(order.indexOf('document'))
    expect(plan.notes.map((n) => n.text).join('\n')).toMatch(/1 file in the export isn’t linked/)
  })

  it('fills placeholders, leaving an unknown one harmless', () => {
    const body = '[@A]({{ref:page:0}}) ![x]({{asset:asset:3}}) [@B]({{ref:page:9}})'
    const filled = fillPlaceholders(body, (kind, ref) => (kind === 'ref' && ref === 'page:0' ? 'mention://document/11111111-1111-1111-1111-111111111111' : kind === 'asset' ? '/api/x' : null))
    expect(filled).toBe('[@A](mention://document/11111111-1111-1111-1111-111111111111) ![x](/api/x) [@B](#)')
  })
})
