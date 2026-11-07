// @vitest-environment jsdom
/**
 * For you, on a bot's page (docs/plans/bots-v4.md Phases 1b and 3).
 *
 *   • what's new first, in its bubble's order (bubbleItems: its waiting rows
 *     not opened yet, then its cards), then what still waits on you that
 *     you've seen (seenItems: an opened review), the seen ones marked Seen,
 *     and nothing twice; a run parked on a question is never here (P13: it
 *     asks in the chat);
 *   • settled here (Phase 3): its cards and its whole reviews are the real
 *     cards, in the Needs you deck narrowed to this bot (new, then seen): a
 *     card's pills and Accept (its properties as corrections), the picker for
 *     an update with no target, a review's Reviewed; the receipt paints after
 *     the last card goes; "Refine in chat" goes to the page's chat with this
 *     bot (`onRefine`), never the main chat; the events carry `surface:
 *     'bot_page'`;
 *   • the rest (a review not held whole) are rows that open their
 *     item on this page, in this window (Phase 2), whatever workspace it's in,
 *     never over the Agents page;
 *   • a work proposal another bot raised for this one is read-only here,
 *     "From Triage", uncounted (decision 9), opening its run's item;
 *   • a handoff listed on its own names the run it was part of;
 *   • the page's own (whole) rows win over the shell's light ones;
 *   • with nothing waiting it says so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { WorkItem } from '@/lib/work/types'
import type { LightWorkRow } from '@/lib/work/queries'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const shared = vi.hoisted(() => ({
  rows: [] as unknown[],
  cards: [] as unknown[],
  /** The chat's cards (P13): none unless a test puts some. */
  asks: [] as unknown[],
  counts: new Map(),
  /** The page's own item opener (the bot card's BotPageNav). */
  pageOpenItem: vi.fn(),
  openBotPage: vi.fn((_id: string, _opts?: unknown) => true),
  openWorkItem: vi.fn((_id: string, _ids: readonly string[], _known?: unknown) => ({ kind: 'item' })),
  accept: vi.fn(async (_id: string, _c?: unknown, _t?: unknown) => ({ ok: true, status: 'accepted', identifier: 'ENG-42' }) as unknown),
  start: vi.fn(async (_id: string) => ({ ok: true, status: 'started' }) as unknown),
  dismiss: vi.fn(async (_id: string) => {}),
  reviewed: vi.fn(async (_id: string) => ({ ok: true })),
  capture: vi.fn(),
  openDeliverable: vi.fn(async (_d: unknown, _ctx: unknown, _nav: unknown) => true),
}))
vi.mock('@/components/work/agent-work-provider', () => ({
  useAgentWorkShared: () => ({
    work: {
      rows: shared.rows,
      cardRows: [],
      roster: [
        { id: 'writer', name: 'Writer', workspace_id: 'w1' },
        { id: 'triage', name: 'Triage', workspace_id: 'w1' },
      ],
      reviewed: shared.reviewed,
      dismissReview: vi.fn(async () => {}),
    },
    attention: { items: shared.cards, asks: shared.asks, editCard: vi.fn(), accept: shared.accept, start: shared.start, draft: vi.fn(), dismiss: shared.dismiss },
    counts: shared.counts,
  }),
}))
vi.mock('@/hooks/use-open-teammate', () => ({ useOpenWorkItem: () => shared.openWorkItem }))
// A delivered item's chevron opens its output through the work panel's opener (Liam, 10-15).
vi.mock('@/lib/work/open-deliverable', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/work/open-deliverable')>()),
  openDeliverable: shared.openDeliverable,
}))
vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaces: () => ({ workspaces: [], currentId: 'w1' }) }))
vi.mock('@/lib/bots/bot-page', () => ({ openBotPage: shared.openBotPage }))
vi.mock('@/components/work/work-item-detail-panel', () => ({ StatusIcon: () => null }))
vi.mock('posthog-js/react', () => ({ usePostHog: () => ({ capture: shared.capture }) }))
// The action picker for an update with no target: its trigger opens it, and open it offers one action.
vi.mock('@/components/capture/action-target-picker', () => ({
  ActionTargetPicker: ({ open, onOpenChange, onPick, children }: { open: boolean; onOpenChange: (o: boolean) => void; onPick: (a: { id: string }) => void; children: unknown }) =>
    h(
      'div',
      { 'data-testid': 'target-picker', 'data-open': String(open) },
      h('span', { onClick: () => onOpenChange(!open) }, children as never),
      open ? h('button', { type: 'button', onClick: () => onPick({ id: 'act-9' }) }, 'Pick ENG-9') : null,
    ),
}))

