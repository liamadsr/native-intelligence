/**
 * Server-side text extraction for attachments — slice 0 of context packages.
 *
 * Until now only png/jpg/pdf got any processing (a single Gemini multimodal
 * vector whose stored chunk_text was literally the filename — see the
 * 2026-08-13 knowledge-layer audit), and docx/pptx/md/txt/json/yaml got
 * nothing at all. This module turns an attachment's bytes into real text so
 * attachment_chunks can hold searchable, readable content, which also
 * un-breaks the ingest_source-on-attachment path (it reads chunk_text and
 * previously found only filenames).
 *
 * Consumers: src/lib/inngest/attachment-embedding.ts (indexing), and — next
 * slice — package ingestion (deck/doc → play cards).
 */

import mammoth from 'mammoth'
import JSZip from 'jszip'
import { EMBEDDABLE_EXTENSIONS } from '@/lib/ai/gemini-embeddings'

/** Extensions this module can turn into text (pdf = text layer, best-effort). */
export const TEXT_EXTRACTABLE_EXTENSIONS = new Set([
  'pdf',
  'docx',
  'pptx',
  'md',
  'txt',
  'json',
  'yaml',
  'yml',
  'csv',
])

/**
 * Everything the attachment/index pipeline can do something useful with:
 * Gemini-multimodal formats (png/jpg/pdf) ∪ text-extractable formats. The
 * upload/reindex gates fire the indexing event for this set.
 */
export const INDEXABLE_ATTACHMENT_EXTENSIONS = new Set([
  ...EMBEDDABLE_EXTENSIONS,
  ...TEXT_EXTRACTABLE_EXTENSIONS,
])

/** Plain-text formats that pass straight through. */
const PASSTHROUGH_EXTENSIONS = new Set(['md', 'txt', 'json', 'yaml', 'yml', 'csv'])

/** Total extracted text is capped — an outlier file must not balloon the DB row set. */
const MAX_TEXT_CHARS = 400_000

/** Below this, a "text layer" is noise (scanned PDFs, empty docs) — treat as none. */
const MIN_MEANINGFUL_CHARS = 40

function capText(text: string): string {
  const trimmed = text.replace(/^﻿/, '').trim()
  return trimmed.length > MAX_TEXT_CHARS ? trimmed.slice(0, MAX_TEXT_CHARS) : trimmed
}

/** Decode the `<a:t>` text runs of one DrawingML XML part, in document order. */
function drawingMlText(xml: string): string {
  const runs: string[] = []
  const re = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    runs.push(
      m[1]
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&'),
    )
  }
  return runs.join(' ').replace(/\s+/g, ' ').trim()
}

/** Zip-bomb guards for pptx: a crafted deck inside the 50MB upload cap can
 * deflate 1000:1, so cap slides, per-part expansion, and cumulative text. */
const MAX_PPTX_SLIDES = 300
const MAX_PPTX_PART_CHARS = 5_000_000

/** Decompress one zip part as text, refusing parts that expand too far. */
async function zipPartText(file: JSZip.JSZipObject): Promise<string | null> {
  const declared = (file as unknown as { _data?: { uncompressedSize?: number } })._data
    ?.uncompressedSize
  if (typeof declared === 'number' && declared > MAX_PPTX_PART_CHARS) return null
  const text = await file.async('string')
  return text.length > MAX_PPTX_PART_CHARS ? null : text
}

/** pptx = zip of slide XMLs. Slide order is the deck's story; speaker notes carry the talk track. */
async function extractPptx(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(new Uint8Array(buffer))
  const slideNumber = (path: string): number =>
    Number(path.match(/(\d+)\.xml$/)?.[1] ?? Number.MAX_SAFE_INTEGER)
  const partsOf = (dir: string, prefix: string): string[] =>
    Object.keys(zip.files)
      .filter((p) => p.startsWith(`${dir}/${prefix}`) && p.endsWith('.xml'))
      .sort((a, b) => slideNumber(a) - slideNumber(b))

  const sections: string[] = []
  let total = 0
  for (const slidePath of partsOf('ppt/slides', 'slide').slice(0, MAX_PPTX_SLIDES)) {
    const n = slideNumber(slidePath)
    const xml = await zipPartText(zip.files[slidePath])
    if (xml === null) continue
    const body = drawingMlText(xml)
    const notesPath = `ppt/notesSlides/notesSlide${n}.xml`
    const notesXml = zip.files[notesPath] ? await zipPartText(zip.files[notesPath]) : null
    const notes = notesXml ? drawingMlText(notesXml) : ''
    const parts = [body, notes ? `Notes: ${notes}` : ''].filter(Boolean)
    if (parts.length) sections.push(`## Slide ${n}\n${parts.join('\n')}`)
    total += parts.reduce((s, p) => s + p.length, 0)
    if (total > MAX_TEXT_CHARS) break // capText trims the tail anyway
  }
  return sections.join('\n\n')
}

async function extractPdf(buffer: Buffer): Promise<string> {
  // unpdf is ESM-only; dynamic import keeps this module loadable everywhere.
  const { extractText, getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  const { text } = await extractText(pdf, { mergePages: true })
  return text
}

/**
 * Extract readable text from an attachment's bytes.
 * Returns null when the format is unsupported or yields no meaningful text
 * (e.g. a scanned PDF with no text layer) — callers keep their existing
 * behavior for that case rather than storing junk.
 */
export async function extractAttachmentText(
  buffer: Buffer,
  extension: string,
): Promise<string | null> {
  const ext = extension.toLowerCase()
  let text: string
  if (PASSTHROUGH_EXTENSIONS.has(ext)) {
    text = buffer.toString('utf8')
  } else if (ext === 'docx') {
    // Cast bridges Node's Buffer<ArrayBufferLike> against mammoth's stricter
    // typed-array generics (TS 5.7 typed-array split); runtime shape is fine.
    const input = { buffer } as unknown as Parameters<typeof mammoth.extractRawText>[0]
    text = (await mammoth.extractRawText(input)).value
  } else if (ext === 'pptx') {
    text = await extractPptx(buffer)
  } else if (ext === 'pdf') {
    text = await extractPdf(buffer)
  } else {
    return null
  }
  const capped = capText(text)
  return capped.length >= MIN_MEANINGFUL_CHARS ? capped : null
}

/**
 * Split extracted text into embedding-sized chunks, preferring paragraph
 * boundaries. Chunk count is capped: an outlier document indexes its head
 * rather than running up an unbounded embedding bill.
 */
export function chunkText(
  text: string,
  chunkSize = 3500,
  maxChunks = 40,
): string[] {
  const chunks: string[] = []
  let rest = text.trim()
  while (rest.length > 0 && chunks.length < maxChunks) {
    if (rest.length <= chunkSize) {
      chunks.push(rest)
      break
    }
    const window = rest.slice(0, chunkSize)
    // Break at the last paragraph (then line, then space) boundary in the
    // window, as long as it doesn't leave a degenerate sliver.
    const breakAt = ['\n\n', '\n', ' ']
      .map((sep) => window.lastIndexOf(sep))
      .find((i) => i > chunkSize * 0.5)
    const cut = breakAt && breakAt > 0 ? breakAt : chunkSize
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  return chunks.filter((c) => c.length > 0)
}
