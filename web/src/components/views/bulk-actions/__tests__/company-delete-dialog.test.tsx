// @vitest-environment jsdom
/**
 * CompanyDeleteDialog — the confirmation for the company cascade delete.
 *
 * The whole point of this dialog is that the user sees EXACTLY how many
 * people (contacts) will be deleted along with the companies before they can
 * confirm. Pinned behaviours:
 *
 *  - on open it POSTs a dry_run to /api/account/companies/bulk-delete and the
 *    Delete button stays DISABLED until the counts arrive;
 *  - the resolved counts appear in the description (singular + plural copy);
 *  - confirming POSTs the real delete (no dry_run) and reports the result via
 *    onDeleted;
 *  - a failed delete keeps the dialog open and shows the error.
 *
 * Radix portals are not under test — the alert-dialog primitives are stubbed
 * to plain elements that forward `disabled`/`onClick` (comments.test pattern).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
    open ? h('div', {}, children) : null,
  AlertDialogAction: ({ children, disabled, onClick }: {
    children?: ReactNode
    disabled?: boolean
    onClick?: (e: React.MouseEvent) => void
  }) => h('button', { type: 'button', 'data-testid': 'confirm', disabled, onClick }, children),
  AlertDialogCancel: ({ children, disabled }: { children?: ReactNode; disabled?: boolean }) =>
    h('button', { type: 'button', 'data-testid': 'cancel', disabled }, children),
  AlertDialogContent: ({ children }: { children?: ReactNode }) => h('div', {}, children),
  AlertDialogDescription: ({ children }: { children?: ReactNode }) =>
    h('div', { 'data-testid': 'description' }, children),
  AlertDialogFooter: ({ children }: { children?: ReactNode }) => h('div', {}, children),
  AlertDialogHeader: ({ children }: { children?: ReactNode }) => h('div', {}, children),
  AlertDialogTitle: ({ children }: { children?: ReactNode }) =>
    h('div', { 'data-testid': 'title' }, children),
}))

import { CompanyDeleteDialog } from '../company-delete-dialog'

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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response
}

const confirmButton = () =>
  container.querySelector('[data-testid="confirm"]') as HTMLButtonElement

const render = (props: Partial<Parameters<typeof CompanyDeleteDialog>[0]> = {}) => {
  act(() => {
    root.render(
      h(CompanyDeleteDialog, {
        open: true,
        onOpenChange: vi.fn(),
        companyIds: ['co-1'],
        companyName: 'Acme',
        onDeleted: vi.fn(),
        ...props,
      }),
    )
  })
}

describe('CompanyDeleteDialog', () => {
  it('keeps Delete disabled until the dry-run counts resolve, then shows them', async () => {
    let resolveDryRun!: (r: Response) => void
    const fetchMock = vi.fn().mockReturnValueOnce(
      new Promise<Response>((resolve) => { resolveDryRun = resolve }),
    )
    vi.stubGlobal('fetch', fetchMock)

    render()

    // Dry run fired on open.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/account/companies/bulk-delete')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      ids: ['co-1'],
      dry_run: true,
    })

    // Gated: counting message on screen, Delete disabled.
    expect(container.textContent).toContain('Counting people…')
    expect(confirmButton().disabled).toBe(true)

    await act(async () => {
      resolveDryRun(jsonResponse({ companies: 1, contacts: 3 }))
    })

    // Counts on screen, Delete enabled.
    expect(container.querySelector('[data-testid="description"]')!.textContent)
      .toContain('its 3 people')
    expect(container.querySelector('[data-testid="title"]')!.textContent)
      .toBe('Delete Acme?')
    expect(confirmButton().disabled).toBe(false)
  })

  it('uses plural copy with the dry-run counts for multiple companies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ companies: 2, contacts: 7 })))

    render({ companyIds: ['co-1', 'co-2'], companyName: undefined })
    await act(async () => {})

    expect(container.querySelector('[data-testid="title"]')!.textContent)
      .toBe('Delete 2 companies?')
    expect(container.querySelector('[data-testid="description"]')!.textContent)
      .toContain('permanently delete 2 companies and their 7 people')
  })

  it('says the company has no people when the dry run counts zero', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ companies: 1, contacts: 0 })))

    render()
    await act(async () => {})

    expect(container.querySelector('[data-testid="description"]')!.textContent)
      .toContain('This company has no people.')
    expect(confirmButton().disabled).toBe(false)
  })

  it('confirming runs the real delete and reports the result', async () => {
    const onDeleted = vi.fn()
    const onOpenChange = vi.fn()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ companies: 1, contacts: 3 }))
      .mockResolvedValueOnce(jsonResponse({ companies: 1, contacts: 3 }))
    vi.stubGlobal('fetch', fetchMock)

    render({ onDeleted, onOpenChange })
    await act(async () => {})

    await act(async () => {
      confirmButton().click()
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    // The real delete carries no dry_run flag.
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ ids: ['co-1'] })
    expect(onDeleted).toHaveBeenCalledWith({ companies: 1, contacts: 3 })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('keeps the dialog open and shows the error when the delete fails', async () => {
    const onDeleted = vi.fn()
    const onOpenChange = vi.fn()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ companies: 1, contacts: 3 }))
      .mockResolvedValueOnce(jsonResponse({ error: 'Failed to delete companies' }, false, 500))
    vi.stubGlobal('fetch', fetchMock)

    render({ onDeleted, onOpenChange })
    await act(async () => {})

    await act(async () => {
      confirmButton().click()
    })

    expect(onDeleted).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(container.textContent).toContain('Failed to delete companies')
    // Still confirmable after the failure.
    expect(confirmButton().disabled).toBe(false)
  })
})
