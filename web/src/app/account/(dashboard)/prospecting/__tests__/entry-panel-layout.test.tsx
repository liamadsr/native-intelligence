// @vitest-environment jsdom
/**
 * The entry panel is built to the CRM company panel's PLAN (Liam,
 * 2026-09-06: "make it look as similar as possible to our CRM page, like how
 * we display companies … reuse our details panel on the side and show the
 * details there … make it look really nice and clean").
 *
 * What this suite pins is the shape, not the copy:
 *
 *  1. a sub-header TOOLBAR with the tab pills (Overview · Details · People)
 *     on the left and the verbs on the right — no footer of the panel's own;
 *  2. a PROPERTIES SIDEBAR beside the content, with the CRM's groups: the
 *     short facts as read-only rows, then Prospecting, then Research (the
 *     twin of the CRM's Enrichment group);
 *  3. the Details tab is the CRM's Details tab over the research: sections
 *     in the CRM order, a roster for key people, chips for the tech stack;
 *  4. nothing is printed twice — the verdict is the Match block and only the
 *     Match block, the one-liner is the description and only the description;
 *  5. the People tab lists the people found here, opens one, and offers Find
 *     people — and the toolbar says so while the search is running.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { EntryPanel, type EntryPanelProps } from '../entry-panel'
import { entry } from './fixtures'
import type { ProspectListEntryRow } from '@/lib/prospecting/types'

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

const SRC = 'https://giftwell.com/about'
const f = (value: string, confidence: 'high' | 'medium' | 'low' = 'high', source_url = SRC) => ({
  value,
  source_url,
  confidence,
})

/** Giftwell, as the account card left it. */
function giftwell(overrides: Partial<ProspectListEntryRow> = {}): ProspectListEntryRow {
  return entry({
    id: 'c1',
    fit_score: 95,
    fit_rationale:
      'Giftwell is a prime candidate because it is a B2B SaaS company with ~244 employees.',
    candidate: {
      name: 'Giftwell',
      domain: 'giftwell.com',
      one_liner: 'Gifting and direct mail automation platform for revenue teams.',
      found_via: 'synthesized',
      account_card_at: '2026-09-05T10:00:00Z',
    },
    research: {
      one_liner: f('Gifting and direct mail automation platform for revenue teams.'),
      why_fit: f('Giftwell is a prime candidate because it is a B2B SaaS company with ~244 employees.'),
      why_match: f('Mid-market US B2B SaaS company with outbound sales motions.', 'high', 'https://g2.com/giftwell'),
      signal: f('Ongoing focus on revenue intelligence tools as of June 2026.'),
      founded_year: f('2016'),
      employee_range: f('201-500'),
      headquarters: f('San Francisco, California, United States'),
      funding_stage: f('Series C'),
      total_raised: f('$152.7M'),
      tech_stack: f('Salesforce, Marketo, HubSpot, Docker, TypeScript, Apache Kafka, Kubernetes.'),
      key_people: f('Kurt Ravensby — Co-CEO and Co-Founder; Paula Desrosiers — Chief Revenue Officer'),
      products: f('Gifting and direct mail automation platform, AI-powered gifting tools, campaign studio.'),
    },
    sources: [{ url: 'https://giftwell.com/about', title: 'About Giftwell' }],
    ...overrides,
  })
}

function person(id: string, name: string, title: string, email: string | null = null) {
  return entry({
    id,
    kind: 'person',
    parent_entry_id: 'c1',
    candidate_key: `linkedin.com/in/${id}`,
    candidate: { name, title, domain: 'giftwell.com', company_name: 'Giftwell', email },
    identity_state: 'anchored',
  })
}

async function render(props: Partial<EntryPanelProps> = {}) {
  await act(async () => {
    root.render(
      <EntryPanel entry={giftwell()} onSave={() => {}} onDismiss={() => {}} {...props} />,
    )
  })
}

