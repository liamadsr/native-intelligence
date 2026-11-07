// @vitest-environment jsdom
/**
 * A bot's page's lists and About (docs/plans/bots-v4.md Phase 1b).
 *
 *   Working on   its running trees; Stop only on the run that was started and
 *                only where something can stop it, handing the shell's Stop
 *                the row itself, so the request goes in the row's own
 *                workspace (useAgentWork's `stop`, whose test pins the
 *                header); "Waiting on Writer" for a run that handed work on;
 *                its own row opens its item on this page, in this window
 *                (Phase 2); a row of another bot opens on that bot's page
 *                (useOpenWorkItem, with that bot named), and says so only
 *                when the roster holds it; its empty state.
 *   Done lately  its settled trees, newest first, handoffs folded under their
 *                run, how each ended; its empty state, which says the window
 *                is by when a run started.
 *   About        what it is, its skills and autonomy; "Attempts paused" with
 *                Resume only for an owner or admin; Customize opens the agent
 *                editor seam on this bot.
 *   The cards    each section a card of its own (BotPageCard): named for its
 *                title, a small header with its count and hint, a list that
 *                scrolls inside the card once long; an empty one compact;
 *                the column (BotWork) stacks For you, Working on, Done lately,
 *                Notices (a bot you may reach: Phase 4c) and About in that
 *                order, and loads as blank cards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { WorkItem } from '@/lib/work/types'
import type { RosterTeammate } from '@/lib/work/agent-roster'
import type { TeammateAbout } from '@/lib/work/teammate-about'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const shared = vi.hoisted(() => ({
  /** The page's own item opener (the bot card's BotPageNav). */
  pageOpenItem: vi.fn(),
  openBotPage: vi.fn((_id: string, _opts?: unknown) => true),
  openWorkItem: vi.fn((_id: string, _ids: readonly string[], _known?: unknown) => ({ kind: 'item' })),
  editorTargets: [] as unknown[],
  editorOpen: vi.fn(),
  roster: [{ id: 'writer', name: 'Writer' }, { id: 'researcher', name: 'Researcher' }] as Array<{ id: string; name: string }>,
}))
vi.mock('@/components/work/agent-work-provider', () => ({
  useAgentWorkShared: () => ({
    work: { roster: shared.roster, rows: [], cardRows: [], stop: vi.fn(), stopping: new Set<string>(), resumeRole: vi.fn(async () => true) },
    attention: { items: [], asks: [] },
    counts: new Map(),
  }),
}))
vi.mock('../bot-page-nav', () => ({ useBotPageNav: () => ({ openItem: shared.pageOpenItem }) }))
vi.mock('@/hooks/use-open-teammate', () => ({ useOpenWorkItem: () => shared.openWorkItem }))
vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaces: () => ({ workspaces: [], currentId: 'w1' }), useWorkspaceId: () => 'w1' }))
vi.mock('@/lib/bots/bot-page', () => ({ openBotPage: shared.openBotPage }))
vi.mock('@/components/work/work-item-detail-panel', () => ({ StatusIcon: () => null }))
vi.mock('@/components/attention/review-card', () => ({ AttemptedChip: () => h('span', { 'data-attempted': '' }, 'Attempted') }))
vi.mock('../agent-editor-seam', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-editor-seam')>()),
  useAgentEditor: (target: unknown) => {
    shared.editorTargets.push(target)
    return { open: shared.editorOpen, editor: null }
  },
}))

import type { BotWork as BotWorkData } from '@/hooks/use-bot-work'
import { partitionForOwner } from '@/lib/work/agent-work-lanes'
import { About } from '../about'
import { BOT_PAGE_CARD_BODY_MAX, BotPageCard, BotPageEmpty } from '../bot-page-card'
import { BotWork } from '../bot-work'
import { DoneLately } from '../done-lately'
import { useBotPageOpen } from '../use-bot-page-open'
import { WorkingOn } from '../working-on'

