// @vitest-environment jsdom
/**
 * openTeammate (bot-characters.md Step 3, items 6 and 11): what a click on a
 * bot does, for the set of teammates it stands for, read off the shared
 * source's counts (what is new: rows waiting on you not opened yet, pending
 * cards); and openItem, where ANY work item opens (bots-v4.md "An item opens
 * on its bot's page", Phase 2).
 *
 *   • one new row → that item, on its teammate's bot's page (the nav's
 *     openItemPage), whatever workspace it's in (the page carries its own);
 *     a row with no teammate, or whose bot's page can't open (a teammate
 *     since deleted, or behind a private team), its panel on a card of its own,
 *     as a card in the chat on screen, carrying its workspace when another;
 *   • one new card → the item of the run that wrote it, when the source holds
 *     that run's row (light card rows included), on that run's teammate's
 *     page;
 *   • one new card with no run held (a work proposal) → the bot's page;
 *   • several new, or none → the bot's page (docs/plans/bots-v4.md Phase 1b),
 *     of the teammate on screen first (resolveTalk's pick); where its page
 *     can't open (no dashboard to answer, a teammate the roster doesn't
 *     hold), nothing opens;
 *   • a card two of the teammates share is one thing waiting; an opened row is
 *     not new.
 *
 * `talk` (bots-v2.md Phase 2) hands the bubble the teammate to start on
 * (decision 6: something new, else the workspace on screen, else the first)
 * and the face to hold it at, and navigates nowhere. `page` (the bubble's
 * "Open Triage's page") is the bot's page whatever is new. `openItem` places
 * an item by the source, else by what the caller knows, else by a lookup.
 */
import { describe, it, expect, vi } from 'vitest'
import type { WorkItem } from '@/lib/work/types'
import type { LightWorkRow } from '@/lib/work/queries'

import { countByOwner, cardLookupRows, type OwnedCard } from '@/lib/work/agent-work-lanes'
import { BOT_CHARACTERS } from '@/lib/bots/bot-faces'
import { openItem, openTeammate, resolveOpenTeammate, resolveTalk, type OpenTeammateSource, type TalkOutcome } from '../open-teammate'

function row(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    workspace_id: 'w1',
    member_id: 'm1',
    kind: 'work_run',
    title: `Item ${id}`,
    status: 'needs_review',
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
    created_at: '2026-09-30T08:00:00.000Z',
    started_at: null,
    finished_at: null,
    reviewed_at: null,
    last_beat_at: '2026-09-30T08:00:00.000Z',
    deadline_at: null,
    ...over,
  }
}

function light(id: string, over: Partial<LightWorkRow> = {}): LightWorkRow {
  return {
    id,
    workspace_id: 'w1',
    member_id: 'm1',
    kind: 'flow_run',
    status: 'done',
    origin: 'loop',
    ai_team_member_id: null,
    parent_id: null,
    root_id: null,
    flow_run_id: null,
    source: {},
    opened_at: null,
    needs: null,
    created_at: '2026-09-30T07:00:00.000Z',
    teammate: null,
    ...over,
  }
}

type Card = OwnedCard & { title?: string | null }
function card(id: string, over: Partial<Card> = {}): Card {
  return { id, source_flow_run_id: null, payload: {}, title: `Card ${id}`, ...over }
}

/** The source the provider hands out: its rows, card rows, cards, and countByOwner over them. */
function source(rows: Array<WorkItem | LightWorkRow>, cards: Card[] = [], cardRows: LightWorkRow[] = []): OpenTeammateSource {
  return { rows, cardRows, cards, counts: countByOwner(rows, cards, cardLookupRows(rows, cardRows)) }
}

const nav = () => ({
  currentWorkspaceId: 'w1' as string | null,
  // A card in the chat on screen, in `workspaceId` when it's another.
  open: vi.fn(),
  // The bot's page opens (the dashboard took it).
  openPage: vi.fn((_teammateId: string) => true),
  // And on one of its items.
  openItemPage: vi.fn((_teammateId: string, _item: { itemId: string; title: string }) => true),
})

/** The item's panel on its own card, as goToItem asks for it (itemCardTarget). */
const itemCard = (id: string, title: string) => ({ type: 'work_item', id, title })

