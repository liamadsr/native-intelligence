/**
 * The Studio as a page card (./pages.ts, migration 620): the agent opens it
 * with `show` (unlike Files), on one video (on one of its tabs) or one Studio
 * project; the `/` menu and the rail offer it where its feature is on; a chip
 * or a card's Open in Studio opens it on a video. Made-up ids.
 */
import { describe, expect, it } from 'vitest'
import { getEdition, withEffectiveSurface } from '@/lib/editions/manifest'
import { PAGE_KINDS, SHOW_PAGE_KIND_NAMES, isPageCardSpec, pageTab } from '../pages'
import { normalizePageInput } from '../page-validate'
import { cardForTarget, studioVideoLink } from '../open-card'
import { CARD_PAGES, pagesFor } from '../page-menu'

const VIDEO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('the Studio page card', () => {
  it('is a page the agent may show, on a video or a Studio project, with a video’s tabs', () => {
    expect(SHOW_PAGE_KIND_NAMES).toContain('studio')
    expect(PAGE_KINDS.studio).toMatchObject({ view: 'studio', target: { types: ['studio_video', 'studio_project'] }, tabs: ['overview', 'storyboard', 'cast', 'edit'] })
    expect(isPageCardSpec({ kind: 'studio', title: 'Studio' })).toBe(true)
    expect(isPageCardSpec({ kind: 'studio', title: 'Teaser', target: { type: 'studio_video', id: VIDEO }, tab: 'edit' })).toBe(true)
    expect(isPageCardSpec({ kind: 'studio', title: 'Teaser', target: { type: 'team', id: VIDEO } })).toBe(false)
    expect(pageTab('studio', undefined)).toBe('overview')
  })

  it('show checks a target by name or id, and a video’s tab needs a video', () => {
    expect(normalizePageInput({ kind: 'studio', title: 'Spring teaser', target: 'Spring teaser', tab: 'Storyboard' })).toEqual({
      ok: true,
      value: { kind: 'studio', title: 'Spring teaser', target: 'Spring teaser', tab: 'storyboard' },
    })
    expect(normalizePageInput({ kind: 'studio', title: 'Studio', tab: 'edit' })).toMatchObject({ ok: false, error: expect.stringContaining("is a view of one video") })
    expect(normalizePageInput({ kind: 'studio', title: 'Studio', tab: 'overview' })).toEqual({ ok: true, value: { kind: 'studio', title: 'Studio' } })
  })

  it('opens on a video (and its tab) from a chip, a card or its link', () => {
    expect(cardForTarget({ type: 'studio_video', id: VIDEO, title: 'Spring teaser', tab: 'edit' })).toEqual({
      spec: { kind: 'studio', title: 'Spring teaser', target: { type: 'studio_video', id: VIDEO, label: 'Spring teaser' }, tab: 'edit' },
    })
    expect(cardForTarget({ type: 'studio_project', id: VIDEO, title: 'Fernhill spring', tab: 'edit' })?.spec).toEqual({
      kind: 'studio',
      title: 'Fernhill spring',
      target: { type: 'studio_project', id: VIDEO, label: 'Fernhill spring' },
    })
    expect(studioVideoLink(VIDEO)).toBe(`/account?page=studio&video=${VIDEO}`)
  })

  it('is a `/` page wherever Studio is on, and nowhere it is off', () => {
    const page = CARD_PAGES.find((p) => p.slug === 'studio')
    expect(page).toMatchObject({ label: 'Studio', description: 'Videos and ads', kind: 'studio', view: 'studio' })
    expect(page?.keywords).toEqual(expect.arrayContaining(['video', 'ads', 'editor', 'storyboard', 'script']))
    const full = getEdition('full')
    expect(pagesFor(full, { desktop: false }).map((p) => p.slug)).toContain('studio')
    expect(pagesFor(withEffectiveSurface(full, { studio: 'off' }), { desktop: false }).map((p) => p.slug)).not.toContain('studio')
  })
})
