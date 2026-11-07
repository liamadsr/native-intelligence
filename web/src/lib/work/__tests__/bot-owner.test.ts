/**
 * Work with no bot you can see is the Assistant's (lib/work/bot-owner.ts;
 * Liam, 2026-10-08): the one rule the client and the server share.
 *
 * Locked in:
 *   - a row's bot is its own teammate when the viewer can reach it there; a
 *     row with no teammate (older work, a deleted bot's: the column is `on
 *     delete set null`) and one whose teammate is out of reach (behind a
 *     private team, or not in the roster at all) are the workspace's
 *     Assistant's; a sequence send keeps no bot; with no Assistant known,
 *     nothing moves; a failed reach read (`reachable: null`) moves nothing;
 *   - a card's bot is its raiser when reachable, else the Assistant; with no
 *     raiser, its run row's bot, else the Assistant;
 *   - so countByOwner counts them for the Assistant;
 *   - taking work changes nothing the Assistant can do: it stays
 *     propose-only, and the run it fronts keeps its own chat (decision 20).
 */
import { describe, it, expect } from 'vitest'
import { cardLookupRows, cardOwnerKeys, countByOwner, teammateKey } from '../agent-work-lanes'
import {
  KINDS_WITHOUT_BOT,
  NO_BOT_OWNERS,
  ROSTER_LIMIT,
  botOwners,
  botOwnersFromRoster,
  faceAreaOf,
  isOwnerFallback,
  rowOwnerId,
  withBotOwner,
  withBotOwners,
  withCardOwner,
  withCardOwners,
} from '../bot-owner'
import { otherReachableTeammates } from '../bot-owner-server'
import { isOwnRun } from '@/lib/bots/own-run'
import { itemChat, rowConversation } from '@/lib/bots/item-run-chat'
import { rowHasRunChat } from '@/lib/bots/bubble-items'
import { composeTeammateChatCeiling, teammateChatBoundsFromRow } from '@/lib/chat/chat-ceiling'
import { computeEditionToolCeiling, EDITIONS } from '@/lib/editions'
import { getToolDefinition } from '@/lib/ai/tool-registry'
import { WORK_BOT_PROPOSE_TOOLS } from '@/lib/chat/chat-ceiling'
import type { WorkItem } from '../types'

const ROSTER = [
  { id: 'tm-assistant', workspace_id: 'w1', name: 'Assistant', is_system: true, system_key: 'assistant', bot_character: 'chat', reachable: true },
  { id: 'writer', workspace_id: 'w1', name: 'Writer', is_system: false, system_key: null, bot_character: 'writer', reachable: true },
  // An owner sees a private team's teammate under RLS; they can't reach it.
  { id: 'closer', workspace_id: 'w1', name: 'Closer', is_system: false, system_key: null, bot_character: 'closer', reachable: false },
  // A reach read that failed: unknown, so it keeps its own work.
  { id: 'unknown', workspace_id: 'w1', name: 'Unknown', is_system: false, system_key: null, bot_character: null, reachable: null },
  // Another workspace, with no Assistant.
  { id: 'w2-writer', workspace_id: 'w2', name: 'Writer', is_system: false, system_key: null, bot_character: 'writer', reachable: true },
]
const owners = botOwners(ROSTER, { complete: true })

function row(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    workspace_id: 'w1',
    member_id: 'm1',
    kind: 'work_run',
    title: id,
    status: 'running',
    actor: 'agent',
    current_step: null,
    progress: {},
    result_summary: null,
    error_message: null,
    skip_reason: null,
    deliverables: [],
    needs: null,
    source: {},
    run_key: null,
    agent_run_id: null,
    flow_run_id: null,
    created_at: '2026-10-08T08:00:00.000Z',
    started_at: null,
    finished_at: null,
    reviewed_at: null,
    last_beat_at: '2026-10-08T08:00:00.000Z',
    deadline_at: null,
    ai_team_member_id: null,
    ...over,
  }
}

