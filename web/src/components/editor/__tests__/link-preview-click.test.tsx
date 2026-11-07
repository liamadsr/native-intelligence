// @vitest-environment jsdom
/**
 * A link preview card in the editor (../link-preview-extension.tsx) opens its
 * link when clicked: in the in-app browser where it's on (⌘ behind), ⇧ in the
 * user's browser (the link router's rules). Its Copy and Remove buttons don't
 * open anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { ReactNodeViewProps } from '@tiptap/react'

vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn() }))

import { LinkPreviewComponent } from '../link-preview-extension'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const URL = 'https://partiful.com/e/abc'

let container: HTMLDivElement
let root: Root
let windowOpen: MockInstance<typeof window.open>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ title: 'Brunch', description: null, image: null, favicon: null, domain: 'partiful.com', url: URL }),
    })),
  )
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  windowOpen.mockRestore()
  vi.unstubAllGlobals()
})

async function renderCard() {
  const props = {
    node: { attrs: { url: URL }, nodeSize: 1 },
    editor: {},
    getPos: () => 0,
  } as unknown as ReactNodeViewProps
  await act(async () => {
    root.render(h(LinkPreviewComponent, props))
  })
  return container.querySelector('[data-link-preview-open]') as HTMLElement
}

function click(el: Element, init: MouseEventInit = {}) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }))
  })
}

describe('link preview card', () => {
  const opened = () => vi.waitFor(() => expect(windowOpen).toHaveBeenCalledWith(URL, '_blank', 'noopener,noreferrer'))

  it('opens its link in the user’s browser', async () => {
    const card = await renderCard()
    expect(card.getAttribute('title')).toBe(URL)
    click(card.querySelector('p')!)
    await opened()
  })

  it('opens it the same way with ⌘ or ⇧', async () => {
    const card = await renderCard()
    click(card, { metaKey: true })
    await opened()
    windowOpen.mockClear()
    click(card, { shiftKey: true })
    await opened()
  })

  it('Copy does not open the link', async () => {
    const card = await renderCard()
    click(card.querySelector('button[title="Copy URL"]')!)
    expect(windowOpen).not.toHaveBeenCalled()
  })
})
