/**
 * Dial8 doesn't learn from mail (2026-10-15, migration 341): the agent's
 * knowledge tools never return a claim learned from mail, never show an email
 * as a graph neighbour or label, and never take mail as a source.
 *
 * The database here is a pre-341 one on purpose: claim_visible_to still says
 * TRUE for an email-sourced claim and claim_neighborhood / match_claims /
 * hybrid_search still return them. The tools must hide them on their own,
 * because they may run service-role (RLS bypassed) and before 341 is applied.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createClaimTools } from '../claims'
import { dropMailFromResults } from '../search'
import { SOURCE_TYPES } from '@/lib/knowledge/entity-registry'

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

/** One claim from a meeting, one from mail, one from both. */
function fixture() {
  return {
    claim: [claim('from-meeting'), claim('from-mail'), claim('mail-and-meeting')],
    claim_source: [
      { claim_id: 'from-meeting', workspace_id: WS, source_type: 'document', source_id: 'doc-1', source_uri: null, excerpt: 'doc words' },
      { claim_id: 'from-mail', workspace_id: WS, source_type: 'email', source_id: 'msg-1', source_uri: null, excerpt: 'private mail words' },
      { claim_id: 'mail-and-meeting', workspace_id: WS, source_type: 'document', source_id: 'doc-1', source_uri: null, excerpt: 'doc words' },
      { claim_id: 'mail-and-meeting', workspace_id: WS, source_type: 'email', source_id: 'msg-2', source_uri: null, excerpt: 'more mail' },
    ],
    entity_link: [] as Row[],
    email_message: [{ id: 'msg-1', workspace_id: WS, subject: 'Their private subject' }],
    document: [{ id: 'doc-1', workspace_id: WS, title: 'Spec' }],
  }
}

const exec = async (tool: { execute?: unknown }, input: Record<string, unknown>) =>
  (await (tool.execute as (i: unknown, o: unknown) => Promise<unknown>)(input, EXEC_OPTS)) as Record<string, unknown>

describe('mail is never a source', () => {
  it('ingest_source refuses email', () => {
    const { client } = makeDb({})
    const tool = createClaimTools(USER_ID, client, WS).ingest_source
    const schema = tool.inputSchema as unknown as { safeParse: (v: unknown) => { success: boolean } }
    expect(schema.safeParse({ source_type: 'email', source_id: 'msg-1' }).success).toBe(false)
    expect(schema.safeParse({ source_type: 'document', source_id: 'doc-1' }).success).toBe(true)
  })

  it('create_claim cannot cite an email', () => {
    expect((SOURCE_TYPES as readonly string[]).includes('email')).toBe(false)
  })
})

