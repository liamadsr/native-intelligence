// @vitest-environment jsdom
/**
 * AttentionCard "Will use" resources (Loops v3 Phase 4, W-D). The card's inline
 * chip markup is REPLACED by the shared <WorkResources> from agent-run-ui, which
 * adds per-type icons and click-to-open. These tests pin the card-side wiring:
 *   • the shared chips render (icon + label) in the expanded details;
 *   • a resource chip opens a card (P5): a package → the Knowledge card on it;
 *     an entity → its record card;
 *   • every card carries the card's workspace (item.workspace_id) — including
 *     on a card from ANOTHER workspace, which used to render its chips static.
 *     The switch-then-open is what keeps the card's ids from resolving
 *     against the active workspace's data.
 *
 * Standalone createRoot mount, mirroring attention-card-work.test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('posthog-js/react', () => ({ usePostHog: () => ({ capture: vi.fn() }) }))

/** The cards the chips asked for (the tabs provider isn't mounted: the requests are the result). */
const opened = vi.hoisted(() => [] as Array<Record<string, unknown>>)
const onOpenCard = (e: Event) => opened.push((e as CustomEvent).detail)
window.addEventListener('ni:open-card', onOpenCard)
vi.mock('@/app/account/workspace-switcher', () => ({
  useWorkspaces: () => ({
    workspaces: [
      { id: 'ws-1', name: 'Native Intelligence' },
      { id: 'ws-2', name: 'Acme' },
    ],
    currentId: 'ws-1',
  }),
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
      task: 'Draft a follow-up email to Randy about GA access.',
      resources: [
        { type: 'contact', id: 'c-1', label: 'Randy Chen' },
        { type: 'package', id: 'pkg-9', label: 'GA onboarding pack' },
        { type: 'email', id: 'e-1', label: 'Re: GA' },
      ],
    },
    proposal_id: 'prop-1',
    source_flow_run_id: null,
    status: 'pending',
    expires_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  } as AttentionItem
}

function renderCard(item: AttentionItem, editable = true) {
  act(() => {
    root.render(
      h(AttentionCard, {
        item,
        editable,
        members: [],
        aiMembers: [],
        projects: [],
        onEdit: vi.fn(),
        onAccept: vi.fn(async () => ({ ok: true })),
        onStart: vi.fn(async () => ({ ok: true })),
        onDismiss: vi.fn(async () => {}),
      }),
    )
  })
}

function expandDetails() {
  const toggle = container.querySelector('button[aria-label="Show details"]') as HTMLButtonElement
  act(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

/** Find a "Will use" resource chip button by its label text. */
function chipButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(label),
  ) as HTMLButtonElement | undefined
}

describe('AttentionCard — Will use resources (shared WorkResources)', () => {
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

  it('renders the shared chips (label + icon) under "Will use" when expanded', () => {
    renderCard(workItem())
    expandDetails()
    const text = container.textContent || ''
    expect(text).toContain('Will use')
    expect(text).toContain('Randy Chen')
    expect(text).toContain('GA onboarding pack')
    // Icons: the resource chips carry lucide <svg>s. At least the three known
    // resource types contribute one each.
    expect(container.querySelectorAll('svg').length).toBeGreaterThanOrEqual(3)
  })

  it('opens a package chip as the Knowledge card on it', () => {
    renderCard(workItem())
    expandDetails()
    const btn = chipButton('GA onboarding pack')
    expect(btn).toBeTruthy()
    act(() => btn!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(opened.at(-1)).toMatchObject({ workspaceId: 'ws-1', spec: { kind: 'knowledge', target: { type: 'package', id: 'pkg-9' } } })
  })

  it('opens an entity chip as its record card', () => {
    renderCard(workItem())
    expandDetails()
    const btn = chipButton('Randy Chen')
    expect(btn).toBeTruthy()
    act(() => btn!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(opened.at(-1)).toMatchObject({ workspaceId: 'ws-1', spec: { kind: 'record', record: { type: 'contact', id: 'c-1' } } })
  })

  it('keeps an unsupported-type chip (email) static — no navigation', () => {
    renderCard(workItem())
    expandDetails()
    // 'Re: GA' is an email resource: no navigation target, so it's a static span.
    const btn = chipButton('Re: GA')
    expect(btn).toBeUndefined()
    expect(container.textContent).toContain('Re: GA')
  })

  it('keeps chips clickable on a card whose workspace pickers have not loaded', () => {
    // `editable` now means only "this workspace's picker lists are in" — it no
    // longer decides whether a chip can be opened.
    renderCard(workItem(), /* editable */ false)
    expandDetails()
    const btn = chipButton('Randy Chen')
    expect(btn).toBeTruthy()
    act(() => btn!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(opened.at(-1)).toMatchObject({ workspaceId: 'ws-1' })
  })

  it('opens a FOREIGN card\u2019s chip in that card\u2019s workspace, not the active one', () => {
    renderCard(workItem({ workspace_id: 'ws-2' }))
    expandDetails()
    const btn = chipButton('Randy Chen')
    expect(btn).toBeTruthy()
    act(() => btn!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(opened.at(-1)).toMatchObject({ workspaceId: 'ws-2', spec: { kind: 'record', record: { type: 'contact', id: 'c-1' } } })
  })
})
