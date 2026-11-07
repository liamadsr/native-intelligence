import { describe, it, expect } from 'vitest'
import { plainTextToHtml, escapeHtml } from '../plain-text-to-html'

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
  it('wraps each line in a paragraph', () => {
    const html = plainTextToHtml('Hi Sam,\nCircling back.')
    expect(html).toContain('<p>Hi Sam,</p>')
    expect(html).toContain('<p>Circling back.</p>')
  })

  it('renders blank lines as spacer paragraphs', () => {
    expect(plainTextToHtml('a\n\nb')).toContain('<p><br/></p>')
  })

  it('escapes user-typed markup so it cannot inject HTML', () => {
    const html = plainTextToHtml('<b>hi</b> & <img src=x onerror=alert(1)>')
    expect(html).not.toContain('<b>hi</b>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;b&gt;hi&lt;/b&gt; &amp; &lt;img src=x onerror=alert(1)&gt;')
  })

  it('wraps output in the styled container', () => {
    expect(plainTextToHtml('x')).toBe(
      '<div style="font-family: sans-serif; line-height: 1.5;"><p>x</p></div>',
    )
  })
})
