import { describe, it, expect } from 'vitest'
import { buildRawEmail, makeRfcMessageId } from '@/lib/crm/email-client'

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
    // The prod bug: 'Dial8 — quick intro (pre-seed)' arrived as
    // 'Dial8 Ã¢Â€Â” quick intro (pre-seed)' because the raw UTF-8 bytes sat
    // in an undeclared header and clients decoded them as Latin-1.
    const raw = buildRawEmail({ ...base, subject: 'Dial8 — quick intro (pre-seed)' })
    const headers = headerSection(raw)
    expect(headers).toContain(
      `Subject: =?UTF-8?B?${Buffer.from('Dial8 — quick intro (pre-seed)', 'utf8').toString('base64')}?=`,
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
