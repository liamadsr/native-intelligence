// @vitest-environment jsdom
/**
 * Dismiss and Save — the two gestures that carry invisible consequences.
 *
 * DISMISS. Two of the seven reasons — `competitor` and `already_customer` —
 * suppress WORKSPACE-WIDE rather than only in the list they happened in
 * (decision 3). That is a real, permanent, invisible effect, so the picker
 * says so ON THE OPTION rather than in a footnote nobody reads. The set of
 * options and which of them are global are both read from the shared const
 * arrays, so a reason added to migration 248 shows up here or the test fails.
 *
 * SAVE. The route returns PER-ENTRY OUTCOMES, never a count (§8), because
 * Add-to-sequence needs the ids that came back and a silent shortfall would go
 * unnoticed. `summarizeSaveResult` is what turns those outcomes into one
 * honest line — a bare "saved!" would be exactly the lie the shape exists to
 * prevent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import {
  PROSPECT_DISMISSED_REASONS,
  PROSPECT_GLOBAL_DISMISS_REASONS,
} from '@/lib/prospecting/types'
import { DismissReasonDialog, suppressesWorkspaceWide } from '../dismiss-reason-dialog'
import { summarizeSaveResult } from '../ui-helpers'

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

/**
 * The picker PORTALS to document.body (shared Radix `Dialog`), so it is not
 * under the render container — queries go through `dialog()` / `document`.
 * That is the point: it opens from inside the ICP sheet's stacking context as
 * well as the list body, and an in-tree `fixed` node was being painted over.
 */
function dialog(): HTMLElement | null {
  return document.querySelector('[aria-label="Dismiss candidates"]')
}

function dialogText(): string {
  return dialog()?.textContent ?? ''
}

function radios(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll('input[type="radio"]'))
}

function labelFor(value: string): HTMLElement {
  return radios().find((r) => r.value === value)!.closest('label') as HTMLElement
}

describe('DismissReasonDialog', () => {
  it('offers every reason in the migration and defaults to not_icp', async () => {
    await act(async () => {
      root.render(
        <DismissReasonDialog open count={1} onCancel={() => {}} onConfirm={() => {}} />,
      )
    })
    expect(radios().map((r) => r.value)).toEqual([...PROSPECT_DISMISSED_REASONS])
    expect(radios().find((r) => r.checked)?.value).toBe('not_icp')
    expect(dialogText()).toContain('Dismiss this candidate')
    // Nothing is deleted — the entry IS the suppression record.
    expect(dialogText()).toContain('not found again')
  })

  it('discloses workspace-wide suppression on exactly the two global reasons', async () => {
    await act(async () => {
      root.render(
        <DismissReasonDialog open count={3} onCancel={() => {}} onConfirm={() => {}} />,
      )
    })
    expect(dialogText()).toContain('Dismiss 3 candidates')

    for (const reason of PROSPECT_DISMISSED_REASONS) {
      const global = (PROSPECT_GLOBAL_DISMISS_REASONS as readonly string[]).includes(reason)
      expect(suppressesWorkspaceWide(reason)).toBe(global)
      const disclosed = labelFor(reason).textContent!.includes('every other list')
      expect(disclosed, `${reason} disclosure`).toBe(global)
    }
  })

  it('hands the chosen reason back on confirm', async () => {
    const onConfirm = vi.fn()
    await act(async () => {
      root.render(
        <DismissReasonDialog open count={1} onCancel={() => {}} onConfirm={onConfirm} />,
      )
    })
    await act(async () => {
      const radio = radios().find((r) => r.value === 'competitor')!
      radio.click()
    })
    await act(async () => {
      Array.from(dialog()!.querySelectorAll('button'))
        .find((b) => (b.textContent ?? '').trim() === 'Dismiss')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onConfirm).toHaveBeenCalledWith('competitor')
  })

  it('portals out of the render tree', async () => {
    // It opens from inside the ICP sheet's stacking context as well as from
    // the list body; in-tree it would be painted over by whichever sibling
    // column comes last, exactly as the sheets were.
    await act(async () => {
      root.render(
        <DismissReasonDialog open count={1} onCancel={() => {}} onConfirm={() => {}} />,
      )
    })
    expect(dialog()).toBeTruthy()
    expect(container.contains(dialog())).toBe(false)
    expect(document.body.contains(dialog())).toBe(true)
  })

  it('renders nothing when closed', async () => {
    await act(async () => {
      root.render(
        <DismissReasonDialog open={false} count={1} onCancel={() => {}} onConfirm={() => {}} />,
      )
    })
    expect(dialog()).toBeNull()
  })
})

describe('summarizeSaveResult', () => {
  it('names what was saved and groups every skip reason', () => {
    expect(
      summarizeSaveResult({
        saved: [
          { entry_id: 'a', kind: 'company' },
          { entry_id: 'b', kind: 'company' },
        ],
        skipped: [
          { entry_id: 'c', list_id: 'list-1', reason: 'no_domain' },
          { entry_id: 'd', list_id: 'list-1', reason: 'no_domain' },
          { entry_id: 'e', list_id: 'list-1', reason: 'needs_review' },
        ],
      }),
    ).toBe(
      '2 added to your CRM, 2 skipped (no website found), 1 skipped (could not verify the employer)',
    )
  })

  it('is honest when nothing could be saved', () => {
    expect(
      summarizeSaveResult({ saved: [], skipped: [{ entry_id: 'a', list_id: 'list-1', reason: 'dismissed' }] }),
    ).toBe('0 added to your CRM, 1 skipped (dismissed)')
  })

  /**
   * A MIXED SELECTION is the case the bare count hides. The selection bar now
   * spans both tabs, and "12 added to your CRM" over 5 companies and 7 people
   * conceals two writes that behave differently — a person may have arrived
   * with no email at all, which decides whether they can ever be sequenced.
   */
  it('splits a mixed company/person save by kind', () => {
    expect(
      summarizeSaveResult({
        saved: [
          { entry_id: 'a', kind: 'company' },
          { entry_id: 'b', kind: 'person' },
          { entry_id: 'c', kind: 'person' },
        ],
        skipped: [{ entry_id: 'd', list_id: 'list-1', reason: 'parent_failed' }],
      }),
    ).toBe(
      '1 company and 2 people added to your CRM, 1 skipped (their company could not be saved)',
    )
  })

  it('agrees with its own nouns at one of each', () => {
    expect(
      summarizeSaveResult({
        saved: [
          { entry_id: 'a', kind: 'company' },
          { entry_id: 'b', kind: 'person' },
        ],
        skipped: [],
      }),
    ).toBe('1 company and 1 person added to your CRM')
  })

  /** An unknown reason prints its raw code rather than blocking the build —
   *  the reason union is owned by the save route and grows there first. */
  it('falls back to the raw code for a reason it has no label for', () => {
    expect(
      summarizeSaveResult({
        saved: [],
        skipped: [{ entry_id: 'a', list_id: 'list-1', reason: 'brand_new_reason' as never }],
      }),
    ).toBe('0 added to your CRM, 1 skipped (brand_new_reason)')
  })
})
