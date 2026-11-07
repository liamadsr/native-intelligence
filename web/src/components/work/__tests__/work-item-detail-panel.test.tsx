// @vitest-environment jsdom
/**
 * The work item detail panel (ACTIVITY-AND-REVIEW-DESIGN §4.2): one panel for
 * every kind of background work, rendered from the `output` the item route
 * folds out of the execution rows (src/lib/work/output.ts).
 *
 * What is locked in here: the sections read in one order (Needs you → What
 * happened → For you → Delivered → Everything it looked at → Task/Log →
 * Steps); a card's own verbs are the same PATCH the rail issues; deliverables
 * shown inline are never repeated under Delivered; a cards row that DOES reach
 * Delivered opens the run instead of this panel; and Send / Merge never appear
 * here (NORTH-STAR invariant 5).
 *
 * Embedded in a bot's page (bots-v4.md Phase 2): no toolbar of its own (Stop
 * and Open run under the title), its properties in the column, never the
 * window's inspector; stamped opened only while the page shows it; it hands
 * its host the item as loaded. Its handoff links open where any item opens
 * (useOpenWorkItem), and its writes name the item's own workspace.
 *
 * A local agent's turn (local-agents contract G): its session's conversation
 * (LocalAgentPanel) in the column unless the page draws it beside; its
 * question is answered there, so it is never offered Stop waiting.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({
  /** The cards the panel asked for (the tabs provider isn't mounted: the requests are the result). */
  navigate: vi.fn(),
  openDeliverable: vi.fn(async () => true),
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
  /** What the bell holds (useNotifications). */
  notices: [] as Array<{ id: string; is_read: boolean; target_type: string | null; target_id: string | null }>,
  /** The bots' notices the window holds (bots-v4 Phase 4c: never the bell's). */
  botNotices: [] as Array<{ id: string; is_read: boolean; target_type: string | null; target_id: string | null; metadata: Record<string, unknown> }>,
  /** Where any work item opens (useOpenWorkItem, bots-v4.md Phase 2). */
  openWorkItem: vi.fn(),
}))

vi.mock('sonner', () => ({ toast: hoisted.toast }))
vi.mock('@/app/account/notification-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/account/notification-context')>()),
  useNotifications: () => ({ notifications: hoisted.notices, botNotices: hoisted.botNotices }),
}))
window.addEventListener('dial8:open-card', (e) => hoisted.navigate((e as CustomEvent).detail))
vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceId: () => 'w1' }))
vi.mock('@/components/agent-run/run-question-section', () => ({
  RunQuestionSection: ({ runId }: { runId: string }) => h('div', { 'data-testid': 'question', 'data-run': runId }, 'question form'),
}))
vi.mock('@/lib/work/open-deliverable', () => ({ openDeliverable: hoisted.openDeliverable }))
vi.mock('@/hooks/use-open-teammate', () => ({ useOpenWorkItem: () => hoisted.openWorkItem }))
vi.mock('@/components/local-agent/local-agent-panel', () => ({
  LocalAgentPanel: ({ sessionId }: { sessionId: string }) => h('div', { 'data-testid': 'local-agent-panel', 'data-session': sessionId }),
}))
// Row 4: the panel is live over two filtered row channels instead of a 5 s poll.
// Captured here so a test can push a row through them.
const rowChannels = vi.hoisted(
  () =>
    [] as Array<{
      table: string
      filter: string | null
      onRow: (row: Record<string, unknown>) => void
      onResync?: () => void
    }>,
)
vi.mock('@/hooks/use-row-changes', () => ({
  useRowChanges: (opts: (typeof rowChannels)[number]) => {
    rowChannels.push(opts)
  },
}))

import { emptyOutput, type WorkOutput, type WorkOutputCard, type WorkOutputDecision, type WorkOutputDraft } from '@/lib/work/output'
import type { WorkItem } from '@/lib/work/types'
import { WorkItemDetailPanel } from '../work-item-detail-panel'

// ─── Fixtures ────────────────────────────────────────────────────────────

const MAIL_ITEM: WorkItem = {
  id: 'job-1',
  workspace_id: 'w1',
  member_id: 'm1',
  kind: 'email_drafts',
  title: 'Reply drafts for 2 threads',
  status: 'needs_review',
  actor: 'loop',
  current_step: null,
  progress: {
    done: 2,
    total: 2,
    steps: [
      { at: '2026-09-17T10:00:00.000Z', text: 'Reading 2 threads that need a reply' },
      { at: '2026-09-17T10:00:20.000Z', text: 'Drafted reply 2 of 2' },
    ],
  },
  result_summary: '2 drafts ready to review',
  error_message: null,
  skip_reason: null,
  deliverables: [
    { type: 'email_draft', id: 'd1', label: 'Re: Pricing' },
    { type: 'email_draft', id: 'd2', label: 'Re: Renewal', resolved_at: '2026-09-17T11:00:00.000Z' },
  ],
  needs: { kind: 'review', verb: 'review' },
  source: { thread_ids: ['t1', 't2'] },
  run_key: null,
  agent_run_id: null,
  flow_run_id: null,
  created_at: '2026-09-17T09:59:00.000Z',
  started_at: '2026-09-17T10:00:00.000Z',
  finished_at: '2026-09-17T10:00:30.000Z',
  reviewed_at: null,
  last_beat_at: '2026-09-17T10:00:30.000Z',
  deadline_at: null,
}

const DRAFT_REFS = {
  d1: { provider_thread_id: 'thr-1', folder: 'inbox', status: 'pending_review' },
  d2: { provider_thread_id: 'thr-2', folder: 'inbox', status: 'sent' },
}

function item(over: Partial<WorkItem>): WorkItem {
  return { ...MAIL_ITEM, ...over }
}

function output(over: Partial<WorkOutput> = {}): WorkOutput {
  return { ...emptyOutput(), ...over }
}

function card(over: Partial<WorkOutputCard> & { id: string; title: string }): WorkOutputCard {
  return {
    kind: 'action_card',
    why: null,
    status: 'pending',
    created_at: '2026-09-17T10:00:10.000Z',
    resolved_at: null,
    expires_at: null,
    proposal_id: null,
    detail: null,
    priority: null,
    due_date: null,
    entity_type: null,
    change_type: null,
    email_to: null,
    email_subject: null,
    ...over,
  }
}

function decision(over: Partial<WorkOutputDecision> & { proposal_id: string; title: string }): WorkOutputDecision {
  return {
    decision: 'accept',
    outcome: 'applied',
    reason: '',
    detail: null,
    entity_id: null,
    entity_type: null,
    change_type: null,
    proposal_status: null,
    ...over,
  }
}

function draft(over: Partial<WorkOutputDraft> & { id: string }): WorkOutputDraft {
  return { subject: null, to: [], snippet: null, status: null, ...over }
}

