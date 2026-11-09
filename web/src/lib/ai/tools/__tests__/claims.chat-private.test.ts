/**
 * What Native Intelligence learns from a person's chat is theirs (Liam, 2026-10-17;
 * migration 353): the agent's knowledge tools show a claim known only from
 * someone else's chat to no one but them, and never show another person's
 * chat as evidence, a neighbour or a label, even on a claim that is shared
 * because a meeting said it too. Their own chat claims stay theirs to use.
 *
 * The database here is a pre-353 one on purpose: claim_visible_to still says
 * TRUE for a conversation-sourced claim. The tools must hide them on their
 * own, because they may run service-role (RLS bypassed) and before 353 is
 * applied.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createClaimTools } from '../claims'

vi.mock('@/lib/ai/embeddings', () => ({ embed: vi.fn(async () => [0.1, 0.2, 0.3]) }))
vi.mock('@/lib/ai/claim-provenance', () => ({ attachClaimProvenance: vi.fn(async () => ({ errors: [] })) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => {}) } }))

const USER_ID = 'user-1'
const WS = 'ws-1'
const EXEC_OPTS = { toolCallId: 'c1', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

type Row = Record<string, unknown>

/** A small filter-aware Supabase double over in-memory tables. */
function makeDb(tables: Record<string, Row[]>, rpcs: Record<string, unknown> = {}) {
  const queried: string[] = []
  const from = vi.fn((table: string) => {
    queried.push(table)
    const preds: Array<(r: Row) => boolean> = []
    let limitN = Infinity
    let range: [number, number] | null = null
    const rows = () => {
      let out = (tables[table] ?? []).filter((r) => preds.every((p) => p(r)))
      if (range) out = out.slice(range[0], range[1] + 1)
      return out.slice(0, limitN)
    }
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (k: string, v: unknown) => (preds.push((r) => r[k] === v), api),
      neq: (k: string, v: unknown) => (preds.push((r) => r[k] !== v), api),
      in: (k: string, vs: unknown[]) => (preds.push((r) => vs.includes(r[k])), api),
      or: () => api,
      order: () => api,
      gte: () => api,
      lte: () => api,
      textSearch: () => api,
      limit: (n: number) => ((limitN = n), api),
      range: (a: number, b: number) => ((range = [a, b]), api),
      maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: rows()[0] ?? null, error: rows()[0] ? null : { message: 'not found' } }),
      overrideTypes: () => api,
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve),
    }
    return api
  })
  const rpc = vi.fn(async (name: string) => ({ data: rpcs[name] ?? null, error: null }))
  return { client: { from, rpc } as never, queried }
}

const claim = (id: string): Row => ({
  id,
  workspace_id: WS,
  text: `text of ${id}`,
  type: 'fact',
  confidence: 0.9,
  confirmation: 'confirmed',
  status: 'active',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
})

/** My chat's claim, their chat's claim, and a claim their chat and a document share. */
function fixture() {
  return {
    claim: [claim('my-chat'), claim('their-chat'), claim('shared-with-their-chat')],
    claim_source: [
      { claim_id: 'my-chat', workspace_id: WS, source_type: 'conversation', source_id: 'conv-mine', source_uri: null, excerpt: 'my own words' },
      { claim_id: 'their-chat', workspace_id: WS, source_type: 'conversation', source_id: 'conv-theirs', source_uri: null, excerpt: 'their private words' },
      { claim_id: 'shared-with-their-chat', workspace_id: WS, source_type: 'document', source_id: 'doc-1', source_uri: null, excerpt: 'doc words' },
      { claim_id: 'shared-with-their-chat', workspace_id: WS, source_type: 'conversation', source_id: 'conv-theirs', source_uri: null, excerpt: 'their private aside' },
    ],
    entity_link: [] as Row[],
    chat_conversations: [
      { id: 'conv-mine', workspace_id: WS, user_id: USER_ID, title: 'Mine' },
      { id: 'conv-theirs', workspace_id: WS, user_id: 'user-2', title: 'Their private chat' },
    ],
    document: [{ id: 'doc-1', workspace_id: WS, title: 'Spec' }],
    captures: [] as Row[],
    attachments: [] as Row[],
  }
}

const exec = async (tool: { execute?: unknown }, input: Record<string, unknown>) =>
  (await (tool.execute as (i: unknown, o: unknown) => Promise<unknown>)(input, EXEC_OPTS)) as Record<string, unknown>

