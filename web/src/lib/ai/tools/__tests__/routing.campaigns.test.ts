/**
 * Workspace routing for the campaign tools (src/lib/ai/tools/campaigns.ts).
 *
 * `create_campaign` is a ROOT create: with no `workspace_id` it lands in the
 * session workspace (byte-identical to before), an explicit foreign id routes
 * there after a membership check, and under policy 'explicit' with several
 * workspaces and no id it refuses with `needs_workspace` rather than guessing.
 * `update_campaign` is a converted MUTATE: a campaign_id that lives in another
 * workspace the user belongs to is edited there, never silently reported
 * not-found because the write stayed pinned to the session workspace.
 *
 * The Supabase double is a small in-memory engine (same shape as
 * actions.workspace-routing.test.ts) — eq() accumulates predicates,
 * insert/update mutate the row set, so a routing bug genuinely writes to the
 * wrong workspace here rather than being masked by a handler that always
 * succeeds.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createCampaignTools } from '../campaigns'

const USER_ID = 'user-1'
const WS_ACTIVE = 'ws-1'
const WS_OTHER = 'ws-2'
const WS_THIRD = 'ws-3'

const WORKSPACES = [
  { id: WS_ACTIVE, name: 'Dial8 Marketing' },
  { id: WS_OTHER, name: 'Engineering' },
  { id: WS_THIRD, name: 'Personal' },
]

type Row = Record<string, unknown>
type LogEntry = { table: string; op: string; col?: string; val?: unknown; payload?: unknown }

function memberRows(memberOf: string[]): Row[] {
  return memberOf.map((id) => ({
    id: `member-${id}`,
    user_id: USER_ID,
    workspace_id: id,
    workspace: WORKSPACES.find((w) => w.id === id) ?? { id, name: id },
  }))
}

/** Chainable table double: eq() accumulates predicates; insert/update mutate
 *  `rows` so a write scoped to the wrong workspace_id matches nothing. */
function tableChain(table: string, rows: Row[], log: LogEntry[]) {
  const preds: Array<(r: Row) => boolean> = []
  let mode: 'select' | 'insert' | 'update' = 'select'
  let patch: Row = {}
  let inserted: Row | null = null

  const chain: Record<string, unknown> = {}
  const pass = () => chain
  chain.select = pass
  chain.eq = (col: string, val: unknown) => {
    log.push({ table, op: 'eq', col, val })
    preds.push((r) => r[col] === val)
    return chain
  }
  chain.insert = (payload: Row) => {
    mode = 'insert'
    inserted = { id: `${table}-${rows.length + 1}`, ...payload }
    log.push({ table, op: 'insert', payload })
    return chain
  }
  chain.update = (payload: Row) => {
    mode = 'update'
    patch = payload
    log.push({ table, op: 'update', payload })
    return chain
  }

  const run = (): Row[] => {
    if (mode === 'insert' && inserted) {
      rows.push(inserted)
      return [inserted]
    }
    const matched = rows.filter((r) => preds.every((p) => p(r)))
    if (mode === 'update') {
      for (const r of matched) Object.assign(r, patch)
    }
    return matched
  }

  chain.single = async () => {
    const matched = run()
    return matched.length === 1
      ? { data: matched[0], error: null }
      : { data: null, error: { message: 'no rows returned' } }
  }
  chain.maybeSingle = async () => ({ data: run()[0] ?? null, error: null })
  chain.then = (resolve: (v: unknown) => unknown) => {
    const data = run()
    return Promise.resolve({ data, error: null }).then(resolve)
  }
  return chain
}

function makeSupabase(opts: { campaigns: Row[]; memberOf: string[] }) {
  const campaigns = opts.campaigns
  const members = memberRows(opts.memberOf)
  const log: LogEntry[] = []
  const from = (table: string) => {
    if (table === 'campaign') return tableChain('campaign', campaigns, log)
    if (table === 'member') return tableChain('member', members, log)
    return tableChain(table, [], log)
  }
  return { supabase: { from } as never, campaigns, log }
}

