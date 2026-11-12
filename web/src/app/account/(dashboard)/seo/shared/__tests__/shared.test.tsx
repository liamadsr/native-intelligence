// @vitest-environment jsdom
/**
 * The SEO pages' shared pieces: the trend chart's line maths (gaps stay
 * gaps, rank positions read top-down), the spend line's words, and why a
 * buying control is off.
 */
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SeoSpendView } from '@/lib/seo/spend-view'
import { buyBlockedReason, SeoDataNotice, SeoSpendLine, spendLineText } from '../data-status'
import { StatTiles } from '../stat-tiles'
import { TabPills } from '../tab-pills'
import { Sparkline, TrendChart, trendPath, trendSpansYears } from '../trend-chart'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
const render = (node: React.ReactNode) => act(() => root.render(node))

const spend = (over: Partial<SeoSpendView> = {}): SeoSpendView => ({
  spent_dollars: 3.4,
  cap_dollars: 20,
  resets_at: '2026-12-01T00:00:00.000Z',
  configured: true,
  can_buy: true,
  refusal: null,
  ...over,
})

describe('trendPath', () => {
  const range = { min: 0, max: 10 }
  it('draws left to right, higher values higher up', () => {
    expect(trendPath([0, 10], range, 100, false)).toBe('M0.0 94.0 L600.0 6.0')
  })
  it('inverted, puts the smallest value at the top (rank 1 is best)', () => {
    expect(trendPath([1, 10], { min: 1, max: 10 }, 100, true)).toBe('M0.0 6.0 L600.0 94.0')
  })
  it('breaks the line at a gap instead of drawing through it', () => {
    const d = trendPath([5, null, 5, 5], range, 100, false)
    expect(d.match(/M/g)).toHaveLength(2)
    expect(d.match(/L/g)).toHaveLength(1)
  })
  it('has nothing to draw when every value is missing', () => {
    expect(trendPath([null, null], range, 100, false)).toBe('')
  })
})

