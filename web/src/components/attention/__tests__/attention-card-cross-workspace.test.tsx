// @vitest-environment jsdom
/**
 * AttentionCard on a card from ANOTHER workspace.
 *
 * The rail is a personal, cross-workspace queue and PATCH
 * /api/account/attention-items already fences on the CARD's workspace — so a
 * foreign card was never actually un-actionable, it was only gated in the UI.
 * These tests pin the four pieces that make it whole:
 *   • a workspace BADGE names where the change will land (and is absent on a
 *     card for the active workspace, or when the name is unknown);
 *   • every card it opens — the capture chip, the receipt toast's "View" —
 *     carries the card's workspace (item.workspace_id), so the tabs switch
 *     first instead of resolving the card's ids against the ACTIVE
 *     workspace's data (P5: every way in opens a card);
 *   • assign-&-start sends the card's workspace on the start-agent request, so
 *     the route resolves the created action instead of 404ing;
 *   • a target-less update mounts the action picker for a foreign card too,
 *     scoped to that card's workspace — it used to be a dead end (the plain
 *     button posted, the server 409'd, and the rescue picker wasn't mounted).
 *
 * Standalone createRoot mount, mirroring attention-card-work.test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { AttentionItem, AcceptResult } from '@/hooks/use-attention-items'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Hoisted: the sonner factory reads `success` at module-init time, before a
// plain `const` in this file would have been initialized.
const hoisted = vi.hoisted(() => ({ toastSuccess: vi.fn() }))
const toastSuccess = hoisted.toastSuccess
vi.mock('sonner', () => ({ toast: { success: hoisted.toastSuccess, error: vi.fn() } }))
vi.mock('posthog-js/react', () => ({ usePostHog: () => ({ capture: vi.fn() }) }))

/** The cards the card asked for (the tabs provider isn't mounted: the requests are the result). */
const opened = vi.hoisted(() => [] as Array<Record<string, unknown>>)
window.addEventListener('dial8:open-card', (e) => opened.push((e as CustomEvent).detail))

// ws-1 is active; ws-2 is another workspace the user belongs to; ws-9 is one the
// cache can't name (a card can outlive the membership that named it).
vi.mock('@/app/account/workspace-switcher', () => ({
  useWorkspaces: () => ({
    workspaces: [
      { id: 'ws-1', name: 'Dial8' },
      { id: 'ws-2', name: 'Acme Corp' },
    ],
    currentId: 'ws-1',
  }),
}))

// The picker is exercised by its own suite; here we only care THAT it mounts and
// WHICH workspace it was told to search.
vi.mock('@/components/capture/action-target-picker', () => ({
  ActionTargetPicker: ({
    workspaceId,
    children,
  }: {
    workspaceId?: string
    children: React.ReactNode
  }) => h('div', { 'data-testid': 'target-picker', 'data-workspace-id': workspaceId ?? '' }, children),
}))

import { AttentionCard } from '../attention-card'

let container: HTMLDivElement
let root: Root

function actionItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: 'card-1',
    workspace_id: 'ws-2',
    member_id: 'm-1',
    kind: 'action_card',
    title: 'Send the recap to Randy',
    why: 'You committed to follow up',
    payload: { change_type: 'create', entity_type: 'action', title: 'Send the recap' },
    proposal_id: 'prop-1',
    source_flow_run_id: null,
    status: 'pending',
    expires_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

function renderCard(
  item: AttentionItem,
  opts: { editable?: boolean; onAccept?: (id: string) => Promise<AcceptResult> } = {},
) {
  const onAccept = opts.onAccept ?? vi.fn(async () => ({ ok: true }) as AcceptResult)
  act(() => {
    root.render(
      h(AttentionCard, {
        item,
        editable: opts.editable ?? true,
        members: [],
        aiMembers: [{ id: 'ai-1', name: 'Ada', avatar_url: null }],
        projects: [],
        onEdit: vi.fn(),
        onAccept,
        onStart: vi.fn(async () => ({ ok: true })),
        onDismiss: vi.fn(async () => {}),
      }),
    )
  })
  return { onAccept }
}

