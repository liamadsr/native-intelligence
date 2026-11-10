// @vitest-environment jsdom
/**
 * The CRM handoff, at the page level (§8) — Save, Sequence, and what the user
 * sees afterwards.
 *
 * FOUR THINGS THIS SUITE EXISTS TO PIN.
 *
 * 1. **The selection bar spans both tabs and reports honestly.** Save no
 *    longer refuses a person, so a mixed selection is now reachable and
 *    "12 saved to your CRM" over 5 companies and 7 people would hide the two
 *    writes that behave differently. The bar reports counts AND reasons.
 *
 * 2. **Add to sequence on People is Save-then-enroll**, and the people with no
 *    email are named INLINE next to the control — never in a toast alone,
 *    which §8 forbids by name.
 *
 * 3. **After saving a person, the panel is the existing ContactDetailPanel**
 *    under the same breadcrumb treatment companies get, with one Prospecting
 *    section on top. That section carries the three facts the CRM record
 *    cannot: which list, how the ACCOUNT scored, and whether the employer was
 *    confirmed.
 *
 * 4. **The Sequenced map is DERIVED and published to the rows.** The row
 *    renderer is mounted deep inside the shared views layout with no prop
 *    channel, so the page publishes and the rows subscribe — and the map is
 *    cleared on unmount, or list A's chips would paint on list B's rows.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { error: toastError, success: toastSuccess } }))
vi.mock('thinking-orbs', () => ({ ThinkingOrb: () => null }))

/** The shared list body is not under test here; the header, the selection bar
 *  and the detail overlay are. `onBulkSelectionChange` is captured so a test
 *  can drive a selection the way the real layout does. */
let selectionHandler: ((info: unknown) => void) | null = null
vi.mock('@/components/views/unified-view-layout', () => ({
  UnifiedViewLayout: (props: {
    onBulkSelectionChange?: (info: unknown) => void
    selectionActions?: React.ReactNode
  }) => {
    selectionHandler = props.onBulkSelectionChange ?? null
    // The selection island is the layout's; the page's verbs ride in it.
    return <>{props.selectionActions}</>
  },
}))

/** Both post-save panels are stubbed to a marker: this suite proves WHICH
 *  panel opens and with which id, not how either renders. */
vi.mock('../../views/company-detail-panel', () => ({
  CompanyDetailPanel: ({ companyId }: { companyId: string }) => (
    <div data-company-panel={companyId} />
  ),
}))
vi.mock('../../views/contact-detail-panel', () => ({
  ContactDetailPanel: ({ contactId }: { contactId: string }) => (
    <div data-contact-panel={contactId} />
  ),
}))

const dialogProps = vi.fn()
vi.mock('@/components/sequences/add-to-sequence-dialog', () => ({
  AddToSequenceDialog: (props: { contactIds: string[]; open: boolean }) => {
    dialogProps(props)
    return props.open ? (
      <div data-add-to-sequence data-contact-ids={props.contactIds.join(',')} />
    ) : null
  },
}))

const fetchList = vi.fn()
const fetchRuns = vi.fn()
const fetchRun = vi.fn()
const saveEntries = vi.fn()
const publishEntries = vi.fn()
const fetchSequenced = vi.fn()
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    fetchList: (id: string) => fetchList(id),
    fetchRuns: (listId: string, limit?: number) => fetchRuns(listId, limit),
    fetchRun: (id: string) => fetchRun(id),
    fetchSequenced: (listId: string) => fetchSequenced(listId),
    saveEntries: (ids: string[]) => saveEntries(ids),
    publishEntries: (ids: string[], includeUnverified?: boolean) =>
      publishEntries(ids, includeUnverified),
    patchEntryStage: () => Promise.resolve({}),
  }
})

import { ListDetail } from '../list-detail'
import { LIST, entry } from './fixtures'

