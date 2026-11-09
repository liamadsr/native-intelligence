// @vitest-environment jsdom
/**
 * The chat's For you column (docs/plans/always-on-agent.md, decision 13):
 *
 *   • placed by the side panels' space plan (it draws in the mode it is
 *     given), sliding off-screen and inert when off, kept mounted once shown;
 *     it tells the side panels' store whether it has cards;
 *   • the work the bots delivered for you, across all of them, one card
 *     each: its cards and reviews, as each bot's own list has them; never an
 *     approval, a question card or a run parked on a question (P13: those ask
 *     in the chat, chat-ask-card.tsx);
 *   • grouped under their bots: one header per bot (a count past one), its
 *     cards beneath it newest first, each with its own age, the bots in order
 *     of their newest; the cap counts cards, a cut bot keeps one header;
 *   • compact cards (column-compact-card.tsx): a verb pill and a sentence,
 *     the rest (other verbs, ages, the full card) in the focus view a click
 *     opens (its own tests: components/attention/__tests__);
 *   • one store with the bots: settling a card here takes it off the shared
 *     source, so it leaves a bot's For you too (and the other way round);
 *   • with nothing waiting, nothing at all;
 *   • no toggle of its own: the top bar's folds it (the side panels' store,
 *     remembered per device: its own tests);
 *   • a card's impression goes once per card per session, once it's in view;
 *   • its bot's count leaves out a review whose read failed;
 *   • its bottom fade follows a card growing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { WorkItem } from '@/lib/work/types'
import type { LightWorkRow } from '@/lib/work/queries'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** The shell's shared source, as one tiny store both surfaces read. */
const store = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const s = {
    version: 0,
    rows: [] as unknown[],
    cards: [] as unknown[],
    counts: new Map(),
    /** Bots a test adds to the roster (a Correspondent for its drafts). */
    extraRoster: [] as unknown[],
    /** Null: no provider (the column renders nothing). */
    present: true,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit() {
      s.version += 1
      for (const l of [...listeners]) l()
    },
    accept: vi.fn(async (_id: string, _c?: unknown, _t?: unknown) => ({ ok: true, status: 'accepted', identifier: 'ENG-42' }) as unknown),
    start: vi.fn(async (_id: string) => ({ ok: true, status: 'started' }) as unknown),
    dismiss: vi.fn(async (_id: string) => {}),
    reviewed: vi.fn(async (_id: string) => ({ ok: true })),
    dismissReview: vi.fn(async (_id: string) => {}),
    answered: vi.fn((_id: string) => {}),
    openItem: vi.fn(),
    capture: vi.fn(),
  }
  return s
})

vi.mock('@/components/work/agent-work-provider', async () => {
  const React = await import('react')
  let cached: { version: number; value: unknown } | null = null
  const roster = [
    { id: 'writer', name: 'Writer', workspace_id: 'w1', bot_character: 'writer', reachable: true },
    { id: 'triage', name: 'Triage', workspace_id: 'w1', bot_character: 'triage', reachable: true },
  ]
  const read = () => {
    if (cached?.version === store.version) return cached.value
    const value = {
      work: { rows: store.rows, cardRows: [], roster: [...roster, ...store.extraRoster], reviewed: store.reviewed, dismissReview: store.dismissReview, answered: store.answered },
      attention: { items: store.cards, asks: [], editCard: vi.fn(), accept: store.accept, start: store.start, draft: vi.fn(), dismiss: store.dismiss },
      counts: store.counts,
    }
    cached = { version: store.version, value }
    return value
  }
  const useShared = () => {
    React.useSyncExternalStore(store.subscribe, () => store.version)
    return read()
  }
  return {
    useAgentWorkShared: useShared,
    useOptionalAgentWorkShared: () => {
      const value = useShared()
      return store.present ? value : null
    },
  }
})
/** The bots' open email drafts (use-agent-drafts.ts): none unless a test puts some. */
const agentDrafts = vi.hoisted(() => ({ list: [] as unknown[] }))
vi.mock('@/hooks/use-agent-drafts', () => ({ useAgentDrafts: () => agentDrafts.list }))
const opened = vi.hoisted(() => ({ targets: [] as unknown[] }))
vi.mock('@/lib/chat-cards/open-card', async (orig) => ({
  ...((await orig()) as object),
  openTarget: (target: unknown, opts: unknown) => {
    opened.targets.push({ target, opts })
    return true
  },
}))
vi.mock('@/hooks/use-open-teammate', () => ({ useOpenWorkItem: () => store.openItem }))
vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaces: () => ({ workspaces: [], currentId: 'w1' }) }))
vi.mock('@/lib/bots/bot-page', () => ({ openBotPage: vi.fn(() => true) }))
vi.mock('@/components/work/work-item-detail-panel', () => ({ StatusIcon: () => null }))
vi.mock('posthog-js/react', () => ({ usePostHog: () => ({ capture: store.capture }) }))
vi.mock('@/components/capture/action-target-picker', () => ({
  ActionTargetPicker: ({ children }: { children: unknown }) => h('div', null, children as never),
}))

