// @vitest-environment jsdom
/**
 * The entry panel's FIT BLOCK.
 *
 * What the panel owes the user is the full profile's verdict — the 0–100
 * score, its word, and the paragraph behind it — the same three things Exa's
 * own demo shows. Until the company is enriched there is NO score (discovery
 * does not score; fit.ts), only discovery's why-match sentence, and the panel
 * says so instead of guessing — and offers the Enrich button that gets one.
 *
 * The `research` blob renders through the EXISTING Details vocabulary
 * (`readBlob` / `fieldFromBlob` / `DetailSectionView`) — the blob is
 * deliberately the same shape as `company.metadata.enrichment`, and this suite
 * proves that pays off with no new display code.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { EntryPanel } from '../entry-panel'
import { entry } from './fixtures'

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

const SCORED = {
  fit_score: 88,
  fit_rationale: 'Sells a real-time analytics database to exactly your buyer.',
  candidate: { name: 'Querylane', domain: 'querylane.io', account_card_at: '2026-09-05T00:00:00Z' },
  research: {
    fields: {
      why_fit: {
        value: 'Sells a real-time analytics database to exactly your buyer.',
        source_url: 'https://querylane.io/about',
        confidence: 'high',
      },
    },
  },
}

async function render(
  overrides: Parameters<typeof entry>[0] = {},
  props: { onProfile?: () => void } = {},
) {
  await act(async () => {
    root.render(
      <EntryPanel
        entry={entry(overrides)}
        onSave={() => {}}
        onDismiss={() => {}}
        onProfile={props.onProfile}
      />,
    )
  })
}

function text() {
  return container.textContent ?? ''
}

function scoreChip(): HTMLElement | null {
  return container.querySelector('[data-fit-score]') as HTMLElement | null
}

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'))
}

describe('EntryPanel — fit block', () => {
  it('shows the score, its word and the rationale for a profiled company', async () => {
    await render(SCORED)
    expect(scoreChip()!.getAttribute('data-fit-score')).toBe('88')
    expect(scoreChip()!.textContent).toBe('88match score')
    expect(text()).toContain('Sells a real-time analytics database to exactly your buyer.')
    expect(text()).not.toContain('Not scored yet')
    // No leftover tier vocabulary anywhere in the panel.
    expect(text()).not.toMatch(/confidence/i)
    expect(container.querySelector('[data-fit-tier]')).toBeNull()
  })

  it('keeps the honest state for a company nobody has enriched — and offers Enrich', async () => {
    const onProfile = vi.fn()
    await render({ fit_rationale: 'Surfaced for its inside sales team.' }, { onProfile })
    expect(scoreChip()!.textContent).toBe('Not scored')
    // Discovery's why-match still reads as the "why".
    expect(text()).toContain('Surfaced for its inside sales team.')
    expect(container.querySelector('[data-prospect-enrich-hint]')).toBeTruthy()

    const enrich = buttons().find((b) => (b.textContent ?? '').includes('Enrich'))!
    expect(enrich).toBeTruthy()
    act(() => {
      enrich.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onProfile).toHaveBeenCalledTimes(1)
  })

  it('says "Not scored yet" when there is no rationale either', async () => {
    await render()
    expect(text()).toContain('Not scored yet')
  })

  it('offers no Enrich once the company has a score, on a dismissed row, or without a domain', async () => {
    const onProfile = vi.fn()
    await render(SCORED, { onProfile })
    expect(buttons().find((b) => (b.textContent ?? '').includes('Enrich'))).toBeUndefined()
    expect(container.querySelector('[data-prospect-enrich-hint]')).toBeNull()

    await render({ stage: 'dismissed' }, { onProfile })
    expect(buttons().find((b) => (b.textContent ?? '').includes('Enrich'))).toBeUndefined()

    await render({ identity_state: 'unresolved', candidate: { name: 'Querylane' } }, { onProfile })
    expect(buttons().find((b) => (b.textContent ?? '').includes('Enrich'))).toBeUndefined()
  })

  it('offers no Enrich button at all when the page gave it nothing to call', async () => {
    await render()
    expect(buttons().find((b) => (b.textContent ?? '').includes('Enrich'))).toBeUndefined()
  })

  it('says so plainly when a scored entry carries no rationale', async () => {
    await render({ ...SCORED, fit_rationale: null, research: null })
    expect(text()).toContain('No rationale was recorded')
  })

  it('reads a zeroed score as a weak match, with the anti rule as its reason', async () => {
    await render({ fit_score: 0, fit_rationale: 'Matches excluded industry "crypto".' })
    expect(scoreChip()!.textContent).toBe('0match score')
    expect(text()).toContain('Matches excluded industry "crypto".')
  })
})

/** The Details tab — the CRM's sections over the candidate's research. */
async function openDetails() {
  const pill = container.querySelector('[data-prospect-tab="details"]') as HTMLButtonElement
  expect(pill, 'the panel offers a Details tab, as the CRM company panel does').toBeTruthy()
  await act(async () => {
    pill.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('EntryPanel — research blob through the Details vocabulary', () => {
  it('lays the account-card fields out in the CRM sections, with their source links', async () => {
    await render({
      ...SCORED,
      research: {
        fields: {
          one_liner: {
            value: 'A real-time analytics database built on Apache Druid.',
            source_url: 'https://querylane.io',
            confidence: 'high',
          },
          why_match: {
            value:
              'They sell to data and engineering teams at mid-market B2B software companies.',
            source_url: 'https://querylane.io/customers',
            confidence: 'high',
          },
          founded_year: { value: '2015', source_url: 'https://querylane.io/about', confidence: 'high' },
          employee_range: {
            value: '201-500',
            source_url: 'https://querylane.io/careers',
            confidence: 'medium',
          },
          // A key nobody catalogued still lands, labelled from the key — a
          // new card field must never silently vanish.
          partner_ecosystem: { value: 'AWS, Confluent', source_url: 'https://querylane.io/partners' },
        },
      },
    })
    // The overview holds the identity and the verdict ONCE: the one-liner is
    // the description, the why-match's page is the citation — neither is a
    // labelled research row any more.
    expect(text()).toContain('A real-time analytics database built on Apache Druid.')
    expect(text()).not.toContain('One liner')
    expect(text()).not.toContain('Why match')
    expect(container.querySelector('a[href="https://querylane.io/customers"]')).toBeTruthy()

    await openDetails()
    // The CRM's own section titles and labels, in its order.
    const details = text()
    expect(details.indexOf('About')).toBeGreaterThan(-1)
    expect(details).toContain('Founded')
    expect(details).toContain('2015')
    expect(details).toContain('Size & revenue')
    expect(details).toContain('Employee range')
    expect(details).toContain('201-500')
    expect(details.indexOf('About')).toBeLessThan(details.indexOf('Size & revenue'))
    expect(details).toContain('Other')
    expect(details).toContain('Partner ecosystem')
    // Each fact links to the page it was read from.
    expect(container.querySelector('a[href="https://querylane.io/about"]')).toBeTruthy()
    expect(container.querySelector('a[href="https://querylane.io/careers"]')).toBeTruthy()
    // And the verdict is not repeated as a row under Details.
    expect(details).not.toContain('Why match')
  })

  it('renders the BARE field map the prospecting engines actually write', async () => {
    // Discovery stores `candidate.fields` and `applyCard` stores the merged
    // map straight into `research` — no `{ fields }` wrapper. Read through
    // `readBlob` alone that is an empty blob, and every profiled company's
    // panel said "Nothing researched yet" under a real score (seen live).
    await render({
      ...SCORED,
      research: {
        headquarters: { value: 'Dublin, Ireland', source_url: 'https://softco.com', confidence: 'high' },
        employee_count: { value: '109', source_url: 'https://softco.com', confidence: 'high' },
        why_fit: { value: 'Sells a real-time analytics database to exactly your buyer.', confidence: 'high' },
      },
    })
    // The sidebar's facts read off the bare map too.
    expect(text()).toContain('Dublin, Ireland')
    expect(text()).toContain('109 employees')

    await openDetails()
    expect(text()).toContain('Headquarters')
    expect(text()).toContain('Headcount')
    expect(text()).not.toContain('No details yet')
  })

  it('offers the honest empty state when nothing has been researched', async () => {
    await render({ ...SCORED, candidate: { name: 'Querylane', domain: 'querylane.io' }, research: null })
    // The sidebar's Research group says so, and offers no View details.
    expect(text()).toContain('Not yet enriched')
    expect(text()).not.toContain('View details')

    await openDetails()
    expect(text()).toContain('No details yet')
    expect(text()).toContain('Enrich in the toolbar')
  })
})

describe('EntryPanel — provenance and result_entity candidates', () => {
  it('shows how the candidate was found and its Exa id, quietly', async () => {
    await render({
      ...SCORED,
      candidate: {
        name: 'Querylane',
        domain: 'querylane.io',
        found_via: 'synthesized',
        exa_entity_id: 'org_abc123',
      },
      discovery_angle: 'segment',
    })
    expect(text()).toContain('Found by ICP search')
    expect(text()).toContain('segment')
    const link = container.querySelector('a[href="https://exa.ai/library/organization/org_abc123"]')
    expect(link).toBeTruthy()
  })

  it('keeps a result_entity blurb as the description, never as the rationale', async () => {
    await render({
      fit_rationale: null,
      candidate: {
        name: 'Querylane',
        domain: 'querylane.io',
        found_via: 'result_entity',
        one_liner: 'Querylane provides a real-time analytics database.',
      },
    })
    // The blurb sits under Description; the Match block says there is no
    // verdict yet rather than borrowing the company's own words for one.
    const body = text()
    expect(body.indexOf('Description')).toBeGreaterThan(-1)
    expect(body.indexOf('Description')).toBeLessThan(
      body.indexOf('Querylane provides a real-time analytics database.'),
    )
    expect(body.indexOf('Querylane provides a real-time analytics database.')).toBeLessThan(
      body.indexOf('Match'),
    )
    expect(body).toContain('Not scored yet')
    expect(body).toContain('Lifted from a search result')
  })

  it('keeps Save and Dismiss, and refuses Save on an unresolved candidate', async () => {
    await render(SCORED)
    const save = buttons().find((b) => (b.textContent ?? '').includes('Save to list'))!
    const dismiss = buttons().find((b) => (b.textContent ?? '').includes('Dismiss'))!
    expect(save.disabled).toBe(false)
    expect(dismiss.disabled).toBe(false)

    await render({ ...SCORED, identity_state: 'unresolved', candidate: { name: 'Querylane' } })
    const unresolvedSave = buttons().find((b) => (b.textContent ?? '').includes('Save to list'))!
    expect(unresolvedSave.disabled).toBe(true)
  })

  /**
   * WHAT THE SLIM ROW HANDED OVER.
   *
   * The list row used to carry a headcount chip and a "Surfaced by <host>"
   * favicon link on every company. Both now sit behind the "Why" display
   * property, so the default row reads favicon · name · score — which is only
   * an honest trade if the panel picks them up. These pin that it does.
   *
   * The citation is built from the SHARED `entryEvidenceUrl`, the same helper
   * the row calls when "Why" is ticked, so the two surfaces cannot disagree
   * about which page surfaced a company.
   */
  it('names the page behind the profile’s why-fit', async () => {
    await render(SCORED)
    const citation = container.querySelector('[data-prospect-citation]') as HTMLAnchorElement | null
    expect(citation, 'the citation moved here from the row').toBeTruthy()
    expect(citation!.getAttribute('href')).toBe('https://querylane.io/about')
    // The HOST, not the whole URL.
    expect(citation!.textContent).toContain('Surfaced by querylane.io')
    expect(citation!.textContent).not.toContain('https://')
  })

  it("falls back to discovery's why_match source before the profile lands", async () => {
    await render({
      research: {
        fields: {
          why_match: { value: 'Matches on category.', source_url: 'https://techcrunch.com/querylane' },
        },
      },
    })
    const citation = container.querySelector('[data-prospect-citation]') as HTMLAnchorElement | null
    expect(citation!.getAttribute('href')).toBe('https://techcrunch.com/querylane')
  })

  it('draws no citation when the entry carries no evidence at all', async () => {
    await render({ fit_score: 45 })
    expect(container.querySelector('[data-prospect-citation]')).toBeNull()
  })

  it('shows the headcount the row stopped showing, under either blob key', async () => {
    await render({ ...SCORED, research: { fields: { employee_range: { value: '51-200' } } } })
    expect(container.querySelector('[data-prospect-employees]')?.textContent).toContain(
      '51-200 employees',
    )

    // The research pass has written this under both names; the panel must read
    // the same pair the row read, or a candidate loses its headcount by moving
    // between the two surfaces.
    await render({ ...SCORED, research: { employee_count_range: '1000+' } })
    expect(container.querySelector('[data-prospect-employees]')?.textContent).toContain(
      '1000+ employees',
    )

    await render({ ...SCORED, research: null })
    expect(container.querySelector('[data-prospect-employees]')).toBeNull()
  })
})
