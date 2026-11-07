// @vitest-environment jsdom
/**
 * A bot's page (lib/bots/bot-page.ts, docs/plans/bots-v4.md Phase 1b).
 *
 *   • openBotPage asks the dashboard for the teammate's page over
 *     openTeammateChatTab (the bridge answers for a teammate its roster
 *     holds), with `replaceTeammateId` passed on for the switcher;
 *     openBotPageItem asks for it on one of its items (Phase 2), and asks no
 *     part (an item always opens on the item);
 *   • the part a narrow window shows rides beside the open: Work by default,
 *     heard by its page when it mounts just after (within the TTL) or at once
 *     when it's mounted, and only by that teammate's page; the page that
 *     applies it takes it (a remount, or a page opened later, hears nothing);
 *     nothing is asked when the dashboard didn't take it;
 *   • its face's state: working while it runs something, asleep while it's
 *     switched off, paused, or stopped by the AI limit lately, else at rest.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OPEN_TEAMMATE_CHAT_EVENT, type OpenTeammateChatDetail } from '../teammate-chat-tab'
import {
  AI_LIMIT_SLEEP_HOURS,
  BOT_PAGE_FOCUS_TTL_MS,
  __resetBotPageForTests,
  onBotPageFocus,
  openBotPage,
  openBotPageItem,
  stoppedByAiLimit,
} from '../bot-page'

/** The dashboard's bridge: takes the ask for a teammate it knows, and says what it got. */
function bridge(known: string[] = ['tm-1', 'tm-2']) {
  const asked: OpenTeammateChatDetail[] = []
  const onOpen = (e: Event) => {
    const detail = (e as CustomEvent<OpenTeammateChatDetail>).detail
    asked.push(detail)
    if (known.includes(detail.teammateId)) e.preventDefault()
  }
  window.addEventListener(OPEN_TEAMMATE_CHAT_EVENT, onOpen)
  return { asked, stop: () => window.removeEventListener(OPEN_TEAMMATE_CHAT_EVENT, onOpen) }
}

beforeEach(() => {
  __resetBotPageForTests()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('openBotPage', () => {
  it('opens the teammate’s page through the dashboard, and says whether it was taken', () => {
    const b = bridge()
    try {
      expect(openBotPage('tm-1')).toBe(true)
      expect(b.asked).toEqual([{ teammateId: 'tm-1' }])
      expect(openBotPage('stranger')).toBe(false)
      expect(openBotPage('')).toBe(false)
      expect(b.asked).toHaveLength(2)
    } finally {
      b.stop()
    }
    // No dashboard at all.
    expect(openBotPage('tm-1')).toBe(false)
  })

  it('openBotPageItem: the page on one of its items, through the dashboard; no part asked; nothing for no item', () => {
    const b = bridge()
    try {
      const parts: string[] = []
      expect(openBotPageItem('tm-1', { itemId: 'item-1', title: 'Reply to Acme' })).toBe(true)
      expect(b.asked).toEqual([{ teammateId: 'tm-1', itemId: 'item-1', itemTitle: 'Reply to Acme' }])
      // Its lists hear no ask from an item's open.
      onBotPageFocus('tm-1', (p) => parts.push(p))()
      expect(parts).toEqual([])
      // One the roster doesn't hold: not taken (the caller opens it over the Inbox).
      expect(openBotPageItem('stranger', { itemId: 'item-1', title: 'x' })).toBe(false)
      expect(openBotPageItem('tm-1', { itemId: '', title: 'x' })).toBe(false)
      expect(b.asked).toHaveLength(2)
    } finally {
      b.stop()
    }
  })

  it('the page that applies an ask takes it: mounting again, or another page after, hears nothing', () => {
    const b = bridge()
    try {
      openBotPage('tm-1')
      const first: string[] = []
      onBotPageFocus('tm-1', (p) => first.push(p))()
      expect(first).toEqual(['work'])
      const again: string[] = []
      onBotPageFocus('tm-1', (p) => again.push(p))()
      expect(again).toEqual([])
      // Heard live by a mounted page: taken just the same.
      const live: string[] = []
      const off = onBotPageFocus('tm-1', (p) => live.push(p))
      openBotPage('tm-1', { focus: 'chat' })
      off()
      expect(live).toEqual(['chat'])
      const late: string[] = []
      onBotPageFocus('tm-1', (p) => late.push(p))()
      expect(late).toEqual([])
    } finally {
      b.stop()
    }
  })

  it('asks its page to show Work by default, or the part named; a page mounting just after hears it', () => {
    const b = bridge()
    try {
      openBotPage('tm-1')
      const parts: string[] = []
      const off = onBotPageFocus('tm-1', (p) => parts.push(p))
      expect(parts).toEqual(['work'])
      openBotPage('tm-1', { focus: 'chat' })
      expect(parts).toEqual(['work', 'chat'])
      off()
      openBotPage('tm-1')
      expect(parts).toEqual(['work', 'chat'])
    } finally {
      b.stop()
    }
  })

  it('only that teammate’s page hears it, and not once the ask is stale', () => {
    vi.useFakeTimers()
    const b = bridge()
    try {
      openBotPage('tm-1')
      const other: string[] = []
      onBotPageFocus('tm-2', (p) => other.push(p))()
      expect(other).toEqual([])
      vi.advanceTimersByTime(BOT_PAGE_FOCUS_TTL_MS + 1)
      const late: string[] = []
      onBotPageFocus('tm-1', (p) => late.push(p))()
      expect(late).toEqual([])
    } finally {
      b.stop()
    }
  })

  it('asks nothing when the dashboard didn’t take it', () => {
    const b = bridge([])
    try {
      openBotPage('tm-1')
      const parts: string[] = []
      onBotPageFocus('tm-1', (p) => parts.push(p))()
      expect(parts).toEqual([])
    } finally {
      b.stop()
    }
  })
})

describe('stoppedByAiLimit', () => {
  const NOW = Date.parse('2026-10-04T12:00:00.000Z')
  const limited = (hoursAgo: number) => ({
    status: 'failed' as const,
    error_message: 'Plan AI usage limit reached',
    finished_at: new Date(NOW - hoursAgo * 3_600_000).toISOString(),
    created_at: new Date(NOW - hoursAgo * 3_600_000 - 60_000).toISOString(),
  })

  it('stoppedByAiLimit reads the last finished row', () => {
    expect(stoppedByAiLimit(limited(AI_LIMIT_SLEEP_HOURS - 1), NOW)).toBe(true)
    expect(stoppedByAiLimit(limited(AI_LIMIT_SLEEP_HOURS + 1), NOW)).toBe(false)
    expect(stoppedByAiLimit(null, NOW)).toBe(false)
  })
})