describe('TrendChart', () => {
  const dates = ['2026-11-01', '2026-11-08', '2026-11-15']
  it('draws one line per series with a spoken summary, and reads out the newest date', () => {
    render(
      <TrendChart
        dates={dates}
        summary="Position for rug cleaning over three weeks"
        invert
        series={[{ key: 'pos', label: 'Position', values: [12, null, 7], tone: 'text-sky-600 dark:text-sky-400' }]}
      />,
    )
    const svg = container.querySelector('svg[role="img"]')!
    expect(svg.getAttribute('aria-label')).toBe('Position for rug cleaning over three weeks')
    expect(container.querySelectorAll('[data-seo-trend-line]')).toHaveLength(1)
    expect(container.querySelector('[data-seo-trend]')!.textContent).toContain('Nov 15')
    expect(container.querySelector('[data-seo-trend]')!.textContent).toContain('Position7')
  })
  it('names the year when the range is about a year long or crosses a year’s end, and not otherwise', () => {
    expect(trendSpansYears(['2026-10-13', '2026-11-09'])).toBe(false)
    expect(trendSpansYears(['2025-11-01', '2026-11-01'])).toBe(true)
    expect(trendSpansYears(['2025-12-20', '2026-01-10'])).toBe(true)
    expect(trendSpansYears(['2026-11-01'])).toBe(false)
    render(<TrendChart dates={['2025-11-01', '2026-11-01']} summary="x" series={[{ key: 'a', label: 'Links', values: [9100, 12480], tone: 'text-sky-600' }]} />)
    const text = container.querySelector('[data-seo-trend]')!.textContent!
    expect(text).toContain('2025')
    expect(text).toContain('2026')
    render(<TrendChart dates={['2026-10-13', '2026-11-09']} summary="x" series={[{ key: 'a', label: 'Clicks', values: [3, 4], tone: 'text-sky-600' }]} />)
    expect(container.querySelector('[data-seo-trend]')!.textContent).not.toContain('2026')
  })
  it('says so instead of drawing when there is not enough history', () => {
    render(<TrendChart dates={['2026-11-01']} summary="x" series={[{ key: 'a', label: 'A', values: [3], tone: 'text-sky-600' }]} />)
    expect(container.querySelector('svg')).toBeNull()
    expect(container.querySelector('[data-seo-trend-empty]')!.textContent).toBe('Not enough history yet')
  })
  it('moves the readout with the keyboard, and shows a dash where a date has no value', () => {
    render(<TrendChart dates={dates} summary="x" series={[{ key: 'a', label: 'Clicks', values: [4, null, 9], tone: 'text-sky-600' }]} />)
    const svg = container.querySelector('svg[role="img"]') as SVGSVGElement
    act(() => {
      svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    const readout = container.querySelector('[data-seo-trend]')!.textContent!
    expect(readout).toContain('Nov 8')
    expect(readout).toContain('Clicks—')
  })
  it('a sparkline needs two values to draw', () => {
    render(<Sparkline values={[3, null]} label="Trend" />)
    expect(container.querySelector('svg')).toBeNull()
    render(<Sparkline values={[3, 5, 4]} label="Trend" />)
    expect(container.querySelector('svg')!.getAttribute('aria-label')).toBe('Trend')
  })
})

describe('the spend line', () => {
  it('reads as money against the ceiling, with the reset date', () => {
    expect(spendLineText(spend())).toBe('$3.40 of $20 this month · resets Dec 1')
  })
  it('is quiet normally, amber when little is left, and absent where lookups are off or unknown', () => {
    render(<SeoSpendLine view={spend()} />)
    expect(container.querySelector('[data-seo-spend]')!.className).toContain('text-muted-foreground')
    render(<SeoSpendLine view={spend({ spent_dollars: 19.4 })} />)
    expect(container.querySelector('[data-seo-spend]')!.className).toContain('text-amber-600')
    render(<SeoSpendLine view={spend({ configured: false, can_buy: false })} />)
    expect(container.querySelector('[data-seo-spend]')).toBeNull()
    render(<SeoSpendLine view={null} />)
    expect(container.querySelector('[data-seo-spend]')).toBeNull()
  })
})

describe('when lookups are off', () => {
  const notSetUp = spend({ configured: false, can_buy: false, refusal: { code: 'SEO_NOT_CONFIGURED', message: 'not set up' } })
  const freePlan = spend({ can_buy: false, refusal: { code: 'FREE_PLAN', message: 'paid plan' } })
  const guest = spend({ can_buy: false, refusal: { code: 'NOT_A_MEMBER', message: 'for members' } })
  it('a buying control says why it is disabled', () => {
    expect(buyBlockedReason(spend())).toBeNull()
    expect(buyBlockedReason(null)).toBeNull()
    expect(buyBlockedReason(notSetUp)).toBe('Search data isn’t set up on this server yet')
    expect(buyBlockedReason(freePlan)).toBe('Part of the paid plan')
    expect(buyBlockedReason(guest)).toBe('For workspace members')
    // Anything else speaks with the refusal's own words.
    expect(buyBlockedReason(spend({ can_buy: false, refusal: { code: 'CHECK_FAILED', message: 'Try again in a moment.' } }))).toBe('Try again in a moment.')
  })
  it('the notice names the page’s data and the reason, and points at what still works', () => {
    render(<SeoDataNotice view={notSetUp} what="Keyword data" />)
    expect(container.querySelector('[data-seo-data-off="SEO_NOT_CONFIGURED"]')!.textContent).toContain('Keyword data isn’t set up yet')
    render(<SeoDataNotice view={freePlan} what="Rank tracking" />)
    const text = container.querySelector('[data-seo-data-off="FREE_PLAN"]')!.textContent!
    expect(text).toContain('Rank tracking is part of the paid plan')
    expect(text).toContain('The site audit is free')
    // A workspace guest: told it is for members, never that it is a paid-plan matter.
    render(<SeoDataNotice view={guest} what="Backlink data" />)
    const guestText = container.querySelector('[data-seo-data-off="NOT_A_MEMBER"]')!.textContent!
    expect(guestText).toContain('Backlink data is for workspace members')
    expect(guestText).toContain('Ask a member')
    expect(guestText).not.toContain('paid plan')
    render(<SeoDataNotice view={spend()} what="Keyword data" />)
    expect(container.querySelector('[data-seo-data-off]')).toBeNull()
  })
})

describe('tiles and tabs', () => {
  it('a tile shows a dash for a value that is not known yet, never a zero', () => {
    render(<StatTiles tiles={[{ key: 'a', label: 'Keywords', value: 1200 }, { key: 'b', label: 'Average position', value: null, title: 'After the first check' }]} />)
    expect(container.querySelector('[data-seo-tile="a"]')!.textContent).toBe('1,200Keywords')
    expect(container.querySelector('[data-seo-tile="b"] p')!.textContent).toBe('—')
    expect(container.querySelector('[data-seo-tile="b"] p')!.getAttribute('title')).toBe('After the first check')
  })
  it('tab pills mark the selected tab and hide a zero count', () => {
    const seen: string[] = []
    render(<TabPills label="Tracker" value="positions" onChange={(t) => seen.push(t)} tabs={[{ id: 'positions', label: 'Positions', count: 12 }, { id: 'history', label: 'History', count: 0 }]} />)
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(tabs.map((t) => [t.textContent, t.getAttribute('aria-selected')])).toEqual([
      ['Positions12', 'true'],
      ['History', 'false'],
    ])
    act(() => tabs[1].click())
    expect(seen).toEqual(['history'])
  })
})
