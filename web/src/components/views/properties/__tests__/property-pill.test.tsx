// @vitest-environment jsdom
/**
 * The extracted card-surface PropertyPill.
 *
 * The three host suites (proposal-card, attention-card, create-dialog's
 * consumers) already pin the BEHAVIOUR at each call site. What they do NOT pin
 * — and what this extraction could silently break — is that each `variant`
 * still emits the exact trigger DOM its host used to build inline. The three
 * were never identical: different heights, borders, label widths and popover
 * widths, and `attention` has a whole separate render path when disabled.
 *
 * So this file is a per-variant DOM contract, deliberately class-literal. If
 * someone "harmonises" the variants into one set of tokens, these fail — which
 * is the point.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { PropertyPill } from '../property-pill'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

function render(props: Parameters<typeof PropertyPill>[0]) {
  act(() => root.render(h(PropertyPill, props)))
  return container.querySelector('button')!
}

const icon = h('svg', { 'data-testid': 'icon' })

describe('PropertyPill — shared contract', () => {
  it('renders the icon and the label in every variant', () => {
    for (const variant of ['dialog', 'proposal', 'attention'] as const) {
      const btn = render({ variant, icon, label: 'Engineering', children: () => null })
      expect(btn, variant).toBeTruthy()
      expect(btn.textContent, variant).toContain('Engineering')
      expect(btn.querySelector('[data-testid="icon"]'), variant).toBeTruthy()
      // The label always truncates rather than wrapping the pill.
      expect(btn.querySelector('.truncate'), variant).toBeTruthy()
    }
  })

  it('is a rounded-full bordered pill in every variant', () => {
    for (const variant of ['dialog', 'proposal', 'attention'] as const) {
      const btn = render({ variant, icon, label: 'X', children: () => null })
      expect(btn.className, variant).toContain('rounded-full')
      expect(btn.className, variant).toContain('border')
    }
  })

  it('mutes the label colour when `muted`', () => {
    for (const variant of ['dialog', 'proposal', 'attention'] as const) {
      const btn = render({ variant, icon, label: 'X', muted: true, children: () => null })
      expect(btn.className, variant).toContain('text-muted-foreground')
    }
  })
})

describe('PropertyPill — dialog variant', () => {
  it('sizes by padding (no fixed height) and allows a 120px label', () => {
    const btn = render({ variant: 'dialog', icon, label: 'X', children: () => null })
    expect(btn.className).toContain('px-2.5')
    expect(btn.className).toContain('py-1')
    expect(btn.className).toContain('text-xs')
    expect(btn.className).not.toContain('h-7')
    expect(btn.className).not.toContain('h-6')
    expect(btn.querySelector('.truncate')!.className).toContain('max-w-[120px]')
  })

  it('tightens padding, text and label width when `small`', () => {
    const btn = render({ variant: 'dialog', icon, label: 'X', small: true, children: () => null })
    expect(btn.className).toContain('px-2')
    expect(btn.className).toContain('py-0.5')
    expect(btn.className).toContain('text-[11px]')
    expect(btn.querySelector('.truncate')!.className).toContain('max-w-[80px]')
  })
})

describe('PropertyPill — proposal variant', () => {
  it('is a h-7 shadowed pill with an 80px label', () => {
    const btn = render({ variant: 'proposal', icon, label: 'X', children: () => null })
    expect(btn.className).toContain('h-7')
    expect(btn.className).toContain('shadow-sm')
    expect(btn.className).toContain('border-border')
    expect(btn.querySelector('.truncate')!.className).toContain('max-w-[80px]')
  })

  it('shows the destructive pulsing outline when `error`, overriding `muted`', () => {
    const btn = render({
      variant: 'proposal', icon, label: 'Project', error: true, muted: true, children: () => null,
    })
    expect(btn.className).toContain('border-destructive')
    expect(btn.className).toContain('text-destructive')
    expect(btn.className).toContain('animate-pulse')
    // `error` wins: the pill must read as missing, not merely unset.
    expect(btn.className).not.toContain('text-muted-foreground')
  })
})

describe('PropertyPill — attention variant', () => {
  it('is a h-6 pill with a softer border and text', () => {
    const btn = render({ variant: 'attention', icon, label: 'X', children: () => null })
    expect(btn.className).toContain('h-6')
    expect(btn.className).toContain('border-border/60')
    expect(btn.className).toContain('text-foreground/80')
    expect(btn.getAttribute('type')).toBe('button')
  })

  it('holds its natural width by default and truncates only when `shrinkable`', () => {
    const fixed = render({ variant: 'attention', icon, label: 'X', children: () => null })
    expect(fixed.className).toContain('shrink-0')
    expect(fixed.className).not.toContain('max-w-[120px]')

    const shrinks = render({ variant: 'attention', icon, label: 'X', shrinkable: true, children: () => null })
    expect(shrinks.className).toContain('min-w-0')
    expect(shrinks.className).toContain('max-w-[120px]')
  })

  it('renders a bare disabled button with no popover trigger wiring', () => {
    const btn = render({ variant: 'attention', icon, label: 'X', disabled: true, children: () => null })
    expect(btn.disabled).toBe(true)
    expect(btn.className).toContain('cursor-default')
    expect(btn.className).toContain('border-border/50')
    // Not a Popover trigger: no Radix state/aria handles on the element.
    expect(btn.getAttribute('aria-expanded')).toBeNull()
    expect(btn.getAttribute('data-state')).toBeNull()
  })

  it('also skips the popover when there are no children to show', () => {
    const btn = render({ variant: 'attention', icon, label: 'X' })
    expect(btn.getAttribute('aria-expanded')).toBeNull()
    expect(btn.getAttribute('data-state')).toBeNull()
  })
})

describe('PropertyPill — popover wiring', () => {
  it('wires an interactive pill as a popover trigger', () => {
    for (const variant of ['dialog', 'proposal', 'attention'] as const) {
      const btn = render({ variant, icon, label: 'X', children: () => null })
      expect(btn.getAttribute('aria-expanded'), variant).toBe('false')
    }
  })

  it('opens the popover and renders the picker content on click', () => {
    const btn = render({
      variant: 'proposal', icon, label: 'X',
      children: () => h('div', { 'data-testid': 'picker' }, 'options'),
    })
    act(() => { btn.click() })
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('[data-testid="picker"]')).toBeTruthy()
  })

  it('passes a close callback that shuts the popover', () => {
    let close: () => void = () => {}
    const btn = render({
      variant: 'proposal', icon, label: 'X',
      children: c => { close = c; return h('div', null, 'options') },
    })
    act(() => { btn.click() })
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    act(() => { close() })
    expect(btn.getAttribute('aria-expanded')).toBe('false')
  })

  it('gives `keepOpen` pills a no-op close so multi-select stays open', () => {
    let close: () => void = () => {}
    const btn = render({
      variant: 'dialog', icon, label: 'Labels', keepOpen: true,
      children: c => { close = c; return h('div', null, 'options') },
    })
    act(() => { btn.click() })
    act(() => { close() })
    expect(btn.getAttribute('aria-expanded')).toBe('true')
  })
})