function row(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    workspace_id: 'w1',
    member_id: 'm1',
    kind: 'work_run',
    title: `Item ${id}`,
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
    created_at: '2026-10-03T08:00:00.000Z',
    started_at: '2026-10-03T08:00:00.000Z',
    finished_at: null,
    reviewed_at: null,
    last_beat_at: '2026-10-03T08:00:00.000Z',
    deadline_at: null,
    ai_team_member_id: 'writer',
    teammate: { id: 'writer', name: 'Writer', is_system: false, system_key: null, role: 'writer' },
    ...over,
  }
}
const RESEARCHER = { id: 'researcher', name: 'Researcher', is_system: false, system_key: null, role: 'researcher' }

function mate(over: Partial<RosterTeammate> = {}): RosterTeammate {
  return {
    id: 'writer',
    workspace_id: 'w1',
    team_id: 'team-1',
    name: 'Writer',
    avatar_url: null,
    role: 'writer',
    autonomy: 'attempt',
    allowed_side_effects: ['read', 'internal-write'],
    is_system: false,
    system_key: null,
    fronts_only: false,
    fronts: [],
    speaks_for_agent: null,
    bot_character: null,
    breaker: null,
    ...over,
  }
}
const ABOUT: TeammateAbout = { skills: [], agent: null, loops: [] }

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  shared.pageOpenItem.mockClear()
  shared.openBotPage.mockClear()
  shared.openWorkItem.mockClear()
  shared.editorOpen.mockClear()
  shared.editorTargets = []
  shared.roster = [{ id: 'writer', name: 'Writer' }, { id: 'researcher', name: 'Researcher' }]
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const writerTrees = (rows: WorkItem[]) => partitionForOwner(rows, new Set(['tm:writer']))
const rowEl = (id: string) => container.querySelector<HTMLElement>(`[data-work-row="${id}"]`)!

