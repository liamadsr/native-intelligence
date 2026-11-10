/**
 * The private graph kinds' fences (entity-fences.ts), and their wiring into the
 * graph's two write fences: entityInWorkspace (claims.ts) and
 * resourceIdInWorkspace (work/start-work-item.ts). Each fence restates its
 * table's read rule for an explicit user (the code may run service-role, where
 * RLS hides nothing), so each is proven here against a foreign, a private and
 * a readable row. Fixtures are made up.
 */
import { describe, expect, it, vi } from 'vitest'
import { memoryDb } from '@/test/memory-db'

vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/lib/ai/embeddings', () => ({ embed: vi.fn() }))

import { hiddenPrivateRefs, isPrivateGraphKind, visiblePrivateKindIds } from '../entity-fences'
import { entityInWorkspace } from '@/lib/ai/tools/claims'
import { resourceIdInWorkspace } from '@/lib/work/start-work-item'

const WS = 'aaaaaaaa-0000-4000-8000-000000000001'
const OTHER_WS = 'aaaaaaaa-0000-4000-8000-000000000002'
const ANA = 'uuuuuuuu-0000-4000-8000-00000000000a' // user ids
const BEN = 'uuuuuuuu-0000-4000-8000-00000000000b'
const OUTSIDER = 'uuuuuuuu-0000-4000-8000-00000000000c'
const GUS = 'uuuuuuuu-0000-4000-8000-00000000000d' // a guest member
const ANA_M = 'mmmmmmmm-0000-4000-8000-00000000000a' // member ids
const BEN_M = 'mmmmmmmm-0000-4000-8000-00000000000b'
const OUT_M = 'mmmmmmmm-0000-4000-8000-00000000000c'
const GUS_M = 'mmmmmmmm-0000-4000-8000-00000000000d'
const TEAM = 'tttttttt-0000-4000-8000-000000000001'

function db() {
  return memoryDb({
    member: [
      { id: ANA_M, user_id: ANA, workspace_id: WS, display_name: 'Ana Ruiz' },
      { id: BEN_M, user_id: BEN, workspace_id: WS, display_name: 'Ben Okafor' },
      { id: OUT_M, user_id: OUTSIDER, workspace_id: OTHER_WS, display_name: 'Cleo Park' },
      { id: GUS_M, user_id: GUS, workspace_id: WS, display_name: 'Gus Lind', role: 'guest' },
    ],
    team_member: [{ team_id: TEAM, member_id: ANA_M }],
    local_calendar_event: [
      { id: 'ev-ana', user_id: ANA, workspace_id: WS, title: 'Ana and Fernhill sync' },
      { id: 'ev-ben', user_id: BEN, workspace_id: WS, title: 'Ben dentist' },
    ],
    team_chat_channel: [
      { id: 'ch-open', workspace_id: WS, team_id: null, kind: 'channel', name: 'general' },
      { id: 'ch-team', workspace_id: WS, team_id: TEAM, kind: 'channel', name: 'design' },
      { id: 'ch-dm-ab', workspace_id: WS, team_id: null, kind: 'dm', name: null },
      { id: 'ch-foreign', workspace_id: OTHER_WS, team_id: null, kind: 'channel', name: 'elsewhere' },
      { id: 'ch-archived', workspace_id: WS, team_id: null, kind: 'channel', name: 'old', archived_at: '2026-10-01T00:00:00Z' },
      { id: 'ch-team-archived', workspace_id: WS, team_id: TEAM, kind: 'channel', name: 'old-design', archived_at: '2026-10-01T00:00:00Z' },
    ],
    team_chat_member: [
      { channel_id: 'ch-dm-ab', member_id: ANA_M, workspace_id: WS },
      { channel_id: 'ch-dm-ab', member_id: BEN_M, workspace_id: WS },
    ],
    team_chat_message: [
      { id: 'msg-open', channel_id: 'ch-open', workspace_id: WS, body: 'hello all' },
      { id: 'msg-team', channel_id: 'ch-team', workspace_id: WS, body: 'design only' },
      { id: 'msg-dm', channel_id: 'ch-dm-ab', workspace_id: WS, body: 'just us' },
      { id: 'msg-foreign', channel_id: 'ch-foreign', workspace_id: OTHER_WS, body: 'not yours' },
    ],
    captures: [
      { id: 'cap-ws', workspace_id: WS, visibility: 'workspace', user_id: BEN, is_eval: false },
      { id: 'cap-ben-private', workspace_id: WS, visibility: 'private', user_id: BEN, is_eval: false },
      { id: 'cap-eval', workspace_id: WS, visibility: 'workspace', user_id: BEN, is_eval: true },
      { id: 'cap-foreign', workspace_id: OTHER_WS, visibility: 'workspace', user_id: OUTSIDER, is_eval: false },
    ],
    decision: [
      { id: 'dec-ws', capture_id: 'cap-ws', confirmation: 'suggested', content: 'Ship Friday' },
      { id: 'dec-private', capture_id: 'cap-ben-private', confirmation: 'suggested', content: 'Raise prices' },
      { id: 'dec-private-confirmed', capture_id: 'cap-ben-private', confirmation: 'confirmed', content: 'Hire a designer' },
      { id: 'dec-eval', capture_id: 'cap-eval', confirmation: 'confirmed', content: 'Mock decision' },
      { id: 'dec-foreign', capture_id: 'cap-foreign', confirmation: 'confirmed', content: 'Their call' },
    ],
  })
}

