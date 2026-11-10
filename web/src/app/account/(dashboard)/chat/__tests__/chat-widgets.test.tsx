// @vitest-environment jsdom
/**
 * The side panel's Plan and Agents sections (docs/plans/always-on-agent.md
 * decision 10), fed by the main chat (side-panels/chat-feed.tsx):
 *
 *   • Plan draws the newest update_plan that went through in the loaded
 *     messages (a refused or in-flight call is not a plan); without one,
 *     nothing draws (a stale plan still counts), and a streamed token that
 *     changes nothing publishes nothing;
 *   • Agents lists ONLY what is RUNNING from the shared rows (queued,
 *     running, parked on a handoff): a row that settled is never listed, and
 *     leaves the moment it settles, with no timer behind it; rows waiting on
 *     the person (For you's) and the non-AI lanes stay out; this chat's quick
 *     helpers (the newest reply's `helpers` call) list while they work, and
 *     go when they finish; nothing draws with nothing running, and the count
 *     is what runs; each row has its full title (two lines at most), plan
 *     badge, step and elapsed time, a click opens its chat the way For you's
 *     Open does (useOpenWorkItem), Stop goes through the shared stop, and a
 *     running helper takes a steer behind its steer icon (the steer route,
 *     with the row's workspace); Stop and steer lie over the row, taking no
 *     space while hidden; the elapsed redraw ticks only while the panel is
 *     open;
 *   • no realtime channel of its own: it reads the shared rows only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Fragment, act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIMessage } from 'ai'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const shared = vi.hoisted(() => ({
  rows: [] as unknown[],
  stop: vi.fn(async (_item: unknown) => {}),
  stopping: new Set<string>(),
}))
vi.mock('@/components/work/agent-work-provider', () => ({
  useOptionalAgentWork: () => ({
    work: { rows: shared.rows, stop: shared.stop, stopping: shared.stopping },
    counts: new Map(),
  }),
}))
const openWorkItem = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/use-open-teammate', () => ({ useOpenWorkItem: () => openWorkItem }))
const createClient = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/client', () => ({ createClient }))

const { AgentsSection, PlanSection, planHeaderCount, useAgentsSummary } = await import('../chat-widgets')
const { ChatFeedPublisher, resetChatFeed, subscribeChatFeed, useChatFeed } = await import('../../side-panels/chat-feed')
const model = await import('../chat-widgets-model')
const {
  agentWidgetGroups,
  agentWidgetRows,
  isSteerable,
  lastPlanOf,
  newestPlanSteps,
  newestThreadPlan,
  planShowsCount,
  runningCount,
  agentsBadge,
  elapsedText,
  quickHelperBatch,
  shownQuickHelpers,
} = model

const CONV = 'conv-1'
const user = (): UIMessage => ({ id: `u-${Math.random()}`, role: 'user', parts: [{ type: 'text', text: 'go on' }] }) as unknown as UIMessage

function planPart(steps: Array<{ text: string; status: string }>, over: Record<string, unknown> = {}) {
  return { type: 'tool-update_plan', toolCallId: `c-${Math.random()}`, state: 'output-available', input: {}, output: { ok: true, plan: steps }, ...over }
}
function assistant(parts: unknown[], id = `m-${Math.random()}`): UIMessage {
  return { id, role: 'assistant', parts } as unknown as UIMessage
}
const FIVE = [
  { text: 'Find the accounts', status: 'done' },
  { text: 'Read their sites', status: 'done' },
  { text: 'Score them', status: 'skipped' },
  { text: 'Draft the notes', status: 'in_progress' },
  { text: 'Send for review', status: 'pending' },
]

function row(over: Record<string, unknown>) {
  return {
    id: 'r',
    workspace_id: 'ws-1',
    kind: 'work_run',
    status: 'running',
    created_at: '2026-10-14T10:00:00.000Z',
    source: {},
    agent_run_id: 'run-1',
    ai_team_member_id: 'tm-1',
    teammate: { name: 'Researcher' },
    plan: null,
    ...over,
  }
}

// ── The model ───────────────────────────────────────────────────────────────

describe('the plan', () => {
  it('is the newest update_plan that went through, walking back across messages', () => {
    const older = assistant([planPart([{ text: 'Old', status: 'pending' }])])
    const newer = assistant([{ type: 'text', text: 'ok' }, planPart(FIVE)])
    const refused = assistant([planPart(FIVE, { output: { ok: false, error: 'nope' } })])
    const inFlight = assistant([planPart(FIVE, { state: 'input-available', output: undefined })])
    expect(newestPlanSteps([older, newer, refused, inFlight])?.map((s) => s.text)).toEqual(FIVE.map((s) => s.text))
  })

  it('flat cost while streaming: a message’s plan is cached by its parts array', () => {
    const settled = assistant([planPart(FIVE)])
    const first = lastPlanOf(settled)
    expect(first).not.toBeNull()
    // The same parts array: the cached answer, not a rescan.
    expect(lastPlanOf(settled)).toBe(first)
    expect(lastPlanOf({ role: 'assistant', parts: settled.parts })).toBe(first)
    // A streamed chunk (a new parts array) is read again.
    const streamed = { role: 'assistant' as const, parts: [...settled.parts] }
    expect(lastPlanOf(streamed)).not.toBe(first)
    expect(lastPlanOf(streamed)?.steps).toEqual(first!.steps)
  })

  it('a finished plan, or one the agent stopped reciting (stale), shows no count', () => {
    const live = newestThreadPlan([assistant([planPart(FIVE)]), user()])
    expect(live).toMatchObject({ stale: false })
    expect(planShowsCount(live)).toBe(true)
    const done = newestThreadPlan([assistant([planPart(FIVE.map((s) => ({ ...s, status: 'done' })))])])
    expect(planShowsCount(done)).toBe(false)
    // More than PLAN_STALE_TURNS (6) turns since it was written.
    const turns = newestThreadPlan([assistant([planPart(FIVE)]), ...Array.from({ length: 7 }, user)])
    expect(turns).toMatchObject({ stale: true })
    expect(planShowsCount(turns)).toBe(false)
    // Older than PLAN_STALE_MS, when the message says when it was written.
    const old = { ...assistant([planPart(FIVE)]), metadata: { createdAt: Date.now() - 25 * 60 * 60 * 1000 } } as UIMessage
    expect(newestThreadPlan([old])).toMatchObject({ stale: true })
    expect(planShowsCount(null)).toBe(false)
  })

  it('reads a dynamic tool part too, and is null with no plan', () => {
    const dyn = assistant([{ type: 'dynamic-tool', toolName: 'update_plan', toolCallId: 'd', state: 'output-available', input: {}, output: { ok: true, plan: FIVE } }])
    expect(newestPlanSteps([dyn])).toHaveLength(5)
    expect(newestPlanSteps([assistant([{ type: 'text', text: 'hi' }])])).toBeNull()
    expect(newestPlanSteps([])).toBeNull()
  })
})

const NOW = Date.parse('2026-10-14T12:30:00.000Z')
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()

function helpersPart(over: Record<string, unknown> = {}) {
  return {
    type: 'tool-helpers',
    toolCallId: 'call-h',
    state: 'input-available',
    input: { tasks: [{ label: 'Acme research', task: 'Research Acme' }, { label: 'Globex research', task: 'Research Globex' }] },
    ...over,
  }
}
const helpersSnapshot = (statuses: string[]) => ({
  state: 'output-available',
  preliminary: true,
  output: { kind: 'helpers-progress', total: statuses.length, done: statuses.filter((s) => s !== 'working').length, tasks: statuses.map((status, i) => ({ label: ['Acme research', 'Globex research'][i], status })) },
})
const helpersDone = {
  state: 'output-available',
  output: { results: [{ label: 'Acme research', status: 'done', output: 'Acme sells anvils.' }, { label: 'Globex research', status: 'failed', output: 'No site.' }] },
}

describe('the agents', () => {
  it('lists running agent work, the newest first, whichever conversation started it; needs-you rows, old settled work and non-AI lanes stay out', () => {
    const rows = [
      row({ id: 'old-elsewhere', created_at: '2026-10-14T08:00:00.000Z' }),
      row({ id: 'review', created_at: '2026-10-14T12:00:00.000Z', status: 'needs_review' }),
      row({ id: 'mine-old', created_at: '2026-10-14T07:00:00.000Z', source: { chat_conversation_id: CONV } }),
      row({ id: 'mine-new', created_at: '2026-10-14T09:00:00.000Z', status: 'queued', source: { chat_conversation_id: CONV } }),
      row({ id: 'parked', created_at: '2026-10-14T10:00:00.000Z', status: 'waiting_on_child' }),
      row({ id: 'done-long-ago', status: 'done', finished_at: minsAgo(30) }),
      row({ id: 'skipped', status: 'skipped', finished_at: minsAgo(1) }),
      row({ id: 'sequence', kind: 'sequence_enrolment', status: 'running' }),
      row({ id: 'asking', status: 'needs_input', created_at: '2026-10-14T11:00:00.000Z' }),
    ]
    // One chat: no conversation's work goes ahead of another's.
    expect(agentWidgetRows(rows, CONV).map((r) => r.id)).toEqual(['parked', 'mine-new', 'old-elsewhere', 'mine-old'])
    expect(agentWidgetRows(rows, null).map((r) => r.id)).toEqual(['parked', 'mine-new', 'old-elsewhere', 'mine-old'])
    expect(agentWidgetRows(null, CONV)).toEqual([])
  })

  it('never lists settled work, however recently it settled: done, failed and stopped rows are gone at once', () => {
    const rows = [
      row({ id: 'running', created_at: '2026-10-14T08:00:00.000Z' }),
      row({ id: 'done', status: 'done', finished_at: new Date(NOW).toISOString() }),
      row({ id: 'failed', status: 'failed', finished_at: minsAgo(1) }),
      row({ id: 'stopped', status: 'canceled', last_beat_at: minsAgo(1) }),
      row({ id: 'unknown', status: 'done' }),
    ]
    expect(agentWidgetRows(rows, CONV).map((r) => r.id)).toEqual(['running'])
    expect(agentWidgetGroups(rows.slice(1), CONV)).toEqual([])
    // The model has no aging-out at all: nothing recent to time.
    expect('RECENTLY_FINISHED_MS' in model).toBe(false)
    expect('nextFinishedExpiry' in model).toBe(false)
  })

  it('groups running handoff children under their root; a child is this chat’s when its root is; a settled root or child drops out, its running kin stay', () => {
    const rows = [
      row({ id: 'root', source: { chat_conversation_id: CONV }, created_at: '2026-10-14T08:00:00.000Z' }),
      row({ id: 'child-b', root_id: 'root', parent_id: 'root', created_at: '2026-10-14T09:30:00.000Z' }),
      row({ id: 'child-a', root_id: 'root', parent_id: 'root', created_at: '2026-10-14T09:00:00.000Z', status: 'done', finished_at: minsAgo(1) }),
      row({ id: 'grandchild', root_id: 'root', parent_id: 'child-a', created_at: '2026-10-14T09:45:00.000Z' }),
      row({ id: 'newer', created_at: '2026-10-14T12:00:00.000Z' }),
      // Its root settled long ago: it stands alone.
      row({ id: 'orphan', root_id: 'gone', parent_id: 'gone', created_at: '2026-10-14T11:00:00.000Z' }),
      // A settled root with a running child: the child stands alone.
      row({ id: 'settled-root', status: 'done', finished_at: minsAgo(3), created_at: '2026-10-14T06:00:00.000Z' }),
      row({ id: 'its-kid', root_id: 'settled-root', parent_id: 'settled-root', created_at: '2026-10-14T06:30:00.000Z' }),
    ]
    const groups = agentWidgetGroups(rows, CONV)
    expect(groups.map((g) => [g.root.id, g.children.map((c) => c.id), g.mine])).toEqual([
      ['newer', [], false],
      ['orphan', [], false],
      ['root', ['child-b', 'grandchild'], true],
      ['its-kid', [], false],
    ])
  })

  it('offers a steer only where the route would take it', () => {
    const now = Date.parse('2026-10-14T10:00:10.000Z')
    const at = (s: number) => new Date(now - s * 1000).toISOString()
    expect(isSteerable(row({ created_at: at(60) }), now)).toBe(true)
    expect(isSteerable(row({ created_at: at(2) }), now)).toBe(false) // no session yet
    expect(isSteerable(row({ created_at: at(60), source: { owner_fallback: true } }), now)).toBe(false)
    expect(isSteerable(row({ created_at: at(60), source: { action_id: 'a-1' } }), now)).toBe(false)
    expect(isSteerable(row({ created_at: at(60), kind: 'coding_run' }), now)).toBe(false)
    expect(isSteerable(row({ created_at: at(60), status: 'needs_input' }), now)).toBe(false)
    expect(isSteerable(row({ created_at: at(60), agent_run_id: null }), now)).toBe(false)
  })

  it('a local agent’s turn takes a message while its session is live or idle, no grace needed', () => {
    const now = Date.parse('2026-10-14T10:00:10.000Z')
    const sid = '11111111-2222-4333-8444-555555555555'
    const local = (over: Record<string, unknown> = {}) =>
      row({ kind: 'local_agent', agent_run_id: null, created_at: new Date(now).toISOString(), source: { local_agent_session_id: sid }, ...over })
    for (const status of ['queued', 'running', 'needs_input', 'needs_review']) {
      expect(isSteerable(local({ status }), now)).toBe(true)
    }
    for (const status of ['done', 'failed', 'canceled']) {
      expect(isSteerable(local({ status }), now)).toBe(false)
    }
    // No session named: nothing to send it to.
    expect(isSteerable(local({ source: {} }), now)).toBe(false)
    expect(isSteerable(local({ source: { local_agent_session_id: 'not-a-uuid' } }), now)).toBe(false)
  })

  it('counts the running ones (never those waiting on you, nor the settled)', () => {
    expect(runningCount([{ status: 'running' }, { status: 'queued' }, { status: 'waiting_on_child' }, { status: 'needs_review' }, { status: 'needs_input' }, { status: 'done' }])).toBe(3)
  })

  it('the badge is "N running", never "need you"', () => {
    expect(agentsBadge([{ status: 'running' }, { status: 'needs_input' }, { status: 'needs_review' }])).toBe('1 running')
    expect(agentsBadge([{ status: 'running' }, { status: 'queued' }, { status: 'done' }])).toBe('2 running')
    expect(agentsBadge([{ status: 'needs_input' }, { status: 'done' }])).toBeNull()
    expect(agentsBadge([])).toBeNull()
  })

  it('elapsed time, short', () => {
    expect(elapsedText(NOW - 20_000, NOW)).toBe('<1m')
    expect(elapsedText(NOW - 4 * 60_000, NOW)).toBe('4m')
    expect(elapsedText(NOW - 65 * 60_000, NOW)).toBe('1h 5m')
    expect(elapsedText(null, NOW)).toBeNull()
  })
})

describe('quick helpers', () => {
  it('reads the newest reply’s helpers call: labels before the first snapshot, then the snapshot, then the results', () => {
    const before = quickHelperBatch([assistant([helpersPart()])])!
    expect(before.running).toBe(true)
    expect(before.rows.map((r) => [r.label, r.status, r.task])).toEqual([
      ['Acme research', 'working', 'Research Acme'],
      ['Globex research', 'working', 'Research Globex'],
    ])
    const mid = quickHelperBatch([assistant([helpersPart(helpersSnapshot(['done', 'working']))])])!
    expect(mid.running).toBe(true)
    expect(mid.headline).toBe('2 helpers working · 1/2 done')
    expect(mid.rows.map((r) => r.status)).toEqual(['done', 'working'])
    const done = quickHelperBatch([assistant([helpersPart(helpersDone)])])!
    expect(done.running).toBe(false)
    expect(done.rows.map((r) => [r.status, r.result])).toEqual([
      ['done', 'Acme sells anvils.'],
      ['failed', 'No site.'],
    ])
  })

  it('only the newest reply counts, a refusal is nothing, and a message’s batch is cached by its parts array', () => {
    expect(quickHelperBatch([assistant([helpersPart()]), user(), assistant([{ type: 'text', text: 'hi' }])])).toBeNull()
    expect(quickHelperBatch([assistant([helpersPart({ state: 'output-available', output: { results: [], refused: 'Off' } })])])).toBeNull()
    expect(quickHelperBatch([])).toBeNull()
    const msg = assistant([helpersPart()])
    expect(quickHelperBatch([msg])).toBe(quickHelperBatch([msg]))
  })

  it('lists only the helpers still working: a finished helper goes at once, and a done call lists none, however recent', () => {
    const running = quickHelperBatch([assistant([helpersPart()])])
    expect(shownQuickHelpers(running)).toHaveLength(2)
    const mid = quickHelperBatch([assistant([helpersPart(helpersSnapshot(['done', 'working']))])])
    expect(shownQuickHelpers(mid).map((r) => r.label)).toEqual(['Globex research'])
    const done = quickHelperBatch([assistant([helpersPart(helpersDone)])])
    expect(shownQuickHelpers(done)).toEqual([])
    const justNow = quickHelperBatch([{ ...assistant([helpersPart(helpersDone)]), metadata: { createdAt: Date.now() } } as UIMessage])
    expect(shownQuickHelpers(justNow)).toEqual([])
    expect(shownQuickHelpers(null)).toEqual([])
  })
})

// ── The sections ────────────────────────────────────────────────────────────

let container: HTMLDivElement
let root: Root

/** The panel's Plan and Agents as it draws them: the chat publishes its feed, the sections read it. */
function Sections({ active }: { active: boolean }) {
  const summary = useAgentsSummary()
  const { plan } = useChatFeed()
  return h(
    'div',
    { 'data-side-panel': '', tabIndex: -1, 'data-running': String(summary.running) },
    plan ? h('p', { 'data-plan-count': '' }, planHeaderCount(plan)) : null,
    plan ? h(PlanSection, { plan }) : null,
    h(AgentsSection, { summary, active }),
  )
}
function render(messages: UIMessage[], conversationId: string | null = CONV, active = true) {
  act(() =>
    root.render(h(Fragment, null, h(ChatFeedPublisher, { messages, conversationId, enabled: true }), h(Sections, { active }))),
  )
}
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null
const click = (el: HTMLElement | null) => act(() => el!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
const running = () => q('[data-side-panel]')!.getAttribute('data-running')
/** The steer line sits behind the row's steer icon. */
const openSteer = (id: string) => click(q(`[data-agent-row="${id}"] [data-agent-row-steer-toggle]`))

beforeEach(() => {
  resetChatFeed()
  shared.rows = []
  shared.stop.mockClear()
  shared.stopping = new Set()
  createClient.mockClear()
  openWorkItem.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('the Plan section', () => {
  it('the newest plan’s checklist, never animated, its progress for the heading', () => {
    render([assistant([planPart(FIVE)])])
    const plan = q('[data-chat-widget="plan"]')!
    expect(plan.querySelectorAll('[data-plan-step]')).toHaveLength(5)
    // Never animated (a WebKit idle-CPU trap).
    expect(plan.querySelector('.animate-spin')).toBeNull()
    expect(q('[data-plan-count]')!.textContent).toBe('3 of 5')
  })

  it('without a plan nothing draws; the first plan brings it', () => {
    render([assistant([{ type: 'text', text: 'hi' }])])
    expect(q('[data-chat-widget="plan"]')).toBeNull()
    expect(container.textContent).not.toContain('No plan yet')
    render([assistant([{ type: 'text', text: 'hi' }]), assistant([planPart(FIVE)])])
    expect(q('[data-chat-widget="plan"]')).not.toBeNull()
  })

  it('a stale plan is still a plan, from earlier in this chat', () => {
    render([assistant([planPart(FIVE)]), ...Array.from({ length: 7 }, user)])
    expect(q('[data-chat-widget="plan"] [data-plan-stale]')?.textContent).toBe('From earlier in this chat')
  })

  it('a streamed token that changes nothing publishes nothing', () => {
    const heard = vi.fn()
    const off = subscribeChatFeed(heard)
    const parts = [planPart(FIVE)]
    render([assistant(parts, 'm-1')])
    const calls = heard.mock.calls.length
    render([assistant([...parts], 'm-1')])
    expect(heard.mock.calls.length).toBe(calls)
    off()
  })
})

describe('the Agents section', () => {
  it('this conversation’s helpers first, each with its full title, plan badge, step, status and elapsed time', () => {
    shared.rows = [
      row({ id: 'elsewhere', title: 'Weekly digest', created_at: '2026-10-14T12:00:00.000Z' }),
      row({ id: 'mine', title: 'Research fintech', plan: FIVE, source: { chat_conversation_id: CONV }, created_at: new Date(Date.now() - 4 * 60_000).toISOString() }),
      row({ id: 'settled', status: 'done' }),
    ]
    render([])
    expect(running()).toBe('2')
    const ids = [...container.querySelectorAll('[data-agent-row]')].map((el) => el.getAttribute('data-agent-row'))
    expect(ids).toEqual(['mine', 'elsewhere'])
    const mine = q('[data-agent-row="mine"]')!
    // The whole title, over two lines at most (no single-line truncation at 360px).
    const title = mine.querySelector('[data-agent-row-title]')!
    expect(title.textContent).toBe('Research fintech')
    expect(title.className).toContain('line-clamp-2')
    expect(mine.querySelector('[data-agent-row-plan]')?.textContent).toBe('3/5')
    expect(mine.textContent).toContain('Draft the notes')
    expect(mine.querySelector('[data-agent-row-status]')?.textContent).toBe('Working')
    expect(mine.querySelector('[data-agent-row-elapsed]')?.textContent).toBe('4m')
    // A spinner only while it runs, and still under reduced motion.
    expect(mine.querySelector('.animate-spin')?.getAttribute('class')).toContain('motion-reduce:animate-none')
    expect(q('[data-chat-widget="agents"]')!.textContent).toContain('This chat')
  })

  it('a local agent’s turn is listed like a helper, with a laptop mark, its steer and its Stop', () => {
    const sid = '11111111-2222-4333-8444-555555555555'
    shared.rows = [
      row({
        id: 'mac',
        kind: 'local_agent',
        agent_run_id: null,
        title: 'Your Mac · native-intelligence: Take a look at this repository',
        current_step: 'Reading README.md',
        source: { chat_conversation_id: CONV, local_agent_session_id: sid },
      }),
      row({ id: 'helper', title: 'Research fintech' }),
    ]
    render([])
    const mac = q('[data-agent-row="mac"]')!
    expect(mac.querySelector('[data-agent-row-title]')!.textContent).toBe('Your Mac · native-intelligence: Take a look at this repository')
    expect(mac.querySelector('[data-agent-row-local]')).not.toBeNull()
    expect(mac.textContent).toContain('Reading README.md')
    expect(mac.querySelector('[data-agent-row-steer-toggle]')).not.toBeNull()
    expect(mac.querySelector('[data-agent-row-stop]')).not.toBeNull()
    expect(q('[data-agent-row="helper"] [data-agent-row-local]')).toBeNull()
  })

  it('Stop and steer are laid over the row, hidden until hover or focus: hidden they take no space', () => {
    shared.rows = [row({ id: 'run', title: 'Research' })]
    render([])
    const tools = q('[data-agent-row="run"] [data-agent-row-tools]')!
    expect(tools.className).toMatch(/(^|\s)absolute(\s|$)/)
    expect(tools.className).toContain('opacity-0')
    expect(tools.className).toContain('group-hover/row:opacity-100')
    expect(tools.className).toContain('group-focus-within/row:opacity-100')
    // Not part of the row's flow: the row's text box is the open button alone.
    expect(q('[data-agent-row="run"] [data-agent-row-open]')!.contains(tools)).toBe(false)
  })

  it('nothing running: nothing drawn', () => {
    shared.rows = [row({ id: 'settled', status: 'done' }), row({ id: 'asks', status: 'needs_input' }), row({ id: 'review', status: 'needs_review' })]
    render([])
    expect(q('[data-chat-widget="agents"]')).toBeNull()
    expect(running()).toBe('0')
    shared.rows = [...shared.rows, row({ id: 'run' })]
    render([])
    expect(q('[data-agent-row="run"]')).not.toBeNull()
  })

  it('lists only running work: no row waiting on the person (For you shows those), and no finished row, however recent', () => {
    shared.rows = [
      row({ id: 'asks', status: 'needs_input' }),
      row({ id: 'review', status: 'needs_review' }),
      row({ id: 'just-done', status: 'done', title: 'Extracting from Notifications', finished_at: new Date().toISOString() }),
      row({ id: 'just-failed', status: 'failed', finished_at: new Date(Date.now() - 60_000).toISOString() }),
      row({ id: 'just-stopped', status: 'canceled', finished_at: new Date(Date.now() - 60_000).toISOString() }),
      row({ id: 'run', title: 'Research' }),
    ]
    render([])
    const ids = [...container.querySelectorAll('[data-agent-row]')].map((el) => el.getAttribute('data-agent-row'))
    expect(ids).toEqual(['run'])
    expect(container.textContent).not.toContain('Extracting from Notifications')
    expect(running()).toBe('1')
  })

  it('a row leaves the moment its work finishes, and the once-a-minute elapsed redraw is its only timer, only while the panel is open', () => {
    // Only the section's own kinds of timer (React's scheduler uses setImmediate).
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    try {
      render([])
      const idle = vi.getTimerCount()
      shared.rows = [row({ id: 'run', title: 'Daily Triage Sweep', plan: FIVE })]
      render([])
      expect(q('[data-agent-row="run"] [data-agent-row-plan]')?.textContent).toBe('3/5')
      expect(vi.getTimerCount()).toBe(idle + 1)
      // The panel closed: no tick (past React's own 0ms work).
      render([], CONV, false)
      act(() => {
        vi.advanceTimersByTime(1)
      })
      expect(vi.getTimerCount()).toBe(idle)
      render([], CONV, true)
      // It finishes (the shared row is pushed settled): gone at once, no wait.
      shared.rows = [row({ id: 'run', title: 'Daily Triage Sweep', plan: FIVE, status: 'done', finished_at: new Date().toISOString() })]
      render([])
      expect(q('[data-agent-row="run"]')).toBeNull()
      act(() => {
        vi.advanceTimersByTime(2 * 60_000)
      })
      expect(vi.getTimerCount()).toBe(idle)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a click opens the run’s chat the way For you’s Open does (useOpenWorkItem, in the row’s workspace)', () => {
    shared.rows = [row({ id: 'run', title: 'Research fintech', workspace_id: 'ws-7', ai_team_member_id: 'tm-3' })]
    render([])
    click(q('[data-agent-row="run"] [data-agent-row-open]'))
    expect(openWorkItem).toHaveBeenCalledWith('run', ['tm-3'], { workspaceId: 'ws-7', title: 'Research fintech', teammateId: 'tm-3' })
  })

  it('this chat’s quick helpers list while they work (a finished one is gone), and a click shows the task and progress in place (no transcript)', () => {
    render([assistant([helpersPart(helpersSnapshot(['done', 'working']))])])
    const rows = [...container.querySelectorAll('[data-quick-helper]')]
    expect(rows.map((el) => el.textContent)).toEqual([expect.stringContaining('Globex research')])
    expect(rows[0].querySelector('[data-agent-row-status]')?.textContent).toBe('Working')
    expect(running()).toBe('1')
    click(rows[0].querySelector('[data-quick-helper-open]') as HTMLElement)
    const details = q('[data-quick-helper-details]')!
    expect(details.textContent).toContain('Research Globex')
    expect(details.textContent).toContain('2 helpers working · 1/2 done')
    expect(openWorkItem).not.toHaveBeenCalled()
  })

  it('quick helpers: counted while they work; once the call finishes (seen running) they go', () => {
    render([assistant([helpersPart()], 'm-h')])
    expect(running()).toBe('2')
    expect(container.querySelectorAll('[data-quick-helper]')).toHaveLength(2)
    render([assistant([helpersPart(helpersDone)], 'm-h')])
    expect(q('[data-quick-helper]')).toBeNull()
    expect(q('[data-chat-widget="agents"]')).toBeNull()
  })

  it('a done helpers call loaded with the conversation (never seen running, no time) shows nothing', () => {
    render([assistant([helpersPart(helpersDone)])])
    expect(q('[data-chat-widget="agents"]')).toBeNull()
  })

  it('Stop goes through the shared stop', () => {
    shared.rows = [row({ id: 'mine', agent_run_id: 'run-1' })]
    render([])
    click(q('[data-agent-row="mine"] [data-agent-row-stop]'))
    expect(shared.stop).toHaveBeenCalledWith(expect.objectContaining({ id: 'mine' }))
  })

  it('a running helper takes a steer through the steer route, with the row’s workspace; others have no line', async () => {
    shared.rows = [row({ id: 'run', workspace_id: 'ws-9' }), row({ id: 'asks', status: 'needs_input' })]
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render([])
    expect(q('[data-agent-row="asks"]')).toBeNull()
    expect(q('[data-agent-row="run"] input')).toBeNull()
    openSteer('run')
    expect(q('[data-agent-row="run"] [data-agent-row-steer-toggle]')!.getAttribute('aria-expanded')).toBe('true')
    const input = q('[data-agent-row="run"] input') as HTMLInputElement
    type(input, 'stick to fintech')
    await act(async () => {
      input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/account/activity/run/steer')
    expect((init.headers as Record<string, string>)['x-workspace-id']).toBe('ws-9')
    const body = JSON.parse(String(init.body))
    expect(body.message).toBe('stick to fintech')
    expect(typeof body.request_id).toBe('string')
    expect(input.value).toBe('')
    expect(input.placeholder).toMatch(/Sent/)
  })

  it('a refused steer says why', async () => {
    shared.rows = [row({ id: 'run' })]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'It is waiting on your answer.', code: 'WAITING_ON_ANSWER' }), { status: 409 })))
    render([])
    openSteer('run')
    const input = q('[data-agent-row="run"] input') as HTMLInputElement
    type(input, 'x')
    await act(async () => {
      input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(q('[data-agent-row="run"] [role="alert"]')?.textContent).toBe('It is waiting on your answer.')
  })

  it('while sending the line is read-only and busy (not disabled), and focus comes back after', async () => {
    shared.rows = [row({ id: 'run' })]
    let answer: (r: Response) => void = () => {}
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => (answer = r))))
    render([])
    openSteer('run')
    const input = q('[data-agent-row="run"] input') as HTMLInputElement
    input.focus()
    type(input, 'shorter')
    act(() => {
      input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(input.readOnly).toBe(true)
    expect(input.getAttribute('aria-busy')).toBe('true')
    expect(input.disabled).toBe(false)
    await act(async () => answer(new Response(JSON.stringify({ ok: true }), { status: 200 })))
    expect(input.readOnly).toBe(false)
    expect(input.hasAttribute('aria-busy')).toBe(false)
    expect(document.activeElement).toBe(input)
  })

  it('Esc in the steer line clears its text first, then hands the focus to the panel (whose own Esc closes it)', () => {
    shared.rows = [row({ id: 'run' })]
    render([])
    openSteer('run')
    const input = q('[data-agent-row="run"] input') as HTMLInputElement
    input.focus()
    type(input, 'half a thought')
    esc(input)
    expect(input.value).toBe('')
    esc(input)
    expect(document.activeElement).toBe(q('[data-side-panel]'))
  })

  it('no steer line on a delegate’s run, an owner-fallback row or a run just started', () => {
    shared.rows = [
      row({ id: 'delegate', source: { action_id: 'a-1' } }),
      row({ id: 'fallback', source: { owner_fallback: true } }),
      row({ id: 'fresh', created_at: new Date().toISOString() }),
    ]
    render([])
    expect(container.querySelectorAll('[data-agent-row-steer-toggle]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-agent-row] input')).toHaveLength(0)
  })

  it('shows the step line when there is no plan, and handoff children under their root', () => {
    shared.rows = [
      row({ id: 'root', title: 'Research', current_step: 'Reading sites', source: { chat_conversation_id: CONV } }),
      row({ id: 'kid', title: 'Score', root_id: 'root', parent_id: 'root' }),
    ]
    render([])
    expect(q('[data-agent-row="root"] [data-agent-row-step]')?.textContent).toContain('Reading sites')
    const ids = [...container.querySelectorAll('[data-agent-row]')].map((el) => el.getAttribute('data-agent-row'))
    expect(ids).toEqual(['root', 'kid'])
    expect(q('[data-agent-row="kid"]')!.hasAttribute('data-agent-row-child')).toBe(true)
    expect(running()).toBe('2')
  })

  it('counts what runs, never what waits on the person (For you’s)', () => {
    shared.rows = [row({ id: 'a', status: 'needs_input' }), row({ id: 'b', status: 'needs_review' }), row({ id: 'c', status: 'running' }), row({ id: 'd', status: 'queued' })]
    render([])
    expect(running()).toBe('2')
  })
})

const type = (input: HTMLInputElement, value: string) => {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setValue.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const esc = (el: HTMLElement) => act(() => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))

describe('flat cost', () => {
  it('opens no realtime channel of its own: it reads the shared rows', () => {
    shared.rows = [row({ id: 'mine' })]
    render([assistant([planPart(FIVE)])])
    expect(createClient).not.toHaveBeenCalled()
    for (const file of ['chat-widgets.tsx', 'chat-widgets-model.ts']) {
      const src = readFileSync(join(__dirname, '..', file), 'utf8')
      expect(src).not.toMatch(/\.channel\(|createClient|postgres_changes|useAgentWork\(/)
    }
  })
})
