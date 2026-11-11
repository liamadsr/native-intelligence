/**
 * The company twin of claims.contact-labels.test.ts. traverse and
 * get_context_bundle may run on a SERVICE-ROLE client (eve chat / live-agent
 * tool routes), where the company table's RLS (mig 059, keyed on auth.uid())
 * does not apply, and claim_neighborhood joins company.name with no check. So a
 * company the caller cannot see is fenced twice: its edges are left out, id and
 * all (migration 500: an edge follows both its ends, asked of
 * entity_refs_hidden), and a label that still reached the resolver would be
 * PRIVATE_COMPANY_LABEL — never the name — through company_visible_to
 * (company, userId). Both fail closed.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createClaimTools, PRIVATE_COMPANY_LABEL, PRIVATE_CONTACT_LABEL } from '../claims'

vi.mock('@/lib/ai/embeddings', () => ({ embed: vi.fn(async () => [0.1]) }))
vi.mock('@/lib/ai/claim-provenance', () => ({ attachClaimProvenance: vi.fn(async () => ({ errors: [] })) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => {}) } }))

const USER = 'user-1'
const WS = 'ws-1'
const EXEC = { toolCallId: 't', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

type Row = Record<string, unknown>
type Answer = boolean | 'error'

function db(opts: {
  tables: Record<string, Row[]>
  companies: Record<string, Answer>
  contacts?: Record<string, Answer>
  bundle?: unknown
}) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = []
  const from = (table: string) => {
    const preds: Array<(r: Row) => boolean> = []
    const c: Record<string, unknown> = {}
    c.select = () => c
    c.limit = () => c
    c.overrideTypes = () => c
    c.eq = (col: string, v: unknown) => {
      preds.push((r) => r[col] === v)
      return c
    }
    c.in = (col: string, vs: unknown[]) => {
      preds.push((r) => vs.includes(r[col]))
      return c
    }
    c.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: (opts.tables[table] ?? []).filter((r) => preds.every((p) => p(r))), error: null }).then(
        resolve,
      )
    return c
  }
  const answer = (v: Answer) => (v === 'error' ? { data: null, error: { message: 'rpc down' } } : { data: v, error: null })
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    if (fn === 'claim_neighborhood') return { data: opts.bundle ?? null, error: null }
    if (fn === 'entity_refs_hidden') {
      // The edge fence (migration 500), answered from the same visibility maps.
      const types = args.p_types as string[]
      const ids = args.p_ids as string[]
      const seen = types.map((t, i) => [t, ids[i], (t === 'company' ? opts.companies[ids[i]] : opts.contacts?.[ids[i]]) ?? true] as const)
      if (seen.some(([, , v]) => v === 'error')) return { data: null, error: { message: 'rpc down' } }
      return { data: seen.filter(([, , v]) => v === false).map(([t, id]) => ({ entity_type: t, entity_id: id })), error: null }
    }
    rpcCalls.push({ fn, args })
    if (fn === 'company_visible_to') return answer(opts.companies[args.p_company_id as string] ?? true)
    if (fn === 'contact_visible_to') return answer(opts.contacts?.[args.p_contact_id as string] ?? true)
    return { data: null, error: { message: `unexpected rpc ${fn}` } }
  })
  return { client: { from, rpc } as never, rpcCalls }
}

const EDGES: Row[] = [
  { workspace_id: WS, source_type: 'project', source_id: 'prj-1', target_type: 'company', target_id: 'co-private', relation: 'related_to' },
  { workspace_id: WS, source_type: 'project', source_id: 'prj-1', target_type: 'company', target_id: 'co-shared', relation: 'related_to' },
  { workspace_id: WS, source_type: 'project', source_id: 'prj-1', target_type: 'project', target_id: 'prj-2', relation: 'depends_on' },
]
const TABLES = {
  entity_link: EDGES,
  company: [
    { id: 'co-private', workspace_id: WS, name: 'Acme Secret' },
    { id: 'co-shared', workspace_id: WS, name: 'Globex' },
  ],
  projects: [{ id: 'prj-2', workspace_id: WS, name: 'Launch' }],
}

describe('traverse — company neighbor labels are fenced (service role: company_visible_to)', () => {
  it('a hidden company is left out, id and all; visible ones and other types resolve', async () => {
    const { client, rpcCalls } = db({ tables: TABLES, companies: { 'co-private': false } })
    const res = (await createClaimTools(USER, client, WS).traverse.execute!(
      { entity_type: 'project', entity_id: 'prj-1', direction: 'outbound' } as never,
      EXEC,
    )) as { success: boolean; outbound: Array<{ target_id: string; label: string | null }> }

    expect(res.success).toBe(true)
    expect(res.outbound.map((e) => [e.target_id, e.label])).toEqual([
      ['co-shared', 'Globex'],
      ['prj-2', 'Launch'],
    ])
    expect(JSON.stringify(res)).not.toContain('Acme Secret')
    expect(JSON.stringify(res)).not.toContain('co-private')
    // The label fence still asks for the company that is shown, as the tool's (verified) user.
    expect(rpcCalls).toEqual([{ fn: 'company_visible_to', args: { p_company_id: 'co-shared', p_user_id: USER } }])
  })

  it('fails CLOSED: an RPC error reads as hidden', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client } = db({ tables: TABLES, companies: { 'co-private': 'error', 'co-shared': 'error' } })
    const res = (await createClaimTools(USER, client, WS).traverse.execute!(
      { entity_type: 'project', entity_id: 'prj-1', direction: 'outbound' } as never,
      EXEC,
    )) as { outbound: Array<{ label: string | null }> }
    expect(res.outbound.map((e) => e.label)).toEqual(['Launch'])
  })

  it('issues no visibility RPC when no company is among the neighbors', async () => {
    const { client, rpcCalls } = db({ tables: { ...TABLES, entity_link: [EDGES[2]] }, companies: {} })
    await createClaimTools(USER, client, WS).traverse.execute!(
      { entity_type: 'project', entity_id: 'prj-1', direction: 'outbound' } as never,
      EXEC,
    )
    expect(rpcCalls).toEqual([])
  })
})

describe('get_context_bundle — claim_neighborhood company labels are fenced', () => {
  const bundle = {
    center: { type: 'project', id: 'prj-1' },
    depth: 1,
    nodes: [
      { node_type: 'project', node_id: 'prj-1', label: 'Pricing' },
      { node_type: 'company', node_id: 'co-private', label: 'Acme Secret' },
      { node_type: 'company', node_id: 'co-shared', label: 'Globex' },
      { node_type: 'contact', node_id: 'ct-private', label: 'Ana Private' },
    ],
    edges: [],
  }

  it('a hidden company node is left out (contacts likewise)', async () => {
    const { client, rpcCalls } = db({
      tables: {},
      companies: { 'co-private': false },
      contacts: { 'ct-private': false },
      bundle,
    })
    const res = (await createClaimTools(USER, client, WS).get_context_bundle.execute!(
      { entity_type: 'project', entity_id: 'prj-1' } as never,
      EXEC,
    )) as { success: boolean; nodes: Array<{ node_id: string; label: string }> }

    expect(res.success).toBe(true)
    expect(res.nodes.map((n) => [n.node_id, n.label])).toEqual([
      ['prj-1', 'Pricing'],
      ['co-shared', 'Globex'],
    ])
    expect(JSON.stringify(res)).not.toContain('Acme Secret')
    expect(JSON.stringify(res)).not.toContain('Ana Private')
    expect(new Set(rpcCalls.map((c) => c.args.p_user_id))).toEqual(new Set([USER]))
  })

  it('fails CLOSED on the bundle too', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client } = db({ tables: {}, companies: { 'co-private': 'error', 'co-shared': 'error' }, bundle })
    const res = (await createClaimTools(USER, client, WS).get_context_bundle.execute!(
      { entity_type: 'project', entity_id: 'prj-1' } as never,
      EXEC,
    )) as { nodes: Array<{ node_id: string; label: string }> }
    expect(res.nodes.filter((n) => n.node_id.startsWith('co-'))).toEqual([])
  })
})