import { countByOwner } from '@/lib/work/agent-work-lanes'
import { ForYou, forYouItems, forYouLayout, forYouRows } from '../for-you'
import { useBotPageOpen } from '../use-bot-page-open'
import { BotPageNavContext } from '../bot-page-nav'

function light(id: string, over: Partial<LightWorkRow> = {}): LightWorkRow {
  return {
    id,
    workspace_id: 'w1',
    member_id: 'm1',
    kind: 'work_run',
    status: 'needs_review',
    origin: 'loop',
    ai_team_member_id: 'writer',
    parent_id: null,
    root_id: null,
    flow_run_id: null,
    source: {},
    opened_at: null,
    needs: null,
    created_at: '2026-10-03T08:00:00.000Z',
    teammate: null,
    ...over,
  }
}
function full(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return {
    ...light(id),
    title: `Item ${id}`,
    actor: 'agent',
    current_step: null,
    progress: {},
    result_summary: null,
    error_message: null,
    skip_reason: null,
    deliverables: [],
    run_key: null,
    agent_run_id: null,
    started_at: null,
    finished_at: null,
    reviewed_at: null,
    last_beat_at: '2026-10-03T08:00:00.000Z',
    deadline_at: null,
    ...over,
  } as WorkItem
}
const card = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspace_id: 'w1',
  member_id: 'm1',
  kind: 'action_card',
  title: `Card ${id}`,
  why: null,
  payload: { raised_by_ai_member_id: 'writer' },
  proposal_id: null,
  source_flow_run_id: null,
  status: 'pending',
  expires_at: null,
  created_at: '2026-10-03T08:30:00.000Z',
  ...over,
})

/** What the shell holds: its rows and cards, and countByOwner over them, as the provider's. */
function hold(rows: Array<WorkItem | LightWorkRow>, cards: ReturnType<typeof card>[] = []) {
  shared.rows = rows
  shared.cards = cards
  shared.counts = countByOwner(rows, cards as never)
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  shared.pageOpenItem.mockClear()
  shared.openBotPage.mockClear()
  shared.openWorkItem.mockClear()
  shared.accept.mockClear()
  shared.start.mockClear()
  shared.dismiss.mockClear()
  shared.reviewed.mockClear()
  shared.capture.mockClear()
  shared.openDeliverable.mockClear()
  hold([])
  // The fixtures are dated 2026-10-03: pin "now" beside them, or a card's
  // relative time turns into a date ("Oct 3") a week on and runs into the
  // pager's "1/3" ("Oct 31/3"). Only Date is faked; timers stay real.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-03T12:00:00.000Z'))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

function Harness({ rows, onRefine }: { rows: WorkItem[]; onRefine?: (...args: unknown[]) => void }) {
  const open = useBotPageOpen('writer')
  return h(ForYou, { teammateId: 'writer', name: 'Writer', rows, chips: {}, open, onRefine })
}
const NAV = { openItem: (item: unknown) => shared.pageOpenItem(item) }
async function render(rows: WorkItem[], onRefine?: (...args: unknown[]) => void) {
  await act(async () => root.render(h(BotPageNavContext.Provider, { value: NAV }, h(Harness, { rows, onRefine }))))
}
/** The rows listed under the deck, in order. */
const entries = () => Array.from(container.querySelectorAll<HTMLElement>('[data-work-row]')).map((el) => el.getAttribute('data-work-row'))
const entry = (id: string) => container.querySelector<HTMLElement>(`[data-work-row="${id}"]`)!
const deck = () => container.querySelector<HTMLElement>('[data-bot-page-deck]')
const button = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name)
/** The deck's pager: "1/3", or nothing for one card. */
const pagerText = () => deck()?.textContent?.match(/\d+\/\d+/)?.[0] ?? null

