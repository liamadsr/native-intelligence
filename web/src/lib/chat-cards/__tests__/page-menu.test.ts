/**
 * The pages `/` lists: every card kind has one (or a reason it has none), each
 * opens on a card the chat can draw, only pages that are on in the workspace
 * are offered, and the query finds them by slug, name or keyword.
 */
import { describe, expect, it } from 'vitest'
import { getEdition, withEffectiveSurface } from '@/lib/editions/manifest'
import { CARD_KIND_NAMES, isCardSpec } from '../kinds'
import { normalizeShowInput } from '../validate'
import { CARD_PAGES, NO_PAGE_KINDS, filterPages, pagesFor, personalToolsFor, thisWeek, type CardPage } from '../page-menu'
import { PAGE_KINDS, isPageKind } from '../pages'
import { PERSONAL_CARD_TOOLS } from '@/lib/ai/tools/show'

const NOW = new Date(2026, 9, 8, 15, 30) // Thursday 8 October 2026, local
const full = getEdition('full')

describe('the page list', () => {
  it('gives every card kind a page, or says why it has none', () => {
    for (const kind of CARD_KIND_NAMES) {
      const hasPage = CARD_PAGES.some((p) => p.kind === kind)
      expect(hasPage || kind in NO_PAGE_KINDS, `kind '${kind}' has no / page and no NO_PAGE_KINDS reason`).toBe(true)
    }
  })

  it('opens each kind this build has on a card the chat can draw', () => {
    for (const page of CARD_PAGES) {
      if (!(CARD_KIND_NAMES as readonly string[]).includes(page.kind)) continue
      const spec = page.spec(NOW)
      expect(isCardSpec(spec), `/${page.slug}`).toBe(true)
      expect((spec as { kind: string }).kind).toBe(page.kind)
    }
  })

  it('opens list pages on views show itself would accept', () => {
    for (const page of CARD_PAGES.filter((p) => p.kind === 'list')) {
      const checked = normalizeShowInput(page.spec(NOW) as Parameters<typeof normalizeShowInput>[0])
      expect(checked.ok, `/${page.slug}: ${checked.ok ? '' : checked.error}`).toBe(true)
    }
  })

  it('opens My Actions on the actions assigned to me that are still open', () => {
    const spec = CARD_PAGES.find((p) => p.slug === 'actions')!.spec(NOW)
    expect(spec).toMatchObject({
      kind: 'list',
      entity_type: 'action',
      filters: [
        { field: 'assignee_id', operator: 'is', value: '@me' },
        { field: 'status_type', operator: 'is_none_of', value: ['completed', 'canceled'] },
      ],
    })
  })

  it('opens Mail on the inbox and the calendar on the week it is opened in', () => {
    expect(CARD_PAGES.find((p) => p.slug === 'mail')!.spec(NOW)).toMatchObject({ kind: 'mail', mail: { folder: 'inbox' } })
    expect(CARD_PAGES.find((p) => p.slug === 'calendar')!.spec(NOW)).toMatchObject({
      kind: 'calendar',
      calendar: { from: '2026-10-04', to: '2026-10-10', view: 'week' },
    })
  })

  it('has one slug per page', () => {
    const slugs = CARD_PAGES.map((p) => p.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })
})

describe('thisWeek', () => {
  it('runs Sunday to Saturday, as the calendar grid draws it', () => {
    expect(thisWeek(new Date(2026, 9, 4))).toEqual({ from: '2026-10-04', to: '2026-10-10' })
    expect(thisWeek(new Date(2026, 9, 10, 23, 59))).toEqual({ from: '2026-10-04', to: '2026-10-10' })
    // Across a month end.
    expect(thisWeek(new Date(2026, 9, 1))).toEqual({ from: '2026-09-27', to: '2026-10-03' })
  })
})

describe('pagesFor', () => {
  it('offers a full workspace its list pages', () => {
    const slugs = pagesFor(full, { desktop: false, now: NOW }).map((p) => p.slug)
    expect(slugs).toEqual(expect.arrayContaining(['actions', 'captures', 'docs', 'contacts', 'companies', 'projects', 'initiatives']))
  })

  it('leaves out the pages that are off in the workspace (the nav gate)', () => {
    const noCrm = withEffectiveSurface(full, { crm: 'off', sequences: 'off', prospecting: 'off', docs: 'off' })
    const slugs = pagesFor(noCrm, { desktop: false, now: NOW }).map((p) => p.slug)
    expect(slugs).not.toContain('contacts')
    expect(slugs).not.toContain('companies')
    expect(slugs).not.toContain('docs')
    expect(slugs).toContain('actions')
    expect(slugs).toContain('captures')
  })

  it('offers a kind only once this build can draw it, and a desktop page only on the desktop', () => {
    const fake = (over: Partial<CardPage>): CardPage => ({
      slug: 'x',
      label: 'X',
      description: '',
      kind: 'list',
      view: 'todo',
      spec: () => ({ kind: 'list', title: 'X', entity_type: 'action', filters: [] }),
      ...over,
    })
    const from = [
      fake({ slug: 'drawn' }),
      fake({ slug: 'unknown-kind', kind: 'nope', spec: () => ({ kind: 'nope', title: 'Nope' }) }),
      fake({ slug: 'desk', desktopOnly: true }),
    ]
    expect(pagesFor(full, { desktop: false, now: NOW, from }).map((p) => p.slug)).toEqual(['drawn'])
    expect(pagesFor(full, { desktop: true, now: NOW, from }).map((p) => p.slug)).toEqual(['drawn', 'desk'])
  })
})

describe('filterPages', () => {
  const pages = pagesFor(full, { desktop: true, now: NOW })

  it('finds a page by the start of its slug first', () => {
    expect(filterPages(pages, 'act')[0].slug).toBe('actions')
    expect(filterPages(pages, 'co').slice(0, 2).map((p) => p.slug)).toEqual(['contacts', 'companies'])
  })

  it('finds pages by name and keyword too', () => {
    expect(filterPages(pages, 'crm').map((p) => p.slug)).toEqual(expect.arrayContaining(['contacts', 'companies']))
    expect(filterPages(pages, 'tasks').map((p) => p.slug)).toContain('actions')
    expect(filterPages(pages, 'zzz')).toEqual([])
  })

  it('lists them all for an empty query', () => {
    expect(filterPages(pages, '')).toHaveLength(pages.length)
  })
})

describe('the kinds that came with P2 and P3', () => {
  it('offers a full workspace every page kind but the ones that need a record', () => {
    const kinds = new Set(pagesFor(getEdition('full'), { desktop: true, now: NOW }).map((p) => p.kind))
    for (const kind of CARD_KIND_NAMES) {
      if (kind in NO_PAGE_KINDS) continue
      // Evals is opt-in: no preset turns it on.
      if (kind === 'evals') continue
      expect(kinds.has(kind), kind).toBe(true)
    }
    const evals = withEffectiveSurface(getEdition('full'), { evals: 'on' })
    expect(pagesFor(evals, { desktop: true, now: NOW }).map((p) => p.kind)).toEqual(expect.arrayContaining(['evals']))
  })

  it('shares each page kind’s own gate and desktop rule (pages.ts)', () => {
    for (const page of CARD_PAGES.filter((p) => isPageKind(p.kind))) {
      const def = PAGE_KINDS[page.kind as keyof typeof PAGE_KINDS]
      expect(page.view, page.slug).toBe(def.view)
      expect(!!page.desktopOnly, page.slug).toBe(!!def.desktopOnly)
    }
  })

  it('names the same per-person tools show gates calendar and mail on', () => {
    expect(CARD_PAGES.find((p) => p.kind === 'calendar')?.personalTool).toBe(PERSONAL_CARD_TOOLS.calendar)
    expect(CARD_PAGES.find((p) => p.kind === 'mail')?.personalTool).toBe(PERSONAL_CARD_TOOLS.mail)
  })

  it('leaves out the members-only pages for a guest of the workspace: the Studio, whose routes refuse a guest', () => {
    expect(CARD_PAGES.filter((p) => p.membersOnly).map((p) => p.slug)).toEqual(['studio'])
    const member = pagesFor(full, { desktop: false, now: NOW }).map((p) => p.slug)
    const guest = pagesFor(full, { desktop: false, now: NOW, guest: true }).map((p) => p.slug)
    expect(member).toContain('studio')
    expect(pagesFor(full, { desktop: false, now: NOW, guest: false }).map((p) => p.slug)).toEqual(member)
    expect(guest).toEqual(member.filter((slug) => slug !== 'studio'))
  })

  it('leaves out calendar and mail where the chat may not read them', () => {
    const slugs = (chat: Parameters<typeof personalToolsFor>[0]) =>
      pagesFor(full, { desktop: false, now: NOW, personalTools: personalToolsFor(chat) }).map((p) => p.slug)
    expect(slugs({ bot: false, agent: null })).toEqual(expect.arrayContaining(['calendar', 'mail']))
    // A bot's conversation: the bot's own limits rule.
    expect(slugs({ bot: true, agent: null })).not.toEqual(expect.arrayContaining(['calendar']))
    expect(slugs({ bot: true, agent: null })).not.toContain('mail')
    // A persona that drops list_emails, or keeps an allowlist without it.
    expect(slugs({ bot: false, agent: { disabled_tools: ['list_emails'] } })).not.toContain('mail')
    expect(slugs({ bot: false, agent: { enabled_tools: ['get_calendar_events'] } })).toEqual(expect.arrayContaining(['calendar']))
    expect(slugs({ bot: false, agent: { enabled_tools: ['get_calendar_events'] } })).not.toContain('mail')
    // Mail off in the workspace: no Mail page, whoever asks.
    const noMail = withEffectiveSurface(full, { email: 'off' })
    expect(pagesFor(noMail, { desktop: false, now: NOW }).map((p) => p.slug)).not.toContain('mail')
  })

  it('opens the page kinds at their top level, and no browser page anywhere (the agent’s computer is the side panel’s)', () => {
    const web = pagesFor(full, { desktop: false, now: NOW }).map((p) => p.slug)
    expect(web).toEqual(expect.arrayContaining(['sequences', 'prospecting', 'flows', 'campaigns', 'knowledge', 'agents', 'teams']))
    expect(web).not.toContain('browser')
    // The inbox page went with the notifications page (docs/plans/retire-notifications-page.md).
    expect(web).not.toContain('inbox')
    const desk = withEffectiveSurface(full, { browser: 'on' })
    expect(pagesFor(desk, { desktop: true, now: NOW }).map((p) => p.slug)).not.toContain('browser')
  })
})

describe('pagesFor in an edition’s words', () => {
  const service = getEdition('service')
  const offered = pagesFor(service, { desktop: false, now: NOW })
  const page = (slug: string) => offered.find((p) => p.slug === slug)!

  it('names the pages a service business renames, and leaves the rest', () => {
    expect(page('actions')).toMatchObject({ label: 'My jobs', description: 'Jobs and to-dos still open' })
    expect(page('captures')).toMatchObject({ label: 'Calls & notes' })
    expect(page('contacts')).toMatchObject({ label: 'Customers' })
    expect(page('initiatives')).toMatchObject({ label: 'Goals' })
    expect(page('mail')).toMatchObject({ label: 'Mail', description: 'Your inbox' })
    // Same pages, same order: words only, nothing turned off.
    expect(offered.map((p) => p.slug)).toEqual(pagesFor(full, { desktop: false, now: NOW }).map((p) => p.slug))
  })

  it('titles a renamed list page’s card by its new name, and keeps its query', () => {
    const spec = page('actions').spec(NOW)
    const appSpec = pagesFor(full, { desktop: false, now: NOW }).find((p) => p.slug === 'actions')!.spec(NOW)
    expect(spec).toEqual({ ...appSpec, title: 'My jobs' })
    expect(isCardSpec(spec)).toBe(true)
  })

  it('shows the owner’s slug, and keeps the app’s as the page’s id', () => {
    expect(page('actions').shownSlug).toBe('jobs')
    expect(page('captures').shownSlug).toBe('calls')
    expect(page('contacts').shownSlug).toBe('customers')
    expect(page('mail').shownSlug).toBeUndefined()
    expect(pagesFor(full, { desktop: false, now: NOW }).every((p) => p.shownSlug === undefined)).toBe(true)
  })

  it('still finds a renamed page by the app’s word and by the owner’s', () => {
    expect(filterPages(offered, 'actions')[0].slug).toBe('actions')
    expect(filterPages(offered, 'jobs')[0].slug).toBe('actions')
    expect(filterPages(offered, 'customers')[0].slug).toBe('contacts')
    expect(filterPages(offered, 'captures')[0].slug).toBe('captures')
    expect(filterPages(offered, 'calls')[0].slug).toBe('captures')
    expect(filterPages(offered, 'goa')[0].slug).toBe('initiatives')
  })

  it('changes nothing in an edition that says nothing', () => {
    for (const p of pagesFor(full, { desktop: false, now: NOW })) {
      const own = CARD_PAGES.find((c) => c.slug === p.slug)!
      expect(p.label).toBe(own.label)
      expect(p.keywords).toBe(own.keywords)
      expect(p.spec(NOW)).toEqual(own.spec(NOW))
    }
  })
})
