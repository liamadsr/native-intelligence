/**
 * GET /m/<token>/notes: what a meeting guest reads of the call's notes while
 * they are in it. Off (404) unless the live notes are on. The guest's signed
 * cookie is checked first, with no read; then the limits; then 657, by the
 * guest and the link's hash. A guest let into the live call reads the lines
 * said since they came in, and the agent's notes of that call as plain
 * blocks (the owner's decision, 2026-11-18): read only after 657's yes, only
 * of the live call the guest's own row is let into, and never as raw
 * markdown, a link's address or a proposal's anchor. The same guest once
 * removed, gone, or the call over is refused (403) and reads nothing: no
 * table is touched. Whatever the database answers, a line carries its time,
 * its speaker and its words only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { LIVEKIT_ENV } from '@/lib/team-calls/__tests__/signing'

const h = vi.hoisted(() => ({
  rpcs: [] as Array<[string, Record<string, unknown>]>,
  answer: null as unknown,
  tables: [] as string[],
  /** What each table's read answers; a table not here throws (nothing else may be read). */
  rows: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  filters: [] as Array<[string, string, unknown]>,
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: async () => undefined } }))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => (h.rpcs.push([name, args]), { data: h.answer, error: null }),
    from: (t: string) => {
      h.tables.push(t)
      if (!(t in h.rows)) throw new Error('no table read here')
      const q = {
        select: () => q,
        eq: (col: string, value: unknown) => (h.filters.push([t, col, value]), q),
        maybeSingle: async () => h.rows[t],
      }
      return q
    },
  }),
}))

const { meetingToken, signGuestCookie, tokenDigest, MEETING_GUEST_COOKIE } = await import('@/lib/meeting-links/link')
const { GET } = await import('../notes/route')

const MEETING = '22222222-2222-4222-8222-222222222222'
const GUEST = '55555555-5555-4555-8555-555555555555'
const CALL = '66666666-6666-4666-8666-666666666666'
const CAPTURE = '77777777-7777-4777-8777-777777777777'
const NONCE = 'route-nonce-aaaaaaaaaaaaaaaaaaaaaaa'
const ON = { ...LIVEKIT_ENV, TEAM_CALL_RECORDER: 'on', CAPTURE_FEED_SECRET: 'capture-feed-secret-of-its-own-0123456789', TEAM_CALL_LIVE_AGENT: 'on', MEETING_LINK_SECRET: 'route-test-secret' }

let saved: NodeJS.ProcessEnv
let TOKEN: string
let addr = 0

function req(cookie: string | null) {
  const headers: Record<string, string> = { host: 'nativeintelligence.dev', 'x-forwarded-for': `198.51.100.${++addr}` }
  if (cookie) headers.cookie = `${MEETING_GUEST_COOKIE}=${encodeURIComponent(cookie)}`
  return new NextRequest(`https://nativeintelligence.dev/m/${TOKEN}/notes`, { headers })
}
const params = () => ({ params: Promise.resolve({ token: TOKEN }) })
const cookie = () => signGuestCookie(TOKEN, GUEST, new Date(Date.now() + 3_600_000)).value

beforeEach(() => {
  saved = { ...process.env }
  Object.assign(process.env, ON)
  TOKEN = meetingToken(MEETING, NONCE)
  h.rpcs = []
  h.tables = []
  h.rows = {}
  h.filters = []
  h.answer = null
})
afterEach(() => {
  process.env = saved
})

