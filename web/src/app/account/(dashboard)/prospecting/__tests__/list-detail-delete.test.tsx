// @vitest-environment jsdom
/**
 * DELETING A LIST from its own settings menu (Liam, 2026-09-06: "add a way to
 * delete a list from this settings button").
 *
 * The menu's last item, below a rule, in the destructive colour. It opens the
 * shared confirmation (the same one the index's bulk delete uses), which
 * names the list and its candidates; confirming goes through the list's own
 * DELETE route, toasts, and lands on the index — the page it was on no longer
 * exists. While a run is live the item is DISABLED with the reason: the route
 * would refuse it anyway, and a menu item that 409s is worse than one that
 * says why it is off.
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
const fetchActiveRuns = vi.fn()
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    fetchList: (id: string) => fetchList(id),
    fetchRuns: (listId: string, limit?: number) => fetchRuns(listId, limit),
    fetchRun: (id: string) => fetchRun(id),
    fetchActiveRuns: () => fetchActiveRuns(),
    fetchSequenced: () => Promise.resolve({}),
    fetchSpend: () => Promise.reject(new Error('not under test')),
  }
})

import { ListDetail } from '../list-detail'
import { LIST, entry } from './fixtures'
import { run } from './run-fixtures'

const ENTRIES = [
  entry({ id: 'c1', fit_score: 90 }),
  entry({ id: 'c2', fit_score: 70 }),
  entry({ id: 'c3', fit_score: 45 }),
]
const COUNTS = { discovered: 3, shortlisted: 0, saved: 0, dismissed: 0, total: 3, pending_publish: 0 }

let container: HTMLDivElement
let root: Root
const onBack = vi.fn()
/** Every DELETE the page issued; the stub answers with `deleteResponse`. */
const deleteCalls: string[] = []
let deleteResponse: { ok: boolean; status: number; body: unknown } = { ok: true, status: 200, body: { deleted: true } }

beforeEach(() => {
  toastError.mockReset()
  toastSuccess.mockReset()
  onBack.mockReset()
  deleteCalls.length = 0
  deleteResponse = { ok: true, status: 200, body: { deleted: true } }
  fetchRun.mockReset()
  fetchRuns.mockReset().mockResolvedValue([])
  fetchActiveRuns.mockReset().mockResolvedValue([])
  fetchList.mockReset().mockResolvedValue({ list: LIST, entries: ENTRIES, entry_counts: COUNTS })
  // The dialog talks to the list route through global fetch; nothing else on
  // this page reaches it (the api module is mocked above).
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deleteCalls.push(url)
        return { ok: deleteResponse.ok, status: deleteResponse.status, json: async () => deleteResponse.body } as Response
      }
      return { ok: false, status: 500, json: async () => ({ error: 'not under test' }) } as Response
    }),
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render() {
  await act(async () => {
    root.render(<ListDetail listId="list-1" onBack={onBack} onNameLoaded={() => {}} />)
  })
  await act(async () => {})
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {})
}

/** Open the settings popover and return its Delete list item. */
async function openDeleteItem(): Promise<HTMLButtonElement> {
  const gear = document.body.querySelector('button[aria-label="List settings"]')
  if (!gear) throw new Error('settings button not rendered')
  await click(gear)
  const item = document.body.querySelector('button[data-prospect-delete-list]')
  if (!item) throw new Error('Delete list not in the settings menu')
  return item as HTMLButtonElement
}

const dialog = () => document.body.querySelector('[data-prospect-list-delete-dialog]')
const confirmButton = () =>
  document.body.querySelector('button[data-prospect-list-delete-confirm]') as HTMLButtonElement | null

describe('ListDetail — Delete list', () => {
  it('is the last item in the settings menu and opens the confirmation naming the list and its candidates', async () => {
    await render()
    const item = await openDeleteItem()
    expect(item.disabled).toBe(false)
    expect(item.textContent?.trim()).toBe('Delete list')

    await click(item)
    const said = (dialog()?.textContent ?? '').replace(/\s+/g, ' ')
    expect(said).toContain(`Delete “${LIST.name}”?`)
    expect(said).toContain('its 3 candidates and its run history')
    expect(said).toContain('already published to your CRM stay there')
    // Nothing has been deleted by opening the dialog.
    expect(deleteCalls).toEqual([])
  })

  it('confirming deletes through the list route, toasts, and goes back to the index', async () => {
    await render()
    await click(await openDeleteItem())
    await click(confirmButton()!)

    expect(deleteCalls).toEqual(['/api/account/prospecting/lists/list-1'])
    expect(toastSuccess).toHaveBeenCalledWith(`Deleted “${LIST.name}”`)
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(toastError).not.toHaveBeenCalled()
  })

  it("a refusal keeps the dialog open with the server's reason and stays on the page", async () => {
    deleteResponse = {
      ok: false,
      status: 409,
      body: { error: 'A run is still going on this list — stop it before deleting', code: 'RUN_LIVE' },
    }
    await render()
    await click(await openDeleteItem())
    await click(confirmButton()!)

    expect(dialog()).toBeTruthy()
    expect(dialog()?.textContent).toContain('stop it before deleting')
    expect(onBack).not.toHaveBeenCalled()
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('is disabled while a run is live, and says why', async () => {
    fetchRuns.mockResolvedValue([run({ status: 'running' })])
    fetchRun.mockResolvedValue(run({ status: 'running' }))
    await render()
    const item = await openDeleteItem()
    expect(item.disabled).toBe(true)
    expect(item.getAttribute('title')).toContain('Stop the run')
  })
})
