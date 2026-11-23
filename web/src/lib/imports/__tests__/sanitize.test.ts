import { describe, expect, it } from 'vitest'
import { allowedLinkTarget, sanitizeImportedMarkdown } from '../sanitize'

describe('sanitizeImportedMarkdown', () => {
  it('removes HTML, keeping its words, outside code only', () => {
    const md = '<aside>💡 Note <b>this</b></aside>\n\nA<br>B\n\n<script>alert(1)</script>Done\n\n`<b>kept</b>`\n\n```\n<div>kept</div>\n```'
    const out = sanitizeImportedMarkdown(md)
    expect(out).toContain('💡 Note this')
    expect(out).toContain('A  \nB')
    expect(out).not.toMatch(/alert|<aside|<b>this/)
    expect(out).toContain('`<b>kept</b>`')
    expect(out).toContain('<div>kept</div>')
  })

  it('turns a web <img> into a markdown image and drops any other', () => {
    expect(sanitizeImportedMarkdown('<img src="https://x.test/a.png" alt="a">')).toBe('![](https://x.test/a.png)')
    expect(sanitizeImportedMarkdown('<img src="javascript:alert(1)">x')).toBe('x')
  })

  it('keeps only http(s), mention and placeholder links', () => {
    const md = '[a](https://ok.test) [b](javascript:void0) [c](mailto:x@y.z) [d](file:///etc/passwd) ![e](data:image/png;base64,AAA) [@f]({{ref:page:1}}) ![g]({{asset:asset:0}}) [@h](mention://document/11111111-1111-1111-1111-111111111111) [i](relative/thing.md)'
    expect(sanitizeImportedMarkdown(md)).toBe('[a](https://ok.test) b c d  [@f]({{ref:page:1}}) ![g]({{asset:asset:0}}) [@h](mention://document/11111111-1111-1111-1111-111111111111) i')
  })

  it('knows its targets', () => {
    expect(allowedLinkTarget('http://a.test')).toBe(true)
    expect(allowedLinkTarget('mention://document/not-a-uuid')).toBe(false)
    expect(allowedLinkTarget('JAVASCRIPT:x')).toBe(false)
  })
})
