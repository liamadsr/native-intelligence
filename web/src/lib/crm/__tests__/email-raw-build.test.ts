import { describe, it, expect } from 'vitest'
import { buildRawEmail, encodeQuotedPrintable, makeRfcMessageId } from '@/lib/crm/email-client'
import { plainTextToHtml } from '@/lib/email/plain-text-to-html'

function headerSection(raw: string): string {
  return raw.split('\r\n\r\n')[0]
}

describe('makeRfcMessageId', () => {
  it('uses the sender domain', () => {
    expect(makeRfcMessageId('liam@dial8.ai')).toMatch(/@dial8\.ai$/)
  })

  it('falls back when no sender email is known', () => {
    expect(makeRfcMessageId(null)).toMatch(/@mail\.dial8\.ai$/)
  })

  it('is unique per call', () => {
    expect(makeRfcMessageId('a@b.co')).not.toBe(makeRfcMessageId('a@b.co'))
  })
})

describe('buildRawEmail threading headers', () => {
  const base = {
    from: 'liam@dial8.ai',
    to: ['investor@fund.com'],
    subject: 'Quick intro',
    bodyHtml: '<p>Hello</p>',
  }

  it('stamps a caller-provided Message-ID', () => {
    const raw = buildRawEmail({ ...base, messageId: 'abc-123@dial8.ai' })
    expect(headerSection(raw)).toContain('Message-ID: <abc-123@dial8.ai>')
  })

  it('omits Message-ID / In-Reply-To / References for a bare new message', () => {
    const headers = headerSection(buildRawEmail(base))
    expect(headers).not.toContain('Message-ID:')
    expect(headers).not.toContain('In-Reply-To:')
    expect(headers).not.toContain('References:')
  })

  it('builds the full References chain, oldest first, wrapping bare ids', () => {
    const headers = headerSection(
      buildRawEmail({
        ...base,
        inReplyTo: 'parent@dial8.ai',
        references: ['root@dial8.ai', 'parent@dial8.ai'],
      }),
    )
    expect(headers).toContain('In-Reply-To: <parent@dial8.ai>')
    expect(headers).toContain('References: <root@dial8.ai> <parent@dial8.ai>')
  })

  it('falls back to a single-id References chain from inReplyTo', () => {
    const headers = headerSection(buildRawEmail({ ...base, inReplyTo: 'parent@dial8.ai' }))
    expect(headers).toContain('References: <parent@dial8.ai>')
  })

  it('emits References without In-Reply-To when only references are known', () => {
    const headers = headerSection(
      buildRawEmail({ ...base, references: ['root@dial8.ai', 'parent@dial8.ai'] }),
    )
    expect(headers).toContain('References: <root@dial8.ai> <parent@dial8.ai>')
    expect(headers).not.toContain('In-Reply-To:')
  })
})

describe('buildRawEmail subject sanitization', () => {
  const base = {
    from: 'liam@dial8.ai',
    to: ['investor@fund.com'],
    subject: 'Quick intro',
    bodyHtml: '<p>Hello</p>',
  }

  it('neutralizes CRLF in the subject so injected headers stay inside the Subject line', () => {
    const raw = buildRawEmail({
      ...base,
      subject: 'Quick question\r\nBcc: exfil@attacker.com',
    })
    const headers = headerSection(raw)
    expect(headers).toContain('Subject: Quick question Bcc: exfil@attacker.com')
    expect(headers).not.toContain('\r\nBcc:')
  })

  it('collapses lone CR/LF and other control characters to a single space', () => {
    const raw = buildRawEmail({ ...base, subject: 'a\rb\nc\u0000d\u007fe' })
    expect(headerSection(raw)).toContain('Subject: a b c d e')
  })

  it('preserves ordinary subjects through the encoded word', () => {
    // Sanitization must not MANGLE ordinary text. A non-ASCII subject can't
    // sit raw in a header (that was the mojibake bug), so the guarantee is a
    // lossless round-trip rather than byte-identical passthrough.
    const subject = 'Résumé — follow-up'
    const raw = buildRawEmail({ ...base, subject })
    const encoded = /Subject: =\?UTF-8\?B\?(.+?)\?=/.exec(headerSection(raw))
    expect(encoded).not.toBeNull()
    expect(Buffer.from(encoded![1], 'base64').toString('utf8')).toBe(subject)
  })
})

