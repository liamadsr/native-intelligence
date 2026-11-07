// @vitest-environment jsdom
/**
 * Asks inline in the chat (P13, chat-ask-card.tsx):
 *
 *   • a loop's parked "post" in the home thread is the full approval card,
 *     found in the shell's shared source by its card: Approve and post, Edit,
 *     Skip in plain sight, and "Open run" opens the run's item;
 *   • Approve goes through the shared source's own accept (the one
 *     person-only PATCH), once; Skip through its dismiss;
 *   • once the card has left the source, one line says what became of it
 *     (read once from the row); a card someone else must answer says so;
 *   • a chat turn's held call (the tool result's approval_id) is the same card;
 *   • a run's question under its report is the run's own picker, answered
 *     through its respond route; once it no longer waits, the report's chip
 *     says Answered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { LightWorkRow } from '@/lib/work/queries'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CARD = '11111111-0000-4000-8000-000000000001'
const APPROVAL = '22222222-0000-4000-8000-000000000002'
const ITEM = '33333333-0000-4000-8000-000000000003'

const store = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const s = {
    version: 0,
    asks: [] as unknown[],
    rows: [] as unknown[] | null,
    loaded: true,
    subscribe(l: () => void) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    emit() {
      s.version += 1
      for (const l of [...listeners]) l()
    },
    accept: vi.fn(async (_id: string) => ({ ok: true, status: 'executed' }) as unknown),
    dismiss: vi.fn(async (_id: string) => {}),
    answered: vi.fn((_id: string) => {}),
    refetch: vi.fn(async () => {}),
    openOutput: vi.fn(async () => true),
    outcomes: new Map<string, { status: string; result?: unknown }>(),
    changes: new Map<string, { status: string; result_entity_id: string | null }>(),
  }
  return s
})

vi.mock('@/components/work/agent-work-provider', async () => {
  const React = await import('react')
  const editCard = vi.fn()
  const start = vi.fn()
  // What the shell holds now (read fresh each render: each test sets its own).
  const read = () => ({
    work: { rows: store.rows, cardRows: [], roster: [], answered: store.answered },
    attention: { items: [], asks: store.asks, loaded: store.loaded, editCard, accept: store.accept, start, dismiss: store.dismiss, refetch: store.refetch },
    counts: new Map(),
  })
  return {
    useOptionalAgentWorkShared: () => {
      React.useSyncExternalStore(store.subscribe, () => store.version)
      return read()
    },
  }
})
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: () => ({
        in: async (_c: string, ids: string[]) => ({
          data:
            table === 'tool_approval'
              ? ids.flatMap((id) => (store.outcomes.has(id) ? [{ id, ...store.outcomes.get(id) }] : []))
              : table === 'proposed_change'
                ? ids.flatMap((id) => (store.changes.has(id) ? [{ id, ...store.changes.get(id) }] : []))
                : [],
          error: null,
        }),
      }),
    }),
  }),
}))
vi.mock('@/hooks/use-open-output', () => ({ useOpenOutput: () => store.openOutput }))
vi.mock('@/hooks/use-open-teammate', () => ({ useOpenWorkItem: () => vi.fn() }))
vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaces: () => ({ workspaces: [], currentId: 'w1' }) }))
vi.mock('posthog-js/react', () => ({ usePostHog: () => ({ capture: vi.fn() }) }))
vi.mock('@/components/capture/action-target-picker', () => ({ ActionTargetPicker: ({ children }: { children: unknown }) => h('div', null, children as never) }))

import { ChatApprovalCard, ChatAskCard, ChatAskCardGroup, RunQuestionInline } from '../chat-ask-card'
import { __resetAskOutcomesForTests } from '@/lib/attention/ask-outcome'
import { __resetFullRowsForTests } from '@/lib/work/full-rows'

/** A loop's parked "post to X" step's card, as the shared source's `asks` hold it. */
const parkedPost = (over: Record<string, unknown> = {}) => ({
  id: CARD,
  workspace_id: 'w1',
  member_id: 'm1',
  kind: 'approval',
  title: "Post via Typefully: 'We shipped SSO'",
  why: '“Weekly posts” stopped here for your yes. This posts publicly.',
  payload: { approval_id: APPROVAL, tool: 'mcp__typefully__create_draft', door: 'flow_step', editable: true, public_content: true, input: { content: 'We shipped SSO', publish_at: 'now' } },
  proposal_id: null,
  source_flow_run_id: null,
  status: 'pending',
  expires_at: null,
  created_at: new Date().toISOString(),
  ...over,
})

