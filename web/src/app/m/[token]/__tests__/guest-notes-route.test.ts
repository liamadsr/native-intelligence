/**
 * GET /m/<token>/notes: what a meeting guest reads of the call's notes while
 * they are in it. Off (404) unless the live notes are on. The guest's signed
 * cookie is checked first, with no read; then the limits; then 657, by the
 * guest and the link's hash. A guest let into the live call reads the lines
 * said since they came in; the same guest once removed, gone, or the call
 * over is refused (403) and reads nothing. Whatever the database answers, a
 * line carries its time, its speaker and its words only: never a field from
 * the workspace (the summary, a contact), and the summary is never asked for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { LIVEKIT_ENV } from '@/lib/team-calls/__tests__/signing'

const h = vi.hoisted(() => ({
  rpcs: [] as Array<[string, Record<string, unknown>]>,
  answer: null as unknown,
  tables: [] as string[],
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: async () => undefined } }))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => (h.rpcs.push([name, args]), { data: h.answer, error: null }),
    from: (t: string) => {
      h.tables.push(t)
      throw new Error('no table read here')
    },
  }),
}))

const { meetingToken, signGuestCookie, tokenDigest, MEETING_GUEST_COOKIE } = await import('@/lib/meeting-links/link')
const { GET } = await import('../notes/route')

const MEETING = '22222222-2222-4222-8222-222222222222'
const GUEST = '55555555-5555-4555-8555-555555555555'
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
    expect(await res.json()).toEqual({ lines: h.answer && (h.answer as { lines: unknown }).lines })
    expect(h.rpcs).toEqual([['team_call_guest_notes', { target_guest: GUEST, token_digest: tokenDigest(TOKEN), max_lines: 200 }]])
    // Read through 657 alone: never the capture, its summary or anything of the workspace.
    expect(h.tables).toEqual([])
  })

  it('the same guest once removed, gone or the call over: refused, and nothing', async () => {
    h.answer = { allowed: false, lines: [] }
    const res = await GET(req(cookie()), params())
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('NOT_IN_CALL')
    expect(body.lines).toBeUndefined()
  })

  it('a line never carries a field from the workspace, whatever the database answers', async () => {
    h.answer = {
      allowed: true,
      lines: [{ at: '2026-11-13T14:59:00Z', speaker: 'Dana Ortiz', text: 'Welcome.', summary: '## Summary from the workspace', contact_id: 'c-1', claim: 'x' }],
      summary: '## The members’ notes',
    }
    const body = await (await GET(req(cookie()), params())).json()
    expect(body).toEqual({ lines: [{ at: '2026-11-13T14:59:00Z', speaker: 'Dana Ortiz', text: 'Welcome.' }] })
  })
})
