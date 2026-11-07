import { describe, expect, it } from 'vitest'
import { filenameFromContentDisposition } from '../download'

describe('filenameFromContentDisposition', () => {
  it('parses a quoted filename', () => {
    expect(
      filenameFromContentDisposition('attachment; filename="koko-link-2026-06-11.md"'),
    ).toBe('koko-link-2026-06-11.md')
  })

  it('parses an unquoted filename', () => {
    expect(filenameFromContentDisposition('attachment; filename=export.jsonl')).toBe(
      'export.jsonl',
    )
  })

  it('prefers the RFC 5987 filename* form and decodes it', () => {
    expect(
      filenameFromContentDisposition(
        `attachment; filename="fallback.md"; filename*=UTF-8''sp%C3%A9c%20doc.md`,
      ),
    ).toBe('spéc doc.md')
  })

  it('returns null for a missing or unparseable header', () => {
    expect(filenameFromContentDisposition(null)).toBeNull()
    expect(filenameFromContentDisposition('inline')).toBeNull()
  })
})
