// @vitest-environment jsdom
/**
 * The entity tab (row 10): the cards about this entity with their one-tap
 * action, then one row per work item (who, what it did here, when, the item),
 * reads muted, other members' runs counted, and a row opening its work item:
 * as the detail panels mount it (EntityActivitySection), where any item opens
 * (bots-v4.md Phase 2, useOpenWorkItem): on its bot's page, else over the
 * Inbox, never over the Agents page.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({
  activity: null as unknown,
  cards: [] as unknown[],
  start: vi.fn(async () => ({ ok: true })),
  accept: vi.fn(async () => ({ ok: true })),
  dismiss: vi.fn(async () => {}),
  attentionOpts: [] as unknown[],
  openWorkItem: vi.fn(),
}))
vi.mock('@/hooks/use-entity-activity', () => ({ useEntityActivity: () => hoisted.activity }))
vi.mock('@/hooks/use-attention-items', () => ({
  useAttentionItems: (opts: unknown) => {
    hoisted.attentionOpts.push(opts)
    return { items: hoisted.cards, isLoading: false, start: hoisted.start, accept: hoisted.accept, dismiss: hoisted.dismiss }
  },
}))
vi.mock('@/components/attention/review-card', () => ({ AttemptedChip: () => h('span', null, 'Attempted') }))
vi.mock('../work-item-detail-panel', () => ({ StatusIcon: () => null }))
vi.mock('@/app/account/(dashboard)/main-chat/main-chat-context', () => ({ buildEntryForDetail: vi.fn() }))
vi.mock('@/hooks/use-open-teammate', () => ({ useOpenWorkItem: () => hoisted.openWorkItem }))

import { EntityActivitySection, EntityActivityTab, cardIsAbout, needsTargetToast } from '../entity-activity-tab'
import { NO_BOT_OWNERS, botOwners } from '@/lib/work/bot-owner'

const CAPTURE = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspace_id: 'w1',
  kind: 'work_run',
  title: `Job ${id}`,
  status: 'done',
  origin: 'user',
  ai_team_member_id: 't1',
  teammate: { id: 't1', name: 'Quill', is_system: false, system_key: null, role: 'writer' },
  deliverables: [],
  result_summary: 'Drafted 1 document',
  ...over,
})

let container: HTMLDivElement
let root: Root
const onOpen = vi.fn()
const render = () => act(() => root.render(h(EntityActivityTab, { entityType: 'capture', entityId: CAPTURE, onOpenWorkItem: onOpen })))
const text = () => container.textContent ?? ''
const button = (name: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(name)) as HTMLButtonElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  hoisted.attentionOpts = []
  hoisted.cards = [
    { id: 'card-1', kind: 'work_proposal', title: 'Draft the kickoff note', why: 'Cori asked for it', status: 'pending', payload: { capture_id: CAPTURE } },
    { id: 'card-2', kind: 'action_card', title: 'Elsewhere', why: null, status: 'pending', payload: { capture_id: OTHER } },
  ]
  hoisted.activity = {
    rows: [
      { work_item_id: 'w-write', verbs: { created: 1, read: 2 }, tools: ['create_document'], last_at: new Date().toISOString(), work_item: item('w-write', { origin: 'attempt' }) },
      { work_item_id: 'w-read', verbs: { read: 1 }, tools: [], last_at: new Date(Date.now() - 3 * 3_600_000).toISOString(), work_item: item('w-read', { teammate: { id: 's', name: 'Triage', is_system: true, system_key: 'triage', role: null } }) },
    ],
    hidden: 2,
    failed: false,
    refresh: vi.fn(),
  }
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

describe('EntityActivityTab', () => {
  it('rows name who, what they did here, and the item; reads muted; others counted', () => {
    render()
    const rows = Array.from(container.querySelectorAll('ul[aria-label="Agent interactions"] > li'))
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('Quill')
    expect(rows[0].textContent).toContain('· Writer')
    expect(rows[0].textContent).toContain('created 1 · read 2')
    expect(rows[0].textContent).toContain('Job w-write')
    expect(rows[0].textContent).toContain('Attempted')
    expect(rows[1].textContent).toContain('Triage')
    expect(rows[1].textContent).not.toContain('· Writer')
    expect(rows[1].textContent).toContain('looked at')
    expect(rows[1].textContent).toContain('3h')
    expect(text()).toContain('2 more runs by other members touched this.')
  })

  it('a role teammate named for its role says it once', () => {
    hoisted.activity = {
      rows: [{ work_item_id: 'r', verbs: { read: 1 }, tools: [], last_at: new Date().toISOString(), work_item: item('r', { teammate: { id: 't', name: 'Writer', is_system: false, system_key: null, role: 'writer' } }) }],
      hidden: 0,
      failed: false,
      refresh: vi.fn(),
    }
    render()
    expect(text()).toContain('Writer')
    expect(text()).not.toContain('Writer · Writer')
  })

  it('a row opens its work item', () => {
    render()
    act(() => button('Job w-read').click())
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'w-read' }))
  })

  it('shows only the cards about this entity, on its own channel and silently, with their one-tap action', async () => {
    render()
    expect(hoisted.attentionOpts[0]).toMatchObject({ announce: false })
    expect(text()).toContain('Draft the kickoff note')
    expect(text()).not.toContain('Elsewhere')
    await act(async () => button('Start').click())
    expect(hoisted.start).toHaveBeenCalledWith('card-1')
    await act(async () => button('Dismiss').click())
    expect(hoisted.dismiss).toHaveBeenCalledWith('card-1')
  })

  it('nothing yet, and a failed load says so', () => {
    hoisted.cards = []
    hoisted.activity = { rows: [], hidden: 0, failed: false, refresh: vi.fn() }
    render()
    expect(text()).toContain('No agent has worked on this yet.')
    hoisted.activity = { rows: null, hidden: 0, failed: true, refresh: vi.fn() }
    render()
    expect(text()).toContain('Could not load this item’s agent activity.')
  })
})

describe('EntityActivitySection (as the detail panels mount it)', () => {
  it('a row opens its work item where any item opens: with its workspace, title and teammate, never over the Agents page', () => {
    act(() => root.render(h(EntityActivitySection, { entityType: 'capture', entityId: CAPTURE })))
    act(() => button('Job w-write').click())
    expect(hoisted.openWorkItem).toHaveBeenCalledWith('w-write', [], { workspaceId: 'w1', title: 'Job w-write', teammateId: 't1' })
  })

  it('a row with no teammate is opened known to have none (over the Inbox)', () => {
    hoisted.activity = {
      rows: [{ work_item_id: 'w-lane', verbs: { read: 1 }, tools: [], last_at: new Date().toISOString(), work_item: item('w-lane', { ai_team_member_id: null, teammate: null }) }],
      hidden: 0,
      failed: false,
      refresh: vi.fn(),
    }
    act(() => root.render(h(EntityActivitySection, { entityType: 'capture', entityId: CAPTURE })))
    act(() => button('Job w-lane').click())
    expect(hoisted.openWorkItem).toHaveBeenCalledWith('w-lane', [], expect.objectContaining({ teammateId: null }))
  })
})

describe('cardIsAbout', () => {
  it('matches the card’s entity by id and type, or a capture by provenance', () => {
    const payload = (p: Record<string, unknown>) => ({ kind: 'action_card' as const, payload: p as never })
    expect(cardIsAbout(payload({ entity_type: 'contact', entity_id: CAPTURE }), 'contact', CAPTURE)).toBe(true)
    expect(cardIsAbout(payload({ entity_type: 'project', entity_id: CAPTURE }), 'contact', CAPTURE)).toBe(false)
    expect(cardIsAbout(payload({ capture_id: CAPTURE }), 'capture', CAPTURE)).toBe(true)
    expect(cardIsAbout(payload({ capture_id: CAPTURE }), 'contact', CAPTURE)).toBe(false)
    expect(cardIsAbout({ kind: 'work_proposal', payload: { resources: [{ type: 'project', id: OTHER }] } as never }, 'project', OTHER)).toBe(true)
  })
})

// The toast a card that needs somewhere to go shows, read through the owner rule (lib/work/bot-owner.ts).
describe('needsTargetToast', () => {
  const owners = botOwners(
    [
      { id: 'tm-assistant', workspace_id: 'w1', name: 'Assistant', is_system: true, system_key: 'assistant', reachable: true },
      { id: 'writer', workspace_id: 'w1', name: 'Writer', reachable: true },
    ],
    { complete: true },
  )
  const card = (payload: Record<string, unknown>, workspace_id = 'w1') => ({ workspace_id, source_flow_run_id: null, payload })

  it('a card with no raiser, or one whose raiser is gone, is with the Assistant', () => {
    expect(needsTargetToast(card({}), owners)).toBe('It’s with the Assistant: pick where this goes in For you or on its page')
    expect(needsTargetToast(card({ raised_by_ai_member_id: 'deleted-bot' }), owners)).toBe('It’s with the Assistant: pick where this goes in For you or on its page')
  })

  it('a card a reachable bot raised is with that bot', () => {
    expect(needsTargetToast(card({ raised_by_ai_member_id: 'writer' }), owners)).toBe('Pick where this goes in For you or on its agent’s page')
  })

  it('in a workspace with no Assistant, a card that names no one says only what it needs', () => {
    expect(needsTargetToast(card({}, 'w2'), owners)).toBe('This card needs somewhere to go before it can be added')
    expect(needsTargetToast(card({}), NO_BOT_OWNERS)).toBe('This card needs somewhere to go before it can be added')
  })
})
