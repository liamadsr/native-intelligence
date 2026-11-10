// @vitest-environment jsdom
/**
 * The work_proposal branch of AttentionCard (Loops v3 — WORK-PROPOSALS-DESIGN).
 * A work card renders differently from action/email/question cards:
 *   • the primary button reads "Start" and calls onStart (not onAccept);
 *   • the effect line reads "Runs an agent: <first ~80 chars of task>";
 *   • the property pills row (project/assignee/priority/due) is HIDDEN — a work
 *     card runs an agent, it isn't a board-row proposal;
 *   • the expanded details show the full task text + a "Will use" chip per
 *     declared resource.
 *
 * We mount the card standalone with the tab-context + posthog boundaries mocked
 * (mirrors intelligence-panel.test's createRoot approach — no @testing-library).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('posthog-js/react', () => ({ usePostHog: () => ({ capture: vi.fn() }) }))

// The main chat's context, stubbed.
const navigate = vi.fn()
const openInWorkspace = vi.fn(async () => {})
vi.mock('@/app/account/(dashboard)/main-chat/main-chat-context', () => ({
  buildEntryForDetail: (view: string, dp: unknown) => ({ view, detailPanel: dp }),
}))
// The card names its own workspace on a badge when it isn't the active one.
vi.mock('@/app/account/workspace-switcher', () => ({
  useWorkspaces: () => ({ workspaces: [{ id: 'ws-1', name: 'Native Intelligence' }], currentId: 'ws-1' }),
}))

import { AttentionCard } from '../attention-card'
import type { AttentionItem } from '@/hooks/use-attention-items'

let container: HTMLDivElement
let root: Root

function workItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: 'card-work-1',
    workspace_id: 'ws-1',
    member_id: 'm-1',
    kind: 'work_proposal',
    title: 'Follow up with Randy about GA access',
    why: 'You committed to reach out',
    payload: {
      task: 'Draft a follow-up email to Randy about GA access, referencing the Aug 3 call where he asked for a sandbox key, and propose next Tuesday for a walkthrough.',
      resources: [
        { type: 'contact', id: 'c-1', label: 'Randy Chen' },
        { type: 'capture', id: 'cap-1', label: 'Aug 3 call' },
      ],
    },
    proposal_id: 'prop-1',
    source_flow_run_id: null,
    status: 'pending',
    expires_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

function renderCard(item: AttentionItem, handlers: {
  onStart?: (id: string) => Promise<import('@/hooks/use-attention-items').AcceptResult>
  onAccept?: (id: string) => Promise<import('@/hooks/use-attention-items').AcceptResult>
  onDismiss?: (id: string) => Promise<void>
} = {}) {
  const onStart = handlers.onStart ?? vi.fn(async () => ({ ok: true }))
  const onAccept = handlers.onAccept ?? vi.fn(async () => ({ ok: true }))
  const onDismiss = handlers.onDismiss ?? vi.fn(async () => {})
  act(() => {
    root.render(
      h(AttentionCard, {
        item,
        editable: true,
        members: [],
        aiMembers: [],
        projects: [],
        onEdit: vi.fn(),
        onAccept,
        onStart,
        onDismiss,
      }),
    )
  })
  return { onStart, onAccept, onDismiss }
}

describe('AttentionCard — work_proposal branch', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  it('renders a "Start" primary button (not an Accept variant)', () => {
    renderCard(workItem())
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent)
    expect(buttons.some((t) => t?.includes('Start'))).toBe(true)
    expect(buttons.some((t) => t?.includes('Create action'))).toBe(false)
  })

  it('the Start button calls onStart, not onAccept', async () => {
    const onStart = vi.fn(async () => ({ ok: true }))
    const onAccept = vi.fn(async () => ({ ok: true }))
    renderCard(workItem(), { onStart, onAccept })
    const startBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Start'),
    )!
    // Await the click's async chain (onStart → receipt) inside act so the
    // post-resolve setState settles without an act() warning.
    await act(async () => {
      startBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    // No place picked: a Native Intelligence work run, as always (null: no run_in sent).
    expect(onStart).toHaveBeenCalledWith('card-work-1', null)
    expect(onAccept).not.toHaveBeenCalled()
  })

  it('hides the property pills row (no project/priority/due controls)', () => {
    renderCard(workItem())
    // Property pills are rendered as buttons whose text is Project/Assignee/etc.
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent)
    expect(buttons.some((t) => t === 'Project' || t === 'Assignee' || t === 'Priority')).toBe(false)
  })

  it('shows "Runs an agent: <task first ~80 chars>" and the full task + resource chips when expanded', () => {
    renderCard(workItem())
    // Expand the details.
    const toggle = container.querySelector('button[aria-label="Show details"]') as HTMLButtonElement
    expect(toggle).toBeTruthy()
    act(() => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const text = container.textContent || ''
    expect(text).toContain('Runs an agent:')
    // The effect line is truncated to ~80 chars → ends with an ellipsis.
    expect(text).toContain('Runs an agent: Draft a follow-up email to Randy about GA access, referencing the')
    // Full task + resources.
    expect(text).toContain('propose next Tuesday for a walkthrough')
    expect(text).toContain('Will use')
    expect(text).toContain('Randy Chen')
    expect(text).toContain('Aug 3 call')
  })
})