describe('the knowledge tools never return a claim learned from mail', () => {
  it('list_claims', async () => {
    const { client } = makeDb(fixture())
    const res = await exec(createClaimTools(USER_ID, client, WS).list_claims, {})
    expect((res.claims as Row[]).map((c) => c.id)).toEqual(['from-meeting'])
  })

  it('list_claims with provenance never carries a mail excerpt', async () => {
    const { client } = makeDb(fixture())
    const res = await exec(createClaimTools(USER_ID, client, WS).list_claims, { include_provenance: true })
    expect(JSON.stringify(res)).not.toContain('mail words')
  })

  it('get_claim: not found, even when a pre-341 claim_visible_to says visible', async () => {
    const { client } = makeDb(fixture(), { claim_visible_to: true })
    const tools = createClaimTools(USER_ID, client, WS)
    for (const id of ['from-mail', 'mail-and-meeting']) {
      const res = await exec(tools.get_claim, { claim_id: id })
      expect(res).toEqual({ success: false, error: 'Claim not found' })
    }
    const ok = await exec(tools.get_claim, { claim_id: 'from-meeting' })
    expect(ok.success).toBe(true)
  })

  it('search_claims drops mail-sourced matches', async () => {
    const { client } = makeDb(fixture(), {
      match_claims: [
        { claim_id: 'from-meeting', claim_text: 'a', similarity: 0.9 },
        { claim_id: 'from-mail', claim_text: 'b', similarity: 0.95 },
      ],
    })
    const res = await exec(createClaimTools(USER_ID, client, WS).search_claims, { query: 'pricing' })
    expect((res.matches as Row[]).map((m) => m.claim_id)).toEqual(['from-meeting'])
  })

  it('traverse: no email neighbours, no mail claims, no email labels', async () => {
    const db = fixture()
    db.entity_link = [
      { workspace_id: WS, source_type: 'claim', source_id: 'from-mail', target_type: 'contact', target_id: 'ct-1', relation: 'about' },
      { workspace_id: WS, source_type: 'claim', source_id: 'from-meeting', target_type: 'contact', target_id: 'ct-1', relation: 'about' },
      { workspace_id: WS, source_type: 'email', source_id: 'msg-1', target_type: 'contact', target_id: 'ct-1', relation: 'mentions' },
    ]
    const { client, queried } = makeDb(db)
    const tools = createClaimTools(USER_ID, client, WS)
    const res = await exec(tools.traverse, { entity_type: 'contact', entity_id: 'ct-1', direction: 'inbound' })
    expect((res.inbound as Row[]).map((e) => `${e.source_type}:${e.source_id}`)).toEqual(['claim:from-meeting'])
    expect(queried).not.toContain('email_message')

    // An email centre shows nothing, and a mail claim centre has no neighbours.
    expect(await exec(tools.traverse, { entity_type: 'email', entity_id: 'msg-1' })).toEqual({ success: true, outbound: [], inbound: [] })
    expect(await exec(tools.traverse, { entity_type: 'claim', entity_id: 'from-mail' })).toEqual({ success: true, outbound: [], inbound: [] })
  })

  it('get_context_bundle drops email nodes, mail claims and their edges from an old RPC', async () => {
    const { client } = makeDb(fixture(), {
      claim_neighborhood: {
        center: { type: 'contact', id: 'ct-1' },
        depth: 2,
        nodes: [
          { node_type: 'contact', node_id: 'ct-1', label: null },
          { node_type: 'claim', node_id: 'from-meeting', label: 'ok' },
          { node_type: 'claim', node_id: 'from-mail', label: 'private mail words' },
          { node_type: 'email', node_id: 'msg-1', label: 'Their private subject' },
        ],
        edges: [
          { source_type: 'claim', source_id: 'from-meeting', target_type: 'contact', target_id: 'ct-1', relation: 'about' },
          { source_type: 'claim', source_id: 'from-mail', target_type: 'contact', target_id: 'ct-1', relation: 'about' },
          { source_type: 'claim', source_id: 'from-meeting', target_type: 'email', target_id: 'msg-1', relation: 'cites' },
        ],
      },
    })
    const res = await exec(createClaimTools(USER_ID, client, WS).get_context_bundle, { entity_type: 'contact', entity_id: 'ct-1' })
    expect(JSON.stringify(res)).not.toMatch(/private|msg-1|from-mail/)
    expect((res.nodes as Row[]).map((n) => n.node_id)).toEqual(['ct-1', 'from-meeting'])
    expect(res.edge_count).toBe(1)
  })

  it('search results (find / search) drop mail claims and mail-provenance rows', async () => {
    const { client } = makeDb(fixture())
    const rows = [
      { result_type: 'claim', result_id: 'from-meeting', source_type: 'document' },
      { result_type: 'claim', result_id: 'mail-and-meeting', source_type: 'document' },
      { result_type: 'claim', result_id: 'from-mail', source_type: 'email' },
      { result_type: 'capture', result_id: 'cap-1', source_type: 'capture' },
    ]
    const shown = await dropMailFromResults(client, rows)
    expect(shown?.map((r) => r.result_id)).toEqual(['from-meeting', 'cap-1'])
  })
})

