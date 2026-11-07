// @vitest-environment jsdom
/**
 * The row → page seam (phase 4 integration).
 *
 * A prospect row's hover Save/Dismiss buttons live in the shared views system
 * (`entity-row.tsx`), which must not import from a feature folder — so they
 * state an intent as a CustomEvent and this page decides what it means. Two
 * packages built the two halves; nothing proved they meet. This suite is that
 * proof, and it asserts the halves are joined THROUGH THE PUBLIC EVENT rather
 * than by reaching into either component: the event name, payload shape and
 * emitter are all imported from `entity-row.tsx`, so a rename on either side
 * fails here instead of silently unwiring the buttons in production.
 *
 * THE ONE THING THIS MUST NOT ALLOW. Dismiss may not take effect on click.
 * Two of the dismissal reasons suppress the candidate WORKSPACE-WIDE and
 * permanently, so a one-click hover affordance that skipped the reason picker
 * would let a row quietly do something the entry panel makes the user choose.
 * A hover action may OPEN a dialog; it may not substitute for one. The test
 * below asserts the dialog appears and that nothing was written before the
 * user answered it.
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

vi.mock('@/components/views/unified-view-layout', () => ({
  UnifiedViewLayout: () => null,
}))
vi.mock('../../views/company-detail-panel', () => ({ CompanyDetailPanel: () => null }))
vi.mock('../../views/contact-detail-panel', () => ({ ContactDetailPanel: () => null }))

const fetchList = vi.fn()
const fetchRuns = vi.fn()
const fetchRun = vi.fn()
const saveEntries = vi.fn()
const publishEntries = vi.fn()
const patchEntryStage = vi.fn()
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    fetchList: (id: string) => fetchList(id),
    fetchRuns: (listId: string, limit?: number) => fetchRuns(listId, limit),
    fetchRun: (id: string) => fetchRun(id),
    fetchAngles: () => Promise.resolve([]),
    saveEntries: (ids: string[]) => saveEntries(ids),
    publishEntries: (ids: string[], includeUnverified?: boolean) =>
      publishEntries(ids, includeUnverified),
    fetchSequenced: () => Promise.resolve({}),
    patchEntryStage: (id: string, stage: string, reason?: string) =>
      patchEntryStage(id, stage, reason),
  }
})

import { emitProspectEntryAction } from '@/components/views/list/entity-row'
import { ListDetail } from '../list-detail'
import { LIST, entry } from './fixtures'

const COUNTS = { discovered: 8, shortlisted: 0, saved: 2, dismissed: 1, total: 11 }
const ENTRIES = [
  entry({ id: 'e1', fit_score: 90, stage: 'discovered' }),
  entry({ id: 'e2', fit_score: 70, stage: 'discovered' }),
]

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  toastError.mockReset()
  toastSuccess.mockReset()
  fetchRun.mockReset()
  fetchRuns.mockReset().mockResolvedValue([])
  saveEntries.mockReset().mockResolvedValue({ saved: [], skipped: [], failed: [] })
  publishEntries.mockReset().mockResolvedValue({ saved: [], skipped: [], list_ids: [], published_at: null })
  patchEntryStage.mockReset().mockResolvedValue({})
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

/** The reason picker portals to document.body (shared Radix Dialog). */
function dismissDialog(): HTMLElement | null {
  return document.querySelector('[aria-label="Dismiss candidates"]')
}

async function emit(action: 'save' | 'dismiss', ids: string[]) {
  await act(async () => {
    emitProspectEntryAction(action, ids)
  })
  await act(async () => {})
}

/**
 * The list header is the crumb and the name, nothing else. The Beta pill
 * (still on the index) and the purpose chip ("Customers") used to flank the
 * name here; Liam cut both from this page on 2026-09-05. This pins the
 * removal, and that the name still truncates rather than pushing the header's
 * actions off the row.
 */