const MAIL_OUTPUT = output({
  drafts: [
    draft({ id: 'd1', subject: 'Re: Pricing', to: ['dana@acme.com'], snippet: 'Hi Dana, that works — Tuesday at 10 suits us.', status: 'pending_review' }),
    draft({ id: 'd2', subject: 'Re: Renewal', to: ['sam@acme.com'], snippet: 'Sending the renewal doc over now.', status: 'sent' }),
  ],
})

const FLOW_ITEM = item({
  id: 'job-1',
  kind: 'flow_run',
  title: 'Meeting triage',
  status: 'done',
  result_summary: 'Filed 1, 2 for you',
  needs: null,
  deliverables: [
    { type: 'attention_cards', id: 'fr-1', label: '2 cards for you', count: 2 },
    { type: 'document', id: 'doc-1', label: 'Output document' },
  ],
  source: { capture_id: 'cap-1', flow_id: 'flow-1' },
  flow_run_id: 'fr-1',
  progress: { steps: [{ at: '2026-09-17T10:00:00.000Z', text: 'Reading the pricing sync' }] },
})

const FLOW_OUTPUT = output({
  narrative: 'One real commitment came out of the pricing sync.',
  cards: [
    card({
      id: 'card-1',
      kind: 'action_card',
      title: 'Book the follow-up',
      why: 'Dana asked on the call',
      detail: 'Book 30 minutes with Dana next week',
      priority: 'high',
      due_date: '2026-09-20',
      proposal_id: 'p1',
    }),
    card({ id: 'card-2', kind: 'work_proposal', title: 'Draft the pricing recap', detail: 'Write the recap and send it to Dana', proposal_id: 'p2' }),
    card({ id: 'card-3', title: 'Share the deck', status: 'accepted', resolved_at: '2026-09-17T10:05:00.000Z' }),
  ],
  decisions: [
    decision({ proposal_id: 'p1', title: 'Book a follow-up with Dana', outcome: 'applied', reason: 'Dana asked for it on the call' }),
    decision({ proposal_id: 'p3', title: 'Chase the security review', decision: 'dismiss', outcome: 'dismissed', reason: 'Already tracked as ENG-12' }),
    decision({ proposal_id: 'p4', title: 'Rename the pricing project', decision: 'dismiss', outcome: 'dismissed', reason: 'Not a commitment' }),
  ],
  context: [
    { type: 'capture', id: 'cap-1', label: 'Pricing sync with Dana' },
    { type: 'flow', id: 'flow-1', label: 'Meeting triage loop' },
  ],
  labels: { 'document:doc-1': 'Q3 pricing recap' },
})

// ─── Harness ─────────────────────────────────────────────────────────────

let container: HTMLDivElement
let root: Root
let fetchMock: ReturnType<typeof vi.fn>
let payload: Record<string, unknown>
let documentHidden = false
let documentFocused = true
/** What the `opened` PATCH stores (migration 295). */
const STAMPED = '2026-09-17T12:30:00.000Z'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function render(
  itemId = 'job-1',
  { embedded = false, shown = true, onItem }: { embedded?: boolean; shown?: boolean; onItem?: (item: WorkItem | null, failed: boolean) => void } = {},
) {
  act(() => {
    root.render(h(WorkItemDetailPanel, { itemId, onClose: vi.fn(), ...(embedded ? { embedded, shown, onItem } : {}) }))
  })
  return flush()
}

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'))
}

function button(label: string): HTMLButtonElement | undefined {
  return buttons().find((b) => b.textContent?.trim() === label)
}

function buttonStartingWith(label: string): HTMLButtonElement | undefined {
  return buttons().find((b) => (b.textContent ?? '').trim().startsWith(label))
}

function text(): string {
  return container.textContent ?? ''
}

async function click(el: Element | undefined) {
  expect(el).toBeDefined()
  await act(async () => {
    ;(el as HTMLElement).click()
    await Promise.resolve()
  })
  await flush()
}

function calls(url: string, method?: string) {
  return fetchMock.mock.calls.filter(
    ([u, init]) => u === url && (!method || (init as RequestInit | undefined)?.method === method),
  )
}

beforeEach(() => {
  documentHidden = false
  documentFocused = true
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => documentHidden)
  vi.spyOn(document, 'hasFocus').mockImplementation(() => documentFocused)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  payload = { item: MAIL_ITEM, run: null, drafts: DRAFT_REFS, output: MAIL_OUTPUT }
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/account/attention-items') return jsonResponse({ ok: true })
    if (url.startsWith('/api/account/activity/') && init?.method === 'PATCH' && String(init.body).includes('"opened"')) {
      // The route stamps an empty opened_at and answers with what is stored.
      const held = payload.item as WorkItem
      const changed = !held.opened_at
      if (changed) payload = { ...payload, item: { ...held, opened_at: STAMPED } }
      return jsonResponse({ ok: true, changed, opened_at: (payload.item as WorkItem).opened_at })
    }
    if (url.startsWith('/api/account/activity/') && init?.method === 'PATCH') {
      const after = { ...(payload.item as object), status: 'done', needs: null, reviewed_at: '2026-09-17T12:00:00.000Z' }
      payload = { ...payload, item: after }
      return jsonResponse({ ok: true, changed: true, item: after })
    }
    if (init?.method === 'POST') return jsonResponse({ ok: true })
    return jsonResponse(payload)
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// ─── Tests ───────────────────────────────────────────────────────────────

describe('WorkItemDetailPanel — a pass that wrote drafts', () => {
  it('shows what it wrote, what it needs, and the steps it took (collapsed)', async () => {
    await render()
    expect(fetchMock).toHaveBeenCalledWith('/api/account/activity/job-1', expect.objectContaining({ cache: 'no-store' }))
    expect(container.querySelector('h1')?.textContent).toBe('Reply drafts for 2 threads')
    expect(text()).toContain('Ready to review')
    expect(text()).toContain('Email assistant')

    // Needs you — one of the two drafts is still unreviewed.
    expect(text()).toContain('Needs you')
    expect(text()).toContain('Review 1 draft')
    expect(button('Mark reviewed')).toBeDefined()
    expect(button('Dismiss')).toBeDefined()

    // For you — each draft with what it says and the verb that opens it.
    expect(text()).toContain('For you')
    expect(text()).toContain('Re: Pricing')
    expect(text()).toContain('To dana@acme.com')
    expect(text()).toContain('Hi Dana, that works — Tuesday at 10 suits us.')
    expect(text()).toContain('Re: Renewal')
    expect(button('Review draft')).toBeDefined()
    expect(button('Open draft')).toBeDefined()

    // Shown inline, so never repeated as a Delivered row.
    expect(text()).not.toContain('Delivered')

    // Settled: the steps are folded away until asked for.
    const steps = buttonStartingWith('Steps')
    expect(steps?.getAttribute('aria-expanded')).toBe('false')
    expect(text()).not.toContain('Drafted reply 2 of 2')
    await click(steps)
    expect(text()).toContain('Reading 2 threads that need a reply')
    expect(text()).toContain('Drafted reply 2 of 2')

    // Send lives in Mail, never here.
    expect(buttons().some((b) => b.textContent?.trim() === 'Send')).toBe(false)
  })

  it('routes a draft through openDeliverable with what the route resolved, on this item', async () => {
    await render()
    await click(button('Review draft'))
    expect(hoisted.openDeliverable).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'email_draft', id: 'd1' }),
      { drafts: DRAFT_REFS, itemId: 'job-1' },
      expect.objectContaining({ workspaceId: 'w1', foreignWorkspaceId: null }),
    )
  })

  it('Mark reviewed PATCHes the item and re-renders it settled', async () => {
    await render()
    await click(button('Mark reviewed'))
    const patch = calls('/api/account/activity/job-1', 'PATCH')[0]
    expect(patch).toBeDefined()
    expect(JSON.parse((patch[1] as RequestInit).body as string)).toEqual({ action: 'reviewed' })
    expect(text()).toContain('Done')
    expect(button('Mark reviewed')).toBeUndefined()
  })
})

