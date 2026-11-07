// @vitest-environment jsdom
/**
 * The Properties popover (window-properties.tsx): a detail page's properties
 * and, under Actions, its toolbar actions, behind the Properties button of
 * the frame it is in (each card in the chat mounts one; windows did before).
 * Ported from the window tests of PR #557 with the frame given as a prop.
 */
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { act, useState } from 'react'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { PreferenceActionButton } from '../preference-action'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WindowPropertiesButton,
  WindowPropertiesProvider,
  WindowPropertiesSidebar,
  WindowProperties,
  WindowActions,
  useWindowPropertiesSidebarShown,
  type PropertiesFrame,
} from '../window-properties'
;(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: Root

function frame(focused: boolean, tucked = false): PropertiesFrame {
  return { isFocused: focused, tucked }
}
function Fields() {
  const [value, setValue] = useState('Draft')
  return (
    <>
      <input
        aria-label="Property draft"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <Popover>
        <PopoverTrigger>Choose status</PopoverTrigger>
        <PopoverContent>
          <button>In progress</button>
        </PopoverContent>
      </Popover>
    </>
  )
}
function Actions({ reveal = false }: { reveal?: boolean }) {
  const [copies, setCopies] = useState(0)
  return <WindowActions reveal={reveal} className="toolbar">
    <PreferenceActionButton label={copies ? `Copied ${copies} times` : 'Copy ID'} onClick={() => setCopies(copies + 1)}>
      <svg aria-hidden="true" />
    </PreferenceActionButton>
    <Dialog>
      <DialogTrigger asChild><PreferenceActionButton label="Share capture"><svg aria-hidden="true" /></PreferenceActionButton></DialogTrigger>
      <DialogContent aria-describedby={undefined}><DialogTitle>Share capture options</DialogTitle><button>Copy share link</button></DialogContent>
    </Dialog>
  </WindowActions>
}
function Fixture({
  focused = 'capture',
  locked = false,
  tucked = false,
  title = 'Weekly sync',
  revealActions = false,
}: {
  focused?: string
  locked?: boolean
  tucked?: boolean
  title?: string
  revealActions?: boolean
}) {
  return (
    <>
      <header data-page-header />
      <main>
          <WindowPropertiesProvider frame={frame(focused === 'capture', tucked)}>
          <section data-window="capture">
            <header><WindowPropertiesButton /></header>
            <h1>Capture content</h1>
            <Actions reveal={revealActions} />
            <WindowProperties title={title} locked={locked}>
              <Fields />
            </WindowProperties>
          </section>
          </WindowPropertiesProvider>
          <WindowPropertiesProvider frame={frame(focused === 'action', tucked)}>
          <section data-window="action">
            <header><WindowPropertiesButton /></header>
            <h1>Action content</h1>
            <WindowProperties title="Send proposal">
              <button>High priority</button>
            </WindowProperties>
          </section>
          </WindowPropertiesProvider>
      </main>
      <button>Outside</button>
    </>
  )
}
async function render(props: Parameters<typeof Fixture>[0] = {}) {
  await act(async () => root.render(<Fixture {...props} />))
}
function button(label: string, window?: string) {
  const scope = window ? document.querySelector(`[data-window="${window}"]`)! : document
  const found = Array.from(scope.querySelectorAll('button')).find(
    (node) =>
      node.getAttribute('aria-label') === label || node.textContent === label,
  )
  if (!found) throw new Error(`Missing button: ${label}`)
  return found
}
async function click(label: string) {
  await act(async () => button(label).click())
}
async function hover() {
  await act(async () => {
    button('Properties').dispatchEvent(
      new MouseEvent('pointerover', { bubbles: true }),
    )
  })
}
async function moveOutside() {
  await act(async () => {
    button('Outside').dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 900, clientY: 900 }),
    )
    await new Promise((resolve) => setTimeout(resolve, 450))
  })
}
function dialog() {
  return document.querySelector('[role="dialog"][aria-label$=" properties"]')
}
function positionHoverSurfaces() {
  vi.spyOn(button('Properties'), 'getBoundingClientRect').mockReturnValue(new DOMRect(600, 100, 28, 28))
  vi.spyOn(dialog()!, 'getBoundingClientRect').mockReturnValue(new DOMRect(308, 134, 320, 440))
}
async function movePointer(x: number, y: number, wait = 450) {
  await act(async () => {
    document.body.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y }))
    await new Promise((resolve) => setTimeout(resolve, wait))
  })
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })))
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('window properties', () => {
  it('moves labeled toolbar actions below the properties in a separate group', async () => {
    await render()
    expect(container.querySelector('.toolbar')).toBeNull()
    expect(document.querySelector('[aria-label="Copy ID"]')).toBeNull()
    await hover()
    const group = dialog()!.querySelector('[role="group"][aria-label="Actions"]')!
    expect(group.textContent).toContain('Copy ID')
    expect(group.textContent).toContain('Share capture')
    expect(document.querySelector('[aria-label="Property draft"]')!.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
  it('preserves action state when closing and reopening preferences', async () => {
    await render()
    await click('Properties')
    await click('Copy ID')
    expect(button('Copied 1 times')).toBeTruthy()
    await click('Properties')
    expect(document.querySelector('[data-preference-actions]')).toBeNull()
    await click('Properties')
    expect(button('Copied 1 times').textContent).toBe('Copied 1 times')
  })
  it('keeps action dialogs usable outside the preferences portal', async () => {
    await render()
    await hover()
    await act(async () => button('Share capture').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
    await click('Share capture')
    expect(button('Copy share link')).toBeTruthy()
    await click('Copy share link')
    expect(document.body.textContent).toContain('Share capture options')
    expect(dialog()).not.toBeNull()
  })
  it('reveals the preferences for an externally opened action such as the reminder shortcut', async () => {
    await render()
    expect(dialog()).toBeNull()
    await render({ revealActions: true })
    expect(dialog()).not.toBeNull()
    await moveOutside()
    expect(dialog()).not.toBeNull()
  })
  it('retains the original toolbar presentation outside a content window', async () => {
    await act(async () => root.render(<Actions />))
    expect(container.querySelector('.toolbar')).not.toBeNull()
    expect(button('Copy ID').textContent).toBe('')
    await click('Copy ID')
    expect(button('Copied 1 times')).toBeTruthy()
  })
  it('offers an icon in each window header with no page-level button or panel heading', async () => {
    await render()
    expect(
      container.querySelectorAll('[aria-label="Properties"]'),
    ).toHaveLength(2)
    expect(container.querySelector('[data-page-header] button')).toBeNull()
    expect(button('Properties', 'capture').textContent).toBe('')
    expect(button('Properties', 'action').textContent).toBe('')
    expect(container.querySelector('main input')).toBeNull()
    expect(dialog()).toBeNull()
    expect(container.textContent).toContain('Capture content')
  })
  it('opens immediately on hover without taking focus, and closes after leaving', async () => {
    await render()
    button('Outside').focus()
    await hover()
    expect(dialog()?.getAttribute('aria-label')).toBe('Weekly sync properties')
    expect(dialog()?.textContent).not.toContain('Weekly sync')
    expect(dialog()?.textContent).not.toContain('Properties')
    expect(document.activeElement).toBe(button('Outside'))
    expect(
      document.querySelector('[aria-label="Property draft"]'),
    ).not.toBeNull()
    await moveOutside()
    expect(dialog()).toBeNull()
  })
  it('pins a hover preview on click and closes explicitly', async () => {
    await render()
    await hover()
    await click('Properties')
    await moveOutside()
    expect(dialog()).not.toBeNull()
    await click('Properties')
    expect(dialog()).toBeNull()
  })
  it('ignores animation-generated leave events while the pointer stays over the icon', async () => {
    await render()
    await hover()
    positionHoverSurfaces()
    await act(async () => {
      for (const element of [button('Properties'), dialog()!]) {
        element.dispatchEvent(new MouseEvent('pointerout', {
          bubbles: true, relatedTarget: document.body, clientX: 614, clientY: 114,
        }))
      }
      await new Promise((resolve) => setTimeout(resolve, 450))
    })
    expect(dialog()).not.toBeNull()
  })
  it('keeps the panel open across the icon gap and just beyond its edges', async () => {
    await render()
    await hover()
    positionHoverSurfaces()
    await movePointer(614, 131)
    expect(dialog()).not.toBeNull()
    await movePointer(302, 250)
    expect(dialog()).not.toBeNull()
    await moveOutside()
    expect(dialog()).toBeNull()
  })
  it('cancels dismissal when the pointer returns before the grace period ends', async () => {
    await render()
    await hover()
    positionHoverSurfaces()
    await movePointer(900, 900, 200)
    expect(dialog()).not.toBeNull()
    await movePointer(614, 114)
    expect(dialog()).not.toBeNull()
  })
  it('keeps a background window’s hovered panel open when that window gains focus', async () => {
    await render({ focused: 'action' })
    await hover()
    await render({ focused: 'capture' })
    expect(dialog()?.getAttribute('aria-label')).toBe('Weekly sync properties')
  })
  it('supports keyboard opening and Escape with focus restored to the button', async () => {
    await render()
    button('Properties').focus()
    await act(async () =>
      button('Properties').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      ),
    )
    expect(document.activeElement?.getAttribute('aria-label')).toBe(
      'Property draft',
    )
    await act(async () =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    )
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(button('Properties'))
  })
  it('gives each window its own fields and closes previews when focus changes or windows tuck', async () => {
    await render()
    await click('Properties')
    await render({ focused: 'action' })
    expect(dialog()).toBeNull()
    await act(async () => button('Properties', 'action').click())
    expect(dialog()?.getAttribute('aria-label')).toBe('Send proposal properties')
    expect(dialog()?.textContent).toContain('High priority')
    expect(dialog()?.textContent).not.toContain('Weekly sync')
    await render({ tucked: true })
    expect(container.querySelector('[aria-label="Properties"]')).toBeNull()
    expect(dialog()).toBeNull()
  })
  it('preserves field DOM and drafts when closing and revisiting the window', async () => {
    await render()
    await click('Properties')
    const input = document.querySelector<HTMLInputElement>(
      '[aria-label="Property draft"]',
    )!
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, 'Unfinished edit')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('Properties')
    await render({ focused: 'action' })
    await render()
    await click('Properties')
    expect(document.querySelector('[aria-label="Property draft"]')).toBe(input)
    expect(input.value).toBe('Unfinished edit')
  })
  it('keeps the parent open while selecting a nested portalled property picker', async () => {
    await render()
    await hover()
    await click('Choose status')
    await act(async () =>
      button('In progress').dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true }),
      ),
    )
    await click('In progress')
    expect(dialog()).not.toBeNull()
  })
  it('opens an armed compose form automatically and keeps it reachable', async () => {
    await render({ locked: true })
    expect(dialog()).not.toBeNull()
    await click('Properties')
    expect(dialog()).not.toBeNull()
    await moveOutside()
    expect(dialog()).not.toBeNull()
  })
  it('updates the entity label without closing an open inspector', async () => {
    await render()
    await click('Properties')
    await render({ title: 'Renamed capture' })
    expect(dialog()?.getAttribute('aria-label')).toBe('Renamed capture properties')
    expect(dialog()?.textContent).not.toContain('Renamed capture')
  })
})

