/**
 * The app rail's pages (../rail-pages.ts): every `/` page that's on in the
 * workspace (in its words), in four groups with Liam's reference order first,
 * and the selected place (Liam, 11-11): a page only when its own card comes
 * in front or the person moves inside it; Home for anything opened from home.
 */
import { describe, expect, it } from 'vitest'
import { getEdition, withEffectiveSurface } from '@/lib/editions/manifest'
import { CARD_PAGES, pagesFor } from '@/lib/chat-cards/page-menu'
import type { CardSpec } from '@/lib/chat-cards/kinds'
import {
  NESTED_RAIL_PAGES,
  RAIL_PAGES,
  activeRailItem,
  moveRailPage,
  nestedPageOpen,
  nextSelectedPlace,
  pageOfCard,
  moveRailPageBy,
  ownPageOfCard,
  railLayout,
  railPagesFor,
  resetRailPrefs,
  setRailPagePinned,
} from '../rail-pages'
import { GROUP_OF_PAGE, PAGE_GROUPS, __resetPageGroupsForTests, groupOpenSlug, lastGroupPage, rememberGroupPage } from '../page-groups'

const NOW = new Date(2026, 10, 9, 10, 0)
const full = getEdition('full')
const offered = (edition = full) => railPagesFor(pagesFor(edition, { desktop: false, now: NOW }))