describe('Working on', () => {
  function Harness({ rows, onStop, stopping = new Set<string>() }: { rows: WorkItem[]; onStop: (item: WorkItem) => void; stopping?: ReadonlySet<string> }) {
    const open = useBotPageOpen('writer')
    return h(WorkingOn, { name: 'Writer', trees: writerTrees(rows).running, chips: {}, open, onStop, stopping })
  }

  it('offers Stop only on a run that can be stopped, and hands the shell’s Stop the row itself (its own workspace)', async () => {
    const onStop = vi.fn()
    const rows = [
      row('coding', { agent_run_id: 'ar-1', workspace_id: 'w2', title: 'Fix login redirect' }),
      row('loop', { kind: 'flow_run', title: 'Weekly brief' }),
    ]
    await act(async () => root.render(h(Harness, { rows, onStop })))
    const stops = Array.from(container.querySelectorAll('button[aria-label^="Stop "]')).map((b) => b.getAttribute('aria-label'))
    expect(stops).toEqual(['Stop Fix login redirect'])
    await act(async () => (container.querySelector('button[aria-label="Stop Fix login redirect"]') as HTMLButtonElement).click())
    expect(onStop).toHaveBeenCalledWith(expect.objectContaining({ id: 'coding', workspace_id: 'w2', agent_run_id: 'ar-1' }))
  })

  it('a running job with a plan carries its "3/5" badge, the step in progress as its tooltip (A4)', async () => {
    const plan = {
      steps: [
        { text: 'Read the thread', status: 'done' },
        { text: 'Check the CRM', status: 'skipped' },
        { text: 'Draft the reply', status: 'in_progress' },
        { text: 'Send for review', status: 'pending' },
      ],
      updated_at: '2026-10-03T08:01:00.000Z',
    }
    await act(async () => root.render(h(Harness, { rows: [row('busy', { plan }), row('plain')], onStop: vi.fn() })))
    const badge = rowEl('busy').querySelector('[data-work-row-plan]')!
    expect(badge.textContent).toBe('2/4')
    expect(badge.getAttribute('title')).toBe('Plan: Draft the reply')
    expect(rowEl('plain').querySelector('[data-work-row-plan]')).toBeNull()
  })

  it('shows a Stop in flight as stopping', async () => {
    await act(async () => root.render(h(Harness, { rows: [row('coding', { agent_run_id: 'ar-1' })], onStop: vi.fn(), stopping: new Set(['coding']) })))
    const stop = container.querySelector('button[aria-label^="Stop "]') as HTMLButtonElement
    expect(stop.disabled).toBe(true)
    expect(stop.textContent).toContain('Stopping')
  })

  it('a run that handed work on says whom it waits on; the handoff names its bot and opens on that bot’s page; Stop is the run’s, not its handoff’s', async () => {
    const rows = [
      row('root', { status: 'waiting_on_child', agent_run_id: 'ar-root', needs: { kind: 'child', work_item_id: 'child', role: 'researcher' } }),
      row('child', { parent_id: 'root', root_id: 'root', agent_run_id: 'ar-child', ai_team_member_id: 'researcher', teammate: RESEARCHER }),
    ]
    await act(async () => root.render(h(Harness, { rows, onStop: vi.fn() })))
    expect(rowEl('root').textContent).toContain('Waiting on Researcher')
    expect(Array.from(container.querySelectorAll('button[aria-label^="Stop "]')).map((b) => b.getAttribute('aria-label'))).toEqual(['Stop Item root'])
    const handoff = rowEl('child').querySelector('button')!
    expect(handoff.getAttribute('title')).toBe('Open on Researcher’s page')
    await act(async () => handoff.click())
    // Where any item opens, with its own bot named: on Researcher's page.
    expect(shared.openWorkItem).toHaveBeenCalledWith('child', [], { workspaceId: 'w1', title: 'Item child', teammateId: 'researcher' })
    expect(shared.openBotPage).not.toHaveBeenCalled()
    expect(shared.pageOpenItem).not.toHaveBeenCalled()
    // Its own run opens on this page, in this window: the item, Back to the lists.
    await act(async () => rowEl('root').querySelector('button')!.click())
    expect(shared.pageOpenItem).toHaveBeenCalledWith({ itemId: 'root', title: 'Item root' })
    expect(shared.openWorkItem).toHaveBeenCalledTimes(1)
  })

  it('a handoff of a bot the roster doesn’t hold (a private team’s, one since deleted) names no page; its item opens where any item opens (over the Inbox)', async () => {
    shared.roster = [{ id: 'writer', name: 'Writer' }]
    const rows = [
      row('root', { status: 'waiting_on_child' }),
      row('child', { parent_id: 'root', root_id: 'root', ai_team_member_id: 'researcher', teammate: RESEARCHER }),
    ]
    await act(async () => root.render(h(Harness, { rows, onStop: vi.fn() })))
    const handoff = rowEl('child').querySelector('button')!
    expect(handoff.getAttribute('title')).toBeNull()
    await act(async () => handoff.click())
    expect(shared.openWorkItem).toHaveBeenCalledWith('child', [], expect.objectContaining({ teammateId: 'researcher' }))
    expect(shared.pageOpenItem).not.toHaveBeenCalled()
  })

  it('a row no bot owns opens where any item opens, known to have none', async () => {
    const rows = [row('lane', { ai_team_member_id: null, teammate: null })]
    // Not this bot's trees: through the page's opener directly.
    function Probe() {
      const open = useBotPageOpen('writer')
      return h('button', { 'data-probe': '', onClick: () => open.row(rows[0]) })
    }
    await act(async () => root.render(h(Probe)))
    await act(async () => container.querySelector<HTMLButtonElement>('[data-probe]')!.click())
    expect(shared.openWorkItem).toHaveBeenCalledWith('lane', [], { workspaceId: 'w1', title: 'Item lane', teammateId: null })
  })

  it('says so when it isn’t working on anything', async () => {
    await act(async () => root.render(h(Harness, { rows: [row('done', { status: 'done' })], onStop: vi.fn() })))
    expect(container.textContent).toContain('Writer isn’t working on anything right now.')
  })
})

