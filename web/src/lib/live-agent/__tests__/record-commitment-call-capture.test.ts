/**
 * record_commitment on a call's capture (src/lib/live-agent/tools.ts, the
 * real tool): what anyone says in a call steers it, and the conversation
 * reads what it files.
 *
 *   - Its duplicate check never matches the owner's PRIVATE claims: a hit
 *     would attach this capture as a source and so widen the claim to the
 *     conversation, and the answer would tell the model it exists. It matches
 *     shared claims, or claims this capture already sources; anything else is
 *     a new claim, and nothing about the owner's is returned.
 *   - It is confirmed only when the member it is about said the line (their
 *     roster row): a guest naming a member files a suggestion.
 *   - People resolve to members only: no contact is looked up or linked.
 *
 * An ordinary capture keeps its dedupe against what its owner can see.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({
  attached: [] as Array<{ claimId: string }>,
  inserted: [] as Array<Record<string, unknown>>,
  rpcs: [] as Array<[string, Record<string, unknown>]>,
  resolveOpts: [] as unknown[],
  speakers: [] as Array<{ participant_id: string | null; member_id: string | null; source: string | null }>,
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/ai/embeddings', () => ({ embed: async () => [0.1, 0.2, 0.3] }))
vi.mock('@/lib/ai/claim-provenance', () => ({
  attachClaimProvenance: async (_sb: unknown, args: { claimId: string }) => {
    h.attached.push({ claimId: args.claimId })
    return { sourceCount: 1, linkCount: 1, errors: [] }
  },
}))
vi.mock('@/lib/live-agent/speaker-resolution', async (orig) => ({
  ...(await orig<typeof import('@/lib/live-agent/speaker-resolution')>()),
  resolvePersonForCapture: async (_sb: unknown, _ws: string, _cap: string, name: string, _user: string, opts: unknown) => {
    h.resolveOpts.push(opts)
    return { name, memberId: 'mem-rosa', contactId: null, viaSpeakerMap: false, unresolvedLabel: false }
  },
}))

const { createLiveAgentTools } = await import('../tools')

const PRIVATE_CLAIM = 'claim-owner-private'
const OWNER = 'user-owner'

/** A service client: the capture is private to its owner; match_claims answers by who asks. */
function fakeDb(opts: { sourcedHere?: string[] } = {}): SupabaseClient {
  const chain = (table: string) => {
    const c: Record<string, unknown> = {}
    Object.assign(c, {
      select: () => c,
      eq: () => c,
      in: async () => ({ data: (opts.sourcedHere ?? []).map((claim_id) => ({ claim_id })), error: null }),
      maybeSingle: async () =>
        table === 'captures' ? { data: { started_at: '2026-11-13T15:00:00Z', created_at: null, visibility: 'private', user_id: OWNER }, error: null } : { data: null, error: null },
      insert: (row: Record<string, unknown>) => {
        h.inserted.push({ table, ...row })
        return { select: () => ({ single: async () => ({ data: { id: 'claim-new' }, error: null }) }) }
      },
    })
    return c
  }
  return {
    from: chain,
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpcs.push([name, args])
      // The owner's private claim matches only when matching as the owner.
      if (name === 'match_claims') return { data: args.p_requesting_user_id === OWNER ? [{ claim_id: PRIVATE_CLAIM }] : [], error: null }
      if (name === 'capture_feed_quote_speakers') return { data: h.speakers, error: null }
      return { data: null, error: null }
    },
  } as unknown as SupabaseClient
}

const policy = { enabled: true, claims: 0.5, actions: 0.5, decisions: 0.5, allow_external: false }
type Exec = { execute: (input: Record<string, unknown>, ctx: unknown) => Promise<Record<string, unknown>> }
const tool = (db: SupabaseClient, callCapture: boolean) =>
  (createLiveAgentTools(OWNER, db, 'ws-1', 'cap-call', null, null, 'mem-owner', null, policy as never, callCapture ? { callCapture: true } : {}) as unknown as Record<string, Exec>).record_commitment

const commit = (t: Exec, quote = 'I will pay the invoice by Friday') =>
  t.execute({ person_name: 'Rosa Lind', commitment: 'pay the invoice by Friday', trigger_quote: quote, confidence: 0.95 }, { toolCallId: 't', messages: [] })

beforeEach(() => {
  h.attached = []
  h.inserted = []
  h.rpcs = []
  h.resolveOpts = []
  h.speakers = []
})

describe('record_commitment on a call’s capture', () => {
  it('never matches the owner’s private claim: nothing attached, nothing about it returned', async () => {
    const out = await commit(tool(fakeDb(), true))
    expect(h.attached.map((a) => a.claimId)).not.toContain(PRIVATE_CLAIM)
    expect(out.deduplicated).toBeUndefined()
    expect(JSON.stringify(out)).not.toContain(PRIVATE_CLAIM)
    // A new claim of its own instead.
    expect(out.claim_id).toBe('claim-new')
    // Its first look was at shared claims only.
    expect(h.rpcs.find(([n]) => n === 'match_claims')?.[1].p_requesting_user_id).toBeNull()
  })

  it('a claim this same capture already sources is the same commitment, said again', async () => {
    const out = await commit(tool(fakeDb({ sourcedHere: [PRIVATE_CLAIM] }), true))
    expect(out).toMatchObject({ deduplicated: true, claim_id: PRIVATE_CLAIM })
  })

  it('a guest naming a member files a suggestion, never a confirmed claim', async () => {
    h.speakers = [{ participant_id: 'p-guest', member_id: null, source: 'call_roster' }]
    await commit(tool(fakeDb(), true), 'Rosa committed to paying the invoice by Friday')
    const claim = h.inserted.find((r) => r.table === 'claim')!
    expect(claim.confirmation).toBe('suggested')
    expect(claim.auto_accepted).toBe(false)
  })

  it('the member saying it themselves is confirmed', async () => {
    h.speakers = [{ participant_id: 'p-rosa', member_id: 'mem-rosa', source: 'call_roster' }]
    await commit(tool(fakeDb(), true))
    const claim = h.inserted.find((r) => r.table === 'claim')!
    expect(claim.confirmation).toBe('confirmed')
  })

  it('people resolve to members only', async () => {
    await commit(tool(fakeDb(), true))
    expect(h.resolveOpts).toEqual([{ contacts: false }])
  })
})

describe('an ordinary capture', () => {
  it('keeps its dedupe against what its private owner can see, and its name-based acceptance', async () => {
    const out = await commit(tool(fakeDb(), false))
    expect(out).toMatchObject({ deduplicated: true, claim_id: PRIVATE_CLAIM })
    expect(h.resolveOpts).toEqual([{ contacts: true }])
  })
})
