/**
 * A .pptx's slides, basic: each slide's paragraphs of text (title first, as
 * the slide lists them), its speaker notes, and the pictures it places, read
 * from the public file format (ECMA-376 PresentationML) over the zip (jszip,
 * MIT). Isomorphic; the viewer reads it in the browser from the file's own
 * bytes. Layout, themes, charts and animations are not drawn: the viewer
 * offers the file as a download for those.
 *
 * Only parts looked up by name are read (a crafted path cannot escape the
 * archive), and the slides, pictures and expanded bytes are capped.
 */
import JSZip from 'jszip'

export interface PptxSlide {
  number: number
  /** Paragraphs in reading order; empty ones dropped. */
  paragraphs: string[]
  notes: string
  /** Pictures the slide places, as zip part paths (ppt/media/...). */
  images: string[]
}

export interface PptxDeck {
  slides: PptxSlide[]
  /** More slides than MAX_PPTX_SLIDES: the rest were left out. */
  truncated: boolean
  zip: JSZip
}

export const MAX_PPTX_SLIDES = 300
const MAX_PART_CHARS = 4_000_000

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** XML text with its entities decoded. */
export function decodeXmlText(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** The paragraphs (`<a:p>`) of one DrawingML part, each its runs joined. */
export function drawingParagraphs(xml: string): string[] {
  const out: string[] = []
  for (const p of xml.matchAll(/<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g)) {
    const runs = [...p[1].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\s*\/>/g)].map((r) => (r[1] === undefined ? '\n' : decodeXmlText(r[1])))
    const text = runs.join('').trim()
    if (text) out.push(text)
  }
  return out
}

/** A relationship target resolved against the part it is relative to (`ppt/slides/`). */
export function resolvePartPath(baseDir: string, target: string): string | null {
  if (/^[a-z]+:/i.test(target)) return null // external link
  const parts = (target.startsWith('/') ? target.slice(1) : `${baseDir}/${target}`).split('/')
  const stack: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (!stack.length) return null
      stack.pop()
    } else stack.push(part)
  }
  return stack.join('/')
}

async function partText(zip: JSZip, path: string): Promise<string | null> {
  const file = zip.file(path)
  if (!file) return null
  const text = await file.async('string')
  return text.length > MAX_PART_CHARS ? text.slice(0, MAX_PART_CHARS) : text
}

/** The slide part paths in the deck's own order (presentation.xml), else by number. */
async function slideOrder(zip: JSZip): Promise<string[]> {
  const pres = await partText(zip, 'ppt/presentation.xml')
  const rels = await partText(zip, 'ppt/_rels/presentation.xml.rels')
  if (pres && rels) {
    const targets = new Map<string, string>()
    for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
      const id = /\bId="([^"]+)"/.exec(m[1])?.[1]
      const target = /\bTarget="([^"]+)"/.exec(m[1])?.[1]
      if (id && target) targets.set(id, target)
    }
    const ordered: string[] = []
    for (const m of pres.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)) {
      const target = targets.get(m[1])
      const path = target ? resolvePartPath('ppt', target) : null
      if (path && zip.file(path)) ordered.push(path)
    }
    if (ordered.length) return ordered
  }
  return Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]))
}

/** Read a .pptx's slides (see the header). Throws a plain sentence when it is not one. */
export async function readPptxSlides(bytes: ArrayBuffer | Uint8Array): Promise<PptxDeck> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch {
    throw new Error('This file is not a PowerPoint (.pptx) presentation.')
  }
  const order = await slideOrder(zip)
  if (!order.length) throw new Error('This presentation has no slides to show.')
  const slides: PptxSlide[] = []
  for (const [i, path] of order.slice(0, MAX_PPTX_SLIDES).entries()) {
    const xml = (await partText(zip, path)) ?? ''
    const name = path.split('/').pop() ?? ''
    const rels = (await partText(zip, `ppt/slides/_rels/${name}.rels`)) ?? ''
    const relTargets = new Map<string, { type: string; target: string }>()
    for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
      const id = /\bId="([^"]+)"/.exec(m[1])?.[1]
      const target = /\bTarget="([^"]+)"/.exec(m[1])?.[1]
      const type = /\bType="([^"]+)"/.exec(m[1])?.[1] ?? ''
      if (id && target && !/\bTargetMode="External"/.test(m[1])) relTargets.set(id, { type, target })
    }
    const images: string[] = []
    for (const m of xml.matchAll(/<a:blip\b[^>]*\br:embed="([^"]+)"/g)) {
      const rel = relTargets.get(m[1])
      const resolved = rel ? resolvePartPath('ppt/slides', rel.target) : null
      if (resolved && resolved.startsWith('ppt/media/') && zip.file(resolved) && !images.includes(resolved)) images.push(resolved)
    }
    let notes = ''
    for (const rel of relTargets.values()) {
      if (!rel.type.endsWith('/notesSlide')) continue
      const notesPath = resolvePartPath('ppt/slides', rel.target)
      const notesXml = notesPath ? await partText(zip, notesPath) : null
      // A notes page repeats the slide number as its own paragraph; keep the words.
      if (notesXml) notes = drawingParagraphs(notesXml).filter((p) => !/^\d+$/.test(p)).join('\n')
    }
    slides.push({ number: i + 1, paragraphs: drawingParagraphs(xml), notes, images })
  }
  return { slides, truncated: order.length > MAX_PPTX_SLIDES, zip }
}

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
}

/** A slide picture's MIME type by its extension, or null for one a browser can't show safely (emf, wmf, svg, tiff...). */
export function slideImageType(path: string): string | null {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_TYPES[ext] ?? null
}
