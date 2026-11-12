// @vitest-environment jsdom
/**
 * A page group's panel: its sub-nav (page-group-panel.tsx; Liam, 11-11:
 * "Contacts: Companies, Contacts, Deals · Outreach: Prospecting, Sequences,
 * Campaigns · Calendar: Captures"). It holds the slot while a member page's
 * own card is in front (the group selected), a row per member page on here
 * with the current one lit; a row opens its page as the rail does and is
 * remembered as the group's last used. With one member on, no panel at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, useSyncExternalStore } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { getEdition, withEffectiveSurface, type EditionDefinition } from '@/lib/editions/manifest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { edition } = vi.hoisted(() => ({ edition: { current: null as EditionDefinition | null } }))
vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceEdition: () => edition.current }))
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
import { PagePanelToggle } from '../page-panel-toggle'
import * as store from '../../side-panels/side-panel-store'
import { holdFrontCard } from '@/components/chat-cards/front-card'
import { OPEN_CARD_EVENT, type OpenCardRequest } from '@/lib/chat-cards/open-card'
import { CARD_PAGES } from '@/lib/chat-cards/page-menu'
import type { CardSpec } from '@/lib/chat-cards/kinds'
import { KEEP_PLACE_ATTR, __resetSelectedPlaceForTests, selectedPlace } from '../../rail/selected-place'
import { GROUP_LAST_PAGE_KEY, __resetPageGroupsForTests, lastGroupPage } from '../../rail/page-groups'

const ownSpec = (slug: string) => CARD_PAGES.find((p) => p.slug === slug)!.spec(new Date()) as CardSpec

let container: HTMLDivElement
let root: Root
let releases: Array<() => void> = []
const asked: OpenCardRequest[] = []
const listen = (e: Event) => asked.push((e as CustomEvent<OpenCardRequest>).detail)

beforeEach(() => {
  releases = []
  asked.length = 0
  edition.current = getEdition('full')
  window.localStorage.clear()
  __resetSelectedPlaceForTests()
  __resetPageGroupsForTests()
  store.resetSidePanelStore()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ entries: [], next_cursor: null }) }) as Response))
  window.addEventListener(OPEN_CARD_EVENT, listen)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  for (const release of releases) act(() => release())
  act(() => root.unmount())
  container.remove()
  window.removeEventListener(OPEN_CARD_EVENT, listen)
  vi.unstubAllGlobals()
})

const flush = async () => {
  for (let i = 0; i < 4; i++) await act(async () => {})
}

function Row() {
  const state = useSyncExternalStore(store.subscribeSidePanels, store.getSidePanelState, store.getServerSidePanelState)
  return (
    <TooltipProvider>
      <PagePanelToggle />
      <PagePanelHost mode={state.pagePanel ? 'room' : 'off'} />
    </TooltipProvider>
  )
}

async function hold(id: string, spec: CardSpec) {
  act(() => {
    releases.push(holdFrontCard({ id, spec, close: () => {} }))
  })
  await flush()
}

const groupPanel = (group: string) => container.querySelector<HTMLElement>(`[data-page-group-panel="${group}"]`)
const rows = (group: string) => [...(groupPanel(group)?.querySelectorAll<HTMLElement>('[data-page-group-row]') ?? [])].map((r) => r.dataset.pageGroupRow)
const lit = (group: string) => [...(groupPanel(group)?.querySelectorAll<HTMLElement>('[aria-current="true"]') ?? [])].map((r) => r.dataset.pageGroupRow)
const row = (group: string, slug: string) => groupPanel(group)!.querySelector<HTMLButtonElement>(`[data-page-group-row="${slug}"]`)!
const shownGroupPanel = () => container.querySelector<HTMLElement>('aside[data-page-panel-mode="room"]')?.getAttribute('data-page-panel')

describe('a page group’s sub-nav', () => {
  it('is registered for each group', () => {
    for (const group of ['contacts', 'outreach', 'calendar']) expect(PAGE_PANELS[group], group).toBeTypeOf('function')
  })

  it('a member page in front: the group selected, its sub-nav with a row per member, that member lit', async () => {
    act(() => root.render(<Row />))
    await flush()
    await hold('deals-1', ownSpec('deals'))
    expect(selectedPlace()).toBe('contacts')
    expect(shownGroupPanel()).toBe('contacts')
    const aside = container.querySelector<HTMLElement>('aside[data-page-panel="contacts"]')!
    expect(aside.getAttribute('aria-label')).toBe('Contacts')
    expect(rows('contacts')).toEqual(['companies', 'contacts', 'deals'])
    expect(lit('contacts')).toEqual(['deals'])
    // The member's own words and icon; the rows as My Actions' sub-nav's (32px, a plain muted glyph).
    expect(row('contacts', 'companies').textContent).toBe('Companies')
    expect(row('contacts', 'companies').querySelector('svg.lucide-building2, svg.lucide-building-2')).not.toBeNull()
    expect(row('contacts', 'deals').className.split(' ')).toEqual(expect.arrayContaining(['h-8', 'bg-foreground/[0.08]']))
    // A press in it keeps the place.
    expect(groupPanel('contacts')!.hasAttribute(KEEP_PLACE_ATTR)).toBe(true)
    // Its button is named by the group.
    expect(container.querySelector('[data-page-panel-toggle]')!.getAttribute('aria-label')).toBe('Contacts')
  })

  it('a row opens its member page as the rail does, and is remembered as the group’s last used', async () => {
    act(() => root.render(<Row />))
    await flush()
    await hold('deals-1', ownSpec('deals'))
    act(() => row('contacts', 'companies').click())
    expect(asked.map((r) => [r.spec, r.from])).toEqual([[ownSpec('companies'), 'rail']])
    expect(lastGroupPage('contacts')).toBe('companies')
    expect(JSON.parse(window.localStorage.getItem(GROUP_LAST_PAGE_KEY)!)).toEqual({ contacts: 'companies' })
    // The lit row (its card in front): nothing more.
    asked.length = 0
    await hold('companies-1', ownSpec('companies'))
    expect(lit('contacts')).toEqual(['companies'])
    act(() => row('contacts', 'companies').click())
    expect(asked).toEqual([])
  })

  it('under a record opened from inside a member page: still the group’s, the member it came from lit', async () => {
    act(() => root.render(<Row />))
    await flush()
    await hold('seq-1', ownSpec('sequences'))
    expect(shownGroupPanel()).toBe('outreach')
    row('outreach', 'sequences').dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await hold('rec-1', { kind: 'sequences', title: 'Q4 outreach', target: { type: 'sequence', id: 's1', label: 'Q4 outreach' } } as CardSpec)
    expect(selectedPlace()).toBe('outreach')
    expect(lit('outreach')).toEqual(['sequences'])
    // Its row brings the page back.
    act(() => row('outreach', 'sequences').click())
    expect(asked.map((r) => r.spec)).toEqual([ownSpec('sequences')])
  })

  it('Captures in front: Calendar’s sub-nav, Captures lit', async () => {
    act(() => root.render(<Row />))
    await flush()
    await hold('cap-1', ownSpec('captures'))
    expect(shownGroupPanel()).toBe('calendar')
    expect(rows('calendar')).toEqual(['calendar', 'availability', 'captures'])
    expect(lit('calendar')).toEqual(['captures'])
  })

  it('Availability in front (Liam, 11-11: its own page under Calendar): Calendar selected, its sub-nav Calendar, Availability, Captures, Availability lit with its icon', async () => {
    act(() => root.render(<Row />))
    await flush()
    await hold('avail-1', ownSpec('availability'))
    expect(selectedPlace()).toBe('calendar')
    expect(shownGroupPanel()).toBe('calendar')
    expect(rows('calendar')).toEqual(['calendar', 'availability', 'captures'])
    expect(lit('calendar')).toEqual(['availability'])
    expect(row('calendar', 'availability').textContent).toContain('Availability')
    expect(row('calendar', 'availability').querySelector('svg.lucide-calendar-clock')).not.toBeNull()
  })

  it('a record opened from home keeps Home and its Recent panel, not a group’s', async () => {
    act(() => root.render(<Row />))
    await flush()
    await hold('rec-1', { kind: 'record', title: 'Fernhill renewal', record: { type: 'deal', id: 'd1' } } as CardSpec)
    expect(selectedPlace()).toBe('home')
    expect(container.querySelector('aside[data-page-panel="contacts"][data-page-panel-mode="room"]')).toBeNull()
  })

  it('one member on: no sub-nav (nothing to switch between), the slot empty; the group still selected', async () => {
    edition.current = withEffectiveSurface(getEdition('full'), { prospecting: 'off', campaigns: 'off' })
    act(() => root.render(<Row />))
    await flush()
    await hold('seq-1', ownSpec('sequences'))
    expect(selectedPlace()).toBe('outreach')
    expect(groupPanel('outreach')).toBeNull()
    expect(store.getSidePanelState().pagePanel).toBe(false)
    expect(container.querySelector('[data-page-panel-toggle]')).toBeNull()
  })

  it('in the workspace’s words: Contacts is Customers where the edition says so, its sub-nav and its button', async () => {
    edition.current = { ...getEdition('full'), words: getEdition('service').words }
    act(() => root.render(<Row />))
    await flush()
    await hold('contacts-1', ownSpec('contacts'))
    expect(container.querySelector<HTMLElement>('aside[data-page-panel="contacts"]')!.getAttribute('aria-label')).toBe('Customers')
    expect(row('contacts', 'contacts').textContent).toBe('Customers')
    expect(container.querySelector('[data-page-panel-toggle]')!.getAttribute('aria-label')).toBe('Customers')
  })
})

describe('Drive and Agents’ sub-navs (Liam, 11-11: "Drive: Docs, Knowledge, and a new page that shows all available files … Agents: Agents & Skills, Flows, Evals")', () => {
  it('are registered', () => {
    for (const group of ['drive', 'agents']) expect(PAGE_PANELS[group], group).toBeTypeOf('function')
  })

  it('Files in front: Drive selected, its rows Docs, Knowledge, Files with their icons, Files lit; a row opens its page', async () => {
    act(() => root.render(<Row />))
    await flush()
    await hold('files-1', ownSpec('files'))
    expect(selectedPlace()).toBe('drive')
    expect(shownGroupPanel()).toBe('drive')
    expect(container.querySelector<HTMLElement>('aside[data-page-panel="drive"]')!.getAttribute('aria-label')).toBe('Drive')
    expect(rows('drive')).toEqual(['docs', 'knowledge', 'files'])
    expect(lit('drive')).toEqual(['files'])
    expect(row('drive', 'files').textContent).toBe('Files')
    expect(row('drive', 'files').querySelector('svg.lucide-paperclip')).not.toBeNull()
    expect(row('drive', 'knowledge').querySelector('svg.lucide-brain')).not.toBeNull()
    act(() => row('drive', 'knowledge').click())
    expect(asked.map((r) => r.spec)).toEqual([ownSpec('knowledge')])
    expect(lastGroupPage('drive')).toBe('knowledge')
  })

  it('Flows in front: Agents selected, its rows Agents & skills, Flows, Evals, Flows lit', async () => {
    act(() => root.render(<Row />))
    await flush()
    await hold('flows-1', ownSpec('flows'))
    expect(selectedPlace()).toBe('agents')
    expect(shownGroupPanel()).toBe('agents')
    expect(rows('agents')).toEqual(['agents', 'flows', 'evals'])
    expect(lit('agents')).toEqual(['flows'])
    expect(row('agents', 'agents').textContent).toBe('Agents & skills')
    expect(row('agents', 'evals').querySelector('svg.lucide-flask-conical')).not.toBeNull()
  })
})

describe('SEO’s sub-nav (one page per section)', () => {
  it('is registered', () => {
    expect(PAGE_PANELS.seo).toBeTypeOf('function')
  })

  it('Site audit in front: SEO selected, its sections listed in order with Site audit lit', async () => {
    act(() => root.render(<Row />))
    await flush()
    await hold('seo-1', ownSpec('seo-audit'))
    expect(selectedPlace()).toBe('seo')
    expect(shownGroupPanel()).toBe('seo')
    expect(rows('seo')).toEqual(['seo-audit', 'seo-keywords', 'seo-rankings', 'seo-search', 'seo-competitors', 'seo-backlinks', 'seo-ai-visibility', 'seo-local'])
    expect(lit('seo')).toEqual(['seo-audit'])
    // Each row wears its page's own words and icon.
    expect(row('seo', 'seo-audit').textContent).toBe('Site audit')
    expect(row('seo', 'seo-keywords').textContent).toBe('Keywords')
    expect(row('seo', 'seo-ai-visibility').textContent).toBe('AI visibility')
    expect(row('seo', 'seo-rankings').querySelector('svg.lucide-trending-up')).not.toBeNull()
    expect(container.querySelector('[data-page-panel-toggle]')!.getAttribute('aria-label')).toBe('SEO')
  })

  it('another section in front lights its own row', async () => {
    act(() => root.render(<Row />))
    await flush()
    await hold('seo-2', ownSpec('seo-rankings'))
    expect(selectedPlace()).toBe('seo')
    expect(lit('seo')).toEqual(['seo-rankings'])
  })
})

describe('changing pages: the next panel arrives as the search palette does, nothing slides (Liam, 11-11)', () => {
  let animated: Array<{ el: Element; frames: Keyframe[]; options: KeyframeAnimationOptions }>
  const realAnimate = (HTMLElement.prototype as { animate?: unknown }).animate
  beforeEach(() => {
    animated = []
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      writable: true,
      value: function (this: Element, frames: Keyframe[], options: KeyframeAnimationOptions) {
        animated.push({ el: this, frames, options })
        return { cancel() {}, finish() {} } as unknown as Animation
      },
    })
  })
  afterEach(() => {
    if (realAnimate === undefined) delete (HTMLElement.prototype as { animate?: unknown }).animate
    else Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, writable: true, value: realAnimate })
  })

  /** Every class the aside wore, in order, while `run` ran (the swap render settles before the test sees it). */
  async function classesOf(page: string, run: () => Promise<void>): Promise<string[]> {
    const seen: string[] = []
    const isIt = (el: Node) => el instanceof HTMLElement && el.matches(`aside[data-page-panel="${page}"]`)
    // Each change's value before it, then the last: React may render twice in one act, and only the records keep both.
    const watch = new MutationObserver((records) => {
      for (const r of records) if (r.type === 'attributes' && isIt(r.target) && r.oldValue !== null) seen.push(r.oldValue)
    })
    watch.observe(container, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['class'] })
    await run()
    for (const r of watch.takeRecords()) if (r.type === 'attributes' && isIt(r.target) && r.oldValue !== null) seen.push(r.oldValue)
    watch.disconnect()
    const now = container.querySelector<HTMLElement>(`aside[data-page-panel="${page}"]`)
    if (now) seen.push(now.className)
    return seen
  }
  const cardOf = (page: string) => container.querySelector(`aside[data-page-panel="${page}"] [data-page-panel-card]`)
  /** The row as the shell has it: the slot on only while wanted (open, with something to show). */
  function OpenRow() {
    const state = useSyncExternalStore(store.subscribeSidePanels, store.getSidePanelState, store.getServerSidePanelState)
    return (
      <TooltipProvider>
        <PagePanelToggle />
        <PagePanelHost mode={store.pagePanelWanted(state) ? 'room' : 'off'} />
      </TooltipProvider>
    )
  }

  it('one group’s panel to another’s: the leaving one snaps out, the arriving one makes the palette’s entrance once', async () => {
    const { PALETTE_ENTRANCE_EASING, PALETTE_ENTRANCE_FROM, PALETTE_ENTRANCE_MS } = await import('@/lib/motion/palette-entrance')
    act(() => root.render(<OpenRow />))
    await flush()
    await hold('deals-1', ownSpec('deals'))
    expect(shownGroupPanel()).toBe('contacts')
    animated.length = 0
    // What each frame wore when its style was settled (the browser's only look at it between two renders).
    const settled: Array<{ page: string | null; classes: string }> = []
    const realComputed = window.getComputedStyle
    const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
      if (el instanceof HTMLElement && el.matches('aside[data-page-panel]')) settled.push({ page: el.getAttribute('data-page-panel'), classes: el.className })
      return realComputed.call(window, el, pseudo)
    })
    const leaving = await classesOf('contacts', async () => {
      await hold('prospecting-1', ownSpec('prospecting'))
    })
    spy.mockRestore()
    expect(shownGroupPanel()).toBe('outreach')
    // It went without sliding: hidden while transitions were off.
    expect(leaving.some((c) => c.includes('transition-none') && c.includes('invisible'))).toBe(true)
    // And the browser saw it so: each frame's style is settled in that one render, its slide off, at its new place.
    // Without that the slide is back on before the paint, and both panels slide past each other under the entrance
    // (Liam, 11-11: "the over all transition even with the sub-nav needs to be updated to be smoother").
    const gone = settled.find((x) => x.page === 'contacts')
    const come = settled.find((x) => x.page === 'outreach')
    expect(gone?.classes).toContain('transition-none')
    expect(gone?.classes).toContain('invisible')
    expect(come?.classes).toContain('transition-none')
    expect(come?.classes).toContain('translate-x-0')
    // The next one: the palette's entrance on its card, once.
    expect(animated).toHaveLength(1)
    expect(animated[0].el).toBe(cardOf('outreach'))
    expect(animated[0].frames).toEqual([PALETTE_ENTRANCE_FROM, { opacity: 1, transform: 'none' }])
    expect(animated[0].options).toEqual({ duration: PALETTE_ENTRANCE_MS, easing: PALETTE_ENTRANCE_EASING })
    // Settled: its slide back for the next open or close.
    const outreach = container.querySelector<HTMLElement>('aside[data-page-panel="outreach"]')!
    expect(outreach.className).toContain('transition-[translate,visibility]')
    expect(outreach.className).not.toContain('transition-none')
  })

  it('the next group has nothing to show for sure (one member on): no hold, the slot empty at once (Liam, 11-11: the hold is for a panel not known yet)', async () => {
    edition.current = withEffectiveSurface(getEdition('full'), { prospecting: 'off', campaigns: 'off' })
    act(() => root.render(<OpenRow />))
    await flush()
    await hold('deals-1', ownSpec('deals'))
    expect(shownGroupPanel()).toBe('contacts')
    await hold('seq-1', ownSpec('sequences'))
    expect(selectedPlace()).toBe('outreach')
    expect(container.querySelector('aside[data-page-panel-held]')).toBeNull()
    expect(container.querySelector('aside[data-page-panel]:not([data-page-panel-mode="off"])')).toBeNull()
    expect(store.getSidePanelState().pagePanel).toBe(false)
  })

  it('closing and opening on the same page still slide: no entrance, no snap', async () => {
    act(() => root.render(<OpenRow />))
    await flush()
    await hold('deals-1', ownSpec('deals'))
    animated.length = 0
    const closing = await classesOf('contacts', async () => {
      act(() => store.setPagePanelOpen(false))
      await flush()
    })
    expect(shownGroupPanel()).toBeUndefined()
    expect(closing.some((c) => c.includes('transition-none'))).toBe(false)
    const opening = await classesOf('contacts', async () => {
      act(() => store.setPagePanelOpen(true))
      await flush()
    })
    expect(shownGroupPanel()).toBe('contacts')
    expect(opening.some((c) => c.includes('transition-none'))).toBe(false)
    expect(animated).toEqual([])
  })
})