import { countByOwner } from '@/lib/work/agent-work-lanes'
import { forYouColumnEntries, uniqueColumnEntries, type ColumnEntry } from '@/lib/bots/for-you-column'
import { columnTag } from '@/components/attention/column-compact-card'
import { splitCardsByPlace } from '@/lib/attention/chat-asks'
import { botOwners, withBotOwners, withCardOwners } from '@/lib/work/bot-owner'
import { __resetFullRowsForTests } from '@/lib/work/full-rows'
import { __resetColumnImpressionsForTests } from '@/components/attention/attention-card'
import { ForYou, forYouItems } from '@/components/bots/bot-page/for-you'
import { useBotPageOpen } from '@/components/bots/bot-page/use-bot-page-open'
import { BotPageNavContext } from '@/components/bots/bot-page/bot-page-nav'
import { ForYouColumn } from '../for-you-column'
import { getSidePanelState, resetSidePanelStore } from '../../side-panels/side-panel-store'
import type { PanelMode } from '../../side-panels/space-plan'

/** A row as the shell's light read gives it (LIGHT_WORK_ITEM_SELECT): its title and step, no result or deliverables. */
function light(id: string, over: Partial<LightWorkRow> = {}): LightWorkRow {
  return {
    id,
    title: `Item ${id}`,
    current_step: null,
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
    created_at: '2026-10-03T08:00:00.000Z',
    teammate: null,
    ...over,
  }
}
function full(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return {
    ...light(id),
    title: `Item ${id}`,
    actor: 'agent',
    current_step: null,
    progress: {},
    result_summary: null,
    error_message: null,
    skip_reason: null,
    deliverables: [],
    run_key: null,
    agent_run_id: null,
    started_at: null,
    finished_at: null,
    reviewed_at: null,
    last_beat_at: '2026-10-03T08:00:00.000Z',
    deadline_at: null,
    ...over,
  } as WorkItem
}
const card = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspace_id: 'w1',
  member_id: 'm1',
  kind: 'action_card',
  title: `Card ${id}`,
  why: null,
  payload: { raised_by_ai_member_id: 'writer', change_type: 'create', entity_type: 'action' },
  proposal_id: null,
  source_flow_run_id: null,
  status: 'pending',
  expires_at: null,
  created_at: '2026-10-03T08:30:00.000Z',
  ...over,
})

/** A run's parked question, as agent_run.pending_input holds it. */
const PENDING = {
  requestId: 'req-1',
  approveOptionId: 'approve',
  denyOptionId: 'deny',
  questions: [
    {
      question: 'Which Acme contact?',
      header: 'Contact',
      options: [
        { label: 'Dana', description: 'CTO' },
        { label: 'Lee', description: 'VP Sales' },
      ],
      multiSelect: false,
    },
  ],
  askedAt: '2026-10-03T09:30:00.000Z',
}
/** A light row parked on that question. */
function asking(id: string, over: Partial<LightWorkRow> = {}): LightWorkRow {
  return light(id, {
    status: 'needs_input',
    agent_run_id: `run-${id}`,
    created_at: '2026-10-03T09:30:00.000Z',
    needs: { kind: 'input', questions: [{ question: 'Which Acme contact?', options: [{ label: 'Dana' }, { label: 'Lee' }] }] },
    ...over,
  })
}
/**
 * The item route (each row whole; a question's run parked on it, unless
 * `noRun`; a 500 for `failRead`) and the run's respond route, as fetch.
 */
function routes(over: { failRead?: Set<string>; noRun?: Set<string> } = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (u.endsWith('/respond')) return new Response(JSON.stringify({ ok: true, status: 'queued' }), { status: 200 })
    const id = decodeURIComponent(u.split('/').pop()!)
    if (init?.method === 'PATCH') return new Response(JSON.stringify({ ok: true }), { status: 200 })
    if (over.failRead?.has(id)) return new Response('{}', { status: 500 })
    const row = (store.rows as LightWorkRow[]).find((r) => r.id === id)
    const question = row?.status === 'needs_input'
    const run = question && !over.noRun?.has(id) ? { id: `run-${id}`, status: 'needs_input', pending_input: PENDING } : null
    const item = full(id, { status: row?.status ?? 'needs_review', title: question ? 'V2CHECK question' : `Item ${id}` })
    return new Response(JSON.stringify({ item, run }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** What the shell holds: its rows and cards, and countByOwner over them, as the provider's. */
function hold(rows: Array<WorkItem | LightWorkRow>, cards: ReturnType<typeof card>[] = []) {
  store.rows = rows
  store.cards = cards
  store.counts = countByOwner(rows, cards as never)
  store.emit()
}

// ── The chat's width (jsdom lays nothing out) and its ResizeObserver ─────────
let chatWidth = 1400
const observers: Array<{ cb: ResizeObserverCallback; els: Set<Element> }> = []
class FakeResizeObserver {
  private entry: { cb: ResizeObserverCallback; els: Set<Element> }
  constructor(cb: ResizeObserverCallback) {
    this.entry = { cb, els: new Set() }
    observers.push(this.entry)
  }
  observe(el: Element) {
    this.entry.els.add(el)
  }
  unobserve(el: Element) {
    this.entry.els.delete(el)
  }
  disconnect() {
    this.entry.els.clear()
  }
}
/** The chat resized to `width`: every observer of the column's box hears it. */
async function resizeChat(width: number) {
  chatWidth = width
  await act(async () => {
    for (const o of observers) {
      for (const el of o.els) {
        if (el.hasAttribute('data-for-you-column-root')) {
          o.cb([{ target: el, contentRect: { width } } as unknown as ResizeObserverEntry], o as unknown as ResizeObserver)
        }
      }
    }
  })
}
const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  for (const fn of [store.accept, store.start, store.dismiss, store.reviewed, store.dismissReview, store.answered, store.openItem, store.capture]) fn.mockClear()
  store.present = true
  hold([])
  __resetFullRowsForTests()
  __resetColumnImpressionsForTests()
  window.localStorage.clear()
  resetSidePanelStore()
  chatWidth = 1400
  observers.length = 0
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute('data-for-you-column-root') ? chatWidth : 0
    },
  })
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-03T12:00:00.000Z'))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth)
})

