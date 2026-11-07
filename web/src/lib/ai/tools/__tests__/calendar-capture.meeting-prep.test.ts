/**
 * Tests for get_meeting_prep's attendee_knowledge section (knowledge-recall
 * plan item 20c). The tool now surfaces what the knowledge graph knows about
 * the meeting's attendees — two claim sets, both status='active' and
 * confirmation != 'dismissed':
 *   (a) subject_member_id ∈ resolved workspace members (internal attendees)
 *   (b) claims linked via about→contact edges (either direction) to resolved
 *       workspace contacts (external attendees' record_commitment claims)
 * Combined, deduped, event_at DESC (fallback created_at), capped at 8.
 *
 * A claims-query failure must degrade to an empty attendee_knowledge array and
 * never break the rest of meeting prep.
 *
 * The Supabase double dispatches per-table and honors the eq/in/neq filters
 * that matter (status / confirmation / subject_member_id / id / target_id /
 * source_id) so the two claim queries and the entity_link resolution return
 * their correct rows rather than a canned blob.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { withMemberSchema } from '@/test/member-schema'
import { _resetMemberEmailCacheForTests } from '@/lib/workspace-member-emails'
import { createCalendarCaptureTools } from '../calendar-capture'

// calendar-capture imports calendar integrations; stub them so the module
// loads in the test env (get_meeting_prep never touches these paths).
vi.mock('@/lib/integrations/calendar-sync', () => ({
  syncCalendarToCaptures: vi.fn(),
  getUpcomingCaptures: vi.fn(),
}))
vi.mock('@/lib/integrations/calendar', () => ({
  listCalendarEvents: vi.fn(),
  getCalendarProvider: vi.fn(),
}))

// Members' emails are resolved on the service client (member has no email
// column; the address lives on auth.users). makeSupabase points it at the
// same double.
let serviceFake: unknown = null
vi.mock('@/lib/admin', () => ({ getServiceClient: () => serviceFake }))

const USER_ID = 'user-1'
const WORKSPACE_ID = 'ws-1'
const EXEC_OPTS = { toolCallId: 'c1', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

const MEMBER = { id: 'member-1', display_name: 'Alice Member', user_id: 'user-alice' }
/** Alice's sign-in email, on her auth user: member rows carry no email. */
const MEMBER_EMAIL = 'alice@acme.com'
const USER_EMAILS: Record<string, string> = { [MEMBER.user_id]: MEMBER_EMAIL }
const CONTACT = { id: 'contact-1', full_name: 'Bob External' }

type ClaimRow = {
  id: string
  text: string
  type: string
  confirmation: string
  status: string
  event_at: string | null
  created_at: string
  subject_member_id: string | null
}

const claim = (p: Partial<ClaimRow> & { id: string }): ClaimRow => ({
  text: `claim ${p.id}`,
  type: 'fact',
  confirmation: 'suggested',
  status: 'active',
  event_at: null,
  created_at: '2026-06-01T00:00:00.000Z',
  subject_member_id: null,
  ...p,
})

type EdgeRow = { source_id: string; target_id: string; source_type: string; target_type: string }

/**
 * A table-dispatching Supabase double. Each from(table) returns a proxy chain
 * that records eq/in/neq/order/limit calls; on await it filters the fixtures
 * for that table by the recorded predicates. `throwOnClaim` makes the `claim`
 * table reject so we can assert graceful degradation.
 */