describe('Done lately', () => {
  function Harness({ rows }: { rows: WorkItem[] }) {
    const open = useBotPageOpen('writer')
    return h(DoneLately, { name: 'Writer', trees: writerTrees(rows).recent, chips: {}, open })
  }

  it('lists settled runs newest first, how each ended, and folds a run’s handoffs under it', async () => {
    const rows = [
      row('older', { status: 'done', finished_at: '2026-10-01T09:00:00.000Z', progress: { review: 'reviewed' } }),
      row('newer', { status: 'failed', error_message: 'Timed out', finished_at: '2026-10-02T09:00:00.000Z' }),
      row('attempt', { status: 'done', origin: 'attempt', finished_at: '2026-09-30T09:00:00.000Z', progress: { review: 'dismissed' } }),
      row('handoff', { status: 'done', parent_id: 'older', root_id: 'older', ai_team_member_id: 'researcher', teammate: RESEARCHER, finished_at: '2026-10-01T08:00:00.000Z' }),
    ]
    await act(async () => root.render(h(Harness, { rows })))
    const shown = Array.from(container.querySelectorAll('[data-work-row]')).map((el) => el.getAttribute('data-work-row'))
    // Folded: the handoff isn't drawn until its run's "1 handoff" opens.
    expect(shown).toEqual(['newer', 'older', 'attempt'])
    expect(rowEl('newer').textContent).toContain('Timed out')
    expect(rowEl('older').textContent).toContain('reviewed')
    expect(rowEl('attempt').querySelector('[data-attempted]')).not.toBeNull()
    expect(rowEl('attempt').textContent).toContain('dismissed')
    await act(async () => (rowEl('older').querySelector('button[aria-expanded]') as HTMLButtonElement).click())
    expect(rowEl('handoff')).not.toBeNull()
  })

  it('says so with nothing settled, by when a run started', async () => {
    await act(async () => root.render(h(Harness, { rows: [row('busy')] })))
    expect(container.textContent).toContain('Nothing Writer started in the last 14 days has finished.')
    expect(container.querySelector('section[aria-label="Done lately"]')!.textContent).toContain('Started in the last 14 days')
  })
})

