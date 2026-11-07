// @vitest-environment jsdom
/**
 * The deck hands each card ITS OWN workspace's picker lists.
 *
 * The rail is cross-workspace, so projects/members/agents are a per-CARD fact,
 * not a per-deck one: the deck looks the top card's workspace up in the rail's
 * cache (`pickerFor`) and passes what it finds. A workspace that has loaded
 * makes its card's pills editable; one still loading (or refused) renders them
 * read-only with stable empty lists — never another workspace's people.
 *
 * AttentionCard is stubbed down to the props under test, mirroring
 * attention-deck-flourish.test's approach.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { AttentionItem } from '@/hooks/use-attention-items'
import type { RailAiMember, RailMember, RailPickerData, RailProject } from '@/hooks/use-rail-picker-data'
import type { DeckPager } from '../rail-cards'
import { CardControlBar } from '../card-control-bar'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The pager now lives INSIDE the card's control bar, so the mock renders the
// real CardControlBar — otherwise the deck's browse arrows would not exist in
// this tree and there'd be nothing to click.
vi.mock('../attention-card', () => ({
  AttentionCard: ({
    item,
    editable,
    members,
    aiMembers,
    projects,
    pager,
  }: {
    item: AttentionItem
    editable: boolean
    members: RailMember[]
    aiMembers: RailAiMember[]
    projects: RailProject[]
    pager?: DeckPager
  }) =>
    h(
      'div',
      {
        'data-testid': 'card',
        'data-card-id': item.id,
        'data-editable': String(editable),
        'data-members': members.map((m) => m.id).join(','),
        'data-ai-members': aiMembers.map((a) => a.id).join(','),
        'data-projects': projects.map((p) => p.id).join(','),
      },
      h(CardControlBar, { pager, primary: null }),
    ),
}))

import { AttentionDeck } from '../attention-deck'

let container: HTMLDivElement
let root: Root

function item(id: string, workspaceId: string): AttentionItem {
  return {
    id,
    workspace_id: workspaceId,
    member_id: 'm-1',
    kind: 'action_card',
    title: `Card ${id}`,
    why: null,
    payload: { change_type: 'create', entity_type: 'action' },
    proposal_id: null,
    source_flow_run_id: null,
    status: 'pending',
    expires_at: null,
    created_at: new Date().toISOString(),
  }
}

/** Only ws-1 has loaded; ws-2 is still in flight (the cache has no entry). */
const pickerFor = (workspaceId: string): RailPickerData | null =>
  workspaceId === 'ws-1'
    ? {
        members: [{ id: 'm-ws-1', display_name: 'Ana', avatar_url: null }],
        aiMembers: [{ id: 'a-ws-1', name: 'Ada', avatar_url: null }],
        projects: [{ id: 'p-ws-1', name: 'Launch' }],
        workspaceId,
        loaded: true,
      }
    : null

function renderDeck(items: AttentionItem[]) {
  act(() => {
    root.render(
      h(AttentionDeck, {
        items,
        pickerFor,
        onEdit: vi.fn(),
        onAccept: vi.fn(async () => ({ ok: true })),
        onStart: vi.fn(async () => ({ ok: true })),
        onDismiss: vi.fn(async () => {}),
        onReviewed: vi.fn(async () => ({ ok: true })),
        onDismissReview: vi.fn(async () => {}),
      }),
    )
  })
}

function card(): HTMLElement {
  return container.querySelector('[data-testid="card"]') as HTMLElement
}

describe('AttentionDeck — per-workspace picker lists', () => {
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

  it('passes the top card its own workspace’s lists and marks it editable', () => {
    renderDeck([item('c1', 'ws-1')])
    expect(card().getAttribute('data-editable')).toBe('true')
    expect(card().getAttribute('data-members')).toBe('m-ws-1')
    expect(card().getAttribute('data-ai-members')).toBe('a-ws-1')
    expect(card().getAttribute('data-projects')).toBe('p-ws-1')
  })

  it('renders a card whose workspace has not loaded read-only, with empty lists', () => {
    renderDeck([item('c2', 'ws-2')])
    expect(card().getAttribute('data-editable')).toBe('false')
    // Crucially EMPTY, not ws-1's people — the pills must never offer another
    // workspace's members/projects.
    expect(card().getAttribute('data-members')).toBe('')
    expect(card().getAttribute('data-projects')).toBe('')
  })

  it('re-looks-up the lists when the deck advances to a card in another workspace', () => {
    renderDeck([item('c1', 'ws-1'), item('c2', 'ws-2')])
    expect(card().getAttribute('data-card-id')).toBe('c1')
    expect(card().getAttribute('data-editable')).toBe('true')

    const next = container.querySelector('button[aria-label="Next card"]') as HTMLButtonElement
    act(() => next.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    // The exiting card lingers for one animation beat, so read the LAST card node.
    const cards = Array.from(container.querySelectorAll('[data-testid="card"]'))
    const top = cards[cards.length - 1]
    expect(top.getAttribute('data-card-id')).toBe('c2')
    expect(top.getAttribute('data-editable')).toBe('false')
    expect(top.getAttribute('data-projects')).toBe('')
  })
})