/** Lets the column's lazily fetched module land and render (loaded here first: a busy run is slow to import it). */
async function settle() {
  await import('@/components/attention/for-you-column-panel')
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

const column = () => container.querySelector<HTMLElement>('section[aria-label="For you"][data-for-you-column]')
const columnCards = () => Array.from(container.querySelectorAll<HTMLElement>('[data-for-you-card]')).map((el) => el.getAttribute('data-for-you-card'))
/** Each card on show and its tag (where it came from), in order. */
const columnTags = () =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-for-you-card]')).map((el) => [
    el.getAttribute('data-for-you-card'),
    el.querySelector('[data-compact-tag]')?.textContent ?? null,
  ])
/** Headers or labels over the cards: none (Liam, 11-09). */
const headers = () => container.querySelectorAll('[data-for-you-group], [data-for-you-source], [data-for-you-area]').length
/** A writer's card raised by `bot`, `minutesAgo` before noon. */
const cardBy = (id: string, bot: string, minutesAgo: number) =>
  card(id, {
    created_at: new Date(Date.parse('2026-10-03T12:00:00.000Z') - minutesAgo * 60_000).toISOString(),
    payload: { raised_by_ai_member_id: bot, change_type: 'create', entity_type: 'action' },
  })
const within = (el: HTMLElement | null, name: string) =>
  [...(el?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name)

async function renderColumn(mode: PanelMode = 'room') {
  await act(async () => root.render(h('div', { style: { position: 'relative' } }, h(ForYouColumn, { mode }))))
  await settle()
}
const columnRoot = () => container.querySelector<HTMLElement>('[data-for-you-column-root]')

describe('the bots\' email drafts, one card each (Phase 6)', () => {
  const draft = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    workspace_id: 'w1',
    subject: `Re: ${id}`,
    to: 'dana@acme.com',
    provider_thread_id: `thr-${id}`,
    provider_draft_id: `msg-${id}`,
    folder: 'inbox',
    created_at: '2026-10-03T08:00:00.000Z',
    ...over,
  })
  const roster = [
    { id: 'agent', name: 'Assistant', workspace_id: 'w1', bot_character: null, reachable: true, is_system: true, system_key: 'assistant' },
    { id: 'corr', name: 'Correspondent', workspace_id: 'w1', bot_character: 'correspondent', reachable: true, role: 'correspondent' as const },
  ]

  it('each open draft is its own entry, under the workspace\'s Correspondent', () => {
    const entries = forYouColumnEntries({ roster: roster as never, counts: new Map(), rows: [], cards: [], drafts: [draft('d1'), draft('d2', { created_at: '2026-10-03T09:00:00.000Z' })] as never })
    expect(entries.map((e) => [e.id, e.kind, e.source.name])).toEqual([
      ['draft:d2', 'draft', 'Correspondent'],
      ['draft:d1', 'draft', 'Correspondent'],
    ])
  })

  it('with no Correspondent, under the agent, labelled Mail; with neither, none', () => {
    const entries = forYouColumnEntries({ roster: [roster[0]] as never, counts: new Map(), rows: [], cards: [], drafts: [draft('d1')] as never })
    expect(entries).toMatchObject([{ kind: 'draft', source: { teammateId: 'agent', agent: true }, area: 'Mail' }])
    expect(forYouColumnEntries({ roster: [], counts: new Map(), rows: [], cards: [], drafts: [draft('d1')] as never })).toEqual([])
  })

  it('the card says whose reply it is, and its verb opens Mail on that draft', async () => {
    agentDrafts.list = [draft('d1')]
    opened.targets = []
    store.extraRoster = [roster[1]]
    hold([])
    try {
      await renderColumn()
      const sentence = container.querySelector('[data-for-you-card="draft:d1"] [data-compact-sentence]')!.textContent
      expect(sentence).toBe('Reviewthe reply to dana@acme.com: “Re: d1”')
      await act(async () => container.querySelector<HTMLButtonElement>('[data-for-you-card="draft:d1"] [data-compact-verb]')!.click())
      expect(opened.targets).toEqual([
        { target: { type: 'mail', folder: 'inbox', threadId: 'thr-d1', draftId: 'msg-d1', title: 'Re: d1' }, opts: { from: 'card', workspaceId: 'w1' } },
      ])
    } finally {
      agentDrafts.list = []
      store.extraRoster = []
    }
  })
})