describe('WorkItemDetailPanel — opening it stamps it opened (migration 295)', () => {
  const openedPatches = () =>
    calls('/api/account/activity/job-1', 'PATCH').filter(([, init]) => JSON.parse((init as RequestInit).body as string).action === 'opened')
  const itemChannel = () => rowChannels.filter((c) => c.table === 'tracked_job' && c.filter === 'id=eq.job-1').at(-1)!
  /** The row as the database now holds it: what a reload reads and the push carries. */
  async function push(row: WorkItem) {
    payload = { ...payload, item: row }
    await act(async () => itemChannel().onRow({ ...row }))
    await flush()
  }

  beforeEach(() => {
    rowChannels.length = 0
    hoisted.notices = []
    hoisted.botNotices = []
  })

  it('opened before, it still reads a notice that landed since (bots v3 1b): one opened PATCH for the bell’s unread notices about it', async () => {
    hoisted.notices = [
      { id: 'n-digest', is_read: false, target_type: 'work_item', target_id: 'job-1' },
      { id: 'n-read', is_read: true, target_type: 'work_item', target_id: 'job-1' },
      { id: 'n-other', is_read: false, target_type: 'work_item', target_id: 'job-2' },
    ]
    payload = { ...payload, mine: true, item: { ...MAIL_ITEM, opened_at: '2026-09-17T11:00:00.000Z' } }
    await render()
    expect(openedPatches()).toHaveLength(1)
    // Pushed rows don't send it again for the same notices.
    await push({ ...(payload.item as WorkItem), last_beat_at: '2026-09-17T12:40:00.000Z' })
    expect(openedPatches()).toHaveLength(1)
  })

  it('opened before, it reads its bot’s late notice too, which the bell never lists (bots-v4 Phase 4c)', async () => {
    hoisted.notices = []
    hoisted.botNotices = [
      { id: 'n-bot', is_read: false, target_type: 'work_item', target_id: 'job-1', metadata: { teammate_id: 'tm-1', sentence: 'I drafted a reply.' } },
    ]
    payload = { ...payload, mine: true, item: { ...MAIL_ITEM, opened_at: '2026-09-17T11:00:00.000Z' } }
    await render()
    expect(openedPatches()).toHaveLength(1)
    // Read on the server (the realtime UPDATE reaches the window): nothing more is sent.
    hoisted.botNotices = [{ ...hoisted.botNotices[0], is_read: true }]
    await push({ ...(payload.item as WorkItem), last_beat_at: '2026-09-17T12:40:00.000Z' })
    expect(openedPatches()).toHaveLength(1)
  })

  it('opened before, from another workspace (a bot’s page, Phase 2): its notices are read once per open, though the bell holds only this workspace’s', async () => {
    // The bell holds nothing about it: its notices are the other workspace's.
    hoisted.notices = []
    payload = { ...payload, mine: true, item: { ...MAIL_ITEM, workspace_id: 'w2', opened_at: '2026-09-17T11:00:00.000Z' } }
    await render()
    expect(openedPatches()).toHaveLength(1)
    // Once per open: pushed rows don't send it again.
    await push({ ...(payload.item as WorkItem), last_beat_at: '2026-09-17T12:40:00.000Z' })
    expect(openedPatches()).toHaveLength(1)
    // Opened again later: once more.
    act(() => root.unmount())
    root = createRoot(container)
    await render()
    expect(openedPatches()).toHaveLength(2)
    // Never another's, nor out of sight.
    act(() => root.unmount())
    root = createRoot(container)
    payload = { ...payload, mine: false }
    await render()
    expect(openedPatches()).toHaveLength(2)
  })

  it('opened before, with nothing unread about it in the bell, or not the viewer’s: nothing sent', async () => {
    hoisted.notices = [{ id: 'n-other', is_read: false, target_type: 'work_item', target_id: 'job-2' }]
    payload = { ...payload, mine: true, item: { ...MAIL_ITEM, opened_at: '2026-09-17T11:00:00.000Z' } }
    await render()
    expect(openedPatches()).toHaveLength(0)
    act(() => root.unmount())
    root = createRoot(container)
    hoisted.notices = [{ id: 'n-digest', is_read: false, target_type: 'work_item', target_id: 'job-1' }]
    payload = { ...payload, mine: false }
    await render()
    expect(openedPatches()).toHaveLength(0)
  })

  it('the owner opening an unopened item stamps it once; reloads and pushed rows carrying the stamp never stamp again', async () => {
    payload = { ...payload, mine: true }
    await render()
    expect(openedPatches()).toHaveLength(1)
    expect(JSON.parse((openedPatches()[0][1] as RequestInit).body as string)).toEqual({ action: 'opened' })
    // A reload (Mark reviewed re-reads the item) and pushed rows carry the stamp.
    await click(button('Mark reviewed'))
    expect((payload.item as WorkItem).opened_at).toBe(STAMPED)
    await push({ ...(payload.item as WorkItem) })
    await push({ ...(payload.item as WorkItem), last_beat_at: '2026-09-17T12:40:00.000Z' })
    expect(openedPatches()).toHaveLength(1)
  })

  it('any status: a settled item the owner opens is stamped too', async () => {
    payload = { item: FLOW_ITEM, run: null, drafts: {}, output: FLOW_OUTPUT, mine: true }
    await render()
    expect(openedPatches()).toHaveLength(1)
  })

  it('never for a row the viewer does not own, or one already opened', async () => {
    payload = { ...payload, mine: false }
    await render()
    expect(openedPatches()).toHaveLength(0)
    act(() => root.unmount())
    root = createRoot(container)
    payload = { ...payload, mine: true, item: { ...MAIL_ITEM, opened_at: '2026-09-17T11:00:00.000Z' } }
    await render()
    expect(openedPatches()).toHaveLength(0)
  })

  it('a row that starts waiting on you again while the panel is open is stamped again, once per time', async () => {
    // Opened earlier, while it ran.
    payload = { ...payload, mine: true, item: item({ status: 'running', needs: null, opened_at: '2026-09-17T11:00:00.000Z' }) }
    await render()
    expect(openedPatches()).toHaveLength(0)
    // It settles with a draft: the recorder clears the stamp in that write.
    await push(item({ status: 'needs_review', opened_at: null }))
    expect(openedPatches()).toHaveLength(1)
    expect((payload.item as WorkItem).opened_at).toBe(STAMPED)
    // The stamp's own UPDATE comes back, then a later write on the row: nothing more.
    await push({ ...(payload.item as WorkItem) })
    await push({ ...(payload.item as WorkItem), last_beat_at: '2026-09-17T12:45:00.000Z' })
    expect(openedPatches()).toHaveLength(1)
    // Back to running, then waiting again: one more stamp.
    await push({ ...(payload.item as WorkItem), status: 'running', needs: null })
    expect(openedPatches()).toHaveLength(1)
    await push(item({ status: 'needs_input', needs: { kind: 'input', questions: [] }, opened_at: null }))
    expect(openedPatches()).toHaveLength(2)
    await push({ ...(payload.item as WorkItem) })
    expect(openedPatches()).toHaveLength(2)
  })

  it.each([
    ['the part of a bot’s page it isn’t in', { embedded: true, shown: false }],
  ])('keeps new work unopened in %s until its panel is shown', async (_name, visibility) => {
    payload = { ...payload, mine: true, item: item({ status: 'running', needs: null, opened_at: STAMPED }) }
    await render()
    await render('job-1', visibility)
    await push(item({ status: 'needs_review', opened_at: null }))
    expect(openedPatches()).toHaveLength(0)
    expect((payload.item as WorkItem).opened_at).toBeNull()

    await render()
    expect(openedPatches()).toHaveLength(1)
    await render()
    expect(openedPatches()).toHaveLength(1)
  })

  it.each(['unfocused', 'hidden'] as const)('keeps a newly waiting item unopened while the document is %s', async (away) => {
    payload = { ...payload, mine: true, item: item({ status: 'running', needs: null, opened_at: STAMPED }) }
    await render()
    act(() => {
      if (away === 'unfocused') {
        documentFocused = false
        window.dispatchEvent(new Event('blur'))
      } else {
        documentHidden = true
        document.dispatchEvent(new Event('visibilitychange'))
      }
    })
    await push(item({ status: 'needs_input', needs: { kind: 'input', questions: [] }, opened_at: null }))
    expect(openedPatches()).toHaveLength(0)

    act(() => {
      documentFocused = true
      documentHidden = false
      if (away === 'unfocused') window.dispatchEvent(new Event('focus'))
      else document.dispatchEvent(new Event('visibilitychange'))
    })
    await flush()
    expect(openedPatches()).toHaveLength(1)
  })

  it('does not stamp an unopened item loaded initially in a background window', async () => {
    documentFocused = false
    payload = { ...payload, mine: true }
    await render()
    expect(openedPatches()).toHaveLength(0)
    act(() => {
      documentFocused = true
      window.dispatchEvent(new Event('focus'))
    })
    await flush()
    expect(openedPatches()).toHaveLength(1)
  })

  it('a stamp that lands nothing is never sent again: not by pushed rows, not by reloads (no loop)', async () => {
    payload = { ...payload, mine: true }
    const base = fetchMock.getMockImplementation()!
    // A database without migration 295: markOpened is a quiet no-op, and no row carries the column.
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === 'PATCH' && String(init.body).includes('"opened"')
        ? jsonResponse({ ok: true, changed: false, opened_at: null })
        : base(url, init),
    )
    await render()
    expect(openedPatches()).toHaveLength(1)
    for (let i = 0; i < 3; i += 1) await push({ ...MAIL_ITEM, last_beat_at: `2026-09-17T12:0${i}:00.000Z` })
    // A status move refetches the item too.
    await push({ ...MAIL_ITEM, status: 'running', needs: null })
    await push({ ...MAIL_ITEM })
    expect(openedPatches()).toHaveLength(1)
  })

  it('a stamp in flight is not doubled by rows pushed meanwhile', async () => {
    payload = { ...payload, mine: true }
    const base = fetchMock.getMockImplementation()!
    let land: (res: Response) => void = () => {}
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      init?.method === 'PATCH' && String(init.body).includes('"opened"')
        ? new Promise<Response>((resolve) => {
            land = resolve
          })
        : base(url, init),
    )
    await render()
    expect(openedPatches()).toHaveLength(1)
    await push({ ...MAIL_ITEM, last_beat_at: '2026-09-17T12:01:00.000Z' })
    await push({ ...MAIL_ITEM, last_beat_at: '2026-09-17T12:02:00.000Z' })
    expect(openedPatches()).toHaveLength(1)
    payload = { ...payload, item: { ...MAIL_ITEM, opened_at: STAMPED } }
    await act(async () => land(jsonResponse({ ok: true, changed: true, opened_at: STAMPED })))
    await flush()
    await push({ ...MAIL_ITEM, opened_at: STAMPED })
    expect(openedPatches()).toHaveLength(1)
  })

  it('never blocks the panel: a failed stamp leaves it as it was, quietly', async () => {
    payload = { ...payload, mine: true }
    const base = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === 'PATCH' ? jsonResponse({ error: 'nope' }, 500) : base(url, init),
    )
    await render()
    expect(openedPatches()).toHaveLength(1)
    expect(container.querySelector('h1')?.textContent).toBe('Reply drafts for 2 threads')
    expect(hoisted.toast.error).not.toHaveBeenCalled()
  })
})

