// @vitest-environment jsdom
/**
 * ProspectListDeleteDialog — the confirmation behind both delete doors (the
 * list's settings menu and the index's bulk action; Liam, 2026-09-06).
 *
 * The sentence is the point, so it is pinned: what goes (the list, its
 * candidates, its runs), what stays (CRM records — they only leave the
 * group) and what the user gives up (dismissed candidates may be found
 * again). Then the mechanics: one DELETE per list through the list's own
 * route, a refusal keeps the dialog open with the server's reason, and every
 * deleted id is announced so the index rows and the CRM chips let go of it.
 *
 * Radix portals are not under test — the alert-dialog primitives are stubbed
 * to plain elements that forward `disabled`/`onClick` (company-delete-dialog
 * test pattern).
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

import { ProspectListDeleteDialog } from '../prospect-list-delete-dialog'

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

const text = (id: string) => container.querySelector(`[data-testid="${id}"]`)?.textContent ?? ''
const confirmButton = () => container.querySelector('[data-testid="confirm"]') as HTMLButtonElement

function render(props: Partial<Parameters<typeof ProspectListDeleteDialog>[0]> = {}) {
  const onDeleted = vi.fn()
  const onOpenChange = vi.fn()
  act(() => {
    root.render(
      h(ProspectListDeleteDialog, {
        open: true,
        onOpenChange,
        listIds: ['list-1'],
        listName: 'US B2B SaaS Outbound Teams',
        candidateCount: 110,
        onDeleted,
        ...props,
      }),
    )
  })
  return { onDeleted, onOpenChange }
}

async function confirm() {
  await act(async () => {
    confirmButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {})
}

describe('ProspectListDeleteDialog', () => {
  it('names the list and its candidates, and says what stays in the CRM', () => {
    render()
    expect(text('title')).toBe('Delete “US B2B SaaS Outbound Teams”?')
    const said = text('description')
    expect(said).toContain('its 110 candidates and its run history')
    expect(said).toContain('already published to your CRM stay there')
    expect(said).toContain("leave this list's group")
    expect(said).toContain('dismissed here may turn up in later searches')
    expect(said).toContain('cannot be undone')
    // Live from the first render — there is no dry run to wait for.
    expect(confirmButton().disabled).toBe(false)
  })

  it('uses plural copy for a bulk selection', () => {
    render({ listIds: ['l1', 'l2', 'l3'], listName: undefined, candidateCount: undefined })
    expect(text('title')).toBe('Delete 3 lists?')
    expect(text('description')).toContain('This deletes 3 lists, every candidate in them and their run history')
    expect(text('description')).toContain("leave those lists' groups")
  })

  it('confirming DELETEs each list through its own route, announces it, reports and closes', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      jsonResponse({ deleted: true }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const deletedEvents: string[] = []
    const changedEvents: string[] = []
    const onDeletedEvent = (e: Event) => {
      const d = (e as CustomEvent).detail as { entityType: string; id: string }
      if (d.entityType === 'prospect_list') deletedEvents.push(d.id)
    }
    const onChangedEvent = (e: Event) => changedEvents.push(((e as CustomEvent).detail as { id: string }).id)
    window.addEventListener('dial8:entity-deleted', onDeletedEvent)
    window.addEventListener('dial8:prospect-list-changed', onChangedEvent)

    const { onDeleted, onOpenChange } = render({ listIds: ['l1', 'l2'], listName: undefined })
    await confirm()

    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      '/api/account/prospecting/lists/l1',
      '/api/account/prospecting/lists/l2',
    ])
    for (const call of fetchMock.mock.calls) expect(call[1]).toMatchObject({ method: 'DELETE' })
    expect(onDeleted).toHaveBeenCalledWith({ deleted: ['l1', 'l2'], failed: [] })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(deletedEvents).toEqual(['l1', 'l2'])
    expect(changedEvents).toEqual(['l1', 'l2'])

    window.removeEventListener('dial8:entity-deleted', onDeletedEvent)
    window.removeEventListener('dial8:prospect-list-changed', onChangedEvent)
  })

  it("a refusal keeps the dialog open with the server's reason, and deletes nothing it was told not to", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: 'A run is still going on this list — stop it before deleting', code: 'RUN_LIVE' }, false, 409),
      ),
    )
    const { onDeleted, onOpenChange } = render()
    await confirm()

    expect(onDeleted).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(container.textContent).toContain('stop it before deleting')
    // Back to a live Delete button, not a stuck "Deleting…".
    expect(confirmButton().disabled).toBe(false)
    expect(confirmButton().textContent).toBe('Delete')
  })

  it('a partial batch reports what went and stays open for what did not', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) =>
      url.endsWith('/l2')
        ? jsonResponse({ error: 'A run is still going on this list — stop it before deleting' }, false, 409)
        : jsonResponse({ deleted: true }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { onDeleted, onOpenChange } = render({ listIds: ['l1', 'l2', 'l3'], listName: undefined })
    await confirm()

    expect(onDeleted).toHaveBeenCalledWith({
      deleted: ['l1', 'l3'],
      failed: [{ id: 'l2', error: 'A run is still going on this list — stop it before deleting' }],
    })
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(container.textContent).toContain('1 of 3 could not be deleted')
  })
})
