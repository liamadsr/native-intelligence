// @vitest-environment jsdom
/**
 * The name input is sized by its OWN TEXT, not by a character count.
 *
 * The header used to compute `width: min(max(len,6)+2, 42)ch` and set it
 * inline. `1ch` is the width of the digit zero, and on this proportional font
 * most letters are narrower than that — so the box came out visibly wider than
 * the name inside it and the ⋯ menu, which is supposed to sit immediately after
 * the name, floated away from it. `field-sizing-content` asks the browser to do
 * the measuring instead, which it can do exactly.
 *
 * What is pinned here: no inline width survives, the class that replaces it is
 * present, the bounds that stopped a long name pushing the status pill
 * off-screen are still applied as classes, and the aria-label contract the
 * callers rely on is unchanged.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

import { EntityDetailHeader } from '../entity-detail-header'

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
})

function nameInput(): HTMLInputElement {
  const el = container.querySelector('input')
  if (!el) throw new Error('name input not found')
  return el
}

function render(props: Partial<React.ComponentProps<typeof EntityDetailHeader>> = {}) {
  act(() => {
    root.render(
      <EntityDetailHeader
        viewTitle="Evals"
        onBack={() => {}}
        name="Smoke 2 — discovery call (after fixes)"
        onNameChange={() => {}}
        {...props}
      />,
    )
  })
}

describe('EntityDetailHeader — name sizing', () => {
  it('sizes the name by its content class, with no ch-based inline width', () => {
    render()
    const el = nameInput()

    // THE REGRESSION: a `width: NNch` inline style is exactly what made the box
    // wider than its text. Nothing may write `width` into the style attribute
    // on the declarative path.
    expect(el.getAttribute('style') ?? '').not.toContain('ch')
    expect(el.style.width).toBe('')

    expect(el.className).toContain('field-sizing-content')
    // `w-auto` beats the Input primitive's own `w-full`, which would otherwise
    // make content sizing a no-op.
    expect(el.className).toContain('w-auto')
  })

  it('keeps the width bounds as classes', () => {
    render()
    const cls = nameInput().className
    // A placeholder still has to be clickable, and a long name must scroll
    // inside the box rather than push the status pill off the right edge.
    expect(cls).toContain('min-w-[6ch]')
    expect(cls).toContain('max-w-[42ch]')
  })

  it('measures the text itself when field-sizing is unsupported', () => {
    // jsdom implements neither `CSS.supports` nor layout, so the fallback runs
    // and every measurement comes back 0. A `width: 0px` written from that
    // would collapse the box past its own `min-w` — worse than the bug being
    // fixed — so a zero measurement must leave the declarative sizing alone.
    render()
    expect(nameInput().style.width).toBe('')

    // Given a real measurement, it writes PIXELS — never a ch estimate.
    const rect = vi
      .spyOn(HTMLSpanElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ width: 214 } as DOMRect)
    try {
      render({ name: 'Smoke 2 — discovery call (after fixes) edited' })
      const width = nameInput().style.width
      expect(width).toMatch(/px$/)
      expect(parseFloat(width)).toBeGreaterThanOrEqual(214)
    } finally {
      rect.mockRestore()
    }
  })

  it('still labels the field from the parent view title', () => {
    render({ viewTitle: 'Sequences' })
    expect(nameInput().getAttribute('aria-label')).toBe('Sequence name')

    // A shortened crumb hands the whole title over separately, and the label
    // reads off THAT.
    render({ viewTitle: 'Smoke 2 —…', viewTitleFull: 'Smoke 2 — discovery calls' })
    expect(nameInput().getAttribute('aria-label')).toBe(
      'Smoke 2 — discovery call name',
    )
  })

  it('renders the ⋯ menu immediately after the name, inside the breadcrumb', () => {
    render({ menuItems: <div>Delete</div> })
    const nav = container.querySelector('nav[aria-label="Breadcrumb"]')!
    const more = nav.querySelector('button[aria-label="More actions"]')
    // Same nav, and the element right after the input — the whole reason the
    // input is content-sized at all.
    expect(more).toBeTruthy()
    expect(nameInput().nextElementSibling).toBe(more)
  })
})