describe('forYouItems', () => {
  it('is bubbleItems (new) and seenItems (seen), with nothing in both', () => {
    const rows = [
      light('new-review'),
      light('opened-question', { status: 'needs_input', opened_at: '2026-10-03T09:00:00.000Z' }),
      light('opened-review', { kind: 'email_drafts', opened_at: '2026-10-03T09:05:00.000Z' }),
      light('theirs', { ai_team_member_id: 'triage' }),
    ]
    const cards = [card('c1')]
    const { fresh, seen } = forYouItems('writer', countByOwner(rows, cards as never), rows, cards as never)
    expect(fresh.map((i) => i.id)).toEqual(['new-review', 'c1'])
    // The opened question asks in the chat (P13), never here.
    expect(seen.map((i) => i.id)).toEqual(['opened-review'])
  })

  it('reads the page’s own rows first, then the shell’s for any it doesn’t hold yet', () => {
    const merged = forYouRows([full('a')], [light('a'), light('b')])
    expect(merged.map((r) => r.id)).toEqual(['a', 'b'])
    expect('title' in merged[0] && merged[0].title).toBe('Item a')
  })

  it('lays the deck out new then seen (cards, a run’s cards, whole reviews), the rest as rows', () => {
    const rows = [
      full('new-review'),
      full('new-question', { status: 'needs_input' }),
      light('light-review', { created_at: '2026-10-03T07:00:00.000Z' }),
      full('seen-review', { opened_at: '2026-10-03T09:05:00.000Z' }),
      full('seen-question', { status: 'needs_input', opened_at: '2026-10-03T09:00:00.000Z' }),
    ]
    const cards = [card('c1'), card('b1', { payload: { raised_by_ai_member_id: 'writer', work_item_id: 'run-1' } }), card('b2', { payload: { raised_by_ai_member_id: 'writer', work_item_id: 'run-1' } })]
    const layout = forYouLayout(forYouItems('writer', countByOwner(rows, cards as never), rows, cards as never))
    expect(layout.deck.map((c) => c.id)).toEqual(['work:new-review', 'c1', 'b1', 'b2', 'work:seen-review'])
    expect(layout.deck.map((c) => ('seen' in c ? !!c.seen : false))).toEqual([false, false, false, false, true])
    // Questions ask in the chat (P13); a review not held whole is a row.
    expect(layout.rows.map((r) => [r.item.id, r.seen])).toEqual([['light-review', false]])
    expect(layout.itemOf.get('b2')?.id).toBe('work:run-1')
  })
})