let container: HTMLDivElement
let root: Root
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}
async function render(node: ReturnType<typeof h>) {
  await act(async () => root.render(node))
  await settle()
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  store.asks = []
  store.rows = []
  store.loaded = true
  store.outcomes.clear()
  store.changes.clear()
  store.accept.mockClear()
  store.dismiss.mockClear()
  store.openOutput.mockClear()
  store.answered.mockClear()
  store.refetch.mockClear()
  __resetAskOutcomesForTests()
  __resetFullRowsForTests()
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const homeAsk = { card_id: CARD, approval_id: APPROVAL, workspace_id: 'w1', title: "Post via Typefully: 'We shipped SSO'", work_item_id: ITEM }

describe('a loop’s parked step, inline in the home thread', () => {
  it('is the full approval card: what runs, Approve and post, Edit and Skip in plain sight, and Open run', async () => {
    store.asks = [parkedPost()]
    await render(h(ChatAskCard, { data: homeAsk }))
    expect(container.querySelector('[data-chat-ask="approval"]')).not.toBeNull()
    expect(container.textContent).toContain('We shipped SSO')
    expect(container.querySelector('[data-approval-inputs]')).not.toBeNull()
    expect(button('Approve and post')).toBeDefined()
    expect(button('Edit')).toBeDefined()
    expect(button('Skip')).toBeDefined()
    await act(async () => button('Open run')!.click())
    expect(store.openOutput).toHaveBeenCalledWith(expect.objectContaining({ workItemId: ITEM, workspaceId: 'w1', output: null }))
  })

  it('Approve and post goes through the shared source’s accept, once; then one line says it ran', async () => {
    store.asks = [parkedPost()]
    await render(h(ChatAskCard, { data: homeAsk }))
    store.accept.mockImplementationOnce(async () => {
      // The card leaves the source (its optimistic removal); the row is approved and ran.
      store.asks = []
      store.outcomes.set(APPROVAL, { status: 'approved', result: { success: true } })
      store.emit()
      return { ok: true, status: 'executed' }
    })
    await act(async () => button('Approve and post')!.click())
    await settle()
    expect(store.accept).toHaveBeenCalledTimes(1)
    expect(store.accept).toHaveBeenCalledWith(CARD, expect.anything(), undefined)
    expect(container.querySelector('[data-chat-ask-settled="approved"]')!.textContent).toContain('Approved. It ran.')
    expect(button('Approve and post')).toBeUndefined()
  })

  it('while the click is on its way it says so, never a stale "waiting" from a row still pending', async () => {
    store.asks = [parkedPost()]
    await render(h(ChatAskCard, { data: homeAsk }))
    let finish: (v: unknown) => void = () => {}
    store.accept.mockImplementationOnce(async () => {
      store.asks = []
      store.emit()
      await new Promise((r) => (finish = r))
      store.outcomes.set(APPROVAL, { status: 'approved', result: { success: true } })
      return { ok: true, status: 'executed' }
    })
    await act(async () => button('Approve and post')!.click())
    await settle()
    expect(container.querySelector('[data-chat-ask-acting]')).not.toBeNull()
    expect(container.querySelector('[data-chat-ask-settled]')).toBeNull()
    await act(async () => finish(undefined))
    await settle()
    expect(container.querySelector('[data-chat-ask-acting]')).toBeNull()
    expect(container.querySelector('[data-chat-ask-settled="approved"]')).not.toBeNull()
  })

  it('Skip is the source’s dismiss (the held call is denied server side)', async () => {
    store.asks = [parkedPost()]
    await render(h(ChatAskCard, { data: homeAsk }))
    await act(async () => button('Skip')!.click())
    expect(store.dismiss).toHaveBeenCalledWith(CARD)
    expect(store.accept).not.toHaveBeenCalled()
  })

  it('settled before this view: the line from its row (expired, declined), and nothing before the source has loaded', async () => {
    store.loaded = false
    await render(h(ChatAskCard, { data: homeAsk }))
    expect(container.textContent).toBe('')
    store.loaded = true
    store.outcomes.set(APPROVAL, { status: 'expired' })
    await act(async () => store.emit())
    await settle()
    expect(container.querySelector('[data-chat-ask-settled="expired"]')!.textContent).toContain('Expired. Nothing ran.')
  })
})

describe('pending by its row but not in the shared source', () => {
  it('reads the source again, once, and shows nothing meanwhile (never a dead "waiting" line)', async () => {
    store.outcomes.set(APPROVAL, { status: 'pending', expires_at: new Date(Date.now() + 3_600_000).toISOString() } as never)
    await render(h(ChatAskCard, { data: homeAsk }))
    expect(container.textContent).toBe('')
    expect(store.refetch).toHaveBeenCalledTimes(1)
    await act(async () => store.emit())
    await settle()
    expect(store.refetch).toHaveBeenCalledTimes(1)
  })

  it('pending but past its wait: expired', async () => {
    store.outcomes.set(APPROVAL, { status: 'pending', expires_at: new Date(Date.now() - 60_000).toISOString() } as never)
    await render(h(ChatAskCard, { data: homeAsk }))
    expect(container.querySelector('[data-chat-ask-settled="expired"]')).not.toBeNull()
  })
})

describe('a call’s outcome, batched (home-asks.ts)', () => {
  const S1 = '55555555-0000-4000-8000-000000000001'
  const S2 = '55555555-0000-4000-8000-000000000002'
  const CAP = '66666666-0000-4000-8000-000000000001'
  const sug = (id: string, title: string) => ({
    ...parkedPost(),
    id,
    kind: 'action_card',
    title,
    why: 'Said on the call',
    payload: { change_type: 'update', entity_type: 'action', entity_id: '77777777-0000-4000-8000-000000000001', status: 'done' },
  })
  const data = {
    card_ids: [S1, S2],
    workspace_id: 'w1',
    source: 'your call “Acme sync”',
    added: [
      { change_id: '88888888-0000-4000-8000-000000000001', entity_id: '99999999-0000-4000-8000-000000000001', entity_type: 'action', capture_id: CAP, identifier: 'ENG-51' },
      { change_id: '88888888-0000-4000-8000-000000000002', entity_id: '99999999-0000-4000-8000-000000000002', entity_type: 'action', capture_id: CAP, identifier: 'ENG-52' },
    ],
  }

  it('what it added, each with Undo (the capture’s undo route); what it asks, each its own card; and Accept all', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    store.asks = [sug(S1, 'Move ENG-40 to Done'), sug(S2, 'Move ENG-41 to Done')]
    await render(h(ChatAskCardGroup, { data }))
    expect(container.querySelector('[data-chat-ask-added]')!.textContent).toContain('Added ENG-51')
    expect(container.querySelectorAll('[data-chat-ask="action_card"]')).toHaveLength(2)
    // Undo: the capture's own route, then it says undone.
    await act(async () => container.querySelector<HTMLButtonElement>(`[data-chat-ask-added-item="${data.added[0].change_id}"] [data-chat-ask-undo]`)!.click())
    await settle()
    expect(fetchMock).toHaveBeenCalledWith(`/api/account/captures/${CAP}/proposed-changes/${data.added[0].change_id}/undo`, expect.objectContaining({ method: 'POST' }))
    // In the change's own workspace, whatever is on screen.
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ workspace_id: 'w1' })
    expect(container.querySelector(`[data-chat-ask-added-item="${data.added[0].change_id}"]`)!.textContent).toContain('ENG-51: undone')
    // Every card one click: Accept all, each through the shared source's accept.
    await act(async () => container.querySelector<HTMLButtonElement>('[data-chat-ask-accept-all]')!.click())
    await settle()
    expect(store.accept.mock.calls.map((c) => c[0])).toEqual([S1, S2])
  })

  it('undone survives a reload: read off the change itself (re-staged, or applied again as something else)', async () => {
    store.asks = []
    store.changes.set(data.added[0].change_id, { status: 'pending', result_entity_id: null })
    store.changes.set(data.added[1].change_id, { status: 'applied', result_entity_id: data.added[1].entity_id })
    await render(h(ChatAskCardGroup, { data }))
    expect(container.querySelector(`[data-chat-ask-added-item="${data.added[0].change_id}"]`)!.textContent).toContain('ENG-51: undone')
    expect(container.querySelector(`[data-chat-ask-added-item="${data.added[0].change_id}"] [data-chat-ask-undo]`)).toBeNull()
    expect(container.querySelector(`[data-chat-ask-added-item="${data.added[1].change_id}"] [data-chat-ask-undo]`)).not.toBeNull()
  })

  it('once every card is settled: what it added stays, the cards go', async () => {
    store.asks = []
    await render(h(ChatAskCardGroup, { data }))
    expect(container.querySelector('[data-chat-ask="action_card"]')).toBeNull()
    expect(container.querySelector('[data-chat-ask-added]')).not.toBeNull()
    await act(async () => root.render(h(ChatAskCardGroup, { data: { ...data, added: [] } })))
    expect(container.querySelector('[data-chat-ask-group-settled]')!.textContent).toBe('All 2 handled.')
  })
})