describe("someone else's chat stays theirs (353)", () => {
  it('list_claims: my chat claims and the shared claim, never theirs', async () => {
    const { client } = makeDb(fixture())
    const res = await exec(createClaimTools(USER_ID, client, WS).list_claims, {})
    expect((res.claims as Row[]).map((c) => c.id).sort()).toEqual(['my-chat', 'shared-with-their-chat'])
  })

  it('list_claims with provenance never carries their chat excerpt', async () => {
    const { client } = makeDb(fixture())
    const res = await exec(createClaimTools(USER_ID, client, WS).list_claims, { include_provenance: true })
    const text = JSON.stringify(res)
    expect(text).not.toContain('their private')
    expect(text).toContain('my own words')
  })

  it('get_claim: their chat claim is not found; the shared one shows without their chat', async () => {
    const { client } = makeDb(fixture(), { claim_visible_to: true })
    const tools = createClaimTools(USER_ID, client, WS)
    expect(await exec(tools.get_claim, { claim_id: 'their-chat' })).toEqual({ success: false, error: 'Claim not found' })
    const shared = await exec(tools.get_claim, { claim_id: 'shared-with-their-chat' })
    expect(shared.success).toBe(true)
    expect((shared.sources as Row[]).map((s) => s.source_type)).toEqual(['document'])
    expect(JSON.stringify(shared)).not.toMatch(/their private|conv-theirs/)
    const mine = await exec(tools.get_claim, { claim_id: 'my-chat' })
    expect((mine.sources as Row[]).map((s) => s.source_id)).toEqual(['conv-mine'])
  })

  it('traverse: never steps onto their chat or names it; their chat as the centre is empty', async () => {
    const db = fixture()
    db.entity_link = [
      { workspace_id: WS, source_type: 'claim', source_id: 'shared-with-their-chat', target_type: 'document', target_id: 'doc-1', relation: 'cites' },
      { workspace_id: WS, source_type: 'claim', source_id: 'shared-with-their-chat', target_type: 'conversation', target_id: 'conv-theirs', relation: 'cites' },
      { workspace_id: WS, source_type: 'claim', source_id: 'my-chat', target_type: 'conversation', target_id: 'conv-mine', relation: 'cites' },
      { workspace_id: WS, source_type: 'conversation', source_id: 'conv-theirs', target_type: 'document', target_id: 'doc-1', relation: 'mentions' },
    ]
    const { client } = makeDb(db, { claim_visible_to: true })
    const tools = createClaimTools(USER_ID, client, WS)

    const shared = await exec(tools.traverse, { entity_type: 'claim', entity_id: 'shared-with-their-chat', direction: 'outbound' })
    expect(shared.success).toBe(true)
    expect((shared.outbound as Row[]).map((e) => e.target_id)).toEqual(['doc-1'])
    expect(JSON.stringify(shared)).not.toMatch(/conv-theirs|Their private chat/)

    const mine = await exec(tools.traverse, { entity_type: 'claim', entity_id: 'my-chat', direction: 'outbound' })
    expect((mine.outbound as Row[]).map((e) => [e.target_id, e.label])).toEqual([['conv-mine', 'Mine']])

    expect(await exec(tools.traverse, { entity_type: 'conversation', entity_id: 'conv-theirs', direction: 'both' })).toEqual({ success: true, outbound: [], inbound: [] })
  })

  it('get_context_bundle drops their conversation and their chat claim from an old RPC', async () => {
    const { client } = makeDb(fixture(), {
      claim_neighborhood: {
        center: { type: 'document', id: 'doc-1' },
        depth: 2,
        nodes: [
          { node_type: 'document', node_id: 'doc-1', label: 'Spec' },
          { node_type: 'claim', node_id: 'shared-with-their-chat', label: 'ok' },
          { node_type: 'claim', node_id: 'their-chat', label: 'their private words' },
          { node_type: 'conversation', node_id: 'conv-theirs', label: 'Their private chat' },
          { node_type: 'conversation', node_id: 'conv-mine', label: 'Mine' },
        ],
        edges: [
          { source_type: 'claim', source_id: 'shared-with-their-chat', target_type: 'document', target_id: 'doc-1', relation: 'cites' },
          { source_type: 'claim', source_id: 'shared-with-their-chat', target_type: 'conversation', target_id: 'conv-theirs', relation: 'cites' },
          { source_type: 'claim', source_id: 'their-chat', target_type: 'conversation', target_id: 'conv-theirs', relation: 'cites' },
        ],
      },
    })
    const res = await exec(createClaimTools(USER_ID, client, WS).get_context_bundle, { entity_type: 'document', entity_id: 'doc-1' })
    expect(JSON.stringify(res)).not.toMatch(/their private|Their private chat|conv-theirs|"their-chat"/)
    expect((res.nodes as Row[]).map((n) => n.node_id)).toEqual(['doc-1', 'shared-with-their-chat', 'conv-mine'])
    expect(res.edge_count).toBe(1)
  })
})
