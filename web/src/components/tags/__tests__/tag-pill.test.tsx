// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { TagPill, TagPills } from '../tag-pill'
import { TAG_OPEN_EVENT } from '@/components/editor/tag-suggestion'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const a = { id: 'a', name: 'Renewal', color: '#22c55e' }
const b = { id: 'b', name: 'Mine', color: '#ef4444', personal: true }
const c = { id: 'c', name: 'Q4' }
const d = { id: 'd', name: 'Ops' }

describe('TagPill', () => {
  it('shows its name in its color and lists the tag on click', () => {
    const heard: unknown[] = []
    const on = (e: Event) => heard.push((e as CustomEvent).detail)
    window.addEventListener(TAG_OPEN_EVENT, on)
    act(() => root.render(<TagPill tag={a} />))
    const pill = host.querySelector<HTMLElement>('[data-tag-id="a"]')!
    expect(pill.textContent).toBe('#Renewal')
    expect(pill.style.getPropertyValue('--tag-color')).toBe('#22c55e')
    act(() => pill.click())
    window.removeEventListener(TAG_OPEN_EVENT, on)
    expect(heard).toEqual([{ id: 'a', name: 'Renewal' }])
  })

  it('marks a personal tag and offers remove without listing', () => {
    const removed: string[] = []
    const heard: unknown[] = []
    const on = (e: Event) => heard.push(e)
    window.addEventListener(TAG_OPEN_EVENT, on)
    act(() => root.render(<TagPill tag={b} onRemove={(t) => removed.push(t.id)} />))
    expect(host.querySelector('[title="#Mine (only you)"]')).not.toBeNull()
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Remove #Mine"]')!.click())
    window.removeEventListener(TAG_OPEN_EVENT, on)
    expect(removed).toEqual(['b'])
    expect(heard).toEqual([])
  })
})

describe('TagPills', () => {
  it('caps and counts the rest', () => {
    act(() => root.render(<TagPills tags={[a, b, c, d]} max={2} />))
    expect(host.textContent).toContain('+2')
    expect(host.textContent).not.toContain('#Q4')
  })

  it('draws nothing for no tags', () => {
    act(() => root.render(<TagPills tags={[]} />))
    expect(host.innerHTML).toBe('')
  })
})