describe('forYouColumnEntries', () => {
  it('lists every bot’s delivered work (cards, reviews), newest first, each with its bot, each once; never an ask (P13)', () => {
    const rows = [full('r1', { finished_at: '2026-10-03T09:00:00.000Z' }), light('q1', { status: 'needs_input' })]
    const cards = [
      card('w-old', { created_at: '2026-10-03T07:00:00.000Z' }),
      card('t-new', { created_at: '2026-10-03T10:00:00.000Z', payload: { raised_by_ai_member_id: 'triage' } }),
      // A post draft is delivered work: For you's, though its kind is `question`.
      card('post', { kind: 'question', created_at: '2026-10-03T06:00:00.000Z', payload: { raised_by_ai_member_id: 'writer', post_draft: { text: 'Exports are 3x faster.', surface: 'x' } } }),
      // Asks are the chat's: an approval and a question card never list here, whatever reaches the column.
      card('ap', { kind: 'approval', created_at: '2026-10-03T11:00:00.000Z', payload: { raised_by_ai_member_id: 'writer', approval_id: 'a1', tool: 'publish_post' } }),
      card('ask', { kind: 'question', created_at: '2026-10-03T11:30:00.000Z', payload: { raised_by_ai_member_id: 'writer' } }),
    ]
    // As the shared source hands them over (the GET's `items`, useAttentionItems): For you's half only.
    const forYou = splitCardsByPlace(cards as never).forYou
    const entries = forYouColumnEntries({
      roster: [
        { id: 'writer', name: 'Writer', bot_character: 'writer', reachable: true },
        { id: 'triage', name: 'Triage', bot_character: 'triage', reachable: true },
      ],
      counts: countByOwner(rows, forYou as never),
      rows,
      cards: forYou as never,
    })
    // Delivered work only: the post draft and the review. The suggested actions, the approval and the question ask in the chat.
    expect(entries.map((e) => [e.id, e.kind, e.source.name])).toEqual([
      ['r1', 'review', 'Writer'],
      ['post', 'card', 'Writer'],
    ])
  })

  it('for each bot, exactly its own list (new, then seen), questions left to the chat', () => {
    const rows = [
      full('r1', { finished_at: '2026-10-03T09:00:00.000Z' }),
      light('q1', { status: 'needs_input', created_at: '2026-10-03T10:00:00.000Z' }),
      // Seen: opened since it started waiting.
      light('q2', { status: 'needs_input', opened_at: '2026-10-03T11:00:00.000Z' }),
    ]
    const cards = [card('c1', { created_at: '2026-10-03T07:00:00.000Z' })]
    const counts = countByOwner(rows, cards as never)
    const entries = forYouColumnEntries({
      roster: [{ id: 'writer', name: 'Writer', bot_character: 'writer', reachable: true }],
      counts,
      rows,
      cards: cards as never,
    })
    const own = forYouItems('writer', counts, rows, cards as never)
    expect(new Set(entries.map((e) => e.id))).toEqual(new Set([...own.fresh, ...own.seen].map((i) => i.id)))
    // The two parked runs still wait on the person (the work page counts them); they ask in the chat.
    expect(entries).toHaveLength(counts.get('tm:writer')!.needsYou - 2)
    expect(entries.map((e) => [e.id, e.kind, 'seen' in e ? e.seen : null])).toEqual([
      ['r1', 'review', false],
      ['c1', 'card', null],
    ])
  })

  it('one face: area work lists under the agent, each card labelled with its area; a custom bot keeps its own group, unlabelled', () => {
    const roster = [
      { id: 'as', workspace_id: 'w1', name: 'Joseph', bot_character: 'chat' as const, reachable: true, is_system: true, system_key: 'assistant' },
      { id: 'mail', workspace_id: 'w1', name: 'Mail', bot_character: 'mail' as const, reachable: true, is_system: true, system_key: 'mail' },
      { id: 'writer', workspace_id: 'w1', name: 'Writer', bot_character: 'writer' as const, reachable: true, is_system: false, system_key: null },
    ]
    const owners = botOwners(roster, { complete: true })
    const rows = withBotOwners(
      [
        full('m1', { ai_team_member_id: 'mail', finished_at: '2026-10-03T09:00:00.000Z' }),
        full('w1r', { ai_team_member_id: 'writer', finished_at: '2026-10-03T08:10:00.000Z' }),
      ],
      owners,
    )
    const cards = withCardOwners([card('cap', { created_at: '2026-10-03T10:00:00.000Z', payload: { raised_by_ai_member_id: 'mail' } })], owners)
    const entries = forYouColumnEntries({ roster, counts: countByOwner(rows, cards as never), rows, cards: cards as never })
    expect(entries.map((e) => [e.id, e.source.teammateId, e.source.name, e.area ?? null])).toEqual([
      ['cap', 'as', 'Joseph', 'Mail'],
      ['m1', 'as', 'Joseph', 'Mail'],
      ['w1r', 'writer', 'Writer', null],
    ])
    expect(entries[0].source).toMatchObject({ agent: true })
    expect(entries[0].source).not.toHaveProperty('face')
    expect(entries.some((e) => e.source.teammateId === 'mail')).toBe(false)
  })

  it('leaves out a bot you can’t reach (the crew’s rule)', () => {
    const cards = [card('c1')]
    const entries = forYouColumnEntries({
      roster: [{ id: 'writer', name: 'Writer', bot_character: 'writer', reachable: false }],
      counts: countByOwner([], cards as never),
      rows: [],
      cards: cards as never,
    })
    expect(entries).toEqual([])
  })
})

