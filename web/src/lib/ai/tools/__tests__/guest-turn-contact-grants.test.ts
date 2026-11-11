/**
 * A guest's or a linked agent's turn reads no grant on a contact or a company
 * (migration 519). Such a turn runs the OWNER's tools with the owner's user id
 * (src/lib/guests/guest-tools.ts passes omitGrants), and a grant (492) shares a
 * record with the owner, never with whoever they let talk to their agent.
 *
 * The fake database answers the twins as 493 does for a contact and a company
 * shared with the owner by a grant: visible through the 2-arg forms, hidden
 * once `p_grants: false` is passed (519's 3-arg forms). The owner's own turn
 * sends no `p_grants` at all, so it reads exactly as before.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const hoisted = vi.hoisted(() => ({ serviceRpc: vi.fn() }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ rpc: hoisted.serviceRpc }) }))

const { createTools } = await import('@/lib/ai/tools')
const { isCompanyVisibleTo, isContactVisibleTo, filterVisibleCompanies, filterVisibleContacts } = await import(
  '@/lib/crm/contact-visibility'
)
const { hiddenGraphRefs } = await import('@/lib/knowledge/entity-fences')

const WS = '00000000-0000-4000-8000-0000000000a1'
const OWNER = '00000000-0000-4000-8000-0000000000b1'
const GRANTED_CONTACT = '00000000-0000-4000-8000-0000000000c1'
const GRANTED_COMPANY = '00000000-0000-4000-8000-0000000000d1'

type RpcCall = { fn: string; args: Record<string, unknown> }
let rpcCalls: RpcCall[] = []

function fakeSupabase(tableRows: Record<string, unknown[]> = {}): SupabaseClient {
  return {
    from: (table: string) => fakeFrom(tableRows[table] ?? []),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args })
      // 493's grant arm: the shared contact and company are the owner's to see,
      // unless the caller asked without grants (519).
      if (fn === 'contact_visible_to') return { data: args.p_grants !== false, error: null }
      if (fn === 'company_visible_to') return { data: args.p_grants !== false, error: null }
      if (fn === 'entity_refs_hidden') {
        const types = args.p_types as string[]
        const ids = args.p_ids as string[]
        return { data: args.p_grants === false ? types.map((t, i) => ({ entity_type: t, entity_id: ids[i] })) : [], error: null }
      }
      return { data: null, error: null }
    },
  } as unknown as SupabaseClient
}

/** A query builder whose every filter returns itself and which resolves to `rows`. */
function fakeFrom(rows: unknown[]): unknown {
  const result = { data: rows, error: null }
  const builder: unknown = new Proxy(
    {},
    {
      get: (_t, k: string) => {
        if (k === 'then') return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject)
        if (k === 'maybeSingle' || k === 'single') return async () => ({ data: rows[0] ?? null, error: null })
        return () => builder
      },
    },
  )
  return builder
}

function supabaseWith(tableRows: Record<string, unknown[]>): SupabaseClient {
  return {
    from: (table: string) => fakeFrom(tableRows[table] ?? []),
    rpc: fakeSupabase().rpc,
  } as unknown as SupabaseClient
}

type Exec = { execute: (input: Record<string, unknown>, opts: unknown) => Promise<Record<string, unknown>> }
const run = (tools: Record<string, unknown>, name: string, input: Record<string, unknown>) =>
  (tools[name] as Exec).execute(input, { toolCallId: 't', messages: [] })

const callsOf = (fn: string) => rpcCalls.filter((c) => c.fn === fn)

beforeEach(() => {
  rpcCalls = []
  hoisted.serviceRpc.mockReset()
  hoisted.serviceRpc.mockResolvedValue({ data: [{ id: GRANTED_COMPANY, name: 'Fernhill Studio' }], error: null })
})

