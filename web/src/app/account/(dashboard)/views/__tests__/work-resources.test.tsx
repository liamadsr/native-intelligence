// @vitest-environment jsdom
/**
 * WorkResources (Loops v3 Phase 4, W-D) — the shared resource-chip row used on
 * the card "Will use" section and every run view. This upgrade adds per-type
 * icons and optional click-to-open. These tests pin:
 *   • a per-type lucide icon renders left of each chip (unknown type → no icon);
 *   • `isResourceOpenable` gates the button: onOpen present AND id present AND a
 *     navigable type (the DetailPanel-backed entity types + 'package');
 *   • an openable chip is a <button> that fires onOpen with the ref; everything
 *     else stays a static <span>.
 *
 * Mounted standalone with createRoot (no @testing-library, mirroring the sibling
 * attention-card / run-chat tests). agent-run-ui pulls no tab-context, so nothing
 * to mock — it's pure presentation over lucide + cn.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { WorkResources, isResourceOpenable } from '../agent-run-ui'
import type { WorkResourceRef } from '@/lib/agent-run/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function render(node: React.ReactNode) {
  act(() => root.render(node))
}

describe('isResourceOpenable', () => {
  const onOpen = () => {}

  it('is true for a DetailPanel-backed type with an id and onOpen', () => {
    for (const type of ['action', 'capture', 'document', 'contact', 'project', 'initiative']) {
      expect(isResourceOpenable({ type, id: 'x', label: 'L' }, onOpen)).toBe(true)
    }
  })

  it('is true for a package with an id and onOpen (the knowledge deep link)', () => {
    expect(isResourceOpenable({ type: 'package', id: 'pkg-1', label: 'P' }, onOpen)).toBe(true)
  })

  it('is false without onOpen', () => {
    expect(isResourceOpenable({ type: 'action', id: 'x', label: 'L' }, undefined)).toBe(false)
  })

  it('is false without an id (label-only reference)', () => {
    expect(isResourceOpenable({ type: 'action', label: 'L' }, onOpen)).toBe(false)
  })

  it('is false for a type with no navigation target even with an id', () => {
    for (const type of ['email', 'attachment', 'member', 'conversation', 'claim', 'cycle', 'garbage']) {
      expect(isResourceOpenable({ type, id: 'x', label: 'L' }, onOpen)).toBe(false)
    }
  })
})

describe('WorkResources — chips', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  it('renders nothing for empty / null resources', () => {
    render(h(WorkResources, { resources: [] }))
    expect(container.textContent).toBe('')
    render(h(WorkResources, { resources: null }))
    expect(container.textContent).toBe('')
  })

  it('renders a per-type icon (an <svg>) left of each known-type chip', () => {
    const resources: WorkResourceRef[] = [
      { type: 'package', id: 'pkg', label: 'Ctx pack' },
      { type: 'capture', id: 'cap', label: 'Aug 3 call' },
      { type: 'document', id: 'doc', label: 'Spec' },
    ]
    render(h(WorkResources, { resources }))
    // Each chip carries a lucide <svg>. 3 known types → 3 icons.
    expect(container.querySelectorAll('svg').length).toBe(3)
  })

  it('renders no icon for an unknown resource type', () => {
    render(h(WorkResources, { resources: [{ type: 'mystery', id: 'x', label: 'Huh' }] }))
    expect(container.querySelector('svg')).toBeNull()
    expect(container.textContent).toContain('Huh')
  })

  it('renders the custom section label', () => {
    render(h(WorkResources, { resources: [{ type: 'contact', id: 'c', label: 'Randy' }], label: 'Will use' }))
    expect(container.textContent).toContain('Will use')
    // default label:
    render(h(WorkResources, { resources: [{ type: 'contact', id: 'c', label: 'Randy' }] }))
    expect(container.textContent).toContain('Used')
  })

  it('makes an openable chip a <button> and fires onOpen with the ref', () => {
    const onOpen = vi.fn()
    const ref: WorkResourceRef = { type: 'contact', id: 'c-1', label: 'Randy Chen' }
    render(h(WorkResources, { resources: [ref], onOpen }))
    const btn = container.querySelector('button')
    expect(btn).toBeTruthy()
    act(() => btn!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onOpen).toHaveBeenCalledWith(ref)
  })

  it('routes a package chip through onOpen (the knowledge deep link)', () => {
    const onOpen = vi.fn()
    const ref: WorkResourceRef = { type: 'package', id: 'pkg-9', label: 'Onboarding' }
    render(h(WorkResources, { resources: [ref], onOpen }))
    const btn = container.querySelector('button')!
    act(() => btn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onOpen).toHaveBeenCalledWith(ref)
  })

  it('keeps an unsupported type a static span even with id + onOpen', () => {
    const onOpen = vi.fn()
    render(h(WorkResources, { resources: [{ type: 'email', id: 'e-1', label: 'Re: GA' }], onOpen }))
    expect(container.querySelector('button')).toBeNull()
    expect(container.textContent).toContain('Re: GA')
  })

  it('keeps a label-only ref (no id) a static span even when onOpen is wired', () => {
    const onOpen = vi.fn()
    render(h(WorkResources, { resources: [{ type: 'contact', label: 'Someone' }], onOpen }))
    expect(container.querySelector('button')).toBeNull()
    expect(container.textContent).toContain('Someone')
  })

  it('renders static spans when onOpen is absent (icons only)', () => {
    render(h(WorkResources, { resources: [{ type: 'action', id: 'a-1', label: 'GEN-42' }] }))
    expect(container.querySelector('button')).toBeNull()
    // still an icon:
    expect(container.querySelector('svg')).toBeTruthy()
    expect(container.textContent).toContain('GEN-42')
  })
})