describe('a guest’s notes of the call', () => {
  it('is off while the live notes are off', async () => {
    process.env.TEAM_CALL_LIVE_AGENT = ''
    const res = await GET(req(cookie()), params())
    expect(res.status).toBe(404)
    expect(h.rpcs).toEqual([])
  })

  it('no cookie, or another guest’s forged one: refused before any read', async () => {
    expect((await GET(req(null), params())).status).toBe(401)
    expect((await GET(req(`${GUEST}.${Date.now() + 60_000}.forged`), params())).status).toBe(401)
    expect(h.rpcs).toEqual([])
  })

  it('a guest in the call reads what was said since they came in', async () => {
    h.answer = {
      allowed: true,
      lines: [
        { at: '2026-11-13T14:59:00Z', speaker: 'Dana Ortiz', text: 'Welcome, Sam.' },
        { at: '2026-11-13T14:59:10Z', speaker: 'Sam Ruiz', text: 'Thanks for having me.' },
      ],
    }
    const res = await GET(req(cookie()), params())
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    // The agent has not written yet (its row cannot even be read here): the lines still come.
    expect(await res.json()).toEqual({ lines: h.answer && (h.answer as { lines: unknown }).lines, summary: [] })
    expect(h.rpcs).toEqual([['team_call_guest_notes', { target_guest: GUEST, token_digest: tokenDigest(TOKEN), max_lines: 200 }]])
  })

  it('and the agent’s notes of that call, as plain words', async () => {
    h.answer = { allowed: true, lines: [] }
    h.rows = {
      meeting_guest: { data: { call_id: CALL }, error: null },
      team_call: { data: { capture_id: CAPTURE }, error: null },
      team_call_live_notes: {
        data: { summary: '## Decisions\n- Keep the **pilot** at three <!-- proposal:abc123 -->\n- See [the plan](https://example.com/private?id=9)\n\n' + 'x'.repeat(900), state: 'working', reason: 'usage' },
        error: null,
      },
    }
    const body = await (await GET(req(cookie()), params())).json()
    expect(body.summary.slice(0, 3)).toEqual([
      { kind: 'heading', text: 'Decisions' },
      { kind: 'bullet', text: 'Keep the pilot at three' },
      { kind: 'bullet', text: 'See the plan' },
    ])
    expect(body.summary[3].text).toHaveLength(600)
    expect(JSON.stringify(body)).not.toMatch(/proposal|example\.com|working|usage|\*\*/)
    // Only the guest's own row, the live call it names (notes on) and that call's notes row.
    expect(h.tables).toEqual(['meeting_guest', 'team_call', 'team_call_live_notes'])
    expect(h.filters).toEqual([
      ['meeting_guest', 'id', GUEST],
      ['meeting_guest', 'state', 'admitted'],
      ['meeting_guest', 'in_call', true],
      ['team_call', 'id', CALL],
      ['team_call', 'status', 'live'],
      ['team_call', 'notes', true],
      ['team_call_live_notes', 'capture_id', CAPTURE],
    ])
  })

  it('no notes for a call that is over or has its notes off, and a failed read costs only the summary', async () => {
    h.answer = { allowed: true, lines: [{ at: '2026-11-13T14:59:00Z', speaker: 'Dana Ortiz', text: 'Welcome.' }] }
    h.rows = { meeting_guest: { data: { call_id: CALL }, error: null }, team_call: { data: null, error: null } }
    expect((await (await GET(req(cookie()), params())).json()).summary).toEqual([])
    expect(h.tables).toEqual(['meeting_guest', 'team_call'])
    h.rows = { meeting_guest: { data: null, error: { message: 'down' } } }
    const res = await GET(req(cookie()), params())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ lines: [{ at: '2026-11-13T14:59:00Z', speaker: 'Dana Ortiz', text: 'Welcome.' }], summary: [] })
  })

  it('the same guest once removed, gone or the call over: refused, and nothing', async () => {
    h.answer = { allowed: false, lines: [] }
    const res = await GET(req(cookie()), params())
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('NOT_IN_CALL')
    expect(body.lines).toBeUndefined()
    expect(body.summary).toBeUndefined()
    // Refused before anything of the call is read.
    expect(h.tables).toEqual([])
  })

  it('a line never carries a field from the workspace, whatever the database answers', async () => {
    h.answer = {
      allowed: true,
      lines: [{ at: '2026-11-13T14:59:00Z', speaker: 'Dana Ortiz', text: 'Welcome.', summary: '## Summary from the workspace', contact_id: 'c-1', claim: 'x' }],
      summary: '## The members’ notes',
    }
    const body = await (await GET(req(cookie()), params())).json()
    expect(body).toEqual({ lines: [{ at: '2026-11-13T14:59:00Z', speaker: 'Dana Ortiz', text: 'Welcome.' }], summary: [] })
  })
})