describe('About', () => {
  async function about(props: { teammate?: RosterTeammate; about?: TeammateAbout; mayResume?: boolean; onResume?: (w: string, r: string) => Promise<boolean>; aiLimit?: boolean }) {
    const onResume = props.onResume ?? vi.fn(async () => true)
    await act(async () =>
      root.render(
        h(About, {
          teammate: props.teammate ?? mate(),
          about: props.about ?? ABOUT,
          mayResume: props.mayResume ?? false,
          onResume,
          aiLimit: props.aiLimit ?? false,
        }),
      ),
    )
    return onResume
  }
  const resume = () => container.querySelector<HTMLButtonElement>('[data-bot-page-resume]')

  it('says what it is, its skills and what it does on its own', async () => {
    await about({ about: { ...ABOUT, skills: [{ id: 's1', name: 'Research brief' }, { id: 's2', name: 'Find emails' }] } })
    expect(container.querySelector('[data-bot-page-what]')!.textContent).toBe('Writer')
    expect(container.querySelector('[data-bot-page-skills]')!.textContent).toBe('Research brief, Find emails')
    expect(container.querySelector('[data-bot-page-autonomy]')!.textContent).toBe('Makes first passes on its own')
  })

  it('a loop’s work bot: the loops it speaks for, no skills or autonomy of its own', async () => {
    await about({ teammate: mate({ id: 'wb', name: 'Pixel', role: null, autonomy: null, fronts_only: true, fronts: ['Weekly brief'] }) })
    expect(container.querySelector('[data-bot-page-what]')!.textContent).toBe('The agent for Weekly brief')
    expect(container.querySelector('[data-bot-page-skills]')).toBeNull()
    expect(container.querySelector('[data-bot-page-autonomy]')).toBeNull()
  })

  it('a system teammate: its job, its skills, no autonomy line', async () => {
    await about({ teammate: mate({ id: 'tri', name: 'Captures', role: null, is_system: true, system_key: 'captures' }) })
    expect(container.querySelector('[data-bot-page-what]')!.textContent).toContain('Files what was said in each capture')
    expect(container.querySelector('[data-bot-page-skills]')!.textContent).toBe('None yet')
    expect(container.querySelector('[data-bot-page-autonomy]')).toBeNull()
  })

  it('a teammate built on a custom agent names it', async () => {
    await about({ teammate: mate({ role: null }), about: { ...ABOUT, agent: { id: 'agent-1', name: 'Sales Coach' } } })
    expect(container.querySelector('[data-bot-page-agent]')!.textContent).toBe('Built on Sales Coach')
  })

  it('Attempts paused shows with Resume only for an owner or admin, and Resume resumes its role in its workspace', async () => {
    const paused = mate({ breaker: { paused: true, window: 3 } })
    await about({ teammate: paused, mayResume: false })
    expect(container.querySelector('[data-bot-page-paused]')!.textContent).toContain('Attempts paused')
    expect(resume()).toBeNull()

    const onResume = await about({ teammate: paused, mayResume: true })
    expect(resume()!.textContent).toContain('Resume Writer')
    await act(async () => resume()!.click())
    expect(onResume).toHaveBeenCalledWith('w1', 'writer')
  })

  it('nothing paused: no Resume, even for an owner', async () => {
    await about({ teammate: mate({ breaker: { paused: false, window: 3 } }), mayResume: true })
    expect(container.querySelector('[data-bot-page-paused]')).toBeNull()
    expect(resume()).toBeNull()
  })

  it('says when the AI limit stopped it', async () => {
    await about({ aiLimit: true })
    expect(container.querySelector('[data-bot-page-ai-limit]')!.textContent).toContain('AI limit')
  })

  it('Customize opens the agent editor seam on this bot', async () => {
    await about({ about: { ...ABOUT, loops: [{ id: 'flow-1', name: 'Weekly brief' }] } })
    expect(shared.editorTargets.at(-1)).toEqual({ teammateId: 'writer', workspaceId: 'w1', kind: 'role' })
    await act(async () => container.querySelector<HTMLButtonElement>('[data-bot-page-customize]')!.click())
    expect(shared.editorOpen).toHaveBeenCalledTimes(1)
  })

  it('offers no Customize on the agent’s own page (one face: its look and name are one everywhere)', async () => {
    await about({ teammate: mate({ id: 'tm-agent', name: 'Assistant', is_system: true, system_key: 'assistant', role: null }) })
    expect(container.querySelector('[data-bot-page-customize]')).toBeNull()
    // An area face or any other bot keeps it.
    await about({ teammate: mate({ is_system: true, system_key: 'mail', role: null }) })
    expect(container.querySelector('[data-bot-page-customize]')).not.toBeNull()
  })

  it('is a card of its own, with no second frame inside it', async () => {
    await about({})
    const card = container.querySelector<HTMLElement>('section[data-bot-page-section="about"]')!
    expect(card.getAttribute('aria-label')).toBe('About')
    expect(card.querySelector<HTMLElement>('[data-bot-page-about]')!.className).not.toContain('border')
  })
})

