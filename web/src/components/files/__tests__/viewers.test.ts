// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { sanitizeDocxHtml } from '../docx-viewer'
import { columnLetters, decodeSheetText } from '../sheet-viewer'
import { stepZoom } from '../pdf-viewer'

describe('sanitizeDocxHtml', () => {
  it('keeps the document’s words and its own pictures, drops anything that runs or calls out', () => {
    const html = sanitizeDocxHtml(
      '<h1 style="color:red" onclick="x()">Brief</h1><script>alert(1)</script><p>Hi <a href="https://example.com">site</a> <a href="javascript:alert(1)">bad</a></p>' +
        '<img src="data:image/png;base64,AAAA"><img src="https://tracker.example.com/pixel.png"><iframe src="https://example.com"></iframe>',
    )
    expect(html).toContain('<h1>Brief</h1>')
    expect(html).not.toContain('script')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('style=')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('iframe')
    expect(html).not.toContain('tracker.example.com')
    expect(html).toContain('src="data:image/png;base64,AAAA"')
    expect(html).toMatch(/<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer nofollow">site<\/a>/)
  })
})

describe('the sheet viewer', () => {
  it('names columns as a spreadsheet does', () => {
    expect([0, 25, 26, 27, 701, 702].map(columnLetters)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA'])
  })

  it('reads a CSV’s characters: UTF-8, UTF-16 by its mark, else Windows-1252', () => {
    expect(decodeSheetText(new TextEncoder().encode('José'))).toBe('José')
    expect(decodeSheetText(new Uint8Array([0xff, 0xfe, 0x41, 0x00]))).toBe('A')
    expect(decodeSheetText(new Uint8Array([0x4a, 0x6f, 0x73, 0xe9]))).toBe('José')
  })
})

describe('the PDF zoom', () => {
  it('steps in and out, within its bounds', () => {
    expect(stepZoom(1, 1)).toBe(1.2)
    expect(stepZoom(1.2, -1)).toBe(1)
    expect(stepZoom(5, 1)).toBe(5)
    expect(stepZoom(0.25, -1)).toBe(0.25)
  })
})
