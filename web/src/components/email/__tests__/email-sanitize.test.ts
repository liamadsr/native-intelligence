// @vitest-environment jsdom
/**
 * An email's own <style> (a newsletter's class-based CSS and @media rules,
 * usually in <head>) survives sanitizing and display processing. Without it
 * the body arrived unstyled: the parser put a leading <style> in the head and
 * only the body came back.
 */
import { describe, expect, it } from 'vitest'
import { processEmailForDisplay, sanitizeEmailHtml } from '../email-sanitize'

describe('email <style> blocks', () => {
  const html = '<html><head><style>.x{color:red}</style></head><body><p class="x">hi</p></body></html>'

  it('keeps a head <style> through sanitizing', () => {
    expect(sanitizeEmailHtml(html)).toContain('.x{color:red}')
  })

  it('keeps it through display processing, after the theme styles', () => {
    const out = processEmailForDisplay(sanitizeEmailHtml(html), false)
    expect(out).toContain('.x{color:red}')
    expect(out).toContain('<p class="x">hi</p>')
    expect(out.indexOf('.x{color:red}')).toBeGreaterThan(out.indexOf(':host'))
  })

  it('still strips scripts', () => {
    const out = sanitizeEmailHtml('<style>p{}</style><script>alert(1)</script><p>ok</p>')
    expect(out).not.toContain('<script')
    expect(out).toContain('<p>ok</p>')
  })
})
