/**
 * The inbox's live headers (src/lib/email/thread-headers.ts): ONE batched
 * provider call per mailbox for the rows on screen (Gmail: one multipart
 * batch; Graph: $batch, 20 a request), mailboxes in parallel; a held row
 * answers from its hold with no call; nothing is written.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

vi.mock('../thread-mailbox', () => ({ ownedMailbox: vi.fn() }))

const { fetchThreadHeaders, gmailHeaders, graphHeaders } = await import('../thread-headers')

let db: FakeSupabase
let calls: Array<{ url: string; body: string }>

const row = (id: string, account: string, provider: string, msg: string) => ({ id, account_id: account, provider, provider_thread_id: `t-${id}`, provider_message_id: msg, folder: 'inbox' })

beforeEach(() => {
  db = makeFakeSupabase()
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: String(init?.body ?? '') })
    if (url.includes('gmail')) {
      const parts = [...String(init?.body).matchAll(/messages\/([^?]+)\?/g)].map((m) => m[1])
      const text = parts
        .map((id) => `--batch_abc\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ id, snippet: `preview ${id}`, payload: { headers: [{ name: 'Subject', value: `Subject ${id}` }, { name: 'From', value: `"Sam Lee" <sam@x.com>` }] } })}\r\n`)
        .join('') + '--batch_abc--'
      return { ok: true, status: 200, text: async () => text } as unknown as Response
    }
    // Graph: a folder's page lists one message (om-listed); a single GET answers any other id, 'gone' is 404.
    if (url.includes('/mailFolders/')) {
      return { ok: true, status: 200, json: async () => ({ value: [{ id: 'om-listed', conversationId: 'conv-x', subject: 'Listed', bodyPreview: 'p', from: { emailAddress: { name: 'Ana' } } }] }) } as unknown as Response
    }
    const id = decodeURIComponent(url.split('/me/messages/')[1].split('?')[0])
    if (id === 'gone') return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
    return { ok: true, status: 200, json: async () => ({ id, subject: `S ${id}`, bodyPreview: 'p', from: { emailAddress: { name: 'Ana' } } }) } as unknown as Response
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('fetchThreadHeaders', () => {
  it('one batched call per mailbox, mailboxes in parallel; held rows from the hold, no call', async () => {
    db.seed('email_hold', [{ id: 'h1', user_id: 'u1', provider_thread_id: 't-3', account_id: 'g', subject: 'Held subject', trust: null, drafts: [] }])
    const mailbox = vi.fn(async (_u: string, accountId: string) => ({ provider: accountId === 'g' ? 'google' as const : 'microsoft' as const, token: accountId, email: null, accountId }))
    const out = await fetchThreadHeaders(db as never, {
      userId: 'u1',
      workspaceId: 'w1',
      rows: [row('1', 'g', 'google', 'gm1'), row('2', 'g', 'google', 'gm2'), row('3', 'g', 'google', 'gm3'), row('4', 'o', 'microsoft', 'om1')],
    }, { mailbox })
    expect(calls.filter((c) => c.url.includes('gmail'))).toHaveLength(1)
    // Graph: the folder's page in one list call, then the one miss as a single GET.
    expect(calls.filter((c) => c.url.includes('graph')).map((c) => (c.url.includes('/mailFolders/inbox/') ? 'list' : 'get'))).toEqual(['list', 'get'])
    // The held row was never asked of Gmail.
    expect(calls.find((c) => c.url.includes('gmail'))!.body).not.toContain('gm3')
    expect(out['1']).toEqual({ subject: 'Subject gm1', snippet: 'preview gm1', from_name: 'Sam Lee' })
    expect(out['3']).toEqual({ subject: 'Held subject', snippet: null, from_name: null })
    expect(out['4']).toEqual({ subject: 'S om1', snippet: 'p', from_name: 'Ana' })
    expect(db.calls.filter((c) => c.op !== 'select')).toEqual([])
  })

  it('a mailbox that cannot be read leaves its rows without headers', async () => {
    const out = await fetchThreadHeaders(db as never, { userId: 'u1', workspaceId: 'w1', rows: [row('1', 'g', 'google', 'gm1')] }, { mailbox: async () => null })
    expect(out).toEqual({})
    expect(calls).toHaveLength(0)
  })
})

describe('the provider batches', () => {
  it('Graph: one list call for the page, then only the misses, at most 4 at once, in row order', async () => {
    let inFlight = 0
    let peak = 0
    const order: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push({ url, body: '' })
      if (url.includes('/mailFolders/')) {
        return { ok: true, status: 200, json: async () => ({ value: [{ id: 'm0', conversationId: 'c0', subject: 'Listed' }, { id: 'newer', conversationId: 'c1', subject: 'By conversation' }] }) } as unknown as Response
      }
      const id = decodeURIComponent(url.split('/me/messages/')[1].split('?')[0])
      order.push(id)
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 2))
      inFlight -= 1
      return id === 'gone'
        ? ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response)
        : ({ ok: true, status: 200, json: async () => ({ id, subject: `S ${id}` }) } as unknown as Response)
    }))
    const rows = [
      { messageId: 'm0', conversationId: 'c0', folder: 'inbox' },
      { messageId: 'm1', conversationId: 'c1', folder: 'inbox' },
      ...Array.from({ length: 9 }, (_, i) => ({ messageId: i === 3 ? 'gone' : `x${i}`, conversationId: `cx${i}`, folder: 'inbox' })),
    ]
    const out = await graphHeaders('tok', rows, { sleep: async () => {} })
    expect(calls[0].url).toContain('/me/mailFolders/inbox/messages?')
    expect(out.get('m0')?.subject).toBe('Listed')
    // Matched by conversation: the listed newest message of c1.
    expect(out.get('m1')?.subject).toBe('By conversation')
    expect(order).toEqual(['x0', 'x1', 'x2', 'gone', 'x4', 'x5', 'x6', 'x7', 'x8'])
    expect(peak).toBeLessThanOrEqual(4)
    expect(out.has('gone')).toBe(false)
  })

  it('Graph: a throttled GET (429) waits its Retry-After and is retried once', async () => {
    let first = true
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push({ url, body: '' })
      if (first) {
        first = false
        return { ok: false, status: 429, headers: { get: () => '2' }, json: async () => ({}) } as unknown as Response
      }
      return { ok: true, status: 200, json: async () => ({ id: 'a', subject: 'S' }) } as unknown as Response
    }))
    const waits: number[] = []
    const out = await graphHeaders('tok', [{ messageId: 'a', conversationId: 'c', folder: null }], { sleep: async (ms) => { waits.push(ms) } })
    expect(waits).toEqual([2000])
    expect(calls).toHaveLength(2)
    expect(out.get('a')?.subject).toBe('S')
  })

  it('Gmail: a throttled batch (429) is retried once for what is missing, never twice', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: String(init?.body ?? '') })
      return { ok: false, status: 429, headers: { get: () => '1' }, text: async () => '' } as unknown as Response
    }))
    const waits: number[] = []
    const out = await gmailHeaders('tok', ['a'], { sleep: async (ms) => { waits.push(ms) } })
    expect(out.size).toBe(0)
    expect(calls).toHaveLength(2)
    expect(waits).toEqual([1000])
  })

  it('Gmail: one multipart batch of metadata reads', async () => {
    const out = await gmailHeaders('tok', ['a', 'b'])
    expect(calls).toHaveLength(1)
    expect(calls[0].body).toContain('GET /gmail/v1/users/me/messages/a?format=metadata&metadataHeaders=Subject&metadataHeaders=From')
    expect(out.get('b')).toEqual({ subject: 'Subject b', snippet: 'preview b', from_name: 'Sam Lee' })
  })

  it("Gmail: the snippet is HTML-escaped at Gmail and reaches the list decoded", async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: String(init?.body ?? '') })
      const msg = { id: 'a', snippet: 'Can&#39;t make it &amp; won&#x27;t &quot;move&quot; &lt;3', payload: { headers: [{ name: 'Subject', value: 'Q&amp;A &#8212; Friday' }, { name: 'From', value: 'Sam <s@x.com>' }] } }
      return { ok: true, status: 200, text: async () => `--batch_x\r\nHTTP/1.1 200 OK\r\n\r\n${JSON.stringify(msg)}\r\n--batch_x--` } as unknown as Response
    }))
    const out = await gmailHeaders('tok', ['a'])
    expect(out.get('a')).toEqual({ subject: 'Q&A \u2014 Friday', snippet: 'Can\'t make it & won\'t "move" <3', from_name: 'Sam' })
  })
})
