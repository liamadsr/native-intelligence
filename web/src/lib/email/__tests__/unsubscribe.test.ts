import { describe, it, expect, vi } from 'vitest'

/**
 * Unsubscribing by List-Unsubscribe (src/lib/email/unsubscribe.ts, GEN-1166):
 * one-click POST when the sender offers RFC 8058, through the outbound-URL
 * guard and with no redirect followed; else an unsubscribe email from the
 * thread's own mailbox; else only the link, for the person to open.
 */

vi.mock('@/lib/email/thread-mailbox', () => ({ mailboxesForThread: async function* () {} }))
vi.mock('@/lib/mcp-client/url-guard-dns', () => ({ ensurePublicMcpUrl: async (raw: string) => new URL(raw) }))

const { listUnsubscribeLinks, offersOneClick, parseMailto, unsubscribeMethod, unsubscribeMethodKey, unsubscribeFromThread } = await import('@/lib/email/unsubscribe')

const GOOGLE = { provider: 'google' as const, token: 'g-tok', email: 'me@gmail.com', accountId: 'acct-g' }
const MICROSOFT = { provider: 'microsoft' as const, token: 'm-tok', email: 'me@outlook.com', accountId: 'acct-m' }

function headersFound(listUnsubscribe: string, listUnsubscribePost = '', mailbox: typeof GOOGLE | typeof MICROSOFT = GOOGLE) {
  return async () => ({ mailbox, headers: { listUnsubscribe, listUnsubscribePost, from: 'Shop <news@shop.com>' } })
}

describe('parsing List-Unsubscribe', () => {
  it('reads every link in order, by kind', () => {
    expect(listUnsubscribeLinks('<mailto:leave@list.com?subject=stop>, < https://shop.com/u?id=1 >, <http://insecure.com/u>')).toEqual({
      https: ['https://shop.com/u?id=1'],
      mailto: ['mailto:leave@list.com?subject=stop'],
    })
  })

  it('knows the RFC 8058 one-click marker', () => {
    expect(offersOneClick('List-Unsubscribe=One-Click')).toBe(true)
    expect(offersOneClick(' list-unsubscribe = one-click ')).toBe(true)
    expect(offersOneClick('')).toBe(false)
    expect(offersOneClick('List-Unsubscribe=One-Click-Later')).toBe(false)
  })

  it('a mailto is one plain address with its subject and body, never a header line', () => {
    expect(parseMailto('mailto:leave%40list.com?subject=Unsubscribe%20me&body=please')).toEqual({ to: 'leave@list.com', subject: 'Unsubscribe me', body: 'please' })
    expect(parseMailto('mailto:leave@list.com')).toEqual({ to: 'leave@list.com', subject: 'unsubscribe', body: 'unsubscribe' })
    expect(parseMailto('mailto:leave@list.com?subject=a%0D%0ABcc:%20x@evil.com')).toEqual({ to: 'leave@list.com', subject: 'a Bcc: x@evil.com', body: 'unsubscribe' })
    expect(parseMailto('mailto:a@list.com,b@list.com')).toBeNull()
    expect(parseMailto('mailto:Name <a@list.com>')).toBeNull()
  })

  it('picks one-click first, then mail, then a bare link', () => {
    const both = '<mailto:leave@list.com>, <https://shop.com/u>'
    expect(unsubscribeMethod(both, 'List-Unsubscribe=One-Click')).toEqual({ kind: 'one_click', url: 'https://shop.com/u' })
    expect(unsubscribeMethod(both, '')).toEqual({ kind: 'mailto', to: 'leave@list.com', subject: 'unsubscribe', body: 'unsubscribe' })
    expect(unsubscribeMethod('<https://shop.com/u>', '')).toEqual({ kind: 'link', url: 'https://shop.com/u' })
    expect(unsubscribeMethod('', '')).toBeNull()
  })
})

