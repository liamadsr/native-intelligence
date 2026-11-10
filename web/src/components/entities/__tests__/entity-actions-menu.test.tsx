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
import { EntityActionsMenu, EntityActionsMenuItems, PANEL_OMIT, type EntityMenuState } from '../entity-actions-menu'
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
    await renderItems('deal', {}, PANEL_OMIT)
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
    await act(async () => root.render(<EntityActionsMenu entity={{ type: 'deal', id: 'd-1', label: 'Fernhill renewal' }} omit={PANEL_OMIT} />))
    expect(container.querySelector('[data-entity-actions-trigger]')).not.toBeNull()
  })

  it('draws nothing when everything is omitted', async () => {
    await act(async () =>
      root.render(<EntityActionsMenu entity={{ type: 'comment', id: 'c-1', label: 'Looks good' }} omit={['copy_id']} />),
    )
    expect(container.innerHTML).toBe('')
  })
})