function buttonContaining(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(text),
  ) as HTMLButtonElement | undefined
}

describe('AttentionCard — cards from another workspace', () => {
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

  it('badges a foreign card with its workspace name', () => {
    renderCard(actionItem())
    expect(container.textContent).toContain('Acme Corp')
  })

  it('shows no badge on a card for the ACTIVE workspace', () => {
    renderCard(actionItem({ workspace_id: 'ws-1' }))
    expect(container.textContent).not.toContain('Acme Corp')
    expect(container.textContent).not.toContain('Dial8')
  })

  it('shows no badge when the workspace cache cannot name the workspace', () => {
    renderCard(actionItem({ workspace_id: 'ws-9' }))
    // Nothing invented — an unnamed badge would tell the user less than silence.
    expect(container.querySelector('[title^="In "]')).toBeNull()
  })

  it('opens the provenance capture chip in the CARD’s workspace', () => {
    renderCard(
      actionItem({
        payload: {
          change_type: 'create',
          entity_type: 'action',
          skill_name: 'triage',
          capture_id: 'cap-7',
          capture_title: 'Aug 3 call',
        },
      }),
    )
    const toggle = container.querySelector('button[aria-label="Show details"]') as HTMLButtonElement
    act(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    const chip = buttonContaining('Aug 3 call')!
    expect(chip).toBeTruthy()
    act(() => chip.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(opened.at(-1)).toMatchObject({ workspaceId: 'ws-2', spec: { kind: 'record', record: { type: 'capture', id: 'cap-7' } } })
  })

  it('offers the receipt toast’s View link on a foreign card, opening it in that workspace', async () => {
    renderCard(actionItem(), {
      onAccept: vi.fn(async () => ({
        ok: true,
        entity_id: 'act-9',
        entity_kind: 'action',
        identifier: 'ACM-9',
      })),
    })
    await act(async () => {
      buttonContaining('Create action')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(toastSuccess).toHaveBeenCalled()
    const opts = toastSuccess.mock.calls[0][1] as { action?: { onClick: () => void } }
    expect(opts.action).toBeTruthy()
    opts.action!.onClick()
    expect(opened.at(-1)).toMatchObject({ workspaceId: 'ws-2', spec: { kind: 'record', record: { type: 'action', id: 'act-9' } } })
  })

  it('sends the card’s workspace on the assign-&-start request', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
    vi.stubGlobal('fetch', fetchMock)

    renderCard(
      actionItem({
        payload: {
          change_type: 'create',
          entity_type: 'action',
          title: 'Send the recap',
          assignee_ai_member_id: 'ai-1',
        },
      }),
      {
        onAccept: vi.fn(async () => ({ ok: true, entity_id: 'act-9', entity_kind: 'action' })),
      },
    )

    await act(async () => {
      buttonContaining('Assign & start')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(fetchMock).toHaveBeenCalled()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toContain('/api/account/actions/act-9/start-agent')
    expect((init.headers as Record<string, string>)['x-workspace-id']).toBe('ws-2')
  })

  it('mounts the target picker for a foreign needs-target card, scoped to its workspace', () => {
    renderCard(
      actionItem({
        payload: { change_type: 'update', entity_type: 'action', entity_id: null },
      }),
    )
    const picker = container.querySelector('[data-testid="target-picker"]')
    expect(picker).toBeTruthy()
    expect(picker!.getAttribute('data-workspace-id')).toBe('ws-2')
    expect(buttonContaining('Choose target')).toBeTruthy()
  })

  it('mounts the target picker even before the card’s workspace lists load', () => {
    // `editable` is only about the property pills now — it must not decide
    // whether the rescue picker exists.
    renderCard(
      actionItem({ payload: { change_type: 'update', entity_type: 'action', entity_id: null } }),
      { editable: false },
    )
    expect(container.querySelector('[data-testid="target-picker"]')).toBeTruthy()
  })
})