/** A company and two of its people — the shape a mixed selection needs. */
const COMPANY = entry({
  id: 'c1',
  kind: 'company',
  fit_score: 90,
  fit_rationale: 'Hiring SDRs and running an outbound motion.',
  candidate: { name: 'Quillfort Security', domain: 'quillfort.ai' },
})
const WITH_EMAIL = entry({
  id: 'p1',
  kind: 'person',
  parent_entry_id: 'c1',
  candidate_key: 'dana@quillfort.ai',
  candidate: {
    name: 'Dana Reyes',
    title: 'VP RevOps',
    domain: 'quillfort.ai',
    company_name: 'Quillfort Security',
    email: 'dana@quillfort.ai',
  },
  identity_state: 'anchored',
})
const NO_EMAIL = entry({
  id: 'p2',
  kind: 'person',
  parent_entry_id: 'c1',
  candidate_key: 'linkedin.com/in/sam-ito',
  candidate: {
    name: 'Sam Ito',
    title: 'Head of Sales',
    domain: 'quillfort.ai',
    company_name: 'Quillfort Security',
    email: null,
  },
  identity_state: 'needs_review',
})
const ENTRIES = [COMPANY, WITH_EMAIL, NO_EMAIL]
const COUNTS = { discovered: 3, shortlisted: 0, saved: 0, dismissed: 0, total: 3 }

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  selectionHandler = null
  toastError.mockReset()
  toastSuccess.mockReset()
  dialogProps.mockReset()
  fetchRun.mockReset()
  fetchRuns.mockReset().mockResolvedValue([])
  fetchSequenced.mockReset().mockResolvedValue({})
  saveEntries.mockReset().mockResolvedValue({ saved: [], skipped: [] })
  publishEntries.mockReset().mockResolvedValue({ saved: [], skipped: [], list_ids: [], published_at: null })
  fetchList.mockReset().mockResolvedValue({
    list: LIST,
    entries: ENTRIES,
    entry_counts: COUNTS,
  })
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
    root.render(<ListDetail listId="list-1" onBack={noop} onNameLoaded={noop} />)
  })
  await act(async () => {})
}

/**
 * Every lookup below reads `document.body`, not the render `container`.
 *
 * The candidate detail is a MODAL now (Liam asked for a pop-up over the list
 * rather than a full-width sheet that replaced it), and a Radix dialog PORTALS
 * out of the tree it is declared in — so the post-save contact/company panels
 * this suite is about are siblings of `container`, not descendants. `body` is
 * the one root that contains both the page and the pop-up.
 */
function text(): string {
  return (document.body.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function button(label: string): HTMLButtonElement | undefined {
  // PREFIX, not equality: the selection bar's verbs now carry their prices
  // ("Enrich · $0.23", "Add to CRM").
  return Array.from(document.body.querySelectorAll('button')).find((b) =>
    b.textContent?.trim().startsWith(label),
  )
}

/** The selection bar's Save — by attribute, because "Save" is a prefix of the
 *  "Saved" chip's label. */
function saveSelection(): HTMLButtonElement | undefined {
  return (document.body.querySelector('button[data-prospect-save-selection]') as HTMLButtonElement | null) ?? undefined
}

/** The one press that still makes a CRM record on its own: the row's
 *  "Publish anyway" for a person the list publish held back, which reaches the
 *  page as a save intent carrying `confirmUnverified`. */
async function publishOne(id: string) {
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent('ni:prospect-entry-action', {
        detail: { action: 'save', entryIds: [id], confirmUnverified: true },
      }),
    )
  })
  await act(async () => {})
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {})
}

async function select(ids: string[]) {
  await act(async () => {
    selectionHandler?.({
      hasSelection: ids.length > 0,
      count: ids.length,
      selectedIds: ids,
      onClear: () => {},
    })
  })
  await act(async () => {})
}

// ---------------------------------------------------------------------------