const ids = async (type: Parameters<typeof visiblePrivateKindIds>[1], user: string | null, list: string[], ws?: string) =>
  [...(await visiblePrivateKindIds(db(), type, user, list, ws))].sort()

describe('private graph kind fences', () => {
  it('names the four private kinds', () => {
    for (const k of ['calendar_event', 'team_chat_channel', 'team_chat_message', 'decision']) expect(isPrivateGraphKind(k)).toBe(true)
    expect(isPrivateGraphKind('document')).toBe(false)
  })

  it('calendar_event: the owner only', async () => {
    expect(await ids('calendar_event', ANA, ['ev-ana', 'ev-ben'])).toEqual(['ev-ana'])
    expect(await ids('calendar_event', BEN, ['ev-ana', 'ev-ben'])).toEqual(['ev-ben'])
    // Another workspace asked for: not there.
    expect(await ids('calendar_event', ANA, ['ev-ana'], OTHER_WS)).toEqual([])
  })

  it('team_chat_channel: open channels for members, team channels for the team, DMs for their two', async () => {
    const all = ['ch-open', 'ch-team', 'ch-dm-ab', 'ch-foreign']
    expect(await ids('team_chat_channel', ANA, all)).toEqual(['ch-dm-ab', 'ch-open', 'ch-team'])
    // Ben is not on the team.
    expect(await ids('team_chat_channel', BEN, all)).toEqual(['ch-dm-ab', 'ch-open'])
    // An outsider reads only their own workspace's channel.
    expect(await ids('team_chat_channel', OUTSIDER, all)).toEqual(['ch-foreign'])
    // Pinned to a workspace: the foreign one is out even for its member.
    expect(await ids('team_chat_channel', OUTSIDER, all, WS)).toEqual([])
  })

  it('team_chat_message: whoever may read its channel', async () => {
    const all = ['msg-open', 'msg-team', 'msg-dm', 'msg-foreign']
    expect(await ids('team_chat_message', ANA, all)).toEqual(['msg-dm', 'msg-open', 'msg-team'])
    expect(await ids('team_chat_message', BEN, all)).toEqual(['msg-dm', 'msg-open'])
    expect(await ids('team_chat_message', OUTSIDER, all, WS)).toEqual([])
  })

  it('decision: through its capture (workspace, owner, or confirmed); never an eval capture or a foreign one', async () => {
    const all = ['dec-ws', 'dec-private', 'dec-private-confirmed', 'dec-eval', 'dec-foreign']
    expect(await ids('decision', ANA, all, WS)).toEqual(['dec-private-confirmed', 'dec-ws'])
    expect(await ids('decision', BEN, all, WS)).toEqual(['dec-private', 'dec-private-confirmed', 'dec-ws'])
    expect(await ids('decision', OUTSIDER, all, WS)).toEqual([])
    // Not a member of the decision's workspace: nothing, even unpinned.
    expect(await ids('decision', OUTSIDER, ['dec-ws'])).toEqual([])
  })

  it('mirrors team_chat_can_read exactly: archived channels stay readable, a guest member reads as a member does', async () => {
    const all = ['ch-open', 'ch-team', 'ch-dm-ab', 'ch-archived', 'ch-team-archived']
    // 474: archived is a POST rule (team_chat_can_post), never a read one.
    expect(await ids('team_chat_channel', ANA, all)).toEqual(['ch-archived', 'ch-dm-ab', 'ch-open', 'ch-team', 'ch-team-archived'])
    expect(await ids('team_chat_channel', BEN, all)).toEqual(['ch-archived', 'ch-dm-ab', 'ch-open'])
    // is_workspace_member counts every member row, a guest's too; a team or a DM still needs its own membership.
    expect(await ids('team_chat_channel', GUS, all)).toEqual(['ch-archived', 'ch-open'])
  })

  it('hiddenPrivateRefs: the private refs a user may not read, in one pass; other kinds never hidden', async () => {
    const refs = [
      { type: 'calendar_event', id: 'ev-ana' },
      { type: 'calendar_event', id: 'ev-ben' },
      { type: 'team_chat_message', id: 'msg-dm' },
      { type: 'deal', id: 'deal-x' },
    ]
    expect([...(await hiddenPrivateRefs(db(), refs, ANA))].sort()).toEqual(['calendar_event:ev-ben'])
    expect([...(await hiddenPrivateRefs(db(), refs, GUS))].sort()).toEqual(['calendar_event:ev-ana', 'calendar_event:ev-ben', 'team_chat_message:msg-dm'])
    expect([...(await hiddenPrivateRefs(db(), refs, null))].sort()).toEqual(['calendar_event:ev-ana', 'calendar_event:ev-ben', 'team_chat_message:msg-dm'])
  })

  it('fails closed with no user', async () => {
    expect(await ids('calendar_event', null, ['ev-ana'])).toEqual([])
    expect(await ids('team_chat_message', null, ['msg-open'])).toEqual([])
    expect(await ids('decision', null, ['dec-ws'])).toEqual([])
  })

  it('fails closed when a read errors', async () => {
    const broken = {
      from: () => {
        const q: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'in']) q[m] = () => q
        q.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: { message: 'boom' } })
        return q
      },
    } as never
    expect([...(await visiblePrivateKindIds(broken, 'team_chat_channel', ANA, ['ch-open']))]).toEqual([])
  })
})

