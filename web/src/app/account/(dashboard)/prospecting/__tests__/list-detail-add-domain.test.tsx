// @vitest-environment jsdom
/**
 * List detail — hand-add by domain, and the collision that is NOT an error.
 *
 * PR 1 ships without a run engine, so hand-add is what makes the list useful
 * on day one: paste a domain, the entry appears, Save promotes it to the CRM.
 * It goes through the SAME `companyCandidateKey` the run engine will use, so a
 * hand-added company suppresses a later discovery of itself (§6, layer 2).
 *
 * THE LOAD-BEARING ASSERTION is the `status:'exists'` path. A
 * `UNIQUE (list_id, candidate_key)` collision comes back HTTP 200 with the
 * existing row, because it is the dedup guarantee working — not a failure. If
 * the UI ever renders it as an error the single most differentiated thing in
 * the design ("we never show you the same company twice") reads to the user as
 * a bug. So: an inline notice, the input stays open, and the entry list is
 * still refreshed.
 *
 * Also pinned: an INVALID_DOMAIN 400 lands inline beside the input rather than
 * in a toast the user must remember while retyping, and the ICP chip opens the
 * editor that PATCHes the list.
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

// The shared views layout and the CRM company panel both pull in the whole
// views/realtime stack. Neither is what this suite is about — the header's
// hand-add path is — so both are stubbed to keep the mount cheap and the
// failure surface honest.
vi.mock('@/components/views/unified-view-layout', () => ({
  UnifiedViewLayout: () => null,
}))
vi.mock('../../views/company-detail-panel', () => ({ CompanyDetailPanel: () => null }))

const fetchList = vi.fn()
const addEntryByDomain = vi.fn()
const patchList = vi.fn()
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    fetchList: (id: string) => fetchList(id),
    addEntryByDomain: (listId: string, domain: string, name?: string | null) =>
      addEntryByDomain(listId, domain, name),
    patchList: (id: string, body: unknown) => patchList(id, body),
  }
})

import { ProspectingRequestError } from '../api'
import { ListDetail } from '../list-detail'
import { EMPTY_COUNTS, LIST, entry } from './fixtures'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  toastError.mockReset()
  toastSuccess.mockReset()
  addEntryByDomain.mockReset()
  patchList.mockReset()
  fetchList.mockReset().mockResolvedValue({
    list: LIST,
    entries: [],
    entry_counts: EMPTY_COUNTS,
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

async function render(onNameLoaded = noop) {
  await act(async () => {
    root.render(<ListDetail listId="list-1" onBack={noop} onNameLoaded={onNameLoaded} />)
  })
  await act(async () => {})
}

/** `document`, not `container`: the ICP panel PORTALS to document.body via
 *  the shared Radix `Sheet` (an in-tree `fixed` panel was painted over by the
 *  dashboard's chat column). The header's own controls are still in-tree, and
 *  a document-wide lookup finds both. */
function byLabel(label: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll('[aria-label]')).find(
    (el) => el.getAttribute('aria-label') === label,
  ) as HTMLElement | undefined
}

