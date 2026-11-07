/**
 * The helpers an agent's page and the For you column read (bubble-items.ts,
 * teammate-switcher.ts): the teammates wearing a face, what's new from one
 * (its beckoning, rows then cards; a run's cards one batch) and what still
 * waits on you that isn't new (seenItems: opened, or quiet; never a card, a
 * folded handoff or a new row); the item a notice's run names; and the
 * switcher's chips saying only what tells them apart, the whole as their
 * tooltip, in a stable order.
 */
import { describe, expect, it } from 'vitest'
import { countByOwner } from '@/lib/work/agent-work-lanes'
import type { LightWorkRow } from '@/lib/work/queries'
import type { WorkItem } from '@/lib/work/types'
import { batchKeyOf } from '../batch'
import { bubbleItems, itemForWorkItem, itemWorkItemId, seenItems, type BubbleCard, type BubbleItem } from '../bubble-items'
import { bubbleTeammates, sameAgentIds, switcherChips, switcherOrder, type BubbleTeammate } from '../teammate-switcher'

describe('what it shows', () => {
  function light(id: string, over: Partial<LightWorkRow> = {}): LightWorkRow {
    return {
      id,
      workspace_id: 'w1',
      member_id: 'm1',
      kind: 'work_run',
      status: 'needs_review',
      origin: 'loop',
      ai_team_member_id: 'writer',
      parent_id: null,
      root_id: null,
      flow_run_id: null,
      source: {},
      opened_at: null,
      needs: null,
      created_at: '2026-10-01T08:00:00.000Z',
      teammate: null,
      ...over,
    }
  }
  const card = (id: string, over: Partial<BubbleCard> = {}) =>
    ({ id, workspace_id: 'w1', member_id: 'm1', kind: 'work_proposal', title: `Card ${id}`, why: null, payload: { raised_by_ai_member_id: 'writer' }, proposal_id: null, source_flow_run_id: null, status: 'pending', expires_at: null, created_at: '2026-10-01T08:00:00.000Z', ...over }) as BubbleCard

  it('names the teammates wearing the face off the roster, and says who has something new', () => {
    const rows = [light('r1')]
    const counts = countByOwner(rows)
    const roster = [
      { id: 'writer', name: ' Writer ', workspace_id: 'w1' },
      { id: 'writer-2', name: 'Writer', workspace_id: 'w2' },
    ]
    expect(bubbleTeammates(['writer', 'writer-2', 'writer', 'gone'], roster, counts)).toEqual([
      { id: 'writer', name: 'Writer', workspaceId: 'w1', hasNew: true },
      { id: 'writer-2', name: 'Writer', workspaceId: 'w2', hasNew: false },
      { id: 'gone', name: 'Teammate', workspaceId: null, hasNew: false },
    ])
  })

  it('marks the agent (a workspace’s Assistant) as talking in the home thread (one face); nobody else', () => {
    const roster = [
      { id: 'as-1', name: 'Joseph', workspace_id: 'w1', is_system: true, system_key: 'assistant' },
      { id: 'writer', name: 'Writer', workspace_id: 'w1', is_system: false, system_key: null },
    ]
    expect(bubbleTeammates(['as-1', 'writer'], roster, new Map())).toEqual([
      { id: 'as-1', name: 'Joseph', workspaceId: 'w1', hasNew: false, home: true },
      { id: 'writer', name: 'Writer', workspaceId: 'w1', hasNew: false },
    ])
  })

  it('lists what’s new from one teammate: its waiting rows not opened yet, then its cards', () => {
    const rows = [
      light('ask', { status: 'needs_input' }),
      light('seen', { opened_at: '2026-10-01T09:00:00.000Z' }),
      light('busy', { status: 'running' }),
      light('theirs', { ai_team_member_id: 'scout' }),
      light('review'),
    ]
    const cards = [card('c1')]
    const counts = countByOwner(rows, cards)
    expect(bubbleItems('writer', counts, rows, cards).map((i) => `${i.kind}:${i.id}`)).toEqual(['row:ask', 'row:review', 'card:c1'])
    expect(bubbleItems('nobody', counts, rows, cards)).toEqual([])
  })

  it('lists what still waits on you that isn’t new: an opened waiting row; never a new one, a folded handoff or a card', () => {
    const OPENED = '2026-10-01T09:00:00.000Z'
    const rows: Array<WorkItem | LightWorkRow> = [
      light('opened-review', { opened_at: OPENED }),
      light('opened-question', { status: 'needs_input', opened_at: OPENED }),
      // Opened, and still waiting on you.
      light('quiet', { kind: 'email_drafts', opened_at: OPENED }),
      // Opened, then waiting again: the recorder cleared its stamp, so it's new.
      light('asks-again', { status: 'needs_input', opened_at: null }),
      light('new-review'),
      // A handoff reviewed with its root (the root still runs): skipped, as the counts skip it.
      light('root', { status: 'running', ai_team_member_id: 'scout' }),
      light('folded', { parent_id: 'root', root_id: 'root', opened_at: OPENED }),
      // Its root settled some other way: it stands alone again.
      light('failed-root', { status: 'failed', ai_team_member_id: 'scout' }),
      light('alone', { parent_id: 'failed-root', root_id: 'failed-root', opened_at: OPENED }),
      light('running', { status: 'running', opened_at: OPENED }),
      light('done', { status: 'done', opened_at: OPENED }),
      light('theirs', { ai_team_member_id: 'scout', opened_at: OPENED }),
    ]
    const cards = [card('c1')]
    const counts = countByOwner(rows, cards)
    const seen = seenItems('writer', rows)
    expect(seen.map((i) => `${i.kind}:${i.id}`)).toEqual(['row:opened-review', 'row:opened-question', 'row:quiet', 'row:alone'])
    // Never what's new: together they're every waiting row the counts count for it, each once.
    const fresh = bubbleItems('writer', counts, rows, cards)
    expect(fresh.map((i) => `${i.kind}:${i.id}`)).toEqual(['row:asks-again', 'row:new-review', 'card:c1'])
    expect(seen.filter((i) => fresh.some((f) => f.id === i.id))).toEqual([])
    expect(fresh.filter((i) => i.kind === 'row').length + seen.length).toBe(counts.get('tm:writer')!.needsYou - 1)
    expect(seenItems('nobody', rows)).toEqual([])
  })
})

