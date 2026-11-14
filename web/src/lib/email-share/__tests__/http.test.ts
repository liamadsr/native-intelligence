/**
 * The share routes' edges (src/lib/email-share/http.ts): an attachment is
 * always a download, never a page on our origin, and its name can't break the
 * header. Made-up file names.
 */
import { describe, expect, it, vi } from 'vitest'
import { contentDisposition, downloadType, shareFailure } from '../http'

vi.mock('@/lib/api-auth', () => ({ requireWorkspaceMember: vi.fn() }))

describe('attachment headers', () => {
  it('hands on types a browser could run or draw as a page as plain bytes', () => {
    for (const t of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/xml', 'application/javascript', 'TEXT/HTML', 'text/html; charset=utf-8', '']) {
      expect(downloadType(t), t).toBe('application/octet-stream')
    }
    expect(downloadType('application/pdf')).toBe('application/pdf')
    expect(downloadType('image/png')).toBe('image/png')
  })

  it('names the file safely, ASCII and UTF-8', () => {
    expect(contentDisposition('terms.pdf')).toBe(`attachment; filename="terms.pdf"; filename*=UTF-8''terms.pdf`)
    const odd = contentDisposition('Q4 "final"\r\nSet-Cookie: x.pdf')
    expect(odd.startsWith('attachment; filename="Q4 _final___Set-Cookie: x.pdf"')).toBe(true)
    expect(odd).not.toMatch(/[\r\n]/)
    expect(contentDisposition('Überblick.pdf')).toContain("filename*=UTF-8''%C3%9Cberblick.pdf")
  })
})

describe('refusals', () => {
  it('carry the code and words only', async () => {
    const res = shareFailure({ ok: false, status: 410, code: 'revoked', error: 'No longer shared' })
    expect(res.status).toBe(410)
    expect(await res.json()).toEqual({ error: 'No longer shared', code: 'revoked' })
  })
})