describe('a row’s bot', () => {
  it('is its own teammate when reachable there; else its workspace’s Assistant', () => {
    expect(rowOwnerId(row('a', { ai_team_member_id: 'writer' }), owners)).toBe('writer')
    // No teammate: an older row, or a deleted bot's.
    expect(rowOwnerId(row('b', { kind: 'prospecting' }), owners)).toBe('tm-assistant')
    expect(rowOwnerId(row('c', { kind: 'crm_import' }), owners)).toBe('tm-assistant')
    // Behind a private team the viewer isn't on, or not in their roster at all.
    expect(rowOwnerId(row('d', { ai_team_member_id: 'closer' }), owners)).toBe('tm-assistant')
    expect(rowOwnerId(row('e', { ai_team_member_id: 'not-in-roster' }), owners)).toBe('tm-assistant')
    // A teammate of another workspace is no teammate of this one.
    expect(rowOwnerId(row('f', { ai_team_member_id: 'w2-writer' }), owners)).toBe('tm-assistant')
    // An unknown reach keeps its own work.
    expect(rowOwnerId(row('g', { ai_team_member_id: 'unknown' }), owners)).toBe('unknown')
  })

  it('keeps no bot for a sequence send, and moves nothing with no Assistant known', () => {
    expect(KINDS_WITHOUT_BOT.has('sequence_enrolment')).toBe(true)
    expect(rowOwnerId(row('s', { kind: 'sequence_enrolment' }), owners)).toBeNull()
    expect(rowOwnerId(row('w2', { workspace_id: 'w2', kind: 'prospecting' }), owners)).toBeNull()
    expect(rowOwnerId(row('none', { kind: 'prospecting' }), NO_BOT_OWNERS)).toBeNull()
    expect(rowOwnerId(row('none', { ai_team_member_id: 'closer' }), NO_BOT_OWNERS)).toBe('closer')
  })

  it('names the Assistant with its embed and marks the row as fronted for attribution only; the same object when nothing moves', () => {
    const own = row('a', { ai_team_member_id: 'writer' })
    expect(withBotOwner(own, owners)).toBe(own)
    const taken = withBotOwner(row('b', { kind: 'work_run', source: { agent_run_id: 'run-1' } }), owners)
    expect(taken).toMatchObject({
      ai_team_member_id: 'tm-assistant',
      teammate: { id: 'tm-assistant', name: 'Assistant', is_system: true, system_key: 'assistant', role: null, bot_character: 'chat' },
      source: { agent_run_id: 'run-1', teammate_routed: true },
    })
    // Idempotent: a row already named for it stays as it is.
    expect(withBotOwner(taken, owners)).toBe(taken)
    const list = [own, row('s', { kind: 'sequence_enrolment' })]
    expect(withBotOwners(list, owners)).toBe(list)
    const mixed = withBotOwners([own, row('b', { kind: 'prospecting' })], owners)
    expect(mixed[0]).toBe(own)
    expect(mixed[1].ai_team_member_id).toBe('tm-assistant')
  })
})

