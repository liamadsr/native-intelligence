// @vitest-environment jsdom
/**
 * Save-then-enroll (§8) — the ordering problem, and the two facts it must not
 * swallow.
 *
 * THE ORDERING. `AddToSequenceDialog` takes contact ids; a prospect person has
 * none until Save promotes them. So the flow saves first, reads the route's
 * PER-ENTRY outcomes, and opens the dialog with exactly what came back. That
 * shape exists precisely so this step cannot hand the dialog a shorter list
 * than the user selected without anyone noticing — the test below asserts the
 * reconciliation rather than trusting the count.
 *
 * THE TWO FACTS.
 *
 * 1. `no_email`. Most discovered people have a LinkedIn URL and nothing else.
 *    `enrollContacts` skips those with `no_email` — inside a toast, beside a
 *    success count that reads as though everything worked. §8 forbids exactly
 *    that, so the flow filters them out BEFORE the dialog opens and reports
 *    them INLINE. The assertion here is on rendered text, not on a mock call:
 *    a toast that happened to carry the right string would still be the
 *    failure mode the spec names.
 *
 * 2. Refusals. An entry the SAVE route would not promote (`needs_review`,
 *    `parent_failed`, …) never reaches the dialog either, and the note says
 *    why with the same vocabulary the save toast uses.
 *
 * The email test is read off the SAVE RESPONSE, never off the pre-save
 * candidate blob: a person promoted through `findOrCreateContact` may match an
 * existing contact that already held an address the discovered candidate never
 * carried, and guessing from the blob would exclude people who are perfectly
 * enrollable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const publishEntries = vi.fn()
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    publishEntries: (ids: string[], includeUnverified?: boolean) =>
      publishEntries(ids, includeUnverified),
  }
})

/** The dialog is the EXISTING shared component and is used unmodified — this
 *  suite proves what reaches it, not how it renders, so it is stubbed down to
 *  the two things that matter: whether it is open, and with which ids. */
const dialogProps = vi.fn()
vi.mock('@/components/sequences/add-to-sequence-dialog', () => ({
  AddToSequenceDialog: (props: { contactIds: string[]; open: boolean }) => {
    dialogProps(props)
    return props.open ? (
      <div data-add-to-sequence data-contact-ids={props.contactIds.join(',')} />
    ) : null
  },
}))

import { SequenceFlowSurface, useSequenceFlow, type SequenceFlow } from '../sequence-actions'

let container: HTMLDivElement
let root: Root
/** The live flow, captured from the harness so a test can drive `start`. */
let flow: SequenceFlow

function Harness({ onSaved }: { onSaved?: () => void }) {
  flow = useSequenceFlow({ onSaved })
  return <SequenceFlowSurface flow={flow} />
}