function makeSupabase(opts: {
  members?: typeof MEMBER[]
  contacts?: typeof CONTACT[]
  claims?: ClaimRow[]
  edges?: EdgeRow[]
  throwOnClaim?: boolean
  /** Contact ids contact_visible_to answers false for (another member's private contact). */
  hiddenContacts?: string[]
}) {
  const from = vi.fn((table: string) => {
    const eqs: Record<string, unknown> = {}
    const ins: Record<string, unknown[]> = {}
    const neqs: Record<string, unknown> = {}
    const chain: Record<string, unknown> = {}
    const resolveData = (): unknown[] => {
      if (table === 'member') return opts.members ?? []
      if (table === 'contact') {
        return (opts.contacts ?? []).filter((c) => true)
      }
      if (table === 'capture_participant') {
        // recent-captures query — no matching captures in these tests
        return []
      }
      if (table === 'actions') return []
      if (table === 'decision') return []
      if (table === 'entity_link') {
        return (opts.edges ?? []).filter((e) => {
          if (eqs['source_type'] && e.source_type !== eqs['source_type']) return false
          if (eqs['target_type'] && e.target_type !== eqs['target_type']) return false
          if (ins['target_id'] && !(ins['target_id'] as string[]).includes(e.target_id)) return false
          if (ins['source_id'] && !(ins['source_id'] as string[]).includes(e.source_id)) return false
          return true
        })
      }
      if (table === 'claim') {
        return (opts.claims ?? []).filter((c) => {
          if (eqs['status'] && c.status !== eqs['status']) return false
          if (neqs['confirmation'] && c.confirmation === neqs['confirmation']) return false
          if (ins['subject_member_id']) {
            if (
              c.subject_member_id == null ||
              !(ins['subject_member_id'] as string[]).includes(c.subject_member_id)
            )
              return false
          }
          if (ins['id'] && !(ins['id'] as string[]).includes(c.id)) return false
          return true
        })
      }
      return []
    }
    const proxy: Record<string, unknown> = new Proxy(chain, {
      get(t, p: string) {
        if (p === 'then') {
          return (
            resolve: (v: unknown) => unknown,
            reject?: (e: unknown) => unknown,
          ) => {
            if (table === 'claim' && opts.throwOnClaim) {
              // Genuine rejection: propagate to the await's onRejected so the
              // tool's surrounding try/catch fires (not resolve with an Error).
              return Promise.reject(new Error('boom')).then(resolve, reject)
            }
            return Promise.resolve({ data: resolveData(), error: null }).then(resolve)
          }
        }
        if (p === 'eq') return (col: string, val: unknown) => ((eqs[col] = val), proxy)
        if (p === 'neq') return (col: string, val: unknown) => ((neqs[col] = val), proxy)
        if (p === 'in') return (col: string, vals: unknown[]) => ((ins[col] = vals), proxy)
        if (p === 'maybeSingle') return () => Promise.resolve({ data: null, error: null })
        return () => proxy
      },
    })
    return proxy
  })
  // contact_visible_to: visible unless listed in hiddenContacts.
  const rpc = vi.fn(async (_fn: string, args: { p_contact_id: string }) => ({
    data: !(opts.hiddenContacts ?? []).includes(args.p_contact_id),
    error: null,
  }))
  // Real member columns only: a member query naming one the table lacks gets
  // PostgREST's error, as `.select('id, display_name, email')` did.
  const client = withMemberSchema({
    from,
    rpc,
    auth: {
      admin: {
        getUserById: async (id: string) => ({ data: { user: { id, email: USER_EMAILS[id] ?? null } }, error: null }),
      },
    },
  })
  serviceFake = client
  return client as never
}

beforeEach(() => {
  _resetMemberEmailCacheForTests()
  makeSupabase({})
})

const prep = (supabase: unknown) =>
  createCalendarCaptureTools(USER_ID, supabase as never, WORKSPACE_ID).get_meeting_prep

type PrepResult = {
  success: boolean
  attendee_knowledge: {
    claim_id: string
    text: string
    type: string
    confirmation: string
    event_at: string | null
    about: string | null
  }[]
}

