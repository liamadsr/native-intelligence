// @vitest-environment jsdom
/**
 * Links in text the app shows: plain text (../linkify.tsx) makes its URLs
 * <a href target=_blank> (a new tab on the web; the link router takes it to the
 * in-app browser on desktop), and a click on one doesn't also click the row it
 * sits in; rendered markdown (../markdown.tsx) opens a link to another site in
 * a new tab instead of navigating the app away, and leaves the app's own links
 * and mailto: alone; a plain-text chat message (../message.tsx) gets its links.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    ttsSpeak: async () => {},
    ttsCancel: async () => {},
    ttsPrepare: async () => {},
    onTtsState: () => () => {},
  },
}))
vi.mock('shiki', () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }))

import { Linkify } from '../linkify'
import { Markdown } from '../markdown'
import { MessageContent } from '../message'

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

function render(node: React.ReactNode) {
  act(() => root.render(node))
}

const anchors = () =>
  Array.from(container.querySelectorAll('a')).map((a) => ({
    href: a.getAttribute('href'),
    text: a.textContent,
    target: a.getAttribute('target'),
    rel: a.getAttribute('rel'),
  }))

describe('Linkify', () => {
  it('makes each URL a link that opens in a new tab, keeping the text around it', () => {
    render(h('p', null, h(Linkify, { text: 'Register: https://partiful.com/e/abc. Then https://x.com' })))
    expect(container.textContent).toBe('Register: https://partiful.com/e/abc. Then https://x.com')
    expect(anchors()).toEqual([
      { href: 'https://partiful.com/e/abc', text: 'https://partiful.com/e/abc', target: '_blank', rel: 'noopener noreferrer' },
      { href: 'https://x.com', text: 'https://x.com', target: '_blank', rel: 'noopener noreferrer' },
    ])
  })

  it('renders text without links, and empty text, as-is', () => {
    render(h('p', null, h(Linkify, { text: 'no links' }), h(Linkify, { text: null })))
    expect(container.textContent).toBe('no links')
    expect(anchors()).toEqual([])
  })

  it("a click on a link doesn't click the row it sits in", () => {
    const rowClick = vi.fn()
    render(h('div', { onClick: rowClick }, h(Linkify, { text: 'see https://x.com' }), ' row'))
    const a = container.querySelector('a')!
    // Keep jsdom from trying to navigate.
    a.addEventListener('click', (e) => e.preventDefault())
    act(() => {
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(rowClick).not.toHaveBeenCalled()
    act(() => {
      ;(container.firstElementChild as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(rowClick).toHaveBeenCalledTimes(1)
  })
})

describe('Markdown links', () => {
  it('opens a link to another site in a new tab: a bare URL and a [text](url)', () => {
    render(h(Markdown, { readAloudSections: false, children: 'Go to https://partiful.com/e/abc or [the site](https://x.com/a).' }))
    expect(anchors()).toEqual([
      { href: 'https://partiful.com/e/abc', text: 'https://partiful.com/e/abc', target: '_blank', rel: 'noopener noreferrer' },
      { href: 'https://x.com/a', text: 'the site', target: '_blank', rel: 'noopener noreferrer' },
    ])
  })

  it("leaves the app's own links and mailto: as they are", () => {
    const own = `${window.location.origin}/account/actions`
    render(
      h(Markdown, {
        readAloudSections: false,
        children: `[Actions](/account/actions), [here](${own}) and [mail](mailto:a@b.co)`,
      }),
    )
    expect(anchors().map((a) => [a.href, a.target])).toEqual([
      ['/account/actions', null],
      [own, null],
      ['mailto:a@b.co', null],
    ])
  })
})

describe('MessageContent', () => {
  it("a plain-text message (the person's own) gets its links", () => {
    render(h(MessageContent, null, 'my invite: https://partiful.com/e/abc'))
    expect(anchors().map((a) => a.href)).toEqual(['https://partiful.com/e/abc'])
  })
})