describe('list detail header', () => {
  it('carries neither the beta pill nor the purpose chip', async () => {
    await render()
    expect(container.querySelector('[data-beta-pill]')).toBeNull()
    const h1 = container.querySelector('h1')!
    expect(h1.textContent).toBe('Customers like us')
    // The title row is exactly: crumb → name.
    const kids = Array.from(h1.parentElement!.children)
    expect(kids.map((el) => el.tagName)).toEqual(['BUTTON', 'H1'])
    expect(kids[0].textContent).toContain('Lists')
    expect(h1.parentElement!.textContent).not.toContain('Customers like us ')
  })

  it('keeps the list name truncating', async () => {
    await render()
    expect(container.querySelector('h1')?.className).toContain('truncate')
  })

  it('folds Find more companies, Edit ICP, Add company by domain and Run history behind one settings button', async () => {
    // Liam, 2026-09-05: "add a settings button and when you click it it
    // should show these options instead of having them all at the top level".
    // The popover portals to document.body, so the lookups are document-wide.
    await render()
    const byLabel = (label: string) =>
      Array.from(document.querySelectorAll('[aria-label]')).find(
        (el) => el.getAttribute('aria-label') === label,
      ) as HTMLElement | undefined
    const byText = (label: string) =>
      Array.from(document.querySelectorAll('button')).find((b) =>
        (b.textContent ?? '').trim().startsWith(label),
      )

    // Top level: the gear. None of the items — discovery included (Liam,
    // 2026-09-06: by the time this page is open the first search has run,
    // so "Find more companies" belongs in the menu, not beside the title).
    expect(byLabel('List settings')).toBeTruthy()
    expect(byText('Find companies')).toBeUndefined()
    expect(byText('Find more companies')).toBeUndefined()
    expect(byText('Edit ICP')).toBeUndefined()
    expect(byLabel('Add company by domain')).toBeUndefined()
    expect(byText('Run history')).toBeUndefined()

    await act(async () => {
      byLabel('List settings')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(byText('Find more companies')).toBeTruthy()
    expect(byText('Edit ICP')).toBeTruthy()
    expect(byLabel('Add company by domain')).toBeTruthy()
    expect(byText('Run history')).toBeTruthy()

    // Second level: the run history panel, fetched on entry, with a way back.
    fetchRuns.mockClear()
    await act(async () => {
      byText('Run history')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {})
    expect(document.querySelector('[data-run-history-panel]')).toBeTruthy()
    expect(fetchRuns).toHaveBeenCalledWith('list-1', 20)
    expect(byText('Edit ICP')).toBeUndefined()

    await act(async () => {
      byLabel('Back to settings')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(byText('Edit ICP')).toBeTruthy()
    expect(document.querySelector('[data-run-history-panel]')).toBeNull()
  })
})

describe('row hover actions reach the page handlers', () => {
  it('Save from a row calls the same saveEntries the selection bar does', async () => {
    await render()
    await emit('save', ['e1'])
    // Curation: the row goes on the list; nothing is published.
    expect(saveEntries).toHaveBeenCalledWith(['e1'])
    expect(publishEntries).not.toHaveBeenCalled()
  })

  /**
   * The needs_review escape hatch, end to end through the public event.
   *
   * The ROW asks the question (it is the row that knows which person and which
   * company), so by the time the page hears the intent the answer is already
   * in — the page must forward the flag rather than re-ask or drop it.
   */
  it('forwards confirmUnverified from a row that already asked', async () => {
    await render()
    await act(async () => {
      emitProspectEntryAction('save', ['e1'], { confirmUnverified: true })
    })
    await act(async () => {})
    // The confirm PUBLISHES that one person — the gate lives at publish time.
    expect(publishEntries).toHaveBeenCalledWith(['e1'], true)
    expect(saveEntries).not.toHaveBeenCalled()
  })

  it('Dismiss from a row opens the reason picker and writes NOTHING yet', async () => {
    await render()
    expect(dismissDialog()).toBeNull()

    await emit('dismiss', ['e1'])

    // The dialog is the whole point: two reasons suppress workspace-wide, so
    // the row may not choose one on the user's behalf.
    expect(dismissDialog()).not.toBeNull()
    expect(patchEntryStage).not.toHaveBeenCalled()
  })

  it('answering that picker dismisses the entry the row named', async () => {
    await render()
    await emit('dismiss', ['e2'])

    const confirm = Array.from(
      dismissDialog()?.querySelectorAll('button') ?? [],
    ).find((b) => b.textContent?.trim() === 'Dismiss')
    expect(confirm).toBeTruthy()
    await act(async () => {
      confirm!.click()
    })
    await act(async () => {})

    // The id from the EVENT, not the current selection — a row acts on itself.
    expect(patchEntryStage).toHaveBeenCalledWith('e2', 'dismissed', 'not_icp')
  })

  it('carries every id in the payload, so a future multi-row emit still works', async () => {
    await render()
    await emit('save', ['e1', 'e2'])
    expect(saveEntries).toHaveBeenCalledWith(['e1', 'e2'])
  })

  it('ignores a malformed event rather than firing a write with no ids', async () => {
    await render()
    await emit('save', [])
    expect(saveEntries).not.toHaveBeenCalled()
  })

  it('unmounts its listener — a stale page must not answer a later row', async () => {
    await render()
    await act(async () => root.unmount())
    // Re-create so the shared afterEach unmount stays valid.
    root = createRoot(container)

    await act(async () => {
      emitProspectEntryAction('save', ['e1'])
    })
    expect(saveEntries).not.toHaveBeenCalled()
  })
})

/**
 * A list in a chat card (pages in the chat, P3) beside the real page on the
 * same list: a row's intent in the card reaches the card's list page alone, a
 * row's intent on the page reaches the page alone, so a save is one save. And
 * the card's list page leaves the page's module stores alone.
 */
describe('list detail in a chat card', () => {
  it('hears only its own rows, and the page only its own', async () => {
    const { ProspectEntryActionTargetContext } = await import('@/components/views/list/entity-row')
    const { readProspectingSelection } = await import('../selection-context')
    const cardTarget = new EventTarget()
    await act(async () => {
      root.render(
        <>
          <ListDetail listId="list-1" onBack={noop} onNameLoaded={noop} />
          <ProspectEntryActionTargetContext.Provider value={cardTarget}>
            <ListDetail listId="list-1" onBack={noop} onNameLoaded={noop} />
          </ProspectEntryActionTargetContext.Provider>
        </>,
      )
    })
    await act(async () => {})
    const pageSnapshot = readProspectingSelection('list-1')
    expect(pageSnapshot).not.toBeNull()

    await act(async () => {
      emitProspectEntryAction('save', ['e1'], {}, cardTarget)
    })
    await act(async () => {})
    expect(saveEntries).toHaveBeenCalledTimes(1)

    await emit('save', ['e2'])
    expect(saveEntries).toHaveBeenCalledTimes(2)
    expect(saveEntries).toHaveBeenLastCalledWith(['e2'])

    // Taking the card away leaves the page's selection snapshot in place.
    await act(async () => {
      root.render(<ListDetail listId="list-1" onBack={noop} onNameLoaded={noop} />)
    })
    expect(readProspectingSelection('list-1')).not.toBeNull()
  })
})