describe('WorkItemDetailPanel — a loop run', () => {
  beforeEach(() => {
    payload = { item: FLOW_ITEM, run: null, drafts: {}, output: FLOW_OUTPUT }
  })

  it("tells the run's own account, the cards it surfaced and what it decided about the rest", async () => {
    await render()

    // What happened — the run's words, with the ledger's settle line under it.
    expect(text()).toContain('What happened')
    expect(text()).toContain('One real commitment came out of the pricing sync.')
    expect(text()).toContain('Filed 1, 2 for you')

    // For you — what each card proposes, where it stands, and its own verbs.
    expect(text()).toContain('2 waiting')
    expect(text()).toContain('Book the follow-up')
    expect(text()).toContain('Dana asked on the call')
    expect(text()).toContain('Book 30 minutes with Dana next week')
    expect(button('Accept')).toBeDefined()
    expect(button('Start')).toBeDefined()
    expect(button('Dismiss')).toBeDefined()
    expect(text()).toContain('Accepted')

    // The cards are on screen, so their deliverable row is not repeated.
    expect(text()).not.toContain('2 cards for you')
    expect(text()).not.toContain('See 2 cards')
    // …and the deliverables that are not shown inline still are.
    expect(text()).toContain('Delivered')
    expect(text()).toContain('Q3 pricing recap')

    // Everything it looked at — collapsed, by outcome, with each reason.
    const looked = buttonStartingWith('Everything it looked at')
    expect(looked?.textContent).toContain('3')
    expect(looked?.getAttribute('aria-expanded')).toBe('false')
    await click(looked)
    expect(text()).toContain('Dismissed (2)')
    expect(text()).toContain('Chase the security review')
    expect(text()).toContain('Already tracked as ENG-12')
    expect(text()).toContain('Rename the pricing project')

    // A loop run's toolbar opens the flow's run history, not an agent run.
    expect(container.querySelector('[aria-label="Run history"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Open run"]')).toBeNull()

    // Nothing was opened just by rendering — the cards row least of all.
    expect(hoisted.openDeliverable).not.toHaveBeenCalled()
  })

  it("Accept issues the card's own PATCH and re-reads the item", async () => {
    await render()
    expect(calls('/api/account/activity/job-1')).toHaveLength(1)
    await click(button('Accept'))
    const patch = calls('/api/account/attention-items', 'PATCH')[0]
    expect(patch).toBeDefined()
    expect(JSON.parse((patch[1] as RequestInit).body as string)).toEqual({ id: 'card-1', action: 'accept' })
    // The panel re-reads the item, so the card shows where it landed.
    expect(calls('/api/account/activity/job-1').length).toBeGreaterThan(1)
  })

  it('lists what it acted on in the sidebar and opens it as its record card', async () => {
    await render()
    expect(text()).toContain('Source')
    expect(text()).toContain('Pricing sync with Dana')
    expect(text()).toContain('Meeting triage loop')
    await click(button('Pricing sync with Dana'))
    expect(hoisted.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ spec: expect.objectContaining({ kind: 'record', record: { type: 'capture', id: 'cap-1' } }) }),
    )
  })

  it('falls back to a Delivered cards row — opening the run — when the cards could not be loaded', async () => {
    payload = { item: FLOW_ITEM, run: null, drafts: {}, output: output({ narrative: 'Two things need you.' }) }
    await render()
    expect(text()).toContain('Delivered')
    const row = buttonStartingWith('Cards')
    expect(row?.textContent).toContain('2 cards for you')
    expect(row?.textContent).toContain('See 2 cards')
    await click(row)
    // No itemId: this panel is where the row already is, so it opens the run.
    expect(hoisted.openDeliverable).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'attention_cards', id: 'fr-1' }),
      { drafts: {} },
      expect.objectContaining({ workspaceId: 'w1' }),
    )
  })

  it("shows the run's own error, not the ledger's summary of it", async () => {
    payload = {
      item: item({ ...FLOW_ITEM, status: 'failed', error_message: '1 action failed', result_summary: null }),
      run: null,
      drafts: {},
      output: output({ error: 'Anthropic API: overloaded_error' }),
    }
    await render()
    expect(text()).toContain('Failed')
    expect(text()).toContain('Anthropic API: overloaded_error')
    expect(text()).not.toContain('1 action failed')
  })
})