describe('openTeammate', () => {
  it('one new row: that item, on its teammate’s bot’s page, nothing else', () => {
    const n = nav()
    const out = openTeammate(['writer'], 'open', source([row('draft', { ai_team_member_id: 'writer' })]), n)
    expect(out).toEqual({ kind: 'item', workItemId: 'draft', workspaceId: 'w1', via: 'row', teammateId: 'writer', on: 'bot-page' })
    expect(n.openItemPage).toHaveBeenCalledWith('writer', { itemId: 'draft', title: 'Item draft' })
    expect(n.open).not.toHaveBeenCalled()
  })

  it('one new row in another workspace: on its bot’s page too, no switch (the page carries its teammate’s workspace)', () => {
    const n = nav()
    // One bot for two Writers (w1 and w2): only the w2 one has something new.
    const rows = [
      row('seen', { ai_team_member_id: 'writer-w1', opened_at: '2026-09-30T09:00:00.000Z' }),
      row('ask', { workspace_id: 'w2', status: 'needs_input', ai_team_member_id: 'writer-w2' }),
    ]
    const out = openTeammate(['writer-w1', 'writer-w2'], 'open', source(rows), n)
    expect(out).toEqual({ kind: 'item', workItemId: 'ask', workspaceId: 'w2', via: 'row', teammateId: 'writer-w2', on: 'bot-page' })
    expect(n.openItemPage).toHaveBeenCalledWith('writer-w2', { itemId: 'ask', title: 'Item ask' })
    expect(n.open).not.toHaveBeenCalled()
  })

  it('a teammate whose bot’s page can’t open (since deleted, behind a private team): its panel on its own card, in its own workspace', () => {
    const n = { ...nav(), openItemPage: vi.fn(() => false) }
    const out = openTeammate(['writer'], 'open', source([row('ask', { workspace_id: 'w2', ai_team_member_id: 'writer' })]), n)
    expect(out).toMatchObject({ kind: 'item', workItemId: 'ask', on: 'card' })
    expect(n.openItemPage).toHaveBeenCalledTimes(1)
    expect(n.open).toHaveBeenCalledWith(itemCard('ask', 'Item ask'), 'w2')
    expect(n.open).toHaveBeenCalledTimes(1)
    // In this workspace: in place.
    const m = { ...nav(), openItemPage: vi.fn(() => false) }
    openTeammate(['writer'], 'open', source([row('ask', { ai_team_member_id: 'writer' })]), m)
    expect(m.open).toHaveBeenCalledWith(itemCard('ask', 'Item ask'), null)
  })

  it('a light row (no title) opens too, named for its kind', () => {
    const n = nav()
    openTeammate(['writer'], 'open', source([light('l1', { kind: 'work_run', status: 'needs_review', ai_team_member_id: 'writer' })]), n)
    expect(n.openItemPage).toHaveBeenCalledWith('writer', { itemId: 'l1', title: 'Work run' })
  })

  it('one new card whose run the source holds: that run, on its teammate’s page (a light card row), named for the card', () => {
    const n = nav()
    const verdict = light('verdict', { workspace_id: 'w2', flow_run_id: 'fr1', ai_team_member_id: 'triage' })
    const out = openTeammate(['triage'], 'open', source([], [card('c1', { source_flow_run_id: 'fr1', title: 'File the follow-up' })], [verdict]), n)
    expect(out).toEqual({ kind: 'item', workItemId: 'verdict', workspaceId: 'w2', via: 'card', teammateId: 'triage', on: 'bot-page' })
    expect(n.openItemPage).toHaveBeenCalledWith('triage', { itemId: 'verdict', title: 'File the follow-up' })
  })

  it('one new card whose run is in the feed: that run, by its own title', () => {
    const n = nav()
    const rows = [row('verdict', { kind: 'flow_run', status: 'done', flow_run_id: 'fr1', ai_team_member_id: 'triage', title: 'Triage after the call' })]
    openTeammate(['triage'], 'open', source(rows, [card('c1', { source_flow_run_id: 'fr1' })]), n)
    expect(n.openItemPage).toHaveBeenCalledWith('triage', { itemId: 'verdict', title: 'Triage after the call' })
  })

  it('one new work proposal with no run held: its bot’s page', () => {
    const n = nav()
    const proposal = card('p1', { payload: { assignee_ai_member_id: 'writer' } })
    const out = openTeammate(['writer'], 'open', source([], [proposal]), n)
    expect(out).toEqual({ kind: 'bot-page', teammateId: 'writer' })
    expect(n.openPage).toHaveBeenCalledWith('writer')
    expect(n.open).not.toHaveBeenCalled()
  })

  it('several new: the bot’s page of the one on screen with something new, never the Agents page', () => {
    const n = nav()
    const rows = [
      row('a', { ai_team_member_id: 'writer-w1' }),
      row('b', { workspace_id: 'w2', ai_team_member_id: 'writer-w2' }),
    ]
    const roster = [
      { id: 'writer-w1', workspace_id: 'w1', bot_character: null },
      { id: 'writer-w2', workspace_id: 'w2', bot_character: null },
    ]
    const out = openTeammate(['writer-w2', 'writer-w1'], 'open', { ...source(rows), roster }, n)
    expect(out).toEqual({ kind: 'bot-page', teammateId: 'writer-w1' })
    expect(n.openPage).toHaveBeenCalledWith('writer-w1')
    expect(n.open).not.toHaveBeenCalled()
  })

  it('nothing new (an opened row, a running one, nothing at all): the bot’s page', () => {
    const n = nav()
    const rows = [
      row('seen', { ai_team_member_id: 'writer', opened_at: '2026-09-30T09:00:00.000Z' }),
      row('busy', { status: 'running', ai_team_member_id: 'writer' }),
    ]
    const out = openTeammate(['writer', 'writer'], 'open', source(rows), n)
    expect(out).toEqual({ kind: 'bot-page', teammateId: 'writer' })
    expect(n.openPage).toHaveBeenCalledTimes(1)
    expect(n.open).not.toHaveBeenCalled()
  })

  it('nothing new, its page on the teammate in the workspace on screen (one bot for two Writers)', () => {
    const n = { ...nav(), currentWorkspaceId: 'w2' }
    const roster = [
      { id: 'writer-w1', workspace_id: 'w1', bot_character: null },
      { id: 'writer-w2', workspace_id: 'w2', bot_character: null },
    ]
    expect(openTeammate(['writer-w1', 'writer-w2'], 'open', { ...source([]), roster }, n)).toEqual({ kind: 'bot-page', teammateId: 'writer-w2' })
  })

  it('where its page can’t open (a teammate the roster doesn’t hold, no dashboard to answer): nothing opens, and it says it couldn’t find the bot', () => {
    const n = { ...nav(), openPage: vi.fn(() => false), botNotFound: vi.fn() }
    const out = openTeammate(['writer-w1', 'writer-w2', 'writer-w1'], 'open', source([]), n)
    expect(out).toEqual({ kind: 'no-page', teammateIds: ['writer-w1', 'writer-w2'] })
    expect(n.botNotFound).toHaveBeenCalledTimes(1)
    expect(n.open).not.toHaveBeenCalled()
    // `page` the same.
    expect(openTeammate(['writer'], 'page', source([]), n)).toEqual({ kind: 'no-page', teammateIds: ['writer'] })
    expect(n.botNotFound).toHaveBeenCalledTimes(2)
    // With no page to ask at all (and no one to say it to): still nothing.
    const bare = { currentWorkspaceId: 'w1', open: vi.fn() }
    expect(openTeammate(['writer'], 'open', source([]), bare)).toEqual({ kind: 'no-page', teammateIds: ['writer'] })
    expect(bare.open).not.toHaveBeenCalled()
  })

  it('a bot with no teammate to start on (resolveTalk finds none): nothing opens, and it says so', () => {
    const n = { ...nav(), botNotFound: vi.fn() }
    expect(openTeammate([], 'page', source([]), n)).toEqual({ kind: 'no-page', teammateIds: [] })
    expect(n.openPage).not.toHaveBeenCalled()
    expect(n.botNotFound).toHaveBeenCalledTimes(1)
  })

  it('a bot whose page opens never says it couldn’t find it', () => {
    const n = { ...nav(), botNotFound: vi.fn() }
    openTeammate(['writer'], 'open', source([]), n)
    openTeammate(['writer'], 'page', source([]), n)
    expect(n.botNotFound).not.toHaveBeenCalled()
  })

  it('`page` (the bubble’s "Open Writer’s page"): the bot’s page even with one new item', () => {
    const n = nav()
    const out = openTeammate(['writer'], 'page', source([row('draft', { ai_team_member_id: 'writer' })]), n)
    expect(out).toEqual({ kind: 'bot-page', teammateId: 'writer' })
    expect(n.openPage).toHaveBeenCalledWith('writer')
    expect(n.open).not.toHaveBeenCalled()
  })

  it('a card two of the teammates share is one thing waiting: its run opens', () => {
    const rows = [row('verdict', { kind: 'flow_run', status: 'done', flow_run_id: 'fr1', ai_team_member_id: 'triage' })]
    const shared = card('p1', { source_flow_run_id: 'fr1', payload: { assignee_ai_member_id: 'writer' } })
    expect(resolveOpenTeammate(['triage', 'writer'], source(rows, [shared]))).toEqual({
      kind: 'item',
      workItemId: 'verdict',
      workspaceId: 'w1',
      via: 'card',
      // The run's own teammate, not the one the card proposes.
      teammateId: 'triage',
    })
  })

  it('a row you opened already is not new', () => {
    const rows = [row('pass', { kind: 'email_drafts', ai_team_member_id: 'corr', opened_at: '2026-10-01T09:00:00.000Z' })]
    expect(resolveOpenTeammate(['corr'], source(rows))).toBeNull()
  })

  it('no workspace known yet: an item on its own card opens in place', () => {
    const n = { ...nav(), currentWorkspaceId: null }
    openItem('draft', [], source([row('draft', { workspace_id: 'w2', ai_team_member_id: null })]), n)
    expect(n.open).toHaveBeenCalledWith(itemCard('draft', 'Item draft'), null)
    expect(n.open).toHaveBeenCalledTimes(1)
  })
})

