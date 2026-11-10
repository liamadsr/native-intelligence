// @vitest-environment jsdom
/**
 * A list row's right-click menu is flat-cost: no row mounts a menu (or puts a
 * listener on `document`) until it is right-clicked, and the first right-click
 * opens it with the record's actions. Fixtures are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({ ran: [] as Array<{ id: string; type: string; rowId: string }> }))
vi.mock('@/lib/entities/actions', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/entities/actions')>()
  return {
    ...real,
    runEntityAction: vi.fn(async (id: string, ref: { type: string; id: string }) => {
      hoisted.ran.push({ id, type: ref.type, rowId: ref.id })
      return true
    }),
  }
})

import { EntityRow } from '../entity-row'

const noop = () => {}
const docs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    title: `Fernhill plan ${i}`,
    status: 'active',
    workspace_id: 'ws-1',
  }))

let container: HTMLDivElement
let root: Root
beforeEach(() => {
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

async function renderRows(n: number) {
  await act(async () =>
    root.render(
      <div>
        {docs(n).map((it) => (
          <EntityRow key={it.id} item={it} entityType="document" displayProperties={[]} isSelected={false} onItemSelect={noop} />
        ))}
      </div>,
    ),
  )
}

const shown = () => [...document.querySelectorAll('[data-entity-action]')].map((el) => el.getAttribute('data-entity-action'))

describe('EntityRow right-click menu', () => {
  it('500 rows mount no menu and add no document listeners', async () => {
    const add = vi.spyOn(document, 'addEventListener')
    await renderRows(500)
    expect(add.mock.calls.filter(([type]) => type === 'keydown')).toEqual([])
    add.mockRestore()
    expect(container.children[0].children.length).toBe(500)
  })

  it("opens the row's record actions on the first right-click (Open is the row's own click)", async () => {
    await renderRows(3)
    const row = container.children[0].children[1] as HTMLElement
    await act(async () => {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }))
    })
    expect(shown()).toEqual(['copy_link', 'copy_id', 'rename', 'share', 'make_task', 'archive'])
    await act(async () => (document.querySelector('[data-entity-action="copy_id"]') as HTMLElement).click())
    expect(hoisted.ran).toEqual([{ id: 'copy_id', type: 'document', rowId: docs(3)[1].id }])
  })

  it('arms on the right button going down, before the browser asks for the menu', async () => {
    await renderRows(1)
    const add = vi.spyOn(document, 'addEventListener')
    const row = container.children[0].children[0] as HTMLElement
    await act(async () => {
      row.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 2 }))
    })
    // The Radix root is mounted now (its keydown listener is how it tracks the keyboard).
    expect(add.mock.calls.some(([type]) => type === 'keydown')).toBe(true)
    add.mockRestore()
  })
})
