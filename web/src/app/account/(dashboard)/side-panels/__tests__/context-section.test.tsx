// @vitest-environment jsdom
/**
 * The side panel's Context card body (context-section.tsx): "18% used" and
 * "45.2k / 250k", the bar, one row per part with tokens and its share of the
 * window (a part at 0 shows none), the free space and the compaction buffer;
 * after a compaction, "Compacted" and the summary's size unknown; Compact now
 * an outlined button offered past 60% of the window only, off while a reply
 * runs, its spinner while compacting, its outcome under it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const m = vi.hoisted(() => ({ compact: vi.fn(async (_id: string) => ({ text: 'ok', tone: 'muted' as const })) }))
vi.mock('@/lib/chat/context-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/context-client')>()),
  compactChatContext: m.compact,
}))

import { COMPACT_BUTTON_SHARE, ContextSection, contextRows, contextSummary, formatShare, formatTokens, offersCompact, usedPercent } from '../context-section'
import type { ChatContextState } from '@/lib/chat/context-client'
import type { ChatContextUsage } from '@/lib/chat/context-usage'

const usage = (over: Partial<ChatContextUsage> = {}): ChatContextUsage => ({
  model: 'deepseek-v4-flash',
  usedTokens: 45_200,
  windowTokens: 250_000,
  compactAtTokens: 225_000,
  idleCompactTokens: 150_000,
  modelWindowTokens: 1_000_000,
  parts: [
    { key: 'messages', tokens: 28_100 },
    { key: 'system', tokens: 9_800 },
    { key: 'tools', tokens: 5_200 },
    { key: 'skills', tokens: 0 },
    { key: 'memory', tokens: 2_100 },
  ],
  measuredAt: '2026-10-22T12:00:00.000Z',
  compactedAt: null,
  ...over,
})

const state = (over: Partial<ChatContextState> = {}): ChatContextState => ({
  conversationId: 'c-1',
  context: usage(),
  loaded: true,
  compacting: false,
  note: null,
  ...over,
})

let container: HTMLDivElement
let root: Root
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null
const render = (s: ChatContextState, busy = false) => act(() => root.render(h(ContextSection, { state: s, busy })))

beforeEach(() => {
  m.compact.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('formatting', () => {
  it('writes tokens as the Claude app does, and shares to one decimal', () => {
    expect([812, 1_000, 45_200, 218_340, 250_000, 1_000_000, 1_250_000].map(formatTokens)).toEqual(['812', '1k', '45.2k', '218.3k', '250k', '1M', '1.3M'])
    expect(formatShare(28_100, 250_000)).toBe('11.2%')
    expect(formatShare(0, 0)).toBe('0.0%')
  })

  it('the row summary: the share used, Compacted after a compaction, nothing with nothing measured', () => {
    expect(contextSummary(usage())).toBe('18%')
    expect(contextSummary(usage({ usedTokens: null, compactedAt: '2026-10-22T12:05:00.000Z' }))).toBe('Compacted')
    expect(contextSummary(null)).toBeNull()
  })

  it('the share used tops out at 100%: a call past the window reads full, its size still the true one', () => {
    expect(usedPercent(usage({ usedTokens: 260_000 }))).toBe(100)
    expect(contextSummary(usage({ usedTokens: 260_000 }))).toBe('100%')
    expect(usedPercent(usage({ usedTokens: null }))).toBe(0)
  })
})

describe('the rows', () => {
  it('the measured parts (none at 0), the free space and the buffer add up to the window', () => {
    const rows = contextRows(usage())
    expect(rows.map((r) => r.key)).toEqual(['messages', 'system', 'tools', 'memory', 'free', 'buffer'])
    expect(rows.reduce((sum, r) => sum + (r.tokens ?? 0), 0)).toBe(250_000)
    expect(rows.find((r) => r.key === 'buffer')!.tokens).toBe(25_000)
  })

  it('a size from before the parts were measured is one row', () => {
    const rows = contextRows(usage({ parts: null }))
    expect(rows.map((r) => [r.key, r.tokens])).toEqual([
      ['used', 45_200],
      ['free', 179_800],
      ['buffer', 25_000],
    ])
  })

  it('past the in-reply threshold the buffer shrinks and nothing goes negative', () => {
    const rows = contextRows(usage({ usedTokens: 240_000, parts: null }))
    expect(rows.map((r) => [r.key, r.tokens])).toEqual([
      ['used', 240_000],
      ['free', 0],
      ['buffer', 10_000],
    ])
  })

  it('after a compaction: the conversation is a summary of unknown size, the agent parts stay, no free space row', () => {
    const rows = contextRows(
      usage({
        usedTokens: null,
        compactedAt: '2026-10-22T12:05:00.000Z',
        parts: [
          { key: 'system', tokens: 9_800 },
          { key: 'tools', tokens: 5_200 },
          { key: 'skills', tokens: 0 },
          { key: 'memory', tokens: 2_100 },
        ],
      }),
    )
    expect(rows.map((r) => [r.key, r.tokens])).toEqual([
      ['messages', null],
      ['system', 9_800],
      ['tools', 5_200],
      ['memory', 2_100],
      ['buffer', 25_000],
    ])
  })
})

describe('ContextSection', () => {
  it('draws the share used, the size of the window, the bar and a row per part', () => {
    render(state())
    expect(q('[data-context-used]')!.textContent).toBe('18% used')
    expect(q('[data-context-total]')!.textContent).toBe('45.2k / 250k')
    expect(q('[data-context-bar]')!.getAttribute('aria-label')).toBe('Context: Messages 28.1k, System prompt 9.8k, Tools 5.2k, Memory 2.1k, of 250k')
    const row = (key: string) => [...q(`[data-context-part="${key}"]`)!.querySelectorAll('span')].map((s) => s.textContent).filter(Boolean)
    expect(row('messages')).toEqual(['Messages', '28.1k', '11.2%'])
    expect(row('buffer')).toEqual(['Compaction buffer', '25k', '10.0%'])
    expect(q('[data-context-part="skills"]')).toBeNull()
    expect(q('[data-context-hint]')!.textContent).toBe('Compacts on its own past 150k, between messages.')
  })

  it('offers Compact now only past 60% of the window, and never after a compaction', () => {
    expect(COMPACT_BUTTON_SHARE).toBe(0.6)
    expect(offersCompact(usage({ usedTokens: 150_000 }))).toBe(false)
    expect(offersCompact(usage({ usedTokens: 150_001 }))).toBe(true)
    expect(offersCompact(usage({ usedTokens: null, compactedAt: '2026-10-22T12:05:00.000Z' }))).toBe(false)
    render(state())
    expect(q('[data-context-compact]')).toBeNull()
    render(state({ context: usage({ usedTokens: 160_000, parts: null }) }))
    const button = q('[data-context-compact]') as HTMLButtonElement
    expect(button.textContent).toBe('Compact now')
    // A button that reads as one: outlined, full width.
    expect(button.className).toContain('border')
    expect(button.className).toContain('w-full')
  })

  it('Compact now compacts the conversation; it is off while a reply runs, and says so', () => {
    const big = usage({ usedTokens: 160_000, parts: null })
    render(state({ context: big }))
    act(() => q('[data-context-compact]')!.click())
    expect(m.compact).toHaveBeenCalledWith('c-1')
    render(state({ context: big }), true)
    expect((q('[data-context-compact]') as HTMLButtonElement).disabled).toBe(true)
    expect(q('[data-context-compact]')!.title).toBe('Wait for the reply to finish')
    expect(q('[data-context-hint]')!.textContent).toBe('Compact once the reply finishes.')
  })

  it('compacting (from the button or /compact, at any size): the button says so and is off; then the outcome shows under it', () => {
    render(state({ compacting: true }))
    const button = q('[data-context-compact]') as HTMLButtonElement
    expect(button.textContent).toBe('Compacting…')
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    render(state({ note: { text: 'Compacted. The next message starts from a summary.', tone: 'muted' } }))
    expect(q('[data-context-note]')!.textContent).toBe('Compacted. The next message starts from a summary.')
    expect(q('[data-context-note]')!.getAttribute('role')).toBe('status')
    render(state({ note: { text: 'A reply is still running. Compact once it finishes.', tone: 'attention' } }))
    expect(q('[data-context-note]')!.className).toContain('text-amber-700')
  })

  it('after a compaction it says the size shows with the next message', () => {
    render(state({ context: usage({ usedTokens: null, compactedAt: '2026-10-22T12:05:00.000Z', parts: null }) }))
    expect(q('[data-context-used]')!.textContent).toBe('Compacted')
    expect(q('[data-context-total]')!.textContent).toBe('— / 250k')
    expect(q('[data-context-compacted]')!.textContent).toBe('The next message starts from a summary. Its size shows then.')
    expect(q('[data-context-compact]')).toBeNull()
    expect(q('[data-context-hint]')).toBeNull()
    expect([...q('[data-context-part="messages"]')!.querySelectorAll('span')].map((s) => s.textContent).filter(Boolean)).toEqual(['Messages', 'Summary', '—'])
  })

  it('nothing measured: nothing drawn', () => {
    render(state({ context: null }))
    expect(container.innerHTML).toBe('')
  })
})