describe('the rail pages', () => {
  it('each opens a `/` page', () => {
    for (const def of RAIL_PAGES) expect(CARD_PAGES.some((p) => p.slug === def.slug), def.slug).toBe(true)
  })

  it('are every `/` page (Liam, 11-09: "all available pages"), so a new page needs its place in the rail: on the bar, or nested under a rail page', () => {
    for (const page of CARD_PAGES) {
      const placed = RAIL_PAGES.some((d) => d.slug === page.slug || !!d.members?.includes(page.slug)) || Object.hasOwn(NESTED_RAIL_PAGES, page.slug)
      expect(placed, page.slug).toBe(true)
    }
  })

  it('nest Projects and Initiatives under My Actions (Liam, 11-11: "Yes, nest them"): no icons of their own, a parent on the bar', () => {
    // Liam, 11-11: "Teams should be under action items".
    expect(NESTED_RAIL_PAGES).toEqual({ projects: 'actions', initiatives: 'actions', teams: 'actions' })
    for (const [slug, parent] of Object.entries(NESTED_RAIL_PAGES)) {
      expect(CARD_PAGES.some((p) => p.slug === slug), slug).toBe(true)
      expect(RAIL_PAGES.some((d) => d.slug === slug), slug).toBe(false)
      expect(RAIL_PAGES.some((d) => d.id === parent), parent).toBe(true)
    }
    expect(offered().map((p) => p.def.id)).not.toContain('projects')
    expect(offered().map((p) => p.def.id)).not.toContain('initiatives')
    expect(offered().map((p) => p.def.id)).not.toContain('teams')
  })

  it('keep the reference order first, then the customers and the agents (Liam, 11-11: Drive and Agents took the plans section’s pages)', () => {
    expect(RAIL_PAGES.map((d) => d.id)).toEqual([
      'drive', 'mail', 'team-chat', 'actions', 'calendar',
      'contacts', 'outreach', 'seo',
      'agents',
    ])
    // Liam, 11-13: the Studio is one of Outreach's pages, no icon of its own.
    expect(RAIL_PAGES.map((d) => d.id)).not.toContain('studio')
    // Each group together, and no section left empty.
    const groups = RAIL_PAGES.map((d) => d.group)
    expect(groups.filter((g, i) => g !== groups[i - 1])).toEqual(['work', 'customers', 'agents'])
  })

  it('offer every page that is on in the full workspace, but the nested ones, each group once', () => {
    expect(offered().map((p) => p.def.id)).toEqual(RAIL_PAGES.map((d) => d.id))
    const onSlugs = new Set(pagesFor(full, { desktop: false, now: NOW }).map((p) => p.slug))
    const reached = offered().flatMap((p) => (p.members ?? [p.page]).map((m) => m.slug))
    expect(reached.sort()).toEqual([...onSlugs].filter((slug) => !Object.hasOwn(NESTED_RAIL_PAGES, slug)).sort())
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

  it('leave out the Studio for a guest of the workspace (its routes refuse a guest), and nothing else', () => {
    const forGuest = railPagesFor(pagesFor(full, { desktop: false, now: NOW, guest: true }))
    const members = (pages: ReturnType<typeof railPagesFor>, id: string) => pages.find((p) => p.def.id === id)!.members!.map((m) => m.slug)
    expect(members(offered(), 'outreach')).toEqual(['prospecting', 'sequences', 'campaigns', 'studio'])
    // Outreach stays for a guest, without its Studio row; every other icon as for a member.
    expect(members(forGuest, 'outreach')).toEqual(['prospecting', 'sequences', 'campaigns'])
    expect(forGuest.map((p) => p.def.id)).toEqual(offered().map((p) => p.def.id))
  })

  it('name a page in the workspace’s words', () => {
    const service = getEdition('service')
    const actions = offered(service).find((p) => p.def.id === 'actions')
    const named = pagesFor(service, { desktop: false, now: NOW }).find((p) => p.slug === 'actions')
    expect(actions?.page.label).toBe(named?.label)
  })
})

describe('the selected place', () => {
  const pages = offered()
  const list = (entity_type: string): CardSpec => ({ kind: 'list', title: 'x', entity_type, filters: [] }) as CardSpec
  const record = (type: string): CardSpec => ({ kind: 'record', title: 'x', record: { type, id: 'r1' } }) as CardSpec
  /** Each page's own card, as the rail, `/` and Search open it. */
  const own = (slug: string) => pages.find((p) => p.page.slug === slug)!.page.spec(NOW)

  it('knows every page’s own card, as the rail, `/` and Search open it (in the workspace’s words too)', () => {
    for (const { def, page } of pages) expect(pageOfCard(page.spec(NOW), NOW), def.id).toBe(def.id)
    for (const { def, page } of offered(getEdition('service'))) expect(pageOfCard(page.spec(NOW), NOW), def.id).toBe(def.id)
    // A group member's own card: its group (Liam, 11-11: page groups).
    for (const { def, members } of pages) for (const m of members ?? []) expect(ownPageOfCard(m.spec(NOW), NOW), m.slug).toEqual({ id: def.id, slug: m.slug })
    // The calendar opened another week is still the page.
    expect(pageOfCard({ kind: 'calendar', title: 'This week', calendar: { from: '2026-11-15', to: '2026-11-21', view: 'week' } }, NOW)).toBe('calendar')
  })

  it('knows no page in an artifact opened from home: a record, an event on its day, a thread, a place inside a page', () => {
    for (const type of ['action', 'document', 'capture', 'project', 'contact', 'company', 'deal', 'initiative']) expect(pageOfCard(record(type), NOW), type).toBeNull()
    expect(pageOfCard({ kind: 'calendar', title: 'Standup', calendar: { from: '2026-11-10', to: '2026-11-10', view: 'day' } }, NOW)).toBeNull()
    expect(pageOfCard({ kind: 'mail', title: 'Thread', mail: { folder: 'inbox', thread_id: 't1' } }, NOW)).toBeNull()
    expect(pageOfCard({ kind: 'sequences', title: 'Q4 outreach', target: { type: 'sequence', id: 's1', label: 'Q4 outreach' } } as CardSpec, NOW)).toBeNull()
    expect(pageOfCard({ kind: 'team_board', title: 'Board', target: { type: 'team', id: 't1' } } as CardSpec, NOW)).toBeNull()
    expect(pageOfCard({ kind: 'bot', title: 'Ada', target: { type: 'bot', id: 'b1' } } as CardSpec, NOW)).toBeNull()
    // A narrower list the agent showed is not the page.
    expect(pageOfCard({ ...list('action'), filters: [{ field: 'priority', operator: 'is', value: 1 }] } as CardSpec, NOW)).toBeNull()
    expect(pageOfCard(list('document'), NOW)).toBe('drive')
  })

  it('is Home with nothing in front, and a page when its own card comes in front', () => {
    expect(nextSelectedPlace({ place: 'calendar', frontId: 'c1' }, null, false, NOW)).toBe('home')
    expect(nextSelectedPlace({ place: 'home', frontId: null }, { id: 'c1', spec: own('calendar') }, false, NOW)).toBe('calendar')
    // From inside another page too (a link to it): that page.
    expect(nextSelectedPlace({ place: 'flows', frontId: 'p1' }, { id: 'c2', spec: own('actions') }, true, NOW)).toBe('actions')
  })

  it('stays Home for an artifact opened from home (the Recent panel, a chip, Search, a notification)', () => {
    expect(nextSelectedPlace({ place: 'home', frontId: null }, { id: 'r1', spec: record('action') }, false, NOW)).toBe('home')
    // One opened from home over a page: home again.
    expect(nextSelectedPlace({ place: 'actions', frontId: 'a1' }, { id: 'r1', spec: record('action') }, false, NOW)).toBe('home')
    // Inside a record opened from home: still home.
    expect(nextSelectedPlace({ place: 'home', frontId: 'r1' }, { id: 'r2', spec: record('project') }, true, NOW)).toBe('home')
  })

  it('keeps the page for a record opened from inside it, and for the same card in front again', () => {
    expect(nextSelectedPlace({ place: 'actions', frontId: 'a1' }, { id: 'r1', spec: record('project') }, true, NOW)).toBe('actions')
    expect(nextSelectedPlace({ place: 'actions', frontId: 'r1' }, { id: 'r1', spec: record('project') }, false, NOW)).toBe('actions')
  })

  it('lights Home or the page selected, and nothing for a page the workspace has off', () => {
    expect(activeRailItem('home', pages)).toBe('home')
    expect(activeRailItem('mail', pages)).toBe('mail')
    expect(activeRailItem('actions', pages)).toBe('actions')
    const noMail = offered(withEffectiveSurface(full, { email: 'off' }))
    expect(activeRailItem('mail', noMail)).toBeNull()
  })
})

describe('the person’s bar (railLayout)', () => {
  const pages = offered()
  const ids = pages.map((p) => p.def.id)
  const shown = (prefs: Parameters<typeof railLayout>[1], from = pages) => railLayout(from, prefs).shown.map((p) => p.def.id)
  const all = (prefs: Parameters<typeof railLayout>[1], from = pages) => railLayout(from, prefs).all.map((p) => p.def.id)

  it('is every page, in the rail’s order, by default', () => {
    expect(ids.length).toBeGreaterThan(7)
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
    const order = ['mail', 'drive', 'team-chat', 'actions', ...ids.filter((id) => !['mail', 'drive', 'team-chat', 'actions', 'calendar', 'captures'].includes(id))]
    expect(all({ order, hidden: [] }).slice(0, 6)).toEqual(['mail', 'drive', 'team-chat', 'actions', 'calendar', 'contacts'])
    // Each after the page before it by default, wherever that one stands: Drive (first) first, Contacts after Calendar.
    const partial = all({ order: ['calendar', 'mail'], hidden: [] })
    expect(partial.slice(0, 3)).toEqual(['drive', 'calendar', 'contacts'])
    expect(partial.slice(partial.indexOf('mail'), partial.indexOf('mail') + 3)).toEqual(['mail', 'team-chat', 'actions'])
    expect(partial).toHaveLength(ids.length)
    expect(shown({ order: ['calendar', 'mail'], hidden: [] })).toContain('agents')
  })

  it('skips saved ids the workspace doesn’t offer (a page turned off, one that is gone)', () => {
    const noMail = offered(withEffectiveSurface(full, { email: 'off' }))
    const layout = railLayout(noMail, { order: ['gone-page', 'mail', 'calendar', 'docs'], hidden: ['mail', 'gone-page'] })
    expect(layout.all.map((p) => p.def.id).slice(0, 2)).toEqual(['calendar', 'contacts'])
    expect(layout.all).toHaveLength(noMail.length)
    expect(layout.shown).toHaveLength(noMail.length)
    expect(all({ order: ['gone-page', 'mail', 'calendar', 'docs'], hidden: [] }, noMail)).not.toContain('mail')
  })
})

describe('a bar saved while Projects and Initiatives had icons (Liam, 11-11: they nest under Tasks)', () => {
  const pages = offered()
  const ids = pages.map((p) => p.def.id)
  const old = { order: ['calendar', 'projects', 'drive', 'initiatives', ...ids.filter((id) => id !== 'calendar' && id !== 'drive')], hidden: ['projects', 'mail'] }

  it('loads: their ids are skipped, the rest stands in the saved order', () => {
    const layout = railLayout(pages, old)
    expect(layout.all.map((p) => p.def.id)).toEqual(['calendar', 'drive', ...ids.filter((id) => id !== 'calendar' && id !== 'drive')])
    expect(layout.shown.map((p) => p.def.id)).not.toContain('mail')
    expect(layout.all.map((p) => p.def.id)).not.toContain('projects')
    // Saved in the old default order: each group where its first member stood
    // (Flows, now in Agents, stood after Calendar), the rest in that order.
    const oldDefault = [
      'docs', 'mail', 'team-chat', 'actions', 'calendar', 'captures', 'projects', 'initiatives',
      'knowledge', 'flows', 'companies', 'contacts', 'deals', 'prospecting', 'sequences', 'campaigns', 'agents', 'evals', 'teams',
    ]
    // SEO is newer than that order: it takes its default place (after Outreach).
    expect(railLayout(pages, { order: oldDefault, hidden: [] }).all.map((p) => p.def.id)).toEqual(['drive', 'mail', 'team-chat', 'actions', 'calendar', 'agents', 'contacts', 'outreach', 'seo'])
    // Teams had an icon too (Liam, 11-11: it nests under My Actions now): its id is skipped, shown or hidden.
    expect(railLayout(pages, { order: oldDefault, hidden: ['teams'] }).shown.map((p) => p.def.id)).not.toContain('teams')
    expect(railLayout(pages, { order: oldDefault, hidden: ['teams'] }).shown).toHaveLength(pages.length)
  })

  it('drops their ids at the next save (a move, a pin)', () => {
    const moved = moveRailPage(old, ids, 'agents', 0)!
    expect(moved.order).not.toContain('projects')
    expect(moved.order).not.toContain('initiatives')
    expect(moved.hidden).toEqual(['mail'])
    const pinned = setRailPagePinned(old, 'mail', true)!
    expect(pinned.order).not.toContain('projects')
    expect(pinned.order).not.toContain('initiatives')
    expect(pinned.hidden).toEqual([])
  })
})

describe('opening a nested page (Liam, 11-11: Projects and Initiatives nest under Tasks)', () => {
  const pagesOf = (edition = full) => pagesFor(edition, { desktop: false, now: NOW })
  const own = (slug: string, edition = full) => pagesOf(edition).find((p) => p.slug === slug)!.spec(NOW)

  it('opens My Actions’ own card on the page’s place inside it, so My Actions is the page selected', () => {
    for (const [slug, place] of [['projects', 'projects'], ['initiatives', 'initiatives'], ['teams', 'teams']] as const) {
      const opened = nestedPageOpen(own(slug), pagesOf(), NOW)
      expect(opened, slug).toEqual({ spec: own('actions'), place })
      expect(pageOfCard(opened!.spec, NOW)).toBe('actions')
      expect(nextSelectedPlace({ place: 'home', frontId: null }, { id: 'a1', spec: opened!.spec }, false, NOW)).toBe('actions')
    }
    // In the workspace's words too (the list's title is the edition's).
    const service = getEdition('service')
    if (pagesOf(service).some((p) => p.slug === 'projects')) {
      expect(nestedPageOpen(own('projects', service), pagesOf(service), NOW)?.spec).toEqual(own('actions', service))
    }
  })

  it('leaves every other card as it is: other pages, a narrower list the agent showed, a record', () => {
    for (const page of pagesOf()) if (!Object.hasOwn(NESTED_RAIL_PAGES, page.slug)) expect(nestedPageOpen(page.spec(NOW), pagesOf(), NOW), page.slug).toBeNull()
    const narrower = { kind: 'list', title: 'Projects', entity_type: 'project', filters: [{ field: 'lead_id', operator: 'is', value: '@me' }] } as CardSpec
    expect(nestedPageOpen(narrower, pagesOf(), NOW)).toBeNull()
    expect(nestedPageOpen({ kind: 'record', title: 'x', record: { type: 'project', id: 'p1' } } as CardSpec, pagesOf(), NOW)).toBeNull()
    // Teams opened on one team (a notification about it), and a team's board: their own cards, as before.
    expect(nestedPageOpen({ kind: 'teams', title: 'Core', target: { type: 'team', id: 't1', label: 'Core' } } as CardSpec, pagesOf(), NOW)).toBeNull()
    expect(nestedPageOpen({ kind: 'team_board', title: 'Core', target: { type: 'team', id: 't1', label: 'Core' } } as CardSpec, pagesOf(), NOW)).toBeNull()
  })

  it('opens the page on its own where My Actions is off (no rail icon to light: Home stays)', () => {
    const noActions = pagesOf().filter((p) => p.slug !== 'actions')
    expect(nestedPageOpen(own('projects'), noActions, NOW)).toBeNull()
    expect(pageOfCard(own('projects'), NOW)).toBeNull()
    expect(nestedPageOpen(own('teams'), noActions, NOW)).toBeNull()
    expect(pageOfCard(own('teams'), NOW)).toBeNull()
    // And where the page itself is off, nothing is redirected to it.
    expect(nestedPageOpen(own('projects'), pagesOf().filter((p) => p.slug !== 'projects'), NOW)).toBeNull()
  })
})

describe('moving, pinning and resetting the bar', () => {
  const ids = offered().map((p) => p.def.id)
  const bar = (prefs: Parameters<typeof railLayout>[1]) => railLayout(offered(), prefs).shown.map((p) => p.def.id)

  it('moves a page to a slot of the bar, the others keeping their order', () => {
    const next = moveRailPage(null, ids, 'calendar', 0)!
    expect(bar(next).slice(0, 3)).toEqual(['calendar', 'drive', 'mail'])
    expect(bar(moveRailPage(next, ids, 'calendar', 2)).slice(0, 4)).toEqual(['drive', 'mail', 'calendar', 'team-chat'])
    // Clamped at the ends; null when nothing moves.
    expect(bar(moveRailPage(null, ids, 'drive', 99)).at(-1)).toBe('drive')
    expect(moveRailPage(null, ids, 'drive', 0)).toBeNull()
    expect(moveRailPage(null, ids, 'drive', -3)).toBeNull()
    expect(moveRailPage(null, ids, 'not-a-page', 0)).toBeNull()
  })

  it('moves up and down by one, past the hidden pages', () => {
    const prefs = { order: [], hidden: ['team-chat'] }
    const next = moveRailPageBy(prefs, ids, 'actions', -1)!
    // Above Mail: Team chat (hidden) is no slot of the bar.
    expect(bar(next).slice(0, 3)).toEqual(['drive', 'actions', 'mail'])
    expect(next.hidden).toEqual(['team-chat'])
    expect(bar(moveRailPageBy(next, ids, 'actions', 1)).slice(0, 3)).toEqual(['drive', 'mail', 'actions'])
    expect(moveRailPageBy(null, ids, 'drive', -1)).toBeNull()
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
    const saved = { order: ['calendar', 'mail', 'drive', ...ids.filter((id) => !['calendar', 'mail', 'drive'].includes(id))], hidden: [] }
    const next = moveRailPage(saved, noMail, 'drive', 0)!
    expect(next.order.slice(0, 3)).toEqual(['drive', 'calendar', 'mail'])
  })

  it('pins and unpins a page: its icon only, its place kept', () => {
    const unpinned = setRailPagePinned(null, 'mail', false)!
    expect(unpinned).toEqual({ order: [], hidden: ['mail'] })
    expect(bar(unpinned)).not.toContain('mail')
    expect(setRailPagePinned(unpinned, 'mail', false)).toBeNull()
    const moved = moveRailPage(unpinned, ids, 'calendar', 0)!
    const pinned = setRailPagePinned(moved, 'mail', true)!
    expect(pinned.hidden).toEqual([])
    expect(bar(pinned).slice(0, 3)).toEqual(['calendar', 'drive', 'mail'])
    expect(setRailPagePinned(null, 'mail', true)).toBeNull()
  })

  it('resets to the default bar', () => {
    expect(resetRailPrefs(null)).toBeNull()
    expect(resetRailPrefs({ order: [], hidden: [] })).toBeNull()
    expect(resetRailPrefs({ order: ['mail', 'docs'], hidden: ['deals'] })).toEqual({ order: [], hidden: [] })
  })
})

describe('page groups (Liam, 11-11: "Contacts: Companies, Contacts, Deals · Outreach: Prospecting, Sequences, Campaigns · Calendar: Captures")', () => {
  const pagesOf = (edition = full) => pagesFor(edition, { desktop: false, now: NOW })
  const own = (slug: string) => pagesOf().find((p) => p.slug === slug)!.spec(NOW)
  const record = (type: string): CardSpec => ({ kind: 'record', title: 'x', record: { type, id: 'r1' } }) as CardSpec

  it('are declared once, members in Liam’s order, each with its default', () => {
    expect(Object.values(PAGE_GROUPS).map((g) => [g.id, g.label, g.members, g.defaultMember])).toEqual([
      ['contacts', 'Contacts', ['companies', 'contacts', 'deals'], 'contacts'],
      // Liam, 11-13: the Studio is "part of the outreach page", after Campaigns.
      ['outreach', 'Outreach', ['prospecting', 'sequences', 'campaigns', 'studio'], 'prospecting'],
      ['seo', 'SEO', ['seo-audit', 'seo-keywords', 'seo-rankings', 'seo-search', 'seo-competitors', 'seo-backlinks', 'seo-ai-visibility', 'seo-local'], 'seo-audit'],
      ['calendar', 'Calendar', ['calendar', 'availability', 'captures'], 'calendar'],
      ['drive', 'Drive', ['docs', 'knowledge', 'files', 'tables'], 'docs'],
      ['agents', 'Agents', ['agents', 'flows', 'evals'], 'agents'],
    ])
    for (const g of Object.values(PAGE_GROUPS)) {
      expect(g.members).toContain(g.defaultMember)
      for (const slug of g.members) expect(CARD_PAGES.some((p) => p.slug === slug), slug).toBe(true)
    }
  })

  it('put one icon per group on the rail, in its first member’s place, and none for the members', () => {
    const ids = offered().map((p) => p.def.id)
    for (const slug of GROUP_OF_PAGE.keys()) if (!Object.hasOwn(PAGE_GROUPS, slug)) expect(ids, slug).not.toContain(slug)
    const contacts = offered().find((p) => p.def.id === 'contacts')!
    expect(contacts.label).toBe('Contacts')
    expect(contacts.page.slug).toBe('contacts')
    expect(contacts.members!.map((m) => m.slug)).toEqual(['companies', 'contacts', 'deals'])
    expect(offered().find((p) => p.def.id === 'outreach')!.label).toBe('Outreach')
    expect(offered().find((p) => p.def.id === 'calendar')!.members!.map((m) => m.slug)).toEqual(['calendar', 'availability', 'captures'])
  })

  it('wear a member’s name in the workspace’s words (Contacts is Customers in a service business)', () => {
    const serviceWords = { ...full, words: getEdition('service').words }
    expect(offered(serviceWords).find((p) => p.def.id === 'contacts')!.label).toBe('Customers')
    expect(offered(serviceWords).find((p) => p.def.id === 'calendar')!.label).toBe('Calendar')
  })

  it('with one member on: the icon opens it (no sub-nav); with none: no icon', () => {
    const one = railPagesFor(pagesOf().filter((p) => p.slug !== 'companies' && p.slug !== 'deals'))
    const contacts = one.find((p) => p.def.id === 'contacts')!
    expect(contacts.members!.map((m) => m.slug)).toEqual(['contacts'])
    expect(contacts.page.slug).toBe('contacts')
    // The default off, one other on: that one.
    const outreach = railPagesFor(pagesOf().filter((p) => p.slug !== 'prospecting' && p.slug !== 'campaigns')).find((p) => p.def.id === 'outreach')!
    expect(outreach.page.slug).toBe('sequences')
    expect(railPagesFor(pagesOf().filter((p) => !PAGE_GROUPS.outreach.members.includes(p.slug))).map((p) => p.def.id)).not.toContain('outreach')
  })

  it('select the group for any member page’s own card (`/`, Search, a link: no redirect); a record from inside keeps it, one from home stays Home', () => {
    for (const [slug, group] of [['deals', 'contacts'], ['companies', 'contacts'], ['contacts', 'contacts'], ['sequences', 'outreach'], ['campaigns', 'outreach'], ['studio', 'outreach'], ['captures', 'calendar'], ['calendar', 'calendar'], ['availability', 'calendar']] as const) {
      expect(pageOfCard(own(slug), NOW), slug).toBe(group)
      expect(nextSelectedPlace({ place: 'home', frontId: null }, { id: slug, spec: own(slug) }, false, NOW), slug).toBe(group)
    }
    expect(activeRailItem('contacts', offered())).toBe('contacts')
    // A deal opened from the Deals page: Contacts kept.
    expect(nextSelectedPlace({ place: 'contacts', frontId: 'deals' }, { id: 'r1', spec: record('deal') }, true, NOW)).toBe('contacts')
    // A deal opened from home (the Recent panel): Home.
    expect(nextSelectedPlace({ place: 'home', frontId: null }, { id: 'r1', spec: record('deal') }, false, NOW)).toBe('home')
  })

  it('open the member last used on this device, else the default, else the first member on', () => {
    __resetPageGroupsForTests()
    expect(lastGroupPage('contacts')).toBeNull()
    expect(groupOpenSlug('contacts', ['companies', 'contacts', 'deals'])).toBe('contacts')
    expect(groupOpenSlug('outreach', ['sequences', 'campaigns'])).toBe('sequences')
    rememberGroupPage('deals')
    rememberGroupPage('mail')
    expect(lastGroupPage('contacts')).toBe('deals')
    expect(groupOpenSlug('contacts', ['companies', 'contacts', 'deals'])).toBe('deals')
    // The last used turned off here: the default.
    expect(groupOpenSlug('contacts', ['companies', 'contacts'])).toBe('contacts')
    expect(groupOpenSlug('calendar', [])).toBeNull()
    __resetPageGroupsForTests()
  })
})

describe('a bar saved before the page groups (Liam, 11-11)', () => {
  const pages = offered()
  const ids = pages.map((p) => p.def.id)
  const all = (prefs: Parameters<typeof railLayout>[1]) => railLayout(pages, prefs).all.map((p) => p.def.id)
  const shown = (prefs: Parameters<typeof railLayout>[1]) => railLayout(pages, prefs).shown.map((p) => p.def.id)

  it('loads: a group stands where the first of its members’ ids was saved, the others dropped', () => {
    const saved = ['contacts', 'mail', 'drive', 'calendar', 'outreach']
    const loaded = all({ order: ['deals', 'mail', 'contacts', 'companies', 'docs', 'captures', 'sequences'], hidden: [] })
    expect(loaded.filter((id) => saved.includes(id))).toEqual(saved)
    expect(loaded[0]).toBe('contacts')
    expect(all({ order: ['campaigns', 'docs'], hidden: [] })[0]).toBe('outreach')
    expect(all({ order: ['deals', 'mail'], hidden: [] })).toHaveLength(ids.length)
  })

  it('hides a group only when every one of its members was hidden', () => {
    expect(shown({ order: [], hidden: ['deals'] })).toContain('contacts')
    expect(shown({ order: [], hidden: ['contacts'] })).toContain('contacts')
    expect(shown({ order: [], hidden: ['companies', 'contacts', 'deals'] })).not.toContain('contacts')
    expect(shown({ order: [], hidden: ['captures'] })).toContain('calendar')
    // A bar that hid Calendar before Availability joined it (Liam, 11-11) shows the group again, for its new member.
    expect(shown({ order: [], hidden: ['calendar', 'captures'] })).toContain('calendar')
    expect(shown({ order: [], hidden: ['calendar', 'availability', 'captures', 'prospecting', 'sequences', 'campaigns', 'studio'] })).toEqual(ids.filter((id) => id !== 'calendar' && id !== 'outreach'))
    expect(railLayout(pages, { order: [], hidden: ['deals'] }).custom).toBe(false)
  })

  it('saves a hidden group as all its members, and drops a lone member’s id at the next save', () => {
    expect(setRailPagePinned(null, 'contacts', false)).toEqual({ order: [], hidden: ['companies', 'contacts', 'deals'] })
    expect(setRailPagePinned(null, 'outreach', false)).toEqual({ order: [], hidden: ['prospecting', 'sequences', 'campaigns', 'studio'] })
    expect(setRailPagePinned({ order: [], hidden: ['companies', 'contacts', 'deals'] }, 'contacts', true)).toEqual({ order: [], hidden: [] })
    expect(setRailPagePinned({ order: [], hidden: ['companies', 'contacts', 'deals'] }, 'contacts', false)).toBeNull()
    expect(setRailPagePinned({ order: [], hidden: ['deals'] }, 'mail', false)).toEqual({ order: [], hidden: ['mail'] })
    const moved = moveRailPage({ order: ['deals', 'docs'], hidden: ['calendar', 'availability', 'captures'] }, ids, 'agents', 0)!
    expect(moved.order.slice(0, 3)).toEqual(['agents', 'contacts', 'outreach'])
    expect(moved.order).not.toContain('deals')
    expect(moved.hidden).toEqual(['calendar', 'availability', 'captures'])
    // Moving past a hidden group counts it hidden.
    expect(moveRailPageBy({ order: [], hidden: ['calendar', 'availability', 'captures'] }, ids, 'contacts', -1)!.order.slice(0, 5)).toEqual(['drive', 'mail', 'team-chat', 'contacts', 'actions'])
  })
})

describe('Drive and Agents (Liam, 11-11: "Drive: Docs, Knowledge, and a new page that shows all available files … Agents: Agents & Skills, Flows, Evals")', () => {
  const pagesOf = (edition = full) => pagesFor(edition, { desktop: false, now: NOW })
  const own = (slug: string) => pagesOf().find((p) => p.slug === slug)!.spec(NOW)
  const shown = (prefs: Parameters<typeof railLayout>[1]) => railLayout(offered(), prefs).shown.map((p) => p.def.id)
  const all = (prefs: Parameters<typeof railLayout>[1]) => railLayout(offered(), prefs).all.map((p) => p.def.id)

  it('stand where Docs and Agents & skills stood, their members with no icons of their own', () => {
    const ids = offered().map((p) => p.def.id)
    expect(ids[0]).toBe('drive')
    for (const slug of ['docs', 'knowledge', 'files', 'tables', 'flows', 'evals']) expect(ids, slug).not.toContain(slug)
    const drive = offered().find((p) => p.def.id === 'drive')!
    expect(drive.label).toBe('Drive')
    expect(drive.page.slug).toBe('docs')
    expect(drive.members!.map((m) => m.slug)).toEqual(['docs', 'knowledge', 'files', 'tables'])
    const agents = offered().find((p) => p.def.id === 'agents')!
    expect(agents.label).toBe('Agents')
    expect(agents.page.slug).toBe('agents')
    expect(agents.members!.map((m) => m.slug)).toEqual(['agents', 'flows', 'evals'].filter((s) => pagesOf().some((p) => p.slug === s)))
    expect(RAIL_PAGES.find((d) => d.id === 'agents')!.group).toBe('agents')
  })

  it('select their group for any member page’s own card', () => {
    for (const slug of ['docs', 'knowledge', 'files', 'tables']) expect(pageOfCard(own(slug), NOW), slug).toBe('drive')
    for (const slug of ['agents', 'flows']) expect(pageOfCard(own(slug), NOW), slug).toBe('agents')
  })

  it('leave no empty section: the plans section is gone, and a section with nothing on draws nothing', () => {
    expect(RAIL_PAGES.some((d) => (d.group as string) === 'plans')).toBe(false)
    // CRM off: no customers section at all, the rest as they were.
    const noCrm = railPagesFor(pagesOf(withEffectiveSurface(full, { crm: 'off', sequences: 'off', campaigns: 'off', prospecting: 'off', studio: 'off', seo: 'off' })))
    expect([...new Set(noCrm.map((p) => p.def.group))]).toEqual(['work', 'agents'])
    // SEO sits with the customers: on alone, it keeps that section (and only itself in it).
    const seoOnly = railPagesFor(pagesOf(withEffectiveSurface(full, { crm: 'off', sequences: 'off', campaigns: 'off', prospecting: 'off', studio: 'off' })))
    expect(seoOnly.filter((p) => p.def.group === 'customers').map((p) => p.def.id)).toEqual(['seo'])
  })

  it('keep a bar saved with their members’ ids working: each where its first member stood, hidden only when all were', () => {
    const flowsFirst = all({ order: ['flows', 'mail'], hidden: [] })
    expect(flowsFirst.indexOf('agents')).toBeLessThan(flowsFirst.indexOf('mail'))
    const knowledgeLast = all({ order: ['mail', 'knowledge'], hidden: [] })
    expect(knowledgeLast.indexOf('drive')).toBeGreaterThan(knowledgeLast.indexOf('mail'))
    expect(shown({ order: [], hidden: ['docs'] })).toContain('drive')
    expect(shown({ order: [], hidden: ['knowledge', 'flows'] })).toEqual(expect.arrayContaining(['drive', 'agents']))
    expect(shown({ order: [], hidden: ['docs', 'knowledge', 'files', 'tables'] })).not.toContain('drive')
    expect(shown({ order: [], hidden: ['agents', 'flows', 'evals'] })).not.toContain('agents')
    expect(setRailPagePinned(null, 'drive', false)).toEqual({ order: [], hidden: ['docs', 'knowledge', 'files', 'tables'] })
  })
})

describe('the Studio in Outreach (Liam, 11-13: "I think it should be part of the outreach page")', () => {
  const pagesOf = (edition = full) => pagesFor(edition, { desktop: false, now: NOW })
  const pages = offered()
  const ids = pages.map((p) => p.def.id)
  const all = (prefs: Parameters<typeof railLayout>[1]) => railLayout(pages, prefs).all.map((p) => p.def.id)
  const shown = (prefs: Parameters<typeof railLayout>[1]) => railLayout(pages, prefs).shown.map((p) => p.def.id)

  it('is Outreach’s last member, after Campaigns, with no icon of its own', () => {
    expect(GROUP_OF_PAGE.get('studio')).toBe('outreach')
    expect(PAGE_GROUPS.outreach.members.at(-1)).toBe('studio')
    expect(ids).not.toContain('studio')
    expect(offered().find((p) => p.def.id === 'outreach')!.members!.map((m) => m.slug)).toEqual(['prospecting', 'sequences', 'campaigns', 'studio'])
  })

  it('its own card selects Outreach and lights it; a Studio card on one video (a link, the agent) is not the page’s own', () => {
    const studio = pagesOf().find((p) => p.slug === 'studio')!.spec(NOW)
    expect(ownPageOfCard(studio, NOW)).toEqual({ id: 'outreach', slug: 'studio' })
    expect(nextSelectedPlace({ place: 'home', frontId: null }, { id: 'card-studio', spec: studio }, false, NOW)).toBe('outreach')
    expect(activeRailItem('outreach', offered())).toBe('outreach')
    const onVideo = { kind: 'studio', title: 'Spring teaser', target: { type: 'studio_video', id: 'v-teaser', label: 'Spring teaser' } } as CardSpec
    expect(pageOfCard(onVideo, NOW)).toBeNull()
  })

  it('is remembered as Outreach’s last used member, and opened again by Outreach’s icon', () => {
    __resetPageGroupsForTests()
    rememberGroupPage('studio')
    expect(lastGroupPage('outreach')).toBe('studio')
    expect(groupOpenSlug('outreach', ['prospecting', 'sequences', 'campaigns', 'studio'])).toBe('studio')
    // Off here (a guest, or the Studio switched off): Outreach's default instead.
    expect(groupOpenSlug('outreach', ['prospecting', 'sequences', 'campaigns'])).toBe('prospecting')
    __resetPageGroupsForTests()
  })

  it('switched off in a workspace: Outreach without it; Outreach’s others off: Outreach opens the Studio alone', () => {
    const noStudio = railPagesFor(pagesOf(withEffectiveSurface(full, { studio: 'off' }))).find((p) => p.def.id === 'outreach')!
    expect(noStudio.members!.map((m) => m.slug)).toEqual(['prospecting', 'sequences', 'campaigns'])
    const studioOnly = railPagesFor(pagesOf(withEffectiveSurface(full, { prospecting: 'off', sequences: 'off', campaigns: 'off' }))).find((p) => p.def.id === 'outreach')!
    expect(studioOnly.members!.map((m) => m.slug)).toEqual(['studio'])
    expect(studioOnly.page.slug).toBe('studio')
  })

  it('loads a bar saved while the Studio had its own icon: its id moves nothing, a hidden Outreach stays hidden', () => {
    // The Studio dragged to the top: Outreach keeps its own place (not the Studio's).
    expect(all({ order: ['studio', 'mail'], hidden: [] }).indexOf('outreach')).toBe(ids.indexOf('outreach'))
    expect(all({ order: ['studio', 'mail'], hidden: [] })).toHaveLength(ids.length)
    // The Studio unpinned alone: Outreach still on the bar.
    expect(shown({ order: [], hidden: ['studio'] })).toContain('outreach')
    // Outreach hidden before the Studio joined it (its three members' ids): still hidden.
    expect(shown({ order: [], hidden: ['prospecting', 'sequences', 'campaigns'] })).not.toContain('outreach')
    // Pinned again: all four go.
    expect(setRailPagePinned({ order: [], hidden: ['prospecting', 'sequences', 'campaigns'] }, 'outreach', true)).toEqual({ order: [], hidden: [] })
    // The next save drops the Studio's old id from the order.
    expect(moveRailPage({ order: ['studio', 'mail'], hidden: [] }, ids, 'agents', 0)!.order).not.toContain('studio')
  })
})
