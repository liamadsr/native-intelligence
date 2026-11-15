/**
 * The files a form takes (migration 663): what a submission's files must be
 * before anything is stored. A file a stranger sends is never trusted for
 * what it says it is, so each is decided by three things that must agree:
 *
 *   its name's extension   one of FORM_FILE_EXTENSIONS (images: JPEG, PNG,
 *                          WebP, HEIC, GIF; PDF; plain text and CSV; Word,
 *                          Excel and PowerPoint files). Nothing else: no
 *                          HTML, SVG, script, archive or program.
 *   its declared type      the browser's Content-Type for the part: the
 *                          kind's own type (or a known alias), or a generic
 *                          one (empty, application/octet-stream) that says
 *                          nothing either way. A declared type that names
 *                          another kind (text/html on a .png) is refused.
 *   its leading bytes      the kind's own signature: an image's magic
 *                          number, "%PDF-", text that is valid UTF-8 with no
 *                          control characters and does not start like a web
 *                          page (read 64 KiB at a time, never decoded whole),
 *                          and for Word, Excel and PowerPoint a zip whose
 *                          directory holds the format's own parts and none
 *                          that runs or reaches out: no VBA code or other
 *                          binary part (any .bin), nothing under embeddings/
 *                          or activeX/, no program, no relationship to an
 *                          outside target but an ordinary web or mail link
 *                          a reader clicks (TargetMode="External", read from
 *                          every _rels part, each at most OFFICE_RELS_MAX
 *                          bytes unpacked, at most OFFICE_RELS_PARTS_MAX of
 *                          them), and at most OFFICE_UNPACKED_MAX bytes
 *                          unpacked in all as its directory declares them (a
 *                          zip bomb is refused before anything opens it).
 *                          An outside relationship is refused even when it is
 *                          only a hyperlink: such a file can be sent as a PDF.
 *
 * The type stored with the file, and served with it, is the kind's own, from
 * this table: never what the browser declared. A name is cleaned (no path
 * parts, control or invisible characters, leading dots or characters a file
 * system or a download header can't take) and clipped with its extension
 * kept. An empty file is refused; at most FORM_FILE_LIMITS.maxFiles a
 * submission and FORM_FILE_LIMITS.maxBytes each.
 *
 * Nothing here runs a file, renders it or reads it with a model; only an
 * Office file's small _rels parts are unpacked, to be read as text. Pure.
 */
import { inflateRawSync } from 'node:zlib'
import { cleanText } from '@/lib/customers/intake'
import { FORM_FILE_LIMITS, type FormField } from './types'

/** One file part as the body reader found it. `bytes` is null when it was larger than a file may be (its size says so). */
export interface UploadedPart {
  name: string
  type: string
  size: number
  bytes: Uint8Array | null
}

/** A file that passed: its cleaned name, its kind's extension and type, and its bytes. */
export interface CheckedFile {
  name: string
  ext: string
  mime: string
  category: 'image' | 'document'
  size: number
  bytes: Uint8Array
}

type Kind = {
  mime: string
  category: 'image' | 'document'
  /** Declared types that name this kind. */
  declared: readonly string[]
  /** Whether the bytes are this kind's: true, false, or why a file of this kind is refused all the same. */
  sniff: (bytes: Uint8Array) => boolean | OfficeRefusal
}

/** Why a real Word, Excel or PowerPoint file is refused: it runs or reaches out, or it unpacks too large. */
type OfficeRefusal = 'active' | 'unpacks_large'

const ascii = (bytes: Uint8Array, at: number, text: string) => {
  if (bytes.length < at + text.length) return false
  for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false
  return true
}

const isJpeg = (b: Uint8Array) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
const isPng = (b: Uint8Array) => b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)
const isWebp = (b: Uint8Array) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')
const isGif = (b: Uint8Array) => ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a')
/** An HEIF image: an ISO box `ftyp` first, with an HEIF brand. */
const HEIF_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']
const isHeif = (b: Uint8Array) => ascii(b, 4, 'ftyp') && HEIF_BRANDS.some((brand) => ascii(b, 8, brand))
const isPdf = (b: Uint8Array) => ascii(b, 0, '%PDF-')

/** Control characters plain text never holds (tab, line ends and form feed are text). */
const TEXT_CONTROL = /[\u0000-\u0008\u000B\u000E-\u001F\u007F]/
/** How much of a text file is decoded at once: never the whole file as one string. */
const TEXT_PIECE = 64 * 1024
/**
 * Plain text: valid UTF-8, no control characters, and not starting like
 * markup (after a byte-order mark and whitespace, no `<`), so nothing that
 * sniffs it can take it for a page. Decoded TEXT_PIECE bytes at a time.
 */
