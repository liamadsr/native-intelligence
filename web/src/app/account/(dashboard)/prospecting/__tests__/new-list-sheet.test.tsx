// @vitest-environment jsdom
/**
 * The New-list sheet (§10 Page 2, §4).
 *
 * What is pinned here, and why each would be silently wrong otherwise:
 *
 *  - PRE-FILL. Every ICP field arrives seeded from the workspace's own
 *    enriched company row. If this regresses the sheet still "works" — it just
 *    asks the user to type their own business, which is the exact failure the
 *    whole pre-fill design exists to prevent.
 *  - PROVENANCE. A seeded field renders "From your company profile" with its
 *    source link. Crucially, a TEMPLATE default must NOT — claiming a sentence
 *    we wrote came from their company profile is the one lie that would make
 *    every other provenance line untrustworthy.
 *  - TEMPLATE SWITCHING re-seeds from the corresponding draft (the server sends
 *    one per purpose), and does not overwrite a name the user chose.
 *  - LIVE EXCLUSION COUNTS. "Exclude the 412 companies already in your CRM" is
 *    what makes an abstract switch legible; a switch with no number is a
 *    different, worse control.
 *  - `exclude_contacted` is a TRI-STATE segmented control, not a checkbox —
 *    'active' is what a re-engagement list needs and a boolean cannot say it.
 *    It DEFAULTS to 'ever' for every template, matching migration 248's column
 *    default (§3: "a list is for NEW people"). The sheet shipped defaulting to
 *    'active', so a list created without touching the control silently landed
 *    as a re-engagement list — every discovered person who had ever been
 *    emailed stayed in, which is the opposite of what the control's own default
 *    promises. The DB default is the source of truth; this pins the UI to it.
 *  - A duplicate name lands UNDER THE FIELD, not in a toast: it is fixed in one
 *    keystroke and the user should not have to remember it while retyping.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const createList = vi.fn()
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return { ...actual, createList: (body: unknown) => createList(body) }
})

// `vi.mock` is hoisted above every top-level const, so the spy must be created
// inside `vi.hoisted` to exist by the time the factory runs.
const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }))

import { ProspectingRequestError } from '../api'
import { NewListSheet } from '../new-list-sheet'
import { DEFAULT_EXCLUDE_CONTACTED } from '../ui-helpers'
import { CARDED_COMPANY, LIST, UNCARDED_COMPANY, sourcePayload } from './fixtures'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  createList.mockReset()
  toastError.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const noop = () => {}

async function render(props: Partial<React.ComponentProps<typeof NewListSheet>> = {}) {
  await act(async () => {
    root.render(
      <NewListSheet
        open
        source={sourcePayload(CARDED_COMPANY)}
        initialPurpose="buyers"
        onClose={noop}
        onCreated={noop}
        {...props}
      />,
    )
  })
}

/**
 * The sheet PORTALS to document.body (shared Radix `Sheet`), so it is NOT
 * under the render container — every query here goes through `sheet()` or
 * `document`. That is deliberate: the dashboard shell paints the chat column
 * over any in-tree `fixed` panel, which is what put the exclusion toggles and
 * "Create list" out of reach in the browser. Querying `container` would pass
 * again the moment someone un-portals it.
 */
function sheet(): HTMLElement {
  return document.querySelector('[aria-label="New prospect list"]') as HTMLElement
}

function text() {
  return sheet()?.textContent ?? ''
}

function byLabel(label: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll('[aria-label]')).find(
    (el) => el.getAttribute('aria-label') === label,
  ) as HTMLElement | undefined
}

/** The template cards carry a title AND a blurb, so match on the leading
 *  title text rather than the whole button. */
function buttonWithText(needle: string): HTMLButtonElement | undefined {
  return Array.from(sheet()?.querySelectorAll('button') ?? []).find((b) =>
    (b.textContent ?? '').trim().startsWith(needle),
  )
}

function nameInput(): HTMLInputElement {
  return document.querySelector('#prospect-list-name') as HTMLInputElement
}

/** The row wrapper holding a labelled field, so provenance can be asserted
 *  against THAT field rather than anywhere on the sheet. */
function rowFor(label: string): HTMLElement | null {
  const spans = Array.from(sheet()?.querySelectorAll('span') ?? [])
  const labelEl = spans.find((s) => s.textContent === label)
  return labelEl?.closest('.group\\/row') ?? null
}