describe('uniqueColumnEntries', () => {
  const src = (id: string) => ({ teammateId: id, name: id, face: null })
  const entry = (id: string, bot: string, at: string) => ({ kind: 'card', id, at, card: card(id), source: src(bot) }) as unknown as ColumnEntry

  it('one flat list in the order given (newest first), not grouped by bot', () => {
    const list = uniqueColumnEntries([
      entry('t1', 'triage', '2026-10-03T11:00:00.000Z'),
      entry('w1', 'writer', '2026-10-03T10:00:00.000Z'),
      entry('t2', 'triage', '2026-10-03T09:00:00.000Z'),
    ])
    expect(list.map((e) => e.id)).toEqual(['t1', 'w1', 't2'])
  })

  it('a thing listed under two bots shows once, where it was first listed', () => {
    const list = uniqueColumnEntries([
      entry('c1', 'writer', '2026-10-03T11:00:00.000Z'),
      entry('c1', 'triage', '2026-10-03T11:00:00.000Z'),
      entry('t1', 'triage', '2026-10-03T10:00:00.000Z'),
    ])
    expect(list.map((e) => [e.id, e.source.teammateId])).toEqual([
      ['c1', 'writer'],
      ['t1', 'triage'],
    ])
  })
})

describe('columnTag: where a card came from, on the card', () => {
  it('the area the agent’s card came from, else the bot’s name', () => {
    const source = { teammateId: 'agent', name: 'Assistant', face: null, agent: true }
    expect(columnTag({ kind: 'card', id: 'a', at: '', card: card('a'), source, area: 'Captures' } as never)).toBe('Captures')
    expect(columnTag({ kind: 'card', id: 'b', at: '', card: card('b'), source } as never)).toBe('Assistant')
    expect(columnTag({ kind: 'card', id: 'c', at: '', card: card('c'), source: { teammateId: 'writer', name: 'Writer', face: null } } as never)).toBe('Writer')
  })
})