describe('a chat turn’s held call', () => {
  it('is the same card, found by its approval; one for someone else says it waits on them', async () => {
    store.asks = [parkedPost({ payload: { approval_id: APPROVAL, tool: 'disconnect', door: 'chat', input: { connection_id: 'c1' } }, title: 'Disconnect Typefully?' })]
    await render(h(ChatApprovalCard, { approvalId: APPROVAL }))
    expect(button('Approve')).toBeDefined()
    expect(button('Decline')).toBeDefined()
    expect(button('Skip')).toBeUndefined()
    await act(async () => root.render(h(ChatApprovalCard, { approvalId: '44444444-0000-4000-8000-000000000004' })))
    await settle()
    expect(container.querySelector('[data-chat-ask-settled="theirs"]')!.textContent).toContain('Waiting on someone else’s yes.')
  })
})

describe('a run’s question under its report', () => {
  const PENDING = {
    requestId: 'req-1',
    approveOptionId: 'approve',
    denyOptionId: 'deny',
    questions: [{ question: 'Which repo should the fix go in?', header: 'Repo', options: [{ label: 'web' }, { label: 'desktop' }], multiSelect: false }],
    askedAt: '2026-10-20T09:30:00.000Z',
  }
  const row = (over: Partial<LightWorkRow> = {}) =>
    ({
      id: ITEM,
      title: 'Fix the export timeout',
      current_step: null,
      workspace_id: 'w1',
      member_id: 'm1',
      kind: 'coding',
      status: 'needs_input',
      origin: 'user',
      ai_team_member_id: 'dev',
      parent_id: null,
      root_id: null,
      flow_run_id: null,
      agent_run_id: 'run-1',
      source: {},
      opened_at: null,
      needs: { kind: 'input', questions: [{ question: 'Which repo should the fix go in?' }] },
      created_at: '2026-10-20T09:30:00.000Z',
      teammate: null,
      ...over,
    }) as LightWorkRow
  const report = { work_item_id: ITEM, workspace_id: 'w1', status: 'needs_input' as const, title: 'Fix the export timeout' }

  it('is the run’s own picker, answered from the chat through the run’s respond route', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).endsWith('/respond')) return new Response(JSON.stringify({ ok: true, status: 'queued' }), { status: 200 })
      return new Response(JSON.stringify({ item: { ...row(), deliverables: [], result_summary: null, last_beat_at: null }, run: { id: 'run-1', status: 'needs_input', pending_input: PENDING } }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    store.rows = [row()]
    await render(h(RunQuestionInline, { data: report }))
    expect(container.querySelector(`[data-question-card="${ITEM}"]`)).not.toBeNull()
    const picker = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('[data-question-card-picker] button')].find((b) => b.textContent?.includes(label))!
    await act(async () => picker('web').click())
    await act(async () => picker('Submit').click())
    await settle()
    const respond = fetchMock.mock.calls.find(([u]) => String(u) === '/api/account/agent-runs/run-1/respond')
    expect(respond).toBeDefined()
    expect(JSON.parse(String((respond![1] as RequestInit).body))).toEqual({ answers: [{ question: 'Which repo should the fix go in?', answer: 'web' }] })
    expect(store.answered).toHaveBeenCalledWith(ITEM)
  })

  it('answered only when its held row went on (running, queued, done); otherwise its own state, or the plain chip', async () => {
    store.rows = [row({ status: 'running', needs: null })]
    await render(h(RunQuestionInline, { data: report }))
    expect(container.querySelector('[data-question-card]')).toBeNull()
    expect(container.querySelector('[data-deliverable-kind]')!.textContent).toBe('Answered')
    store.rows = [row({ status: 'failed', needs: null })]
    await act(async () => store.emit())
    expect(container.querySelector('[data-deliverable-kind]')!.textContent).toBe('Couldn’t finish')
    // Not held (gone from the open rows): what the report said, never a guess.
    store.rows = []
    await act(async () => store.emit())
    expect(container.querySelector('[data-deliverable-kind]')!.textContent).toBe('Needs your answer')
  })
})

