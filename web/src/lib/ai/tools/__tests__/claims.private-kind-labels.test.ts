/**
 * traverse and get_context_bundle walk the graph on what may be a
 * SERVICE-ROLE client. A private graph kind's row
 * (src/lib/knowledge/entity-fences.ts) the caller can't read is left out
 * altogether, id and words, and a hidden centre shows nothing around it: someone else's calendar event, a DM they're not in, a team channel's
 * message, a decision from another member's private capture. Fixtures are
 * made up.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createClaimTools, dropHiddenFromBundle } from '../claims'
import { PRIVATE_KIND_LABEL } from '@/lib/knowledge/entity-fences'

vi.mock('@/lib/ai/embeddings', () => ({ embed: vi.fn(async () => [0.1]) }))
vi.mock('@/lib/ai/claim-provenance', () => ({ attachClaimProvenance: vi.fn(async () => ({ errors: [] })) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => {}) } }))

const ANA = 'user-ana'
const BEN = 'user-ben'
const WS = 'ws-1'
const EXEC = { toolCallId: 't', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

type Row = Record<string, unknown>

function db(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    const preds: Array<(r: Row) => boolean> = []
    const c: Record<string, unknown> = {}
    for (const m of ['select', 'limit', 'order', 'overrideTypes', 'neq', 'or']) c[m] = () => c
    c.eq = (col: string, v: unknown) => {
      preds.push((r) => r[col] === v)
      return c
    }
    c.in = (col: string, vs: unknown[]) => {
      preds.push((r) => vs.includes(r[col]))
      return c
    }
    c.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: (tables[table] ?? []).filter((r) => preds.every((p) => p(r))), error: null }).then(resolve)
    return c
  }
  return { from, rpc: vi.fn(async () => ({ data: null, error: null })) } as never
}

const edge = (target_type: string, target_id: string): Row => ({
  workspace_id: WS,
  source_type: 'project',
  source_id: 'prj-1',
  target_type,
  target_id,
  relation: 'mentions',
})

const TABLES: Record<string, Row[]> = {
  entity_link: [
    edge('calendar_event', 'ev-ben'),
    edge('calendar_event', 'ev-ana'),
    edge('team_chat_message', 'msg-dm'),
    edge('team_chat_channel', 'ch-dm'),
    edge('decision', 'dec-private'),
  ],
  member: [
    { id: 'm-ana', user_id: ANA, workspace_id: WS },
    { id: 'm-ben', user_id: BEN, workspace_id: WS },
  ],
  local_calendar_event: [
    { id: 'ev-ben', user_id: BEN, workspace_id: WS, title: 'Ben dentist' },
    { id: 'ev-ana', user_id: ANA, workspace_id: WS, title: 'Fernhill sync' },
  ],
  team_chat_channel: [{ id: 'ch-dm', workspace_id: WS, team_id: null, kind: 'dm', name: null }],
  team_chat_member: [{ channel_id: 'ch-dm', member_id: 'm-ben' }],
  team_chat_message: [{ id: 'msg-dm', channel_id: 'ch-dm', workspace_id: WS, body: 'Ben only secret' }],
  team_member: [],
  captures: [{ id: 'cap-ben', workspace_id: WS, visibility: 'private', user_id: BEN, is_eval: false }],
  decision: [{ id: 'dec-private', capture_id: 'cap-ben', confirmation: 'suggested', content: 'Raise prices quietly' }],
}

async function labels(userId: string, omitPrivate = false) {
  const res = (await createClaimTools(userId, db(TABLES), WS, false, omitPrivate).traverse.execute!(
    { entity_type: 'project', entity_id: 'prj-1', direction: 'outbound' } as never,
    EXEC,
  )) as { success: boolean; outbound: Array<{ target_id: string; label: string | null }> }
  expect(res.success).toBe(true)
  return { map: Object.fromEntries(res.outbound.map((e) => [e.target_id, e.label])), raw: JSON.stringify(res) }
}

describe('traverse — private graph kinds stay with those who can read them', () => {
  it('shows Ana her own event and leaves out what she cannot read (not even its id)', async () => {
    const { map, raw } = await labels(ANA)
    expect(map).toEqual({ 'ev-ana': 'Fernhill sync' })
    for (const hidden of ['ev-ben', 'msg-dm', 'ch-dm', 'dec-private']) expect(raw).not.toContain(hidden)
    for (const secret of ['Ben dentist', 'Ben only secret', 'Raise prices quietly']) expect(raw).not.toContain(secret)
    // No placeholder either: a hidden private row is left out, as another person's chat is.
    expect(raw).not.toContain(PRIVATE_KIND_LABEL.calendar_event)
  })

  it('shows Ben what is his', async () => {
    const { map } = await labels(BEN)
    expect(map['ev-ben']).toBe('Ben dentist')
    expect(map['msg-dm']).toBe('Ben only secret')
    expect(map['dec-private']).toBe('Raise prices quietly')
    expect(map).not.toHaveProperty('ev-ana')
  })

  it('an unattended run (omitPrivate) reads none of them, even its own person’s', async () => {
    const { map, raw } = await labels(BEN, true)
    expect(map).toEqual({})
    expect(raw).not.toContain('Ben dentist')
    expect(raw).not.toContain('ev-ben')
  })

  it('a private centre the caller cannot read has no neighbours', async () => {
    const tables = { ...TABLES, entity_link: [{ ...edge('contact', 'con-1'), source_type: 'calendar_event', source_id: 'ev-ben' }] }
    const walk = (userId: string) =>
      createClaimTools(userId, db(tables), WS).traverse.execute!(
        { entity_type: 'calendar_event', entity_id: 'ev-ben', direction: 'both' } as never,
        EXEC,
      ) as Promise<{ success: boolean; outbound?: unknown[]; inbound?: unknown[] }>
    expect(await walk(ANA)).toEqual({ success: true, outbound: [], inbound: [] })
    expect((await walk(BEN)).outbound).toHaveLength(1)
  })
})

describe('dropHiddenFromBundle — get_context_bundle leaves out private rows the caller cannot read', () => {
  const bundle = (center: { type: string; id: string }) => ({
    center,
    nodes: [
      { node_type: 'project', node_id: 'prj-1' },
      { node_type: 'calendar_event', node_id: 'ev-ben' },
      { node_type: 'calendar_event', node_id: 'ev-ana' },
      { node_type: 'team_chat_message', node_id: 'msg-dm' },
      { node_type: 'decision', node_id: 'dec-private' },
    ],
    edges: [
      { source_type: 'project', source_id: 'prj-1', target_type: 'calendar_event', target_id: 'ev-ben' },
      { source_type: 'project', source_id: 'prj-1', target_type: 'calendar_event', target_id: 'ev-ana' },
      { source_type: 'team_chat_message', source_id: 'msg-dm', target_type: 'project', target_id: 'prj-1' },
    ],
  })
  const ids = (out: { nodes: unknown[] } | null) => (out!.nodes as Array<{ node_id: string }>).map((n) => n.node_id)

  it('drops the nodes and the edges touching them', async () => {
    const ana = await dropHiddenFromBundle(db(TABLES), bundle({ type: 'project', id: 'prj-1' }), ANA)
    expect(ids(ana)).toEqual(['prj-1', 'ev-ana'])
    expect(ana!.edges).toHaveLength(1)
    const ben = await dropHiddenFromBundle(db(TABLES), bundle({ type: 'project', id: 'prj-1' }), BEN)
    expect(ids(ben)).toEqual(['prj-1', 'ev-ben', 'msg-dm', 'dec-private'])
    expect(ben!.edges).toHaveLength(2)
  })

  it('a hidden private centre leaves an empty bundle; no requester hides them all', async () => {
    expect(await dropHiddenFromBundle(db(TABLES), bundle({ type: 'team_chat_message', id: 'msg-dm' }), ANA)).toEqual({ nodes: [], edges: [] })
    expect(ids(await dropHiddenFromBundle(db(TABLES), bundle({ type: 'project', id: 'prj-1' }), null))).toEqual(['prj-1'])
  })
})