describe('a card’s bot', () => {
  const card = (id: string, over: Record<string, unknown> = {}) => ({ id, workspace_id: 'w1', source_flow_run_id: null as string | null, payload: {} as Record<string, unknown>, ...over })

  it('is its raiser when reachable; a gone or unreachable raiser’s card is the Assistant’s', () => {
    const mine = card('c1', { payload: { raised_by_ai_member_id: 'writer' } })
    expect(withCardOwner(mine, owners)).toBe(mine)
    for (const raiser of ['deleted-bot', 'closer']) {
      const owned = withCardOwner(card('c2', { payload: { raised_by_ai_member_id: raiser } }), owners)
      expect(cardOwnerKeys(owned, []), raiser).toEqual([teammateKey('tm-assistant')])
    }
  })

  it('with no raiser: its run row’s bot (as that row is named), else the Assistant', () => {
    const rows = withBotOwners([row('run-w', { flow_run_id: 'fr-w', ai_team_member_id: 'writer' }), row('run-0', { flow_run_id: 'fr-0', kind: 'flow_run' })], owners)
    const byRow = withCardOwner(card('c3', { source_flow_run_id: 'fr-w' }), owners)
    expect(cardOwnerKeys(byRow, rows)).toEqual([teammateKey('writer')])
    const byNamelessRow = withCardOwner(card('c4', { source_flow_run_id: 'fr-0' }), owners)
    expect(cardOwnerKeys(byNamelessRow, rows)).toEqual([teammateKey('tm-assistant')])
    const noRow = withCardOwner(card('c5'), owners)
    expect(noRow.payload).toMatchObject({ fallback_owner_ai_member_id: 'tm-assistant' })
    expect(cardOwnerKeys(noRow, rows)).toEqual([teammateKey('tm-assistant')])
  })

  it('moves nothing with no Assistant known: a card that names no one is no one’s, as before', () => {
    const list = [card('c6', { workspace_id: 'w2' }), card('c7', { workspace_id: 'w2', payload: { raised_by_ai_member_id: 'deleted-bot' } })]
    expect(withCardOwners(list, owners)).toBe(list)
    expect(cardOwnerKeys(list[0], [])).toEqual([])
  })
})

describe('the counts', () => {
  const rows = withBotOwners(
    [
      row('legacy', { kind: 'prospecting', status: 'needs_input' }),
      row('deleted-bot', { kind: 'work_run', status: 'running' }),
      row('draft', { status: 'needs_review', ai_team_member_id: 'writer' }),
      row('send', { kind: 'sequence_enrolment', status: 'running' }),
    ],
    owners,
  )
  const cards = withCardOwners(
    [
      { id: 'card-gone', workspace_id: 'w1', source_flow_run_id: null, payload: { raised_by_ai_member_id: 'deleted-bot' } },
      { id: 'card-none', workspace_id: 'w1', source_flow_run_id: null, payload: {} },
    ],
    owners,
  )
  const counts = countByOwner(rows, cards, cardLookupRows(rows, []))

  it('count a teammate-less row, a deleted bot’s and a gone raiser’s card for the Assistant; a sequence send stays a lane', () => {
    expect(counts.get(teammateKey('tm-assistant'))).toEqual({ running: 1, needsYou: 3, beckoning: ['legacy', 'card-gone', 'card-none'], asking: ['legacy'] })
    expect(counts.get(teammateKey('writer'))).toEqual({ running: 0, needsYou: 1, beckoning: ['draft'] })
    expect(counts.get('lane:sequence_enrolment')).toEqual({ running: 1, needsYou: 0, beckoning: [] })
    expect([...counts.keys()].some((k) => k.startsWith('lane:') && k !== 'lane:sequence_enrolment')).toBe(false)
  })
})

describe('taking work changes nothing the Assistant can do', () => {
  it('stays propose-only: reads plus the propose-only tools, as a work bot', () => {
    const bounds = teammateChatBoundsFromRow(
      { is_system: true, system_key: 'assistant', team_id: null, fronts_only: false, allowed_side_effects: ['read', 'internal-write', 'external-write'], tool_allowlist: null, agent: null },
      'w1',
    )
    expect(bounds.frontsOnly).toBe(true)
    const out = composeTeammateChatCeiling(computeEditionToolCeiling(EDITIONS.full), bounds)
    expect(out.has('create_document')).toBe(false)
    expect(out.has('create_email_draft')).toBe(false)
    for (const name of out) {
      if (name === 'search_tools' || WORK_BOT_PROPOSE_TOOLS.has(name)) continue
      expect(getToolDefinition(name)?.sideEffect, name).toBe('read')
    }
  })

  it('the run it fronts keeps its own chat ("Your run’s chat"), and nothing about the run itself is named', () => {
    const before = row('own', { kind: 'work_run', agent_run_id: 'run-1' })
    const taken = withBotOwner(before, owners)
    expect(isOwnRun(taken)).toBe(true)
    expect(taken.agent_run_id).toBe('run-1')
    // Only the ledger row's attribution moves: the keys it changes, and no others.
    const changed = Object.keys(taken).filter((k) => (taken as unknown as Record<string, unknown>)[k] !== (before as unknown as Record<string, unknown>)[k])
    expect(changed.sort()).toEqual(['ai_team_member_id', 'source', 'teammate'])
  })
})