describe('WorkItemDetailPanel — an agent run', () => {
  beforeEach(() => {
    payload = {
      item: item({
        kind: 'work_run',
        title: 'Draft the pricing recap',
        status: 'needs_input',
        needs: { kind: 'input', questions: [{ question: 'Which tone?' }] },
        deliverables: [],
        result_summary: null,
        finished_at: null,
        agent_run_id: 'run-1',
        source: { action_id: 'act-1', agent_run_id: 'run-1' },
        progress: {},
      }),
      run: { id: 'run-1', status: 'needs_input', kind: 'workspace', action_id: 'act-1', pr_url: null, pending_input: { questions: [] } },
      drafts: {},
      output: output({
        run: {
          id: 'run-1',
          status: 'needs_input',
          kind: 'workspace',
          task: 'Draft the recap and send it to Dana',
          resources: [{ type: 'capture', id: 'cap-1', label: 'Pricing sync' }],
          log_tail: '$ npm test\nPASS',
          sandbox_id: 'sb-1',
          pr_url: null,
          branch: null,
          repo_full_name: null,
          started_at: '2026-09-17T10:00:00.000Z',
          finished_at: null,
        },
      }),
    }
  })

  it('shows the parked question, the brief it was given and its log, and can stop the run', async () => {
    await render()
    expect(container.querySelector('[data-testid="question"]')?.getAttribute('data-run')).toBe('run-1')
    expect(text()).toContain('Draft the recap and send it to Dana')
    expect(text()).toContain('Pricing sync')
    expect(buttonStartingWith('Log')).toBeDefined()

    const stop = button('Stop')
    expect(stop).toBeDefined()
    await click(stop)
    // In the run's own workspace (a bot's page can show an item from one not on screen).
    expect(fetchMock).toHaveBeenCalledWith('/api/account/actions/act-1/agent-runs/run-1/cancel', { method: 'POST', headers: { 'x-workspace-id': 'w1' } })
  })

  it('an attempted run with NO tracked action (anchored to its capture) can still be stopped, through the run-scoped route', async () => {
    const withAction = payload as { item: Record<string, unknown>; run: Record<string, unknown> }
    payload = {
      ...(payload as object),
      item: { ...withAction.item, source: { agent_run_id: 'run-1', capture_id: 'cap-1', entity_type: 'capture', entity_id: 'cap-1' } },
      run: { ...withAction.run, action_id: null },
    } as typeof payload
    await render()
    const stop = button('Stop')
    expect(stop).toBeDefined()
    await click(stop)
    expect(fetchMock).toHaveBeenCalledWith('/api/account/agent-runs/run-1/cancel', { method: 'POST', headers: { 'x-workspace-id': 'w1' } })
  })

  it('a live question offers no Stop waiting: it is answered, or its run stopped', async () => {
    await render()
    expect(container.querySelector('[data-stale-question]')).toBeNull()
    expect(button('Stop waiting')).toBeUndefined()
  })

  it('its run is gone (deleted with its action): no question form, and Stop waiting stops waiting on it', async () => {
    const live = payload as { item: Record<string, unknown> }
    payload = { ...(payload as object), item: { ...live.item, agent_run_id: null, source: {} }, run: null } as typeof payload
    await render()
    expect(container.querySelector('[data-testid="question"]')).toBeNull()
    expect(container.querySelector('[data-stale-question]')).not.toBeNull()
    expect(button('Stop')).toBeUndefined()
    await click(button('Stop waiting'))
    const sent = calls('/api/account/activity/job-1', 'PATCH').map(([, init]) => JSON.parse(String((init as RequestInit).body)))
    expect(sent).toContainEqual({ action: 'stop_waiting' })
  })

  it('its run moved on without the ledger hearing (no longer parked): Stop waiting is offered too', async () => {
    const live = payload as { run: Record<string, unknown> }
    payload = { ...(payload as object), run: { ...live.run, status: 'completed' } } as typeof payload
    await render()
    expect(container.querySelector('[data-testid="question"]')).toBeNull()
    expect(button('Stop waiting')).toBeDefined()
  })
})

describe('WorkItemDetailPanel — nothing to show', () => {
  it('says so when the item cannot be loaded', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ error: 'nope' }, 404))
    await render('gone')
    expect(text()).toContain('no longer available')
  })
})

