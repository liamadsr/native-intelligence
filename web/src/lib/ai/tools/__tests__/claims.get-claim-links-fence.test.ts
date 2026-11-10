/**
 * get_claim lists a claim's outbound and inbound graph links and its
 * reconciled provenance. It runs on a SERVICE-ROLE client, where RLS hides no
 * edge, so every far end of a fenced kind goes through hiddenGraphRefs
 * (migration 500's edge rule, one entity_refs_hidden call): a contact hidden
 * from the person, a private document, is left out of both lists and out of
 * the provenance, id and all, and the provenance is reconciled for the
 * requester. Fixtures are made up.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createClaimTools } from '../claims'

vi.mock('@/lib/ai/embeddings', () => ({ embed: vi.fn(async () => [0.1]) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => {}) } }))

const USER = 'user-1'
const WS = 'ws-1'
const CLAIM = 'claim-1'
const EXEC = { toolCallId: 't', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

type Row = Record<string, unknown>

const TABLES: Record<string, Row[]> = {
  member: [{ id: 'm-1', user_id: USER, workspace_id: WS }],
  claim: [{ id: CLAIM, workspace_id: WS, text: 'Renewal is due in March', type: 'fact' }],
  claim_source: [],
  entity_link: [
    { id: 'l-1', workspace_id: WS, source_type: 'claim', source_id: CLAIM, target_type: 'contact', target_id: 'ct-hidden', relation: 'about', weight: 1 },
    { id: 'l-2', workspace_id: WS, source_type: 'claim', source_id: CLAIM, target_type: 'project', target_id: 'prj-1', relation: 'about', weight: 1 },
    { id: 'l-3', workspace_id: WS, source_type: 'claim', source_id: CLAIM, target_type: 'company', target_id: 'co-open', relation: 'cites', weight: 1 },
    { id: 'l-4', workspace_id: WS, source_type: 'company', source_id: 'co-hidden', target_type: 'claim', target_id: CLAIM, relation: 'related_to', weight: 1 },
  ],
}
const HIDDEN = new Set(['contact:ct-hidden', 'company:co-hidden'])

function db(fence: 'ok' | 'error' = 'ok') {
  const fenceCalls: Array<Record<string, unknown>> = []
  const from = (table: string) => {
    const preds: Array<(r: Row) => boolean> = []
    const c: Record<string, unknown> = {}
    for (const m of ['select', 'limit', 'order', 'neq', 'is', 'overrideTypes']) c[m] = () => c
    c.eq = (col: string, v: unknown) => (preds.push((r) => r[col] === v), c)
    c.in = (col: string, vs: unknown[]) => (preds.push((r) => vs.includes(r[col])), c)
    const rows = () => (TABLES[table] ?? []).filter((r) => preds.every((p) => p(r)))
    c.single = async () => ({ data: rows()[0] ?? null, error: rows()[0] ? null : { message: 'none' } })
    c.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null })
    c.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve)
    return c
  }
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    if (fn === 'entity_refs_hidden') {
      fenceCalls.push(args)
      if (fence === 'error') return { data: null, error: { message: 'down' } }
      const types = args.p_types as string[]
      const ids = args.p_ids as string[]
      return { data: types.map((t, i) => ({ entity_type: t, entity_id: ids[i] })).filter((r) => HIDDEN.has(`${r.entity_type}:${r.entity_id}`)), error: null }
    }
    // claim_visible_to and the other visibility twins: visible.
    return { data: true, error: null }
  })
  return { client: { from, rpc } as never, fenceCalls }
}

type Res = {
  success: boolean
  outbound_links: Array<{ target_id: string }>
  inbound_links: Array<{ source_id: string }>
  provenance: Array<{ entity_id: string | null }>
}

async function getClaim(client: never, omitPrivate = false) {
  const t = createClaimTools(USER, client, WS, false, omitPrivate)
  const parsed = (t.get_claim.inputSchema as unknown as { parse: (v: unknown) => unknown }).parse({ claim_id: CLAIM })
  return (await t.get_claim.execute!(parsed as never, EXEC)) as Res
}

describe('get_claim — links follow both ends (migration 500)', () => {
  it('leaves a hidden contact and company out of both lists and the provenance, ids and all', async () => {
    const { client, fenceCalls } = db()
    const res = await getClaim(client)
    expect(res.success).toBe(true)
    expect(res.outbound_links.map((l) => l.target_id).sort()).toEqual(['co-open', 'prj-1'])
    expect(res.inbound_links).toEqual([])
    expect(res.provenance.map((p) => p.entity_id).sort()).toEqual(['co-open', 'prj-1'])
    expect(JSON.stringify(res)).not.toContain('ct-hidden')
    expect(JSON.stringify(res)).not.toContain('co-hidden')
    // Asked as the person, in the claim's workspace.
    expect(fenceCalls[0]).toMatchObject({ p_user: USER, p_workspace: WS })
  })

  it('fails closed: a failed fence hides every fenced end, open kinds stay', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await getClaim(db('error').client)
    expect(res.outbound_links.map((l) => l.target_id)).toEqual(['prj-1'])
    expect(res.inbound_links).toEqual([])
    expect(res.provenance.map((p) => p.entity_id)).toEqual(['prj-1'])
  })

  it('an unattended run asks for no one in particular', async () => {
    const { client, fenceCalls } = db()
    await getClaim(client, true)
    expect(fenceCalls.length).toBeGreaterThan(0)
    for (const call of fenceCalls) expect(call.p_user).toBeNull()
  })
})