const run = (t: { execute?: unknown }, args: Record<string, unknown>) =>
  (t as { execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(args, {} as never)

describe('create_campaign — workspace routing', () => {
  it('(a) explicit foreign workspace_id while a member — insert carries it', async () => {
    const { supabase, campaigns } = makeSupabase({ campaigns: [], memberOf: [WS_ACTIVE, WS_OTHER] })
    const tools = createCampaignTools(supabase, WS_ACTIVE, USER_ID)
    const res = await run(tools.create_campaign, { name: 'Q3 push', workspace_id: WS_OTHER })

    expect(res).toMatchObject({ success: true, workspace: { id: WS_OTHER, name: 'Engineering' } })
    expect(campaigns).toHaveLength(1)
    expect(campaigns[0].workspace_id).toBe(WS_OTHER)
  })

  it('(b) explicit non-member workspace_id — "Workspace not found", no insert', async () => {
    const { supabase, campaigns } = makeSupabase({ campaigns: [], memberOf: [WS_ACTIVE] })
    const tools = createCampaignTools(supabase, WS_ACTIVE, USER_ID)
    const res = await run(tools.create_campaign, { name: 'Q3 push', workspace_id: WS_OTHER })

    expect(res).toEqual({ success: false, error: 'Workspace not found' })
    expect(campaigns).toHaveLength(0)
  })

  it("(c) policy 'explicit', 2+ workspaces, no id — needs_workspace, no insert", async () => {
    const { supabase, campaigns } = makeSupabase({
      campaigns: [],
      memberOf: [WS_ACTIVE, WS_OTHER, WS_THIRD],
    })
    const tools = createCampaignTools(supabase, WS_ACTIVE, USER_ID, false, 'explicit')
    const res = await run(tools.create_campaign, { name: 'Q3 push' })

    expect(res).toMatchObject({ success: false, error_type: 'needs_workspace' })
    expect(campaigns).toHaveLength(0)
  })

  it("(d) policy 'session', no id — lands in the session workspace, unchanged call chain", async () => {
    const { supabase, campaigns, log } = makeSupabase({
      campaigns: [],
      memberOf: [WS_ACTIVE, WS_OTHER, WS_THIRD],
    })
    const tools = createCampaignTools(supabase, WS_ACTIVE, USER_ID)
    const res = await run(tools.create_campaign, { name: 'Q3 push' })

    expect(res).toMatchObject({ success: true, workspace: { id: WS_ACTIVE, name: null } })
    expect(campaigns[0].workspace_id).toBe(WS_ACTIVE)
    // The session fast path must not pay a round-trip for a default it
    // already knows.
    expect(log.some((e) => e.table === 'member')).toBe(false)
  })

  it('(e) strictWorkspace + explicit foreign workspace_id — not found, no member probe', async () => {
    const { supabase, campaigns, log } = makeSupabase({
      campaigns: [],
      memberOf: [WS_ACTIVE, WS_OTHER],
    })
    const tools = createCampaignTools(supabase, WS_ACTIVE, USER_ID, true)
    const res = await run(tools.create_campaign, { name: 'Q3 push', workspace_id: WS_OTHER })

    expect(res).toEqual({ success: false, error: 'Workspace not found' })
    expect(campaigns).toHaveLength(0)
    expect(log.some((e) => e.table === 'member')).toBe(false)
  })
})

describe('update_campaign — workspace routing', () => {
  const CAMPAIGN_IN_OTHER = { id: 'camp-1', workspace_id: WS_OTHER, name: 'Old name' }

  beforeEach(() => {
    CAMPAIGN_IN_OTHER.name = 'Old name'
  })

  it('foreign-but-member campaign_id — the update is routed to its OWN workspace', async () => {
    const { supabase, campaigns } = makeSupabase({
      campaigns: [{ ...CAMPAIGN_IN_OTHER }],
      memberOf: [WS_ACTIVE, WS_OTHER],
    })
    const tools = createCampaignTools(supabase, WS_ACTIVE, USER_ID)
    const res = await run(tools.update_campaign, { campaign_id: 'camp-1', name: 'Renamed remotely' })

    expect(res).toMatchObject({ success: true })
    expect(campaigns.find((c) => c.id === 'camp-1')!.name).toBe('Renamed remotely')
  })

  it('is not-found for a campaign_id under strictWorkspace, even though the user is a member elsewhere', async () => {
    const { supabase, campaigns } = makeSupabase({
      campaigns: [{ ...CAMPAIGN_IN_OTHER }],
      memberOf: [WS_ACTIVE, WS_OTHER],
    })
    const tools = createCampaignTools(supabase, WS_ACTIVE, USER_ID, true)
    const res = await run(tools.update_campaign, { campaign_id: 'camp-1', name: 'Should not land' })

    expect(res).toEqual({ success: false, error: 'Campaign not found' })
    expect(campaigns.find((c) => c.id === 'camp-1')!.name).toBe('Old name')
  })
})
