// @vitest-environment jsdom
/**
 * FIX 6 — the resolving flourish must survive accepting/starting the LAST card.
 *
 * When there is a single card and the user accepts (or starts) it, the data hook
 * optimistically removes it in the SAME React tick, emptying `items`. The deck's
 * empty-guard used to `return null` immediately, so the "Applying…" → receipt
 * flourish never painted — the whole card slot just vanished mid-request.
 *
 * The deck now keeps itself mounted while a resolving flourish is active
 * (empty-guard is `items.length === 0 && !resolving`) and paints the flourish
 * STANDALONE when the list is empty. It also lifts a `resolving` signal to the
 * parent rail via `onResolvingChange` so the rail doesn't unmount the deck until
 * the RESOLVED_MS timer clears it.
 *
 * We mount the deck standalone with AttentionCard mocked down to plain
 * Start/Accept buttons (mirrors attention-card-work.test's createRoot approach —
 * no @testing-library), simulate the hook's optimistic removal by re-rendering
 * with an empty `items`, and assert the flourish node is present. Fake timers
 * drive the 1200ms receipt window.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { AttentionItem, AcceptResult } from '@/hooks/use-attention-items'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Stub AttentionCard (owned by another fixer, heavy deps) down to two buttons
// that invoke the deck's wrapped handlers. That's all the deck needs from it to
// exercise the accept/start → flourish path.
vi.mock('../attention-card', () => ({
  AttentionCard: ({
    item,
    onAccept,
    onStart,
  }: {
    item: AttentionItem
    onAccept: (id: string) => Promise<AcceptResult>
    onStart: (id: string) => Promise<AcceptResult>
  }) =>
    h('div', { 'data-testid': 'card', 'data-card-id': item.id }, [
      h('button', { key: 'a', 'data-testid': 'accept', onClick: () => onAccept(item.id) }, 'Accept'),
      h('button', { key: 's', 'data-testid': 'start', onClick: () => onStart(item.id) }, 'Start'),
    ]),
}))

import { AttentionDeck } from '../attention-deck'

let container: HTMLDivElement
let root: Root

function actionItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: 'card-1',
    workspace_id: 'ws-1',
    member_id: 'm-1',
    kind: 'action_card',
    title: 'Send the recap to Randy',
    why: 'You committed to follow up',
    payload: { change_type: 'create', entity_type: 'action' },
    proposal_id: 'prop-1',
    source_flow_run_id: null,
    status: 'pending',
    expires_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

function renderDeck(items: AttentionItem[], handlers: {
  onAccept?: (id: string) => Promise<AcceptResult>
  onStart?: (id: string) => Promise<AcceptResult>
  onResolvingChange?: (active: boolean) => void
}) {
  act(() => {
    root.render(
      h(AttentionDeck, {
        items,
        // The rail's per-workspace picker cache, stubbed loaded for every card.
        pickerFor: (workspaceId: string) => ({
          members: [],
          aiMembers: [],
          projects: [],
          workspaceId,
          loaded: true,
        }),
        onEdit: vi.fn(),
        onAccept: handlers.onAccept ?? vi.fn(async () => ({ ok: true })),
        onStart: handlers.onStart ?? vi.fn(async () => ({ ok: true })),
        onDismiss: vi.fn(async () => {}),
        onReviewed: vi.fn(async () => ({ ok: true })),
        onDismissReview: vi.fn(async () => {}),
        onResolvingChange: handlers.onResolvingChange,
      }),
    )
  })
}

/** Presence of the flourish is keyed off the ResolvedCard's "Applying…"/receipt
 *  text (spinner phase) — the node the old bug never painted. */
function flourishText(): string {
  return container.textContent || ''
}

describe('AttentionDeck — last-card resolving flourish (FIX 6)', () => {
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

  it('keeps the flourish painted after the LAST card is accepted and its item is optimistically removed', async () => {
    // onAccept resolves after a tick (like the real hook's PATCH round-trip),
    // reporting a created identifier so the receipt line is deterministic.
    const onAccept = vi.fn(
      () =>
        new Promise<AcceptResult>((resolve) => {
          setTimeout(() => resolve({ ok: true, status: 'accepted', identifier: 'GEN-42' }), 1)
        }),
    )
    const resolvingLog: boolean[] = []
    renderDeck([actionItem()], { onAccept, onResolvingChange: (a) => resolvingLog.push(a) })

    // Click Accept — the deck sets `resolving` synchronously (spinner phase).
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="accept"]')!.click()
      await Promise.resolve()
    })

    // The parent was told a flourish is active.
    expect(resolvingLog).toContain(true)
    // Spinner-phase flourish is on screen even though the accept hasn't resolved.
    expect(flourishText()).toContain('Applying')

    // Simulate the hook's optimistic removal: the item is gone from `items` in the
    // same window. THIS is the FIX 6 regression trigger — the old empty-guard
    // would unmount here. Re-render with an empty list.
    renderDeck([], { onAccept, onResolvingChange: (a) => resolvingLog.push(a) })

    // Flourish must STILL be present (deck stayed mounted despite items.length===0).
    expect(container.querySelector('[data-testid="card"]')).toBeNull()
    expect(flourishText()).toContain('Applying')

    // Let onAccept resolve → the receipt line replaces the spinner.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2)
    })
    expect(flourishText()).toContain('Created GEN-42')

    // After RESOLVED_MS (1200ms) the flourish clears; with an empty list the deck
    // now renders nothing and tells the parent the flourish ended.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300)
    })
    expect(flourishText()).not.toContain('Created GEN-42')
    expect(resolvingLog).toContain(false)
    // Deck is back to rendering nothing (empty list, no flourish).
    expect(container.querySelector('[data-testid="card"]')).toBeNull()
    expect(flourishText().trim()).toBe('')
  })

  it('keeps the flourish painted after the LAST card is STARTED (work_proposal) and optimistically removed', async () => {
    const onStart = vi.fn(
      () =>
        new Promise<AcceptResult>((resolve) => {
          setTimeout(() => resolve({ ok: true, status: 'started', identifier: 'GEN-9' }), 1)
        }),
    )
    renderDeck([actionItem({ kind: 'work_proposal' })], { onStart })

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="start"]')!.click()
      await Promise.resolve()
    })
    expect(flourishText()).toContain('Applying')

    // Optimistic removal of the last card.
    renderDeck([], { onStart })
    expect(container.querySelector('[data-testid="card"]')).toBeNull()
    expect(flourishText()).toContain('Applying')

    // Resolve → "started" receipt shows.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2)
    })
    expect(flourishText()).toContain('GEN-9 started')
  })

  it('renders nothing when the list is empty and no flourish is in flight', () => {
    renderDeck([], {})
    expect(flourishText().trim()).toBe('')
    expect(container.querySelector('[data-testid="card"]')).toBeNull()
  })
})