describe('WorkItemDetailPanel — contacts held from HubSpot (the tier-2 gate, Sequence step 2)', () => {
  const HELD = [
    { id: 'c-1', full_name: 'Held Contact One', email: 'one@example.com', held_at: '2026-09-17T10:00:00.000Z' },
    { id: 'c-2', full_name: 'Held Contact Two', email: null, held_at: null },
  ]
  beforeEach(() => {
    payload = { item: MAIL_ITEM, run: null, drafts: DRAFT_REFS, output: MAIL_OUTPUT, held_contacts: HELD }
  })

  it('lists them with Release per contact and Release all; Mark reviewed alone releases nothing', async () => {
    await render()
    expect(text()).toContain('Held from HubSpot')
    expect(text()).toContain('Held Contact One')
    expect(text()).toContain('one@example.com')
    expect(buttons().filter((b) => b.textContent?.trim() === 'Release')).toHaveLength(2)
    expect(button('Release all')).toBeDefined()
    await click(button('Mark reviewed'))
    expect(calls('/api/account/contacts/c-1/hubspot-hold', 'POST')).toHaveLength(0)
    expect(calls('/api/account/contacts/c-2/hubspot-hold', 'POST')).toHaveLength(0)
    // Reviewed, but still held: the block stays until someone releases.
    expect(text()).toContain('Held from HubSpot')
  })

  it("Release POSTs that contact's hubspot-hold route and re-reads the item", async () => {
    await render()
    const release = buttons().filter((b) => b.textContent?.trim() === 'Release')[0]
    payload = { ...payload, held_contacts: [HELD[1]] }
    await click(release)
    expect(calls('/api/account/contacts/c-1/hubspot-hold', 'POST')).toHaveLength(1)
    // In the item's own workspace: the hold route scopes to the header's.
    expect((calls('/api/account/contacts/c-1/hubspot-hold', 'POST')[0][1] as RequestInit).headers).toEqual({ 'x-workspace-id': 'w1' })
    expect(calls('/api/account/contacts/c-2/hubspot-hold', 'POST')).toHaveLength(0)
    expect(calls('/api/account/activity/job-1').length).toBeGreaterThanOrEqual(2)
    expect(text()).not.toContain('Held Contact One')
    expect(text()).toContain('Held Contact Two')
    expect(button('Release all')).toBeUndefined()
  })

  it('Release all POSTs every held contact, then the block is gone', async () => {
    await render()
    payload = { ...payload, held_contacts: [] }
    await click(button('Release all'))
    expect(calls('/api/account/contacts/c-1/hubspot-hold', 'POST')).toHaveLength(1)
    expect(calls('/api/account/contacts/c-2/hubspot-hold', 'POST')).toHaveLength(1)
    expect(text()).not.toContain('Held from HubSpot')
  })

  it('opens a held contact as its record card', async () => {
    await render()
    await click(buttonStartingWith('Held Contact One'))
    expect(hoisted.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ spec: expect.objectContaining({ kind: 'record', title: 'Held Contact One', record: { type: 'contact', id: 'c-1' } }) }),
    )
  })

  it('shows nothing of the kind when the run created no held contact', async () => {
    payload = { ...payload, held_contacts: [] }
    await render()
    expect(text()).not.toContain('Held from HubSpot')
  })
})

describe('WorkItemDetailPanel — live without polling (row 4)', () => {
  /** The panel's latest binding for a table (every render re-registers). Its
   *  own row is `id=eq.<item>`; its handoffs bind `parent_id=eq.<item>` (row 14). */
  const channel = (table: string) =>
    [...rowChannels].reverse().find((c) => c.table === table && !(c.filter ?? '').startsWith('parent_id='))!
  const childrenChannel = () => [...rowChannels].reverse().find((c) => (c.filter ?? '').startsWith('parent_id='))!
  const itemFetches = () => calls('/api/account/activity/job-1').length

  beforeEach(() => {
    rowChannels.length = 0
  })

  it('binds its own row, and no run channel while the item has no run', async () => {
    await render()
    expect(channel('tracked_job').filter).toBe('id=eq.job-1')
    expect(channel('agent_run').filter).toBeNull()
  })

  it('patches a step write in place without a refetch; a status transition refetches the folded output', async () => {
    payload = { ...payload, item: item({ status: 'running', needs: null, current_step: 'Reading 2 threads' }) }
    await render()
    const before = itemFetches()

    await act(async () => {
      channel('tracked_job').onRow({ ...(payload.item as object), title: 'Reply drafts for 3 threads', current_step: 'Drafting reply 1 of 3' })
    })
    await flush()
    expect(container.querySelector('h1')?.textContent).toBe('Reply drafts for 3 threads')
    expect(itemFetches()).toBe(before)

    await act(async () => {
      channel('tracked_job').onRow({ ...(payload.item as object), status: 'needs_review' })
    })
    await flush()
    expect(itemFetches()).toBe(before + 1)
  })

  it('keeps the teammate it already named across a pushed row (the payload has no embed)', async () => {
    const TRIAGE = { id: 'tm-1', name: 'Triage', is_system: true, system_key: 'triage' }
    payload = { ...payload, item: item({ status: 'running', ai_team_member_id: 'tm-1', teammate: TRIAGE }) }
    await render()
    expect(text()).toContain('Triage')
    await act(async () => {
      channel('tracked_job').onRow({ ...item({ status: 'running', ai_team_member_id: 'tm-1' }), teammate: undefined })
    })
    await flush()
    expect(text()).toContain('Triage')
  })

  it('shows the parked question the moment its run parks — from the agent_run row, no refetch', async () => {
    payload = {
      item: item({ status: 'needs_input', agent_run_id: 'run-1', needs: null, source: { action_id: 'act-1', agent_run_id: 'run-1' } }),
      run: { id: 'run-1', status: 'running', kind: 'workspace', action_id: 'act-1', pr_url: null, pending_input: null },
      drafts: {},
      output: output(),
    }
    await render()
    expect(channel('agent_run').filter).toBe('id=eq.run-1')
    expect(container.querySelector('[data-testid="question"]')).toBeNull()
    const before = itemFetches()

    await act(async () => {
      channel('agent_run').onRow({ id: 'run-1', status: 'needs_input', kind: 'workspace', action_id: 'act-1', pr_url: null, pending_input: { questions: [] } })
    })
    await flush()
    expect(container.querySelector('[data-testid="question"]')?.getAttribute('data-run')).toBe('run-1')
    expect(itemFetches()).toBe(before)
  })

  it('a restored channel refetches', async () => {
    await render()
    const before = itemFetches()
    await act(async () => {
      channel('tracked_job').onResync?.()
    })
    await flush()
    expect(itemFetches()).toBe(before + 1)
  })
})