describe('one item per run (bots v3 1b)', () => {
  const card = (id: string, payload: Record<string, unknown>, over: Partial<BubbleCard> = {}) =>
    ({ id, workspace_id: 'w1', member_id: 'm1', kind: 'action_card', title: `Card ${id}`, why: null, payload: { raised_by_ai_member_id: 'triage', capture_title: 'Call with Acme', ...payload }, proposal_id: null, source_flow_run_id: null, status: 'pending', expires_at: null, created_at: `2026-10-02T10:00:0${id.slice(-1)}.000Z`, ...over }) as BubbleCard

  it('folds a run’s three cards into one batch, keyed on its work item, where the first stood', () => {
    const cards = [card('c1', { work_item_id: 'job-1' }), card('c2', { work_item_id: 'job-1' }), card('c3', { work_item_id: 'job-1' })]
    const items = bubbleItems('triage', countByOwner([], cards), [], cards)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'batch', id: 'work:job-1', workItemId: 'job-1' })
    expect((items[0] as Extract<BubbleItem, { kind: 'batch' }>).cards.map((c) => c.id)).toEqual(['c1', 'c2', 'c3'])
    expect(itemWorkItemId(items[0])).toBe('job-1')
    expect(itemForWorkItem(items, 'job-1')?.id).toBe('work:job-1')
  })

  it('two verdict loops on one capture (one run_key, two work items) make two batches', () => {
    const cards = [
      card('c1', { work_item_id: 'job-seeded', flow_id: 'flow-seeded' }, { run_key: 'evt-1' }),
      card('c2', { work_item_id: 'job-mine', flow_id: 'flow-mine' }, { run_key: 'evt-1' }),
      card('c3', { work_item_id: 'job-seeded', flow_id: 'flow-seeded' }, { run_key: 'evt-1' }),
      card('c4', { work_item_id: 'job-mine', flow_id: 'flow-mine' }, { run_key: 'evt-1' }),
    ]
    const items = bubbleItems('triage', countByOwner([], cards), [], cards)
    expect(items.map((i) => i.id)).toEqual(['work:job-seeded', 'work:job-mine'])
  })

  it('a run with no ledger row batches on its fire and its loop, never the bare run key', () => {
    const cards = [
      card('c1', { flow_id: 'flow-a' }, { run_key: 'evt-1' }),
      card('c2', { flow_id: 'flow-a' }, { run_key: 'evt-1' }),
      card('c3', { flow_id: 'flow-b' }, { run_key: 'evt-1' }),
    ]
    expect(batchKeyOf(cards[0])).toBe('run:evt-1:flow-a')
    const items = bubbleItems('triage', countByOwner([], cards), [], cards)
    expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual(['batch:run:evt-1:flow-a', 'card:c3'])
    expect(items[0]).toMatchObject({ workItemId: null })
  })

  it('a run’s one card, and a card naming no run, stay cards', () => {
    const cards = [card('c1', { work_item_id: 'job-1' }), card('c2', {})]
    expect(batchKeyOf(cards[1])).toBeNull()
    const items = bubbleItems('triage', countByOwner([], cards), [], cards)
    expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual(['card:c1', 'card:c2'])
    expect(itemForWorkItem(items, 'job-1')?.id).toBe('c1')
    expect(itemForWorkItem(items, 'job-x')).toBeNull()
    expect(itemForWorkItem(items, null)).toBeNull()
  })
})

