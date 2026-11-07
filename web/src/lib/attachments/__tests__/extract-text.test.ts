/**
 * Tests for extract-text — slice 0 of context packages.
 *
 * Covers the hand-rolled parts: the pptx XML walk (slide ordering, speaker
 * notes, entity unescaping), plain-text passthrough (BOM strip, the
 * min-meaningful-chars gate, the total cap), and chunkText boundaries.
 * mammoth (docx) and unpdf (pdf text layer) are exercised upstream.
 */
import { describe, it, expect, vi } from 'vitest'
import JSZip from 'jszip'

vi.mock('@/lib/ai/gemini-embeddings', () => ({
  EMBEDDABLE_EXTENSIONS: new Set(['png', 'jpg', 'jpeg', 'pdf']),
}))

const { extractAttachmentText, chunkText, INDEXABLE_ATTACHMENT_EXTENSIONS, TEXT_EXTRACTABLE_EXTENSIONS } =
  await import('@/lib/attachments/extract-text')

function slideXml(texts: string[]): string {
  const runs = texts.map((t) => `<a:r><a:rPr lang="en-US"/><a:t>${t}</a:t></a:r>`).join('')
  return `<?xml version="1.0"?><p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p>${runs}</a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
}

async function buildPptx(parts: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip()
  for (const [path, xml] of Object.entries(parts)) zip.file(path, xml)
  return (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer
}

describe('extractAttachmentText — pptx', () => {
  it('extracts slides in numeric order (slide10 after slide2) with notes', async () => {
    const buf = await buildPptx({
      'ppt/slides/slide10.xml': slideXml(['Closing recap']),
      'ppt/slides/slide1.xml': slideXml(['Pricing &amp; packaging', 'Pro is $19.99']),
      'ppt/slides/slide2.xml': slideXml(['Objection handling']),
      'ppt/notesSlides/notesSlide1.xml': slideXml(['Lead with value, not price']),
    })
    const text = await extractAttachmentText(buf, 'pptx')
    expect(text).not.toBeNull()
    // Numeric ordering: 1, 2, 10 — a lexical sort would put 10 before 2.
    const i1 = text!.indexOf('## Slide 1\n')
    const i2 = text!.indexOf('## Slide 2\n')
    const i10 = text!.indexOf('## Slide 10\n')
    expect(i1).toBeGreaterThanOrEqual(0)
    expect(i2).toBeGreaterThan(i1)
    expect(i10).toBeGreaterThan(i2)
    // Entity unescaping + notes attribution
    expect(text).toContain('Pricing & packaging')
    expect(text).toContain('Notes: Lead with value, not price')
  })

  it('returns null for a deck with no meaningful text', async () => {
    const buf = await buildPptx({ 'ppt/slides/slide1.xml': slideXml(['Hi']) })
    expect(await extractAttachmentText(buf, 'pptx')).toBeNull()
  })
})

describe('extractAttachmentText — passthrough', () => {
  const long = 'Objection: too expensive. Response: anchor on replacement cost. '.repeat(4)

  it('passes through txt with BOM stripped', async () => {
    const buf = Buffer.from('﻿' + long, 'utf8')
    const text = await extractAttachmentText(buf, 'txt')
    expect(text).toBe(long.trim())
  })

  it('rejects content below the meaningful-chars floor', async () => {
    expect(await extractAttachmentText(Buffer.from('short'), 'md')).toBeNull()
  })

  it('returns null for unsupported extensions', async () => {
    expect(await extractAttachmentText(Buffer.from(long), 'exe')).toBeNull()
  })

  it('caps runaway documents at the max length', async () => {
    const huge = 'a'.repeat(500_000)
    const text = await extractAttachmentText(Buffer.from(huge), 'txt')
    expect(text!.length).toBe(400_000)
  })
})

describe('chunkText', () => {
  it('returns a single chunk for short text', () => {
    expect(chunkText('hello world')).toEqual(['hello world'])
  })

  it('prefers paragraph boundaries and never splits into slivers', () => {
    const para = 'x'.repeat(3000)
    const text = `${para}\n\n${para}\n\n${para}`
    const chunks = chunkText(text)
    expect(chunks.length).toBe(3)
    for (const c of chunks) expect(c).toBe(para)
  })

  it('hard-splits unbroken text at chunkSize', () => {
    const chunks = chunkText('y'.repeat(8000))
    expect(chunks.map((c) => c.length)).toEqual([3500, 3500, 1000])
  })

  it('ignores separators in the first half of the window (sliver guard)', () => {
    // One space at position 10, then unbroken text: a naive lastIndexOf cut
    // would emit a 10-char sliver + word-sized chunks. The guard must reject
    // boundaries at or below half the window and hard-split instead.
    const text = 'tiny start' + 'x'.repeat(7000)
    const chunks = chunkText(text)
    expect(chunks[0].length).toBe(3500)
    expect(chunks.length).toBe(3)
  })

  it('falls back to single newline when no paragraph break is in range', () => {
    const a = 'a'.repeat(3000)
    const b = 'b'.repeat(3000)
    const chunks = chunkText(`${a}\n${b}`)
    expect(chunks).toEqual([a, b])
  })

  it('falls back to space when no newline is in range', () => {
    const a = 'a'.repeat(3000)
    const b = 'b'.repeat(3000)
    const chunks = chunkText(`${a} ${b}`)
    expect(chunks).toEqual([a, b])
  })

  it('caps the chunk count', () => {
    const chunks = chunkText('z'.repeat(1_000_000))
    expect(chunks.length).toBe(40)
  })
})

describe('extension sets', () => {
  it('indexable = multimodal ∪ text-extractable', () => {
    for (const ext of ['png', 'jpg', 'pdf', 'docx', 'pptx', 'md', 'yaml', 'csv']) {
      expect(INDEXABLE_ATTACHMENT_EXTENSIONS.has(ext)).toBe(true)
    }
    expect(TEXT_EXTRACTABLE_EXTENSIONS.has('png')).toBe(false)
    expect(INDEXABLE_ATTACHMENT_EXTENSIONS.has('exe')).toBe(false)
  })
})
