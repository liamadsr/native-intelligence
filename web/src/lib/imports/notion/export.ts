/**
 * Reading a Notion export (docs/plans/imports.md, phase 3).
 *
 * Notion's "Export → Markdown & CSV" is a .zip (often a zip holding one or
 * more zips) laid out as:
 *
 *   Page Title 1a2b…(32 hex).md        a page
 *   Page Title 1a2b…/                  its subpages and files
 *   Tasks 3c4d….csv                    a database (sometimes also `…_all.csv`)
 *   Tasks 3c4d…/Row Title 5e6f….md     the database's row pages
 *   Page Title 1a2b…/image.png         an image or file a page holds
 *
 * This reads the zip into a flat tree: pages, databases and files, each with
 * its path and the page or database it sits under. It never trusts a path: one
 * that climbs out (`..`), is absolute, or names a drive is refused; the
 * entries, their unpacked size and the nesting of zips are all capped, so a
 * zip bomb stops at the cap rather than filling memory.
 *
 * Server-side (jszip), no I/O beyond the bytes given.
 */
import JSZip from 'jszip'

export const NOTION_LIMITS = {
  /** The uploaded file. */
  zipBytes: 50 * 1024 * 1024,
  /** Everything unpacked, nested zips included. */
  unpackedBytes: 200 * 1024 * 1024,
  /** Entries read, nested zips included. */
  entries: 2000,
  /** Folders deep, for one entry's path. */
  pathDepth: 16,
  /** Zips inside zips. */
  nesting: 2,
  pages: 1000,
  databases: 50,
  /** One image or file. */
  fileBytes: 10 * 1024 * 1024,
  /** One page's markdown. */
  pageBytes: 1024 * 1024,
  /** One database's CSV. */
  csvBytes: 5 * 1024 * 1024,
} as const

export interface NotionPage {
  /** Its path in the export, folders joined with `/`. */
  path: string
  /** Notion's id (32 hex), or null when the name has none. */
  notionId: string | null
  title: string
  markdown: string
  /** The page or database it sits under (by path), or null at the top. */
  parentPath: string | null
}

export interface NotionDatabase {
  path: string
  notionId: string | null
  name: string
  csv: string
  parentPath: string | null
}

export interface NotionFile {
  path: string
  fileName: string
  mimeType: string
  bytes: Uint8Array
}

export interface NotionExport {
  pages: NotionPage[]
  databases: NotionDatabase[]
  files: NotionFile[]
  /** What was left out, and why: shown in the preview. */
  dropped: string[]
}

export type NotionReadResult = { ok: true; export: NotionExport } | { ok: false; error: string }

const HEX_ID = /^(.*?)\s+([0-9a-f]{32})$/i

/** "Page Title 1a2b…" → its title and Notion's id. */
export function splitNotionName(base: string): { title: string; notionId: string | null } {
  const m = HEX_ID.exec(base.trim())
  if (m) return { title: m[1].trim() || 'Untitled', notionId: m[2].toLowerCase() }
  return { title: base.trim() || 'Untitled', notionId: null }
}

/** A path inside a zip made safe, or null when it can't be. */
export function safeEntryPath(name: string): string | null {
  const unified = name.replace(/\\/g, '/')
  if (unified.startsWith('/') || /^[a-z]:/i.test(unified)) return null
  const parts = unified.split('/').filter((p) => p !== '' && p !== '.')
  if (!parts.length || parts.some((p) => p === '..')) return null
  if (parts.length > NOTION_LIMITS.pathDepth) return null
  // macOS's resource-fork folder and dot files are no one's content.
  if (parts.some((p) => p === '__MACOSX' || p.startsWith('.'))) return null
  return parts.join('/')
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip', heic: 'image/heic',
}

