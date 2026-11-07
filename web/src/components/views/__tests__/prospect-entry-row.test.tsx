// @vitest-environment jsdom
/**
 * The prospect candidate row (§10, "Row anatomy").
 *
 * THE BUG THIS SUITE FENCES, observed on the first real run: `fit_rationale`
 * is a SENTENCE. Rendered through the generic `title + right-aligned chip
 * strip` layout it had no width of its own and took the whole row, squeezing
 * the `flex-1 truncate` company name down to a single letter — Querylane rendered
 * as "Q…". A prospect list whose company names are illegible is not a
 * prospect list, so three of the assertions below are about width contracts
 * rather than content:
 *
 *   1. the NAME is never empty (name → domain → candidate_key → a literal),
 *   2. the name cell carries a MIN-WIDTH and does not carry `flex-1`,
 *   3. the rationale carries `min-w-0` + `truncate` and the full text on hover.
 *
 * Those three are now asserted under an EXPLICIT `displayProperties` that
 * includes "Why", because the row's DEFAULT is slim: favicon · name · score ·
 * stage. The reasoning strip (rationale, employee range, citation) moved into
 * the detail panel beside the list and the picker's "Why" tick brings it back
 * inline, so this suite pins BOTH shapes — what the default row shows, and
 * that nothing was lost when it slimmed.
 *
 * THE SCORE SLOT is the other thing pinned here: a profiled row shows the
 * full profile's 0–100 rating and its word; a row nobody has profiled shows
 * the Enrich button in the same slot (discovery does not score — fit.ts).
 *
 * And one about honesty: a `result_entity` candidate was lifted free from
 * Exa's `results[].entities[]` and carries a DESCRIPTION, not a judgement
 * about fit. It is labelled "About" and its matched-signal chips are withheld,
 * because presenting a company's own marketing copy as our reasoning is the
 * thing the fit block exists to avoid.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The orb is a canvas animation; jsdom has no 2d context. A stub that keeps
// the state name is enough to assert WHICH orb a row draws.
vi.mock('thinking-orbs', () => ({
  ThinkingOrb: (props: { state: string }) => <span data-orb={props.state} />,
}))

import {
  EntityRow,
  getTitle,
  PROSPECT_ENTRY_ACTION_EVENT,
  type ProspectEntryActionDetail,
} from '@/components/views/list/entity-row'
import { DEFAULT_DISPLAY_PROPERTIES } from '@/lib/views/types'
import {
  ProspectListActivityContext,
  type ProspectListActivity,
} from '@/lib/prospecting/list-activity'

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

/** The picker state that restores the pre-slim row: everything the default
 *  drops, back inline. Used by every assertion about the reasoning strip. */
const WITH_WHY = ['fit_score', 'fit_rationale', 'stage']

const LONG_RATIONALE =
  'Builds a real-time analytics database used by engineering teams at mid-market ' +
  'B2B software companies, which is exactly the buyer profile in your ICP, and ' +
  'they publicly list a revenue operations function.'

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'entry-1',
    list_id: 'list-1',
    kind: 'company',
    candidate_key: 'querylane.io',
    candidate: { name: 'Querylane', domain: 'querylane.io', found_via: 'synthesized' },
    stage: 'discovered',
    identity_state: 'resolved',
    fit_score: 88,
    fit_rationale: LONG_RATIONALE,
    research: null,
    ...overrides,
  }
}

async function render(
  item: Record<string, unknown>,
  displayProperties: string[] = DEFAULT_DISPLAY_PROPERTIES.prospect_list_entry,
) {
  await act(async () => {
    root.render(
      <EntityRow
        item={item}
        entityType="prospect_list_entry"
        displayProperties={displayProperties}
        isSelected={false}
        onItemSelect={() => {}}
      />,
    )
  })
}

function text() {
  return container.textContent ?? ''
}

/** The element carrying the candidate's own name — the one that must never
 *  collapse. Addressed by a data attribute rather than by class, so the
 *  width-contract assertions below read the classes they are actually about. */
