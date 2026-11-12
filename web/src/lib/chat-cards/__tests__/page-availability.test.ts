/**
 * Availability as a `/` page (Liam, 11-11: "Availability (Right now it's in
 * the settings but it needs to be it's own page under Calendar)"): declared
 * once, found by its words, gated with the calendar, opened by openTarget and
 * by the `?page=` deep link the old settings URL redirects to.
 */
import { describe, expect, it } from 'vitest'
import { getEdition } from '@/lib/editions/manifest'
import { CARD_PAGES, filterPages, pagesFor } from '../page-menu'
import { cardForTarget, pageDeepLink, PAGE_DEEP_LINK_PARAM } from '../open-card'
import { isCardSpec } from '../kinds'

const NOW = new Date('2026-11-11T15:00:00Z')

describe('the Availability page', () => {
  it('is declared once, right after Calendar, opening the availability card', () => {
    const pages = CARD_PAGES.filter((p) => p.slug === 'availability')
    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({ label: 'Availability', kind: 'availability', view: 'calendar' })
    expect(pages[0].personalTool).toBeUndefined()
    expect(CARD_PAGES.map((p) => p.slug).indexOf('availability')).toBe(CARD_PAGES.map((p) => p.slug).indexOf('calendar') + 1)
    expect(pages[0].spec(NOW)).toEqual({ kind: 'availability', title: 'Availability' })
    expect(isCardSpec(pages[0].spec(NOW))).toBe(true)
  })

  it('is offered where the calendar is, and found by its words', () => {
    const offered = pagesFor(getEdition('full'), { desktop: false, now: NOW })
    expect(offered.map((p) => p.slug)).toContain('availability')
    for (const q of ['avail', 'working', 'hours', 'booking', 'find']) expect(filterPages(offered, q).map((p) => p.slug), q).toContain('availability')
    // The calendar's own gate (an edition without the calendar page): Availability goes with it.
    const full = getEdition('full')
    const noCalendar = { ...full, views: full.views.filter((v) => v !== 'calendar'), extraAllowedViews: full.extraAllowedViews.filter((v) => v !== 'calendar') }
    expect(pagesFor(noCalendar, { desktop: false, now: NOW }).map((p) => p.slug)).not.toContain('availability')
  })

  it('opens from anywhere as its card, and has a deep link', () => {
    expect(cardForTarget({ type: 'page', slug: 'availability' }, NOW)).toEqual({ spec: { kind: 'availability', title: 'Availability' } })
    expect(PAGE_DEEP_LINK_PARAM).toBe('page')
    expect(pageDeepLink('availability')).toBe('/account?page=availability')
  })
})