describe('WorkItemDetailPanel — handoffs (row 14)', () => {
  const WRITER = { id: 'tm-w', name: 'Quill', is_system: false, system_key: null, role: 'writer' }
  const RESEARCHER = { id: 'tm-r', name: 'Researcher', is_system: false, system_key: null, role: 'researcher' }
  const parentItem = item({
    id: 'job-1',
    kind: 'work_run',
    title: 'Reply to Acme about the renewal',
    status: 'waiting_on_child',
    needs: { kind: 'child', work_item_id: 'job-2', role: 'researcher' },
    deliverables: [],
    ai_team_member_id: 'tm-w',
    teammate: WRITER,
  })
  const childItem = item({
    id: 'job-2',
    kind: 'work_run',
    title: 'Find the Acme per-seat price',
    status: 'running',
    current_step: 'Searching the web',
    needs: null,
    deliverables: [],
    parent_id: 'job-1',
    root_id: 'job-1',
    depth: 1,
    origin: 'delegation',
    ai_team_member_id: 'tm-r',
    teammate: RESEARCHER,
  })
  const childrenChannel = () => [...rowChannels].reverse().find((c) => (c.filter ?? '').startsWith('parent_id='))!
  const itemFetches = () => calls('/api/account/activity/job-1').length

  beforeEach(() => {
    rowChannels.length = 0
  })

  it('a parent waiting on its handoff shows it live, with its teammate and a link', async () => {
    payload = { item: parentItem, run: null, drafts: {}, output: output(), parent: null, children: [childItem] }
    await render()
    const section = container.querySelector('[data-testid="handoffs"]')!
    expect(section.textContent).toContain('Waiting on')
    expect(section.textContent).toContain('Find the Acme per-seat price')
    expect(section.textContent).toContain('Researcher')
    expect(section.textContent).toContain('Searching the web')
    expect(childrenChannel().filter).toBe('parent_id=eq.job-1')

    // The child finishes: patched in place, no refetch.
    const before = itemFetches()
    await act(async () => {
      childrenChannel().onRow({ ...childItem, status: 'needs_review', needs: { kind: 'review', verb: 'review' }, current_step: null })
    })
    await flush()
    expect(container.querySelector('[data-testid="handoffs"]')!.textContent).toContain('Researcher')
    expect(itemFetches()).toBe(before)

    // Where any item opens: on its own bot's (Researcher's) page, never over the Agents page.
    await click(buttonStartingWith('Find the Acme per-seat price'))
    expect(hoisted.openWorkItem).toHaveBeenCalledWith('job-2', [], { workspaceId: 'w1', title: 'Find the Acme per-seat price', teammateId: 'tm-r' })
    expect(hoisted.navigate).not.toHaveBeenCalled()
  })

  it('a handoff it had not loaded refetches; after the park it reads "Handed off"', async () => {
    payload = { item: { ...parentItem, status: 'done', needs: null }, run: null, drafts: {}, output: output(), parent: null, children: [childItem] }
    await render()
    expect(container.querySelector('[data-testid="handoffs"]')!.textContent).toContain('Handed off')
    const before = itemFetches()
    await act(async () => {
      childrenChannel().onRow({ ...childItem, id: 'job-3', title: 'Another piece' })
    })
    await flush()
    expect(itemFetches()).toBe(before + 1)
  })

  it('a handoff names who delegated it and opens that work', async () => {
    payload = { item: childItem, run: null, drafts: {}, output: output(), parent: parentItem, children: [] }
    await render('job-2')
    const line = container.querySelector('[data-testid="delegated-by"]')!
    expect(line.textContent).toBe('Delegated by Quill (Writer) · Reply to Acme about the renewal')
    expect(container.querySelector('[data-testid="handoffs"]')).toBeNull()
    await click(line)
    expect(hoisted.openWorkItem).toHaveBeenCalledWith('job-1', [], { workspaceId: 'w1', title: 'Reply to Acme about the renewal', teammateId: 'tm-w' })
    expect(hoisted.navigate).not.toHaveBeenCalled()
  })

  it('a handoff whose row names no teammate id goes by its teammate embed; none at all, known to have none', async () => {
    payload = { item: { ...parentItem, status: 'done', needs: null }, run: null, drafts: {}, output: output(), parent: null, children: [{ ...childItem, ai_team_member_id: undefined }] }
    await render()
    await click(buttonStartingWith('Find the Acme per-seat price'))
    expect(hoisted.openWorkItem).toHaveBeenLastCalledWith('job-2', [], expect.objectContaining({ teammateId: 'tm-r' }))
    act(() => root.unmount())
    root = createRoot(container)
    payload = { item: { ...parentItem, status: 'done', needs: null }, run: null, drafts: {}, output: output(), parent: null, children: [{ ...childItem, ai_team_member_id: null, teammate: null }] }
    await render()
    await click(buttonStartingWith('Find the Acme per-seat price'))
    expect(hoisted.openWorkItem).toHaveBeenLastCalledWith('job-2', [], expect.objectContaining({ teammateId: null }))
  })

  it('an item with no tree shows neither', async () => {
    await render()
    expect(container.querySelector('[data-testid="delegated-by"]')).toBeNull()
    expect(container.querySelector('[data-testid="handoffs"]')).toBeNull()
  })
})

