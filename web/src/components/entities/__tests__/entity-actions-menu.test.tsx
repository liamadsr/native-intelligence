// @vitest-environment jsdom
/**
 * The one entity actions menu renders only the actions the record's kind
 * supports, and each item runs the action layer. Fixtures are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({ canOpen: true, ran: [] as Array<{ id: string; type: string }> }))
vi.mock('@/app/account/(dashboard)/main-chat/main-chat-context', () => ({ useCanOpenCards: () => hoisted.canOpen }))
vi.mock('@/lib/entities/actions', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/entities/actions')>()
  return {
    ...real,
    runEntityAction: vi.fn(async (id: string, ref: { type: string }) => {
      hoisted.ran.push({ id, type: ref.type })
      return true
    }),
    loadShareChannels: vi.fn(async () => []),
  }
})

import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { EntityActionsMenu, EntityActionsMenuItems, EntityContextMenu, PANEL_OMIT, type EntityMenuState } from '../entity-actions-menu'
import type { EntityActionId } from '@/lib/entities/entity-actions-registry'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  hoisted.canOpen = true
  hoisted.ran.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

async function renderItems(type: string, state: EntityMenuState = {}, omit?: readonly EntityActionId[]) {
  await act(async () =>
    root.render(
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <EntityActionsMenuItems entity={{ type, id: 'rec-1', label: 'Fernhill renewal' }} state={state} omit={omit} variant="dropdown" onRename={() => {}} />
        </DropdownMenuContent>
      </DropdownMenu>,
    ),
  )
}

const shown = () => [...document.querySelectorAll('[data-entity-action]')].map((el) => el.getAttribute('data-entity-action'))

describe('EntityActionsMenuItems', () => {
  it("lists a document's full menu", async () => {
    await renderItems('document')
    expect(shown()).toEqual(['open', 'copy_link', 'copy_id', 'rename', 'share', 'make_task', 'archive'])
  })

  it('offers Restore instead of Archive once archived', async () => {
    await renderItems('document', { archived: true })
    expect(shown()).toContain('restore')
    expect(shown()).not.toContain('archive')
  })

  it('hides Archive for a kind with no archive', async () => {
    await renderItems('contact')
    expect(shown()).toEqual(['open', 'copy_link', 'copy_id', 'rename', 'share', 'make_task'])
  })

  it('hides what a calendar event does not support', async () => {
    await renderItems('calendar_event')
    expect(shown()).toEqual(['open', 'copy_id', 'make_task'])
  })

  it('leaves out Open where no chat can open it, and what the host omits', async () => {
    hoisted.canOpen = false
    await renderItems('company', {}, PANEL_OMIT)
    expect(shown()).toEqual(['copy_link', 'copy_id', 'share', 'make_task'])
  })

  it('renders nothing for a kind that is not registered', async () => {
    await renderItems('not_a_kind')
    expect(shown()).toEqual([])
  })

  it('runs the action layer on a pick', async () => {
    await renderItems('project')
    const item = document.querySelector('[data-entity-action="archive"]') as HTMLElement
    await act(async () => item.click())
    expect(hoisted.ran).toEqual([{ id: 'archive', type: 'project' }])
  })
})

describe('EntityActionsMenu', () => {
  it('draws its ⋯ trigger for a kind with actions', async () => {
    await act(async () => root.render(<EntityActionsMenu entity={{ type: 'company', id: 'd-1', label: 'Fernhill renewal' }} omit={PANEL_OMIT} />))
    expect(container.querySelector('[data-entity-actions-trigger]')).not.toBeNull()
  })

  it('draws nothing when everything is omitted', async () => {
    await act(async () =>
      root.render(<EntityActionsMenu entity={{ type: 'comment', id: 'c-1', label: 'Looks good' }} omit={['copy_id']} />),
    )
    expect(container.innerHTML).toBe('')
  })
})

describe("EntityActionsMenu with a page's own verbs (extra)", () => {
  const Trash = () => <svg data-icon="trash" />
  const Move = () => <svg data-icon="move" />
  async function open() {
    const trigger = container.querySelector('[data-entity-actions-trigger]') as HTMLElement
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
  }
  const extras = () => [...document.querySelectorAll('[data-entity-extra-action]')].map((el) => el.getAttribute('data-entity-extra-action'))

  it("lists them under the kind's actions, the destructive one last, and runs a pick", async () => {
    const onDelete = vi.fn()
    const onMove = vi.fn()
    await act(async () =>
      root.render(
        <EntityActionsMenu
          entity={{ type: 'company', id: 'd-1', label: 'Fernhill renewal' }}
          omit={PANEL_OMIT}
          extra={[
            { id: 'delete', label: 'Delete company', icon: Trash, danger: true, onSelect: onDelete },
            null,
            false,
            { id: 'move_to_workspace', label: 'Move to workspace…', icon: Move, onSelect: onMove },
          ]}
        />,
      ),
    )
    await open()
    // The kind's own items are still there, first.
    expect(shown()).toEqual(['open', 'copy_link', 'copy_id', 'share', 'make_task'].filter((a) => !PANEL_OMIT.includes(a as EntityActionId)))
    expect(extras()).toEqual(['move_to_workspace', 'delete'])
    const all = [...document.querySelectorAll('[role="menuitem"]')]
    expect(all[all.length - 1].textContent).toBe('Delete company')
    expect(all[all.length - 1].className).toContain('text-destructive')

    vi.useFakeTimers()
    try {
      await act(async () => (document.querySelector('[data-entity-extra-action="delete"]') as HTMLElement).click())
      // After the menu has closed, so a dialog it opens keeps its focus.
      expect(onDelete).not.toHaveBeenCalled()
      await act(async () => {
        vi.runAllTimers()
      })
    } finally {
      vi.useRealTimers()
    }
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onMove).not.toHaveBeenCalled()
  })

  it('still draws the menu for a kind with no actions of its own when the page has verbs', async () => {
    await act(async () =>
      root.render(
        <EntityActionsMenu
          entity={{ type: 'comment', id: 'c-1', label: 'Looks good' }}
          omit={['copy_id']}
          extra={[{ id: 'delete', label: 'Delete', icon: Trash, danger: true, onSelect: () => {} }]}
        />,
      ),
    )
    expect(container.querySelector('[data-entity-actions-trigger]')).not.toBeNull()
    await open()
    expect(extras()).toEqual(['delete'])
    // No separator above a lone group.
    expect(document.querySelectorAll('[role="separator"]').length).toBe(0)
  })

  it('shows a disabled verb as disabled, with its reason', async () => {
    const onSelect = vi.fn()
    await act(async () =>
      root.render(
        <EntityActionsMenu
          entity={{ type: 'company', id: 'd-1', label: 'Fernhill renewal' }}
          omit={PANEL_OMIT}
          extra={[{ id: 'relations', label: 'Relations', icon: Move, disabled: true, title: 'Not available yet', onSelect }]}
        />,
      ),
    )
    await open()
    const item = document.querySelector('[data-entity-extra-action="relations"]') as HTMLElement
    expect(item.getAttribute('data-disabled')).not.toBeNull()
    expect(item.getAttribute('title')).toBe('Not available yet')
  })
})

describe('EntityContextMenu', () => {
  const chip = (i: number) => (
    <EntityContextMenu key={i} entity={{ type: 'document', id: `doc-${i}`, label: `Fernhill plan ${i}` }}>
      <button type="button" data-chip={i}>
        Fernhill plan {i}
      </button>
    </EntityContextMenu>
  )

  it('mounts no menu (and no document listeners) until a right-click', async () => {
    const add = vi.spyOn(document, 'addEventListener')
    await act(async () => root.render(<div>{Array.from({ length: 200 }, (_, i) => chip(i))}</div>))
    expect(add.mock.calls.filter(([type]) => type === 'keydown')).toEqual([])
    add.mockRestore()
    expect(container.querySelectorAll('button[data-chip]').length).toBe(200)
  })

  it("opens the record's actions on the first right-click", async () => {
    await act(async () => root.render(<div>{chip(7)}</div>))
    const el = container.querySelector('[data-chip="7"]') as HTMLElement
    await act(async () => {
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
    })
    expect(shown()).toEqual(['open', 'copy_link', 'copy_id', 'rename', 'share', 'make_task', 'archive'])
    const copy = document.querySelector('[data-entity-action="copy_id"]') as HTMLElement
    await act(async () => copy.click())
    expect(hoisted.ran).toEqual([{ id: 'copy_id', type: 'document' }])
  })
})
