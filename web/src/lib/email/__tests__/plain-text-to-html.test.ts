import { describe, it, expect } from 'vitest'
import { plainTextToHtml, escapeHtml, htmlToPlainText } from '../plain-text-to-html'

const WRAP_OPEN = '<div style="font-family: sans-serif; line-height: 1.5;">'

describe('escapeHtml', () => {
  it('escapes the HTML-significant characters', () => {
    expect(escapeHtml('a & b < c > d "e" \'f\'')).toBe(
      'a &amp; b &lt; c &gt; d &quot;e&quot; &#39;f&#39;',
    )
  })

  it('escapes ampersand before angle brackets so entities are not double-mangled', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;')
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })
})

describe('plainTextToHtml', () => {
  it('writes a line per typed line and a <br> line per blank one, never a paragraph per line', () => {
    const html = plainTextToHtml('Hi Sam,\n\nCircling back on Tuesday.\n\nBest,\nDana')
    expect(html).toBe(
      WRAP_OPEN +
        '<div>Hi Sam,</div>\n' +
        '<div><br></div>\n' +
        '<div>Circling back on Tuesday.</div>\n' +
        '<div><br></div>\n' +
        '<div>Best,</div>\n' +
        '<div>Dana</div>' +
        '</div>',
    )
    // A <p> gets a margin in every mail client: each line break showed as a gap.
    expect(html).not.toContain('<p')
  })

  it('wraps output in the styled container', () => {
    expect(plainTextToHtml('x')).toBe(`${WRAP_OPEN}<div>x</div></div>`)
  })

  it('takes Windows and old Mac line breaks as line breaks', () => {
    expect(plainTextToHtml('a\r\nb\rc')).toBe(`${WRAP_OPEN}<div>a</div>\n<div>b</div>\n<div>c</div></div>`)
  })

  it('keeps a leading space and runs of spaces, which HTML would collapse', () => {
    expect(plainTextToHtml('a  b')).toContain('<div>a&nbsp; b</div>')
    expect(plainTextToHtml('  - item')).toContain('<div>&nbsp; - item</div>')
    expect(plainTextToHtml('one space')).toContain('<div>one space</div>')
  })

  it('escapes user-typed markup so it cannot inject HTML', () => {
    const html = plainTextToHtml('<b>hi</b> & <img src=x onerror=alert(1)>')
    expect(html).not.toContain('<b>hi</b>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;b&gt;hi&lt;/b&gt; &amp; &lt;img src=x onerror=alert(1)&gt;')
  })
})

describe('htmlToPlainText', () => {
  it.each([
    'Hi Sam,\n\nCircling back on Tuesday.\n\nBest,\nDana',
    "I'll be in PST for two weeks — R&D <team> \"notes\".",
    'Steps:\n  1. Open it\n  2. Close it',
    'One line',
  ])('reads plainTextToHtml back to the text that was typed: %j', (text) => {
    expect(htmlToPlainText(plainTextToHtml(text))).toBe(text)
  })

  it('reads other HTML as lines: a paragraph, then a blank line', () => {
    expect(htmlToPlainText('<p>One</p><p>Two<br>three</p>')).toBe('One\n\nTwo\nthree')
    expect(htmlToPlainText('<ul><li>a</li><li>b</li></ul>')).toBe('a\nb')
  })

  it('reads the old paragraph-per-line HTML without doubling its blank lines', () => {
    expect(htmlToPlainText('<div><p>Hi</p><p><br/></p><p>There</p></div>')).toBe('Hi\n\nThere')
  })

  it('takes a line break in the HTML source as a space, never as text', () => {
    expect(htmlToPlainText('<p>Hello\nworld</p>\n<p>Next</p>')).toBe('Hello world\n\nNext')
  })

  it('decodes entities once', () => {
    expect(htmlToPlainText('<div>&amp;lt; &#39;a&#39; &#x2014; b &unknown;</div>')).toBe("&lt; 'a' — b &unknown;")
  })
})