describe('switcherChips', () => {
  const mate = (id: string, name: string, workspaceId: string | null): BubbleTeammate => ({ id, name, workspaceId, hasNew: false })
  const names: Record<string, string> = { w1: 'Acme', w2: 'Liam Alizadeh’s Workspace', w3: 'Asd' }
  const workspaceName = (id: string | null) => (id ? (names[id] ?? null) : null)

  it('labels the same teammate in several workspaces by its workspace alone (the header names it)', () => {
    const chips = switcherChips([mate('a', 'Triage', 'w1'), mate('b', 'Triage', 'w2'), mate('c', 'triage ', 'w3')], workspaceName)
    expect(chips.map((c) => c.label)).toEqual(['Acme', 'Liam Alizadeh’s Workspace', 'Asd'])
    expect(chips.map((c) => c.title)).toEqual(['Triage · Acme', 'Triage · Liam Alizadeh’s Workspace', 'triage  · Asd'])
  })

  it('labels a shared face’s teammates by name, with the workspace where two share a name', () => {
    const chips = switcherChips([mate('a', 'Triage', 'w1'), mate('b', 'Scout', 'w1'), mate('c', 'Triage', 'w3')], workspaceName)
    expect(chips.map((c) => c.label)).toEqual(['Triage · Acme', 'Scout', 'Triage · Asd'])
    expect(chips[1].title).toBe('Scout · Acme')
  })

  it('falls back to the name for a workspace it doesn’t know', () => {
    const chips = switcherChips([mate('a', 'Triage', 'w1'), mate('b', 'Triage', 'gone'), mate('c', 'Triage', null)], workspaceName)
    expect(chips).toEqual([
      { label: 'Acme', title: 'Triage · Acme' },
      { label: 'Triage', title: 'Triage' },
      { label: 'Triage', title: 'Triage' },
    ])
  })
})

