// @vitest-environment jsdom
/**
 * The label picker: with more than LABEL_FILTER_THRESHOLD labels it opens with
 * a filter box that narrows the list as the person types and keeps focus;
 * with fewer it is the plain list it always was. Checkboxes and colours are
 * unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { LabelPickerContent, LABEL_FILTER_THRESHOLD, filterLabelGroups } from '../label-picker-content'
import type { LabelGroup, LabelWithScope } from '@/lib/labels/utils'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function label(i: number, name: string): LabelWithScope {
  return { id: `l${i}`, name, color: '#3b82f6', group_name: null } as unknown as LabelWithScope
}

const NAMES = [
  'accelerator', 'access-provisioning', 'action-items', 'billing', 'customers', 'design',
  'draft', 'engineering', 'finance', 'hiring', 'investors', 'legal', 'marketing', 'ops',
]

function groups(n: number): LabelGroup[] {
  return [{ groupName: null, labels: NAMES.slice(0, n).map((name, i) => label(i, name)) }]
}

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

/** Types into a controlled React input the way a keystroke would. */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const rows = () => [...container.querySelectorAll('[role="button"]')].map((el) => el.textContent)

describe('LabelPickerContent', () => {
  it('has no filter box with few labels', () => {
    act(() => root.render(<LabelPickerContent grouped={groups(LABEL_FILTER_THRESHOLD)} selectedIds={[]} onToggle={() => {}} />))
    expect(container.querySelector('[data-label-filter]')).toBeNull()
    expect(rows()).toHaveLength(LABEL_FILTER_THRESHOLD)
  })

  it('filters as the person types, and the box keeps focus', () => {
    act(() => root.render(<LabelPickerContent grouped={groups(NAMES.length)} selectedIds={['l1']} onToggle={() => {}} />))
    const input = container.querySelector<HTMLInputElement>('[data-label-filter]')!
    expect(input).not.toBeNull()
    input.focus()
    type(input, 'ac')
    expect(rows()).toEqual(['accelerator', 'access-provisioning', 'action-items'])
    type(input, 'ACC')
    expect(rows()).toEqual(['accelerator', 'access-provisioning'])
    expect(document.activeElement).toBe(input)
    // The checkbox still shows what is attached, and the colour dot is drawn.
    const access = [...container.querySelectorAll('[role="button"]')].find((el) => el.textContent === 'access-provisioning')!
    expect(access.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('true')
    expect(access.querySelector<HTMLElement>('span.rounded-full[style]')?.style.backgroundColor).toBe('rgb(59, 130, 246)')
  })

  it('says so when nothing matches, and Enter toggles the one label left', () => {
    const onToggle = vi.fn()
    act(() => root.render(<LabelPickerContent grouped={groups(NAMES.length)} selectedIds={[]} onToggle={onToggle} />))
    const input = container.querySelector<HTMLInputElement>('[data-label-filter]')!
    type(input, 'zzz')
    expect(rows()).toHaveLength(0)
    expect(container.textContent).toContain('No labels match.')
    type(input, 'hiring')
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onToggle).toHaveBeenCalledWith('l9', false)
  })
})

describe('filterLabelGroups', () => {
  it('drops groups left empty', () => {
    const g: LabelGroup[] = [
      { groupName: 'A', labels: [label(1, 'one')] },
      { groupName: 'B', labels: [label(2, 'two')] },
    ]
    expect(filterLabelGroups(g, 'tw').map((x) => x.groupName)).toEqual(['B'])
    expect(filterLabelGroups(g, '  ')).toBe(g)
  })
})
