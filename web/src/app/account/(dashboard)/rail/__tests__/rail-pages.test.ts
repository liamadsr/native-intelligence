/**
 * The app rail's pages (../rail-pages.ts): every `/` page that's on in the
 * workspace (in its words), in four groups with Liam's reference order first,
 * and the icon lit for the card in front.
 */
import { describe, expect, it } from 'vitest'
import { getEdition, withEffectiveSurface } from '@/lib/editions/manifest'
import { CARD_PAGES, pagesFor } from '@/lib/chat-cards/page-menu'
import type { CardSpec } from '@/lib/chat-cards/kinds'
import {
  RAIL_PAGES,
  activeRailItem,
  moveRailPage,
  moveRailPageBy,
  railLayout,
  railPagesFor,
  resetRailPrefs,
  setRailPagePinned,
} from '../rail-pages'

const NOW = new Date(2026, 10, 9, 10, 0)
const full = getEdition('full')
const offered = (edition = full) => railPagesFor(pagesFor(edition, { desktop: false, now: NOW }))

describe('the rail pages', () => {
  it('each opens a `/` page', () => {
    for (const def of RAIL_PAGES) expect(CARD_PAGES.some((p) => p.slug === def.slug), def.slug).toBe(true)
  })

  it('are every `/` page (Liam, 11-09: "all available pages"), so a new page needs its place in the rail', () => {
    for (const page of CARD_PAGES) expect(RAIL_PAGES.some((d) => d.slug === page.slug), page.slug).toBe(true)
  })

  it('keep the reference order first, then the plans, the customers and the agents', () => {
    expect(RAIL_PAGES.map((d) => d.id)).toEqual([
      'docs', 'mail', 'team-chat', 'actions', 'calendar', 'captures',
      'projects', 'initiatives', 'knowledge', 'flows', 'tables',
      'companies', 'contacts', 'deals', 'prospecting', 'sequences', 'campaigns',
      'agents', 'evals', 'teams',
    ])
    // Each group together.
    const groups = RAIL_PAGES.map((d) => d.group)
    expect(groups.filter((g, i) => g !== groups[i - 1])).toEqual(['work', 'plans', 'customers', 'agents'])
  })

  it('offer every page that is on in the full workspace', () => {
    expect(offered().map((p) => p.def.id)).toEqual(pagesFor(full, { desktop: false, now: NOW }).map((p) => p.slug).sort((a, b) => RAIL_PAGES.findIndex((d) => d.slug === a) - RAIL_PAGES.findIndex((d) => d.slug === b)))
  })

  it('leave out a page that is off in the workspace', () => {
    const ids = offered(withEffectiveSurface(full, { email: 'off', crm: 'off', docs: 'off' })).map((p) => p.def.id)
    expect(ids).not.toContain('mail')
    expect(ids).not.toContain('companies')
    expect(ids).not.toContain('contacts')
    expect(ids).not.toContain('deals')
    expect(ids).not.toContain('docs')
    expect(ids).toContain('team-chat')
  })

  it('name a page in the workspace’s words', () => {
    const service = getEdition('service')
    const actions = offered(service).find((p) => p.def.id === 'actions')
    const named = pagesFor(service, { desktop: false, now: NOW }).find((p) => p.slug === 'actions')
    expect(actions?.page.label).toBe(named?.label)
  })
})