async function openAddAndType(domain: string) {
  // "Add company by domain" lives in the header's settings popover now.
  await act(async () => {
    byLabel('List settings')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {
    byLabel('Add company by domain')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {
    const input = byLabel('Company domain') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, domain)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function pressAdd() {
  await act(async () => {
    const add = Array.from(container.querySelectorAll('button')).find(
      (b) => (b.textContent ?? '').trim() === 'Add',
    )!
    add.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {})
}

describe('ListDetail — hand-add by domain', () => {
  it('reports the real list name exactly once so the tab label adopts it', async () => {
    const onNameLoaded = vi.fn()
    await render(onNameLoaded)
    expect(onNameLoaded).toHaveBeenCalledTimes(1)
    expect(onNameLoaded).toHaveBeenCalledWith('Customers like us')
    expect(container.textContent).toContain('Customers like us')
  })

  it('adds a new domain, closes the input and refreshes the list', async () => {
    addEntryByDomain.mockResolvedValue({ entry: entry(), status: 'created' })
    await render()
    await openAddAndType('acme.com')
    await pressAdd()

    expect(addEntryByDomain).toHaveBeenCalledWith('list-1', 'acme.com', undefined)
    expect(toastSuccess).toHaveBeenCalledWith('Added to the list')
    expect(byLabel('Company domain')).toBeUndefined()
    // The entry list is refetched so the new row is visible.
    expect(fetchList).toHaveBeenCalledTimes(2)
  })

  it('treats a collision as the dedup guarantee, not an error', async () => {
    addEntryByDomain.mockResolvedValue({
      entry: entry({ id: 'entry-existing' }),
      status: 'exists',
    })
    await render()
    await openAddAndType('acme.com')
    await pressAdd()

    // Inline, in the words of what is true — never an error toast.
    expect(container.textContent).toContain('Already on this list')
    expect(toastError).not.toHaveBeenCalled()
    // The input stays open so a second paste is one keystroke away, and the
    // typed value is preserved rather than silently wiped.
    const input = byLabel('Company domain') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.value).toBe('acme.com')
    // Still refreshed: the row exists and the user should be able to see it.
    expect(fetchList).toHaveBeenCalledTimes(2)
  })

  it('shows a rejected domain inline beside the input', async () => {
    addEntryByDomain.mockRejectedValue(
      new ProspectingRequestError({
        message: 'gmail.com is a personal email domain',
        code: 'PERSONAL_DOMAIN',
        details: null,
        status: 400,
      }),
    )
    await render()
    await openAddAndType('gmail.com')
    await pressAdd()

    expect(container.textContent).toContain('gmail.com is a personal email domain')
    expect(toastError).not.toHaveBeenCalled()
    expect(byLabel('Company domain')).toBeTruthy()
  })

  it('opens the ICP panel from the settings menu and PATCHes the list', async () => {
    patchList.mockResolvedValue({
      list: { ...LIST, icp_version: 2 },
      icp_version_bumped: true,
    })
    await render()

    // "Edit ICP" lives in the header's settings popover (a portal, so
    // `document`), showing the current version.
    await act(async () => {
      byLabel('List settings')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const chip = Array.from(document.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('v1'),
    )!
    expect(chip.textContent).toContain('Edit ICP')
    // One line, like its neighbours — the target description no longer sits
    // under it, truncated to nothing useful (Liam, 2026-09-06).
    expect(chip.textContent).not.toContain('revenue teams')

    await act(async () => {
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const panel = document.querySelector('[aria-label="Edit ICP"]')
    expect(panel).toBeTruthy()
    // The panel is honest that editing does not retro-invalidate anything.
    expect(panel!.textContent).toContain('does not change candidates already found')

    await act(async () => {
      Array.from(panel!.querySelectorAll('button'))
        .find((b) => (b.textContent ?? '').trim() === 'Save')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {})

    expect(patchList).toHaveBeenCalledTimes(1)
    expect(patchList.mock.calls[0][0]).toBe('list-1')
    expect((patchList.mock.calls[0][1] as { icp: unknown }).icp).toBeTruthy()
    // The bump is reported rather than silently drifting every entry badge.
    expect(toastSuccess.mock.calls[0][0]).toContain('version 1')
  })
})

/**
 * RENAME FROM THE TITLE (Liam, 2026-09-06: "click on this and rename the
 * list … make sure if you rename the list it updates it in the CRM and
 * anywhere else it's shown"). The name is a button; a press makes it a field;
 * Enter (or blur) PATCHes the list and announces the change on the window so
 * every surface that spelled the name out at mount — the CRM's "From list"
 * chips above all — reads it again. Everything keyed on the id needs nothing.
 */
describe('ListDetail — rename from the title', () => {
  const EVENT = 'dial8:prospect-list-changed'

  function titleButton(): HTMLButtonElement | null {
    return container.querySelector('button[data-prospect-list-name]') as HTMLButtonElement | null
  }
  function nameInput(): HTMLInputElement | null {
    return container.querySelector('input[data-prospect-list-name-input]') as HTMLInputElement | null
  }
  async function beginRename() {
    await act(async () => {
      titleButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }
  async function typeName(value: string) {
    const input = nameInput()!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  async function press(key: string) {
    await act(async () => {
      nameInput()!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    })
    await act(async () => {})
  }

  it('turns the title into a field, PATCHes the new name on Enter, and announces it', async () => {
    patchList.mockResolvedValue({ list: { ...LIST, name: 'Q4 outbound' }, icp_version_bumped: false })
    const onNameLoaded = vi.fn()
    const announced = vi.fn()
    window.addEventListener(EVENT, announced)
    try {
      await render(onNameLoaded)
      expect(titleButton()!.textContent).toBe('Customers like us')
      await beginRename()
      expect(nameInput()!.value).toBe('Customers like us')
      await typeName('Q4 outbound')
      await press('Enter')

      expect(patchList).toHaveBeenCalledWith('list-1', { name: 'Q4 outbound' })
      expect(nameInput()).toBeNull()
      expect(titleButton()!.textContent).toBe('Q4 outbound')
      // The tab label follows the loaded name…
      expect(onNameLoaded).toHaveBeenLastCalledWith('Q4 outbound')
      // …and every surface that cached the old one is told to read again.
      expect(announced).toHaveBeenCalledTimes(1)
      expect((announced.mock.calls[0][0] as CustomEvent).detail).toEqual({ id: 'list-1', name: 'Q4 outbound' })
    } finally {
      window.removeEventListener(EVENT, announced)
    }
  })

  it('Escape drops the draft, and an unchanged or blank name writes nothing', async () => {
    await render()
    await beginRename()
    await typeName('Something else')
    await press('Escape')
    expect(nameInput()).toBeNull()
    expect(titleButton()!.textContent).toBe('Customers like us')

    await beginRename()
    await typeName('   ')
    await press('Enter')
    await beginRename()
    await press('Enter')
    expect(patchList).not.toHaveBeenCalled()
  })

  it('says so when the name is already taken, and keeps the old name', async () => {
    patchList.mockRejectedValue(
      new ProspectingRequestError({
        message: 'A list called "Q4 outbound" already exists in this workspace',
        code: 'LIST_NAME_TAKEN',
        details: null,
        status: 409,
      }),
    )
    await render()
    await beginRename()
    await typeName('Q4 outbound')
    await press('Enter')
    expect(toastError).toHaveBeenCalledWith('A list with that name already exists')
    expect(titleButton()!.textContent).toBe('Customers like us')
  })
})