describe('ForYouColumn', () => {
  it('draws where the space plan puts it; off, it slides away inert but stays mounted once shown', async () => {
    hold([], [card('c1')])
    await renderColumn('off')
    // Never shown yet: nothing mounted.
    expect(columnRoot()).toBeNull()
    await renderColumn('room')
    expect(columnRoot()!.getAttribute('data-for-you-column-root')).toBe('room')
    expect(columnRoot()!.hasAttribute('inert')).toBe(false)
    expect(columnCards()).toEqual(['c1'])
    await renderColumn('off')
    expect(columnRoot()!.hasAttribute('inert')).toBe(true)
    expect(columnRoot()!.className).toContain('-translate-x-[calc(100%+1rem)]')
    // It slides: the transition is on `translate`, what translate-x-* sets.
    expect(columnRoot()!.className).toContain('transition-[translate,visibility]')
    // Its cards stay mounted (what was half done in one survives).
    expect(columnCards()).toEqual(['c1'])
  })

  it('no flap: a click-through column whose cards, pill and buttons take the pointer themselves', async () => {
    // Past one page, so Show more is there too.
    hold([], Array.from({ length: 32 }, (_, i) => card(`c${i}`, { created_at: new Date(Date.parse('2026-10-03T08:00:00.000Z') - i * 60_000).toISOString() })))
    await renderColumn('float')
    const pe = (el: Element | null) => el!.className.match(/(^|\s)pointer-events-(none|auto)(\s|$)/)?.[2]
    // The column, its section and its scroller draw nothing and take no pointer: the chat behind the gaps stays clickable.
    expect(pe(columnRoot())).toBe('none')
    expect(pe(column())).toBe('none')
    const scroller = container.querySelector('[data-for-you-scroller]')
    expect(pe(scroller)).toBe('none')
    for (const el of [columnRoot()!, column()!, scroller!]) expect(el.className).not.toMatch(/(^|\s)(bg-|backdrop-)/)
    // What takes the pointer: each card and Show more.
    const boxes = [...container.querySelectorAll<HTMLElement>('[data-for-you-card-box]')]
    expect(boxes.length).toBeGreaterThan(0)
    for (const box of boxes) {
      expect(pe(box)).toBe('auto')
      expect(box.className).toMatch(/(^|\s)relative(\s|$)/)
    }
    const more = container.querySelector('[data-for-you-more]')
    expect(pe(more)).toBe('auto')
  })

  it('tells the side panels whether it has anything to show', async () => {
    await renderColumn('off')
    expect(getSidePanelState().leftContent).toBe(false)
    await act(async () => hold([], [card('c1')]))
    expect(getSidePanelState().leftContent).toBe(true)
    await act(async () => hold([], []))
    expect(getSidePanelState().leftContent).toBe(false)
  })

  it('renders what the shared source holds, each under its bot, the bots newest first', async () => {
    hold(
      [full('r1', { finished_at: '2026-10-03T09:00:00.000Z' })],
      [
        card('w-old', { created_at: '2026-10-03T07:00:00.000Z' }),
        card('t-new', { created_at: '2026-10-03T10:00:00.000Z', payload: { raised_by_ai_member_id: 'triage', change_type: 'create', entity_type: 'action' } }),
      ],
    )
    await renderColumn()
    expect(columnCards()).toEqual(['t-new', 'r1', 'w-old'])
    // One list, no headers: each card tagged with where it came from.
    expect(headers()).toBe(0)
    expect(columnTags()).toEqual([
      ['t-new', 'Triage'],
      ['r1', 'Writer'],
      ['w-old', 'Writer'],
    ])
    // Compact cards: a verb and one sentence each.
    expect(container.querySelector('[data-for-you-card="r1"] [data-compact-card="r1"]')).not.toBeNull()
    expect(container.querySelector('[data-for-you-card="r1"] [data-review-card]')).toBeNull()
    expect(container.querySelector('[data-for-you-card="t-new"] [data-compact-sentence]')!.textContent).toBe('Add“Card t-new” to your to-dos')
  })

  it('reads a light review’s whole row (once) before showing its card', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ item: full('r2') }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    hold([light('r2')])
    await renderColumn()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('/api/account/activity/r2')
    expect(columnCards()).toEqual(['r2'])
  })

  it('a light review opens what it delivered, not its run’s chat (its title is no sign it was read whole)', async () => {
    const doc = { type: 'document' as const, id: 'doc-1', label: 'Weekly Groomer' }
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ item: full('r3', { title: 'Weekly Groom', deliverables: [doc], needs: { kind: 'review', verb: 'check' } }) }), {
          status: 200,
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    opened.targets = []
    store.openItem.mockClear()
    hold([light('r3', { title: 'Weekly Groom' })])
    await renderColumn()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-for-you-card="r3"] [data-compact-sentence]')!.textContent).toBe('Open“Weekly Groomer”')
    await act(async () => container.querySelector<HTMLButtonElement>('[data-for-you-card="r3"] [data-compact-verb]')!.click())
    expect(opened.targets).toEqual([{ target: { type: 'document', id: 'doc-1', title: 'Weekly Groomer' }, opts: { from: 'work-item', workspaceId: null } }])
    expect(store.openItem).not.toHaveBeenCalled()
  })

  it('settling a card here takes it off the shared source, so it leaves the bot’s For you too', async () => {
    store.accept.mockImplementation(async (id: string) => {
      hold([full('r1')], (store.cards as ReturnType<typeof card>[]).filter((c) => c.id !== id))
      return { ok: true, status: 'accepted', identifier: 'ENG-42' }
    })
    store.reviewed.mockImplementation(async (id: string) => {
      hold((store.rows as WorkItem[]).filter((r) => r.id !== id), store.cards as ReturnType<typeof card>[])
      return { ok: true }
    })
    hold([full('r1')], [card('c1')])
    const page = document.createElement('div')
    document.body.appendChild(page)
    const pageRoot = createRoot(page)
    function BotPage() {
      const open = useBotPageOpen('writer')
      return h(ForYou, { teammateId: 'writer', name: 'Writer', rows: [], chips: {}, open })
    }
    await act(async () => pageRoot.render(h(BotPageNavContext.Provider, { value: { openItem: () => {} } as never }, h(BotPage))))
    await renderColumn()
    expect(columnCards()).toEqual(['c1', 'r1'])
    // The bot's page holds both: its deck pages them (the review first, then the card).
    const pageCount = () => page.querySelector('section[aria-label="For you"] h2')!.textContent
    expect(pageCount()).toContain('2')
    expect(page.textContent).toContain('1/2')

    const c1 = container.querySelector<HTMLElement>('[data-for-you-card="c1"]')
    // The card's verb, done from its pill.
    await act(async () => within(c1, 'Add')!.click())
    expect(store.accept).toHaveBeenCalledWith('c1', expect.any(Object), undefined)
    expect(store.capture).toHaveBeenCalledWith('attention_card_accepted', expect.objectContaining({ surface: 'column' }))
    await settle()
    expect(columnCards()).toEqual(['r1'])
    expect(pageCount()).toContain('1')
    expect(page.textContent).not.toContain('1/2')
    expect(page.textContent).not.toContain('Card c1')

    // Reviewed is in its focus view's menu.
    await act(async () => container.querySelector<HTMLElement>('[data-compact-card="r1"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[data-compact-row="reviewed"]')!.click())
    expect(store.reviewed).toHaveBeenCalledWith('r1')
    await settle()
    // Nothing left: nothing at all, in either place.
    expect(column()).toBeNull()
    expect(page.textContent).toContain('Nothing from Writer is waiting on you.')
    await act(async () => pageRoot.unmount())
    page.remove()
    store.accept.mockReset()
    store.reviewed.mockReset()
  })

  it('a run parked on a question asks in the chat, never here (P13): a review and a question are one card, the pill 1', async () => {
    routes()
    hold([full('r1', { finished_at: '2026-10-03T09:00:00.000Z' }), asking('q1')])
    const page = document.createElement('div')
    document.body.appendChild(page)
    const pageRoot = createRoot(page)
    function BotPage() {
      const open = useBotPageOpen('writer')
      return h(ForYou, { teammateId: 'writer', name: 'Writer', rows: [], chips: {}, open })
    }
    await act(async () => pageRoot.render(h(BotPageNavContext.Provider, { value: { openItem: () => {} } as never }, h(BotPage))))
    await renderColumn()
    try {
      expect(columnCards()).toEqual(['r1'])
      expect(columnTags()).toEqual([['r1', 'Writer']])
      expect(container.querySelector('[data-question-card]')).toBeNull()
      // The bot's page lists the review alone too.
      expect(page.querySelector('section[aria-label="For you"] h2')!.textContent).toContain('1')
    } finally {
      await act(async () => pageRoot.unmount())
      page.remove()
    }
  })

  it('a question alone: nothing at all (no column, no empty state)', async () => {
    routes()
    hold([asking('q1')])
    await renderColumn()
    expect(column()).toBeNull()
  })

  it('a card settled in the bots leaves the column', async () => {
    hold([], [card('c1'), card('c2', { created_at: '2026-10-03T08:00:00.000Z' })])
    await renderColumn()
    expect(columnCards()).toEqual(['c1', 'c2'])
    await act(async () => hold([], [card('c2', { created_at: '2026-10-03T08:00:00.000Z' })]))
    await settle()
    expect(columnCards()).toEqual(['c2'])
  })

  it('renders nothing with nothing waiting, or with no shared source', async () => {
    await renderColumn()
    expect(column()).toBeNull()
    expect(container.querySelector('section')).toBeNull()
    store.present = false
    await act(async () => hold([], [card('c1')]))
    await renderColumn()
    expect(container.querySelector('[data-for-you-column-root]')).toBeNull()
  })

  it('caps what it mounts and shows the rest a page at a time', async () => {
    const many = Array.from({ length: 34 }, (_, i) => card(`c${i}`, { created_at: new Date(Date.parse('2026-10-03T08:00:00.000Z') - i * 60_000).toISOString() }))
    hold([], many)
    await renderColumn()
    expect(columnCards()).toHaveLength(30)
    const more = container.querySelector<HTMLButtonElement>('[data-for-you-more]')!
    expect(more.textContent).toBe('Show 4 more')
    await act(async () => more.click())
    expect(columnCards()).toHaveLength(34)
    expect(container.querySelector('[data-for-you-more]')).toBeNull()
  })

  it('two cards from one bot: no header, each tagged with the bot, each with its own age (in its focus view)', async () => {
    hold([], [cardBy('w1', 'writer', 5), cardBy('w2', 'writer', 120)])
    await renderColumn()
    expect(columnTags()).toEqual([
      ['w1', 'Writer'],
      ['w2', 'Writer'],
    ])
    expect(headers()).toBe(0)
    const age = async (id: string) => {
      await act(async () => container.querySelector<HTMLElement>(`[data-compact-card="${id}"]`)!.click())
      const meta = document.querySelector('[data-compact-meta]')?.textContent
      await act(async () => document.querySelector<HTMLElement>('[data-column-focus-backdrop]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
      return meta
    }
    expect(await age('w1')).toBe('Writer · 5m')
    expect(await age('w2')).toBe('Writer · 2h')
  })

  it('two bots: one list, newest first, each card tagged with its bot (no headers)', async () => {
    hold([], [cardBy('w-old', 'writer', 300), cardBy('t-mid', 'triage', 60), cardBy('w-new', 'writer', 10)])
    await renderColumn()
    expect(columnTags()).toEqual([
      ['w-new', 'Writer'],
      ['t-mid', 'Triage'],
      ['w-old', 'Writer'],
    ])
    expect(headers()).toBe(0)
  })

  it('the cap counts cards: the first page, then the rest, newest first across bots', async () => {
    // Writer: 33, Triage: 3 older; the first page is 30 of the writer's.
    const many = [
      ...Array.from({ length: 33 }, (_, i) => cardBy(`w${i}`, 'writer', i + 1)),
      ...Array.from({ length: 3 }, (_, i) => cardBy(`t${i}`, 'triage', 100 + i)),
    ]
    hold([], many)
    await renderColumn()
    expect(columnCards()).toHaveLength(30)
    expect(columnTags().every(([, tag]) => tag === 'Writer')).toBe(true)
    const more = container.querySelector<HTMLButtonElement>('[data-for-you-more]')!
    expect(more.textContent).toBe('Show 6 more')
    await act(async () => more.click())
    expect(columnCards()).toHaveLength(36)
    expect(columnTags().slice(-3)).toEqual([
      ['t0', 'Triage'],
      ['t1', 'Triage'],
      ['t2', 'Triage'],
    ])
    expect(headers()).toBe(0)
  })

  it('stands under its top-bar button: its left edge at the bar’s inset, just under the bar (Liam, 11-09)', async () => {
    hold([], [card('c1')])
    await renderColumn()
    // The web's bar starts its controls 4px in (top-bar/insets.ts); the column lines up with them.
    expect(columnRoot()!.style.left).toBe('4px')
    // Half a gutter under the bar, not below its 24px blur (the blur is under the panels now).
    expect(columnRoot()!.style.top).toBe('calc(var(--chat-top-inset, 0px) + 6px)')
  })

  it('has no toggle of its own: the top bar’s folds it', async () => {
    hold([], [card('c1')])
    await renderColumn()
    const loose = [...column()!.querySelectorAll('button')].filter((b) => !b.closest('[data-for-you-card-box]'))
    expect(loose).toEqual([])
    expect(container.querySelector('[data-for-you-toggle]')).toBeNull()
  })

  it('sends a card’s impression once it’s in view, once per card for the session (not again on a fold)', async () => {
    const ios: Array<{ cb: IntersectionObserverCallback; els: Set<Element> }> = []
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        private entry: { cb: IntersectionObserverCallback; els: Set<Element> }
        constructor(cb: IntersectionObserverCallback) {
          this.entry = { cb, els: new Set() }
          ios.push(this.entry)
        }
        observe(el: Element) {
          this.entry.els.add(el)
        }
        disconnect() {
          this.entry.els.clear()
        }
      },
    )
    const inView = (id: string) =>
      act(async () => {
        for (const io of [...ios]) {
          for (const el of [...io.els]) {
            if (el.closest(`[data-for-you-card="${id}"]`)) io.cb([{ target: el, isIntersecting: true } as unknown as IntersectionObserverEntry], io as never)
          }
        }
      })
    const impressions = () => store.capture.mock.calls.filter(([e]) => e === 'attention_card_impression').map(([, p]) => p as Record<string, unknown>)
    hold([full('r1')], [card('c1'), card('c2', { created_at: '2026-10-03T08:00:00.000Z' })])
    await renderColumn()
    expect(columnCards()).toEqual(['c1', 'r1', 'c2'])
    expect(impressions()).toEqual([])

    await inView('c1')
    await inView('r1')
    expect(impressions()).toEqual([
      expect.objectContaining({ kind: 'action_card', surface: 'column' }),
      expect.objectContaining({ kind: 'work_review', surface: 'column' }),
    ])

    // Folded and shown again: nothing new for those already seen.
    await renderColumn('off')
    await renderColumn('room')
    await inView('c1')
    await inView('r1')
    expect(impressions()).toHaveLength(2)
    await inView('c2')
    expect(impressions()).toHaveLength(3)
  })

  it('a review whose read failed doesn’t show', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    hold([light('bad')], [card('c1')])
    await renderColumn()
    expect(columnCards()).toEqual(['c1'])
    expect(columnTags()).toEqual([['c1', 'Writer']])
  })

  it('floating, it stands clear of the composer', async () => {
    const strip = document.createElement('div')
    strip.id = 'dial8-chat-strip-slot'
    const dock = document.createElement('div')
    dock.setAttribute('data-chat-composer-dock', '')
    Object.defineProperty(dock, 'offsetHeight', { configurable: true, value: 140 })
    strip.appendChild(dock)
    document.body.appendChild(strip)
    try {
      hold([], [card('c1')])
      await renderColumn('float')
      expect(columnRoot()!.style.bottom).toBe('152px')
    } finally {
      strip.remove()
    }
  })

  it('watches its content too, so a card growing turns the bottom fade on', async () => {
    hold([], [card('c1')])
    await renderColumn()
    const scroller = container.querySelector<HTMLElement>('[data-for-you-scroller]')!
    const list = scroller.querySelector('ul')!
    expect(observers.some((o) => o.els.has(list))).toBe(true)
    expect(scroller.hasAttribute('data-for-you-fades')).toBe(false)

    // The card grew past the scroller's height; only the content resized.
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 300 })
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 500 })
    await act(async () => {
      for (const o of observers) if (o.els.has(list)) o.cb([{ target: list } as unknown as ResizeObserverEntry], o as unknown as ResizeObserver)
    })
    expect(scroller.getAttribute('data-for-you-fades')).toBe('bottom')
  })
})
