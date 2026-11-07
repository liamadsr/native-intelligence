// @vitest-environment jsdom
/**
 * The lists index EMPTY STATE — the one screen that earns the whole pre-fill
 * wedge (§4, §10 Page 1).
 *
 * Three states, each with a different consequence if it regresses:
 *
 *  1. A carded company renders the sentence "You sell <what_we_sell> to
 *     <target_customer>. Who should we find?" plus the four starter cards. If
 *     this breaks the user is asked to describe their own business, which is
 *     exactly what the pre-fill exists to avoid.
 *  2. An UNCARDED company must NOT present a purpose template as if it were
 *     knowledge about the business — the "to …" half only renders when the
 *     description actually came from the company profile — and must offer the
 *     quiet "Research my company" action.
 *  3. NO source company at all gets the §10 "We don't know your company yet"
 *     state. This one is explicitly REQUIRED rather than optional: company
 *     enrichment has hung in production before, and on exactly those
 *     workspaces the whole wedge evaporates.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The detail page pulls in UnifiedViewLayout and the company panel; the index
// branch never renders it, and stubbing keeps this suite about the empty state.
vi.mock('../list-detail', () => ({ ListDetail: () => null }))

const fetchLists = vi.fn(async () => [] as unknown[])
const fetchSource = vi.fn()
const researchSource = vi.fn()
const saveCompanyDescription = vi.fn()
const createList = vi.fn()
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    fetchLists: () => fetchLists(),
    fetchSource: () => fetchSource(),
    researchSource: (domain?: string | null) => researchSource(domain),
    saveCompanyDescription: (id: string, description: string) =>
      saveCompanyDescription(id, description),
    createList: (body: unknown) => createList(body),
  }
})

import { ProspectingRequestError } from '../api'
import { ProspectingView } from '../prospecting-view'
import {
  CARDED_COMPANY,
  ENRICHING_COMPANY,
  LIST,
  NO_WHAT_WE_SELL_COMPANY,
  UNCARDED_COMPANY,
  sourcePayload,
} from './fixtures'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  fetchLists.mockClear().mockResolvedValue([])
  fetchSource.mockReset()
  researchSource.mockReset()
  saveCompanyDescription.mockReset().mockResolvedValue(undefined)
  createList.mockReset()
  vi.useRealTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const noop = () => {}

async function render() {
  await act(async () => {
    root.render(
      <ProspectingView listId={null} onOpenList={noop} onCloseDetail={noop} />,
    )
  })
  // One extra flush: the lists and the source resolve on separate promises.
  await act(async () => {})
}

function text() {
  return container.textContent ?? ''
}

function buttonWithText(needle: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes(needle),
  )
}

function domainInput(): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>('#prospecting-source-domain')
}

/** React owns the value property on a controlled input, so a bare `.value =`
 *  is swallowed by its own change detection. Go through the prototype setter. */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function click(el: Element) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

