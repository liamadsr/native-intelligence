// @vitest-environment jsdom
/**
 * The 'enrollment' display property on a sequence row — the SCOPED CONTACT's
 * own enrollment (contact detail panel → Sequences embed).
 *
 * The row reads `item.contact_enrollment`, which the views/query route merges
 * ONLY when the enrolled_contact_id scope filter is active. Pins:
 *
 *  - absent key (every global sequence list) → the cell renders nothing, so
 *    shipping the property in the entity's defaults is safe everywhere,
 *  - active enrollment → progress chip ("Step X of N", next send in the
 *    tooltip labeled with the SEQUENCE's zone),
 *  - exited enrollment → exit-reason chip from the same EXIT_REASON_META the
 *    sequence detail page uses (unknown reason degrades to "Exited").
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/tasks/action-platform-cell', () => ({
  ActionPlatformCell: () => null,
}))

import { EntityRow } from '../list/entity-row'

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

async function renderSequenceRow(item: Record<string, unknown>) {
  await act(async () => {
    root.render(
      h(EntityRow, {
        item,
        entityType: 'sequence',
        displayProperties: ['enrollment'],
        isSelected: false,
        onItemSelect: vi.fn(),
      }),
    )
  })
}

describe('EntityRow — sequence contact-enrollment cell', () => {
  it('renders nothing when contact_enrollment is absent (global lists)', async () => {
    await renderSequenceRow({ id: 'seq-1', name: 'Outreach', status: 'active' })
    expect(container.textContent).toContain('Outreach')
    expect(container.textContent).not.toContain('Step')
    expect(container.textContent).not.toContain('Exited')
  })

  it('active enrollment → progress chip with the next send in the tooltip', async () => {
    await renderSequenceRow({
      id: 'seq-1',
      name: 'Outreach',
      status: 'active',
      timezone: 'UTC',
      contact_enrollment: {
        status: 'active',
        exit_reason: null,
        current_step_order: 1,
        next_send_at: '2026-08-13T14:00:00Z',
        step_count: 3,
      },
    })
    // current_step_order is the last COMPLETED step → the next one is step 2.
    expect(container.textContent).toContain('Step 2 of 3')
    const chip = Array.from(container.querySelectorAll('[title]')).find((el) =>
      el.getAttribute('title')?.startsWith('Next send:'),
    )
    expect(chip).toBeTruthy()
    // Labeled with the sequence's zone, or a viewer elsewhere reads it as local.
    expect(chip?.getAttribute('title')).toContain('UTC')
  })

  it('exited enrollment → exit-reason chip; unknown reasons degrade to "Exited"', async () => {
    await renderSequenceRow({
      id: 'seq-1',
      name: 'Outreach',
      status: 'active',
      contact_enrollment: {
        status: 'exited',
        exit_reason: 'replied',
        current_step_order: 2,
        next_send_at: null,
        step_count: 3,
      },
    })
    expect(container.textContent).toContain('Replied')

    await renderSequenceRow({
      id: 'seq-1',
      name: 'Outreach',
      status: 'active',
      contact_enrollment: {
        status: 'exited',
        exit_reason: 'some_future_reason',
        current_step_order: 2,
        next_send_at: null,
        step_count: 3,
      },
    })
    expect(container.textContent).toContain('Exited')
  })
})