describe('the selection bar — Save across both kinds', () => {
  it('offers Save on a PEOPLE selection — a nested person row checks like any row', async () => {
    await render()
    await select(['p1'])
    expect(saveSelection()!.disabled).toBe(false)
  })

  it('reports a mixed company/person save by kind, with the reasons', async () => {
    // The whole point of per-entry outcomes: a bare count over a mixed
    // selection hides which writes happened and which did not.
    saveEntries.mockResolvedValue({
      saved: [
        { entry_id: 'c1', kind: 'company', company_id: 'co-1' },
        { entry_id: 'p1', kind: 'person', contact_id: 'ct-1', email: 'dana@quillfort.ai' },
      ],
      skipped: [{ entry_id: 'p2', reason: 'needs_review' }],
    })
    await render()
    await select(['c1', 'p1', 'p2'])
    await click(saveSelection()!)

    // Curation: on the list, nothing published.
    expect(saveEntries).toHaveBeenCalledWith(['c1', 'p1', 'p2'])
    expect(publishEntries).not.toHaveBeenCalled()

    // NOT A TOAST (C5). A multi-row save's outcome is a set of counts with
    // somewhere to go, and each number is only useful if the rows it counts can
    // still be reached in ten seconds' time. So the page states it in a banner
    // it owns; the toast — which holds no link and cannot be re-read — is kept
    // for the single-row case, where the record's own panel opens under it.
    expect(toastSuccess).not.toHaveBeenCalled()
    const banner = document.body.querySelector('[data-save-story]')!
    expect(banner).toBeTruthy()
    expect(banner.getAttribute('data-save-story')).toBe('page')
    const said = (banner.textContent ?? '').replace(/\s+/g, ' ')
    expect(said).toContain('1 company and 1 person saved to the list')
    expect(said).toContain('1 need review')
  })

  it('opens NO panel for a bulk save — there is no single record to show', async () => {
    saveEntries.mockResolvedValue({
      saved: [
        { entry_id: 'c1', kind: 'company', company_id: 'co-1' },
        { entry_id: 'p1', kind: 'person', contact_id: 'ct-1', email: 'a@x.com' },
      ],
      skipped: [],
    })
    await render()
    await select(['c1', 'p1'])
    await click(saveSelection()!)
    expect(document.body.querySelector('[data-contact-panel]')).toBeNull()
    expect(document.body.querySelector('[data-company-panel]')).toBeNull()
  })
})

describe('the selection bar — Add to sequence', () => {
  it('is offered only when people are in the selection', async () => {
    await render()
    await select(['c1'])
    expect(button('Add to sequence')).toBeUndefined()
    await select(['p1'])
    expect(button('Add to sequence')).toBeTruthy()
  })

  it('is disabled with the reason when NOBODY selected has an email', async () => {
    await render()
    await select(['p2'])
    const add = button('Add to sequence')!
    expect(add.disabled).toBe(true)
    expect(add.getAttribute('title')).toContain('No email address')
  })

  it('publishes first, then opens the dialog with only the emailed contacts', async () => {
    publishEntries.mockResolvedValue({
      saved: [
        { entry_id: 'p1', kind: 'person', contact_id: 'ct-1', email: 'dana@quillfort.ai' },
        { entry_id: 'p2', kind: 'person', contact_id: 'ct-2', email: null },
      ],
      skipped: [],
    })
    await render()
    await select(['p1', 'p2'])
    await click(button('Add to sequence')!)

    // PUBLISHED, not merely saved: the dialog needs contact ids.
    expect(publishEntries).toHaveBeenCalledWith(['p1', 'p2'], false)
    expect(saveEntries).not.toHaveBeenCalled()
    const dialog = document.body.querySelector('[data-add-to-sequence]')
    expect(dialog?.getAttribute('data-contact-ids')).toBe('ct-1')
    // Inline, beside the control — §8 forbids a toast alone for this.
    expect(text()).toContain('1 person has no email address and was not added')
  })

  it('re-reads the DERIVED sequenced map after an enrollment', async () => {
    publishEntries.mockResolvedValue({
      saved: [{ entry_id: 'p1', kind: 'person', contact_id: 'ct-1', email: 'a@x.com' }],
      skipped: [],
    })
    await render()
    // Once on load.
    expect(fetchSequenced).toHaveBeenCalledTimes(1)
    await select(['p1'])
    await click(button('Add to sequence')!)
    // Again after the save half, since a person saved from another list may
    // already be enrolled.
    expect(fetchSequenced.mock.calls.length).toBeGreaterThan(1)
  })
})