describe('the lit icon', () => {
  const pages = offered()
  const list = (entity_type: string): CardSpec => ({ kind: 'list', title: 'x', entity_type, filters: [] }) as CardSpec
  const record = (type: string): CardSpec => ({ kind: 'record', title: 'x', record: { type, id: 'r1' } }) as CardSpec

  it('is Home with no card in front', () => {
    expect(activeRailItem(null, pages)).toBe('home')
  })

  it('is the page a card in front is one of', () => {
    expect(activeRailItem({ kind: 'mail', title: 'Inbox', mail: { folder: 'inbox' } }, pages)).toBe('mail')
    expect(activeRailItem({ kind: 'team_chat', title: 'Team chat' }, pages)).toBe('team-chat')
    expect(activeRailItem({ kind: 'calendar', title: 'This week', calendar: { from: '2026-11-08', to: '2026-11-14', view: 'week' } }, pages)).toBe('calendar')
    expect(activeRailItem({ kind: 'library', title: 'Agents & skills' }, pages)).toBe('agents')
    expect(activeRailItem({ kind: 'bot', title: 'Ada', target: { type: 'bot', id: 'b1' } }, pages)).toBe('agents')
    expect(activeRailItem(list('document'), pages)).toBe('docs')
    expect(activeRailItem(list('action'), pages)).toBe('actions')
    expect(activeRailItem({ kind: 'team_board', title: 'Board', target: { type: 'team', id: 't1' } }, pages)).toBe('actions')
  })

  it('lights Companies, Contacts and Deals each for its own, as lists or records', () => {
    for (const [entity, id] of [['company', 'companies'], ['contact', 'contacts'], ['project', 'projects'], ['initiative', 'initiatives'], ['capture', 'captures']]) {
      expect(activeRailItem(list(entity), pages), entity).toBe(id)
      expect(activeRailItem(record(entity), pages), entity).toBe(id)
    }
    // Deals are the pipelines' page (Tables, phase 7).
    expect(activeRailItem({ kind: 'pipelines', title: 'Deals' }, pages)).toBe('deals')
    expect(activeRailItem({ kind: 'flows', title: 'Flows' }, pages)).toBe('flows')
    expect(activeRailItem(record('action'), pages)).toBe('actions')
    expect(activeRailItem(record('document'), pages)).toBe('docs')
  })

  it('is none for a card no rail page shows', () => {
    expect(activeRailItem({ kind: 'work_item', title: 'A review' } as unknown as CardSpec, pages)).toBeNull()
  })

  it('is none for a page the workspace has off', () => {
    const noMail = offered(withEffectiveSurface(full, { email: 'off' }))
    expect(activeRailItem({ kind: 'mail', title: 'Inbox', mail: { folder: 'inbox' } }, noMail)).toBeNull()
  })
})

describe('the person’s bar (railLayout)', () => {
  const pages = offered()
  const ids = pages.map((p) => p.def.id)
  const shown = (prefs: Parameters<typeof railLayout>[1], from = pages) => railLayout(from, prefs).shown.map((p) => p.def.id)
  const all = (prefs: Parameters<typeof railLayout>[1], from = pages) => railLayout(from, prefs).all.map((p) => p.def.id)

  it('is every page, in the rail’s order, by default', () => {
    expect(ids.length).toBeGreaterThan(10)
    for (const prefs of [null, { order: [], hidden: [] }]) {
      const layout = railLayout(pages, prefs)
      expect(layout.all.map((p) => p.def.id)).toEqual(ids)
      expect(layout.shown.map((p) => p.def.id)).toEqual(ids)
      expect(layout.custom).toBe(false)
    }
  })

  it('stands in the saved order, without the hidden pages (still listed for Customize bar)', () => {
    const order = [...ids].reverse()
    const layout = railLayout(pages, { order, hidden: ['mail', 'deals'] })
    expect(layout.all.map((p) => p.def.id)).toEqual(order)
    expect(layout.shown.map((p) => p.def.id)).toEqual(order.filter((id) => id !== 'mail' && id !== 'deals'))
    expect(layout.custom).toBe(true)
  })

  it('hides pages without making the order custom', () => {
    const layout = railLayout(pages, { order: [], hidden: ['mail'] })
    expect(layout.custom).toBe(false)
    expect(layout.shown.map((p) => p.def.id)).toEqual(ids.filter((id) => id !== 'mail'))
  })

  it('puts a page the prefs don’t mention (new, or just turned on) in its default place, pinned', () => {
    // Saved before Calendar and Captures existed: calendar lands after actions, captures after it.
    const order = ['mail', 'docs', 'team-chat', 'actions', ...ids.filter((id) => !['mail', 'docs', 'team-chat', 'actions', 'calendar', 'captures'].includes(id))]
    expect(all({ order, hidden: [] }).slice(0, 7)).toEqual(['mail', 'docs', 'team-chat', 'actions', 'calendar', 'captures', 'projects'])
    // Each after the page before it by default, wherever that one stands: Docs (first) first, Captures after Calendar.
    const partial = all({ order: ['calendar', 'mail'], hidden: [] })
    expect(partial.slice(0, 3)).toEqual(['docs', 'calendar', 'captures'])
    expect(partial.slice(partial.indexOf('mail'), partial.indexOf('mail') + 3)).toEqual(['mail', 'team-chat', 'actions'])
    expect(partial).toHaveLength(ids.length)
    expect(shown({ order: ['calendar', 'mail'], hidden: [] })).toContain('teams')
  })

  it('skips saved ids the workspace doesn’t offer (a page turned off, one that is gone)', () => {
    const noMail = offered(withEffectiveSurface(full, { email: 'off' }))
    const layout = railLayout(noMail, { order: ['gone-page', 'mail', 'calendar', 'docs'], hidden: ['mail', 'gone-page'] })
    expect(layout.all.map((p) => p.def.id).slice(0, 2)).toEqual(['calendar', 'captures'])
    expect(layout.all).toHaveLength(noMail.length)
    expect(layout.shown).toHaveLength(noMail.length)
    expect(all({ order: ['gone-page', 'mail', 'calendar', 'docs'], hidden: [] }, noMail)).not.toContain('mail')
  })
})

