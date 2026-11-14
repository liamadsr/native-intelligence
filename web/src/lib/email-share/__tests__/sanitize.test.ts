/**
 * A shared message's HTML (sanitize.ts): nothing remote loads in a reader's
 * browser until they ask for images, scripts never survive, and `data:`
 * images inside the mail stay. Made-up senders.
 */
import { describe, expect, it } from 'vitest'
import { sanitizeSharedEmailHtml } from '../sanitize'

describe('sanitizeSharedEmailHtml', () => {
  it('drops remote image sources (keeping alt), counts them, and keeps data: images', () => {
    const { html, blocked } = sanitizeSharedEmailHtml(
      '<img src="https://track.example/open.gif" alt="Northwind"><img src="//cdn.example/x.png"><img src="data:image/gif;base64,R0lGOD=" alt="dot">',
    )
    expect(blocked).toBe(2)
    expect(html).not.toMatch(/track\.example|cdn\.example/)
    expect(html).toContain('alt="Northwind"')
    expect(html).toContain('data:image/gif')
  })

  it('turns remote CSS url(...) into none, in style attributes and <style>, and drops @import', () => {
    const { html, blocked } = sanitizeSharedEmailHtml(
      '<style>@import url("https://fonts.example/a.css"); .hero { background: url(https://track.example/bg.png) } .ok { background: url(data:image/png;base64,AAAA) }</style>' +
        '<div style="background-image: url(\'https://track.example/b.png\'); color: red">Hi</div>',
    )
    expect(blocked).toBe(2)
    expect(html).not.toMatch(/track\.example|fonts\.example|@import/)
    expect(html).toContain('background: none')
    expect(html).toMatch(/background-image: ?none/)
    expect(html).toContain('url(data:image/png;base64,AAAA)')
    expect(html).toMatch(/color: ?red/)
  })

  it('with images asked for, keeps remote images and CSS urls; everything else as strict', () => {
    const { html, blocked } = sanitizeSharedEmailHtml(
      '<img src="https://cdn.example/x.png" onerror="steal()"><div style="background:url(https://cdn.example/bg.png)">Hi</div><script>alert(1)</script><a href="javascript:alert(1)">x</a>',
      { images: true },
    )
    expect(blocked).toBe(0)
    expect(html).toContain('src="https://cdn.example/x.png"')
    expect(html).toContain('url(https://cdn.example/bg.png)')
    expect(html).not.toMatch(/onerror|<script|javascript:/)
  })

  it('nothing remote: nothing counted', () => {
    expect(sanitizeSharedEmailHtml('<p>Plain words</p>').blocked).toBe(0)
  })
})