export function mimeFor(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  return MIME[ext] ?? 'application/octet-stream'
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

function baseOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function stem(fileName: string): string {
  const i = fileName.lastIndexOf('.')
  return i <= 0 ? fileName : fileName.slice(0, i)
}

interface RawEntry {
  path: string
  bytes: Uint8Array
}

/** Read the zip's entries, opening nested zips, under every cap. */
async function readEntries(bytes: Uint8Array): Promise<{ ok: true; entries: RawEntry[]; dropped: string[] } | { ok: false; error: string }> {
  const entries: RawEntry[] = []
  const dropped: string[] = []
  let seen = 0
  let unpacked = 0

  const walk = async (data: Uint8Array, prefix: string, depth: number): Promise<string | null> => {
    let zip: JSZip
    try {
      zip = await JSZip.loadAsync(data)
    } catch {
      return depth === 0 ? 'That file isn’t a zip Notion made. Export with “Markdown & CSV” and upload the .zip.' : null
    }
    const files = Object.values(zip.files).filter((f) => !f.dir)
    for (const f of files) {
      seen++
      if (seen > NOTION_LIMITS.entries) return `The export holds more than ${NOTION_LIMITS.entries.toLocaleString('en-US')} files. Export a smaller part of the workspace.`
      const safe = safeEntryPath(f.name)
      if (!safe) {
        if (!/(^|\/)(__MACOSX|\.[^/]*)(\/|$)/.test(f.name.replace(/\\/g, '/'))) dropped.push(`${f.name.slice(0, 80)}: its path isn’t safe`)
        continue
      }
      // A size the zip declares; checked again on the real bytes.
      const declared = (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0
      if (declared && unpacked + declared > NOTION_LIMITS.unpackedBytes) return 'The export is over 200 MB unpacked. Export a smaller part of the workspace.'
      const content = await f.async('uint8array')
      unpacked += content.byteLength
      if (unpacked > NOTION_LIMITS.unpackedBytes) return 'The export is over 200 MB unpacked. Export a smaller part of the workspace.'
      if (safe.toLowerCase().endsWith('.zip')) {
        if (depth + 1 > NOTION_LIMITS.nesting) {
          dropped.push(`${safe}: a zip nested too deep`)
          continue
        }
        // Notion's outer zip holds parts named "Export-….zip"; their insides sit at the top.
        const err = await walk(content, prefix, depth + 1)
        if (err) return err
        continue
      }
      entries.push({ path: prefix ? `${prefix}/${safe}` : safe, bytes: content })
    }
    return null
  }

  if (bytes.byteLength > NOTION_LIMITS.zipBytes) return { ok: false, error: 'That file is over 50 MB. Export a smaller part of the workspace.' }
  const err = await walk(bytes, '', 0)
  if (err) return { ok: false, error: err }
  return { ok: true, entries, dropped }
}

const decoder = new TextDecoder('utf-8')

/**
 * The export as a tree. A page's parent is the page or database whose folder
 * holds it: `A <id>/B <id>.md` sits under `A <id>.md` (or `A <id>.csv`).
 */
export async function readNotionExport(bytes: Uint8Array): Promise<NotionReadResult> {
  const read = await readEntries(bytes)
  if (!read.ok) return read
  const dropped = [...read.dropped]

  // Folder (without extension) → the page or database it belongs to.
  const owners = new Map<string, string>()
  const csvs = read.entries.filter((e) => e.path.toLowerCase().endsWith('.csv'))
  const mds = read.entries.filter((e) => e.path.toLowerCase().endsWith('.md'))
  for (const e of [...mds, ...csvs]) {
    const folder = stem(e.path).replace(/_all$/, '')
    if (!owners.has(folder)) owners.set(folder, e.path)
  }
  const parentOf = (path: string): string | null => {
    let dir = dirOf(path)
    while (dir) {
      const owner = owners.get(dir)
      if (owner && owner !== path) return owner
      dir = dirOf(dir)
    }
    return null
  }

  const pages: NotionPage[] = []
  for (const e of mds) {
    if (pages.length >= NOTION_LIMITS.pages) {
      dropped.push(`${baseOf(e.path)}: more than ${NOTION_LIMITS.pages} pages`)
      continue
    }
    if (e.bytes.byteLength > NOTION_LIMITS.pageBytes) {
      dropped.push(`${baseOf(e.path)}: a page over 1 MB`)
      continue
    }
    const { title, notionId } = splitNotionName(stem(baseOf(e.path)))
    pages.push({ path: e.path, notionId, title, markdown: decoder.decode(e.bytes).replace(/^﻿/, ''), parentPath: parentOf(e.path) })
  }

  // A database comes as `X.csv` and often `X_all.csv` too (every row, not just the view's): keep the fuller one.
  const byFolder = new Map<string, RawEntry>()
  for (const e of csvs) {
    const folder = stem(e.path).replace(/_all$/, '')
    const prev = byFolder.get(folder)
    if (!prev || /_all\.csv$/i.test(e.path)) byFolder.set(folder, e)
  }
  const databases: NotionDatabase[] = []
  for (const [folder, e] of byFolder) {
    if (databases.length >= NOTION_LIMITS.databases) {
      dropped.push(`${baseOf(e.path)}: more than ${NOTION_LIMITS.databases} databases`)
      continue
    }
    if (e.bytes.byteLength > NOTION_LIMITS.csvBytes) {
      dropped.push(`${baseOf(e.path)}: a database over 5 MB`)
      continue
    }
    const { title, notionId } = splitNotionName(baseOf(folder))
    const path = `${folder}.csv`
    databases.push({ path, notionId, name: title, csv: decoder.decode(e.bytes).replace(/^﻿/, ''), parentPath: parentOf(path) })
    // Links and parents name the folder's own csv: keep one owner path for both spellings.
    owners.set(folder, path)
  }
  // Row pages found their parent before the database's owner path was settled.
  for (const p of pages) p.parentPath = parentOf(p.path)

  const files: NotionFile[] = []
  for (const e of read.entries) {
    const lower = e.path.toLowerCase()
    if (lower.endsWith('.md') || lower.endsWith('.csv')) continue
    if (e.bytes.byteLength > NOTION_LIMITS.fileBytes) {
      dropped.push(`${baseOf(e.path)}: a file over 10 MB`)
      continue
    }
    files.push({ path: e.path, fileName: baseOf(e.path), mimeType: mimeFor(e.path), bytes: e.bytes })
  }

  if (!pages.length && !databases.length) return { ok: false, error: 'No Notion pages or databases in that zip. Export with “Markdown & CSV”.' }
  return { ok: true, export: { pages, databases, files, dropped } }
}

/** Just the files of an export (images and attachments), by path: what Apply uploads. */
export async function readNotionExportFiles(bytes: Uint8Array): Promise<Map<string, Uint8Array> | null> {
  const read = await readNotionExport(bytes)
  return read.ok ? new Map(read.export.files.map((f) => [f.path, f.bytes])) : null
}