describe('buildRawEmail recipient headers', () => {
  const base = {
    from: 'liam@dial8.ai',
    to: ['investor@fund.com'],
    subject: 'Quick intro',
    bodyHtml: '<p>Hello</p>',
  }

  it('emits Bcc when bcc recipients are present', () => {
    const headers = headerSection(
      buildRawEmail({ ...base, bcc: ['crm@dial8.ai', 'archive@dial8.ai'] }),
    )
    expect(headers).toContain('Bcc: crm@dial8.ai, archive@dial8.ai')
  })

  it('omits Bcc when absent or empty', () => {
    expect(headerSection(buildRawEmail(base))).not.toContain('Bcc:')
    expect(headerSection(buildRawEmail({ ...base, bcc: [] }))).not.toContain('Bcc:')
  })

  it('keeps a CR/LF in a recipient or reference id from adding a header', () => {
    const headers = headerSection(
      buildRawEmail({
        ...base,
        to: ['a@x.com\r\nBcc: attacker@evil.com'],
        cc: ['b@x.com\nReply-To: attacker@evil.com'],
        inReplyTo: 'id@x.com>\r\nBcc: attacker@evil.com',
      }),
    )
    expect(headers).not.toMatch(/\r\n(Bcc|Reply-To):/)
    expect(headers).toContain('To: a@x.com Bcc: attacker@evil.com')
  })
})

describe('buildRawEmail non-ASCII subject encoding', () => {
  const base = {
    from: 'liam@dial8.ai',
    to: ['investor@fund.com'],
    bodyHtml: '<p>Hello</p>',
  }

  it('RFC 2047 encodes a subject containing an em dash', () => {
    // The prod bug: 'Native Intelligence — quick intro (pre-seed)' arrived as
    // 'Native Intelligence Ã¢Â€Â” quick intro (pre-seed)' because the raw UTF-8 bytes sat
    // in an undeclared header and clients decoded them as Latin-1.
    const raw = buildRawEmail({ ...base, subject: 'Native Intelligence — quick intro (pre-seed)' })
    const headers = headerSection(raw)
    expect(headers).toContain(
      `Subject: =?UTF-8?B?${Buffer.from('Native Intelligence — quick intro (pre-seed)', 'utf8').toString('base64')}?=`,
    )
    // No raw non-ASCII may survive anywhere in the header block.
      expect(/[^\x00-\x7f]/.test(headers)).toBe(false)
  })

  it('round-trips the encoded word back to the original subject', () => {
    const subject = 'Grüße — 会議 🚀'
    const raw = buildRawEmail({ ...base, subject })
    const encoded = /Subject: =\?UTF-8\?B\?(.+?)\?=/.exec(headerSection(raw))
    expect(encoded).not.toBeNull()
    expect(Buffer.from(encoded![1], 'base64').toString('utf8')).toBe(subject)
  })

  it('leaves a pure-ASCII subject unencoded', () => {
    const raw = buildRawEmail({ ...base, subject: 'Quick intro' })
    expect(headerSection(raw)).toContain('Subject: Quick intro')
  })

  it('still strips CRLF before encoding (no header injection via non-ASCII)', () => {
    const raw = buildRawEmail({
      ...base,
      subject: 'Hi —\r\nBcc: attacker@evil.com',
    })
    const headers = headerSection(raw)
    expect(headers).not.toContain('attacker@evil.com')
    const encoded = /Subject: =\?UTF-8\?B\?(.+?)\?=/.exec(headers)!
    const decoded = Buffer.from(encoded[1], 'base64').toString('utf8')
    expect(decoded).not.toMatch(/[\r\n]/)
  })
})

