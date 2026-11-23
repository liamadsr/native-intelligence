/**
 * A Notion export as an import plan (docs/plans/imports.md, phase 3).
 *
 *   folders    one top folder for the import; inside it, a folder for every
 *              page that has subpages (named for the page, inside its
 *              parent's folder), and one for a database whose row pages have
 *              a body of their own.
 *   documents  every page, filed in its own folder when it has subpages,
 *              else in its parent's. The title is the file's name without
 *              Notion's id; a first heading that repeats it is dropped.
 *   tables     every database, from its CSV, in its parent's folder.
 *   files      every image or file a page links to, uploaded once.
 *   links      a link to another page of the export becomes a mention of
 *              its document (`[@Text](mention://document/…)`, which the save
 *              turns into a record link); to a database, a mention of its
 *              table; to a file, the file's address; to anything else in
 *              the export that didn't come in, its words alone.
 *
 * A link to an item of the import is written as a placeholder
 * (`{{ref:<ref>}}`, `{{asset:<ref>}}`) that apply fills in once every item
 * has its id. Pure.
 */
import { parseCsv } from '@/lib/crm/import/sources/spreadsheet'
import { mentionLabelText } from '@/lib/documents/mention-markdown'
import { IMPORT_MAX_ROWS } from '@/lib/tables/csv'
import { sanitizeImportedMarkdown } from '../sanitize'
import { countOf, type ImportPlan, type PlanNote, type PlannedItem, type Ref } from '../types'
import type { NotionDatabase, NotionExport, NotionPage } from './export'

export interface NotionPlanOptions {
  /** The top folder's name ("Notion import, Nov 23"). */
  folderName: string
  /** The folder the top folder goes in, or the top of Drive. */
  parentFolderId?: string | null
  visibility: 'workspace' | 'private'
}

export const REF_PLACEHOLDER = /\{\{(ref|asset):([a-z_]+:\d+)\}\}/g

/** A row page's opening `Key: value` lines, when every key is one of its database's columns. */
function stripRowProperties(markdown: string, headers: readonly string[]): string {
  const lines = markdown.split('\n')
  let i = 0
  while (i < lines.length && !lines[i].trim()) i++
  const start = i
  const known = new Set(headers.map((h) => h.trim().toLowerCase()))
  while (i < lines.length && lines[i].trim()) {
    const m = /^([^:]{1,80}):\s?(.*)$/.exec(lines[i])
    if (!m || !known.has(m[1].trim().toLowerCase())) return markdown
    i++
  }
  return i > start ? lines.slice(i).join('\n') : markdown
}

/** Drop a first `# Heading` that only repeats the title. */
export function dropTitleHeading(markdown: string, title: string): string {
  const m = /^\s*#\s+(.+?)\s*(?:\n|$)/.exec(markdown)
  if (m && m[1].trim().toLowerCase() === title.trim().toLowerCase()) return markdown.slice(m[0].length).replace(/^\s*\n/, '')
  return markdown
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

/** A link's target, resolved against the page's folder, or null for a web link, an anchor, or one that climbs out. */
export function resolveTarget(fromPath: string, target: string): string | null {
  const raw = target.trim().replace(/^<|>$/g, '').split(/\s+"/)[0].split('#')[0].split('?')[0]
  if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    decoded = raw
  }
  const parts = (raw.startsWith('/') ? [] : dirOf(fromPath).split('/').filter(Boolean))
  for (const seg of decoded.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (!parts.length) return null
      parts.pop()
    } else parts.push(seg)
  }
  return parts.join('/') || null
}