describe('the visibility helpers', () => {
  it('pass p_grants: false only when told grants: false', async () => {
    const db = fakeSupabase()
    expect(await isContactVisibleTo(db, GRANTED_CONTACT, OWNER)).toBe(true)
    expect(await isContactVisibleTo(db, GRANTED_CONTACT, OWNER, { grants: false })).toBe(false)
    expect(await isCompanyVisibleTo(db, GRANTED_COMPANY, OWNER)).toBe(true)
    expect(await isCompanyVisibleTo(db, GRANTED_COMPANY, OWNER, { grants: false })).toBe(false)
    expect(await filterVisibleContacts(db, OWNER, [{ id: GRANTED_CONTACT }], { grants: false })).toEqual([])
    expect(await filterVisibleCompanies(db, OWNER, [{ id: GRANTED_COMPANY }], { grants: false })).toEqual([])
    expect(rpcCalls.map((c) => 'p_grants' in c.args)).toEqual([false, true, false, true, true, true])
    expect(rpcCalls.filter((c) => 'p_grants' in c.args).every((c) => c.args.p_grants === false)).toBe(true)
  })

  it('the graph fence asks entity_refs_hidden without grants only when told so', async () => {
    const db = fakeSupabase()
    const refs = [{ type: 'contact', id: GRANTED_CONTACT }]
    expect((await hiddenGraphRefs(db, refs, OWNER, WS)).size).toBe(0)
    expect((await hiddenGraphRefs(db, refs, OWNER, WS, { grants: false })).size).toBe(1)
    const [own, guest] = callsOf('entity_refs_hidden')
    expect(own.args).not.toHaveProperty('p_grants')
    expect(guest.args.p_grants).toBe(false)
  })
})

describe('createTools on a guest turn (omitGrants) vs the owner turn', () => {
  const contactRow = { id: GRANTED_CONTACT, full_name: 'Ana Ortiz', email: 'ana@example.com' }

  it('list_contacts: the owner sees a contact shared with them, their guest does not', async () => {
    const db = supabaseWith({ contact: [contactRow] })
    const owner = await run(createTools(OWNER, db, WS), 'list_contacts', {})
    expect(owner.count).toBe(1)
    expect(callsOf('contact_visible_to').at(-1)!.args).not.toHaveProperty('p_grants')

    const guest = await run(createTools(OWNER, db, WS, undefined, { omitGrants: true }), 'list_contacts', {})
    expect(guest.count).toBe(0)
    expect(callsOf('contact_visible_to').at(-1)!.args.p_grants).toBe(false)
  })

  it('get_contact: a contact only a grant opens is not found on a guest turn', async () => {
    const db = supabaseWith({ contact: [contactRow] })
    const guest = await run(createTools(OWNER, db, WS, undefined, { omitGrants: true }), 'get_contact', { email: 'ana@example.com' })
    expect(guest).toEqual({ success: false, error: 'Contact not found' })
    expect(callsOf('contact_visible_to').every((c) => c.args.p_grants === false)).toBe(true)
  })

  it('get_contact_details: the context fence asks without grants on a guest turn', async () => {
    const db = supabaseWith({ contact: [{ ...contactRow, workspace_id: WS, merged_into_contact_id: null }] })
    const guest = await run(createTools(OWNER, db, WS, undefined, { omitGrants: true }), 'get_contact_details', { contact_id: GRANTED_CONTACT })
    expect(guest).toEqual({ success: false, error: 'Contact not found' })
    expect(callsOf('contact_visible_to').length).toBeGreaterThan(0)
    expect(callsOf('contact_visible_to').every((c) => c.args.p_grants === false)).toBe(true)
  })

  it('list_companies: list_companies_with_stats gets p_grants: false on a guest turn, nothing on the owner turn', async () => {
    const db = supabaseWith({})
    await run(createTools(OWNER, db, WS), 'list_companies', {})
    await run(createTools(OWNER, db, WS, undefined, { omitGrants: true }), 'list_companies', {})
    const [own, guest] = hoisted.serviceRpc.mock.calls
    expect(own[0]).toBe('list_companies_with_stats')
    expect(own[1]).not.toHaveProperty('p_grants')
    expect(guest[1]).toMatchObject({ p_user_id: OWNER, p_grants: false })
  })

  it('get_company_overview: a company only a grant opens is not found on a guest turn', async () => {
    const db = supabaseWith({ company: [{ id: GRANTED_COMPANY, workspace_id: WS, name: 'Fernhill Studio' }] })
    const owner = await run(createTools(OWNER, db, WS), 'get_company_overview', { company_id: GRANTED_COMPANY })
    expect(owner.success).toBe(true)
    expect(callsOf('company_visible_to')[0].args).not.toHaveProperty('p_grants')

    rpcCalls = []
    const guest = await run(createTools(OWNER, db, WS, undefined, { omitGrants: true }), 'get_company_overview', { company_id: GRANTED_COMPANY })
    expect(guest).toEqual({ success: false, error: 'Company not found' })
    expect(callsOf('company_visible_to')[0].args.p_grants).toBe(false)
  })
})
