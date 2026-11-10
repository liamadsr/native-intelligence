// @vitest-environment jsdom
/**
 * An approval card's Always allow (Claude's Allow once / Always allow): shown
 * beside Approve only on a connected app's call its own permission held (the
 * card's payload says so, approvals.ts); its click accepts with
 * `always_allow`, and the toast says whether the tool now runs without asking.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
vi.mock('posthog-js/react', () => ({ usePostHog: () => ({ capture: vi.fn() }) }))
vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaces: () => ({ workspaces: [{ id: 'ws-1', name: 'Native Intelligence' }], currentId: 'ws-1' }) }))

import { AttentionCard } from '../attention-card'
import type { AttentionItem } from '@/hooks/use-attention-items'

const approval = (payload: Record<string, unknown>): AttentionItem =>
  ({
    id: 'appr-card-1',
    workspace_id: 'ws-1',
    member_id: 'm-1',
    kind: 'approval',
    title: 'Approve mcp__linear__create_issue?',
    why: 'Linear asks for your approval before this runs.',
    payload: { approval_id: 'appr-1', tool: 'mcp__linear__create_issue', side_effect: 'unclassified', door: 'chat', input: { title: 'Bug' }, ...payload },
    proposal_id: null,
    source_flow_run_id: null,
    status: 'pending',
    expires_at: null,
    created_at: new Date().toISOString(),
  }) as unknown as AttentionItem

let container: HTMLDivElement
let root: Root
const onAccept = vi.fn(async (): Promise<Record<string, unknown>> => ({ ok: true, status: 'executed', always_allowed: true }))

function render(item: AttentionItem, surface: 'chat' | 'column' = 'chat') {
  act(() => {
    root.render(
      h(AttentionCard, {
        item,
        editable: true,
        members: [],
        aiMembers: [],
        projects: [],
        surface,
        onEdit: vi.fn(),
        onAccept,
        onStart: vi.fn(async () => ({ ok: true })),
        onDismiss: vi.fn(async () => {}),
      } as never),
    )
  })
}

const always = () => container.querySelector<HTMLButtonElement>('[data-approval-always]')

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.clearAllMocks()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('an approval card’s Always allow', () => {
  it('shows beside Approve on a card that offers it, in the chat and elsewhere', () => {
    render(approval({ always_allow: true }))
    expect(always()?.textContent?.trim()).toBe('Always allow')
    act(() => root.unmount())
    root = createRoot(container)
    render(approval({ always_allow: true }), 'column')
    expect(always()).not.toBeNull()
  })

  it('never on a card that doesn’t offer it (the reviewer held it, or the tool always asks)', () => {
    render(approval({}))
    expect(always()).toBeNull()
  })

  it('accepts with always_allow and says the tool now runs without asking', async () => {
    render(approval({ always_allow: true }))
    await act(async () => {
      always()!.click()
    })
    expect(onAccept).toHaveBeenCalledWith('appr-card-1', { always_allow: true })
    expect(toast.success).toHaveBeenCalledWith('Approved', { description: expect.stringMatching(/^Create issue runs without asking from now on/) })
  })

  it('says it was approved once when Always allow could not be saved', async () => {
    onAccept.mockResolvedValueOnce({ ok: true, status: 'executed', always_allowed: false })
    render(approval({ always_allow: true }))
    await act(async () => {
      always()!.click()
    })
    expect(toast.success).toHaveBeenCalledWith('Approved once', { description: expect.stringMatching(/Create issue still asks/) })
  })
})
