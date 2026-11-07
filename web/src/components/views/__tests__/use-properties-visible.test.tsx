// @vitest-environment jsdom
/**
 * The properties sidebar is width-driven, not toggled.
 *
 * Every detail panel used to carry a manual show/hide button (and the capture
 * panel a persisted global preference). The rule now: show it whenever there's
 * room, step aside when there isn't, and come back on its own as the window
 * grows — so the two things worth pinning are that it reacts to width at all,
 * and that it does so without flickering on the boundary.
 *
 * The hysteresis is the subtle part. Hiding the sidebar widens the content,
 * which can re-satisfy the show condition, which hides it again — so coming
 * back requires slightly more width than staying does.
 *
 * The other pinned behaviour is drag deferral: mounting or unmounting the whole
 * sidebar in the middle of a splitter drag is a render + relayout spike in a
 * frame the user can feel, so the flip waits for the drag to end.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { usePropertiesVisible, PROPERTIES_MIN_WIDTH } from '../use-properties-visible'
import { WindowPropertiesProvider } from '../window-properties'

/** Drives width via a stubbed ResizeObserver + getBoundingClientRect. */
let observerCallback: (() => void) | null = null
let currentWidth = 1200

class StubResizeObserver {
  constructor(cb: () => void) {
    observerCallback = cb
  }
  observe() {}
  disconnect() {
    observerCallback = null
  }
}

function setWidth(px: number) {
  currentWidth = px
  act(() => {
    observerCallback?.()
  })
}

let container: HTMLDivElement
let root: Root
let visible = false

function Probe() {
  const ref = { current: container } as React.RefObject<HTMLElement>
  visible = usePropertiesVisible(ref)
  return null
}

function LockedProbe() {
  const ref = { current: container } as React.RefObject<HTMLElement>
  visible = usePropertiesVisible(ref, true)
  return null
}

beforeEach(() => {
  currentWidth = 1200
  observerCallback = null
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
  container = document.createElement('div')
  container.getBoundingClientRect = () =>
    ({ width: currentWidth, height: 600 }) as DOMRect
  document.body.appendChild(container)
  root = createRoot(document.createElement('div'))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('usePropertiesVisible', () => {
  it('shows the sidebar when there is room', () => {
    act(() => root.render(<Probe />))
    expect(visible).toBe(true)
  })

  it('hides it once the panel is too narrow', () => {
    act(() => root.render(<Probe />))
    setWidth(PROPERTIES_MIN_WIDTH - 1)
    expect(visible).toBe(false)
  })

  it('brings it back when the panel grows again', () => {
    act(() => root.render(<Probe />))
    setWidth(400)
    expect(visible).toBe(false)

    // The whole point: no reload, no toggle — it returns on its own.
    setWidth(1200)
    expect(visible).toBe(true)
  })

  it('needs extra width to reappear, so the boundary does not flicker', () => {
    act(() => root.render(<Probe />))
    setWidth(400)
    expect(visible).toBe(false)

    // Exactly at the threshold is enough to STAY, but not to COME BACK —
    // otherwise showing it re-narrows the content and hides it again.
    setWidth(PROPERTIES_MIN_WIDTH)
    expect(visible).toBe(false)

    setWidth(PROPERTIES_MIN_WIDTH + 40)
    expect(visible).toBe(true)
  })

  it('ignores a zero width instead of collapsing', () => {
    act(() => root.render(<Probe />))
    // display:none or an unmounted subtree reports 0 — not a real answer.
    setWidth(0)
    expect(visible).toBe(true)
  })

  it('stays visible when locked, however narrow the panel gets', () => {
    act(() => root.render(<LockedProbe />))
    // The push compose form lives in the sidebar; unmounting it on a resize
    // would silently discard whatever the user had typed.
    setWidth(200)
    expect(visible).toBe(true)
  })

  it('in a card, follows the card’s Properties popover instead of the width', () => {
    // Closed: no inline sidebar at any width (the fields wait in the popover).
    act(() => root.render(<WindowPropertiesProvider frame={{ isFocused: true, tucked: false }}><Probe /></WindowPropertiesProvider>))
    setWidth(1200)
    expect(visible).toBe(false)
  })
})

describe('usePropertiesVisible — a body that mounts after a loading state', () => {
  // A detail panel shows a loading state until its entity is in, and only then
  // mounts the body its ref points at — the SAME ref object across those
  // renders (useRef), unlike the throwaway refs above. A watch set up only on
  // mount found no element, never ran again, and left the sidebar up at any
  // width.
  function LatePanel({ loaded }: { loaded: boolean }) {
    const ref = useRef<HTMLDivElement>(null)
    visible = usePropertiesVisible(ref)
    return loaded ? <div ref={ref} data-panel-body="" /> : <p>Loading…</p>
  }

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { width: this.hasAttribute('data-panel-body') ? currentWidth : 0, height: 600 } as DOMRect
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('starts watching once the body mounts, and steps aside when the panel narrows', () => {
    act(() => root.render(<LatePanel loaded={false} />))
    act(() => root.render(<LatePanel loaded />))
    setWidth(400)
    expect(visible).toBe(false)
  })

  it('reads the width the moment the body arrives — already narrow means hidden straight away', () => {
    currentWidth = 400
    act(() => root.render(<LatePanel loaded={false} />))
    expect(visible).toBe(true)
    act(() => root.render(<LatePanel loaded />))
    expect(visible).toBe(false)
  })

  it('stops watching while the body is gone, and picks it up again when it returns', () => {
    act(() => root.render(<LatePanel loaded />))
    act(() => root.render(<LatePanel loaded={false} />))
    expect(observerCallback).toBeNull()

    act(() => root.render(<LatePanel loaded />))
    setWidth(400)
    expect(visible).toBe(false)
  })
})
