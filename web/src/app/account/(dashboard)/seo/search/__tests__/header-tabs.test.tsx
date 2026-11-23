// @vitest-environment jsdom
/**
 * Search performance in a card (Liam, 11-23: "all the SEO pages"): its four
 * tabs are a capsule in the card header's right slot, before the period's
 * 24px capsule and the "…" menu, and the page starts with the site's line;
 * outside a card the tabs head the page as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CardHeaderSlotsProvider } from '@/components/chat-cards/card-header-slot'
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

describe('Search performance’s tabs', () => {
  it('in a card: a capsule in the header, before the period’s capsule and the menu; none in the page', async () => {
    const onTab = vi.fn()
    await act(async () => root.render(<CardHeaderSlotsProvider value={{ left: null, right }}><SearchPerformancePage tab="pages" onTab={onTab} /></CardHeaderSlotsProvider>))
    await settle()
    const tabs = right.querySelector<HTMLElement>('[data-seo-tabs="header"]')!
    expect(tabs.getAttribute('role')).toBe('tablist')
    expect(tabs.className).toContain('h-6')
    expect(Array.from(tabs.querySelectorAll('[role="tab"]')).map((t) => [t.getAttribute('data-seo-tab'), t.getAttribute('aria-selected')])).toEqual([
      ['queries', 'false'],
      ['pages', 'true'],
      ['opportunities', 'false'],
      ['analytics', 'false'],
    ])
    const period = right.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Period"]')!
    expect(period.className).toContain('h-6')
    expect(period.querySelector('[data-seo-filter="last_28_days"]')!.getAttribute('aria-checked')).toBe('true')
    const more = right.querySelector('[data-seo-search-menu]')!
    expect(tabs.compareDocumentPosition(period) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(period.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(container.querySelector('[role="tablist"], [data-seo-tab]')).toBeNull()
    expect(container.querySelector('[data-seo-search-site]')).not.toBeNull()
    await act(async () => tabs.querySelector<HTMLButtonElement>('[data-seo-tab="opportunities"]')!.click())
    expect(onTab).toHaveBeenCalledWith('opportunities')
  })

  it('outside a card: the tabs head the page, as before', async () => {
    await act(async () => root.render(<SearchPerformancePage onTab={() => {}} />))
    await settle()
    expect(container.querySelector('[role="tablist"][aria-label="Search performance"] [data-seo-tab="queries"]')).not.toBeNull()
    expect(container.querySelector('[data-seo-tabs="header"]')).toBeNull()
    expect(right.childElementCount).toBe(0)
  })
})