describe('NewListSheet', () => {
  it('pre-fills every ICP field from the company profile', async () => {
    await render()
    expect(text()).toContain('an AI meeting-capture and CRM workspace')
    expect(text()).toContain('revenue teams at 20–500 person B2B software companies')
    // known_customers → chips
    expect(text()).toContain('Acme')
    expect(text()).toContain('Globex')
    // The source-company line, with the "Not your company?" correction.
    expect(text()).toContain('Pre-filled from')
    expect(text()).toContain('Not your company?')
  })

  it('renders the provenance line with its source link under a seeded field', async () => {
    await render()
    const row = rowFor('Our product')
    expect(row).toBeTruthy()
    expect(row!.textContent).toContain('From your company profile')
    const link = row!.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://dial8.ai/product')
    expect(link?.textContent).toContain('dial8.ai')
  })

  it('never claims a template default came from the company profile', async () => {
    // With no ICP card there is no `targetCustomer`, so buildIcpDraft falls
    // back to the purpose TEMPLATE — a sentence we wrote, which must NOT be
    // dressed up as something read off the company's own site.
    await render({
      source: sourcePayload(UNCARDED_COMPANY),
      initialPurpose: 'partners',
    })
    const row = rowFor('Description')
    expect(row).toBeTruthy()
    expect(row!.textContent).toContain('complements')
    expect(row!.textContent).not.toContain('From your company profile')
  })

  it('switches the pre-fill when a different template is picked', async () => {
    await render()
    expect(text()).toContain('revenue teams at 20–500 person B2B software companies')

    await act(async () => {
      buttonWithText('Investors')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // Investors CLEARS the card's sales-shaped description and its buyer
    // titles, and keeps `source` + comparables so the angles have evidence.
    expect(text()).not.toContain('revenue teams at 20–500 person B2B software companies')
    expect(text()).toContain('Partner')
    expect(text()).toContain('Principal')
    expect(text()).toContain('an AI meeting-capture and CRM workspace')
  })

  it('follows the template name until the user types one, then leaves it alone', async () => {
    await render()
    expect(nameInput().value).toBe('Customers')

    // A template switch before any typing still re-seeds the name.
    await act(async () => {
      buttonWithText('Partners')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(nameInput().value).toBe('Partners')

    // Once typed, a later switch must not overwrite it.
    await act(async () => {
      const input = nameInput()
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!
      setter.call(input, 'Q4 push')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      buttonWithText('Investors')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(nameInput().value).toBe('Q4 push')
  })

  it('renders the three exclusion controls with live counts, contacted as a tri-state', async () => {
    await render()
    expect(text()).toContain('412')
    expect(text()).toContain('companies already in your CRM')
    expect(text()).toContain('3')
    expect(text()).toContain('other lists')
    expect(text()).toContain('38')

    const group = byLabel('Exclude contacted')!
    const options = Array.from(group.querySelectorAll('button')).map((b) => b.textContent)
    expect(options).toEqual(['Off', 'Active', 'Ever'])
    // 'ever' is the default — the same value migration 248 gives the column.
    expect(DEFAULT_EXCLUDE_CONTACTED).toBe('ever')
    const pressed = Array.from(group.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-pressed') === 'true',
    )
    expect(pressed?.textContent).toBe('Ever')
  })

  it('defaults exclude_contacted to ever on every template, not just buyers', async () => {
    // The bug was a hardcoded 'active' in one useState, so it was wrong for
    // ALL FOUR templates at once — asserting only `buyers` would have let a
    // per-purpose regression through.
    for (const purpose of ['buyers', 'investors', 'partners', 'custom'] as const) {
      await render({ initialPurpose: purpose })
      const group = byLabel('Exclude contacted')!
      const pressed = Array.from(group.querySelectorAll('button')).find(
        (b) => b.getAttribute('aria-pressed') === 'true',
      )
      expect(pressed?.textContent, `${purpose} default`).toBe('Ever')
    }
  })

  it('posts the edited ICP and the exclusion settings, then hands back the list', async () => {
    createList.mockResolvedValue(LIST)
    const onCreated = vi.fn()
    await render({ onCreated })

    await act(async () => {
      buttonWithText('Create list')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(createList).toHaveBeenCalledTimes(1)
    const body = createList.mock.calls[0][0] as Record<string, unknown>
    expect(body.name).toBe('Customers')
    expect(body.purpose).toBe('buyers')
    expect(body.exclude_crm).toBe(true)
    expect(body.exclude_other_lists).toBe(false)
    // Untouched, the created row must land on the migration's own default.
    expect(body.exclude_contacted).toBe('ever')
    expect(body.source_company_id).toBe('company-1')
    expect((body.icp as { source: { what_we_sell: string } }).source.what_we_sell).toContain(
      'AI meeting-capture',
    )
    expect(onCreated).toHaveBeenCalledWith(LIST)
  })

  it('shows a duplicate name under the field rather than in a toast', async () => {
    createList.mockRejectedValue(
      new ProspectingRequestError({
        message: 'A list with that name already exists',
        code: 'LIST_NAME_TAKEN',
        details: null,
        status: 409,
      }),
    )
    await render()

    await act(async () => {
      buttonWithText('Create list')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(text()).toContain('You already have a list with that name')
    expect(toastError).not.toHaveBeenCalled()
  })

  it('portals out of the render tree, and keeps the footer outside the scroller', async () => {
    // THE BUG THIS PINS: rendered in-tree, the sheet's `fixed` panel loses the
    // paint-order fight with the dashboard's chat column — the exclusion
    // toggles and "Create list" end up under the chat dock, unclickable, with
    // no way to scroll to them. Portaling to document.body is the fix, so the
    // sheet must NOT be a descendant of the mount container.
    await render()
    const panel = sheet()
    expect(panel).toBeTruthy()
    expect(container.contains(panel)).toBe(false)
    expect(document.body.contains(panel)).toBe(true)

    // And the scroll chain must actually bound the body: a `min-h-0 flex-1`
    // scroller is only a scroller when its parent is a bounded flex column.
    expect(panel.className).toContain('flex')
    expect(panel.className).toContain('h-full')
    expect(panel.className).toContain('flex-col')
    const body = Array.from(panel.querySelectorAll('div')).find((d) =>
      d.className.includes('overflow-y-auto'),
    )
    expect(body, 'the sheet body must be its own scroller').toBeTruthy()
    expect(body!.className).toContain('min-h-0')
    expect(body!.className).toContain('flex-1')
    // The footer is a SIBLING of the scroller, never inside it — that is what
    // keeps "Create list" reachable however long the ICP grows.
    const create = buttonWithText('Create list')!
    expect(body!.contains(create)).toBe(false)
  })

  it('renders nothing when closed', async () => {
    await render({ open: false })
    expect(sheet()).toBeNull()
  })
})