describe("the knowledge tools never return a claim taken only from someone else's private capture (341)", () => {
  /** Claims by source: a shared meeting, their private 1:1, my private notes, their private 1:1 plus a document. */
  function privateFixture() {
    return {
      claim: [claim('shared'), claim('their-private'), claim('my-private'), claim('private-plus-doc')],
      claim_source: [
        { claim_id: 'shared', source_type: 'capture', source_id: 'cap-shared', source_uri: null, excerpt: 'shared words' },
        { claim_id: 'their-private', source_type: 'capture', source_id: 'cap-theirs', source_uri: null, excerpt: 'their private words' },
        { claim_id: 'my-private', source_type: 'capture', source_id: 'cap-mine', source_uri: null, excerpt: 'my words' },
        { claim_id: 'private-plus-doc', source_type: 'capture', source_id: 'cap-theirs', source_uri: null, excerpt: null },
        { claim_id: 'private-plus-doc', source_type: 'document', source_id: 'doc-1', source_uri: null, excerpt: 'doc words' },
      ],
      captures: [
        { id: 'cap-shared', workspace_id: WS, visibility: 'workspace', user_id: 'them', is_eval: false, title: 'Standup' },
        { id: 'cap-theirs', workspace_id: WS, visibility: 'private', user_id: 'them', is_eval: false, title: 'Their 1:1' },
        { id: 'cap-mine', workspace_id: WS, visibility: 'private', user_id: USER_ID, is_eval: false, title: 'My notes' },
      ],
      // The cited document, workspace-visible (migration 369).
      document: [{ id: 'doc-1', workspace_id: WS, title: 'Spec', visibility: 'workspace' }],
      entity_link: [] as Row[],
    }
  }

  it("list_claims: the reader sees their own private claims, never another person's", async () => {
    const { client } = makeDb(privateFixture())
    const res = await exec(createClaimTools(USER_ID, client, WS).list_claims, {})
    expect((res.claims as Row[]).map((c) => c.id).sort()).toEqual(['my-private', 'private-plus-doc', 'shared'])
  })

  it('list_claims under omitPrivateCaptures: no private claim at all', async () => {
    const { client } = makeDb(privateFixture())
    const res = await exec(createClaimTools(USER_ID, client, WS, false, true).list_claims, {})
    expect((res.claims as Row[]).map((c) => c.id).sort()).toEqual(['private-plus-doc', 'shared'])
  })

  it('traverse: a hidden claim is no neighbour, and a hidden centre has none', async () => {
    const db = privateFixture()
    db.entity_link = ['shared', 'their-private', 'my-private'].map((id) => ({
      workspace_id: WS, source_type: 'claim', source_id: id, target_type: 'project', target_id: 'p-1', relation: 'about',
    }))
    const { client } = makeDb(db)
    const tools = createClaimTools(USER_ID, client, WS)
    const res = await exec(tools.traverse, { entity_type: 'project', entity_id: 'p-1', direction: 'inbound' })
    expect((res.inbound as Row[]).map((e) => e.source_id).sort()).toEqual(['my-private', 'shared'])
    expect(await exec(tools.traverse, { entity_type: 'claim', entity_id: 'their-private' })).toEqual({ success: true, outbound: [], inbound: [] })
  })

  it('get_context_bundle drops a hidden claim even when an old RPC returns it', async () => {
    const { client } = makeDb(privateFixture(), {
      claim_neighborhood: {
        center: { type: 'project', id: 'p-1' },
        depth: 2,
        nodes: [
          { node_type: 'project', node_id: 'p-1', label: 'P' },
          { node_type: 'claim', node_id: 'shared', label: 'ok' },
          { node_type: 'claim', node_id: 'their-private', label: 'their private words' },
        ],
        edges: [
          { source_type: 'claim', source_id: 'shared', target_type: 'project', target_id: 'p-1', relation: 'about' },
          { source_type: 'claim', source_id: 'their-private', target_type: 'project', target_id: 'p-1', relation: 'about' },
        ],
      },
    })
    const res = await exec(createClaimTools(USER_ID, client, WS).get_context_bundle, { entity_type: 'project', entity_id: 'p-1' })
    expect((res.nodes as Row[]).map((n) => n.node_id)).toEqual(['p-1', 'shared'])
    expect(res.edge_count).toBe(1)
  })
})
