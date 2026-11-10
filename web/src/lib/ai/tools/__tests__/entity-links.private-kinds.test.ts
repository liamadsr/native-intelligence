/**
 * list_entity_links and unlink_entities may run on a SERVICE-ROLE client. A
 * private graph kind's row (src/lib/knowledge/entity-fences.ts) the person
 * can't read is never listed, not even by id, and its edges are not theirs to
 * remove: someone else's calendar event, a DM they're not in. Fixtures are
 * made up.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { memoryDb } from '@/test/memory-db'
import { createEntityLinkTools } from '../entity-links'

vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))

const WS = 'aaaaaaaa-0000-4000-8000-000000000001'
const ANA = 'uuuuuuuu-0000-4000-8000-00000000000a'
const BEN = 'uuuuuuuu-0000-4000-8000-00000000000b'
const EXEC = { toolCallId: 't', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

type Row = Record<string, unknown>

function tables(): Record<string, Row[]> {
  return {
    member: [
      { id: 'm-ana', user_id: ANA, workspace_id: WS, display_name: 'Ana Ruiz' },
      { id: 'm-ben', user_id: BEN, workspace_id: WS, display_name: 'Ben Okafor' },
    ],
    deal: [{ id: 'deal-1', workspace_id: WS, name: 'Fernhill renewal' }],
    local_calendar_event: [
      { id: 'ev-ben', user_id: BEN, workspace_id: WS, title: 'Ben dentist' },
      { id: 'ev-ana', user_id: ANA, workspace_id: WS, title: 'Fernhill sync' },
    ],
    team_chat_channel: [{ id: 'ch-dm', workspace_id: WS, team_id: null, kind: 'dm', name: null }],
    team_chat_member: [{ channel_id: 'ch-dm', member_id: 'm-ben', workspace_id: WS }],
    team_chat_message: [{ id: 'msg-dm', channel_id: 'ch-dm', workspace_id: WS, body: 'Ben only' }],
    team_member: [],
    entity_link: [
      { id: 'e1', workspace_id: WS, source_type: 'team_chat_message', source_id: 'msg-dm', target_type: 'deal', target_id: 'deal-1', relation: 'mentions', created_at: '2026-11-09T10:00:00Z' },
      { id: 'e2', workspace_id: WS, source_type: 'calendar_event', source_id: 'ev-ben', target_type: 'deal', target_id: 'deal-1', relation: 'related_to', created_at: '2026-11-09T11:00:00Z' },
      { id: 'e3', workspace_id: WS, source_type: 'calendar_event', source_id: 'ev-ana', target_type: 'deal', target_id: 'deal-1', relation: 'related_to', created_at: '2026-11-09T12:00:00Z' },
    ],
  }
}

type Listed = { success: boolean; inbound: Array<{ source_id: string }>; outbound: Array<{ target_id: string }>; total: number }

async function list(userId: string, entity: { type: string; id: string }, omitPrivate = false, t = tables()) {
  const tools = createEntityLinkTools(userId, memoryDb(t) as never, WS, false, omitPrivate)
  return (await tools.list_entity_links.execute!({ entity_type: entity.type, entity_id: entity.id, direction: 'both' } as never, EXEC)) as Listed
}

describe('list_entity_links — private graph kinds', () => {
  it('leaves out the private rows the person cannot read, ids and all', async () => {
    const ana = await list(ANA, { type: 'deal', id: 'deal-1' })
    expect(ana.inbound.map((e) => e.source_id)).toEqual(['ev-ana'])
    expect(JSON.stringify(ana)).not.toContain('msg-dm')
    expect(JSON.stringify(ana)).not.toContain('ev-ben')
    const ben = await list(BEN, { type: 'deal', id: 'deal-1' })
    expect(ben.inbound.map((e) => e.source_id).sort()).toEqual(['ev-ben', 'msg-dm'])
  })

  it('a private centre the person cannot read lists nothing', async () => {
    const ana = await list(ANA, { type: 'calendar_event', id: 'ev-ben' })
    expect(ana.outbound).toEqual([])
    expect(ana.total).toBe(0)
    expect((await list(BEN, { type: 'calendar_event', id: 'ev-ben' })).outbound).toHaveLength(1)
  })

  it('an unattended run sees none of them, even its own person’s', async () => {
    const ben = await list(BEN, { type: 'deal', id: 'deal-1' }, true)
    expect(ben.inbound).toEqual([])
  })
})

describe('unlink_entities — private graph kinds', () => {
  it('refuses to remove an edge of a private row the person cannot read', async () => {
    const t = tables()
    const ana = createEntityLinkTools(ANA, memoryDb(t) as never, WS)
    const res = (await ana.unlink_entities.execute!(
      { source_type: 'team_chat_message', source_id: 'msg-dm', target_type: 'deal', target_id: 'deal-1' } as never,
      EXEC,
    )) as { success: boolean }
    expect(res.success).toBe(false)
    expect(t.entity_link.map((e) => e.id)).toContain('e1')

    const ben = createEntityLinkTools(BEN, memoryDb(t) as never, WS)
    const ok = (await ben.unlink_entities.execute!(
      { source_type: 'team_chat_message', source_id: 'msg-dm', target_type: 'deal', target_id: 'deal-1' } as never,
      EXEC,
    )) as { success: boolean }
    expect(ok.success).toBe(true)
    expect(t.entity_link.map((e) => e.id)).not.toContain('e1')
  })
})
