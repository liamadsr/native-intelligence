/**
 * Extraction-time COMPANY inheritance: which company (if any) a capture's
 * claims should anchor to, derived from its participants with no LLM in the
 * loop.
 *
 * The rule is all-or-nothing on purpose — link only when exactly ONE distinct
 * company covers the company-bearing EXTERNAL participants. Everything below
 * is a way of failing that test:
 *   - two vendors on the same call → ambiguous → no anchor;
 *   - nobody matched to a contact → nothing to inherit from;
 *   - only teammates present → their self-contacts are filtered out, which is
 *     also what keeps the workspace's OWN company from being inherited.
 * A wrong company anchor is more visible damage than a missing one, so refusing
 * ambiguity needs no tiebreak rule to defend later.
 */
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/inngest/client', () => ({
  inngest: { createFunction: () => ({ id: 'claim-extraction' }) },
}))
vi.mock('@/lib/eve/utility/run-utility', () => ({ runUtilityTask: vi.fn() }))
vi.mock('@/lib/ai/embeddings', () => ({ embed: vi.fn(), batchEmbed: vi.fn() }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ from: vi.fn() }) }))
vi.mock('@/lib/inngest/usage-guard', () => ({ guardBackgroundUsage: vi.fn() }))

import { resolveCaptureCompanyId } from '../claim-extraction'

const CAPTURE = 'cap-1'
const WS = 'ws-1'

interface Filters {
  table: string
  eq: Record<string, unknown>
  is: Record<string, unknown>
  not: Array<[string, string]>
  in: Record<string, unknown>
}

/**
 * Two-table double. `participants` are capture_participant rows;
 * `contacts` are contact rows, filtered here the way the real query's
 * `.is('member_id', null)` / `.not('company_id','is',null)` filters would.
 */
function makeClient(opts: {
  participants?: Array<{ contact_id: string | null }>
  contacts?: Array<{ id: string; company_id: string | null; member_id: string | null }>
  throwOn?: string
}) {
  const calls: Filters[] = []
  const client = {
    from(table: string) {
      if (opts.throwOn === table) throw new Error('boom')
      const rec: Filters = { table, eq: {}, is: {}, not: [], in: {} }
      calls.push(rec)
      const c: Record<string, unknown> = {}
      c.select = () => c
      c.eq = (k: string, v: unknown) => {
        rec.eq[k] = v
        return c
      }
      c.is = (k: string, v: unknown) => {
        rec.is[k] = v
        return c
      }
      c.not = (k: string, op: string) => {
        rec.not.push([k, op])
        return c
      }
      c.in = (k: string, v: unknown) => {
        rec.in[k] = v
        return c
      }
      c.limit = () => c
      c.then = (resolve: (v: unknown) => void) => {
        if (table === 'capture_participant') {
          return resolve({
            data: (opts.participants ?? []).filter((p) => p.contact_id !== null),
            error: null,
          })
        }
        const ids = new Set((rec.in.id as string[]) ?? [])
        const rows = (opts.contacts ?? []).filter(
          (ct) => ids.has(ct.id) && ct.member_id === null && ct.company_id !== null,
        )
        return resolve({ data: rows, error: null })
      }
      return c
    },
  } as unknown as SupabaseClient
  return { client, calls }
}

describe('resolveCaptureCompanyId — the single-company rule', () => {
  it('links when EXACTLY ONE company covers the external participants', async () => {
    const { client } = makeClient({
      participants: [{ contact_id: 'ct-1' }, { contact_id: 'ct-2' }],
      contacts: [
        { id: 'ct-1', company_id: 'co-a', member_id: null },
        { id: 'ct-2', company_id: 'co-a', member_id: null },
      ],
    })
    expect(await resolveCaptureCompanyId(client, CAPTURE, WS)).toBe('co-a')
  })

  it('SKIPS when two distinct companies are present (a multi-vendor call)', async () => {
    const { client } = makeClient({
      participants: [{ contact_id: 'ct-1' }, { contact_id: 'ct-2' }],
      contacts: [
        { id: 'ct-1', company_id: 'co-a', member_id: null },
        { id: 'ct-2', company_id: 'co-b', member_id: null },
      ],
    })
    expect(await resolveCaptureCompanyId(client, CAPTURE, WS)).toBeNull()
  })

  it('SKIPS when no participant matched a contact at all', async () => {
    const { client } = makeClient({ participants: [{ contact_id: null }] })
    expect(await resolveCaptureCompanyId(client, CAPTURE, WS)).toBeNull()
  })

  it('SKIPS when there are no participants', async () => {
    const { client } = makeClient({ participants: [] })
    expect(await resolveCaptureCompanyId(client, CAPTURE, WS)).toBeNull()
  })

  it('SKIPS when every matched contact has no company', async () => {
    const { client } = makeClient({
      participants: [{ contact_id: 'ct-1' }],
      contacts: [{ id: 'ct-1', company_id: null, member_id: null }],
    })
    expect(await resolveCaptureCompanyId(client, CAPTURE, WS)).toBeNull()
  })

  it('ignores TEAMMATES — a member self-contact never contributes a company', async () => {
    // This is what keeps the workspace's OWN company (created by onboarding
    // enrichment and attached to every teammate's self-contact) from being
    // inherited as if it were the meeting's other party.
    const { client } = makeClient({
      participants: [{ contact_id: 'ct-self' }, { contact_id: 'ct-ext' }],
      contacts: [
        { id: 'ct-self', company_id: 'co-home', member_id: 'm-1' },
        { id: 'ct-ext', company_id: 'co-a', member_id: null },
      ],
    })
    // Without the member filter this would be ambiguous (two companies) and
    // return null; with it, the external company wins cleanly.
    expect(await resolveCaptureCompanyId(client, CAPTURE, WS)).toBe('co-a')
  })

  it('returns null (never the home company) for an internal-only meeting', async () => {
    const { client } = makeClient({
      participants: [{ contact_id: 'ct-self' }, { contact_id: 'ct-mate' }],
      contacts: [
        { id: 'ct-self', company_id: 'co-home', member_id: 'm-1' },
        { id: 'ct-mate', company_id: 'co-home', member_id: 'm-2' },
      ],
    })
    expect(await resolveCaptureCompanyId(client, CAPTURE, WS)).toBeNull()
  })

  it('dedupes a participant listed twice', async () => {
    const { client, calls } = makeClient({
      participants: [{ contact_id: 'ct-1' }, { contact_id: 'ct-1' }],
      contacts: [{ id: 'ct-1', company_id: 'co-a', member_id: null }],
    })
    expect(await resolveCaptureCompanyId(client, CAPTURE, WS)).toBe('co-a')
    expect(calls.find((c) => c.table === 'contact')!.in.id).toEqual(['ct-1'])
  })

  it('WORKSPACE-fences the contact read (service-role client bypasses RLS)', async () => {
    const { client, calls } = makeClient({
      participants: [{ contact_id: 'ct-1' }],
      contacts: [{ id: 'ct-1', company_id: 'co-a', member_id: null }],
    })
    await resolveCaptureCompanyId(client, CAPTURE, WS)
    expect(calls.find((c) => c.table === 'contact')!.eq.workspace_id).toBe(WS)
    expect(calls.find((c) => c.table === 'capture_participant')!.eq.capture_id).toBe(CAPTURE)
  })

  it('degrades to null on a query failure — enrichment never fails extraction', async () => {
    const { client } = makeClient({ throwOn: 'capture_participant' })
    await expect(resolveCaptureCompanyId(client, CAPTURE, WS)).resolves.toBeNull()
  })
})