describe('moving, pinning and resetting the bar', () => {
  const ids = offered().map((p) => p.def.id)
  const bar = (prefs: Parameters<typeof railLayout>[1]) => railLayout(offered(), prefs).shown.map((p) => p.def.id)

  it('moves a page to a slot of the bar, the others keeping their order', () => {
    const next = moveRailPage(null, ids, 'calendar', 0)!
    expect(bar(next).slice(0, 3)).toEqual(['calendar', 'docs', 'mail'])
    expect(bar(moveRailPage(next, ids, 'calendar', 2)).slice(0, 4)).toEqual(['docs', 'mail', 'calendar', 'team-chat'])
    // Clamped at the ends; null when nothing moves.
    expect(bar(moveRailPage(null, ids, 'docs', 99)).at(-1)).toBe('docs')
    expect(moveRailPage(null, ids, 'docs', 0)).toBeNull()
    expect(moveRailPage(null, ids, 'docs', -3)).toBeNull()
    expect(moveRailPage(null, ids, 'not-a-page', 0)).toBeNull()
  })

  it('moves up and down by one, past the hidden pages', () => {
    const prefs = { order: [], hidden: ['team-chat'] }
    const next = moveRailPageBy(prefs, ids, 'actions', -1)!
    // Above Mail: Team chat (hidden) is no slot of the bar.
    expect(bar(next).slice(0, 3)).toEqual(['docs', 'actions', 'mail'])
    expect(next.hidden).toEqual(['team-chat'])
    expect(bar(moveRailPageBy(next, ids, 'actions', 1)).slice(0, 3)).toEqual(['docs', 'mail', 'actions'])
    expect(moveRailPageBy(null, ids, 'docs', -1)).toBeNull()
    expect(moveRailPageBy(null, ids, ids.at(-1)!, 1)).toBeNull()
  })

  it('saves the default order as no order, so the hairlines come back', () => {
    const moved = moveRailPage(null, ids, 'mail', 0)!
    expect(moved.order.length).toBeGreaterThan(0)
    const back = moveRailPage(moved, ids, 'mail', 1)!
    expect(back.order).toEqual([])
    expect(railLayout(offered(), back).custom).toBe(false)
  })

  it('keeps a page this workspace doesn’t offer where it was, for the workspace that does', () => {
    const noMail = offered(withEffectiveSurface(full, { email: 'off' })).map((p) => p.def.id)
    const saved = { order: ['calendar', 'mail', 'docs', ...ids.filter((id) => !['calendar', 'mail', 'docs'].includes(id))], hidden: [] }
    const next = moveRailPage(saved, noMail, 'docs', 0)!
    expect(next.order.slice(0, 3)).toEqual(['docs', 'calendar', 'mail'])
  })

  it('pins and unpins a page: its icon only, its place kept', () => {
    const unpinned = setRailPagePinned(null, 'mail', false)!
    expect(unpinned).toEqual({ order: [], hidden: ['mail'] })
    expect(bar(unpinned)).not.toContain('mail')
    expect(setRailPagePinned(unpinned, 'mail', false)).toBeNull()
    const moved = moveRailPage(unpinned, ids, 'calendar', 0)!
    const pinned = setRailPagePinned(moved, 'mail', true)!
    expect(pinned.hidden).toEqual([])
    expect(bar(pinned).slice(0, 3)).toEqual(['calendar', 'docs', 'mail'])
    expect(setRailPagePinned(null, 'mail', true)).toBeNull()
  })

  it('resets to the default bar', () => {
    expect(resetRailPrefs(null)).toBeNull()
    expect(resetRailPrefs({ order: [], hidden: [] })).toBeNull()
    expect(resetRailPrefs({ order: ['mail', 'docs'], hidden: ['deals'] })).toEqual({ order: [], hidden: [] })
  })
})
