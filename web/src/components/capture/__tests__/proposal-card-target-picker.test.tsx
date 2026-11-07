// @vitest-environment jsdom
/**
 * W-4c on the CAPTURE surface (adversarial-review finding 2): the capture detail
 * panel's proposal card is where target-less `update:action` proposals are
 * actually staged — before this fix the Apply button rendered "Choose target"
 * but was DISABLED (getMissingRequiredFields adds 'entity'), a dead end with no
 * picker. Now the button is ENABLED and opens the shared ActionTargetPicker;
 * picking an action persists entity_id on the proposal (onEdit) and applies
 * (onApply) — the same rescue flow as the attention rail, one shared component.
 *
 * Mounted standalone with createRoot (mirrors attention-card-work.test.tsx).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom has no ResizeObserver; cmdk (the picker's Command list) requires one
// (mirrors run-follow-up-chat.test.tsx).
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { ProposalCard } from '../proposal-card'
import { ActionTargetPicker } from '../action-target-picker'
import type { ProposedChange } from '@/lib/proposed-changes/types'

let container: HTMLDivElement
let root: Root

function makeChange(overrides: Partial<ProposedChange>): ProposedChange {
  return {
    id: 'pc-1',
    workspace_id: 'ws-1',
    capture_id: 'cap-1',
    change_type: 'update',
    entity_type: 'action',
    entity_id: null,
    display_text: 'Bump the API docs task to urgent',
    title: 'Bump the API docs task',
    description: null,
    priority: null,
    due_date: null,
    status_from: null,
    status_to: null,
    assignee_name: null,
    assignee_member_id: null,
    assignee_contact_id: null,
    team_id: null,
    project_id: null,
    labels: null,
    email_to_name: null,
    email_to_address: null,
    email_subject: null,
    email_context: null,
    extra: null,
    anchor_text: null,
    sort_order: 0,
    confidence: 0.9,
    trigger_quote: null,
    reasoning: null,
    stakes: null,
    open_questions: null,
    status: 'pending',
    applied_at: null,
    applied_by: null,
    result_entity_id: null,
    error_message: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

function renderCard(
  change: ProposedChange,
  handlers: {
    onApply?: (id: string) => Promise<void>
    onEdit?: (id: string, updates: Record<string, unknown>) => Promise<void>
  } = {},
) {
  const onApply = handlers.onApply ?? vi.fn(async () => {})
  const onEdit = handlers.onEdit ?? vi.fn(async () => {})
  const onDismiss = vi.fn(async () => {})
  act(() => {
    root.render(h(ProposalCard, { change, onApply, onDismiss, onEdit }))
  })
  return { onApply, onEdit, onDismiss }
}

/** The primary action button (by its rendered label). */
function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(text),
  ) as HTMLButtonElement | undefined
}

describe('ProposalCard — target-less update rescue (W-4c)', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    // The picker fetches actions when opened; the card never fetches on render.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ actions: [] }) })))
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('a target-less update:action renders an ENABLED "Choose target" button (no disabled dead end)', () => {
    renderCard(makeChange({ entity_id: null }))
    const btn = buttonByText('Choose target')
    expect(btn).toBeTruthy()
    expect(btn!.disabled).toBe(false)
  })

  it('a TARGETED update:action renders the normal enabled "Update" button that applies directly', async () => {
    const onApply = vi.fn(async () => {})
    renderCard(makeChange({ entity_id: 'act-1' }), { onApply })
    const btn = buttonByText('Update')
    expect(btn).toBeTruthy()
    expect(btn!.disabled).toBe(false)
    await act(async () => {
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(onApply).toHaveBeenCalledWith('pc-1')
  })

  it('a target-less update:milestone (picker is actions-only) keeps the disabled guard', () => {
    renderCard(makeChange({ entity_type: 'milestone', entity_id: null }))
    // Falls through to the generic missing-fields button — disabled, no picker.
    const btn = buttonByText('Update')
    expect(btn).toBeTruthy()
    expect(btn!.disabled).toBe(true)
  })
})

describe('ActionTargetPicker (shared W-4c picker)', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('loads workspace actions when opened and hands the picked action to onPick (closing itself)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      void url
      return {
        ok: true,
        json: async () => ({
          actions: [
            { id: 'act-7', identifier: 'GEN-7', title: 'Update API docs' },
            { id: 'act-8', identifier: 'GEN-8', title: 'Ship the SDK' },
          ],
        }),
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    const onPick = vi.fn()
    const onOpenChange = vi.fn()
    await act(async () => {
      root.render(
        h(ActionTargetPicker, {
          open: true,
          onOpenChange,
          onPick,
          children: h('button', {}, 'Choose target'),
        }),
      )
      await Promise.resolve()
    })

    // Opened → fetched the active workspace's actions.
    expect(fetchMock).toHaveBeenCalled()
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/account/actions')

    // The results render into the portal (document.body, Radix popover).
    const items = Array.from(document.querySelectorAll('[cmdk-item]'))
    expect(items.length).toBe(2)
    expect(document.body.textContent).toContain('Update API docs')
    expect(document.body.textContent).toContain('GEN-7')

    // Picking one → onPick with the full option + the popover closes.
    const target = items.find((el) => el.textContent?.includes('Update API docs'))!
    await act(async () => {
      // cmdk items select on click.
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(onPick).toHaveBeenCalledWith({ id: 'act-7', identifier: 'GEN-7', title: 'Update API docs' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