describe('a bot you can’t reach: shown by the Assistant, never its run chat', () => {
  it('its row is marked owner_fallback, not teammate_routed: not the person’s own run', () => {
    const taken = withBotOwner(row('p', { ai_team_member_id: 'closer', source: { agent_run_id: 'run-9' } }), owners)
    expect(taken).toMatchObject({ ai_team_member_id: 'tm-assistant', source: { agent_run_id: 'run-9', owner_fallback: true } })
    expect(taken.source).not.toHaveProperty('teammate_routed')
    expect(isOwnRun(taken)).toBe(false)
    expect(isOwnerFallback(taken)).toBe(true)
  })

  const P_WORK = '90000000-0000-4000-8000-000000000001'

  it('the bubble refuses its run chat (a work run’s, a loop run’s): the Assistant’s own thread, about the item', () => {
    const work = withBotOwner(row(P_WORK, { kind: 'work_run', status: 'needs_review', agent_run_id: 'run-9', ai_team_member_id: 'closer' }), owners)
    expect(itemChat({ kind: 'row', id: work.id, row: work })).toEqual({ kind: 'none', itemId: P_WORK, why: 'fallback' })
    expect(rowConversation(work)).toEqual({ context: { workItemId: P_WORK } })
    const loop = withBotOwner(row('p-loop', { kind: 'flow_run', status: 'done', ai_team_member_id: 'closer', source: { run_chat: true } }), owners)
    expect(rowHasRunChat(loop)).toBe(false)
    expect(itemChat({ kind: 'row', id: loop.id, row: loop })).toMatchObject({ kind: 'none', why: 'fallback' })
  })

  it('a person’s own run with no teammate still opens as “Your run’s chat”', () => {
    const own = withBotOwner(row('own', { kind: 'work_run', status: 'needs_review', agent_run_id: 'run-1' }), owners)
    expect(itemChat({ kind: 'row', id: own.id, row: own })).toMatchObject({ kind: 'run', runId: 'run-1', own: true })
    expect(rowConversation(own)).toMatchObject({ runId: 'run-1', own: true })
  })
})

describe('a capped roster: a teammate missing from it is unknown', () => {
  const full = (n: number) => [
    ROSTER[0],
    ...Array.from({ length: n - 1 }, (_, i) => ({ id: `mate-${i}`, workspace_id: 'w1', name: `Mate ${i}`, reachable: true })),
  ]

  it(`at ROSTER_LIMIT (${ROSTER_LIMIT}) its rows and cards don’t move; under it, a missing one is out of reach`, () => {
    const capped = botOwnersFromRoster(full(ROSTER_LIMIT))
    expect(capped.complete).toBe(false)
    expect(rowOwnerId(row('x', { ai_team_member_id: 'past-the-cap' }), capped)).toBe('past-the-cap')
    const card = { id: 'c', workspace_id: 'w1', source_flow_run_id: null, payload: { raised_by_ai_member_id: 'past-the-cap' } }
    expect(withCardOwner(card, capped)).toBe(card)
    // A row with no teammate still moves, and so does an explicitly unreachable one.
    expect(rowOwnerId(row('y'), capped)).toBe('tm-assistant')
    const under = botOwnersFromRoster(full(ROSTER_LIMIT - 1))
    expect(under.complete).toBe(true)
    expect(rowOwnerId(row('x', { ai_team_member_id: 'past-the-cap' }), under)).toBe('tm-assistant')
  })
})

