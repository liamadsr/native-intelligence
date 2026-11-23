import { describe, expect, it } from 'vitest'
import { extensionOf, figmaEmbedUrl, fitsViewer, isFigmaUrl, viewerKindOf } from '../viewer-kind'

describe('viewerKindOf', () => {
  it.each([
    ['Q3 plan.pdf', null, 'pdf'],
    ['scan', 'application/pdf', 'pdf'],
    ['brief.docx', null, 'docx'],
    ['deck.pptx', null, 'pptx'],
    ['numbers.xlsx', null, 'sheet'],
    ['export.csv', null, 'sheet'],
    ['export.tsv', null, 'sheet'],
    ['photo.JPG', null, 'image'],
    ['clip.mov', null, 'video'],
    ['memo.m4a', null, 'audio'],
    ['notes.md', null, 'text'],
    ['main.rs', null, 'text'],
    ['archive.zip', 'application/zip', 'none'],
    ['legacy.doc', null, 'none'],
    ['old.xls', null, 'none'],
  ] as const)('%s → %s', (name, mimeType, kind) => {
    expect(viewerKindOf({ name, mimeType })).toBe(kind)
  })

  it('shows an SVG as text, never as an image (its script must not run)', () => {
    expect(viewerKindOf({ name: 'logo.svg', mimeType: 'image/svg+xml' })).toBe('text')
    expect(viewerKindOf({ name: 'logo', mimeType: 'image/svg+xml' })).toBe('none')
  })

  it('shows an HTML file as text', () => {
    expect(viewerKindOf({ name: 'page.html', mimeType: 'text/html' })).toBe('text')
  })

  it('falls back on the MIME type when the name has no extension', () => {
    expect(viewerKindOf({ name: 'voice', mimeType: 'audio/ogg; codecs=opus' })).toBe('audio')
    expect(viewerKindOf({ name: 'shot', mimeType: 'image/png' })).toBe('image')
  })

  it('takes a Figma link as Figma', () => {
    expect(viewerKindOf({ name: 'Design', url: 'https://www.figma.com/design/AbC123/Home?node-id=1-2' })).toBe('figma')
  })
})

describe('Figma links', () => {
  it('accepts Figma file, design, proto and board links only', () => {
    expect(isFigmaUrl('https://www.figma.com/file/AbC123/Home')).toBe(true)
    expect(isFigmaUrl('https://figma.com/proto/AbC123/Home')).toBe(true)
    expect(isFigmaUrl('https://www.figma.com/board/AbC123/Plan')).toBe(true)
    expect(isFigmaUrl('http://www.figma.com/file/AbC123/Home')).toBe(false)
    expect(isFigmaUrl('https://figma.com.example.com/file/AbC123')).toBe(false)
    expect(isFigmaUrl('https://www.figma.com/settings')).toBe(false)
    expect(isFigmaUrl('not a url')).toBe(false)
  })

  it("builds Figma's own embed address, keeping the link's query", () => {
    const embed = figmaEmbedUrl('https://www.figma.com/design/AbC123/Home?node-id=1-2')
    expect(embed).not.toBeNull()
    const url = new URL(embed!)
    expect(url.origin).toBe('https://embed.figma.com')
    expect(url.pathname).toBe('/design/AbC123/Home')
    expect(url.searchParams.get('node-id')).toBe('1-2')
    expect(figmaEmbedUrl('https://evil.example.com/design/x')).toBeNull()
  })
})

describe('extensionOf and fitsViewer', () => {
  it('reads an extension', () => {
    expect(extensionOf('a/b/Report.Final.PDF')).toBe('pdf')
    expect(extensionOf('.env')).toBe('')
    expect(extensionOf('README')).toBe('')
  })

  it('opens a file within its viewer’s size, and offers a bigger one as a download', () => {
    expect(fitsViewer('text', 1024)).toBe(true)
    expect(fitsViewer('text', 3 * 1024 * 1024)).toBe(false)
    expect(fitsViewer('pdf', null)).toBe(true)
    expect(fitsViewer('none', 10)).toBe(false)
    expect(fitsViewer('figma', null)).toBe(true)
  })
})
