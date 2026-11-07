/**
 * traverse and get_context_bundle resolve graph-neighbor LABELS. They may run
 * on a SERVICE-ROLE client (eve chat / live-agent tool routes), where the
 * contact table's RLS (mig 058) does not hide another member's private
 * contact, and claim_neighborhood joins contact.full_name with no contact
 * check. So a contact node the caller cannot see keeps its id and relation but
 * its label is PRIVATE_CONTACT_LABEL — never the name — fenced through
 * contact_visible_to(contact, userId), failing closed.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createClaimTools, PRIVATE_CONTACT_LABEL } from '../claims'

vi.mock('@/lib/ai/embeddings', () => ({ embed: vi.fn(async () => [0.1]) }))
vi.mock('@/lib/ai/claim-provenance', () => ({ attachClaimProvenance: vi.fn(async () => ({ errors: [] })) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => {}) } }))

const USER = 'user-1'
const WS = 'ws-1'
const EXEC = { toolCallId: 't', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

type Row = Record<string, unknown>

function db(opts: {
  tables: Record<string, Row[]>
  visibility: Record<string, boolean | 'error'>
  bundle?: unknown
}) {
  const rpcUsers: string[] = []
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
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    if (fn === 'claim_neighborhood') return { data: opts.bundle ?? null, error: null }
    if (fn !== 'contact_visible_to') return { data: null, error: { message: `unexpected rpc ${fn}` } }
    rpcUsers.push(args.p_user_id as string)
    const v = opts.visibility[args.p_contact_id as string] ?? true
    return v === 'error' ? { data: null, error: { message: 'rpc down' } } : { data: v, error: null }
  })
  return { client: { from, rpc } as never, rpcUsers }
}

const EDGES: Row[] = [
  { workspace_id: WS, source_type: 'project', source_id: 'prj-1', target_type: 'contact', target_id: 'ct-private', relation: 'related_to' },
  { workspace_id: WS, source_type: 'project', source_id: 'prj-1', target_type: 'contact', target_id: 'ct-shared', relation: 'related_to' },
  { workspace_id: WS, source_type: 'project', source_id: 'prj-1', target_type: 'project', target_id: 'prj-2', relation: 'depends_on' },
]
const TABLES = {
  entity_link: EDGES,
  contact: [
    { id: 'ct-private', workspace_id: WS, full_name: 'Ana Private' },
    { id: 'ct-shared', workspace_id: WS, full_name: 'Sam Shared' },
  ],
  projects: [{ id: 'prj-2', workspace_id: WS, name: 'Launch' }],
}

describe('traverse — contact neighbor labels are fenced (service role: contact_visible_to)', () => {
  it("a hidden contact keeps its id but never its name; visible ones and other types resolve", async () => {
    const { client, rpcUsers } = db({ tables: TABLES, visibility: { 'ct-private': false } })
    const res = (await createClaimTools(USER, client, WS).traverse.execute!(
      { entity_type: 'project', entity_id: 'prj-1', direction: 'outbound' } as never,
      EXEC,
    )) as { success: boolean; outbound: Array<{ target_id: string; label: string | null }> }

    expect(res.success).toBe(true)
    expect(res.outbound.map((e) => [e.target_id, e.label])).toEqual([
      ['ct-private', PRIVATE_CONTACT_LABEL],
      ['ct-shared', 'Sam Shared'],
      ['prj-2', 'Launch'],
    ])
    expect(JSON.stringify(res)).not.toContain('Ana Private')
    // Fenced against the tool's (verified) user.
    expect(new Set(rpcUsers)).toEqual(new Set([USER]))
  })

  it('fails CLOSED: an RPC error reads as hidden', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client } = db({ tables: TABLES, visibility: { 'ct-private': 'error', 'ct-shared': 'error' } })
    const res = (await createClaimTools(USER, client, WS).traverse.execute!(
      { entity_type: 'project', entity_id: 'prj-1', direction: 'outbound' } as never,
      EXEC,
    )) as { outbound: Array<{ label: string | null }> }
    expect(res.outbound.map((e) => e.label)).toEqual([PRIVATE_CONTACT_LABEL, PRIVATE_CONTACT_LABEL, 'Launch'])
  })

  it('issues no visibility RPC when no contact is among the neighbors', async () => {
    const { client, rpcUsers } = db({ tables: { ...TABLES, entity_link: [EDGES[2]] }, visibility: {} })
    await createClaimTools(USER, client, WS).traverse.execute!(
      { entity_type: 'project', entity_id: 'prj-1', direction: 'outbound' } as never,
      EXEC,
    )
    expect(rpcUsers).toEqual([])
  })
})

describe('get_context_bundle — claim_neighborhood contact labels are fenced', () => {
  const bundle = {
    center: { type: 'project', id: 'prj-1' },
    depth: 1,
    nodes: [
      { node_type: 'project', node_id: 'prj-1', label: 'Pricing' },
      { node_type: 'contact', node_id: 'ct-private', label: 'Ana Private' },
      { node_type: 'contact', node_id: 'ct-shared', label: 'Sam Shared' },
    ],
    edges: [],
  }

  it("a hidden contact node keeps its id but never its name", async () => {
    const { client, rpcUsers } = db({ tables: {}, visibility: { 'ct-private': false }, bundle })
    const res = (await createClaimTools(USER, client, WS).get_context_bundle.execute!(
      { entity_type: 'project', entity_id: 'prj-1' } as never,
      EXEC,
    )) as { success: boolean; nodes: Array<{ node_id: string; label: string }> }

    expect(res.success).toBe(true)
    expect(res.nodes.map((n) => [n.node_id, n.label])).toEqual([
      ['prj-1', 'Pricing'],
      ['ct-private', PRIVATE_CONTACT_LABEL],
      ['ct-shared', 'Sam Shared'],
    ])
    expect(JSON.stringify(res)).not.toContain('Ana Private')
    expect(new Set(rpcUsers)).toEqual(new Set([USER]))
  })
})