function isPlainText(bytes: Uint8Array): boolean {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let leading = true
  const fits = (text: string) => {
    if (TEXT_CONTROL.test(text)) return false
    if (!leading) return true
    const rest = text.trimStart()
    if (!rest) return true
    leading = false
    return !rest.startsWith('<')
  }
  try {
    for (let at = 0; at < bytes.length; at += TEXT_PIECE) {
      if (!fits(decoder.decode(bytes.subarray(at, at + TEXT_PIECE), { stream: true }))) return false
    }
    return fits(decoder.decode())
  } catch {
    return false
  }
}

/** One entry of a zip's central directory: its sizes as declared there, and where its data starts. */
export interface ZipEntry {
  name: string
  flags: number
  /** 0 stored, 8 deflated; anything else this can't read. */
  method: number
  compressedSize: number
  /** Its size unpacked, as the directory declares it. */
  size: number
  /** Where its local header is. */
  offset: number
}

/** A zip's central directory, or null when it isn't a plain zip this can read (zip64, encrypted, damaged). */
export function zipEntries(bytes: Uint8Array, max = 5000): ZipEntry[] | null {
  if (!ascii(bytes, 0, 'PK\u0003\u0004')) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // The end-of-directory record sits in the last 22 bytes plus at most a 64 KB comment.
  let end = -1
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 22 - 0xffff); p--) {
    if (view.getUint32(p, true) === 0x06054b50) {
      end = p
      break
    }
  }
  if (end < 0) return null
  const count = view.getUint16(end + 10, true)
  const size = view.getUint32(end + 12, true)
  const offset = view.getUint32(end + 16, true)
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) return null
  if (count > max || offset + size > end) return null
  const entries: ZipEntry[] = []
  const decoder = new TextDecoder('utf-8')
  let p = offset
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || view.getUint32(p, true) !== 0x02014b50) return null
    const flags = view.getUint16(p + 8, true)
    if (flags & 0x1) return null
    const compressedSize = view.getUint32(p + 20, true)
    const unpacked = view.getUint32(p + 24, true)
    const local = view.getUint32(p + 42, true)
    // A zip64 entry's sizes live elsewhere: not a plain zip.
    if (compressedSize === 0xffffffff || unpacked === 0xffffffff || local === 0xffffffff) return null
    const nameLength = view.getUint16(p + 28, true)
    const extraLength = view.getUint16(p + 30, true)
    const commentLength = view.getUint16(p + 32, true)
    if (p + 46 + nameLength > end) return null
    entries.push({
      name: decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength)),
      flags,
      method: view.getUint16(p + 10, true),
      compressedSize,
      size: unpacked,
      offset: local,
    })
    p += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** The names in a zip's central directory, or null when it isn't a plain zip this can read (zip64, encrypted, damaged). */
export function zipEntryNames(bytes: Uint8Array, max = 5000): string[] | null {
  return zipEntries(bytes, max)?.map((e) => e.name) ?? null
}

/** One entry's bytes unpacked, at most `cap` of them; null when it can't be read within that. */
function zipEntryBytes(bytes: Uint8Array, entry: ZipEntry, cap: number): Uint8Array | null {
  if (entry.size > cap || entry.compressedSize > cap) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const p = entry.offset
  if (p + 30 > bytes.length || view.getUint32(p, true) !== 0x04034b50) return null
  const start = p + 30 + view.getUint16(p + 26, true) + view.getUint16(p + 28, true)
  const end = start + entry.compressedSize
  if (end > bytes.length) return null
  const data = bytes.subarray(start, end)
  if (entry.method === 0) return data
  if (entry.method !== 8) return null
  try {
    const out = inflateRawSync(data, { maxOutputLength: cap })
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
  } catch {
    return null
  }
}

/**
 * Parts no Word, Excel or PowerPoint file sent through a form may hold:
 * binary parts (VBA code is vbaProject.bin; an embedded object's data is a
 * .bin too), anything under embeddings/ or activeX/, and programs.
 */