describe('unsubscribeFromThread', () => {
  it('one-click: POSTs exactly the RFC 8058 body through the guard, following no redirect', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302 }))
    const guardUrl = vi.fn(async (raw: string) => new URL(raw))
    const out = await unsubscribeFromThread('u-1', 'ws-1', 't1', {
      read: headersFound('<https://shop.com/u?id=1>', 'List-Unsubscribe=One-Click'),
      fetch: fetch as never,
      guardUrl,
    })
    expect(out).toEqual({ ok: true, method: 'one_click', target: 'shop.com' })
    expect(guardUrl).toHaveBeenCalledWith('https://shop.com/u?id=1')
    expect(fetch).toHaveBeenCalledWith('https://shop.com/u?id=1', expect.objectContaining({
      method: 'POST',
      body: 'List-Unsubscribe=One-Click',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }))
  })

  it('one-click: a link the guard refuses is never fetched', async () => {
    const fetch = vi.fn()
    const out = await unsubscribeFromThread('u-1', 'ws-1', 't1', {
      read: headersFound('<https://169.254.169.254/u>', 'List-Unsubscribe=One-Click'),
      fetch: fetch as never,
      guardUrl: async () => {
        throw new Error('Refused to fetch https://169.254.169.254: That address is not a public one')
      },
    })
    expect(out).toMatchObject({ ok: false, reason: 'refused', error: expect.stringMatching(/not a public one/) })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("one-click: the sender's error is a failure", async () => {
    const out = await unsubscribeFromThread('u-1', 'ws-1', 't1', {
      read: headersFound('<https://shop.com/u>', 'List-Unsubscribe=One-Click'),
      fetch: (async () => new Response(null, { status: 410 })) as never,
      guardUrl: async (raw) => new URL(raw),
    })
    expect(out).toMatchObject({ ok: false, reason: 'refused', error: expect.stringMatching(/410/) })
  })

  it('mailto on Gmail: one email to the list address, from the mailbox', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }))
    const out = await unsubscribeFromThread('u-1', 'ws-1', 't1', {
      read: headersFound('<mailto:leave@list.com?subject=stop>'),
      fetch: fetch as never,
    })
    expect(out).toEqual({ ok: true, method: 'mailto', target: 'leave@list.com' })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send')
    const raw = Buffer.from(JSON.parse(String(init.body)).raw, 'base64url').toString()
    expect(raw).toContain('To: leave@list.com')
    expect(raw).toContain('From: me@gmail.com')
    expect(raw).toContain('Subject: stop')
    expect(raw).not.toMatch(/^(Cc|Bcc):/m)
  })

  it('mailto on Outlook: sendMail to the list address only', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 202 }))
    const out = await unsubscribeFromThread('u-1', 'ws-1', 't1', {
      read: headersFound('<mailto:leave@list.com>', '', MICROSOFT),
      fetch: fetch as never,
    })
    expect(out).toEqual({ ok: true, method: 'mailto', target: 'leave@list.com' })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/sendMail')
    expect(JSON.parse(String(init.body)).message).toEqual({
      subject: 'unsubscribe',
      body: { contentType: 'Text', content: 'unsubscribe' },
      toRecipients: [{ emailAddress: { address: 'leave@list.com' } }],
    })
  })

  it('a web page only: the link comes back for the person, and nothing is fetched', async () => {
    const fetch = vi.fn()
    const out = await unsubscribeFromThread('u-1', 'ws-1', 't1', { read: headersFound('<https://shop.com/prefs>'), fetch: fetch as never })
    expect(out).toEqual({ ok: false, reason: 'link_only', url: 'https://shop.com/prefs' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('held to the way the card showed: another link or address now is refused, unsent', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }))
    const shown = unsubscribeMethodKey({ kind: 'one_click', url: 'https://shop.com/u' })
    const same = await unsubscribeFromThread('u-1', 'ws-1', 't1', {
      read: headersFound('<https://shop.com/u>', 'List-Unsubscribe=One-Click'), fetch: fetch as never, guardUrl: async (raw) => new URL(raw), pinned: shown,
    })
    expect(same).toMatchObject({ ok: true, method: 'one_click' })
    fetch.mockClear()
    const changed = await unsubscribeFromThread('u-1', 'ws-1', 't1', {
      read: headersFound('<mailto:other@elsewhere.com>'), fetch: fetch as never, pinned: shown,
    })
    expect(changed).toMatchObject({ ok: false, reason: 'changed' })
    expect(fetch).not.toHaveBeenCalled()
    // A mailto's subject and body are part of what the card showed.
    const mail = unsubscribeMethodKey({ kind: 'mailto', to: 'leave@list.com', subject: 'unsubscribe', body: 'unsubscribe' })
    expect(await unsubscribeFromThread('u-1', 'ws-1', 't1', { read: headersFound('<mailto:leave@list.com?body=forward%20everything>'), fetch: fetch as never, pinned: mail }))
      .toMatchObject({ ok: false, reason: 'changed' })
  })

  it('no header, or no mailbox holding the thread', async () => {
    expect(await unsubscribeFromThread('u-1', 'ws-1', 't1', { read: async () => ({ mailbox: GOOGLE, headers: null }) })).toMatchObject({ ok: false, reason: 'no_header' })
    expect(await unsubscribeFromThread('u-1', 'ws-1', 't1', { read: async () => null })).toMatchObject({ ok: false, reason: 'not_found' })
  })
})