/**
 * A card full screen with room (`embedded`: card-body.tsx): the properties in
 * a column on the right, always shown, and no header button; back in the chat
 * the button again, with the very same fields (moved, never drawn twice).
 */
describe('embedded properties (a card full screen)', () => {
  function Row() {
    return <div data-row="" data-column-shown={String(useWindowPropertiesSidebarShown())}><h1>Card content</h1><WindowPropertiesSidebar /></div>
  }
  function Embedded({ embedded, properties = true }: { embedded: boolean; properties?: boolean }) {
    return (
      <WindowPropertiesProvider frame={{ isFocused: true, tucked: false, embedded }}>
        <section data-window="card">
          <header><WindowPropertiesButton /></header>
          <Row />
          {properties && <Actions />}
          {properties && (
            <WindowProperties title="Weekly sync">
              <Fields />
            </WindowProperties>
          )}
        </section>
      </WindowPropertiesProvider>
    )
  }
  const shown = () => document.querySelector('[data-row]')!.getAttribute('data-column-shown')
  const sidebar = () => document.querySelector<HTMLElement>('[data-properties-sidebar]')
  const draft = () => document.querySelector<HTMLInputElement>('[aria-label="Property draft"]')

  it('shows the fields and actions in a column, open, with no header button', async () => {
    await act(async () => root.render(<Embedded embedded />))
    expect(document.querySelector('button[aria-label="Properties"]')).toBeNull()
    const column = sidebar()!
    expect(column.getAttribute('aria-label')).toBe('Weekly sync properties')
    expect(column.contains(draft())).toBe(true)
    expect(column.querySelector('[role="group"][aria-label="Actions"]')!.textContent).toContain('Copy ID')
    // No popover anywhere: the column is the inspector.
    expect(dialog()).toBeNull()
    expect(shown()).toBe('true')
  })

  it('a page with no properties (a list) shows no column, so it keeps its full width', async () => {
    await act(async () => root.render(<Embedded embedded properties={false} />))
    expect(sidebar()).toBeNull()
    expect(shown()).toBe('false')
  })

  it('back in the chat: the button again, and the same field with its draft', async () => {
    await act(async () => root.render(<Embedded embedded />))
    const input = draft()!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Half typed')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => root.render(<Embedded embedded={false} />))
    expect(sidebar()).toBeNull()
    await click('Properties')
    expect(dialog()!.contains(draft())).toBe(true)
    expect(draft()).toBe(input)
    expect(input.value).toBe('Half typed')
  })
})
