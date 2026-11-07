// @vitest-environment jsdom
/**
 * A review card in the deck (ACTIVITY-AND-REVIEW-DESIGN §4.4).
 *
 * The deck shows one card at a time from BOTH queues (rail-cards.ts). A work
 * item waiting on a review renders through ReviewCard, never AttentionCard,
 * and asks for no picker lists (it has no pills). Its Reviewed verb plays the
 * accept flourish with a fixed "Reviewed" receipt and survives the optimistic
 * removal of the last card like an accept does (FIX 6); its Dismiss reaches
 * the rail's review handler with the WORK item id, not the deck card id.
 *
 * Both cards are stubbed down to their handlers, mirroring
 * attention-deck-flourish.test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { AttentionItem } from '@/hooks/use-attention-items'
import type { WorkItem } from '@/lib/work/types'
import type { DeckCard, ReviewCardItem } from '../rail-cards'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../attention-card', () => ({
  AttentionCard: ({ item, pager }: { item: AttentionItem; pager?: DeckPager }) =>
    h('div', { 'data-testid': 'card', 'data-card-id': item.id }, h(CardControlBar, { pager, primary: null })),
}))
// The deck's pager moved INSIDE the card's control bar, so the mock renders the
// real CardControlBar — otherwise the position indicator and browse arrows
// would not exist anywhere in this tree.
vi.mock('../review-card', () => ({
  ReviewCard: ({
    card,
    pager,
    onReviewed,
    onDismiss,
  }: {
    card: ReviewCardItem
    pager?: DeckPager
    onReviewed: (workId: string) => Promise<{ ok: boolean }>
    onDismiss: (workId: string) => Promise<void>
  }) =>
    h('div', { 'data-testid': 'review-card', 'data-work-id': card.work.id }, [
      h('button', { key: 'r', 'data-testid': 'reviewed', onClick: () => onReviewed(card.work.id) }, 'Reviewed'),
      h('button', { key: 'd', 'data-testid': 'dismiss', onClick: () => onDismiss(card.work.id) }, 'Dismiss'),
      h(CardControlBar, { key: 'bar', pager, primary: null }),
    ]),
}))

import { AttentionDeck } from '../attention-deck'
import { reviewCardOf, type DeckPager } from '../rail-cards'
import { CardControlBar } from '../card-control-bar'

let container: HTMLDivElement
let root: Root

function attention(id: string, createdAt: string): AttentionItem {
  return {
    id,
    workspace_id: 'ws-1',
    member_id: 'm-1',
    kind: 'action_card',
    title: `Card ${id}`,
    why: null,
    payload: { change_type: 'create', entity_type: 'action' },
    proposal_id: null,
    source_flow_run_id: null,
    status: 'pending',
    expires_at: null,
    created_at: createdAt,
  }
}

function work(id: string, finishedAt: string): WorkItem {
  return {
    id,
    workspace_id: 'ws-2',
    member_id: 'm-2',
    kind: 'email_drafts',
    title: `Reply to ${id}`,
    status: 'needs_review',
    actor: 'loop',
    current_step: null,
    progress: {},
    result_summary: null,
    error_message: null,
    skip_reason: null,
    deliverables: [{ type: 'email_draft', id: `d-${id}`, label: 'Re: pricing' }],
    needs: { kind: 'review', verb: 'send' },
    source: {},
    run_key: null,
    agent_run_id: null,
    flow_run_id: null,
    created_at: finishedAt,
    started_at: finishedAt,
    finished_at: finishedAt,
    reviewed_at: null,
    last_beat_at: finishedAt,
    deadline_at: null,
  }
}

const pickerFor = vi.fn(() => null)
const handlers = {
  onEdit: vi.fn(),
  onAccept: vi.fn(async () => ({ ok: true })),
  onStart: vi.fn(async () => ({ ok: true })),
  onDismiss: vi.fn(async () => {}),
}

function renderDeck(
  items: DeckCard[],
  over: {
    onReviewed?: (workId: string) => Promise<{ ok: boolean }>
    onDismissReview?: (workId: string) => Promise<void>
    onResolvingChange?: (active: boolean) => void
  } = {},
) {
  act(() => {
    root.render(
      h(AttentionDeck, {
        items,
        pickerFor,
        ...handlers,
        onReviewed: over.onReviewed ?? vi.fn(async () => ({ ok: true })),
        onDismissReview: over.onDismissReview ?? vi.fn(async () => {}),
        onResolvingChange: over.onResolvingChange,
      }),
    )
  })
}

const text = () => container.textContent || ''

describe('AttentionDeck — review cards', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('renders a review card through ReviewCard, asks for no pickers, and steps to the attention card behind it', async () => {
    const items = [reviewCardOf(work('w1', '2026-09-18T09:00:00.000Z')), attention('a1', '2026-09-18T08:00:00.000Z')] as DeckCard[]
    renderDeck(items)
    expect(container.querySelector('[data-testid="review-card"]')?.getAttribute('data-work-id')).toBe('w1')
    expect(container.querySelector('[data-testid="card"]')).toBeNull()
    expect(pickerFor).not.toHaveBeenCalled()
    expect(text()).toContain('1/2')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Next card"]')!.click()
      // Let the peeled card's exit animation finish (AnimatePresence keeps it
      // mounted until then).
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(container.querySelector('[data-testid="card"]')?.getAttribute('data-card-id')).toBe('a1')
    expect(container.querySelector('[data-testid="review-card"]')).toBeNull()
    expect(text()).toContain('2/2')
    expect(pickerFor).toHaveBeenCalledWith('ws-1')
  })

  it('Reviewed plays the flourish with a "Reviewed" receipt and survives the optimistic removal of the last card', async () => {
    const onReviewed = vi.fn(
      (_workId: string) =>
        new Promise<{ ok: boolean }>((resolve) => {
          setTimeout(() => resolve({ ok: true }), 1)
        }),
    )
    const resolvingLog: boolean[] = []
    const items = [reviewCardOf(work('w1', '2026-09-18T09:00:00.000Z'))]
    renderDeck(items, { onReviewed, onResolvingChange: (a) => resolvingLog.push(a) })

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="reviewed"]')!.click()
      await Promise.resolve()
    })
    expect(onReviewed).toHaveBeenCalledWith('w1')
    expect(resolvingLog).toContain(true)
    expect(text()).toContain('Applying')
    expect(text()).toContain('Reply to w1')

    // The hook's optimistic removal empties the deck mid-request (FIX 6).
    renderDeck([], { onReviewed, onResolvingChange: (a) => resolvingLog.push(a) })
    expect(text()).toContain('Applying')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2)
    })
    expect(text()).toContain('Reviewed')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300)
    })
    expect(text().trim()).toBe('')
    expect(resolvingLog).toContain(false)
  })

  it('a failed Reviewed ends the flourish without claiming a receipt', async () => {
    const onReviewed = vi.fn(async () => ({ ok: false }))
    const resolvingLog: boolean[] = []
    renderDeck([reviewCardOf(work('w1', '2026-09-18T09:00:00.000Z'))], {
      onReviewed,
      onResolvingChange: (a) => resolvingLog.push(a),
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="reviewed"]')!.click()
      await vi.advanceTimersByTimeAsync(400)
    })
    // The flourish opened for the in-flight verb and closed on the failure —
    // the deck's own signal, independent of how long the overlay's fade-out
    // keeps its node mounted.
    expect(resolvingLog).toEqual([false, true, false])
    // The only "Reviewed" on screen is the card's own button — no receipt line.
    expect(text().split('Reviewed').length - 1).toBe(1)
    // The card stays, still actionable (the hook re-added it).
    expect(container.querySelector('[data-testid="review-card"]')).not.toBeNull()
  })

  it('Dismiss hands the work item id to the review dismiss handler, never the attention one', async () => {
    const onDismissReview = vi.fn(async () => {})
    renderDeck([reviewCardOf(work('w1', '2026-09-18T09:00:00.000Z'))], { onDismissReview })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="dismiss"]')!.click()
      await Promise.resolve()
    })
    expect(onDismissReview).toHaveBeenCalledWith('w1')
    expect(handlers.onDismiss).not.toHaveBeenCalled()
  })
})