describe('WorkItemDetailPanel — embedded in a bot’s page (bots-v4.md Phase 2)', () => {
  const openedPatches = () =>
    calls('/api/account/activity/job-1', 'PATCH').filter(([, init]) => JSON.parse((init as RequestInit).body as string).action === 'opened')

  beforeEach(() => {
    rowChannels.length = 0
    hoisted.notices = []
    payload = {
      item: item({ status: 'running', kind: 'work_run', needs: null, agent_run_id: 'run-1', source: { action_id: 'act-1' } }),
      run: { id: 'run-1', status: 'running', kind: 'workspace', action_id: 'act-1', pr_url: null, pending_input: null },
      drafts: {},
      output: FLOW_OUTPUT,
      mine: true,
    }
  })

  it('has no toolbar of its own: Stop and Open run sit under its title, with their words', async () => {
    await render('job-1', { embedded: true })
    const verbs = container.querySelector('[data-work-item-verbs]')!
    expect(verbs).not.toBeNull()
    expect(Array.from(verbs.querySelectorAll('button')).map((b) => b.textContent?.trim())).toEqual(['Stop', 'Open run'])
    expect(container.querySelector('[data-work-item-panel]')!.getAttribute('data-work-item-panel')).toBe('embedded')
    // The title sits first in the column: no toolbar row above it.
    expect(container.querySelector('[data-work-item-panel]')!.firstElementChild!.querySelector('h1')).not.toBeNull()
    await click(button('Stop'))
    expect(fetchMock).toHaveBeenCalledWith('/api/account/actions/act-1/agent-runs/run-1/cancel', { method: 'POST', headers: { 'x-workspace-id': 'w1' } })
  })

  it('folds its properties into the column (Details), never the window’s inspector', async () => {
    await render('job-1', { embedded: true })
    expect(container.querySelector('[data-work-item-details]')).toBeNull()
    await click(buttonStartingWith('Details'))
    const details = container.querySelector('[data-work-item-details]')!
    expect(details.textContent).toContain('Work run')
    // Its sources (the run's context) ride along, each opening its record.
    expect(details.textContent).toContain('Pricing sync with Dana')
    // Outside the dashboard the inspector would draw inline: embedded, it isn't drawn at all.
    expect(container.querySelectorAll('.w-\\[289px\\]')).toHaveLength(0)
  })

  it('outside a bot’s page it keeps its toolbar and its properties beside it', async () => {
    await render('job-1')
    expect(container.querySelector('[data-work-item-verbs]')).toBeNull()
    expect(container.querySelector('[data-work-item-panel]')!.getAttribute('data-work-item-panel')).toBe('panel')
    expect(container.querySelector('[data-work-item-details]')).toBeNull()
    expect(button('Stop')).toBeDefined()
  })

  it('is stamped opened only while the page shows it, drawn and focused, and only for its owner', async () => {
    payload = { ...payload, item: { ...(payload.item as WorkItem), status: 'needs_review' } }
    // A narrow page showing its chat: the item isn't on show.
    await render('job-1', { embedded: true, shown: false })
    expect(openedPatches()).toHaveLength(0)
    // The app in the background: not focused.
    act(() => {
      documentFocused = false
      window.dispatchEvent(new Event('blur'))
    })
    await render('job-1', { embedded: true, shown: true })
    expect(openedPatches()).toHaveLength(0)
    // On show, drawn, focused: stamped once.
    act(() => {
      documentFocused = true
      window.dispatchEvent(new Event('focus'))
    })
    await flush()
    expect(openedPatches()).toHaveLength(1)
    // Never another's.
    act(() => root.unmount())
    root = createRoot(container)
    payload = { ...payload, mine: false, item: { ...(payload.item as WorkItem), opened_at: null } }
    await render('job-1', { embedded: true, shown: true })
    expect(openedPatches()).toHaveLength(1)
  })

  it('hands its host the item as loaded, and says when it couldn’t be', async () => {
    const onItem = vi.fn()
    await render('job-1', { embedded: true, onItem })
    expect(onItem).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'job-1', agent_run_id: 'run-1' }), false)
    act(() => root.unmount())
    root = createRoot(container)
    fetchMock.mockImplementation(async () => jsonResponse({ error: 'nope' }, 404))
    const gone = vi.fn()
    await render('job-1', { embedded: true, onItem: gone })
    expect(gone).toHaveBeenLastCalledWith(null, true)
  })
})

describe('WorkItemDetailPanel — the plan (A4, migration 331)', () => {
  const itemChannel = () => rowChannels.filter((c) => c.table === 'tracked_job' && c.filter === 'id=eq.job-1').at(-1)!
  const PLAN = {
    steps: [
      { text: 'Read the thread', status: 'done' },
      { text: 'Draft the reply', status: 'in_progress' },
      { text: 'Send for review', status: 'pending' },
    ],
    updated_at: '2026-09-17T10:00:10.000Z',
  }
  const RUNNING = item({ status: 'running', needs: null, finished_at: null, plan: PLAN })

  beforeEach(() => {
    rowChannels.length = 0
  })

  it('shows a live job’s plan open, with its badge, above the steps', async () => {
    payload = { ...payload, item: RUNNING }
    await render()
    const plan = buttonStartingWith('Plan')
    expect(plan?.getAttribute('aria-expanded')).toBe('true')
    expect(plan?.textContent).toContain('1/3')
    const checklist = container.querySelector('[data-work-item-plan]')!
    expect([...checklist.querySelectorAll('[data-plan-step]')].map((li) => [li.getAttribute('data-plan-step'), li.textContent])).toEqual([
      ['done', 'Read the thread'],
      ['in_progress', 'Draft the reply'],
      ['pending', 'Send for review'],
    ])
    // Above Steps in the column.
    const steps = buttonStartingWith('Steps')!
    expect(plan!.compareDocumentPosition(steps) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('patches live from the row channel', async () => {
    payload = { ...payload, item: RUNNING }
    await render()
    const next = { ...PLAN, steps: [{ ...PLAN.steps[0] }, { ...PLAN.steps[1], status: 'done' }, { ...PLAN.steps[2], status: 'in_progress' }] }
    await act(async () => itemChannel().onRow({ ...RUNNING, plan: next }))
    await flush()
    expect(buttonStartingWith('Plan')?.textContent).toContain('2/3')
  })

  it('folds a settled job’s plan away, and draws nothing without one', async () => {
    payload = { ...payload, item: item({ plan: PLAN }) }
    await render()
    expect(buttonStartingWith('Plan')?.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[data-work-item-plan]')).toBeNull()
    act(() => root.unmount())
    root = createRoot(container)
    payload = { ...payload, item: MAIL_ITEM }
    await render()
    expect(buttonStartingWith('Plan')).toBeUndefined()
  })
})

describe('WorkItemDetailPanel — a local agent’s turn', () => {
  const SESSION = '11111111-2222-4333-8444-555555555555'
  const LOCAL = item({
    id: 'job-1',
    kind: 'local_agent',
    title: 'Your Mac · dial8-website: Take a look at this repository',
    status: 'needs_input',
    actor: 'agent',
    agent_run_id: null,
    needs: { kind: 'input', questions: [{ question: 'Should I look at the desktop repo too?' }] } as WorkItem['needs'],
    deliverables: [],
    result_summary: null,
    source: { chat_conversation_id: 'c1', local_agent_session_id: SESSION, folder_label: 'dial8-website', turn: 1 },
  })

  it('draws the whole session’s conversation, and its question is answered there, never stale', async () => {
    payload = { item: LOCAL, run: null, drafts: {}, output: output() }
    await render()
    expect(container.querySelector('[data-testid="local-agent-panel"]')?.getAttribute('data-session')).toBe(SESSION)
    expect(container.querySelector('[data-local-agent-question]')?.textContent).toContain('Should I look at the desktop repo too?')
    expect(container.querySelector('[data-local-agent-question]')?.textContent).toContain('in the conversation below')
    expect(container.querySelector('[data-stale-question]')).toBeNull()
    expect(button('Stop waiting')).toBeUndefined()
    // Stop is the conversation's own (the session's), not the toolbar's.
    expect(button('Stop')).toBeUndefined()
  })

  it('on a bot’s page the conversation is beside it: not drawn twice', async () => {
    payload = { item: { ...LOCAL, status: 'running', needs: null }, run: null, drafts: {}, output: output() }
    act(() => {
      root.render(h(WorkItemDetailPanel, { itemId: 'job-1', embedded: true, conversationBeside: true }))
    })
    await flush()
    expect(container.querySelector('h1')?.textContent).toBe('Your Mac · dial8-website: Take a look at this repository')
    expect(container.querySelector('[data-testid="local-agent-panel"]')).toBeNull()
  })

  it('a row naming no session draws no conversation', async () => {
    payload = { item: { ...LOCAL, source: {} }, run: null, drafts: {}, output: output() }
    await render()
    expect(container.querySelector('[data-testid="local-agent-panel"]')).toBeNull()
  })
})