describe('after publishing one person through the confirm', () => {
  const SAVED_ONE = {
    saved: [
      { entry_id: 'p1', kind: 'person' as const, contact_id: 'ct-1', email: 'dana@quillfort.ai' },
    ],
    skipped: [],
    list_ids: ['list-1'],
    published_at: '2026-09-06T00:00:00.000Z',
  }

  it('opens the EXISTING ContactDetailPanel, not a bespoke one', async () => {
    publishEntries.mockResolvedValue(SAVED_ONE)
    await render()
    await publishOne('p1')
    expect(document.body.querySelector('[data-contact-panel]')?.getAttribute('data-contact-panel')).toBe(
      'ct-1',
    )
  })

  it('names the person in the breadcrumb, not "Contact"', async () => {
    publishEntries.mockResolvedValue(SAVED_ONE)
    await render()
    await publishOne('p1')
    // The crumb is "<list> › <candidate>" — the id alone would leave the user
    // on the one screen where they most need to know what they just created.
    expect(text()).toContain('Dana Reyes')
    expect(text()).toContain(LIST.name)
  })

  it('injects ONE Prospecting section carrying what the CRM record cannot', async () => {
    publishEntries.mockResolvedValue(SAVED_ONE)
    await render()
    await publishOne('p1')

    const section = document.body.querySelector('[data-prospecting-section]')
    expect(section).toBeTruthy()
    const copy = (section!.textContent ?? '').replace(/\s+/g, ' ')
    expect(copy).toContain(LIST.name)
    expect(copy).toContain('Quillfort Security')
    // Fit is the ACCOUNT's — a per-person score is a number nobody
    // computed — and it is read off the parent entry, number and word.
    expect(copy).toContain('match score 90 · strong match')
    expect(copy).toContain('Hiring SDRs')
    expect(copy).toContain('verified at this company')
  })

  it('says "employer not confirmed" for a person published through the confirm', async () => {
    publishEntries.mockResolvedValue({
      saved: [{ entry_id: 'p2', kind: 'person' as const, contact_id: 'ct-2', email: null }],
      skipped: [],
      list_ids: ['list-1'],
      published_at: '2026-09-06T00:00:00.000Z',
    })
    await render()
    await publishOne('p2')
    const copy = (
      document.body.querySelector('[data-prospecting-section]')?.textContent ?? ''
    ).replace(/\s+/g, ' ')
    expect(copy).toContain('employer not confirmed')
  })

  it('still opens the company panel when a COMPANY was the one thing published', async () => {
    publishEntries.mockResolvedValue({
      saved: [{ entry_id: 'c1', kind: 'company' as const, company_id: 'co-1' }],
      skipped: [],
      list_ids: ['list-1'],
      published_at: '2026-09-06T00:00:00.000Z',
    })
    await render()
    await publishOne('c1')
    expect(document.body.querySelector('[data-company-panel]')?.getAttribute('data-company-panel')).toBe(
      'co-1',
    )
    // A company has no prospecting banner — the section is the person's
    // per-list verdict, and the company panel already IS the account.
    expect(document.body.querySelector('[data-prospecting-section]')).toBeNull()
  })
})

describe('the derived Sequenced map', () => {
  it('is fetched once per list load', async () => {
    await render()
    expect(fetchSequenced).toHaveBeenCalledWith('list-1')
  })

  it('renders the page normally when the fetch fails', async () => {
    // The chip is additive information; an error banner for a decoration
    // would be worse than the missing decoration.
    fetchSequenced.mockRejectedValue(new Error('boom'))
    await render()
    expect(text()).toContain(LIST.name)
    expect(toastError).not.toHaveBeenCalled()
  })
})