const LINK = /(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g

export function planNotionImport(exp: NotionExport, opts: NotionPlanOptions): ImportPlan {
  const items: PlannedItem[] = []
  const notes: PlanNote[] = []
  const pageRef = new Map<string, string>() // path → ref
  const dbRef = new Map<string, string>()
  const assetRef = new Map<string, string>()
  const folderOf = new Map<string, Ref>() // a node's own folder (it has children)

  const children = new Map<string, number>()
  for (const p of exp.pages) if (p.parentPath) children.set(p.parentPath, (children.get(p.parentPath) ?? 0) + 1)
  for (const d of exp.databases) if (d.parentPath) children.set(d.parentPath, (children.get(d.parentPath) ?? 0) + 1)

  const dbHeaders = new Map<string, string[]>()
  const sheets = new Map<string, { headers: string[]; rows: string[][] }>()
  for (const d of exp.databases) {
    const sheet = parseCsv(d.csv)
    sheets.set(d.path, sheet)
    dbHeaders.set(d.path, sheet.headers)
  }

  // Row pages with nothing but their title and properties are the row itself.
  const isDb = new Set(exp.databases.map((d) => d.path))
  const bodyOf = (p: NotionPage): string => {
    let md = dropTitleHeading(p.markdown, p.title)
    if (p.parentPath && isDb.has(p.parentPath)) md = stripRowProperties(md, dbHeaders.get(p.parentPath) ?? [])
    return md
  }
  const pages = exp.pages.filter((p) => !(p.parentPath && isDb.has(p.parentPath)) || bodyOf(p).trim() || children.has(p.path))
  const rowOnly = exp.pages.length - pages.length
  const keptPaths = new Set([...pages.map((p) => p.path), ...exp.databases.map((d) => d.path)])

  // ── Folders, top-down ────────────────────────────────────────────────────
  const top: Ref = { ref: 'folder:0' }
  items.push({ ref: 'folder:0', external_id: null, record: { kind: 'drive_folder', name: opts.folderName.slice(0, 200), parent: opts.parentFolderId ? { id: opts.parentFolderId } : null } })
  let folders = 1
  const depth = (path: string | null): number => {
    let n = 0
    const byPath = new Map<string, string | null>([...exp.pages.map((p) => [p.path, p.parentPath] as const), ...exp.databases.map((d) => [d.path, d.parentPath] as const)])
    let at = path
    while (at && n < 64) {
      at = byPath.get(at) ?? null
      n++
    }
    return n
  }
  const containerOf = (parentPath: string | null): Ref => (parentPath ? folderOf.get(parentPath) ?? top : top)
  const needsFolder = [
    ...pages.filter((p) => children.has(p.path)).map((p) => ({ path: p.path, name: p.title, parentPath: p.parentPath })),
    ...exp.databases
      .filter((d) => pages.some((p) => p.parentPath === d.path))
      .map((d) => ({ path: d.path, name: d.name, parentPath: d.parentPath })),
  ].sort((a, b) => depth(a.path) - depth(b.path))
  for (const n of needsFolder) {
    const ref = `folder:${folders++}`
    items.push({ ref, external_id: null, record: { kind: 'drive_folder', name: n.name.slice(0, 200), parent: containerOf(n.parentPath && keptPaths.has(n.parentPath) ? n.parentPath : null) } })
    folderOf.set(n.path, { ref })
  }

  // ── Refs for pages and databases, so links can name them ─────────────────
  pages.forEach((p, i) => pageRef.set(p.path, `page:${i}`))
  exp.databases.forEach((d, i) => dbRef.set(d.path, `table:${i}`))
  const filesByPath = new Map(exp.files.map((f) => [f.path, f]))

  // ── Bodies: links rewritten to placeholders ──────────────────────────────
  let deadLinks = 0
  const assetItems: PlannedItem[] = []
  const rewrite = (p: NotionPage): string =>
    bodyOf(p).replace(LINK, (whole, bang: string, text: string, target: string) => {
      const path = resolveTarget(p.path, target)
      if (!path) return whole
      const file = filesByPath.get(path)
      if (file) {
        let ref = assetRef.get(path)
        if (!ref) {
          ref = `asset:${assetRef.size}`
          assetRef.set(path, ref)
          assetItems.push({ ref, external_id: null, record: { kind: 'asset', path, file_name: file.fileName.slice(0, 200), mime_type: file.mimeType, size: file.bytes.byteLength } })
        }
        return `${bang}[${text.replace(/[[\]]/g, '')}]({{asset:${ref}}})`
      }
      const page = pageRef.get(path)
      const db = dbRef.get(path) ?? dbRef.get(path.replace(/_all\.csv$/i, '.csv'))
      const target_ = page ?? db
      if (target_) return `[@${mentionLabelText(text || 'Untitled')}]({{ref:${target_}}})`
      // Something of the export that didn't come in (or isn't there): keep its words.
      deadLinks++
      return bang ? '' : text
    })

  const docs: PlannedItem[] = pages.map((p) => ({
    ref: pageRef.get(p.path)!,
    external_id: p.notionId,
    record: {
      kind: 'document' as const,
      title: p.title.slice(0, 500),
      body: sanitizeImportedMarkdown(rewrite(p)),
      folder: folderOf.get(p.path) ?? containerOf(p.parentPath),
      visibility: opts.visibility,
    },
  }))

  const tables: PlannedItem[] = exp.databases.map((d: NotionDatabase) => {
    const sheet = sheets.get(d.path)!
    if (sheet.rows.length > IMPORT_MAX_ROWS) notes.push({ level: 'warn', text: `“${d.name}” has ${sheet.rows.length.toLocaleString('en-US')} rows; only the first ${IMPORT_MAX_ROWS.toLocaleString('en-US')} come in.` })
    return {
      ref: dbRef.get(d.path)!,
      external_id: d.notionId,
      record: {
        kind: 'data_table' as const,
        name: d.name.slice(0, 200),
        folder: containerOf(d.parentPath),
        visibility: opts.visibility,
        headers: sheet.headers,
        rows: sheet.rows.slice(0, IMPORT_MAX_ROWS),
      },
    }
  })

  items.push(...assetItems, ...tables, ...docs)

  if (rowOnly) notes.push({ level: 'info', text: `${countOf(rowOnly, 'database row page has', 'database row pages have')} no text beyond the row, so they come in as table rows only.` })
  if (deadLinks) notes.push({ level: 'info', text: `${countOf(deadLinks, 'link points', 'links point')} at something outside the export; the link’s words are kept.` })
  const unused = exp.files.length - assetRef.size
  if (unused > 0) notes.push({ level: 'info', text: `${countOf(unused, 'file in the export isn’t', 'files in the export aren’t')} linked from any page and won’t be uploaded.` })
  for (const d of exp.dropped.slice(0, 10)) notes.push({ level: 'warn', text: `Left out: ${d}.` })
  if (exp.dropped.length > 10) notes.push({ level: 'warn', text: `And ${exp.dropped.length - 10} more left out.` })

  return {
    items,
    counts: { drive_folder: folders, document: docs.length, data_table: tables.length, asset: assetItems.length },
    notes,
  }
}

/** Fill a body's placeholders once every item has its id; an unknown one keeps nothing but its words. */
export function fillPlaceholders(body: string, resolve: (kind: 'ref' | 'asset', ref: string) => string | null): string {
  return body.replace(REF_PLACEHOLDER, (_m, kind: 'ref' | 'asset', ref: string) => resolve(kind, ref) ?? '#')
}