describe('BotPageCard', () => {
  const section = (title: string) => container.querySelector<HTMLElement>(`section[aria-label="${title}"]`)!
  const body = (title: string) => section(title).querySelector<HTMLElement>('[data-bot-page-section-body]')!

  it('is a card of its own: a section named for its title, a small header with its count and hint, then its body', async () => {
    await act(async () =>
      root.render(
        h(BotPageCard, { section: 'for-you', title: 'For you', hint: 'What’s new, then what you’ve seen', count: 3, children: h('ul', { 'data-body': '' }) }),
      ),
    )
    const card = section('For you')
    expect(card.getAttribute('data-bot-page-section')).toBe('for-you')
    // Its own rounded, edged surface standing off the page, in light and dark.
    expect(card.className).toContain('rounded-2xl')
    expect(card.className).toContain('hud-surface-shadow')
    expect(card.className).toContain('dark:bg-white/[0.04]')
    expect(card.querySelector('h2')!.textContent).toBe('For you3')
    const hint = card.querySelector<HTMLElement>('header span[title]')!
    expect(hint.textContent).toBe('What’s new, then what you’ve seen')
    expect(hint.title).toBe('What’s new, then what you’ve seen')
    expect(body('For you').querySelector('[data-body]')).not.toBeNull()
  })

  it('says no count of nothing; a bounded card’s list scrolls inside it, an unbounded one grows', async () => {
    await act(async () =>
      root.render(
        h(
          'div',
          null,
          h(BotPageCard, { section: 'a', title: 'Plain', count: 0, children: 'x' }),
          h(BotPageCard, { section: 'b', title: 'Long', bounded: true, children: 'y' }),
        ),
      ),
    )
    expect(section('Plain').querySelector('h2')!.textContent).toBe('Plain')
    expect(body('Plain').className).not.toContain('overflow-y-auto')
    expect(body('Long').className).toContain('overflow-y-auto')
    expect(body('Long').className).toContain(BOT_PAGE_CARD_BODY_MAX)
  })

  it('an empty section is one quiet line, without a box of its own', async () => {
    await act(async () => root.render(h(BotPageEmpty, null, 'Nothing here.')))
    const empty = container.querySelector<HTMLElement>('[data-bot-page-empty]')!
    expect(empty.textContent).toBe('Nothing here.')
    expect(empty.className).not.toContain('border')
  })
})