beforeEach(() => {
  publishEntries.mockReset()
  dialogProps.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function render(onSaved?: () => void) {
  await act(async () => {
    root.render(<Harness onSaved={onSaved} />)
  })
}

async function start(entryIds: string[]) {
  await act(async () => {
    await flow.start(entryIds)
  })
}

function text(): string {
  return (container.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** The ids the dialog was actually opened with, or null if it never opened. */
function openedWith(): string[] | null {
  const node = container.querySelector('[data-add-to-sequence]')
  if (!node) return null
  const raw = node.getAttribute('data-contact-ids') ?? ''
  return raw === '' ? [] : raw.split(',')
}

describe('useSequenceFlow — save first, then enroll', () => {
  it('saves the selection before anything else happens', async () => {
    publishEntries.mockResolvedValue({
      saved: [{ entry_id: 'p1', kind: 'person', contact_id: 'c1', email: 'a@x.com' }],
      skipped: [],
    })
    await render()
    await start(['p1'])
    // Never with `include_unverified`: the bulk path is what keeps the
    // identity gate meaningful.
    expect(publishEntries).toHaveBeenCalledWith(['p1'], false)
  })

  it('opens the dialog with ONLY the contact ids that came back', async () => {
    // Three entries selected, two promoted — the dialog gets two. A route that
    // silently returned fewer ids than the user picked is precisely what the
    // per-entry outcome shape exists to make visible.
    publishEntries.mockResolvedValue({
      saved: [
        { entry_id: 'p1', kind: 'person', contact_id: 'c1', email: 'a@x.com' },
        { entry_id: 'p2', kind: 'person', contact_id: 'c2', email: 'b@x.com' },
      ],
      skipped: [{ entry_id: 'p3', reason: 'needs_review' }],
    })
    await render()
    await start(['p1', 'p2', 'p3'])
    expect(openedWith()).toEqual(['c1', 'c2'])
  })

  it('passes ONLY contacts with an email, and names the rest inline', async () => {
    publishEntries.mockResolvedValue({
      saved: [
        { entry_id: 'p1', kind: 'person', contact_id: 'c1', email: 'a@x.com' },
        { entry_id: 'p2', kind: 'person', contact_id: 'c2', email: null },
        { entry_id: 'p3', kind: 'person', contact_id: 'c3', email: null },
        { entry_id: 'p4', kind: 'person', contact_id: 'c4', email: '   ' },
      ],
      skipped: [],
    })
    await render()
    await start(['p1', 'p2', 'p3', 'p4'])

    expect(openedWith()).toEqual(['c1'])
    // The §8 copy, rendered where the user pressed the control — not a toast.
    expect(text()).toContain('3 people have no email address and were not added')
  })

  it('says "1 person" when exactly one had no address', async () => {
    publishEntries.mockResolvedValue({
      saved: [
        { entry_id: 'p1', kind: 'person', contact_id: 'c1', email: 'a@x.com' },
        { entry_id: 'p2', kind: 'person', contact_id: 'c2', email: null },
      ],
      skipped: [],
    })
    await render()
    await start(['p1', 'p2'])
    expect(text()).toContain('1 person has no email address and was not added')
  })

  it('reports save refusals in the same words the save toast uses', async () => {
    publishEntries.mockResolvedValue({
      saved: [{ entry_id: 'p1', kind: 'person', contact_id: 'c1', email: 'a@x.com' }],
      skipped: [
        { entry_id: 'p2', reason: 'needs_review' },
        { entry_id: 'p3', reason: 'needs_review' },
        { entry_id: 'p4', reason: 'parent_failed' },
      ],
    })
    await render()
    await start(['p1', 'p2', 'p3', 'p4'])
    const rendered = text()
    expect(rendered).toContain('2 skipped (could not verify the employer)')
    expect(rendered).toContain('1 skipped (their company could not be saved)')
  })

  it('never opens an empty dialog — it says why nobody is going instead', async () => {
    publishEntries.mockResolvedValue({
      saved: [{ entry_id: 'p1', kind: 'person', contact_id: 'c1', email: null }],
      skipped: [],
    })
    await render()
    await start(['p1'])
    expect(openedWith()).toBeNull()
    expect(text()).toContain('Nobody could be added to a sequence')
    expect(text()).toContain('1 person has no email address')
  })

  it('ignores a promoted COMPANY — there is no contact to enroll', async () => {
    publishEntries.mockResolvedValue({
      saved: [
        { entry_id: 'e1', kind: 'company', company_id: 'co1' },
        { entry_id: 'p1', kind: 'person', contact_id: 'c1', email: 'a@x.com' },
      ],
      skipped: [],
    })
    await render()
    await start(['e1', 'p1'])
    expect(openedWith()).toEqual(['c1'])
  })

  it('dedupes two entries that promoted into the same contact', async () => {
    // The same person on two lists is two entries and one contact — enrolling
    // them twice would be one duplicate the dialog would count as two.
    publishEntries.mockResolvedValue({
      saved: [
        { entry_id: 'p1', kind: 'person', contact_id: 'c1', email: 'a@x.com' },
        { entry_id: 'p2', kind: 'person', contact_id: 'c1', email: 'a@x.com' },
      ],
      skipped: [],
    })
    await render()
    await start(['p1', 'p2'])
    expect(openedWith()).toEqual(['c1'])
  })

  it('refetches through onSaved before the dialog reports', async () => {
    const onSaved = vi.fn()
    publishEntries.mockResolvedValue({
      saved: [{ entry_id: 'p1', kind: 'person', contact_id: 'c1', email: 'a@x.com' }],
      skipped: [],
    })
    await render(onSaved)
    await start(['p1'])
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it('surfaces a failed save inline rather than opening anything', async () => {
    publishEntries.mockRejectedValue(new Error('Network down'))
    await render()
    await start(['p1'])
    expect(openedWith()).toBeNull()
    expect(text()).toContain('Network down')
  })

  it('does nothing at all on an empty selection', async () => {
    await render()
    await start([])
    expect(publishEntries).not.toHaveBeenCalled()
    expect(container.querySelector('[data-sequence-note]')).toBeNull()
  })

  it('clears the note on dismiss', async () => {
    publishEntries.mockResolvedValue({
      saved: [{ entry_id: 'p1', kind: 'person', contact_id: 'c1', email: null }],
      skipped: [],
    })
    await render()
    await start(['p1'])
    expect(container.querySelector('[data-sequence-note]')).toBeTruthy()
    await act(async () => {
      flow.dismissNote()
    })
    expect(container.querySelector('[data-sequence-note]')).toBeNull()
  })
})
