// @vitest-environment jsdom
/**
 * The For you column's compact card and its focus view
 * (column-compact-card.tsx, column-focus-view.tsx):
 *
 *   • a verb pill and one sentence; the pill does the card's primary verb
 *     (the shared source's, with its events) without opening anything; a
 *     review's opens its OUTPUT (#722); an approval's shows its inputs first;
 *   • a click on the card (or Enter on it) opens the focus view: a labelled
 *     dialog over a blur (a hole blocker, the sky held still) with the card's
 *     details under a divider and a menu card of its other verbs, Reply first;
 *   • Esc or a click on the blur closes it, focus goes back to the card, and
 *     nothing of it stays mounted (the sky's hold released); focus stays
 *     inside while open;
 *   • the menu's verbs are the shared source's (Dismiss, Mark reviewed, Open
 *     chat) and close it; Reply hands the card to the main chat (card-reply.ts);
 *   • "Edit…" shows today's full card in the focus view, so nothing is lost;
 *   • an update whose accept finds no target (409) opens the focus view with
 *     the target picker on its pill; the action chosen retries the accept;
 *   • the focus view's small line names the bot once (no kind line or area
 *     label repeating it), and Dismiss is a plain row, never red;
 *   • its impression goes once (the full card opened later sends no other);
 *   • placeFocus keeps card and menu on screen: below, else above, else up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const spies = vi.hoisted(() => ({
  capture: vi.fn(),
  openItem: vi.fn(),
  openOutput: vi.fn(async () => 'output' as const),
  openBotPage: vi.fn(() => true),
}))
vi.mock('posthog-js/react', () => ({ usePostHog: () => ({ capture: spies.capture }) }))
vi.mock('@/hooks/use-open-teammate', () => ({ useOpenWorkItem: () => spies.openItem }))
vi.mock('@/hooks/use-open-output', () => ({ useOpenOutput: () => spies.openOutput }))
vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaces: () => ({ workspaces: [], currentId: WS }) }))
vi.mock('@/lib/bots/bot-page', () => ({ openBotPage: spies.openBotPage }))
// The picker as its open flag and a pick (the real one is a Radix popover searching the API).
vi.mock('@/components/capture/action-target-picker', () => ({
  ActionTargetPicker: ({
    children,
    open,
    onOpenChange,
    onPick,
  }: {
    children: unknown
    open: boolean
    onOpenChange: (open: boolean) => void
    onPick: (a: { id: string }) => void
  }) =>
    h(
      'span',
      { 'data-target-picker': open ? 'open' : 'closed' },
      children as never,
      // As the real one: it closes itself, then hands the action back.
      open
        ? h('button', { type: 'button', 'data-target-pick': '', onClick: () => (onOpenChange(false), onPick({ id: 'act-9' })) }, 'ENG-9')
        : null,
    ),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { ColumnCompactCard, type ColumnShown } from '../column-compact-card'
import { FOCUS_EDGE_PX, FOCUS_MENU_GAP_PX, FOCUS_SHADOW_ROOM_PX, FOCUS_SKY_HOLD, placeFocus } from '../column-focus-view'
import { __resetColumnImpressionsForTests } from '../attention-card'
import { reviewCardOf } from '../rail-cards'
import { skyActivity } from '@/lib/sky/sky-activity'
import { CARD_REPLY_EVENT } from '@/lib/chat/card-reply'
import type { AgentWorkShared } from '@/components/work/agent-work-provider'
import type { AttentionItem } from '@/hooks/use-attention-items'
import type { WorkItem } from '@/lib/work/types'

const WS = '11111111-1111-4111-8111-111111111111'
const CARD_ID = '22222222-2222-4222-8222-222222222222'
const WORK_ID = '33333333-3333-4333-8333-333333333333'
const SOURCE = { teammateId: 'writer', name: 'Writer', face: null }

function card(over: Partial<AttentionItem> & { payload?: Record<string, unknown> } = {}): AttentionItem {
  return {
    id: CARD_ID,
    workspace_id: WS,
    member_id: 'm1',
    kind: 'action_card',
    title: 'Send Dana the pricing deck',
    why: 'Dana asked for it on Tuesday’s call.',
    proposal_id: 'p1',
    source_flow_run_id: null,
    status: 'pending',
    expires_at: null,
    created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    ...over,
    payload: { change_type: 'create', entity_type: 'action', raised_by_ai_member_id: 'writer', ...(over.payload ?? {}) },
  } as AttentionItem
}
function work(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: WORK_ID,
    workspace_id: WS,
    member_id: 'm1',
    kind: 'work_run',
    status: 'needs_review',
    title: 'Reply to Dana',
    result_summary: 'Drafted a short reply.',
    deliverables: [{ type: 'email_draft', id: 'd1', label: 'Re: pricing' }],
    needs: null,
    ai_team_member_id: 'writer',
    created_at: '2026-10-16T08:00:00.000Z',
    finished_at: '2026-10-16T08:00:00.000Z',
    last_beat_at: '2026-10-16T08:00:00.000Z',
    ...over,
  } as WorkItem
}

const shared = {
  work: {
    rows: [],
    reviewed: vi.fn(async () => ({ ok: true })),
    dismissReview: vi.fn(async () => {}),
    answered: vi.fn(),
  },
  attention: {
    items: [],
    editCard: vi.fn(),
    accept: vi.fn(async () => ({ ok: true, status: 'accepted', identifier: 'ENG-42' })),
    start: vi.fn(async () => ({ ok: true, status: 'started' })),
    draft: vi.fn(),
    dismiss: vi.fn(async () => {}),
  },
  counts: new Map(),
} as unknown as AgentWorkShared
const picker = { loaded: true, members: [], aiMembers: [], projects: [] }

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.clearAllMocks()
  __resetColumnImpressionsForTests()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function render(entry: ColumnShown) {
  await act(async () => root.render(h(ColumnCompactCard, { entry, shared, pickerFor: () => picker as never })))
}
const cardEntry = (c = card()): ColumnShown => ({ kind: 'card', id: c.id, at: c.created_at, card: c, source: SOURCE })
const reviewEntry = (w = work()): ColumnShown => ({ kind: 'review', id: w.id, at: w.created_at, card: reviewCardOf(w), source: SOURCE })

const compact = () => container.querySelector<HTMLElement>('[data-compact-card]')!
const pill = () => compact().querySelector<HTMLButtonElement>('[data-compact-verb]')!
const focus = () => document.querySelector<HTMLElement>('[data-column-focus]')
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const row = (key: string) => document.querySelector<HTMLButtonElement>(`[data-compact-row="${key}"]`)
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-compact-row]')].map((r) => r.getAttribute('data-compact-row'))
const click = (el: HTMLElement) => act(async () => el.click())
async function openFocus() {
  await click(compact())
  expect(focus()).not.toBeNull()
}

describe('ColumnCompactCard', () => {
  it('the focus view (portalled out of the column) carries ph-no-capture itself, around the full card', async () => {
    await render(cardEntry(card({ title: 'Reply to Sarah about pricing' })))
    await openFocus()
    expect(focus()!.classList.contains('ph-no-capture')).toBe(true)
  })

  it('an update whose accept finds no target opens the focus view with the picker on its pill; the action chosen retries the accept', async () => {
    const accept = shared.attention.accept as unknown as ReturnType<typeof vi.fn>
    accept.mockResolvedValueOnce({ ok: false, needsTarget: true })
    await render(cardEntry(card({ title: 'Move the launch to Friday', payload: { change_type: 'update', entity_type: 'action', entity_id: 'a-gone' } })))
    expect(pill().textContent).toBe('Apply')
    await click(pill())
    expect(accept).toHaveBeenCalledTimes(1)
    // Not a loop of 409s: the picker is up, in the focus view, on its pill.
    expect(focus()).not.toBeNull()
    const pickerEl = dialog()!.querySelector<HTMLElement>('[data-target-picker]')!
    expect(pickerEl.getAttribute('data-target-picker')).toBe('open')
    expect(pickerEl.querySelector('[data-compact-target-picker]')!.textContent).toBe('Apply')

    await click(dialog()!.querySelector<HTMLButtonElement>('[data-target-pick]')!)
    expect(accept).toHaveBeenCalledTimes(2)
    expect(accept).toHaveBeenLastCalledWith(CARD_ID, expect.any(Object), 'act-9')
    expect(focus()).toBeNull()
  })

  it('closing the focus view closes the picker an unresolved update opened', async () => {
    const accept = shared.attention.accept as unknown as ReturnType<typeof vi.fn>
    accept.mockResolvedValueOnce({ ok: false, needsTarget: true })
    await render(cardEntry(card({ payload: { change_type: 'update', entity_type: 'action', entity_id: 'a-gone' } })))
    await click(pill())
    expect(focus()).not.toBeNull()
    await act(async () => dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(focus()).toBeNull()
    // The pill acts again (no picker left open to re-show the view).
    await click(pill())
    expect(accept).toHaveBeenCalledTimes(2)
  })

  it('the focus view’s small line names the bot once: no kind line or area label saying it again', async () => {
    await render({ ...reviewEntry(work({ teammate: { name: 'Writer' } } as Partial<WorkItem>)), area: 'Writer' })
    await openFocus()
    const meta = dialog()!.querySelector('[data-compact-meta]')!.textContent!
    expect(meta.startsWith('Writer · Work run · ')).toBe(true)
    expect(meta.match(/Writer/g)).toHaveLength(1)
    await act(async () => root.render(h('div')))
    await render({ ...reviewEntry(), area: 'Captures' })
    await openFocus()
    expect(dialog()!.querySelector('[data-compact-meta]')!.textContent).toMatch(/^Writer · Work run · .* · Captures$/)
  })

  it('Dismiss is a plain row: a trash icon and the word, never red', async () => {
    await render(cardEntry())
    await openFocus()
    expect(row('dismiss')!.textContent).toBe('Dismiss')
    expect(row('dismiss')!.querySelector('svg')).not.toBeNull()
    expect(row('dismiss')!.className).not.toMatch(/red-/)
    expect(row('dismiss')!.className).toBe(row('reply')!.className)
  })

  it('a verb pill and one sentence, nothing else', async () => {
    await render(cardEntry())
    expect(pill().textContent).toBe('Add')
    expect(compact().querySelector('[data-compact-sentence]')!.textContent).toBe('Add“Send Dana the pricing deck” to your to-dos')
    expect(compact().querySelectorAll('button')).toHaveLength(1)
    expect(focus()).toBeNull()
  })

  it('the pill does the primary verb (the shared source’s, with its event) and opens nothing', async () => {
    await render(cardEntry())
    await click(pill())
    expect(shared.attention.accept).toHaveBeenCalledWith(CARD_ID, expect.objectContaining({ project_id: null }), undefined)
    expect(spies.capture).toHaveBeenCalledWith('attention_card_accepted', expect.objectContaining({ surface: 'column' }))
    expect(focus()).toBeNull()
  })

  it('a work proposal’s pill starts it', async () => {
    await render(cardEntry(card({ kind: 'work_proposal', title: 'Draft the memo', payload: { task: 'Write it' } })))
    expect(pill().textContent).toBe('Start')
    await click(pill())
    expect(shared.attention.start).toHaveBeenCalledWith(CARD_ID, null)
  })

  it('a review’s pill opens its output (#722), not the run', async () => {
    await render(reviewEntry())
    expect(compact().querySelector('[data-compact-sentence]')!.textContent).toBe('Reviewthe draft “Re: pricing”')
    await click(pill())
    expect(spies.openOutput).toHaveBeenCalledWith(expect.objectContaining({ workItemId: WORK_ID, output: expect.objectContaining({ type: 'email_draft', id: 'd1' }) }))
    expect(spies.openItem).not.toHaveBeenCalled()
    expect(focus()).toBeNull()
  })

  it('a click on the card opens its focus view: a labelled dialog over a blur, the details under a divider, a menu card of its other verbs', async () => {
    await render(cardEntry())
    await openFocus()
    expect(dialog()!.getAttribute('aria-modal')).toBe('true')
    expect(dialog()!.getAttribute('aria-label')).toBe('Add “Send Dana the pricing deck” to your to-dos')
    const backdrop = document.querySelector<HTMLElement>('[data-column-focus-backdrop]')!
    expect(backdrop.className).toContain('backdrop-blur')
    expect(skyActivity.holds()).toContain(FOCUS_SKY_HOLD)
    const details = dialog()!.querySelector('[data-compact-details]')!.textContent
    expect(details).toContain('Dana asked for it on Tuesday’s call.')
    expect(details).toContain('Writer · 5m')
    expect(rows()).toEqual(['reply', 'full', 'bot', 'dismiss'])
    expect(row('full')!.textContent).toBe('Edit…')
    expect(focus()!.contains(document.activeElement)).toBe(true)
  })

  it('Enter on the focused card opens it too', async () => {
    await render(cardEntry())
    compact().focus()
    await act(async () => compact().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(focus()).not.toBeNull()
  })

  it('Esc closes it, focus goes back to the card, and nothing of it stays (the sky moves again)', async () => {
    await render(cardEntry())
    await openFocus()
    await act(async () => dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(focus()).toBeNull()
    expect(document.activeElement).toBe(compact())
    expect(skyActivity.holds()).not.toContain(FOCUS_SKY_HOLD)
  })

  it('the card’s shadow has room inside its scroll box (no square corners), taken back so the card stands where it did; the room takes no press', async () => {
    await render(cardEntry())
    await openFocus()
    const box = document.querySelector<HTMLElement>('[data-column-focus-card]')!
    expect(box.style.padding).toBe(`${FOCUS_SHADOW_ROOM_PX}px`)
    expect(box.style.margin).toBe(`-${FOCUS_SHADOW_ROOM_PX}px`)
    expect(box.className).toContain('pointer-events-none')
    expect((box.firstElementChild as HTMLElement).className).toContain('pointer-events-auto')
    expect(box.querySelector('[data-compact-focus-card]')).not.toBeNull()
  })

  it('a click on the blur closes it', async () => {
    await render(cardEntry())
    await openFocus()
    await act(async () => document.querySelector('[data-column-focus-backdrop]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(focus()).toBeNull()
  })

  it('focus stays inside while open: Tab from the last row goes back to the first control', async () => {
    await render(cardEntry())
    await openFocus()
    row('dismiss')!.focus()
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    await act(async () => row('dismiss')!.dispatchEvent(tab))
    expect(tab.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(dialog()!.querySelector('[data-compact-verb]'))
  })

  it('Dismiss is the shared source’s, and closes it', async () => {
    await render(cardEntry())
    await openFocus()
    await click(row('dismiss')!)
    expect(shared.attention.dismiss).toHaveBeenCalledWith(CARD_ID)
    expect(spies.capture).toHaveBeenCalledWith('attention_card_dismissed', expect.objectContaining({ surface: 'column' }))
    expect(focus()).toBeNull()
  })

  it('Open Writer opens the bot’s page; the agent’s own face has no such row', async () => {
    await render(cardEntry())
    await openFocus()
    await click(row('bot')!)
    expect(spies.openBotPage).toHaveBeenCalledWith('writer', { focus: 'work' })
    await render({ ...cardEntry(), source: { ...SOURCE, agent: true } })
    await openFocus()
    expect(rows()).not.toContain('bot')
  })

  it('Reply hands the card to the main chat (its kind, id, verb and sentence) and closes', async () => {
    const heard = vi.fn()
    window.addEventListener(CARD_REPLY_EVENT, heard)
    try {
      await render(cardEntry())
      await openFocus()
      await click(row('reply')!)
      expect(heard).toHaveBeenCalledTimes(1)
      expect((heard.mock.calls[0][0] as CustomEvent).detail).toEqual({
        kind: 'card',
        id: CARD_ID,
        workspaceId: WS,
        verb: 'Add',
        sentence: '“Send Dana the pricing deck” to your to-dos',
        subkind: 'action_card',
        // Its round icon rides too, so the chat draws the card as the column did.
        icon: 'action',
      })
      expect(focus()).toBeNull()
    } finally {
      window.removeEventListener(CARD_REPLY_EVENT, heard)
    }
  })

  it('Edit… shows today’s full card in the focus view (its pickers), in place of the details', async () => {
    await render(cardEntry())
    await openFocus()
    await click(row('full')!)
    expect(focus()).not.toBeNull()
    expect(dialog()!.querySelector('[data-compact-details]')).toBeNull()
    expect(dialog()!.querySelector('[data-attention-card-pills]')).not.toBeNull()
    expect(rows()).toEqual(['reply', 'bot', 'dismiss'])
    // Its own impression was the compact card's: nothing more.
    expect(spies.capture.mock.calls.filter(([e]) => e === 'attention_card_impression')).toHaveLength(1)
  })

  it('a review’s menu: Mark reviewed and Dismiss (the ledger’s), Open chat (its run)', async () => {
    await render(reviewEntry())
    await openFocus()
    expect(rows()).toEqual(['reply', 'reviewed', 'chat', 'dismiss'])
    expect(dialog()!.querySelector('[data-compact-details]')!.textContent).toContain('Drafted a short reply.')
    await click(row('chat')!)
    expect(spies.openItem).toHaveBeenCalledWith(WORK_ID, ['writer'], { workspaceId: WS, title: 'Reply to Dana', teammateId: 'writer' })
    await openFocus()
    await click(row('reviewed')!)
    expect(shared.work.reviewed).toHaveBeenCalledWith(WORK_ID)
    await openFocus()
    await click(row('dismiss')!)
    expect(shared.work.dismissReview).toHaveBeenCalledWith(WORK_ID)
  })

  it('sends its impression once, as the full card would', async () => {
    await render(cardEntry())
    expect(spies.capture.mock.calls.filter(([e]) => e === 'attention_card_impression')).toEqual([
      ['attention_card_impression', { kind: 'action_card', surface: 'column' }],
    ])
    await render(reviewEntry())
    expect(spies.capture).toHaveBeenCalledWith('attention_card_impression', { kind: 'work_review', work_kind: 'work_run', surface: 'column' })
  })
})

describe('placeFocus', () => {
  const anchor = { top: 100, left: 20, width: 300 }
  it('the card at its own top, the menu below, when both fit', () => {
    expect(placeFocus(anchor, 200, 120, 800)).toEqual({ top: 100, left: 20, width: 300, menuAbove: false, maxHeight: 800 - FOCUS_EDGE_PX * 2 - 120 - FOCUS_MENU_GAP_PX })
  })
  it('no room below: the menu goes above, the card stays', () => {
    const p = placeFocus({ ...anchor, top: 600 }, 120, 120, 800)
    expect(p).toMatchObject({ top: 600, menuAbove: true })
  })
  it('a card that would run off the bottom moves up, and the menu flips above when it fits there', () => {
    const p = placeFocus({ ...anchor, top: 700 }, 200, 100, 800)
    expect(p.menuAbove).toBe(true)
    expect(p.top).toBe(800 - FOCUS_EDGE_PX - 200)
  })
  it('neither fits as it stands (the card near the top, tall): the card moves up so the menu fits below', () => {
    const p = placeFocus({ ...anchor, top: 40 }, 500, 200, 800)
    expect(p.menuAbove).toBe(false)
    expect(p.top + Math.min(500, p.maxHeight) + FOCUS_MENU_GAP_PX + 200).toBeLessThanOrEqual(800 - FOCUS_EDGE_PX)
    expect(p.top).toBeGreaterThanOrEqual(FOCUS_EDGE_PX)
  })
})
