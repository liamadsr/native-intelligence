/**
 * GET and POST /m/<token>/chat: a meeting guest reads the meeting's chat and
 * writes in it while they are in its call (migration 670). The guest's signed
 * cookie is checked first, with no read; then the limits; then 670's
 * functions, by the guest and the link's hash. A guest let into the live call
 * reads the messages since they first came in, made plain (never a link's
 * address behind a label, a link into the app, a record's id, a file's path,
 * a preview or a share); their send is a message of theirs and nothing else
 * (no agent, no notification, no mention). Refused (403) once they are not in
 * the call. Chat does not need the live notes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { LIVEKIT_ENV } from '@/lib/team-calls/__tests__/signing'

const h = vi.hoisted(() => ({
  rpcs: [] as Array<[string, Record<string, unknown>]>,
  answer: null as unknown,
  error: null as { message: string; code?: string } | null,
  tables: [] as string[],
  sends: [] as unknown[],
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: async (e: unknown) => void h.sends.push(e) } }))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => (h.rpcs.push([name, args]), { data: h.error ? null : h.answer, error: h.error }),
    from: (t: string) => {
      h.tables.push(t)
      throw new Error('no table read here')
    },
  }),
}))

const { meetingToken, signGuestCookie, tokenDigest, MEETING_GUEST_COOKIE } = await import('@/lib/meeting-links/link')
const { GET, POST } = await import('../chat/route')

const MEETING = '22222222-2222-4222-8222-222222222222'
const GUEST = '55555555-5555-4555-8555-555555555555'
const NONCE = 'route-nonce-aaaaaaaaaaaaaaaaaaaaaaa'
const ON = { ...LIVEKIT_ENV, MEETING_LINK_SECRET: 'route-test-secret', TEAM_CALL_LIVE_AGENT: '' }

let saved: NodeJS.ProcessEnv
let TOKEN: string
let addr = 0
let guest = GUEST

function req(cookie: string | null, init: { method?: string; body?: string; sameOrigin?: boolean; address?: string } = {}) {
  const headers: Record<string, string> = { host: 'nativeintelligence.dev', 'x-forwarded-for': init.address ?? `198.51.100.${++addr % 250}` }
  if (cookie) headers.cookie = `${MEETING_GUEST_COOKIE}=${encodeURIComponent(cookie)}`
  if (init.method === 'POST') {
    headers['content-type'] = 'application/json'
    if (init.sameOrigin !== false) headers['sec-fetch-site'] = 'same-origin'
    else headers['sec-fetch-site'] = 'cross-site'
  }
  return new NextRequest(`https://nativeintelligence.dev/m/${TOKEN}/chat`, { method: init.method ?? 'GET', headers, body: init.body })
}
const params = () => ({ params: Promise.resolve({ token: TOKEN }) })
const cookie = () => signGuestCookie(TOKEN, guest, new Date(Date.now() + 3_600_000)).value
const send = (text: unknown, init: { sameOrigin?: boolean; address?: string } = {}) => POST(req(cookie(), { method: 'POST', body: JSON.stringify({ text }), ...init }), params())

beforeEach(() => {
  saved = { ...process.env }
  Object.assign(process.env, ON)
  TOKEN = meetingToken(MEETING, NONCE)
  h.rpcs = []
  h.tables = []
  h.sends = []
  h.answer = null
  h.error = null
  // A fresh guest each test: the limits are per guest, counted in this process.
  guest = `55555555-5555-4555-8555-${String(++addr).padStart(12, '0')}`
})
afterEach(() => {
  process.env = saved
})

describe('a guest reads the meeting’s chat', () => {
  it('no cookie, or a forged one: refused before any read', async () => {
    expect((await GET(req(null), params())).status).toBe(401)
    expect((await GET(req(`${GUEST}.${Date.now() + 60_000}.forged`), params())).status).toBe(401)
    expect(h.rpcs).toEqual([])
  })

  it('in the call: the messages since they came in, as plain words, with the live notes off', async () => {
    h.answer = {
      allowed: true,
      messages: [
        { id: 'm1', at: '2026-11-19T10:00:00Z', author: 'member', label: 'Rosa Lind', mine: false, body: 'Welcome! The plan is **here**: [the plan](https://nativeintelligence.dev/account/documents/0b4c1f8e-1111-4222-8333-444455556666)', files: 0, email: false },
        { id: 'm2', at: '2026-11-19T10:00:05Z', author: 'member', label: 'Ben Ortiz', mine: false, body: '## Next\n- Ship on `Friday` <!-- proposal:abc -->', files: 0, email: false },
        // An agent's reply: 670 never hands one over, and if it did it would be dropped here too.
        { id: 'm2b', at: '2026-11-19T10:00:06Z', author: 'agent', label: 'Joseph', mine: false, body: 'From the workspace', files: 0, email: false },
        { id: 'm3', at: '2026-11-19T10:00:10Z', author: 'member', label: 'Rosa Lind', mine: false, body: '', files: 2, email: false },
        { id: 'm4', at: '2026-11-19T10:00:20Z', author: 'member', label: 'Rosa Lind', mine: false, body: 'Read this one', files: 0, email: true },
        { id: 'm5', at: '2026-11-19T10:00:30Z', author: 'guest', label: 'Sam Ruiz', mine: true, body: 'Thanks, see https://example.test/brief', files: 0, email: false },
      ],
    }
    const res = await GET(req(cookie()), params())
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(h.rpcs).toEqual([['meeting_guest_chat_read', { target_guest: guest, token_digest: tokenDigest(TOKEN), max_messages: 100 }]])
    const body = await res.json()
    expect(body.messages).toEqual([
      { id: 'm1', at: '2026-11-19T10:00:00Z', author: 'member', name: 'Rosa Lind', mine: false, text: 'Welcome! The plan is here: the plan', note: null },
      { id: 'm2', at: '2026-11-19T10:00:05Z', author: 'member', name: 'Ben Ortiz', mine: false, text: 'Next\n- Ship on Friday', note: null },
      { id: 'm3', at: '2026-11-19T10:00:10Z', author: 'member', name: 'Rosa Lind', mine: false, text: '', note: 'Sent 2 files' },
      { id: 'm4', at: '2026-11-19T10:00:20Z', author: 'member', name: 'Rosa Lind', mine: false, text: '', note: 'Shared an email' },
      { id: 'm5', at: '2026-11-19T10:00:30Z', author: 'guest', name: 'Sam Ruiz', mine: true, text: 'Thanks, see https://example.test/brief', note: null },
    ])
    expect(JSON.stringify(body)).not.toMatch(/0b4c1f8e|\/account|proposal|\*\*|Read this one|Joseph|From the workspace/)
    expect(h.tables).toEqual([])
  })

  it('a row never carries a field from the workspace, whatever the database answers', async () => {
    h.answer = {
      allowed: true,
      messages: [{ id: 'm1', at: '2026-11-19T10:00:00Z', author: 'member', label: 'Rosa Lind', mine: false, body: 'Hi', files: 0, email: false, author_member_id: 'member-1', attachments: [{ path: 'c/u/x.pdf' }], link_preview: { url: 'https://x.test' } }],
    }
    const body = await (await GET(req(cookie()), params())).json()
    expect(body.messages).toEqual([{ id: 'm1', at: '2026-11-19T10:00:00Z', author: 'member', name: 'Rosa Lind', mine: false, text: 'Hi', note: null }])
  })

  it('no longer in the call (left, removed, the call over): refused, and nothing', async () => {
    h.answer = { allowed: false, messages: [] }
    const res = await GET(req(cookie()), params())
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('NOT_IN_CALL')
    expect(body.messages).toBeUndefined()
  })

  it('a failed read is a 500 that says nothing of it', async () => {
    h.error = { message: 'connection reset by the database at 10.0.0.1' }
    const res = await GET(req(cookie()), params())
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('10.0.0.1')
  })

  it('reads from one address have their own limit, sized for about 20 guests behind it', async () => {
    h.answer = { allowed: true, messages: [] }
    const address = '203.0.113.90'
    let ok = 0
    for (let g = 0; g < 21; g++) {
      guest = `77777777-7777-4777-8777-${String(g + 1).padStart(12, '0')}`
      for (let i = 0; i < 40; i++) if ((await GET(req(cookie(), { address }), params())).status === 200) ok++
    }
    expect(ok).toBe(800)
  })

  it('asked too often: 429, the function not called', async () => {
    h.answer = { allowed: true, messages: [] }
    for (let i = 0; i < 40; i++) expect((await GET(req(cookie()), params())).status).toBe(200)
    const calls = h.rpcs.length
    expect((await GET(req(cookie()), params())).status).toBe(429)
    expect(h.rpcs.length).toBe(calls)
  })
})

describe('a guest writes in the meeting’s chat', () => {
  it('from another site, without a cookie or with a forged one: refused before anything', async () => {
    expect((await send('hello', { sameOrigin: false })).status).toBe(403)
    expect((await POST(req(null, { method: 'POST', body: JSON.stringify({ text: 'hello' }) }), params())).status).toBe(401)
    expect((await POST(req(`${GUEST}.${Date.now() + 60_000}.forged`, { method: 'POST', body: JSON.stringify({ text: 'hello' }) }), params())).status).toBe(401)
    expect(h.rpcs).toEqual([])
  })

  it('their words, trimmed, as their message: 201 with it, and nothing else is started', async () => {
    h.answer = { allowed: true, id: 'msg-1', created_at: '2026-11-19T10:01:00Z', name: 'Sam Ruiz' }
    const res = await send('  Can everyone hear me?\r\nI am on a train.  ')
    expect(res.status).toBe(201)
    expect(h.rpcs).toEqual([['meeting_guest_chat_post', { target_guest: guest, token_digest: tokenDigest(TOKEN), words: 'Can everyone hear me?\nI am on a train.' }]])
    expect((await res.json()).message).toEqual({ id: 'msg-1', at: '2026-11-19T10:01:00Z', author: 'guest', name: 'Sam Ruiz', mine: true, text: 'Can everyone hear me?\nI am on a train.', note: null })
    // No agent's turn, no notification, no loop, no link preview: nothing is sent to Inngest, no table is touched.
    expect(h.sends).toEqual([])
    expect(h.tables).toEqual([])
  })

  it('empty, too long, not text, or not JSON: 400, the function not called', async () => {
    for (const text of ['', '   ', 'x'.repeat(2001), 42, null, ['hi']]) {
      const res = await send(text)
      expect(res.status, JSON.stringify(text)).toBe(400)
      expect((await res.json()).code).toBe('BAD_TEXT')
    }
    expect((await POST(req(cookie(), { method: 'POST', body: '{not json' }), params())).status).toBe(400)
    expect(h.rpcs).toEqual([])
    // 2000 characters, of any script, fit (the body cap leaves room for them).
    h.answer = { allowed: true, id: 'msg-2', created_at: '2026-11-19T10:02:00Z', name: 'Sam Ruiz' }
    expect((await send('語'.repeat(2000))).status).toBe(201)
  })

  it('a body far over the cap: 413 before it is read', async () => {
    const res = await POST(req(cookie(), { method: 'POST', body: JSON.stringify({ text: 'x'.repeat(20_000) }) }), params())
    expect(res.status).toBe(413)
    expect(h.rpcs).toEqual([])
  })

  it('no longer in the call: 403; the database refusing the words: 400', async () => {
    h.answer = { allowed: false }
    const res = await send('hello?')
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('NOT_IN_CALL')
    h.error = { message: 'meeting chat: a message is 1 to 2000 characters', code: '22023' }
    expect((await send('hello?')).status).toBe(400)
  })

  it('20 a minute at most per guest; then 429, the function not called', async () => {
    h.answer = { allowed: true, id: 'msg-3', created_at: '2026-11-19T10:03:00Z', name: 'Sam Ruiz' }
    for (let i = 0; i < 20; i++) expect((await send(`message ${i}`)).status).toBe(201)
    const calls = h.rpcs.length
    expect((await send('one more')).status).toBe(429)
    expect(h.rpcs.length).toBe(calls)
  })

  it('60 a minute at most from one address, across guests', async () => {
    h.answer = { allowed: true, id: 'msg-4', created_at: '2026-11-19T10:04:00Z', name: 'Sam Ruiz' }
    const address = '203.0.113.77'
    let ok = 0
    for (let g = 0; g < 4; g++) {
      guest = `66666666-6666-4666-8666-${String(g + 1).padStart(12, '0')}`
      for (let i = 0; i < 16; i++) if ((await send(`hi ${g}.${i}`, { address })).status === 201) ok++
    }
    expect(ok).toBe(60)
  })
})