describe('entityInWorkspace fences the private kinds', () => {
  it('admits the requester’s own calendar event and refuses someone else’s', async () => {
    expect(await entityInWorkspace(db(), WS, 'calendar_event', 'ev-ana', ANA)).toBe(true)
    expect(await entityInWorkspace(db(), WS, 'calendar_event', 'ev-ben', ANA)).toBe(false)
  })

  it('fails closed with no requester (a package the whole workspace reads)', async () => {
    expect(await entityInWorkspace(db(), WS, 'calendar_event', 'ev-ana')).toBe(false)
    expect(await entityInWorkspace(db(), WS, 'team_chat_message', 'msg-open')).toBe(false)
  })

  it('refuses a DM the requester is not in, and a foreign decision', async () => {
    expect(await entityInWorkspace(db(), WS, 'team_chat_channel', 'ch-dm-ab', OUTSIDER)).toBe(false)
    expect(await entityInWorkspace(db(), WS, 'team_chat_message', 'msg-team', BEN)).toBe(false)
    expect(await entityInWorkspace(db(), WS, 'decision', 'dec-foreign', ANA)).toBe(false)
    expect(await entityInWorkspace(db(), WS, 'decision', 'dec-ws', ANA)).toBe(true)
  })
})

describe('resourceIdInWorkspace fences the private kinds', () => {
  it('keeps the id only for a requester who may read it', async () => {
    expect(await resourceIdInWorkspace(db(), 'calendar_event', 'ev-ana', WS, ANA)).toBe(true)
    expect(await resourceIdInWorkspace(db(), 'calendar_event', 'ev-ana', WS, BEN)).toBe(false)
    expect(await resourceIdInWorkspace(db(), 'calendar_event', 'ev-ana', WS)).toBe(false)
    expect(await resourceIdInWorkspace(db(), 'team_chat_message', 'msg-foreign', WS, OUTSIDER)).toBe(false)
    expect(await resourceIdInWorkspace(db(), 'decision', 'dec-private', WS, ANA)).toBe(false)
  })
})
