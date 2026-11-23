// @vitest-environment jsdom
/**
 * Reviews' sub-nav beside the rail (reviews-panel.tsx; docs/plans/github-reviews.md,
 * "Reviews on the app's own list"), as My Actions' is: the sections and the
 * state as rows, lit from where the card says it is (reviews-card-controls.ts),
 * a press moving the card. Registered for `reviews`. Fixtures are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, useSyncExternalStore } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => 'ws-home' }))
vi.mock('@/components/desktop-titlebar', () => ({ useHasTrafficLights: () => false, useIsDesktop: () => false }))
vi.mock('../../side-panels/side-panels', async () => {
  const store = await import('../../side-panels/side-panel-store')
  return {
    PANEL_TOP: '6px',
    SLIDE_CLASS: 'transition-[translate,visibility]',
    SLIDE_STYLE: {},
    useComposerReserve: () => 0,
    useSidePanelState: () => useSyncExternalStore(store.subscribeSidePanels, store.getSidePanelState, store.getServerSidePanelState),
  }
})

import { PAGE_PANELS, PagePanelHost } from '../page-panel'
import { ReviewsPanel } from '../reviews-panel'
import * as store from '../../side-panels/side-panel-store'
import { holdFrontCard } from '@/components/chat-cards/front-card'
import { __resetReviewsCardsForTests, publishReviewsCard, type ReviewsCardControls } from '@/components/chat-cards/reviews-card-controls'
import { CARD_PAGES } from '@/lib/chat-cards/page-menu'
import type { CardSpec } from '@/lib/chat-cards/kinds'
import { __resetSelectedPlaceForTests } from '../../rail/selected-place'

const CARD = 'card-reviews-page'
const reviewsSpec = () => CARD_PAGES.find((p) => p.slug === 'reviews')!.spec(new Date()) as CardSpec

let container: HTMLDivElement
let root: Root
let releases: Array<() => void> = []
const calls: string[] = []

function controls(over: Partial<ReviewsCardControls> = {}): ReviewsCardControls {
  return {
    cardId: CARD,
    section: 'review_requests',
    state: 'open',
    setSection: (s) => calls.push(`section:${s}`),
    setState: (s) => calls.push(`state:${s}`),
    show: () => calls.push('show'),
    ...over,
  }
}

beforeEach(() => {
  calls.length = 0
  releases = []
  window.localStorage.clear()
  __resetSelectedPlaceForTests()
  __resetReviewsCardsForTests()
  store.resetSidePanelStore()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) }) as Response))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  for (const release of releases) act(() => release())
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const flush = async () => {
  for (let i = 0; i < 4; i++) await act(async () => {})
}

function Row() {
  const state = useSyncExternalStore(store.subscribeSidePanels, store.getSidePanelState, store.getServerSidePanelState)
  return <PagePanelHost mode={store.pagePanelWanted(state) ? 'room' : 'off'} />
}

async function openReviews() {
  act(() => {
    releases.push(holdFrontCard({ id: CARD, spec: reviewsSpec(), close: () => {} }))
  })
  await flush()
}

const rows = () => [...container.querySelectorAll<HTMLButtonElement>('[data-reviews-panel-section], [data-reviews-panel-state]')]
const lit = () => rows().filter((r) => r.getAttribute('aria-current') === 'true').map((r) => r.textContent)

describe('the Reviews sub-nav', () => {
  it('is the Reviews page’s registered panel', () => {
    expect(PAGE_PANELS.reviews).toBe(ReviewsPanel)
  })

  it('lists the sections, then the state, from its first commit, the defaults lit', async () => {
    act(() => root.render(<Row />))
    await openReviews()
    expect(container.querySelector('aside[data-page-panel="reviews"]')).not.toBeNull()
    expect(rows().map((r) => r.textContent)).toEqual(['Review requests', 'Authored by me', 'Assigned to me', 'Involves me', 'Open', 'Closed', 'All'])
    expect(lit()).toEqual(['Review requests', 'Open'])
  })

  it('lights the rows from where the card says it is, and its rows move the card', async () => {
    act(() => root.render(<Row />))
    await openReviews()
    act(() => publishReviewsCard(controls({ section: 'authored', state: 'all' })))
    await flush()
    expect(lit()).toEqual(['Authored by me', 'All'])
    act(() => container.querySelector<HTMLButtonElement>('[data-reviews-panel-section="involves"]')!.click())
    act(() => container.querySelector<HTMLButtonElement>('[data-reviews-panel-state="closed"]')!.click())
    await flush()
    expect(calls).toEqual(['section:involves', 'state:closed'])
  })
})
