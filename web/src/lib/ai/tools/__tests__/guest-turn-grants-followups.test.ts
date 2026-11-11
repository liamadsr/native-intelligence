/**
 * The rest of a guest's or a linked agent's turn reading no grant (migration
 * 519): a campaign's audience (and the replay of its card), a name a
 * suggestion resolves, an id link_entities checks, and the custom-field gate's
 * "forbidden" vs "not found".
 *
 * The fake database answers contact_visible_to as 493 does for a contact
 * shared with the owner by a grant: visible, unless asked with p_grants: false.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({
  prepare: vi.fn(),
  execute: vi.fn(),
  privateKinds: vi.fn(),
}))

vi.mock('@/lib/campaigns/launch', async (orig) => ({
  ...(await orig<typeof import('@/lib/campaigns/launch')>()),
  loadCampaignForLaunch: async () => ({ id: CAMPAIGN, name: 'Spring check-in', status: 'active', sequence_id: 'seq-1' }),
  prepareCampaignLaunch: h.prepare,
  executeCampaignLaunch: h.execute,
}))
vi.mock('@/lib/sequences/launch-card', async (orig) => ({
  ...(await orig<typeof import('@/lib/sequences/launch-card')>()),
  approvedOutreach: (call: unknown) => (call ? { id: CAMPAIGN, content_hash: 'h' } : null),
}))
vi.mock('@/lib/ai/tools/_shared', async (orig) => ({
  ...(await orig<typeof import('@/lib/ai/tools/_shared')>()),
  resolveEntityWorkspace: async () => ({ workspaceId: WS, crossWorkspace: false }),
}))
vi.mock('@/lib/knowledge/entity-fences', async (orig) => ({
  ...(await orig<typeof import('@/lib/knowledge/entity-fences')>()),
  visiblePrivateKindIds: h.privateKinds,
}))

const WS = '00000000-0000-4000-8000-0000000000a1'
const OWNER = '00000000-0000-4000-8000-0000000000b1'
const GRANTED_CONTACT = '00000000-0000-4000-8000-0000000000c1'
const CAMPAIGN = '00000000-0000-4000-8000-0000000000e1'
const DECISION = '00000000-0000-4000-8000-0000000000f1'

const { createCampaignTools } = await import('@/lib/ai/tools/campaigns')
const { matchAudience } = await import('@/lib/campaigns/audience')
const { resolveContactIdByName } = await import('@/lib/people/name-match')
const { resolveSuggestionTarget } = await import('@/lib/suggestions/target')
const { entityInWorkspace } = await import('@/lib/ai/tools/claims')
const { customFieldWriteRefusal } = await import('@/lib/crm/custom-field-access')

let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = []

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

function db(tableRows: Record<string, unknown[]> = {}): SupabaseClient {
  return {
    from: (table: string) => fakeFrom(tableRows[table] ?? []),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args })
      if (fn === 'contact_visible_to') return { data: args.p_grants !== false, error: null }
      return { data: false, error: null }
    },
  } as unknown as SupabaseClient
}

const contactCalls = () => rpcCalls.filter((c) => c.fn === 'contact_visible_to')

type Exec = { execute: (input: Record<string, unknown>, opts: unknown) => Promise<Record<string, unknown>> }
const run = (tools: Record<string, unknown>, name: string, input: Record<string, unknown>) =>
  (tools[name] as Exec).execute(input, { toolCallId: 't', messages: [] })

beforeEach(() => {
  rpcCalls = []
  h.prepare.mockReset().mockResolvedValue({ ok: false, code: 'NO_AUDIENCE', error: 'none' })
  h.execute.mockReset().mockResolvedValue({ ok: false, code: 'CAMPAIGN_CHANGED', error: 'changed' })
  h.privateKinds.mockReset().mockResolvedValue(new Set([DECISION]))
})

describe('a campaign launch', () => {
  it('matchAudience asks each contact without grants only when told grants: false', async () => {
    const rows = { contact: [{ id: GRANTED_CONTACT, full_name: 'Ana Ortiz', email: 'ana@example.com' }] }
    expect(await matchAudience(db(rows), { workspaceId: WS, userId: OWNER, audience: {} as never })).toHaveLength(1)
    expect(await matchAudience(db(rows), { workspaceId: WS, userId: OWNER, audience: {} as never, grants: false })).toHaveLength(0)
    expect(contactCalls().map((c) => c.args.p_grants)).toEqual([undefined, false])
  })

  it('launch_campaign prepares without grants on a guest turn, with them on the owner turn', async () => {
    await run(createCampaignTools(db(), WS, OWNER), 'launch_campaign', { campaign_id: CAMPAIGN })
    await run(createCampaignTools(db(), WS, OWNER, false, 'session', { omitGrants: true }), 'launch_campaign', { campaign_id: CAMPAIGN })
    expect(h.prepare.mock.calls[0][1]).not.toHaveProperty('grants')
    expect(h.prepare.mock.calls[1][1]).toMatchObject({ grants: false })
  })

  it("the approved card's replay (omitGrants from storedToolOptions) launches without grants too", async () => {
    const approvedCall = { approvalId: 'a-1' } as never
    await run(createCampaignTools(db(), WS, OWNER, false, 'session', { approvedCall }), 'launch_campaign', { campaign_id: CAMPAIGN })
    await run(createCampaignTools(db(), WS, OWNER, false, 'session', { approvedCall, omitGrants: true }), 'launch_campaign', { campaign_id: CAMPAIGN })
    expect(h.execute.mock.calls[0][1]).not.toHaveProperty('grants')
    expect(h.execute.mock.calls[1][1]).toMatchObject({ grants: false })
  })
})

describe('a suggestion naming a contact', () => {
  it('resolveContactIdByName resolves a granted contact for the owner, not without grants', async () => {
    const rows = { contact: [{ id: GRANTED_CONTACT, full_name: 'Ana Ortiz' }] }
    expect(await resolveContactIdByName(db(rows), WS, 'Ana', OWNER)).toBe(GRANTED_CONTACT)
    expect(await resolveContactIdByName(db(rows), WS, 'Ana', OWNER, { grants: false })).toBeNull()
  })

  it('resolveSuggestionTarget fences a contact given by id, and without grants a granted one is not found', async () => {
    const rows = { contact: [{ id: GRANTED_CONTACT, workspace_id: WS, full_name: 'Ana Ortiz' }] }
    const args = { entity: 'contact' as const, target: GRANTED_CONTACT, summary: 's', workspaceIds: [WS], preferredWorkspaceId: WS, userId: OWNER }
    expect(await resolveSuggestionTarget(db(rows), args)).toMatchObject({ ok: true, entityId: GRANTED_CONTACT })
    expect(await resolveSuggestionTarget(db(rows), { ...args, grants: false })).toMatchObject({ ok: false, refusal: 'target_not_found' })
  })
})

describe("link_entities' id check", () => {
  it('entityInWorkspace hands the private-kind fence the grant switch', async () => {
    await entityInWorkspace(db(), WS, 'decision', DECISION, OWNER)
    await entityInWorkspace(db(), WS, 'decision', DECISION, OWNER, { grants: false })
    expect(h.privateKinds.mock.calls[0][5]).toEqual({})
    expect(h.privateKinds.mock.calls[1][5]).toEqual({ grants: false })
  })
})

describe('the custom-field gate on a view-granted contact', () => {
  it('an owner turn without edit grants (unattended) still says forbidden; only a guest turn says not found', async () => {
    // contact_editable_by and entity_edit_granted say no (db() answers false); the view grant shows it.
    const unattended = await customFieldWriteRefusal(db(), OWNER, WS, 'contact', GRANTED_CONTACT, { grants: false })
    expect(unattended?.reason).toBe('forbidden')
    const guest = await customFieldWriteRefusal(db(), OWNER, WS, 'contact', GRANTED_CONTACT, { grants: false, readGrants: false })
    expect(guest?.reason).toBe('not_found')
  })
})
