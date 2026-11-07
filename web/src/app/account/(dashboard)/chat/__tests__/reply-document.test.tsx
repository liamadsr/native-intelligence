// @vitest-environment jsdom
/**
 * A long reply's folded part: a block with its title and a preview that takes
 * no clicks, which opens the whole text in a reader over the window; Esc, the
 * button in its corner or a click on the backdrop puts it away.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { ReplyDocument } from '../reply-document'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const reader = () => document.querySelector('[data-reply-reader]') as HTMLElement | null

describe('ReplyDocument', () => {
  it('folds the text under its title, and opens it in a reader over the window', () => {
    act(() => root.render(h(ReplyDocument, { title: 'The Keeper', body: 'The barges stopped needing Agnes in 1954.' })))
    const block = container.querySelector('[data-reply-document]') as HTMLElement
    expect(block.getAttribute('aria-label')).toBe('Open “The Keeper”')
    expect(block.textContent).toContain('The Keeper')
    const preview = block.querySelector('[aria-hidden]') as HTMLElement
    expect(preview.className).toContain('pointer-events-none')
    expect(reader()).toBeNull()

    act(() => block.click())
    expect(reader()?.parentElement).toBe(document.body)
    expect(reader()?.getAttribute('role')).toBe('dialog')
    expect(reader()?.querySelector('h1')?.textContent).toBe('The Keeper')
    expect(reader()?.textContent).toContain('The barges stopped needing Agnes in 1954.')

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(reader()).toBeNull()
  })

  it('is a button in role only, so the preview’s own buttons (entity chips) are valid inside it, and opens on Enter', () => {
    act(() => root.render(h(ReplyDocument, { title: 'Customers', body: 'Three customers.' })))
    const block = container.querySelector('[data-reply-document]') as HTMLElement
    expect(block.tagName).toBe('DIV')
    expect(block.getAttribute('role')).toBe('button')
    expect(block.tabIndex).toBe(0)
    act(() => block.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(reader()).not.toBeNull()
  })

  it('puts the reader away from its corner button or a click on the backdrop', () => {
    act(() => root.render(h(ReplyDocument, { title: null, body: 'A long summary.' })))
    const block = container.querySelector('[data-reply-document]') as HTMLElement
    expect(block.getAttribute('aria-label')).toBe('Open the full reply')

    act(() => block.click())
    act(() => (reader()!.querySelector('[aria-label="Back into the chat"]') as HTMLElement).click())
    expect(reader()).toBeNull()

    act(() => block.click())
    act(() => reader()!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })))
    expect(reader()).toBeNull()
  })

  it('closes on a press anywhere off its page and buttons, the same rule as a full-screen card', () => {
    const press = (el: Element, init: PointerEventInit = {}) =>
      act(() => {
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, ...init }))
      })
    act(() => root.render(h(ReplyDocument, { title: 'The Keeper', body: 'The barges stopped needing Agnes in 1954.' })))
    const block = container.querySelector('[data-reply-document]') as HTMLElement
    act(() => block.click())
    const r = reader()!

    // On the page, its title, its round button, a right press: it stays.
    // (More opens its menu on the press: Radix's trigger.)
    const page = r.querySelector('article')!
    press(page)
    press(page.querySelector('h1')!)
    press(r.querySelector('[aria-label="Back into the chat"]')!)
    press(r, { button: 2 })
    expect(reader()).toBe(r)

    // A menu open: only it closes.
    const menu = document.createElement('div')
    menu.setAttribute('data-radix-popper-content-wrapper', '')
    menu.innerHTML = '<div role="menu" data-state="open"></div>'
    document.body.append(menu)
    press(r)
    expect(reader()).toBe(r)
    menu.remove()

    // The space round the page: the backdrop, and the title strip over it.
    for (const spot of [() => reader()!, () => reader()!.querySelector('.pointer-events-none')!]) {
      if (!reader()) act(() => block.click())
      const el = spot()
      expect(el.closest('article')).toBeNull()
      press(el)
      expect(reader()).toBeNull()
    }
  })
})