function text(): string {
  return (container.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function toolbar(): HTMLElement {
  const el = container.querySelector('[data-prospect-toolbar]') as HTMLElement | null
  expect(el, 'the panel has the CRM sub-header toolbar').toBeTruthy()
  return el!
}

function sidebar(): HTMLElement {
  const el = container.querySelector('[data-prospect-sidebar]') as HTMLElement | null
  expect(el, 'the panel has the CRM properties sidebar').toBeTruthy()
  return el!
}

function tabPills(): string[] {
  return Array.from(toolbar().querySelectorAll('[data-prospect-tab]')).map(
    (b) => b.getAttribute('data-prospect-tab') ?? '',
  )
}

async function openTab(tab: string) {
  const pill = toolbar().querySelector(`[data-prospect-tab="${tab}"]`) as HTMLButtonElement
  expect(pill).toBeTruthy()
  await act(async () => {
    pill.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function buttons(scope: ParentNode = container): HTMLButtonElement[] {
  return Array.from(scope.querySelectorAll('button'))
}

function button(label: string, scope: ParentNode = container): HTMLButtonElement | undefined {
  return buttons(scope).find((b) => (b.textContent ?? '').trim() === label)
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('EntryPanel — the CRM company panel’s plan', () => {
  it('draws the toolbar: tab pills on the left, the verbs on the right, no footer', async () => {
    await render({ onProfile: () => {}, onFindPeople: () => {} })
    expect(tabPills()).toEqual(['overview', 'details', 'people'])
    // The active pill is the filled one, exactly as the CRM draws it.
    const overview = toolbar().querySelector('[data-prospect-tab="overview"]')!
    expect(overview.className).toContain('bg-foreground')
    expect(overview.getAttribute('aria-pressed')).toBe('true')

    // Every verb lives in the toolbar; nothing sits under the body.
    for (const label of ['Find people', 'Dismiss', 'Save to list']) {
      const verb = button(label)
      expect(verb, `${label} is a toolbar verb`).toBeTruthy()
      expect(toolbar().contains(verb!)).toBe(true)
    }
    // A scored company offers no Enrich — it has its profile.
    expect(button('Enrich')).toBeUndefined()
    // No footer band: the toolbar is the LAST place a verb lives.
    const save = button('Save to list')!
    const last = Array.from(container.querySelectorAll('button')).at(-1)!
    expect(toolbar().contains(last) || sidebar().contains(last) || last === save).toBe(true)
  })

  it('draws the properties sidebar with the CRM groups, as read-only rows', async () => {
    await render()
    const side = sidebar()
    const body = (side.textContent ?? '').replace(/\s+/g, ' ')
    expect(body.indexOf('Properties')).toBeGreaterThan(-1)
    expect(body.indexOf('Properties')).toBeLessThan(body.indexOf('Prospecting'))
    expect(body.indexOf('Prospecting')).toBeLessThan(body.indexOf('Research'))

    // The short facts, each as one row.
    expect(body).toContain('giftwell.com')
    expect(body).toContain('201-500 employees')
    expect(body).toContain('San Francisco, California, United States')
    expect(body).toContain('Founded 2016')
    expect(body).toContain('Series C')
    expect(body).toContain('$152.7M raised')
    // Read-only: no inputs, unlike the CRM's editable rows.
    expect(side.querySelector('input')).toBeNull()
    // Each fact keeps the page it was read from, as the Details tab does.
    expect(side.querySelector(`a[href="${SRC}"]`)).toBeTruthy()

    // Prospecting: the stage and how it was found.
    expect(body).toContain('Discovered')
    expect(body).toContain('Found by ICP search')
    // Research: when, and the way to the Details tab.
    expect(body).toMatch(/Enriched .*· 1 source/)
    expect(button('View details', side)).toBeTruthy()
  })

  it('View details in the sidebar opens the Details tab', async () => {
    await render()
    await click(button('View details', sidebar())!)
    expect(toolbar().querySelector('[data-prospect-tab="details"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    )
    expect(text()).toContain('Size & revenue')
  })

  it('prints the verdict and the description once each', async () => {
    await render()
    const body = text()
    const rationale = 'Giftwell is a prime candidate because it is a B2B SaaS company with ~244 employees.'
    const blurb = 'Gifting and direct mail automation platform for revenue teams.'
    expect(body.split(rationale).length - 1, 'the why-fit appears exactly once').toBe(1)
    expect(body.split(blurb).length - 1, 'the one-liner appears exactly once').toBe(1)
    // The chip beside the name is the ONLY chip.
    expect(container.querySelectorAll('[data-fit-score]')).toHaveLength(1)
    expect(container.querySelector('[data-fit-score]')?.textContent).toBe('95match score')
    expect(body).toContain('Strong match')

    await openTab('details')
    const details = text()
    expect(details.split(rationale).length - 1, 'Details does not repeat the verdict').toBe(0)
    expect(details.split(blurb).length - 1, 'Details does not repeat the one-liner').toBe(0)
    // Nor the name and the domain as rows — the header carries them.
    expect(details).not.toMatch(/Name\s*Giftwell/)
    expect(details).not.toMatch(/Domain\s*giftwell\.com/)
  })

  it('lays the Details tab out as the CRM does: sections in order, a roster, chips', async () => {
    await render()
    await openTab('details')
    const details = text()
    const order = ['About', 'Size & revenue', 'Funding', 'Leadership', 'Products & services', 'Technology', 'Signals']
    const positions = order.map((title) => details.indexOf(title))
    expect(positions.every((p) => p > -1), `every section present: ${positions}`).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)

    // Key people as a roster — name in the foreground weight, title beside it.
    const roster = Array.from(container.querySelectorAll('li')).map((li) =>
      Array.from(li.querySelectorAll('span')).map((span) => span.textContent),
    )
    expect(roster).toContainEqual(['Kurt Ravensby', 'Co-CEO and Co-Founder'])
    expect(roster).toContainEqual(['Paula Desrosiers', 'Chief Revenue Officer'])

    // The tech stack as chips, not a sentence — the card's trailing full stop
    // used to defeat the list check and render one long line.
    const chips = Array.from(container.querySelectorAll('.rounded-full.border.bg-muted\\/40')).map(
      (el) => el.textContent,
    )
    expect(chips).toContain('Salesforce')
    expect(chips).toContain('Apache Kafka')
    expect(chips).toContain('Kubernetes')

    // Status line and sources, exactly as the CRM tab has them.
    expect(details).toMatch(/^Overview.*Enriched/)
    expect(details).toContain('Sources')
    expect(details).toContain('About Giftwell')
  })

  it('keeps the signals on the overview too — the one section a seller reads first', async () => {
    await render()
    expect(text()).toContain('Signals')
    expect(text()).toContain('Ongoing focus on revenue intelligence tools as of June 2026.')
  })
})

describe('EntryPanel — People', () => {
  const PEOPLE = [
    person('p1', 'Kurt Ravensby', 'Co-CEO'),
    person('p2', 'Paula Desrosiers', 'Chief Revenue Officer', 'paula@giftwell.com'),
  ]

  it('counts them on the pill and previews them on the overview', async () => {
    await render({ people: PEOPLE })
    const pill = toolbar().querySelector('[data-prospect-tab="people"]')!
    expect(pill.textContent).toBe('People2')
    // The overview's People block, in the CRM's Recent Captures slot.
    expect(text()).toContain('Kurt Ravensby')
    expect(text()).toContain('Paula Desrosiers')
  })

  it('opens a person from the People tab', async () => {
    const onOpenPerson = vi.fn()
    await render({ people: PEOPLE, onOpenPerson })
    await openTab('people')
    const row = container.querySelector('[data-prospect-person-row="p2"]')!
    expect(row.textContent).toContain('Chief Revenue Officer')
    await click(row)
    expect(onOpenPerson).toHaveBeenCalledWith(PEOPLE[1])
  })

  it('offers Find people when nobody has been found, and says so while searching', async () => {
    const onFindPeople = vi.fn()
    await render({ people: [], onFindPeople })
    await openTab('people')
    expect(text()).toContain('No people found yet')
    // Both doors — the empty state's button and the toolbar's — start the
    // same search.
    const doors = buttons().filter((b) => (b.textContent ?? '').trim() === 'Find people')
    expect(doors).toHaveLength(2)
    await click(doors[1])
    expect(onFindPeople).toHaveBeenCalledTimes(1)

    await render({ people: [], onFindPeople, findingPeople: true })
    const busy = button('Finding people…')
    expect(busy, 'the toolbar says the search is running').toBeTruthy()
    expect(busy!.disabled).toBe(true)
    expect(text()).toContain('Searching for people…')
  })

  it('withholds Find people from a dismissed or unresolved company', async () => {
    await render({ onFindPeople: () => {}, entry: giftwell({ stage: 'dismissed' }) })
    expect(button('Find people')).toBeUndefined()
    await render({
      onFindPeople: () => {},
      entry: giftwell({ identity_state: 'unresolved', candidate: { name: 'Giftwell' } }),
    })
    expect(button('Find people')).toBeUndefined()
  })
})

describe('EntryPanel — while the profile run is live', () => {
  it('says the company is being enriched, in the toolbar and in the sidebar', async () => {
    const unscored = giftwell({
      fit_score: null,
      fit_rationale: 'Mid-market US B2B SaaS company with outbound sales motions.',
      candidate: { name: 'Giftwell', domain: 'giftwell.com' },
      research: { why_match: f('Mid-market US B2B SaaS company with outbound sales motions.') },
    })
    await render({ entry: unscored, onProfile: () => {}, profiling: true })
    const enrich = button('Enriching…')
    expect(enrich).toBeTruthy()
    expect(enrich!.disabled).toBe(true)
    expect(sidebar().textContent).toContain('Researching giftwell.com…')

    // A company that already has its score is not "being enriched" by a run
    // that is scoring the others.
    await render({ onProfile: () => {}, profiling: true })
    expect(button('Enriching…')).toBeUndefined()
    expect(sidebar().textContent).not.toContain('Researching')
  })
})

describe('EntryPanel — a person, in the contact panel’s plan', () => {
  it('draws Overview and Details, the properties sidebar, and the verbs in the toolbar', async () => {
    const dana = person('p1', 'Dana Reyes', 'VP of Revenue Operations', 'dana@giftwell.com')
    await render({ entry: dana, onAddToSequence: () => {}, parentName: 'Giftwell' })
    expect(tabPills()).toEqual(['overview', 'details'])
    for (const label of ['Add to sequence', 'Dismiss', 'Save to list']) {
      expect(toolbar().contains(button(label)!), `${label} is a toolbar verb`).toBe(true)
    }
    const side = sidebar().textContent ?? ''
    expect(side).toContain('VP of Revenue Operations')
    expect(side).toContain('Giftwell')
    expect(side).toContain('dana@giftwell.com')
    expect(side).toContain('Discovered')
    // The identity chip sits beside the name, where the CRM's Enriched badge sits.
    expect(container.querySelector('[data-prospect-identity="anchored"]')?.textContent).toBe('Verified')
    expect(container.querySelector('h1')?.textContent).toBe('Dana Reyes')
  })

  it('asks the needs_review question in a band under the toolbar, beside the evidence', async () => {
    const held = person('p1', 'Dana Reyes', 'VP of Revenue Operations')
    await render({
      entry: { ...held, identity_state: 'needs_review', stage: 'saved', published_at: null },
      parentName: 'Giftwell',
    })
    expect(container.querySelector('[data-unverified-confirm]')).toBeNull()
    await click(button('Publish anyway')!)
    const band = container.querySelector('[data-unverified-confirm]')!
    expect(band).toBeTruthy()
    expect(band.textContent).toContain('This person could not be verified at Giftwell. Publish anyway?')
    // The band holds the answer, and the Identity block is still on screen.
    expect(button('Cancel', band)).toBeTruthy()
    expect(button('Publish anyway', band)).toBeTruthy()
    expect(text()).toContain('Employer not confirmed')
  })
})

/**
 * "1 found, already in this list" in the panel — with the row it duplicates
 * and the account that row sits under, as a link. The Solenne Ventures case: the
 * real firm's row read "No people found yet" while its partners sat under a
 * ghost row of the same name at a parked domain.
 */
describe('EntryPanel — people found, none kept', () => {
  const ghost = entry({
    id: 'ghost',
    candidate: { name: 'Solenne Ventures', domain: 'solenneventures.net' },
    fit_score: 80,
  })
  const tom = entry({
    id: 'entry-theo',
    kind: 'person',
    parent_entry_id: 'ghost',
    candidate_key: 'linkedin.com/in/theo-sandford',
    candidate: { name: 'Theo Sandford', title: 'Operating Partner', domain: 'solenneventures.net' },
    stage: 'saved',
  })
  const byId: Record<string, ProspectListEntryRow> = { ghost, 'entry-theo': tom }
  const lookupEntry = (id: string) => byId[id]

  const solenne = () =>
    giftwell({
      id: 'real',
      candidate: {
        name: 'Solenne Ventures',
        domain: 'solennevc.co',
        one_liner: 'Operator-led VC investing in AI-native enterprise software workflows.',
        account_card_at: '2026-09-07T02:20:50.060Z',
        people_searched_at: '2026-09-07T12:44:30.658Z',
        people_search: {
          at: '2026-09-07T12:44:30.658Z',
          found: 1,
          added: 0,
          known: [{ name: 'Theo Sandford', by: 'this_list', ref_id: 'entry-theo' }],
          capped: 0,
          invalid: 0,
        },
      },
    })

  it('says what the search saw on the overview, and opens the duplicate', async () => {
    const onOpenEntry = vi.fn()
    await render({ entry: solenne(), people: [], lookupEntry, onOpenEntry, onFindPeople: () => {} })
    const note = container.querySelector('[data-prospect-people-known]')!
    expect(note, 'the overview states what the search saw').toBeTruthy()
    const said = (note.textContent ?? '').replace(/\s+/g, ' ')
    expect(said).toContain('1 found, already in this list')
    expect(said).toContain('Theo Sandford')
    expect(said).toContain('under Solenne Ventures (solenneventures.net)')
    expect(text()).not.toContain('No people found yet')

    await click(container.querySelector('[data-prospect-known-person="entry-theo"]')!)
    expect(onOpenEntry).toHaveBeenCalledWith(tom)
  })

  it('leads the People tab with it and says a retry finds the same people', async () => {
    await render({ entry: solenne(), people: [], lookupEntry, onFindPeople: () => {} })
    await openTab('people')
    expect(text()).toContain('1 found, already in this list')
    expect(text()).toContain('Searching again finds the same people')
    // Still the user's call.
    expect(buttons().filter((b) => (b.textContent ?? '').trim() === 'Find people')).toHaveLength(2)
  })

  it('names the person without a link when the page cannot resolve the row', async () => {
    await render({ entry: solenne(), people: [] })
    const note = container.querySelector('[data-prospect-people-known]')!
    expect(note.textContent).toContain('Theo Sandford')
    expect(note.textContent).toContain('already in this list')
    expect(container.querySelector('[data-prospect-known-person]')).toBeNull()
  })

  it('falls back to "No people found yet" when nothing was searched, or people sit beneath', async () => {
    await render({ people: [] })
    expect(text()).toContain('No people found yet')
    await render({ entry: solenne(), people: [person('p1', 'Someone Else', 'Partner')] })
    expect(container.querySelector('[data-prospect-people-known]')).toBeNull()
  })
})
