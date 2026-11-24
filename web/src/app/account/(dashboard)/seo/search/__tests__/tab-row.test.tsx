// @vitest-environment jsdom
/**
 * Search performance's tabs and period (Liam, 11-23: "can you make sure it's
 * updated everywhere? and everything looks the same as the projects page"):
 * the page's first row (DETAIL_TAB_ROW), in the card's corner, the four tabs
 * from the left and the period at the row's end, in every page's tab pill;
 * the card header's right holds only the "…" menu. Outside a card the same
 * row stands under the page's own header row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CardHeaderSlotsProvider } from '@/components/chat-cards/card-header-slot'
import { DETAIL_TAB_ROW, pageTabClass } from '@/components/views/page-tabs'
import type { GoogleSeoStatus } from '@/lib/seo/google/view'
import { stubAppFetch } from '@/test/app-fetch-stub'

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/lib/integrations/use-connect-provider', () => ({ useConnectProvider: () => ({ connect: vi.fn(), connectingId: null }) }))

const { SearchPerformancePage } = await import('../search-performance-view')

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SITE = 'sc-domain:fernhillstudio.example'
const ME = [{ account_id: 'acc-me', email: 'jonas@fernhillstudio.example', status: 'ok' as const }]
const SOURCE = { site_url: SITE, account_id: 'acc-me', account_email: 'jonas@fernhillstudio.example', chosen_by: 'u1', chosen_by_name: 'Jonas', chosen_at: '2026-11-01T10:00:00Z', health: 'ok' as const }
const READY: GoogleSeoStatus = {
  workspace_site_url: 'https://fernhillstudio.example',
  search_console: { state: 'ready', my_accounts: ME, source: SOURCE, options: [], suggested: SITE },
  analytics: { state: 'not_connected', my_accounts: [], source: null, options: [], suggested: null },
}

let container: HTMLDivElement
let right: HTMLDivElement
let root: Root

beforeEach(() => {
  // The tab's own reads are refused: only where the controls stand counts here.
  stubAppFetch({ '/api/account/seo/google/status': READY })
  container = document.createElement('div')
  right = document.createElement('div')
  document.body.append(right, container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  right.remove()
  vi.unstubAllGlobals()
})

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

describe('Search performance’s tab row', () => {
  it('in a card: the page’s first row holds the tabs and, at its end, the period; the header’s right only the menu', async () => {
    const onTab = vi.fn()
    await act(async () => root.render(<CardHeaderSlotsProvider value={{ left: null, right }}><SearchPerformancePage tab="pages" onTab={onTab} /></CardHeaderSlotsProvider>))
    await settle()
    const page = container.querySelector<HTMLElement>('[data-seo-search-page]')!
    const row = page.firstElementChild as HTMLElement
    expect(row.hasAttribute('data-seo-tab-row')).toBe(true)
    // In the card's corner: the row's own 48px and 10px sides, no padding above it.
    expect(row.className).toContain(DETAIL_TAB_ROW)
    expect(page.className).not.toContain('pt-2')
    const tabs = row.querySelector<HTMLElement>('[role="tablist"][aria-label="Search performance"]')!
    expect(Array.from(tabs.querySelectorAll('[role="tab"]')).map((t) => [t.getAttribute('data-seo-tab'), t.getAttribute('aria-selected'), t.className])).toEqual([
      ['queries', 'false', pageTabClass(false)],
      ['pages', 'true', pageTabClass(true)],
      ['opportunities', 'false', pageTabClass(false)],
      ['analytics', 'false', pageTabClass(false)],
    ])
    const period = row.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Period"]')!
    expect(period.parentElement!.className).toContain('ml-auto')
    expect(tabs.compareDocumentPosition(period) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(period.querySelector('[data-seo-filter="last_28_days"]')!.getAttribute('aria-checked')).toBe('true')
    // The header keeps the menu and nothing of the row.
    expect(right.querySelector('[data-seo-search-menu]')).not.toBeNull()
    expect(right.querySelector('[role="tablist"], [role="radiogroup"], [data-seo-tab], [data-seo-filter]')).toBeNull()
    // Under the row, the site's line.
    expect(container.querySelector('[data-seo-search-site]')).not.toBeNull()
    await act(async () => tabs.querySelector<HTMLButtonElement>('[data-seo-tab="opportunities"]')!.click())
    expect(onTab).toHaveBeenCalledWith('opportunities')
    await act(async () => period.querySelector<HTMLButtonElement>('[data-seo-filter="last_7_days"]')!.click())
    expect(period.querySelector('[data-seo-filter="last_7_days"]')!.getAttribute('aria-checked')).toBe('true')
  })

  it('outside a card: the same row, under the page’s own header row, which keeps the menu', async () => {
    await act(async () => root.render(<SearchPerformancePage onTab={() => {}} />))
    await settle()
    const page = container.querySelector<HTMLElement>('[data-seo-search-page]')!
    const [headerRow, row] = Array.from(page.children) as HTMLElement[]
    expect(headerRow.querySelector('h1')!.textContent).toBe('Search performance')
    expect(headerRow.querySelector('[data-seo-search-menu]')).not.toBeNull()
    expect(headerRow.querySelector('[role="radiogroup"]')).toBeNull()
    expect(row.hasAttribute('data-seo-tab-row')).toBe(true)
    expect(row.className).toContain(DETAIL_TAB_ROW)
    expect(row.querySelector('[role="tablist"][aria-label="Search performance"] [data-seo-tab="queries"]')!.getAttribute('aria-selected')).toBe('true')
    expect(row.querySelector('[role="radiogroup"][aria-label="Period"]')).not.toBeNull()
    expect(right.childElementCount).toBe(0)
  })
})
