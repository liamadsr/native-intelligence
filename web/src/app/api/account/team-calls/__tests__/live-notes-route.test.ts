/**
 * GET /api/account/team-calls/[id]/live-notes: the call's shared live notes
 * for someone in it, read AS the person (their own client, so the capture's
 * read policy decides: 566's fence, a call's notes for its conversation
 * alone). A member of the conversation who is not the notes' owner reads the
 * summary and the agent's state; a workspace member outside the conversation
 * (who reads neither the call nor its capture) gets a 404 and nothing. The
 * policy itself is run on PGlite by scripts/check-call-live-notes-sql.mjs;
 * here the route is shown to read only through the person's client, never
 * the service role. Off (404) unless the live notes are on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIVEKIT_ENV } from '@/lib/team-calls/__tests__/signing'

const CALL = '11111111-1111-4111-8111-111111111111'
const CAPTURE = '22222222-2222-4222-8222-222222222222'
const CHANNEL = '33333333-3333-4333-8333-333333333333'
const ROSA = 'user-rosa'
const THEO = 'user-theo'

const h = vi.hoisted(() => ({ user: 'user-rosa', reads: [] as string[], service: 0 }))

/** The person's client: rows as RLS shows them to that person (Rosa is in the conversation; Theo is not). */
function personClient() {
  const visible = h.user === 'user-rosa'
  return {
    from: (table: string) => {
      h.reads.push(table)
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => {
          if (!visible) return { data: null, error: null }
          if (table === 'team_call')
            return { data: { id: CALL, channel_id: CHANNEL, status: 'live', capture_id: CAPTURE, ringing: [], declined: [], room: 'r', workspace_id: 'ws' }, error: null }
          if (table === 'team_chat_channel') return { data: { kind: 'meeting', archived_at: null }, error: null }
          if (table === 'captures')
            return {
              data: { id: CAPTURE, ai_summary: '## Summary\nThe pilot starts Monday.', metadata: { source: 'team_call', live_notes: { state: 'ready', at: '2026-11-13T14:58:00Z', turns: 3 } } },
              error: null,
            }
          return { data: null, error: null }
        },
      }
      return chain
    },
  }
}

vi.mock('server-only', () => ({}))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: async () => undefined } }))
vi.mock('@/lib/api-auth', () => ({ requireUser: async () => ({ user: { id: h.user }, supabase: personClient() }) }))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => {
    h.service++
    throw new Error('the service role is never used here')
  },
}))

const { GET } = await import('../[id]/live-notes/route')

const ON = { ...LIVEKIT_ENV, TEAM_CALL_RECORDER: 'on', CAPTURE_FEED_SECRET: 'capture-feed-secret-of-its-own-0123456789', TEAM_CALL_LIVE_AGENT: 'on' }
const params = (id = CALL) => ({ params: Promise.resolve({ id }) })

let saved: NodeJS.ProcessEnv
beforeEach(() => {
  saved = { ...process.env }
  Object.assign(process.env, ON)
  h.reads = []
  h.service = 0
})
afterEach(() => {
  process.env = saved
})

describe('the call’s live notes', () => {
  it('reach a member of the conversation who is not the owner', async () => {
    h.user = ROSA
    const res = await GET(new Request('https://app.test/x'), params())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      captureId: CAPTURE,
      summary: '## Summary\nThe pilot starts Monday.',
      state: { phase: 'ready', at: '2026-11-13T14:58:00Z', reason: null },
    })
    expect(h.reads).toContain('captures')
    expect(h.service).toBe(0)
  })

  it('do not reach a workspace member outside the conversation', async () => {
    h.user = THEO
    const res = await GET(new Request('https://app.test/x'), params())
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toContain('pilot')
    expect(h.service).toBe(0)
  })

  it('are off unless the live notes are on', async () => {
    process.env.TEAM_CALL_LIVE_AGENT = ''
    expect((await GET(new Request('https://app.test/x'), params())).status).toBe(404)
    expect(h.reads).toEqual([])
  })

  it('a call id of the wrong shape is a 404', async () => {
    expect((await GET(new Request('https://app.test/x'), params('nope'))).status).toBe(404)
  })
})
