/**
 * LIVE-AGENT-DESIGN §11 item 6 — the two-claims FRESHNESS check, end to end
 * through the REAL spec route, the REAL spec rebuild and the REAL eve-side
 * resolvers + spec client (only the database and eve's `fetch` hop are faked):
 *
 * A paired meeting fires a copilot turn and a notes turn for the SAME window,
 * back to back and concurrently. Each is its own task session with its own run
 * token (turnType is a signed claim), and each session's resolvers must see
 * THAT turn's claims — never the other's, never a stale one — including through
 * the spec client's per-token cache. If this ever fails, the turnType-as-claim
 * design needs a fallback (per-turnType mounts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createFakeSupabase, meetingFixture, FIX } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'
import { mintLiveAgentRunToken, type LiveAgentTokenClaims } from '@/lib/live-agent/live-agent-run-token'
import { BATCH_SUMMARY_REQUIRED, LIVE_NOTES_PAIRING_PROMPT } from '@/lib/live-agent/prompts'

const h = vi.hoisted(() => ({ client: null as unknown as SupabaseClient, specHits: 0 }))

vi.mock('@/lib/admin', async (orig) => ({
  ...(await orig<typeof import('@/lib/admin')>()),
  getServiceClient: () => h.client,
}))

const { GET } = await import('../route')
const sayToUser = (await import('../../../../../../../agents/live-agent/tools/say_to_user')).default
const askUser = (await import('../../../../../../../agents/live-agent/tools/ask_user')).default
const instructions = (await import('../../../../../../../agents/live-agent/instructions/live-turn')).default
const { resetLiveAgentSpecCache } = await import('../../../../../../../agents/live-agent/lib/spec-client')

type Resolver = { events: Record<string, (e: unknown, ctx: { session: { auth: unknown } }) => Promise<unknown>> }

const BASE: Omit<LiveAgentTokenClaims, 'exp' | 'turnType'> = {
  captureId: FIX.captureId,
  workspaceId: FIX.workspaceId,
  userId: FIX.userId,
  currentMemberId: FIX.memberId,
  model: 'deepseek-v4-flash',
  isEvalCapture: false,
  allowAutoArchive: false,
}

/** The session principal eve's channel stamps from the create request's headers. */
const sessionFor = (runToken: string) => ({ session: { auth: { current: { attributes: { runToken } } } } })

beforeEach(() => {
  process.env.LIVE_AGENT_INTERNAL_SECRET = 'fresh-secret'
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.test'
  h.client = createFakeSupabase(meetingFixture({})).client
  h.specHits = 0
  resetLiveAgentSpecCache()
  // eve → Next hop: the spec client's fetch lands on the REAL spec route handler.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      h.specHits++
      return GET(new Request(url, { method: 'GET', headers: init.headers as Record<string, string> }))
    }),
  )
})

describe('a copilot turn and its paired notes turn never see each other’s claims', () => {
  it('back to back, interleaved, and concurrently — each session resolves its OWN ceiling and prompt', async () => {
    const copilot = mintLiveAgentRunToken({ ...BASE, turnType: 'copilot' })
    const notes = mintLiveAgentRunToken({ ...BASE, turnType: 'notes' })
    const say = sayToUser as unknown as Resolver
    const ask = askUser as unknown as Resolver
    const instr = instructions as unknown as Resolver

    // Concurrent session starts for the two turns (the client fires both per window).
    const [cSay, nSay, cAsk, nAsk, cPrompt, nPrompt] = await Promise.all([
      say.events['session.started']({}, sessionFor(copilot)),
      say.events['session.started']({}, sessionFor(notes)),
      ask.events['session.started']({}, sessionFor(copilot)),
      ask.events['session.started']({}, sessionFor(notes)),
      instr.events['session.started']({}, sessionFor(copilot)),
      instr.events['session.started']({}, sessionFor(notes)),
    ])
    expect(cSay, 'the copilot lost say_to_user').not.toBeNull()
    expect(cAsk, 'the copilot lost ask_user').not.toBeNull()
    expect(nSay, 'the note-taker can talk').toBeNull()
    expect(nAsk, 'the note-taker can ask').toBeNull()
    const promptOf = (x: unknown) => (x as { content: string }).content
    expect(promptOf(nPrompt)).toContain(LIVE_NOTES_PAIRING_PROMPT)
    expect(promptOf(cPrompt)).not.toContain(LIVE_NOTES_PAIRING_PROMPT)

    // One spec rebuild per TURN, shared by that turn's resolvers — not per resolver.
    expect(h.specHits).toBe(2)

    // Next window: the order flips (notes first), with fresh tokens.
    const notes2 = mintLiveAgentRunToken({ ...BASE, turnType: 'notes' })
    const copilot2 = mintLiveAgentRunToken({ ...BASE, turnType: 'copilot' })
    expect(await say.events['session.started']({}, sessionFor(notes2))).toBeNull()
    expect(await say.events['session.started']({}, sessionFor(copilot2))).not.toBeNull()
    // …and the first window's tokens still resolve to their own turn types.
    expect(await say.events['session.started']({}, sessionFor(notes))).toBeNull()
    expect(await say.events['session.started']({}, sessionFor(copilot))).not.toBeNull()
  })

  it('a batch token and a copilot token for the same capture get different surfaces', async () => {
    const batch = mintLiveAgentRunToken({ ...BASE, turnType: 'batch' })
    const copilot = mintLiveAgentRunToken({ ...BASE, turnType: 'copilot' })
    const [bRes, cRes] = await Promise.all([
      GET(new Request('https://app.test/api/internal/live-agent/spec?schemas=1', { headers: { 'x-live-agent-secret': 'fresh-secret', 'x-live-agent-token': batch } })),
      GET(new Request('https://app.test/api/internal/live-agent/spec?schemas=1', { headers: { 'x-live-agent-secret': 'fresh-secret', 'x-live-agent-token': copilot } })),
    ])
    const b = (await bRes.json()) as { systemPrompt: string; coreToolNames: string[] }
    const c = (await cRes.json()) as { systemPrompt: string; coreToolNames: string[] }
    expect(b.systemPrompt).toContain(BATCH_SUMMARY_REQUIRED)
    expect(c.systemPrompt).not.toContain(BATCH_SUMMARY_REQUIRED)
  })
})