describe('openTeammate — talk', () => {
  const [FACE] = BOT_CHARACTERS.map((c) => c.type)
  // One face on three teammates, in three workspaces.
  const roster = [
    { id: 'writer-w1', workspace_id: 'w1', bot_character: FACE },
    { id: 'writer-w2', workspace_id: 'w2', bot_character: FACE },
    { id: 'writer-w3', workspace_id: 'w3', bot_character: FACE },
  ]
  const talkNav = (current: string | null = 'w1') => ({ ...nav(), currentWorkspaceId: current, talk: vi.fn<(t: TalkOutcome) => void>() })
  const ids = ['writer-w3', 'writer-w2', 'writer-w1']

  it('opens the bubble on the one with something new, at its face, and navigates nowhere', () => {
    const n = talkNav()
    const src = { ...source([row('ask', { workspace_id: 'w2', status: 'needs_input', ai_team_member_id: 'writer-w2' })]), roster }
    const out = openTeammate(ids, 'talk', src, n)
    expect(out).toEqual({ kind: 'talk', teammateIds: ids, teammateId: 'writer-w2', face: FACE })
    expect(n.talk).toHaveBeenCalledWith(out)
    expect(n.open).not.toHaveBeenCalled()
  })

  it('with nothing new, starts on the one in the workspace on screen, else the first', () => {
    const src = { ...source([]), roster }
    expect(resolveTalk(ids, src, 'w1').teammateId).toBe('writer-w1')
    expect(resolveTalk(ids, src, 'w2').teammateId).toBe('writer-w2')
    expect(resolveTalk(ids, src, 'elsewhere').teammateId).toBe('writer-w3')
    expect(resolveTalk(ids, src, null).teammateId).toBe('writer-w3')
  })

  it('of several with something new, starts on the one on screen', () => {
    const rows = [
      row('a', { workspace_id: 'w3', ai_team_member_id: 'writer-w3' }),
      row('b', { workspace_id: 'w1', ai_team_member_id: 'writer-w1' }),
    ]
    const src = { ...source(rows), roster }
    expect(resolveTalk(ids, src, 'w1').teammateId).toBe('writer-w1')
    expect(resolveTalk(ids, src, 'w2').teammateId).toBe('writer-w3')
  })

  it('something new beats the workspace on screen', () => {
    const src = { ...source([row('a', { workspace_id: 'w3', ai_team_member_id: 'writer-w3' })]), roster }
    expect(resolveTalk(ids, src, 'w1').teammateId).toBe('writer-w3')
  })

  it('asks for no bubble with nobody to talk to', () => {
    const n = talkNav()
    expect(openTeammate([], 'talk', { ...source([]), roster }, n)).toEqual({ kind: 'talk', teammateIds: [], teammateId: null, face: null })
    expect(n.talk).not.toHaveBeenCalled()
  })
})