describe('BotWork: the work column', () => {
  const work = (over: Partial<BotWorkData> = {}): BotWorkData => ({
    rows: [row('busy'), row('done', { status: 'done', finished_at: '2026-10-03T09:00:00.000Z' })],
    chips: {},
    teammate: mate(),
    mayResume: false,
    lastFinished: null,
    about: ABOUT,
    loading: false,
    failed: false,
    refresh: async () => {},
    ...over,
  })
  const render = (data: BotWorkData) => act(async () => root.render(h(BotWork, { teammateId: 'writer', name: 'Writer', mate: mate(), work: data, aiLimit: false })))
  // The sections read their own rows (Notices, What I’ve learned).
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ conversations: [] }) })))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('stacks For you, Working on, Done lately and About, each a card of its own, with gaps between them (no Conversations: one-chat Slice 2)', async () => {
    await render(work())
    const stack = container.querySelector<HTMLElement>('[data-bot-page-cards]')!
    expect(Array.from(stack.children).map((el) => el.getAttribute('data-bot-page-section'))).toEqual([
      'for-you',
      'working-on',
      'done-lately',
      'about',
    ])
    expect(stack.className).toContain('gap-3')
    expect(stack.querySelector('[data-bot-page-section="working-on"] [data-work-row="busy"]')).not.toBeNull()
    expect(stack.querySelector('[data-bot-page-section="done-lately"] [data-work-row="done"]')).not.toBeNull()
    // An empty section keeps its card, compact: one quiet line.
    expect(stack.querySelector('[data-bot-page-section="for-you"] [data-bot-page-empty]')!.textContent).toBe('Nothing from Writer is waiting on you.')
    // The lists stay bounded however long; About is short. For you's deck
    // (its real cards, bots-v4.md Phase 3) stands outside a scroller; only the
    // rows under it scroll.
    for (const id of ['working-on', 'done-lately']) {
      expect(stack.querySelector(`[data-bot-page-section="${id}"] [data-bot-page-section-body]`)!.className).toContain('overflow-y-auto')
    }
    expect(stack.querySelector('[data-bot-page-section="for-you"] [data-bot-page-section-body]')!.className).not.toContain('overflow-y-auto')
    expect(stack.querySelector('[data-bot-page-section="about"] [data-bot-page-section-body]')!.className).not.toContain('overflow-y-auto')
  })

  it('a run parked on a question stays on its page, under Working on, as "Needs your answer" (P13: never in For you)', async () => {
    await render(work({ rows: [row('busy'), row('asking', { status: 'needs_input' })] }))
    const working = container.querySelector<HTMLElement>('[data-bot-page-section="working-on"]')!
    expect(working.querySelector('[data-work-row="asking"]')).not.toBeNull()
    expect(working.querySelector('[data-work-row="asking"]')!.textContent).toContain('Needs your answer')
    expect(container.querySelector('[data-bot-page-section="for-you"] [data-work-row="asking"]')).toBeNull()
  })

  it('a bot you may reach carries its Notices (bots-v4 Phase 4c), after Done lately, read for this bot', async () => {
    await render(work({ teammate: mate({ reachable: true }) }))
    const stack = container.querySelector<HTMLElement>('[data-bot-page-cards]')!
    expect(Array.from(stack.children).map((el) => el.getAttribute('data-bot-page-section'))).toEqual([
      'for-you',
      'working-on',
      'done-lately',
      'notices',
      'about',
    ])
    const asked = (vi.mocked(fetch).mock.calls as unknown as Array<[string]>).map(([url]) => url)
    expect(asked).toContain('/api/account/notifications/bot?teammate=writer&limit=30')
  })

  it('an area face’s page shows What I’ve learned for its area (one-agent S3)', async () => {
    const face = mate({ id: 'tm-mail', name: 'Mail', role: null, is_system: true, system_key: 'mail', autonomy: 'propose', allowed_side_effects: ['read'] })
    await act(async () => root.render(h(BotWork, { teammateId: 'tm-mail', name: 'Mail', mate: face, work: work({ teammate: face }), aiLimit: false })))
    const stack = container.querySelector<HTMLElement>('[data-bot-page-cards]')!
    expect(Array.from(stack.children).map((el) => el.getAttribute('data-bot-page-section'))).toEqual([
      'for-you',
      'working-on',
      'done-lately',
      'about',
      'learned',
    ])
    expect(stack.querySelector('[data-bot-page-learned="mail"]')).not.toBeNull()
    const asked = (vi.mocked(fetch).mock.calls as unknown as Array<[string]>).map(([url]) => url)
    // S2's memory, read for this area alone; no conversation list.
    expect(asked).toContain('/api/account/memory?area=mail')
    expect(asked.some((u) => u.startsWith('/api/account/chat-history'))).toBe(false)
  })

  it('a custom agent’s bot shows no memory card', async () => {
    await render(work())
    expect(container.querySelector('[data-bot-page-section="learned"]')).toBeNull()
  })

  it('the agent’s page (one face) shows What I’ve learned area by area: one area at a time, picked from a row', async () => {
    const assistant = mate({ id: 'tm-assistant', name: 'Assistant', role: null, is_system: true, system_key: 'assistant' })
    await act(async () => root.render(h(BotWork, { teammateId: 'tm-assistant', name: 'Assistant', mate: assistant, work: work({ teammate: assistant }), aiLimit: false })))
    expect(container.querySelector('[data-bot-page-section="learned"]')).not.toBeNull()
    const chips = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-bot-page-learned-area]'))
    expect(chips.map((c) => c.textContent)).toEqual(['Captures', 'Mail', 'Prospecting', 'Evals', 'CRM'])
    expect(container.querySelector('[data-bot-page-learned="captures"]')).not.toBeNull()
    await act(async () => chips[1].click())
    expect(container.querySelector('[data-bot-page-learned="mail"]')).not.toBeNull()
    expect(chips[1].getAttribute('aria-checked')).toBe('true')
  })

  it('loads as the same stack of blank cards', async () => {
    await render(work({ rows: null }))
    const loading = container.querySelector<HTMLElement>('[data-bot-page-loading]')!
    expect(loading.className).toContain('gap-3')
    expect(loading.children).toHaveLength(3)
    expect(container.querySelector('[data-bot-page-section]')).toBeNull()
  })
})