describe('get_meeting_prep — attendee_knowledge', () => {
  it("matches a teammate by the sign-in email on their auth user, whatever its case", async () => {
    const supabase = makeSupabase({
      members: [MEMBER],
      claims: [claim({ id: 'c-member', text: 'Alice owns the roadmap', subject_member_id: MEMBER.id })],
    })
    const res = (await prep(supabase).execute!(
      { participant_email: 'Alice@Acme.com' } as never,
      EXEC_OPTS,
    )) as unknown as PrepResult

    expect(res.success).toBe(true)
    expect(res.attendee_knowledge.map((c) => c.about)).toEqual(['Alice Member'])
  })

  it('surfaces a claim whose subject_member_id is a resolved attendee member', async () => {
    const supabase = makeSupabase({
      members: [MEMBER],
      claims: [
        claim({ id: 'c-member', text: 'Alice owns the roadmap', subject_member_id: MEMBER.id }),
      ],
    })
    const res = (await prep(supabase).execute!(
      { participant_email: MEMBER_EMAIL } as never,
      EXEC_OPTS,
    )) as unknown as PrepResult

    expect(res.success).toBe(true)
    expect(res.attendee_knowledge).toHaveLength(1)
    expect(res.attendee_knowledge[0]).toMatchObject({
      claim_id: 'c-member',
      text: 'Alice owns the roadmap',
      about: 'Alice Member',
    })
  })

  it('surfaces a claim linked via an about→contact edge for an external attendee', async () => {
    const supabase = makeSupabase({
      contacts: [CONTACT],
      claims: [
        claim({ id: 'c-contact', text: 'Bob committed to send the SOW', type: 'fact' }),
      ],
      // contact --(edge)--> claim (either direction is honored)
      edges: [
        {
          source_type: 'contact',
          source_id: CONTACT.id,
          target_type: 'claim',
          target_id: 'c-contact',
        },
      ],
    })
    const res = (await prep(supabase).execute!(
      { participant_email: 'bob@vendor.com' } as never,
      EXEC_OPTS,
    )) as unknown as PrepResult

    expect(res.success).toBe(true)
    expect(res.attendee_knowledge).toHaveLength(1)
    expect(res.attendee_knowledge[0]).toMatchObject({
      claim_id: 'c-contact',
      text: 'Bob committed to send the SOW',
      about: 'Bob External',
    })
  })

  it("never surfaces knowledge about another member's private contact (service role: contact_visible_to)", async () => {
    const supabase = makeSupabase({
      contacts: [CONTACT],
      hiddenContacts: [CONTACT.id],
      claims: [claim({ id: 'c-contact', text: 'Bob committed to send the SOW', type: 'fact' })],
      edges: [{ source_type: 'contact', source_id: CONTACT.id, target_type: 'claim', target_id: 'c-contact' }],
    })
    const res = (await prep(supabase).execute!(
      { participant_email: 'bob@vendor.com' } as never,
      EXEC_OPTS,
    )) as unknown as PrepResult

    expect(res.success).toBe(true)
    expect(res.attendee_knowledge).toEqual([])
    expect(JSON.stringify(res)).not.toContain('Bob External')
  })

  it('excludes dismissed and non-active claims from attendee_knowledge', async () => {
    const supabase = makeSupabase({
      members: [MEMBER],
      claims: [
        claim({ id: 'c-ok', subject_member_id: MEMBER.id }),
        claim({ id: 'c-dismissed', subject_member_id: MEMBER.id, confirmation: 'dismissed' }),
        claim({ id: 'c-superseded', subject_member_id: MEMBER.id, status: 'superseded' }),
      ],
    })
    const res = (await prep(supabase).execute!(
      { participant_email: MEMBER_EMAIL } as never,
      EXEC_OPTS,
    )) as unknown as PrepResult

    expect(res.attendee_knowledge.map((c) => c.claim_id)).toEqual(['c-ok'])
  })

  it('degrades to an empty attendee_knowledge array when the claims query fails', async () => {
    const supabase = makeSupabase({
      members: [MEMBER],
      claims: [claim({ id: 'c-member', subject_member_id: MEMBER.id })],
      throwOnClaim: true,
    })
    const res = (await prep(supabase).execute!(
      { participant_email: MEMBER_EMAIL } as never,
      EXEC_OPTS,
    )) as unknown as PrepResult

    // The rest of meeting prep still succeeds; only knowledge degrades.
    expect(res.success).toBe(true)
    expect(res.attendee_knowledge).toEqual([])
  })
})

describe('get_meeting_prep — recent-captures embed', () => {
  /**
   * PostgREST binds embedded order/filter params by the embed's ALIAS when one
   * is given. The embed is aliased `capture`, and the workspace + visibility
   * predicates key on that alias — the ordering must match, or `.limit(5)`
   * silently returns 5 arbitrary rows instead of the 5 most recent captures.
   */
  it('orders the aliased capture embed by the alias, not the table name', async () => {
    const orderCalls: Array<[string, unknown]> = []
    const from = vi.fn((table: string) => {
      const proxy: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, p: string) {
            if (p === 'then') {
              return (resolve: (v: unknown) => unknown) =>
                Promise.resolve({ data: [], error: null }).then(resolve)
            }
            if (p === 'maybeSingle') return () => Promise.resolve({ data: null, error: null })
            if (p === 'order' && table === 'capture_participant') {
              return (col: string, opts: unknown) => (orderCalls.push([col, opts]), proxy)
            }
            return () => proxy
          },
        },
      )
      return proxy
    })

    await createCalendarCaptureTools(
      USER_ID,
      { from } as never,
      WORKSPACE_ID,
    ).get_meeting_prep.execute!({ participant_email: MEMBER_EMAIL } as never, EXEC_OPTS)

    expect(orderCalls).toContainEqual([
      'created_at',
      { ascending: false, referencedTable: 'capture' },
    ])
  })
})