describe('openItem: any work item, from anywhere', () => {
  it('a row: on its teammate’s page, in whichever workspace it is', () => {
    const n = nav()
    const rows = [row('one', { ai_team_member_id: 'writer' }), row('two', { workspace_id: 'w2', ai_team_member_id: 'writer' })]
    // Two new for the teammate: `open` would go to the page; one item opens itself.
    expect(openItem('two', ['writer'], source(rows), n)).toEqual({ kind: 'item', workItemId: 'two', workspaceId: 'w2', via: 'row', teammateId: 'writer', on: 'bot-page' })
    expect(n.openItemPage).toHaveBeenCalledWith('writer', { itemId: 'two', title: 'Item two' })
    expect(n.open).not.toHaveBeenCalled()
  })

  it('a row with no teammate: its panel on its own card, in its own workspace (switched to)', () => {
    const n = nav()
    const out = openItem('import', [], source([row('import', { workspace_id: 'w2', kind: 'crm_import' as WorkItem['kind'], ai_team_member_id: null })]), n)
    expect(out).toMatchObject({ kind: 'item', teammateId: null, on: 'card' })
    expect(n.openItemPage).not.toHaveBeenCalled()
    expect(n.open).toHaveBeenCalledWith(itemCard('import', 'Item import'), 'w2')
  })

  it('a card: the item of the run that wrote it, on that run’s teammate’s page', () => {
    const n = nav()
    const verdict = light('verdict', { flow_run_id: 'fr1', ai_team_member_id: 'triage' })
    const out = openItem('c1', ['triage'], source([], [card('c1', { source_flow_run_id: 'fr1', title: 'File it' })], [verdict]), n)
    expect(out).toEqual({ kind: 'item', workItemId: 'verdict', workspaceId: 'w1', via: 'card', teammateId: 'triage', on: 'bot-page' })
    expect(n.openItemPage).toHaveBeenCalledWith('triage', { itemId: 'verdict', title: 'File it' })
  })

  it('a run’s batch (bots v3 1b): its run, by the work item its cards name', () => {
    const n = nav()
    const run = light('job-1', { ai_team_member_id: 'triage', workspace_id: 'w2' })
    const cards = [
      card('c1', { payload: { raised_by_ai_member_id: 'triage', work_item_id: 'job-1' } }),
      card('c2', { payload: { raised_by_ai_member_id: 'triage', work_item_id: 'job-1' } }),
    ]
    expect(openItem('work:job-1', ['triage'], source([], cards, [run]), n)).toMatchObject({ workItemId: 'job-1', workspaceId: 'w2', via: 'card', teammateId: 'triage', on: 'bot-page' })
    expect(n.openItemPage).toHaveBeenCalledWith('triage', expect.objectContaining({ itemId: 'job-1' }))
  })

  it('a card that names its run opens that run, held or not, on the page of the bot that raised it', () => {
    const n = nav()
    const c = { ...card('c1', { payload: { raised_by_ai_member_id: 'triage', work_item_id: 'job-9' } }), workspace_id: 'w1' }
    expect(openItem('c1', ['triage'], source([], [c]), n)).toEqual({ kind: 'item', workItemId: 'job-9', workspaceId: 'w1', via: 'card', teammateId: 'triage', on: 'bot-page' })
  })

  it('a batch of a run with no ledger row opens its run through the card’s flow run', () => {
    const n = nav()
    const verdict = light('verdict', { flow_run_id: 'fr1', ai_team_member_id: 'triage' })
    const cards = [
      { ...card('c1', { source_flow_run_id: 'fr1', payload: { flow_id: 'flow-a' } }), run_key: 'evt-1' },
      { ...card('c2', { source_flow_run_id: 'fr1', payload: { flow_id: 'flow-a' } }), run_key: 'evt-1' },
    ]
    expect(openItem('run:evt-1:flow-a', ['triage'], source([], cards, [verdict]), n)).toMatchObject({ workItemId: 'verdict', workspaceId: 'w1', via: 'card', teammateId: 'triage' })
  })

  it('a settled row the caller holds whole (the bubble’s “Last finished”, a record’s activity row): on its teammate’s page, by its title, no lookup', () => {
    const n = { ...nav(), lookup: vi.fn(async () => null) }
    // The shell's light rows hold open rows only: this one isn't among them.
    const out = openItem('old', ['writer'], source([]), n, { workspaceId: 'w2', title: 'Weekly brief', teammateId: 'writer' })
    expect(out).toEqual({ kind: 'item', workItemId: 'old', workspaceId: 'w2', via: 'row', teammateId: 'writer', on: 'bot-page' })
    expect(n.openItemPage).toHaveBeenCalledWith('writer', { itemId: 'old', title: 'Weekly brief' })
    expect(n.lookup).not.toHaveBeenCalled()
    expect(n.openPage).not.toHaveBeenCalled()
    // Known to have no teammate: on its own card, in its workspace.
    const m = { ...nav(), lookup: vi.fn(async () => null) }
    openItem('old', [], source([]), m, { workspaceId: 'w2', title: 'CRM import', teammateId: null })
    expect(m.open).toHaveBeenCalledWith(itemCard('old', 'CRM import'), 'w2')
    expect(m.lookup).not.toHaveBeenCalled()
    // One the source holds goes by the source, not the caller's word.
    const k = nav()
    openItem('draft', ['writer'], source([row('draft', { ai_team_member_id: 'writer' })]), k, { workspaceId: 'w9', title: 'Other', teammateId: 'someone-else' })
    expect(k.openItemPage).toHaveBeenCalledWith('writer', { itemId: 'draft', title: 'Item draft' })
  })

  it('one nothing on screen holds, whose teammate the caller doesn’t know (a report chip, a plain notice): looked up, then on its bot’s page', async () => {
    const ITEM = '11111111-2222-4333-8444-555555555555'
    const lookup = vi.fn(async (id: string) => ({ workItemId: id, workspaceId: 'w2', teammateId: 'writer', title: 'Weekly brief' }))
    const n = { ...nav(), lookup }
    const out = openItem(ITEM, [], source([]), n, { workspaceId: 'w2', title: 'Reply drafts' })
    expect(out).toMatchObject({ kind: 'looking', workItemId: ITEM })
    expect(n.openItemPage).not.toHaveBeenCalled()
    const settled = await (out as { settled: Promise<unknown> }).settled
    expect(lookup).toHaveBeenCalledWith(ITEM)
    expect(settled).toEqual({ kind: 'item', workItemId: ITEM, workspaceId: 'w2', via: 'row', teammateId: 'writer', on: 'bot-page' })
    // The caller's title wins over the read's.
    expect(n.openItemPage).toHaveBeenCalledWith('writer', { itemId: ITEM, title: 'Reply drafts' })
  })

  it('looked up with no teammate: on its own card, in its own workspace; looked up and not found: where the caller says, else the bot’s page, else here', async () => {
    const ITEM = '11111111-2222-4333-8444-555555555555'
    const n = { ...nav(), lookup: vi.fn(async (id: string) => ({ workItemId: id, workspaceId: 'w2', teammateId: null, title: 'Prospecting run' })) }
    await (openItem(ITEM, [], source([]), n) as { settled: Promise<unknown> }).settled
    expect(n.openItemPage).not.toHaveBeenCalled()
    expect(n.open).toHaveBeenCalledWith(itemCard(ITEM, 'Prospecting run'), 'w2')

    const gone = { ...nav(), lookup: vi.fn(async () => null) }
    await (openItem(ITEM, [], source([]), gone, { workspaceId: 'w2', title: 'Old notice' }) as { settled: Promise<unknown> }).settled
    expect(gone.open).toHaveBeenCalledWith(itemCard(ITEM, 'Old notice'), 'w2')

    const fromBot = { ...nav(), lookup: vi.fn(async () => null) }
    expect(await (openItem(ITEM, ['writer'], source([]), fromBot) as { settled: Promise<unknown> }).settled).toEqual({ kind: 'bot-page', teammateId: 'writer' })

    const bare = { ...nav(), lookup: vi.fn(async () => Promise.reject(new Error('offline'))) }
    await (openItem(ITEM, [], source([]), bare) as { settled: Promise<unknown> }).settled
    expect(bare.open).toHaveBeenCalledWith(itemCard(ITEM, 'Work item'), null)
  })

  it('a notice’s bot is the item’s teammate when nothing else says (known teammate, workspace unknown): no lookup needed for whose, the read’s workspace', async () => {
    const ITEM = '11111111-2222-4333-8444-555555555555'
    const n = { ...nav(), lookup: vi.fn(async (id: string) => ({ workItemId: id, workspaceId: 'w2', teammateId: null, title: null })) }
    // Known to have none, the read's teammate is never taken over the caller's word.
    await (openItem(ITEM, [], source([]), n, { teammateId: null }) as { settled: Promise<unknown> }).settled
    expect(n.openItemPage).not.toHaveBeenCalled()
    const m = { ...nav(), lookup: vi.fn(async (id: string) => ({ workItemId: id, workspaceId: 'w2', teammateId: null, title: null })) }
    await (openItem(ITEM, [], source([]), m, { teammateId: 'writer' }) as { settled: Promise<unknown> }).settled
    expect(m.openItemPage).toHaveBeenCalledWith('writer', { itemId: ITEM, title: 'Work item' })
  })

  it('one the source can’t place (a card whose run isn’t known): its bot’s page, never looked up', () => {
    const n = { ...nav(), lookup: vi.fn(async () => null) }
    const out = openItem('p1', ['writer'], source([], [card('p1', { payload: { assignee_ai_member_id: 'writer' } })]), n)
    expect(out).toEqual({ kind: 'bot-page', teammateId: 'writer' })
    expect(n.openPage).toHaveBeenCalledWith('writer')
    expect(n.lookup).not.toHaveBeenCalled()
    expect(n.open).not.toHaveBeenCalled()
  })

  it('a card the source can’t place, whose bot’s page can’t open: nothing opens (no panel for a card id), and it says it couldn’t find the bot', () => {
    const n = { ...nav(), openPage: vi.fn(() => false), lookup: vi.fn(async () => null), botNotFound: vi.fn() }
    const out = openItem('p1', ['writer'], source([], [card('p1', { payload: { assignee_ai_member_id: 'writer' } })]), n)
    expect(out).toEqual({ kind: 'no-page', teammateIds: ['writer'] })
    expect(n.botNotFound).toHaveBeenCalledTimes(1)
    expect(n.open).not.toHaveBeenCalled()
  })

  it('an item nothing can place, whose bot’s page can’t open: its panel on its own card, here (no "couldn’t find")', async () => {
    const ITEM = '11111111-2222-4333-8444-555555555555'
    const n = { ...nav(), openPage: vi.fn(() => false), lookup: vi.fn(async () => null), botNotFound: vi.fn() }
    const out = openItem(ITEM, ['writer'], source([]), n, { title: 'Draft the follow-up' })
    expect(out.kind).toBe('looking')
    expect(await (out as { settled: Promise<unknown> }).settled).toMatchObject({ kind: 'item', workItemId: ITEM, workspaceId: 'w1', on: 'card' })
    expect(n.openPage).toHaveBeenCalledWith('writer')
    expect(n.open).toHaveBeenCalledWith(itemCard(ITEM, 'Draft the follow-up'), null)
    expect(n.botNotFound).not.toHaveBeenCalled()
  })
})