describe('switcherOrder', () => {
  const mate = (id: string, name: string, workspaceId: string | null): BubbleTeammate => ({ id, name, workspaceId, hasNew: id === 'b' })
  const names: Record<string, string> = { liam: 'Liam’s Workspace', test: 'Test', asd: 'Asd', acme: 'acme' }
  const workspaceName = (id: string | null) => (id ? (names[id] ?? null) : null)
  const order = (mates: BubbleTeammate[], current: string | null) => switcherOrder(mates, current, workspaceName).map((i) => mates[i].id)

  it('puts the workspace on screen first, then the rest by workspace name, whatever order the crew lists them in', () => {
    const triage = [mate('a', 'Triage', 'test'), mate('b', 'Triage', 'asd'), mate('c', 'Triage', 'liam')]
    const extraction = [mate('c', 'Triage', 'liam'), mate('a', 'Triage', 'test'), mate('b', 'Triage', 'asd')]
    expect(order(triage, 'liam')).toEqual(['c', 'b', 'a'])
    expect(order(extraction, 'liam')).toEqual(['c', 'b', 'a'])
    expect(order(triage, 'test')).toEqual(['a', 'b', 'c'])
  })

  it('sorts names without regard to case, a workspace it doesn’t know last, and by name within one workspace', () => {
    const mates = [mate('a', 'Triage', 'gone'), mate('b', 'Scout', 'test'), mate('c', 'Triage', 'acme'), mate('d', 'Apex', 'test'), mate('e', 'Triage', null)]
    expect(order(mates, null)).toEqual(['c', 'd', 'b', 'a', 'e'])
    expect(order(mates, 'test')).toEqual(['d', 'b', 'c', 'a', 'e'])
  })
})

describe('sameAgentIds: the agent in other workspaces, never grouped by face', () => {
  const A = { id: 'a', workspace_id: 'ws-1', name: 'Ada', agent_recipe_id: 'p1' }

  it('the same persona under the same name, one per other workspace, the agent first', () => {
    const roster = [
      { id: 'b', workspace_id: 'ws-2', name: ' ada ', agent_recipe_id: 'p1' },
      { id: 'b2', workspace_id: 'ws-2', name: 'Ada', agent_recipe_id: 'p1' },
      { id: 'c', workspace_id: 'ws-1', name: 'Ada', agent_recipe_id: 'p1' },
      { id: 'd', workspace_id: 'ws-3', name: 'Ada', agent_recipe_id: 'p2' },
      { id: 'e', workspace_id: 'ws-3', name: 'Bea', agent_recipe_id: 'p1' },
      A,
    ]
    expect(sameAgentIds(A, roster)).toEqual(['a', 'b'])
  })

  it('a built-in teammate by its system key; a role teammate by its role and name', () => {
    const asst = { id: 's1', workspace_id: 'ws-1', name: 'Assistant', is_system: true, system_key: 'assistant' }
    const roster = [
      asst,
      { id: 's2', workspace_id: 'ws-2', name: 'Joseph', is_system: true, system_key: 'assistant' },
      { id: 's3', workspace_id: 'ws-2', name: 'Mail', is_system: true, system_key: 'mail' },
      { id: 'x', workspace_id: 'ws-3', name: 'Assistant' },
    ]
    expect(sameAgentIds(asst, roster)).toEqual(['s1', 's2'])
    const writer = { id: 'w1', workspace_id: 'ws-1', name: 'Writer', role: 'writer' as const }
    expect(sameAgentIds(writer, [writer, { id: 'w2', workspace_id: 'ws-2', name: 'Writer', role: 'writer' as const }, { id: 'w3', workspace_id: 'ws-3', name: 'Quill', role: 'writer' as const }])).toEqual(['w1', 'w2'])
  })

  it('just the agent when nothing matches, and nothing for an unknown one', () => {
    expect(sameAgentIds({ id: 'z', workspace_id: 'ws-1', name: 'Zed' }, [{ id: 'y', workspace_id: 'ws-2', name: 'Zed' }])).toEqual(['z'])
    expect(sameAgentIds(null, [A])).toEqual([])
  })
})
