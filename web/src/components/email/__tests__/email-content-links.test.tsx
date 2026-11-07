// @vitest-environment jsdom
/**
 * Links in an email body. The body renders in a shadow root whose own click
 * handler takes every link (nothing outside sees the click), so it must route
 * web links itself: to the in-app browser where it's on, ⌘ behind, ⇧ always
 * the user's browser — on desktop window.open is dropped, which left these
 * links dead.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { EmailContent } from '../email-content'

const openUrlMock = vi.fn(async (_url: string) => {})
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: (url: string) => openUrlMock(url) }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let windowOpen: MockInstance<typeof window.open>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null)
  openUrlMock.mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  windowOpen.mockRestore()
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__
})

function renderEmail(html: string) {
  act(() => root.render(h(EmailContent, { html })))
  const shadow = (container.firstElementChild as HTMLElement).shadowRoot!
  return (selector: string) => shadow.querySelector(selector) as HTMLElement
}

function click(el: HTMLElement, init: MouseEventInit = {}) {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, ...init })
  el.dispatchEvent(e)
  return e
}

describe('EmailContent links', () => {
  it('a web link opens in the user’s browser (the web: a new tab), the click taken whole', () => {
    const q = renderEmail('<p>See <a href="https://example.com/offer">the offer</a></p>')
    const e = click(q('a'))
    expect(e.defaultPrevented).toBe(true)
    expect(windowOpen).toHaveBeenCalledWith('https://example.com/offer', '_blank', 'noopener,noreferrer')
  })

  it('on the desktop, through the OS opener, with or without a modifier; a click on text inside the link counts', async () => {
    ;(window as unknown as { __TAURI__?: unknown }).__TAURI__ = {}
    const q = renderEmail('<a href="https://example.com/a"><b>bold</b></a>')
    click(q('b'), { metaKey: true })
    await vi.waitFor(() => expect(openUrlMock).toHaveBeenCalledWith('https://example.com/a'))
    openUrlMock.mockClear()
    click(q('b'), { shiftKey: true })
    await vi.waitFor(() => expect(openUrlMock).toHaveBeenCalledWith('https://example.com/a'))
  })
})