const OFFICE_REFUSED = /(^|\/)(embeddings|activex)\/|\.(bin|exe|dll|com|bat|cmd|scr|msi|ps1|vbs|js|jar|sh)$/i
/** Bytes an Office file may unpack to in all, as its directory declares: a real one is far under it, a zip bomb far over. */
export const OFFICE_UNPACKED_MAX = 256 * 1024 * 1024
/** Bytes one _rels part may unpack to: a real one is a few KB. */
export const OFFICE_RELS_MAX = 512 * 1024
/** _rels parts one Office file may hold: one per part that has relationships. */
export const OFFICE_RELS_PARTS_MAX = 200
/** A relationship to something outside the file, after the XML's character references are read. */
const EXTERNAL_TARGET = /TargetMode\s*=\s*(["'])\s*External\s*\1/i
/** The one outside relationship a file may hold: a hyperlink, to a web or mail address. */
const CLICKED_LINK_TYPE = /\bType\s*=\s*(["'])[^"']*\/relationships\/hyperlink\1/i
const CLICKED_LINK_TARGET = /\bTarget\s*=\s*(["'])\s*(https?:\/\/|mailto:)[^"']*\1/i
const XML_NAMED: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** XML text with its character references (&#69;, &#x45;, &quot;) read, so a disguised attribute reads as itself. */
function xmlText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] !== '#') return XML_NAMED[ref.toLowerCase()] ?? whole
    const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
  })
}

/** Whether a _rels part points outside the file, or can't be read as one (UTF-16, too large, damaged): either refuses it. */
function relsReachOut(bytes: Uint8Array, entry: ZipEntry): boolean {
  const data = zipEntryBytes(bytes, entry, OFFICE_RELS_MAX)
  if (!data || data.includes(0)) return true
  const text = xmlText(data)
  if (!EXTERNAL_TARGET.test(text)) return false
  // An outside relationship is fine only when it is an ordinary link a reader clicks (a web or mail address in a
  // hyperlink relationship): a CV links its author's site. Anything else outside (a remote template, an OLE link, an
  // image or frame fetched when the file opens) loads without a click, and is refused. Judged one relationship at a time.
  const relationships = text.match(/<\s*Relationship\b[^>]*>/gi) ?? []
  const outside = relationships.filter((r) => EXTERNAL_TARGET.test(r))
  // "External" somewhere this could not pin to a relationship element: refused.
  if (!outside.length) return true
  return !outside.every((r) => CLICKED_LINK_TYPE.test(r) && CLICKED_LINK_TARGET.test(r))
}

/**
 * An Office Open XML file: a zip holding the format's content types and its
 * main part, with nothing in it that runs or reaches out, and not unpacking
 * too large (see the header).
 */
function isOffice(main: string) {
  return (bytes: Uint8Array): boolean | OfficeRefusal => {
    const entries = zipEntries(bytes)
    if (!entries) return false
    const names = entries.map((e) => e.name)
    if (names.some((n) => n.startsWith('/') || n.split('/').includes('..'))) return false
    if (!names.includes('[Content_Types].xml') || !names.includes(main)) return false
    if (names.some((n) => OFFICE_REFUSED.test(n))) return 'active'
    if (entries.reduce((sum, e) => sum + e.size, 0) > OFFICE_UNPACKED_MAX) return 'unpacks_large'
    const rels = entries.filter((e) => /\.rels$/i.test(e.name))
    if (rels.length > OFFICE_RELS_PARTS_MAX || rels.some((e) => relsReachOut(bytes, e))) return 'active'
    return true
  }
}

const OOXML = 'application/vnd.openxmlformats-officedocument'
const ZIP_TYPES = ['application/zip', 'application/x-zip-compressed']

/** Each extension a form takes, and how its kind is told. */
const KINDS: Readonly<Record<string, Kind>> = {
  jpg: { mime: 'image/jpeg', category: 'image', declared: ['image/jpeg', 'image/jpg', 'image/pjpeg'], sniff: isJpeg },
  jpeg: { mime: 'image/jpeg', category: 'image', declared: ['image/jpeg', 'image/jpg', 'image/pjpeg'], sniff: isJpeg },
  png: { mime: 'image/png', category: 'image', declared: ['image/png', 'image/x-png'], sniff: isPng },
  webp: { mime: 'image/webp', category: 'image', declared: ['image/webp'], sniff: isWebp },
  gif: { mime: 'image/gif', category: 'image', declared: ['image/gif'], sniff: isGif },
  heic: { mime: 'image/heic', category: 'image', declared: ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'], sniff: isHeif },
  heif: { mime: 'image/heif', category: 'image', declared: ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'], sniff: isHeif },
  pdf: { mime: 'application/pdf', category: 'document', declared: ['application/pdf', 'application/x-pdf'], sniff: isPdf },
  txt: { mime: 'text/plain', category: 'document', declared: ['text/plain'], sniff: isPlainText },
  // Windows says a CSV is an Excel file.
  csv: { mime: 'text/csv', category: 'document', declared: ['text/csv', 'application/csv', 'text/comma-separated-values', 'text/plain', 'application/vnd.ms-excel'], sniff: isPlainText },
  docx: { mime: `${OOXML}.wordprocessingml.document`, category: 'document', declared: [`${OOXML}.wordprocessingml.document`, ...ZIP_TYPES], sniff: isOffice('word/document.xml') },
  xlsx: { mime: `${OOXML}.spreadsheetml.sheet`, category: 'document', declared: [`${OOXML}.spreadsheetml.sheet`, ...ZIP_TYPES], sniff: isOffice('xl/workbook.xml') },
  pptx: { mime: `${OOXML}.presentationml.presentation`, category: 'document', declared: [`${OOXML}.presentationml.presentation`, ...ZIP_TYPES], sniff: isOffice('ppt/presentation.xml') },
}

/** Declared types that say nothing about the file. */
const GENERIC_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream'])

/** What a person is told a form takes. */
export const FORM_FILE_KINDS_TEXT = 'images (JPEG, PNG, WebP, HEIC or GIF), PDFs, text and CSV files, and Word, Excel or PowerPoint files'

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`

/** C1 control characters, which cleanText keeps. */
const C1_CONTROLS = /[\u0080-\u009F]/g
/** Characters a file system or a download's header can't take in a name. */
const NAME_UNSAFE = /["*:<>?|;]/g

/** A name's extension, lower case, or ''. Pure. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : ''
}

/**
 * A file's name as it is stored: its last path part only, no control,
 * invisible or unsafe characters, no leading dots, one line, at most
 * FORM_FILE_LIMITS.name characters with its extension kept. Null when
 * nothing is left. Pure.
 */
export function cleanFileName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const last = raw.split(/[/\\]/).pop() ?? ''
  let name = cleanText(last.normalize('NFC').replace(C1_CONTROLS, ''), 10_000) ?? ''
  name = name.replace(NAME_UNSAFE, '_').replace(/^[.\s]+/, '').trim()
  if (!name) return null
  const max = FORM_FILE_LIMITS.name
  if (name.length <= max) return name
  const ext = extensionOf(name)
  if (!ext || ext.length > 10) return name.slice(0, max).trimEnd()
  const base = name.slice(0, name.length - ext.length - 1)
  return `${base.slice(0, max - ext.length - 1).trimEnd()}.${ext}`
}

/** The kind a cleaned name, a declared type and the bytes agree on, or why not. Pure. */
export function decideFileKind(name: string, declared: string, bytes: Uint8Array): { ok: true; ext: string; mime: string; category: 'image' | 'document' } | { ok: false; error: string } {
  const ext = extensionOf(name)
  const kind = Object.prototype.hasOwnProperty.call(KINDS, ext) ? KINDS[ext] : null
  if (!kind) return { ok: false, error: `"${name}" isn't a kind of file this form takes. It takes ${FORM_FILE_KINDS_TEXT}.` }
  const type = declared.split(';')[0].trim().toLowerCase()
  if (!GENERIC_TYPES.has(type) && !kind.declared.includes(type)) return { ok: false, error: `"${name}" isn't what its name says it is.` }
  const sniffed = kind.sniff(bytes)
  if (sniffed === 'active') return { ok: false, error: `"${name}" holds macros, embedded objects or links to outside files, which this form doesn't take. Send it as a PDF instead.` }
  if (sniffed === 'unpacks_large') return { ok: false, error: `"${name}" is far larger unpacked than a document can be.` }
  if (!sniffed) return { ok: false, error: `"${name}" isn't what its name says it is.` }
  return { ok: true, ext, mime: kind.mime, category: kind.category }
}

export type CheckFilesResult = { ok: true; files: CheckedFile[] } | { ok: false; error: string }

/**
 * A submission's files against its form's files field (see the header).
 * `parts` are every file part the body carried. Pure.
 */
export function checkFormFiles(field: FormField, parts: readonly UploadedPart[]): CheckFilesResult {
  if (parts.length === 0) return field.required ? { ok: false, error: `${field.label} is required.` } : { ok: true, files: [] }
  if (parts.length > FORM_FILE_LIMITS.maxFiles) return { ok: false, error: `Send at most ${FORM_FILE_LIMITS.maxFiles} files.` }
  const files: CheckedFile[] = []
  for (const part of parts) {
    const name = cleanFileName(part.name)
    if (!name) return { ok: false, error: 'Each file needs a name.' }
    if (part.size === 0 || (part.bytes && part.bytes.length === 0)) return { ok: false, error: `"${name}" is empty.` }
    if (part.size > FORM_FILE_LIMITS.maxBytes || !part.bytes || part.bytes.length > FORM_FILE_LIMITS.maxBytes) {
      return { ok: false, error: `"${name}" is larger than ${megabytes(FORM_FILE_LIMITS.maxBytes)}.` }
    }
    const kind = decideFileKind(name, part.type, part.bytes)
    if (!kind.ok) return kind
    files.push({ name, ext: kind.ext, mime: kind.mime, category: kind.category, size: part.bytes.length, bytes: part.bytes })
  }
  return { ok: true, files }
}

/**
 * Where a form's file is stored in the attachments bucket: under forms/, by
 * workspace and form, named by a random id (`id`, a UUID) and its kind's
 * extension. Never anything the sender chose, so it can't collide or be
 * guessed. Pure.
 */
export function formFilePath(workspaceId: string, formId: string, id: string, ext: string): string {
  return `forms/${workspaceId}/${formId}/${id}.${ext}`
}
