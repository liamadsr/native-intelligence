// @vitest-environment jsdom
/**
 * Menus and popovers fit the window: each shared primitive caps its content
 * to the height Radix says is free on the side it opened to, and scrolls
 * inside it (the owner's long label list ran off the bottom of the window,
 * #menus-fit). Runs against the real installed Radix.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '../popover'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../dropdown-menu'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../context-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../select'
import { MENU_COLLISION_PADDING, fixedMenuStyle, roomFor } from '../menu-fit'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= NoopResizeObserver
  Element.prototype.scrollIntoView ??= function () {}
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.releasePointerCapture ??= function () {}
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function classesOf(selector: string): string {
  const el = document.querySelector(selector)
  expect(el, selector).not.toBeNull()
  return el!.className
}

describe('the shared primitives fit the window', () => {
  it('a popover caps itself to the available height and scrolls', () => {
    act(() =>
      root.render(
        <Popover defaultOpen>
          <PopoverTrigger>Open</PopoverTrigger>
          <PopoverContent data-testid="pop">Body</PopoverContent>
        </Popover>,
      ),
    )
    const cls = classesOf('[data-testid="pop"]')
    expect(cls).toContain('max-h-(--radix-popover-content-available-height)')
    expect(cls).toContain('overflow-y-auto')
  })

  it("a popover keeps a caller's width and padding (the label picker's w-56 p-2)", () => {
    act(() =>
      root.render(
        <Popover defaultOpen>
          <PopoverTrigger>Open</PopoverTrigger>
          <PopoverContent data-testid="pop" className="w-56 p-2">Body</PopoverContent>
        </Popover>,
      ),
    )
    const cls = classesOf('[data-testid="pop"]')
    expect(cls).toContain('w-56')
    expect(cls).toContain('p-2')
    expect(cls).not.toContain('w-72')
    expect(cls).toContain('max-h-(--radix-popover-content-available-height)')
  })

  it('a dropdown menu caps itself to the available height and scrolls', () => {
    act(() =>
      root.render(
        <DropdownMenu defaultOpen modal={false}>
          <DropdownMenuTrigger>Open</DropdownMenuTrigger>
          <DropdownMenuContent data-testid="menu">
            <DropdownMenuItem>One</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>,
      ),
    )
    const cls = classesOf('[data-testid="menu"]')
    expect(cls).toContain('max-h-(--radix-dropdown-menu-content-available-height)')
    expect(cls).toContain('overflow-y-auto')
  })

  it('a context menu caps itself with the Tailwind 4 form of the variable, and scrolls', () => {
    act(() =>
      root.render(
        <ContextMenu modal={false}>
          <ContextMenuTrigger data-testid="area">Area</ContextMenuTrigger>
          <ContextMenuContent data-testid="ctx">
            <ContextMenuItem>One</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>,
      ),
    )
    const area = document.querySelector('[data-testid="area"]')!
    act(() => {
      area.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }))
    })
    const cls = classesOf('[data-testid="ctx"]')
    expect(cls).toContain('max-h-(--radix-context-menu-content-available-height)')
    expect(cls).not.toContain('max-h-[--radix')
    expect(cls).toContain('overflow-y-auto')
  })

  it('a select caps itself to the available height and scrolls', () => {
    act(() =>
      root.render(
        <Select defaultOpen defaultValue="a">
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent data-testid="sel">
            <SelectItem value="a">A</SelectItem>
            <SelectItem value="b">B</SelectItem>
          </SelectContent>
        </Select>,
      ),
    )
    const cls = classesOf('[data-testid="sel"]')
    expect(cls).toContain('max-h-(--radix-select-content-available-height)')
    expect(cls).toContain('overflow-y-auto')
  })
})

describe('roomFor', () => {
  it('stays on its usual side while that side has the room it needs', () => {
    expect(roomFor({ top: 100, bottom: 120 }, 900)).toEqual({
      side: 'bottom',
      maxHeight: 900 - 120 - MENU_COLLISION_PADDING,
      below: 900 - 120 - MENU_COLLISION_PADDING,
      above: 100 - MENU_COLLISION_PADDING,
    })
    // 250px free below is enough: it does not jump above for having more there.
    expect(roomFor({ top: 630, bottom: 642 }, 900).side).toBe('bottom')
  })

  it('opens above when the anchor sits near the bottom of the window', () => {
    const room = roomFor({ top: 520, bottom: 540 }, 600)
    expect(room.side).toBe('top')
    expect(room.maxHeight).toBe(520 - MENU_COLLISION_PADDING)
  })

  it('never caps below the minimum', () => {
    expect(roomFor({ top: 10, bottom: 590 }, 600, { min: 120 }).maxHeight).toBe(120)
  })
})

describe('fixedMenuStyle', () => {
  it('pins the top edge under the anchor when it opens below', () => {
    expect(fixedMenuStyle({ top: 100, bottom: 120 }, { height: 900 })).toEqual({
      side: 'bottom',
      style: { top: 124, maxHeight: 900 - 124 - MENU_COLLISION_PADDING, overflowY: 'auto' },
    })
  })

  it('pins the bottom edge over the anchor when it opens above', () => {
    expect(fixedMenuStyle({ top: 560, bottom: 580 }, { height: 600 })).toEqual({
      side: 'top',
      style: { bottom: 600 - 560 + 4, maxHeight: 560 - 4 - MENU_COLLISION_PADDING, overflowY: 'auto' },
    })
  })
})
