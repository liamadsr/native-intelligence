import { deflateRawSync } from 'node:zlib'

/** A tiny stored (uncompressed) zip with these entry names, for the type checks' tests. Each entry is empty. */
export function zipOf(names: readonly string[], opts: { encrypted?: boolean } = {}): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const name of names) {
    const n = enc.encode(name)
    const local = new Uint8Array(30 + n.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, opts.encrypted ? 1 : 0, true)
    lv.setUint16(26, n.length, true)
    local.set(n, 30)
    const central = new Uint8Array(46 + n.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, opts.encrypted ? 1 : 0, true)
    cv.setUint16(28, n.length, true)
    cv.setUint32(42, offset, true)
    central.set(n, 46)
    locals.push(local)
    centrals.push(central)
    offset += local.length
  }
  const cdSize = centrals.reduce((s, c) => s + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, names.length, true)
  ev.setUint16(10, names.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)
  const out = new Uint8Array(offset + cdSize + 22)
  let at = 0
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at)
    at += part.length
  }
  return out
}

export const bytesOf = (...parts: Array<string | number[]>): Uint8Array<ArrayBuffer> => {
  const enc = new TextEncoder()
  const chunks = parts.map((p) => (typeof p === 'string' ? enc.encode(p) : Uint8Array.from(p)))
  const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0))
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

export const PNG = bytesOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'IHDR rest of a picture')
export const JPEG = bytesOf([0xff, 0xd8, 0xff, 0xe0], 'JFIF rest')
export const GIF = bytesOf('GIF89a', 'rest')
export const WEBP = bytesOf('RIFF', [0, 0, 0, 0], 'WEBPVP8 rest')
export const HEIC = bytesOf([0, 0, 0, 24], 'ftypheic', [0, 0, 0, 0], 'mif1heic')
export const PDF = bytesOf('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n')
export const DOCX = zipOf(['[Content_Types].xml', '_rels/.rels', 'word/document.xml'])
export const XLSX = zipOf(['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml'])
export const PPTX = zipOf(['[Content_Types].xml', 'ppt/presentation.xml'])

/** One entry of {@link zipWith}: its bytes (stored, or deflated), and the unpacked size its directory declares when that should lie. */
export interface ZipFixtureEntry {
  name: string
  data?: Uint8Array | string
  deflate?: boolean
  declaredSize?: number
  /** The method the directory declares, when it should not match the bytes. */
  method?: number
}

/** A zip with these entries and their bytes, stored or deflated, for the Office checks' tests. */
export function zipWith(entries: readonly ZipFixtureEntry[]): Uint8Array {
  const enc = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const e of entries) {
    const n = enc.encode(e.name)
    const raw = typeof e.data === 'string' ? enc.encode(e.data) : (e.data ?? new Uint8Array(0))
    const body = e.deflate ? new Uint8Array(deflateRawSync(raw)) : raw
    const method = e.method ?? (e.deflate ? 8 : 0)
    const size = e.declaredSize ?? raw.length
    const local = new Uint8Array(30 + n.length + body.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(8, method, true)
    lv.setUint32(18, body.length, true)
    lv.setUint32(22, size, true)
    lv.setUint16(26, n.length, true)
    local.set(n, 30)
    local.set(body, 30 + n.length)
    const central = new Uint8Array(46 + n.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(10, method, true)
    cv.setUint32(20, body.length, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, n.length, true)
    cv.setUint32(42, offset, true)
    central.set(n, 46)
    locals.push(local)
    centrals.push(central)
    offset += local.length
  }
  const cdSize = centrals.reduce((s, c) => s + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)
  const out = new Uint8Array(offset + cdSize + 22)
  let at = 0
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at)
    at += part.length
  }
  return out
}