/** A reference decoder: soft breaks joined, `=XX` back to its byte, read as UTF-8. */
function decodeQuotedPrintable(encoded: string): string {
  const joined = encoded.replace(/=\r\n/g, '')
  const bytes: number[] = []
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === '=') {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      bytes.push(joined.charCodeAt(i))
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

/** One body part of the raw message: its headers and its encoded content. */
function bodyPart(raw: string, type: 'text/plain' | 'text/html'): { headers: string; content: string } {
  const boundary = /boundary="([^"]+)"/.exec(raw)![1]
  const part = raw
    .split(`--${boundary}`)
    .find((p) => p.includes(`Content-Type: ${type};`))!
  const [headers, ...rest] = part.replace(/^\r\n/, '').split('\r\n\r\n')
  return { headers, content: rest.join('\r\n\r\n').replace(/\r\n$/, '') }
}

describe('encodeQuotedPrintable', () => {
  it('leaves printable ASCII alone and encodes "=" and UTF-8 bytes', () => {
    expect(encodeQuotedPrintable('a=b')).toBe('a=3Db')
    expect(encodeQuotedPrintable('I\u2019ll')).toBe('I=E2=80=99ll')
  })

  it('encodes a space or tab only at the end of a line, where it would be lost', () => {
    expect(encodeQuotedPrintable('a b \nc\t')).toBe('a b=20\r\nc=09')
  })

  it('writes line breaks as CRLF', () => {
    expect(encodeQuotedPrintable('a\nb\r\nc\rd')).toBe('a\r\nb\r\nc\r\nd')
  })

  it('keeps every line within 76 characters with soft breaks, and decodes back', () => {
    const text = `${'word '.repeat(400)}end\n${'\u00e9\u2014'.repeat(200)}\n\n${'='.repeat(90)}`
    const encoded = encodeQuotedPrintable(text)
    for (const line of encoded.split('\r\n')) expect(line.length).toBeLessThanOrEqual(76)
    expect(decodeQuotedPrintable(encoded)).toBe(text.replace(/\n/g, '\r\n'))
  })
})

describe('buildRawEmail body encoding', () => {
  const base = { from: 'dana@example.com', to: ['sam@example.org'], subject: 'Tuesday' }

  it('sends both parts quoted-printable, each reading back as given', () => {
    const text = 'Hi Sam,\n\nI\u2019ll be in PST \u2014 for two weeks.\n\nBest,\nDana'
    const raw = buildRawEmail({ ...base, bodyText: text, bodyHtml: plainTextToHtml(text) })
    const plain = bodyPart(raw, 'text/plain')
    const html = bodyPart(raw, 'text/html')
    expect(plain.headers).toContain('Content-Transfer-Encoding: quoted-printable')
    expect(html.headers).toContain('Content-Transfer-Encoding: quoted-printable')
    expect(decodeQuotedPrintable(plain.content)).toBe(text.replace(/\n/g, '\r\n'))
    expect(decodeQuotedPrintable(html.content)).toBe(plainTextToHtml(text).replace(/\n/g, '\r\n'))
  })

  it('never writes a body line past 76 characters, however long the message', () => {
    // A long paragraph is one line of text; the old paragraph-per-line HTML put
    // a whole email on one line, which servers break mid-word past 998.
    const text = Array.from({ length: 6 }, (_, i) => `Paragraph ${i} ${'and more words '.repeat(80)}`).join('\n\n')
    const raw = buildRawEmail({ ...base, bodyText: text, bodyHtml: plainTextToHtml(text) })
    const body = raw.slice(raw.indexOf('\r\n\r\n') + 4)
    for (const line of body.split('\r\n')) expect(line.length).toBeLessThanOrEqual(76)
    // Pure ASCII on the wire.
    expect(body).not.toMatch(/[^\x00-\x7f]/)
  })

  it('without a text part given, writes one that matches the typed text', () => {
    const text = 'Hi Sam,\n\nCircling back.\n\nBest,\nDana'
    const raw = buildRawEmail({ ...base, bodyHtml: plainTextToHtml(text) })
    expect(decodeQuotedPrintable(bodyPart(raw, 'text/plain').content)).toBe(text.replace(/\n/g, '\r\n'))
  })
})