describe('ForYou', () => {
  it('shows what’s new first, then what you’ve seen: the deck (new, then seen, a seen review marked Seen), then the rows', async () => {
    const shell = [
      light('new-review'),
      light('opened-question', { status: 'needs_input', opened_at: '2026-10-03T09:00:00.000Z' }),
      light('opened-review', { kind: 'email_drafts', opened_at: '2026-10-03T09:05:00.000Z' }),
    ]
    hold(shell, [card('c1')])
    await render([
      full('new-review'),
      full('opened-question', { status: 'needs_input', opened_at: '2026-10-03T09:00:00.000Z' }),
      full('opened-review', { kind: 'email_drafts', opened_at: '2026-10-03T09:05:00.000Z' }),
    ])
    // The deck pages the new review, the card, then the seen review.
    expect(pagerText()).toBe('1/3')
    expect(deck()!.querySelector('[data-review-card="new-review"]')!.textContent).toContain('Item new-review')
    expect(deck()!.querySelector('[data-review-card-seen]')).toBeNull()
    await act(async () => button('Next card')!.click())
    expect(deck()!.textContent).toContain('Card c1')
    await act(async () => button('Next card')!.click())
    expect(deck()!.querySelector('[data-review-card="opened-review"] [data-review-card-seen]')!.textContent).toContain('Seen')
    // The opened question is not here: it asks in the chat (P13).
    expect(entries()).toEqual([])
    // The lane counts the three delivered ones.
    expect(container.querySelector('section[aria-label="For you"] h2')!.textContent).toContain('3')
  })

  it('accepting a card sends its properties as corrections; a target-less update opens the picker first', async () => {
    hold([], [card('c1', { payload: { raised_by_ai_member_id: 'writer', change_type: 'create', entity_type: 'action', priority: 'high', project_id: 'p1' } })])
    await render([])
    await act(async () => button('Create action')!.click())
    expect(shared.accept).toHaveBeenCalledWith('c1', expect.objectContaining({ priority: 'high', project_id: 'p1', assignee_ai_member_id: null }), undefined)
    expect(shared.capture).toHaveBeenCalledWith('attention_card_accepted', expect.objectContaining({ surface: 'bot_page' }))

    shared.accept.mockClear()
    hold([], [card('u1', { payload: { raised_by_ai_member_id: 'writer', change_type: 'update', entity_type: 'action', entity_id: null } })])
    await render([])
    await act(async () => button('Choose target')!.click())
    expect(shared.accept).not.toHaveBeenCalled()
    expect(deck()!.querySelector('[data-testid="target-picker"]')!.getAttribute('data-open')).toBe('true')
    await act(async () => button('Pick ENG-9')!.click())
    expect(shared.accept).toHaveBeenCalledWith('u1', expect.any(Object), 'act-9')
  })

  it('the receipt paints after the last card goes', async () => {
    let land: (v: unknown) => void = () => {}
    shared.accept.mockImplementationOnce(() => new Promise((resolve) => (land = resolve)))
    hold([], [card('c1', { payload: { raised_by_ai_member_id: 'writer', change_type: 'create', entity_type: 'action' } })])
    await render([])
    await act(async () => button('Create action')!.click())
    hold([], [])
    await render([])
    expect(deck()!.querySelector('[data-attention-resolved="applying"]')).not.toBeNull()
    await act(async () => land({ ok: true, status: 'accepted', identifier: 'ENG-42' }))
    expect(deck()!.querySelector('[data-attention-resolved="done"]')!.textContent).toContain('Created ENG-42')
  })

  it('a review’s Reviewed settles it through the shared source', async () => {
    hold([light('r1')])
    await render([full('r1')])
    await act(async () => button('Reviewed')!.click())
    expect(shared.reviewed).toHaveBeenCalledWith('r1')
  })

  it('a delivered review opens its output from its chevron; its run’s chat is the caret menu’s Open chat', async () => {
    const delivered = full('r1', { deliverables: [{ type: 'document', id: 'doc-1', label: 'Brief' }] })
    hold([light('r1')])
    await render([delivered])
    const chevron = deck()!.querySelector<HTMLButtonElement>('[data-review-card-opens]')!
    expect(chevron.getAttribute('data-review-card-opens')).toBe('document')
    await act(async () => {
      chevron.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(shared.openDeliverable).toHaveBeenCalledTimes(1)
    expect(shared.openDeliverable.mock.calls[0][0]).toMatchObject({ type: 'document', id: 'doc-1' })
    expect(shared.openWorkItem).not.toHaveBeenCalled()

    act(() => {
      deck()!.querySelector<HTMLButtonElement>('button[aria-label="More actions"]')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    })
    const openChat = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.trim() === 'Open chat')!
    await act(async () => openChat.click())
    expect(shared.openWorkItem).toHaveBeenCalledTimes(1)
    expect(shared.openWorkItem.mock.calls[0][0]).toBe('r1')
  })

  it('a review with nothing to open: its chevron opens the item, and its menu offers no Open chat', async () => {
    hold([light('r1')])
    await render([full('r1')])
    const chevron = deck()!.querySelector<HTMLButtonElement>('[data-review-card-opens]')!
    expect(chevron.getAttribute('data-review-card-opens')).toBe('item')
    await act(async () => chevron.click())
    expect(shared.openWorkItem).toHaveBeenCalledTimes(1)
    expect(shared.openDeliverable).not.toHaveBeenCalled()
    act(() => {
      deck()!.querySelector<HTMLButtonElement>('button[aria-label="More actions"]')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    })
    expect([...document.querySelectorAll('[role="menuitem"]')].some((el) => el.textContent?.trim() === 'Open chat')).toBe(false)
  })

  it('“Refine in chat” goes to the page’s chat with this bot (the card and its item), never the main chat', async () => {
    const mainChat = vi.fn()
    window.addEventListener('dial8:chat-about-proposal', mainChat)
    try {
      const onRefine = vi.fn()
      hold([], [card('e1', { kind: 'draft_email', payload: { raised_by_ai_member_id: 'writer', email_to_name: 'Dana' } })])
      await render([], onRefine)
      await act(async () => button('Refine')!.click())
      expect(onRefine).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1' }), expect.objectContaining({ kind: 'card', id: 'e1' }))
      expect(mainChat).not.toHaveBeenCalled()
      expect(shared.dismiss).toHaveBeenCalledWith('e1')
    } finally {
      window.removeEventListener('dial8:chat-about-proposal', mainChat)
    }
  })

  /** This bot's page on one of its items, as the page's window is sent to it. */
  const onPage = (itemId: string, title: string) => ({ itemId, title })

  it('a row opens its item on this page, in this window, whatever workspace it’s in; never over the Inbox or the Agents page', async () => {
    // Reviews the page doesn't hold whole yet (the shell's light rows): rows.
    hold([light('here'), light('there', { workspace_id: 'w2' })])
    await render([])
    await act(async () => entry('here').querySelector('button')!.click())
    expect(shared.pageOpenItem).toHaveBeenLastCalledWith(expect.objectContaining({ itemId: onPage('here', '').itemId }))
    await act(async () => entry('there').querySelector('button')!.click())
    expect(shared.pageOpenItem).toHaveBeenLastCalledWith(expect.objectContaining({ itemId: onPage('there', '').itemId }))
    expect(shared.pageOpenItem).toHaveBeenCalledTimes(2)
    expect(shared.openWorkItem).not.toHaveBeenCalled()
    expect(shared.openBotPage).not.toHaveBeenCalled()
  })

  it('a run’s cards are the deck’s, paged one by one', async () => {
    const cards = [
      card('c1', { payload: { raised_by_ai_member_id: 'writer', work_item_id: 'run-9', capture_title: 'Call with Acme' } }),
      card('c2', { payload: { raised_by_ai_member_id: 'writer', work_item_id: 'run-9', capture_title: 'Call with Acme' } }),
    ]
    hold([], cards)
    await render([])
    expect(pagerText()).toBe('1/2')
    expect(deck()!.textContent).toContain('Card c1')
    expect(entries()).toEqual([])
  })

  // bots-v4.md decision 9: the raiser owns a work proposal; the teammate it
  // proposes sees it here read-only, with no dot and no count.
  it('a work proposal another bot raised for this one is read-only here: “From Triage”, uncounted, opening its run', async () => {
    hold([], [card('proposal', { kind: 'work_proposal', payload: { raised_by_ai_member_id: 'triage', assignee_ai_member_id: 'writer', work_item_id: 'run-7' } })])
    await render([])
    expect(deck()).toBeNull()
    expect(container.textContent).toContain('Nothing from Writer is waiting on you.')
    expect(container.querySelector('section[aria-label="For you"] h2')!.textContent).not.toMatch(/\d/)
    const mention = container.querySelector<HTMLElement>('[data-bot-page-mention="proposal"]')!
    expect(mention.querySelector('[data-bot-page-mention-from]')!.textContent).toBe('From Triage')
    expect(button('Start')).toBeUndefined()
    await act(async () => mention.querySelector('button')!.click())
    expect(shared.openWorkItem).toHaveBeenCalledWith('run-7', [], { workspaceId: 'w1', title: 'Card proposal', teammateId: 'triage' })
    expect(shared.pageOpenItem).not.toHaveBeenCalled()
  })

  it('a handoff listed on its own names the run it was part of', async () => {
    const root = full('root', { status: 'done', ai_team_member_id: 'triage', title: 'Weekly brief' })
    // A review handoff the page doesn't hold whole yet: a row.
    hold([light('child', { parent_id: 'root', root_id: 'root' })])
    await render([root])
    expect(entries()).toEqual(['child'])
    expect(entry('child').textContent).toContain('Part of Weekly brief')
  })

  it('never says "nothing waiting" while it asks you something in the chat (P13)', async () => {
    hold([light('asking', { status: 'needs_input' })])
    await render([full('asking', { status: 'needs_input' })])
    expect(entries()).toEqual([])
    expect(container.textContent).not.toContain('Nothing from Writer is waiting on you.')
    expect(container.textContent).toContain('What Writer is asking you waits in your chat.')
  })

  it('says so with nothing waiting on you', async () => {
    hold([light('busy', { status: 'running' })])
    await render([full('busy', { status: 'running' })])
    expect(entries()).toEqual([])
    expect(deck()).toBeNull()
    expect(container.textContent).toContain('Nothing from Writer is waiting on you.')
  })
})