function nameEl(): HTMLElement {
  return container.querySelector('[data-prospect-name]') as HTMLElement
}

/** The rationale is identified by its title attribute carrying the full text —
 *  which is itself half the contract (hover reveals what truncation hid). */
function rationaleEl(): HTMLElement | null {
  return container.querySelector(`[title="${LONG_RATIONALE}"]`) as HTMLElement | null
}

function scoreChip(): HTMLElement | null {
  return container.querySelector('[data-fit-score]') as HTMLElement | null
}

function findPeopleButton(): HTMLButtonElement | null {
  return container.querySelector('button[data-prospect-find-people]') as HTMLButtonElement | null
}

/** Render under a live-run context, the way the list page provides one. */
async function renderWithActivity(
  item: Record<string, unknown>,
  activity: ProspectListActivity,
  displayProperties: string[] = DEFAULT_DISPLAY_PROPERTIES.prospect_list_entry,
) {
  await act(async () => {
    root.render(
      <ProspectListActivityContext.Provider value={activity}>
        <EntityRow
          item={item}
          entityType="prospect_list_entry"
          displayProperties={displayProperties}
          isSelected={false}
          onItemSelect={() => {}}
        />
      </ProspectListActivityContext.Provider>,
    )
  })
}

/** The leading glyph: the company's own favicon, or the tinted telescope it
 *  falls back to when there is no domain (or the image fails). */
function favicon(): HTMLImageElement | null {
  return container.querySelector('[data-prospect-favicon]') as HTMLImageElement | null
}

function faviconFallback(): HTMLElement | null {
  return container.querySelector('[data-prospect-favicon-fallback]') as HTMLElement | null
}