describe('Prospecting empty state', () => {
  it('renders the pre-filled company sentence and the four starter cards', async () => {
    fetchSource.mockResolvedValue(sourcePayload(CARDED_COMPANY))
    await render()

    expect(text()).toContain('You sell')
    expect(text()).toContain('revenue teams at 20–500 person B2B software companies')
    expect(text()).toContain('Who should we find?')

    for (const label of ['Customers', 'Investors', 'Partners']) {
      expect(buttonWithText(label), `starter card: ${label}`).toBeTruthy()
    }
    // Custom is a card with an inline box rather than a button, so it is
    // asserted by its own field.
    expect(container.querySelector('#prospecting-custom-target')).toBeTruthy()
    // The card is present, so the quiet refresh is not offered.
    expect(buttonWithText('Research my company')).toBeUndefined()
  })

  it('opens the New-list sheet pre-filled for the starter card that was pressed', async () => {
    fetchSource.mockResolvedValue(sourcePayload(CARDED_COMPANY))
    await render()

    await act(async () => {
      buttonWithText('Investors')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const sheet = document.querySelector('[aria-label="New prospect list"]')
    expect(sheet).toBeTruthy()
    // The investors template pressed 'Partner'/'Principal' buyer titles and
    // deliberately CLEARED the card's sales-shaped target description.
    expect(sheet!.textContent).toContain('Partner')
    expect(sheet!.textContent).toContain('Principal')
  })

  it('offers Research my company, and never presents a template as knowledge, when the card has not run', async () => {
    fetchSource.mockResolvedValue(sourcePayload(UNCARDED_COMPANY))
    researchSource.mockResolvedValue({
      ...sourcePayload(CARDED_COMPANY),
      enrichment: 'already' as const,
    })
    await render()

    // The company IS known, so the sentence still leads with what it sells —
    // but the "to <target customer>" half comes only from the card.
    expect(text()).toContain('Who should we find?')
    expect(text()).not.toContain('revenue teams at 20–500 person B2B software companies')

    const research = buttonWithText('Research my company')
    expect(research).toBeTruthy()

    await act(async () => {
      research!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {})

    expect(researchSource).toHaveBeenCalledTimes(1)
    // Re-rendered from the refreshed source, card answers now in place.
    expect(text()).toContain('revenue teams at 20–500 person B2B software companies')
  })

  it('renders the required no-source-company state with a usable domain input', async () => {
    // THE PRODUCTION BUG. Before the input existed this card rendered a button
    // that posted nothing actionable and returned a null source, so the screen
    // never changed and there was no way to type a domain at all.
    fetchSource.mockResolvedValue(sourcePayload(null))
    await render()

    expect(text()).toContain("We don't know your company yet")
    expect(text()).toContain("Your company's website")
    expect(domainInput()).toBeTruthy()
    // No starter cards: there is nothing to seed them from yet.
    expect(buttonWithText('Customers')).toBeUndefined()
  })

  it('pre-fills the domain from suggested_domain and labels the button as a confirmation', async () => {
    // A business signup should press ONE button. `suggested_domain` is
    // companyDomainFromEmail(liam@dial8.ai) — the exact case that shipped
    // broken — and a pre-filled field means the verb is "research", not "use".
    fetchSource.mockResolvedValue(sourcePayload(null, 'dial8.ai'))
    await render()

    expect(domainInput()!.value).toBe('dial8.ai')
    expect(buttonWithText('Research my company')).toBeTruthy()
    expect(buttonWithText('Use this company')).toBeUndefined()
  })

  it('offers "Use this company" when there is nothing to suggest', async () => {
    // A personal/webmail signup gets `suggested_domain: null`, so the user is
    // telling us something we do not know rather than confirming a guess.
    fetchSource.mockResolvedValue(sourcePayload(null))
    await render()

    expect(domainInput()!.value).toBe('')
    expect(buttonWithText('Use this company')).toBeTruthy()
  })

  it('POSTs the typed domain and renders the company card plus the researching line', async () => {
    fetchSource.mockResolvedValue(sourcePayload(null))
    // The route establishes the row and kicks the full enrichment; the ICP
    // card has NOT landed yet, which is what the researching line is for.
    researchSource.mockResolvedValue({
      ...sourcePayload(UNCARDED_COMPANY),
      established: true,
      enrichment: 'started' as const,
    })
    await render()

    await act(async () => typeInto(domainInput()!, 'dial8.ai'))
    await act(async () => click(buttonWithText('Use this company')!))
    await act(async () => {})

    expect(researchSource).toHaveBeenCalledWith('dial8.ai')
    // The card re-rendered off the established company…
    expect(text()).toContain('Who should we find?')
    // …and says, quietly, WHAT is still running and roughly how long.
    expect(text()).toContain('Researching dial8.ai')
    expect(text()).toContain('reading your site for what you sell and who buys it')
    expect(text()).toContain('about a minute')
  })

  it('does not claim to be researching when the server says the row was already enriched', async () => {
    // A line that never resolves is worse than no line: `enrichment: 'already'`
    // means nothing new started, so nothing new should be promised.
    fetchSource.mockResolvedValue(sourcePayload(null))
    researchSource.mockResolvedValue({
      ...sourcePayload(CARDED_COMPANY),
      established: true,
      enrichment: 'already' as const,
    })
    await render()

    await act(async () => typeInto(domainInput()!, 'dial8.ai'))
    await act(async () => click(buttonWithText('Use this company')!))
    await act(async () => {})

    expect(text()).not.toContain('Researching')
  })

  it('renders PERSONAL_DOMAIN inline beside the field, not as a page error', async () => {
    fetchSource.mockResolvedValue(sourcePayload(null))
    researchSource.mockRejectedValue(
      new ProspectingRequestError({
        message: 'Personal email domain',
        code: 'PERSONAL_DOMAIN',
        details: null,
        status: 400,
      }),
    )
    await render()

    await act(async () => typeInto(domainInput()!, 'gmail.com'))
    await act(async () => click(buttonWithText('Use this company')!))
    await act(async () => {})

    expect(text()).toContain(
      "That looks like a personal email domain — enter your company's website",
    )
    // The field stays open and keeps what was typed: the correction is one
    // edit away, which is the whole reason this is not a toast.
    expect(domainInput()!.value).toBe('gmail.com')
  })

  it('maps INVALID_DOMAIN and NEEDS_DOMAIN to their own inline messages', async () => {
    fetchSource.mockResolvedValue(sourcePayload(null))
    researchSource.mockRejectedValue(
      new ProspectingRequestError({
        message: 'Bad domain',
        code: 'INVALID_DOMAIN',
        details: null,
        status: 400,
      }),
    )
    await render()

    await act(async () => typeInto(domainInput()!, 'not a domain'))
    await act(async () => click(buttonWithText('Use this company')!))
    await act(async () => {})

    expect(text()).toContain("That doesn't look like a website")
  })

  it('reveals the same domain input from "Not your company?" on the company card', async () => {
    // The re-point path (§4). Until now the only remedy named was "correct it
    // on the company record in your CRM", which does not clear the flag.
    fetchSource.mockResolvedValue(sourcePayload(CARDED_COMPANY))
    researchSource.mockResolvedValue({
      ...sourcePayload(CARDED_COMPANY),
      established: true,
      enrichment: 'started' as const,
    })
    await render()

    expect(domainInput()).toBeNull()

    await act(async () => click(buttonWithText('Not your company?')!))
    expect(domainInput()).toBeTruthy()

    await act(async () => typeInto(domainInput()!, 'other.com'))
    await act(async () => click(buttonWithText('Use this company')!))
    await act(async () => {})

    expect(researchSource).toHaveBeenCalledWith('other.com')
  })

  it('closes the correction panel once the re-point lands', async () => {
    // A re-point that WORKED must not look identical to one that did nothing.
    // Leaving the field open over the freshly-updated card is exactly that,
    // and a second Enter on the still-open field re-POSTs the same domain.
    fetchSource.mockResolvedValue(sourcePayload(CARDED_COMPANY))
    researchSource.mockResolvedValue({
      ...sourcePayload(CARDED_COMPANY),
      established: true,
      enrichment: 'started' as const,
    })
    await render()

    await act(async () => click(buttonWithText('Not your company?')!))
    await act(async () => typeInto(domainInput()!, 'other.com'))
    await act(async () => click(buttonWithText('Use this company')!))
    await act(async () => {})

    expect(domainInput()).toBeNull()
  })

  it('leaves the correction panel open when the re-point was refused', async () => {
    // The mirror of the above: a 400 is a correction the user makes IN the
    // field, so closing it would throw away what they typed.
    fetchSource.mockResolvedValue(sourcePayload(CARDED_COMPANY))
    researchSource.mockRejectedValue(
      new ProspectingRequestError({
        message: 'personal',
        code: 'PERSONAL_DOMAIN',
        details: null,
        status: 400,
      }),
    )
    await render()

    await act(async () => click(buttonWithText('Not your company?')!))
    await act(async () => typeInto(domainInput()!, 'gmail.com'))
    await act(async () => click(buttonWithText('Use this company')!))
    await act(async () => {})

    expect(domainInput()).toBeTruthy()
    expect(domainInput()!.value).toBe('gmail.com')
    expect(text()).toContain('That looks like a personal email domain')
  })

  /**
   * The wedge YIELDS once a list exists — and what it yields to is now the
   * views list, not a card grid.
   *
   * The counts and the run line that used to be asserted here moved with the
   * cards: they are the row's content, pinned by
   * `src/components/views/__tests__/prospect-list-row.test.tsx` against the
   * real `entry_counts` and embedded-run shapes. What this suite still owns is
   * the DECISION — that the empty state disappears — because that is the one
   * thing the layout cannot decide from inside itself.
   */
  it('yields to the lists view once a list exists', async () => {
    fetchSource.mockResolvedValue(sourcePayload(CARDED_COMPANY))
    fetchLists.mockResolvedValue([
      {
        id: 'list-1',
        name: 'Customers like us',
        purpose: 'buyers',
        updated_at: new Date().toISOString(),
        entry_counts: {
          discovered: 8,
          shortlisted: 0,
          saved: 3,
          saved_people: 2,
          dismissed: 1,
          total: 12,
        },
      },
    ])
    await render()

    expect(text()).not.toContain('Who should we find?')
    // The header survives the swap — it draws the nav toggle, and losing it
    // is a documented historical bug on this page.
    expect(text()).toContain('Prospecting')
  })

  it('keeps polling while the ICP card has landed but the enrichment has not', async () => {
    // THE BUG LIAM HIT. The card is a $0.012 side search that lands in seconds;
    // the enrichment that writes `description` — the entire "You sell X" half —
    // runs on for another minute. Stopping on the card alone left the spinner
    // gone and the line stale, with nothing on screen ever changing again.
    vi.useFakeTimers()
    fetchSource.mockResolvedValue(sourcePayload(null))
    researchSource.mockResolvedValue({
      ...sourcePayload(ENRICHING_COMPANY),
      established: true,
      enrichment: 'started' as const,
    })
    await render()

    await act(async () => typeInto(domainInput()!, 'dial8.ai'))
    await act(async () => click(buttonWithText('Use this company')!))
    await act(async () => {})
    expect(text()).toContain('Researching dial8.ai')

    // Tick 1: the CARD has landed, but enrichment_status is still 'pending'.
    fetchSource.mockResolvedValue(
      sourcePayload({ ...CARDED_COMPANY, enrichment_status: 'pending' }),
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(text()).toContain('Researching dial8.ai')

    // Tick 2: enrichment is terminal too — NOW the line stops, and the card
    // has the fresh answers on it.
    fetchSource.mockResolvedValue(sourcePayload(CARDED_COMPANY))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(text()).not.toContain('Researching dial8.ai')
    expect(text()).toContain('revenue teams at 20–500 person B2B software companies')
    vi.useRealTimers()
  })

  it('stops with a Refresh rather than vanishing when three minutes pass', async () => {
    // A spinner that simply disappears with the line still empty is the
    // original complaint minus the spinner. The cap has to SAY it gave up.
    vi.useFakeTimers()
    fetchSource.mockResolvedValue(sourcePayload(null))
    researchSource.mockResolvedValue({
      ...sourcePayload(ENRICHING_COMPANY),
      established: true,
      enrichment: 'started' as const,
    })
    await render()

    await act(async () => typeInto(domainInput()!, 'dial8.ai'))
    await act(async () => click(buttonWithText('Use this company')!))
    await act(async () => {})

    // Never goes terminal.
    fetchSource.mockResolvedValue(sourcePayload(ENRICHING_COMPANY))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000 + 5000)
    })

    expect(text()).not.toContain('reading your site for what you sell')
    expect(text()).toContain('Still researching — check back in a minute')

    // Refresh is a re-READ, not a re-POST: the job is still queued server-side
    // and a second POST would answer 'already' while looking like an action.
    fetchSource.mockClear().mockResolvedValue(sourcePayload(CARDED_COMPANY))
    await act(async () => click(buttonWithText('Refresh')!))
    await act(async () => {})
    expect(fetchSource).toHaveBeenCalled()
    expect(researchSource).toHaveBeenCalledTimes(1)
    expect(text()).toContain('revenue teams at 20–500 person B2B software companies')
    vi.useRealTimers()
  })

  it('asks what you sell, inline, when the enrichment finished and could not tell', async () => {
    // Replaces "We know your company, but not yet what it sells" — a statement
    // about our own failure, with nothing the user could do about it, shown at
    // the exact moment they were waiting to be asked something.
    fetchSource.mockResolvedValue(sourcePayload(NO_WHAT_WE_SELL_COMPANY))
    await render()

    expect(text()).not.toContain('We know your company but not yet what it sells')
    expect(text()).toContain("We found")
    expect(text()).toContain("couldn't tell what you sell")
    expect(text()).toContain('Tell us in a sentence')

    const input = container.querySelector<HTMLInputElement>('#prospecting-what-we-sell')
    expect(input).toBeTruthy()

    // Saving PATCHes the company DESCRIPTION, which is buildIcpDraft's second
    // `what_we_sell` source — so the re-read comes back with every purpose's
    // draft re-seeded, not just this card's sentence.
    fetchSource.mockResolvedValue(sourcePayload(CARDED_COMPANY))
    await act(async () => typeInto(input!, 'an AI meeting-capture and CRM workspace'))
    await act(async () => click(buttonWithText('Save')!))
    await act(async () => {})

    expect(saveCompanyDescription).toHaveBeenCalledWith(
      'company-1',
      'an AI meeting-capture and CRM workspace',
    )
    expect(text()).toContain('You sell')
    expect(container.querySelector('#prospecting-what-we-sell')).toBeNull()
  })

  it('does not ask what you sell while the research is still running', async () => {
    // Asking for something a job is about to supply, while telling the user
    // that job is running, is two contradictory requests on one card.
    fetchSource.mockResolvedValue(sourcePayload(null))
    researchSource.mockResolvedValue({
      ...sourcePayload(ENRICHING_COMPANY),
      established: true,
      enrichment: 'started' as const,
    })
    await render()

    await act(async () => typeInto(domainInput()!, 'dial8.ai'))
    await act(async () => click(buttonWithText('Use this company')!))
    await act(async () => {})

    expect(text()).toContain('Researching dial8.ai')
    expect(container.querySelector('#prospecting-what-we-sell')).toBeNull()
  })

  it('creates and opens a custom list from the inline box, without the sheet', async () => {
    // "I clicked Investors and it opened the side panel — what was the point of
    // selecting it from there?" Custom seeds NOTHING, so its sheet was a form
    // asking exactly what this one line asks.
    fetchSource.mockResolvedValue(sourcePayload(CARDED_COMPANY))
    createList.mockResolvedValue({ ...LIST, id: 'list-9', name: 'companies with big sales teams' })
    const onOpenList = vi.fn()
    await act(async () => {
      root.render(
        <ProspectingView listId={null} onOpenList={onOpenList} onCloseDetail={noop} />,
      )
    })
    await act(async () => {})

    const box = container.querySelector<HTMLInputElement>('#prospecting-custom-target')!
    await act(async () => typeInto(box, 'companies with big sales teams'))
    await act(async () => click(buttonWithText('Find')!))
    await act(async () => {})

    expect(createList).toHaveBeenCalledTimes(1)
    const body = createList.mock.calls[0][0] as {
      name: string
      purpose: string
      icp: {
        target: { description: string }
        source: { what_we_sell: string; domain: string }
      }
    }
    expect(body.name).toBe('companies with big sales teams')
    expect(body.purpose).toBe('custom')
    expect(body.icp.target.description).toBe('companies with big sales teams')
    // The SAME custom draft the sheet would have used — seeded source fields
    // intact, so the list's ICP chip afterwards shows this exact object rather
    // than something the inline path invented. (WHICH source field wins for
    // `what_we_sell` is `buildIcpDraft`'s business and is pinned in icp.test.ts;
    // what matters here is that the inline path did not blank it.)
    expect(body.icp.source.domain).toBe('dial8.ai')
    expect(body.icp.source.what_we_sell).not.toBe('')
    // Straight into the list. No sheet.
    expect(onOpenList).toHaveBeenCalledWith('list-9', 'companies with big sales teams')
    expect(document.querySelector('[aria-label="New prospect list"]')).toBeNull()
  })

  it('trims a pasted paragraph to 60 characters for the list name', async () => {
    // A list is found again by its name in a sidebar; a paragraph pasted from a
    // doc is a target description, not a label.
    const long = 'companies with big sales teams that already run outbound and have raised a Series B'
    fetchSource.mockResolvedValue(sourcePayload(CARDED_COMPANY))
    createList.mockResolvedValue({ ...LIST, id: 'list-9', name: long.slice(0, 60) })
    await render()

    const box = container.querySelector<HTMLInputElement>('#prospecting-custom-target')!
    await act(async () => typeInto(box, long))
    await act(async () => click(buttonWithText('Find')!))
    await act(async () => {})

    const body = createList.mock.calls[0][0] as {
      name: string
      icp: { target: { description: string } }
    }
    expect(body.name).toBe(long.slice(0, 60))
    expect(body.name.length).toBe(60)
    // The full text still reaches the ICP — only the LABEL is capped.
    expect(body.icp.target.description).toBe(long)
  })

  it('keeps a full editor within one click of the Custom card', async () => {
    // Nothing is removed: the sheet is still there for anyone who wants it,
    // and the created list's own ICP chip opens the same editor.
    fetchSource.mockResolvedValue(sourcePayload(CARDED_COMPANY))
    await render()

    await act(async () => click(buttonWithText('Open full editor')!))
    const sheet = document.querySelector('[aria-label="New prospect list"]')
    expect(sheet).toBeTruthy()
    expect(sheet!.textContent).toContain('Custom — review who to find')
  })

  it('says on every template card why it leads to a sheet', async () => {
    // The card → sheet step has to read as REVIEW, not as being asked the same
    // question twice.
    fetchSource.mockResolvedValue(sourcePayload(CARDED_COMPANY))
    await render()

    for (const label of ['Customers', 'Investors', 'Partners']) {
      expect(buttonWithText(label)!.textContent, label).toContain(
        'Pre-fills who to find from your profile · edit before the first search',
      )
    }
  })

  it('writes every starter card in plain second person', async () => {
    fetchSource.mockResolvedValue(sourcePayload(CARDED_COMPANY))
    await render()

    expect(buttonWithText('Customers')!.textContent).toContain(
      'Companies like the ones that already buy from you',
    )
    expect(buttonWithText('Investors')!.textContent).toContain(
      'Funds that back companies like yours',
    )
    expect(buttonWithText('Partners')!.textContent).toContain(
      'Companies whose products complement yours',
    )
    expect(text()).toContain("Tell us who you're looking for")
    // The first-person plural title is gone from every surface.
    expect(text()).not.toContain('Customers like us')
  })

  it('tags Investors as experimental and leaves the other starters alone', async () => {
    // Fund discovery leans on the portfolio comparables the user listed (§7's
    // investor angles cite `comparables`), so results are only as good as that
    // list — and nobody has run it at volume. Saying so costs one word and
    // buys the honest expectation; learning it from twenty bad funds costs the
    // user their trust in the three templates that DO work.
    fetchSource.mockResolvedValue(sourcePayload(CARDED_COMPANY))
    await render()

    const investors = buttonWithText('Investors')
    expect(investors).toBeTruthy()
    expect(investors!.textContent).toContain('Experimental')
    expect(investors!.querySelector('[title]')?.getAttribute('title')).toBe(
      'Fund discovery is unproven; results lean on portfolio comparables you list',
    )

    expect(buttonWithText('Customers')!.textContent).not.toContain('Experimental')
    expect(buttonWithText('Partners')!.textContent).not.toContain('Experimental')
  })
})