describe('a guest’s held call (guest access)', () => {
  const GUEST = '44444444-0000-4000-8000-000000000004'
  const guestAsk = { card_id: CARD, approval_id: APPROVAL, workspace_id: 'w1', title: 'Email Dana Ortiz', guest: { id: GUEST, name: 'Jason Lee', preset: 'colleague' as const, channel: 'sms' as const } }

  it('names who asked over the card, and their line opens their conversation as a card', async () => {
    store.asks = [parkedPost({ title: 'Email Dana Ortiz', payload: { approval_id: APPROVAL, tool: 'create_email_draft', door: 'chat', input: { to: 'dana@example.com' } } })]
    await render(h(ChatAskCard, { data: guestAsk }))
    const line = container.querySelector<HTMLButtonElement>(`[data-guest-line="${GUEST}"]`)!
    expect(line.textContent).toBe('JLJason Lee · Colleague')
    // The line sits over the card, inside the same ask.
    expect(container.querySelector('[data-chat-ask="approval"]')!.firstElementChild).toBe(line)
    const opened: unknown[] = []
    const onOpen = (e: Event) => opened.push((e as CustomEvent).detail)
    window.addEventListener('dial8:open-card', onOpen)
    await act(async () => line.click())
    window.removeEventListener('dial8:open-card', onOpen)
    expect(opened).toEqual([expect.objectContaining({ spec: { kind: 'guest', title: 'Jason Lee', target: { type: 'guest', id: GUEST, label: 'Jason Lee' } }, reuse: true, from: 'guest' })])
  })

  it('keeps the line over what became of it once settled', async () => {
    store.outcomes.set(APPROVAL, { status: 'expired' })
    await render(h(ChatAskCard, { data: guestAsk }))
    expect(container.querySelector(`[data-guest-line="${GUEST}"]`)).not.toBeNull()
    expect(container.querySelector('[data-chat-ask-settled]')).not.toBeNull()
  })
})
