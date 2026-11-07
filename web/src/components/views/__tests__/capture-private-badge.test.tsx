// @vitest-environment jsdom
/**
 * The lock badge on a private capture row.
 *
 * Only the creator is ever served a private capture row (RLS + the query
 * engine's predicate), so this mark is a REMINDER — "teammates can't see
 * this" — not an access signal. Two things make it worth pinning:
 *
 *  - It must be tolerant of a row with no `visibility` at all. Lists fetched
 *    before the column shipped, and any consumer that hand-builds a row, must
 *    render exactly as before rather than crashing or drawing a stray lock.
 *  - It is scoped to captures. Contacts have their own three-tier
 *    `visibility` column whose 'private' means something else entirely; a
 *    predicate that only looked at the field would put a lock on those rows.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/tasks/action-platform-cell', () => ({
  ActionPlatformCell: () => null,
}))

import { EntityRow } from '../list/entity-row'
import type { ViewEntityType } from '@/lib/views/types'

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

function lock(): Element | null {
  return container.querySelector('[aria-label="Only you can see this capture"]')
}

async function renderRow(item: Record<string, unknown>, entityType: ViewEntityType = 'capture') {
  await act(async () => {
    root.render(
      h(EntityRow, {
        item,
        entityType,
        displayProperties: [],
        isSelected: false,
        onItemSelect: vi.fn(),
      }),
    )
  })
}

describe('EntityRow — private capture badge', () => {
  it('draws a lock on a private capture', async () => {
    await renderRow({ id: 'cap-1', title: 'Interview', visibility: 'private' })
    expect(lock()).toBeTruthy()
    // The title is still the row's subject — the lock sits beside it, not over it.
    expect(container.textContent).toContain('Interview')
  })

  it('draws NOTHING on a workspace capture', async () => {
    await renderRow({ id: 'cap-1', title: 'Standup', visibility: 'workspace' })
    expect(lock()).toBeNull()
  })

  it('draws nothing on a row with no visibility field at all', async () => {
    await renderRow({ id: 'cap-1', title: 'Standup' })
    expect(lock()).toBeNull()
    expect(container.textContent).toContain('Standup')
  })

  it('does NOT mark a private CONTACT — that column means something else', async () => {
    await renderRow(
      { id: 'ct-1', full_name: 'Ada', title: 'Ada', visibility: 'private' },
      'contact',
    )
    expect(lock()).toBeNull()
  })

  it('carries an accessible name so the lock is not a mystery glyph', async () => {
    await renderRow({ id: 'cap-1', title: 'Interview', visibility: 'private' })
    expect(lock()!.getAttribute('aria-label')).toBe('Only you can see this capture')
  })
})
