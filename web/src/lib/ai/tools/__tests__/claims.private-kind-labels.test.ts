/**
 * traverse resolves graph-neighbor LABELS on what may be a SERVICE-ROLE
 * client. The private graph kinds (src/lib/knowledge/entity-fences.ts) keep
 * their id and relation but never their words for a caller who can't read
 * them: someone else's calendar event, a DM they're not in, a team channel's
 * message, a decision from another member's private capture. Fixtures are
 * made up.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createClaimTools } from '../claims'
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

describe('traverse — private graph kinds keep their words from those who cannot read them', () => {
  it('shows Ana her own event and placeholders for the rest', async () => {
    const { map, raw } = await labels(ANA)
    expect(map['ev-ana']).toBe('Fernhill sync')
    expect(map['ev-ben']).toBe(PRIVATE_KIND_LABEL.calendar_event)
    expect(map['msg-dm']).toBe(PRIVATE_KIND_LABEL.team_chat_message)
    expect(map['ch-dm']).toBe(PRIVATE_KIND_LABEL.team_chat_channel)
    expect(map['dec-private']).toBe(PRIVATE_KIND_LABEL.decision)
    for (const secret of ['Ben dentist', 'Ben only secret', 'Raise prices quietly']) expect(raw).not.toContain(secret)
  })

  it('shows Ben what is his', async () => {
    const { map } = await labels(BEN)
    expect(map['ev-ben']).toBe('Ben dentist')
    expect(map['msg-dm']).toBe('Ben only secret')
    expect(map['dec-private']).toBe('Raise prices quietly')
    expect(map['ev-ana']).toBe(PRIVATE_KIND_LABEL.calendar_event)
  })

  it('an unattended run (omitPrivate) reads none of them, even its own person’s', async () => {
    const { map, raw } = await labels(BEN, true)
    expect(map['ev-ben']).toBe(PRIVATE_KIND_LABEL.calendar_event)
    expect(map['msg-dm']).toBe(PRIVATE_KIND_LABEL.team_chat_message)
    expect(raw).not.toContain('Ben dentist')
  })
})
