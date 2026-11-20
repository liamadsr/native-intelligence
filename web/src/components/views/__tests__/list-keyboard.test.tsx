// @vitest-environment jsdom
/**
 * A list's keyboard (list-keyboard.tsx): which list a key is for, how J and K
 * step, and how a task key opens the picker on the row it is on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listOwnsKeys, openPropertyPicker, regionOwnsKeys, stepListFocus } from '../list-keyboard'

/** jsdom lays nothing out: every element reads as shown. */
function layOut(): void {
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList)
}

function keyOn(target: EventTarget, key = 'j'): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true })
  Object.defineProperty(e, 'target', { value: target })
  return e
}

function list(parent: HTMLElement = document.body): HTMLElement {
  const root = document.createElement('div')
  root.setAttribute('data-list-keyboard-root', '')
  parent.appendChild(root)
  return root
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('stepListFocus', () => {
  const ids = ['a', 'b', 'c']
  it('starts at the first going down, the last going up', () => {
    expect(stepListFocus(ids, null, 1)).toBe('a')
    expect(stepListFocus(ids, null, -1)).toBe('c')
  })
  it('steps and stops at the ends', () => {
    expect(stepListFocus(ids, 'a', 1)).toBe('b')
    expect(stepListFocus(ids, 'c', 1)).toBe('c')
    expect(stepListFocus(ids, 'a', -1)).toBe('a')
  })
  it('from a row that left the list, starts again', () => {
    expect(stepListFocus(ids, 'gone', 1)).toBe('a')
    expect(stepListFocus([], 'a', 1)).toBeNull()
  })
})

describe('listOwnsKeys', () => {
  it('takes a key typed inside the list; on its controls, letters only', () => {
    layOut()
    const root = list()
    const row = document.createElement('div')
    const button = document.createElement('button')
    root.append(row, button)
    expect(listOwnsKeys(root, keyOn(row))).toBe(true)
    // A row's button the focus came back to (a picker closed): letters still the list's, Enter the button's.
    expect(listOwnsKeys(root, keyOn(button, 'x'))).toBe(true)
    expect(listOwnsKeys(root, keyOn(button, 'Enter'))).toBe(false)
    expect(listOwnsKeys(root, keyOn(button, 'ArrowDown'))).toBe(false)
    // …but a row's own button: Enter opens the row.
    const rowEl = document.createElement('div')
    rowEl.setAttribute('data-list-row-id', 'r1')
    const picker = document.createElement('button')
    rowEl.appendChild(picker)
    root.appendChild(rowEl)
    expect(listOwnsKeys(root, keyOn(picker, 'Enter'))).toBe(true)
    expect(listOwnsKeys(root, keyOn(picker, ' '))).toBe(false)
    const input = document.createElement('input')
    root.appendChild(input)
    expect(listOwnsKeys(root, keyOn(input, 'x'))).toBe(false)
  })

  it('takes a key on the page itself only while the list is in the page in front, or the only one', () => {
    layOut()
    const front = document.createElement('div')
    front.setAttribute('data-chat-card-fullscreen', '')
    document.body.appendChild(front)
    const inFront = list(front)
    const behind = list()
    expect(listOwnsKeys(inFront, keyOn(document.body))).toBe(true)
    expect(listOwnsKeys(behind, keyOn(document.body))).toBe(false)
    expect(listOwnsKeys(inFront, keyOn(front))).toBe(true)
    // A frame inside the page that wraps the list (the card's content, focused).
    expect(listOwnsKeys(inFront, keyOn(front))).toBe(true)
    const wrapper = document.createElement('div')
    front.appendChild(wrapper)
    const wrapped = list(wrapper)
    expect(listOwnsKeys(wrapped, keyOn(wrapper))).toBe(true)
    // …but not a sibling of it.
    const sibling = document.createElement('div')
    front.appendChild(sibling)
    expect(listOwnsKeys(wrapped, keyOn(sibling))).toBe(false)
    wrapper.remove()
    sibling.remove()
    front.remove()
    // No page in front, one list on screen: that one.
    expect(listOwnsKeys(behind, keyOn(document.body))).toBe(true)
    list()
    expect(listOwnsKeys(behind, keyOn(document.body))).toBe(false)
  })

  it('never a list that is hidden or inert', () => {
    layOut()
    const root = list()
    root.setAttribute('inert', '')
    expect(listOwnsKeys(root, keyOn(document.body))).toBe(false)
    expect(regionOwnsKeys(null, keyOn(document.body), '[data-x]')).toBe(false)
  })
})

describe('openPropertyPicker', () => {
  it('clicks the picker marked for the field, on the row', () => {
    const row = document.createElement('div')
    const cell = document.createElement('span')
    cell.setAttribute('data-property-field', 'priority')
    const trigger = document.createElement('button')
    const clicked = vi.fn()
    trigger.addEventListener('click', clicked)
    cell.appendChild(trigger)
    row.appendChild(cell)
    expect(openPropertyPicker(row, 'priority')).toBe(true)
    expect(clicked).toHaveBeenCalledTimes(1)
    // A field the row doesn't show: nothing to open.
    expect(openPropertyPicker(row, 'labels')).toBe(false)
  })

  it('clicks a trigger that is itself marked (a panel’s assignee button)', () => {
    const panel = document.createElement('div')
    const button = document.createElement('button')
    button.setAttribute('data-property-field', 'assignee')
    const clicked = vi.fn()
    button.addEventListener('click', clicked)
    panel.appendChild(button)
    expect(openPropertyPicker(panel, 'assignee')).toBe(true)
    expect(clicked).toHaveBeenCalledTimes(1)
  })
})
