import { describe, expect, it } from 'vitest'
import {
  MAX_COMPOSE_FILE_BYTES,
  attachmentMimePart,
  attachmentsProblem,
  base64Bytes,
  graphFileAttachment,
  parseComposeAttachments,
  safeAttachmentName,
} from '../compose-attachments'

const b64 = (s: string) => Buffer.from(s).toString('base64')

describe('parseComposeAttachments', () => {
  it('none is none', () => {
    expect(parseComposeAttachments(undefined)).toEqual([])
    expect(parseComposeAttachments(null)).toEqual([])
  })

  it('takes well-formed files, their names made safe', () => {
    expect(parseComposeAttachments([{ name: 'C:\\x\\plan "v2".pdf', mime_type: 'application/PDF', content_base64: b64('hello') }])).toEqual([
      { name: 'plan v2 .pdf', mimeType: 'application/pdf', contentBase64: b64('hello') },
    ])
  })

  it('refuses a bad type, bad base64, a header-breaking type, or too much', () => {
    expect(parseComposeAttachments([{ name: 'a', mime_type: 'text/plain\r\nBcc: x', content_base64: b64('x') }])).toBe('invalid')
    expect(parseComposeAttachments([{ name: 'a', mime_type: 'text/plain', content_base64: 'not base64!' }])).toBe('invalid')
    expect(parseComposeAttachments([{ name: '', mime_type: 'text/plain', content_base64: b64('x') }])).toBe('invalid')
    expect(parseComposeAttachments('x')).toBe('invalid')
    const big = 'A'.repeat(Math.ceil((MAX_COMPOSE_FILE_BYTES + 3) / 3) * 4)
    expect(parseComposeAttachments([{ name: 'big.bin', mime_type: 'application/octet-stream', content_base64: big }])).toBe('invalid')
    const eleven = Array.from({ length: 11 }, () => ({ name: 'a.txt', mime_type: 'text/plain', content_base64: b64('x') }))
    expect(parseComposeAttachments(eleven)).toBe('invalid')
  })
})

describe('limits as the composer says them', () => {
  it('per file, in all, and how many', () => {
    expect(attachmentsProblem([{ name: 'a.pdf', size: 1000 }])).toBeNull()
    expect(attachmentsProblem([{ name: 'a.pdf', size: MAX_COMPOSE_FILE_BYTES + 1 }])).toBe('“a.pdf” is over 3 MB')
    expect(attachmentsProblem(Array.from({ length: 3 }, (_, i) => ({ name: `${i}`, size: 2.9 * 1024 * 1024 })))).toBe('Attachments are over 6 MB in all')
    expect(attachmentsProblem(Array.from({ length: 11 }, (_, i) => ({ name: `${i}`, size: 1 })))).toBe('Attach 10 files at most')
  })

  it('base64Bytes is the decoded size', () => {
    expect(base64Bytes(b64('hello'))).toBe(5)
    expect(base64Bytes(b64('hell'))).toBe(4)
  })
})

describe('safeAttachmentName', () => {
  it('one line, no path, a long name cut keeping its extension', () => {
    expect(safeAttachmentName('../../etc/passwd')).toBe('passwd')
    expect(safeAttachmentName('a\r\nb.txt')).toBe('a b.txt')
    expect(safeAttachmentName('')).toBe('attachment')
    const long = safeAttachmentName(`${'x'.repeat(300)}.docx`)
    expect(long).toHaveLength(200)
    expect(long.endsWith('.docx')).toBe(true)
  })
})

describe('the parts that carry them', () => {
  it('MIME: base64 lines of 76, an ASCII name quoted, any other RFC 2231-encoded', () => {
    const part = attachmentMimePart('B', { name: 'notes.txt', mimeType: 'text/plain', contentBase64: 'A'.repeat(100) })
    expect(part).toContain('Content-Type: text/plain; name="notes.txt"')
    expect(part).toContain('Content-Disposition: attachment; filename="notes.txt"')
    expect(part).toContain(`${'A'.repeat(76)}\r\n${'A'.repeat(24)}`)
    const intl = attachmentMimePart('B', { name: 'résumé.pdf', mimeType: 'application/pdf', contentBase64: 'AAAA' })
    expect(intl).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf")
  })

  it('Graph: a fileAttachment', () => {
    expect(graphFileAttachment({ name: 'a.txt', mimeType: 'text/plain', contentBase64: 'AAAA' })).toEqual({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: 'a.txt',
      contentType: 'text/plain',
      contentBytes: 'AAAA',
    })
  })
})