describe('prospect_list_entry row — the name never collapses', () => {
  it('falls back name → domain → candidate_key, and never renders empty', async () => {
    await render(row())
    expect(nameEl().textContent).toBe('Querylane')

    await render(row({ candidate: { name: null, domain: 'querylane.io' } }))
    expect(nameEl().textContent).toBe('querylane.io')

    await render(row({ candidate: { name: null, domain: null } }))
    expect(nameEl().textContent).toBe('querylane.io') // the candidate_key

    await render(row({ candidate: {}, candidate_key: '' }))
    expect(nameEl().textContent).toBe('Unknown candidate')
    expect(nameEl().textContent!.trim()).not.toBe('')
  })

  it('gives the name cell a min-width and denies it flex-1, so the sentence yields first', async () => {
    await render(row(), WITH_WHY)
    const cell = container.querySelector('[data-prospect-identity]') as HTMLElement
    // A minimum the name is measured against — without one the flex line lets
    // it go to zero, which is the reported "Q…" bug.
    expect(cell.className).toMatch(/min-w-\[/)
    // The rationale, NOT the name, is the flexible one.
    expect(cell.className).not.toContain('flex-1')
    // And it may only truncate its own text, never disappear.
    expect(nameEl().className).toContain('truncate')
  })

  it('truncates the rationale with the full text on hover', async () => {
    await render(row(), WITH_WHY)
    const el = rationaleEl()
    expect(el).toBeTruthy()
    expect(el!.className).toContain('truncate')
    expect(el!.className).toContain('min-w-0')
    // Its container is the one that flexes.
    expect((el!.parentElement as HTMLElement).className).toContain('flex-1')
    expect(el!.getAttribute('title')).toBe(LONG_RATIONALE)
  })

  it('lets the domain shrink so a long one cannot outrank the name it annotates', async () => {
    await render(
      row({
        candidate: {
          name: 'A Very Long Company Name Incorporated',
          domain: 'verylongcompanyname.example.com',
        },
      }),
    )
    const domain = Array.from(container.querySelectorAll('span')).find(
      (s) => s.textContent === 'verylongcompanyname.example.com',
    )!
    // Measured in a real browser: `shrink-0` here gave the name 56px of a
    // 256px cell; shrinking + capping the domain gives it 159px.
    expect(domain.className).toContain('shrink')
    expect(domain.className).not.toContain('shrink-0')
    expect(domain.className).toContain('truncate')
    expect(domain.className).toMatch(/max-w-\[/)
  })

  it('renders the domain beside the name, and says so when there is none', async () => {
    await render(row())
    expect(text()).toContain('querylane.io')

    await render(
      row({
        candidate: { name: 'Querylane' },
        candidate_key: 'imply',
        identity_state: 'unresolved',
      }),
    )
    expect(text()).toContain('no domain found')
  })
})

describe('prospect_list_entry row — the score slot', () => {
  it('renders the score and its word, coloured by band, with the long form as the label', async () => {
    await render(row({ fit_score: 88 }))
    expect(scoreChip()!.textContent).toBe('88match score')
    expect(scoreChip()!.getAttribute('data-fit-score')).toBe('88')
    expect(scoreChip()!.getAttribute('data-fit-label')).toBe('strong')
    expect(scoreChip()!.getAttribute('aria-label')).toBe('Match score 88 of 100 · Strong match')
    expect(scoreChip()!.className).toContain('emerald')

    await render(row({ fit_score: 12 }))
    expect(scoreChip()!.textContent).toBe('12match score')
    expect(scoreChip()!.className).toContain('muted')
  })

  it('offers Find people beside the score for a scored company with no people yet', async () => {
    await render(row({ fit_score: 88 }))
    const button = findPeopleButton()!
    expect(button).toBeTruthy()
    expect(button.textContent).toContain('Find people')
    expect(button.getAttribute('aria-label')).toBe('Find people at Querylane')
    // Never an Enrich button on a row: the profile runs by itself now.
    expect(container.querySelector('button[data-prospect-enrich]')).toBeNull()
  })

  it('Find people emits a people intent for this entry and never activates the row', async () => {
    const seen: ProspectEntryActionDetail[] = []
    const onAction = (e: Event) => seen.push((e as CustomEvent<ProspectEntryActionDetail>).detail)
    window.addEventListener(PROSPECT_ENTRY_ACTION_EVENT, onAction)
    const onItemSelect = vi.fn()
    try {
      await act(async () => {
        root.render(
          <EntityRow
            item={row({ fit_score: 88 })}
            entityType="prospect_list_entry"
            displayProperties={DEFAULT_DISPLAY_PROPERTIES.prospect_list_entry}
            isSelected={false}
            onItemSelect={onItemSelect}
          />,
        )
      })
      act(() => {
        findPeopleButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(seen).toEqual([{ action: 'people', entryIds: ['entry-1'] }])
      expect(onItemSelect).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(PROSPECT_ENTRY_ACTION_EVENT, onAction)
    }
  })

  it('withholds Find people once the company has people, on a dismissed row, and without a score', async () => {
    await render(row({ fit_score: 88, children: [{ id: 'p1', kind: 'person' }] }))
    expect(findPeopleButton()).toBeNull()

    await render(row({ fit_score: 88, stage: 'dismissed' }))
    expect(findPeopleButton()).toBeNull()

    await render(row({ fit_score: null }))
    expect(findPeopleButton()).toBeNull()
  })

  it('keeps Find people in place but greyed out while a discovery or profile run is live — it never vanishes from the row', async () => {
    // One live run per list, so the button cannot start anything — but a
    // button that disappears from every other row the moment one is pressed
    // reads as the layout breaking (Liam, 2026-09-06). It stays, disabled,
    // and says why. (A live PEOPLE run is different: the button joins it —
    // see the orb tests below.)
    await renderWithActivity(row({ fit_score: 88 }), { runLive: true, profiling: false, findingPeople: null })
    const button = findPeopleButton()!
    expect(button).toBeTruthy()
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('title')).toContain('One search at a time')
    expect(scoreChip()!.textContent).toBe('88match score')

    // The profile run counts too: a scored row mid hand-off waits its turn.
    await renderWithActivity(row({ fit_score: 88 }), { runLive: true, profiling: true, findingPeople: null })
    expect(findPeopleButton()!.disabled).toBe(true)

    // Idle again: live, and back to its own title.
    await render(row({ fit_score: 88 }))
    expect(findPeopleButton()!.disabled).toBe(false)
    expect(findPeopleButton()!.getAttribute('title')).toBe('Find the people to contact at Querylane')
  })

  /** The page's context while a people run that targets THIS row is live. */
  const PEOPLE_RUN: ProspectListActivity = {
    runLive: true,
    profiling: false,
    findingPeople: { ids: new Set(['entry-1']), since: '2026-09-06T10:00:00.000Z' },
  }

  function orb(): HTMLElement | null {
    return container.querySelector('[data-prospect-finding-people]') as HTMLElement | null
  }

  it('swaps Find people for the searching orb while the live people run targets this row', async () => {
    await renderWithActivity(row({ fit_score: 88 }), PEOPLE_RUN)
    expect(findPeopleButton()).toBeNull()
    expect(orb()).toBeTruthy()
    expect(orb()!.getAttribute('aria-label')).toBe('Finding people at Querylane')
    // The rail's own orb, not a spinner — "that search globe icon thing"
    // (Liam, 2026-09-06), on the row the user pressed.
    expect(orb()!.querySelector('[data-orb="searching"]')).toBeTruthy()
    // The score stays beside it.
    expect(scoreChip()!.textContent).toBe('88match score')
  })

  it('takes the orb off once people land, or the engine stamps this search as over — an older stamp does not count', async () => {
    // People landed: nothing left to search for, nothing to offer.
    await renderWithActivity(
      row({ fit_score: 88, children: [{ id: 'p1', kind: 'person' }] }),
      PEOPLE_RUN,
    )
    expect(orb()).toBeNull()
    expect(findPeopleButton()).toBeNull()

    // Searched during this run and nobody found: the orb comes off, and the
    // button is back — greyed out, because the running search will not do
    // this company twice. The stamp is in Postgres' own offset form, the
    // run's start in JS ISO form — the row compares instants, not strings.
    await renderWithActivity(
      row({
        fit_score: 88,
        candidate: {
          name: 'Querylane',
          domain: 'querylane.io',
          people_searched_at: '2026-09-06T10:00:30+00:00',
        },
      }),
      PEOPLE_RUN,
    )
    expect(orb()).toBeNull()
    expect(findPeopleButton()!.disabled).toBe(true)
    expect(findPeopleButton()!.getAttribute('title')).toContain('Searched by the run that is going')

    // A stamp from an EARLIER search: this run has not reached the row yet.
    await renderWithActivity(
      row({
        fit_score: 88,
        candidate: {
          name: 'Querylane',
          domain: 'querylane.io',
          people_searched_at: '2026-09-01T09:00:00.000Z',
        },
      }),
      PEOPLE_RUN,
    )
    expect(orb()).toBeTruthy()
  })

  it('leaves a row the people run does not target alone — no orb, and a LIVE button that joins the running search', async () => {
    // Queue-on-click: pressing Find people on another row while a people
    // search is going appends that company to it (createRun), so the button
    // stays pressable — and says what pressing it does.
    await renderWithActivity(row({ fit_score: 88 }), {
      ...PEOPLE_RUN,
      findingPeople: { ids: new Set(['someone-else']), since: PEOPLE_RUN.findingPeople!.since },
    })
    expect(orb()).toBeNull()
    expect(findPeopleButton()!.disabled).toBe(false)
    expect(findPeopleButton()!.getAttribute('title')).toContain('joins the search that is running')

    // Dismissed rows are never searched, targeted or not.
    await renderWithActivity(row({ fit_score: 88, stage: 'dismissed' }), PEOPLE_RUN)
    expect(orb()).toBeNull()
  })

  it('says "Scoring…" on an unscored row while the profile run is live', async () => {
    await renderWithActivity(row({ fit_score: null }), { runLive: true, profiling: true, findingPeople: null })
    expect(scoreChip()!.getAttribute('data-fit-score')).toBe('pending')
    expect(scoreChip()!.textContent).toContain('Scoring')
    expect(findPeopleButton()).toBeNull()
  })

  it('shows a quiet dash on an unscored row when nothing is running — or the row is dismissed', async () => {
    await render(row({ fit_score: null }))
    expect(scoreChip()!.getAttribute('data-fit-score')).toBe('none')
    expect(scoreChip()!.textContent).toBe('—')

    // A dismissed row is never "Scoring…", even mid profile run: the run
    // skipped it.
    await renderWithActivity(row({ fit_score: null, stage: 'dismissed' }), {
      runLive: true,
      profiling: true,
      findingPeople: null,
    })
    expect(scoreChip()!.getAttribute('data-fit-score')).toBe('none')
  })

  it('reads a zeroed score as a weak match, with the anti rule readable on the Why strip — and offers no Find people', async () => {
    await render(row({ fit_score: 0, fit_rationale: 'Matches excluded industry "crypto".' }), WITH_WHY)
    expect(scoreChip()!.textContent).toBe('0match score')
    expect(text()).toContain('Matches excluded industry "crypto".')
    // A 0 is the user's own rule saying never — nobody to find there.
    expect(findPeopleButton()).toBeNull()
  })

  it('links the research blob’s own citation when "Why" is on', async () => {
    await render(
      row({
        research: {
          fields: {
            why_fit: { value: 'Because', source_url: 'https://querylane.io/customers' },
          },
        },
      }),
      WITH_WHY,
    )
    const link = container.querySelector('a[href="https://querylane.io/customers"]')
    expect(link).toBeTruthy()
    expect(link!.getAttribute('rel')).toContain('noopener')
  })

  it('reads the employee range out of the research blob', async () => {
    await render(
      row({ research: { fields: { employee_range: { value: '51-200', confidence: 'high' } } } }),
      WITH_WHY,
    )
    expect(text()).toContain('51-200')
  })

  it('never renders the vocabulary migration 256 removed', async () => {
    await render(row({ fit_tier: 'A', fit_confidence: 'low', fit_signals: [{ label: 'X', met: true }] }), [
      ...WITH_WHY,
      'fit_tier',
      'fit_confidence',
    ])
    expect(container.querySelector('[data-fit-tier]')).toBeNull()
    expect(text()).not.toContain('low confidence')
    expect(text()).not.toContain('X')
    expect(scoreChip()!.textContent).toBe('88match score')
  })
})

describe('prospect_list_entry row — result_entity candidates', () => {
  it('labels the description "About" and withholds the fit chips', async () => {
    await render(
      row({
        candidate: {
          name: 'Querylane',
          domain: 'querylane.io',
          found_via: 'result_entity',
          one_liner: 'Querylane provides a real-time analytics database built on Apache Druid.',
        },
        fit_rationale: null,
        fit_signals: [{ label: 'B2B software', met: true }],
      }),
      WITH_WHY,
    )
    expect(text()).toContain('About')
    expect(text()).toContain('real-time analytics database')
    // The description is NOT our reasoning, so it makes no chip claims.
    expect(text()).not.toContain('B2B software')
  })

  it('still calls it a rationale when the run actually scored one', async () => {
    await render(
      row({ candidate: { name: 'Querylane', domain: 'querylane.io', found_via: 'synthesized' } }),
      WITH_WHY,
    )
    expect(text()).not.toContain('About')
    expect(rationaleEl()).toBeTruthy()
  })
})

describe('prospect_list_entry row — hover actions', () => {
  function press(label: string) {
    const button = container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement
    expect(button, `button: ${label}`).toBeTruthy()
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
  }

  it('emits save and dismiss intents for this entry, and never activates the row', async () => {
    const seen: ProspectEntryActionDetail[] = []
    const onAction = (e: Event) => seen.push((e as CustomEvent<ProspectEntryActionDetail>).detail)
    window.addEventListener(PROSPECT_ENTRY_ACTION_EVENT, onAction)

    const onItemSelect = vi.fn()
    await act(async () => {
      root.render(
        <EntityRow
          item={row()}
          entityType="prospect_list_entry"
          displayProperties={DEFAULT_DISPLAY_PROPERTIES.prospect_list_entry}
          isSelected={false}
          onItemSelect={onItemSelect}
        />,
      )
    })

    press('Save to list')
    press('Dismiss')
    window.removeEventListener(PROSPECT_ENTRY_ACTION_EVENT, onAction)

    expect(seen).toEqual([
      { action: 'save', entryIds: ['entry-1'] },
      { action: 'dismiss', entryIds: ['entry-1'] },
    ])
    // A hover action is not navigation.
    expect(onItemSelect).not.toHaveBeenCalled()
  })

  it('offers no Save on a saved or unresolved row, and no Dismiss on a dismissed one', async () => {
    await render(row({ stage: 'saved' }))
    expect(container.querySelector('button[aria-label="Save to list"]')).toBeNull()
    expect(container.querySelector('button[aria-label="Dismiss"]')).toBeTruthy()

    await render(row({ stage: 'dismissed' }))
    expect(container.querySelector('button[aria-label="Dismiss"]')).toBeNull()

    await render(row({ identity_state: 'unresolved', candidate: { name: 'Querylane' } }))
    expect(container.querySelector('button[aria-label="Save to list"]')).toBeNull()
  })
})

/**
 * THE PICKER MUST NOT LIE. `DISPLAY_PROPERTIES.prospect_list_entry` registers
 * nine fields, every one of which appears in the display-property picker. The
 * bespoke row body renders a fixed anatomy — which is what fixed the name
 * collapsing under a sentence-long rationale — but a body that ignored
 * `displayProperties` entirely meant ticking "Confidence" changed nothing and
 * un-ticking "Stage" still showed the stage chip: a checkbox that moves and
 * does nothing.
 *
 * The identity cell and its rationale slot stay unconditional on purpose. They
 * are what the row IS, and a candidate row with the company name switched off
 * is not a shorter row, it is an unusable one.
 */
describe('prospect row honours the display-property picker', () => {
  it('drops the score slot when Fit score is turned off — Find people included', async () => {
    await render(row(), ['stage', 'fit_rationale'])
    expect(scoreChip()).toBeNull()
    expect(findPeopleButton()).toBeNull()

    await render(row(), DEFAULT_DISPLAY_PROPERTIES.prospect_list_entry)
    expect(scoreChip()).toBeTruthy()
  })

  it('drops the stage chip when Stage is turned off, without resurrecting Dismiss', async () => {
    // The chip is display; the Dismiss/Save guards read the REAL stage, so
    // hiding the chip must not offer to dismiss an already-dismissed row.
    await render(row({ stage: 'dismissed' }), ['fit_score'])
    expect(text()).not.toContain('Dismissed')
    expect(container.querySelector('button[aria-label="Dismiss"]')).toBeNull()
  })

  it('shows the dismissal reason only when it is enabled', async () => {
    const item = row({ stage: 'dismissed', dismissed_reason: 'Too small' })

    await render(item, DEFAULT_DISPLAY_PROPERTIES.prospect_list_entry)
    expect(text()).not.toContain('Too small')

    await render(item, ['fit_score', 'fit_rationale', 'dismissed_reason'])
    expect(text()).toContain('Too small')
  })

  it('keeps the name even when every optional property is off', async () => {
    await render(row(), [])
    expect(nameEl().textContent).toBe('Querylane')
  })
})

/**
 * THE LEADING GLYPH IS THE COMPANY'S OWN FAVICON.
 *
 * A column of twenty identical telescopes carried no information: every row on
 * this page is a prospect, so an icon that says "prospect" says nothing. The
 * favicon is the one thing about a row a user recognises before reading.
 *
 * IT COMES FROM `candidate.domain`, NEVER FROM THE CITATION HOST. The trailing
 * citation link shows the favicon of the page that SURFACED the candidate — a
 * news site, a directory — and putting that in the identity slot would tell
 * the user the wrong company.
 */
describe('prospect_list_entry row — the leading favicon', () => {
  it('renders the favicon of the candidate’s OWN domain', async () => {
    await render(row())
    const img = favicon()!
    expect(img).toBeTruthy()
    expect(img.getAttribute('src')).toBe(
      'https://www.google.com/s2/favicons?domain=querylane.io&sz=32',
    )
    // Decorative: the name beside it is the accessible label for this row.
    expect(img.getAttribute('alt')).toBe('')
    expect(faviconFallback()).toBeNull()
  })

  it('never sources it from the citation host', async () => {
    // Querylane surfaced via a TechCrunch article: the leading icon is still
    // Querylane's, and techcrunch.com appears only on the (Why-gated) citation.
    await render(
      row({
        fit_signals: [
          { label: 'B2B software', met: true, evidence_url: 'https://www.techcrunch.com/x' },
        ],
      }),
      WITH_WHY,
    )
    expect(favicon()!.getAttribute('src')).toContain('domain=querylane.io')
    expect(favicon()!.getAttribute('src')).not.toContain('techcrunch')
  })

  it('falls back to the stage-tinted telescope when there is no domain', async () => {
    await render(row({ candidate: { name: 'Querylane' }, identity_state: 'unresolved' }))
    expect(favicon()).toBeNull()
    expect(faviconFallback()).toBeTruthy()

    await render(row({ candidate: { name: 'Querylane' }, stage: 'saved' }))
    expect(faviconFallback()!.getAttribute('class')).toContain('emerald')

    await render(row({ candidate: { name: 'Querylane' }, stage: 'dismissed' }))
    expect(faviconFallback()!.getAttribute('class')).toContain('muted-foreground/40')
  })

  it('falls back to the telescope when the image itself fails to load', async () => {
    // Blocked, 404, offline — a broken-image glyph in the identity column is
    // worse than the icon it replaced.
    await render(row())
    const img = favicon()!
    await act(async () => {
      img.dispatchEvent(new Event('error'))
    })
    expect(favicon()).toBeNull()
    expect(faviconFallback()).toBeTruthy()
  })

  it('gives a PERSON row an initials avatar, not a favicon', async () => {
    await render(row({ kind: 'person', candidate: { name: 'Dana Reyes', domain: 'querylane.io' } }))
    expect(favicon()).toBeNull()
    expect(faviconFallback()).toBeNull()
    expect(text()).toContain('DR')
  })
})

/**
 * THE DEFAULT ROW IS SLIM: favicon · name · grade · stage.
 *
 * The reasoning strip — the rationale sentence, the matched-signal chips, the
 * employee range, the confidence chip and the citation link — is what made a
 * 40px row unreadable. It moved to the detail panel beside the list, and the
 * picker's "Why" tick brings the whole strip back inline exactly as it was.
 * NOTHING WAS REMOVED, which is what the second half of this suite pins.
 */
describe('prospect_list_entry row — slim by default', () => {
  const LOADED = row({
    research: {
      fields: {
        employee_range: { value: '51-200' },
        why_fit: { value: 'Because', source_url: 'https://querylane.io/customers' },
      },
    },
  })

  it('reads name → score, in that order', async () => {
    await render(row())
    const identity = container.querySelector('[data-prospect-identity]') as HTMLElement
    const score = scoreChip()!
    // The score is a verdict ON the name, so it follows it.
    expect(
      identity.compareDocumentPosition(score) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('drops the rationale, the employees and the citation', async () => {
    await render(LOADED)
    expect(rationaleEl()).toBeNull()
    expect(text()).not.toContain('51-200')
    expect(container.querySelector('a[href="https://querylane.io/customers"]')).toBeNull()
  })

  it('keeps the four things the row is FOR', async () => {
    await render(row({ stage: 'saved' }))
    expect(favicon()).toBeTruthy()
    expect(nameEl().textContent).toBe('Querylane')
    expect(scoreChip()!.textContent).toBe('88match score')
    expect(text()).toContain('Saved')
  })

  it('brings the whole strip back when "Why" is ticked — nothing was lost', async () => {
    await render(LOADED, WITH_WHY)
    expect(rationaleEl()).toBeTruthy()
    expect(text()).toContain('51-200')
    expect(container.querySelector('a[href="https://querylane.io/customers"]')).toBeTruthy()
  })

  it('still keeps the hover actions on the slim row', async () => {
    await render(row())
    expect(container.querySelector('button[aria-label="Save to list"]')).toBeTruthy()
    expect(container.querySelector('button[aria-label="Dismiss"]')).toBeTruthy()
  })
})

describe('getTitle for prospect entries', () => {
  it('never returns an empty string', async () => {
    expect(getTitle('prospect_list_entry', row())).toBe('Querylane')
    expect(getTitle('prospect_list_entry', row({ candidate: { domain: 'querylane.io' } }))).toBe(
      'querylane.io',
    )
    expect(getTitle('prospect_list_entry', row({ candidate: {} }))).toBe('querylane.io')
    expect(getTitle('prospect_list_entry', row({ candidate: {}, candidate_key: '  ' }))).toBe(
      'Unknown candidate',
    )
  })
})

describe('prospect_list_entry row — the people nested beneath it', () => {
  // The views route attaches a company's people as inline `children`; the
  // list draws them as child rows and the company row says how many are there.
  const person = (id: string) => ({ id, kind: 'person', candidate: { name: id } })

  it('counts the people attached inline, and says nothing when there are none', async () => {
    await render(row({ children: [person('p1'), person('p2')] }))
    expect(container.querySelector('[data-prospect-people-count]')?.textContent).toBe('2 people')

    await render(row({ children: [person('p1')] }))
    expect(container.querySelector('[data-prospect-people-count]')?.textContent).toBe('1 person')

    await render(row({ children: [] }))
    expect(container.querySelector('[data-prospect-people-count]')).toBeNull()

    await render(row())
    expect(container.querySelector('[data-prospect-people-count]')).toBeNull()
  })
})

/**
 * "1 found, already in this list" — the engine's own stamp of what the last
 * people search saw, said on the row. Before it, a search whose every hit
 * was a duplicate left the slot empty with a Find people button, and the
 * button got pressed three times at $0.012 a go for the same person (Solenne
 * Ventures, 2026-09-07).
 */
describe('the people slot — people found, none kept', () => {
  const KNOWN_ONLY = {
    at: '2026-09-07T12:44:30.658Z',
    found: 1,
    added: 0,
    known: [{ name: 'Theo Sandford', by: 'this_list', ref_id: 'entry-theo' }],
    capped: 0,
    invalid: 0,
  }

  function knownNote(): HTMLElement | null {
    return container.querySelector('[data-prospect-people-known]') as HTMLElement | null
  }

  it('says so beside Find people, naming the person on hover', async () => {
    await render(
      row({
        candidate: { name: 'Solenne Ventures', domain: 'solennevc.co', people_search: KNOWN_ONLY },
        children: [],
      }),
    )
    const note = knownNote()
    expect(note, 'the row states what the search saw').toBeTruthy()
    expect(note!.textContent).toBe('1 found, already in this list')
    expect(note!.getAttribute('title')).toContain('Theo Sandford — already in this list')
    // A retry is still the user's call — but now a decision, not a guess.
    expect(findPeopleButton()).toBeTruthy()
  })

  it('says nothing once people sit beneath the row, or when the search kept someone', async () => {
    await render(
      row({
        candidate: { name: 'Solenne Ventures', domain: 'solennevc.co', people_search: KNOWN_ONLY },
        children: [{ id: 'p-1', kind: 'person' }],
      }),
    )
    expect(knownNote()).toBeNull()

    await render(
      row({
        candidate: {
          name: 'Solenne Ventures',
          domain: 'solennevc.co',
          people_search: { ...KNOWN_ONLY, found: 2, added: 1 },
        },
        children: [],
      }),
    )
    expect(knownNote()).toBeNull()
  })

  it('says nothing for a dismissed row, or without a stamp', async () => {
    await render(
      row({
        stage: 'dismissed',
        candidate: { name: 'Solenne Ventures', domain: 'solennevc.co', people_search: KNOWN_ONLY },
        children: [],
      }),
    )
    expect(knownNote()).toBeNull()
    await render(row({ children: [] }))
    expect(knownNote()).toBeNull()
  })
})