describe('one face: an area face’s work is the agent’s own (always-on-agent §2c)', () => {
  const FACED = [
    ...ROSTER,
    { id: 'tm-mail', workspace_id: 'w1', name: 'Mail', is_system: true, system_key: 'mail', bot_character: 'mail', reachable: true },
    { id: 'tm-captures', workspace_id: 'w1', name: 'Captures', is_system: true, system_key: 'captures', bot_character: 'triage', reachable: true },
    // Another workspace's area face, whose workspace has no Assistant known.
    { id: 'w2-mail', workspace_id: 'w2', name: 'Mail', is_system: true, system_key: 'mail', bot_character: 'mail', reachable: true },
  ]
  const faced = botOwners(FACED, { complete: true })

  it('collects the area faces, with their workspace and area', () => {
    expect(faced.areaFaces.get('tm-mail')).toEqual({ workspaceId: 'w1', area: 'mail' })
    expect(faced.areaFaces.get('tm-captures')).toEqual({ workspaceId: 'w1', area: 'captures' })
    expect(faced.areaFaces.has('tm-assistant')).toBe(false)
    expect(faced.areaFaces.has('writer')).toBe(false)
  })

  it('an area face’s row shows with the Assistant, marked teammate_routed (its run chat stays offered) and with its area', () => {
    const mailRow = row('m', { kind: 'email_drafts', status: 'needs_review', ai_team_member_id: 'tm-mail' })
    expect(rowOwnerId(mailRow, faced)).toBe('tm-assistant')
    const taken = withBotOwner(mailRow, faced)
    expect(taken).toMatchObject({
      ai_team_member_id: 'tm-assistant',
      teammate: { id: 'tm-assistant', system_key: 'assistant' },
      source: { teammate_routed: true, face_area: 'mail' },
    })
    expect(isOwnerFallback(taken)).toBe(false)
    expect(faceAreaOf(taken)).toBe('mail')
    expect(withBotOwner(taken, faced)).toBe(taken)
    // A person's own run an area face fronted still opens as their run's chat.
    const own = withBotOwner(row('p', { kind: 'work_run', status: 'needs_review', agent_run_id: 'run-2', ai_team_member_id: 'tm-captures' }), faced)
    expect(itemChat({ kind: 'row', id: own.id, row: own })).toMatchObject({ kind: 'run', runId: 'run-2', own: true })
  })

  it('an area face with no Assistant known in its workspace keeps its work (nothing moves)', () => {
    expect(rowOwnerId(row('w2m', { workspace_id: 'w2', ai_team_member_id: 'w2-mail' }), faced)).toBe('w2-mail')
  })

  it('a card an area face raised is the Assistant’s, with raised_by_area', () => {
    const card = { id: 'c', workspace_id: 'w1', source_flow_run_id: null, payload: { raised_by_ai_member_id: 'tm-captures' } as Record<string, unknown> }
    const owned = withCardOwner(card, faced)
    expect(owned.payload).toEqual({ raised_by_ai_member_id: 'tm-assistant', raised_by_area: 'captures' })
    expect(withCardOwner(owned, faced)).toBe(owned)
  })

  it('counts them on the Assistant: no area face holds any', () => {
    const rows = withBotOwners(
      [
        row('m1', { kind: 'email_drafts', status: 'needs_review', ai_team_member_id: 'tm-mail' }),
        row('m2', { kind: 'extraction', status: 'needs_review', ai_team_member_id: 'tm-captures' }),
      ],
      faced,
    )
    const counts = countByOwner(rows, [], cardLookupRows(rows, []))
    expect(counts.get(teammateKey('tm-assistant'))?.needsYou).toBe(2)
    expect(counts.get(teammateKey('tm-mail'))).toBeUndefined()
    expect(counts.get(teammateKey('tm-captures'))).toBeUndefined()
  })

  it('the Assistant’s page read takes the area faces’ rows in (otherReachableTeammates leaves them out)', () => {
    expect(otherReachableTeammates(faced, 'w1').sort()).toEqual(['unknown', 'writer'])
  })
})
