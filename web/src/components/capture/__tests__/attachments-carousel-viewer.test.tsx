// @vitest-environment jsdom
/**
 * The image viewer of the Attachments row, opened from a card's properties
 * popover. The popover keeps its content mounted while closed (window-
 * properties.tsx, an Activity), so the viewer's open state used to outlive
 * it: a press on the viewer's close button counted as a press outside the
 * popover, the popover closed and hid the viewer before the click landed,
 * and every later hover over the popover brought the viewer back, with no
 * way to close it (Liam, 10-27). Now:
 *
 *  - the viewer is a dialog, which the popover counts as its own surface;
 *  - hiding the row (the popover closing) closes the viewer;
 *  - Escape closes the viewer alone: it never reaches the popover's handler.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, Activity } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    storage: { from: () => ({ createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://x/${path}` } }) }) },
  }),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { AttachmentsCarousel } from '../attachments-carousel'

const SHOTS = [
  { id: 's1', file_name: 'shot-1.png', file_category: 'image', storage_path: 'p/s1.png' },
  { id: 's2', file_name: 'shot-2.png', file_category: 'image', storage_path: 'p/s2.png' },
]

let container: HTMLDivElement
let root: Root

function Host({ open }: { open: boolean }) {
  return (
    <Activity mode={open ? 'visible' : 'hidden'}>
      <AttachmentsCarousel variant="row" captureId="c1" />
    </Activity>
  )
}

async function render(open: boolean) {
  await act(async () => {
    root.render(<Host open={open} />)
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

const viewer = () => document.querySelector('[role="dialog"][aria-label="Attachment viewer"]')

async function openViewer() {
  await render(true)
  // Expand the row, then press the first thumbnail.
  await act(async () => {
    container.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  const thumb = container.querySelector('img[alt="shot-1.png"]')!.closest('button')!
  await act(async () => {
    thumb.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(() => {
  class NoopObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  }
  vi.stubGlobal('IntersectionObserver', NoopObserver)
  vi.stubGlobal('ResizeObserver', NoopObserver)
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }))
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ attachments: SHOTS }) })) as unknown as typeof fetch)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('AttachmentsCarousel image viewer', () => {
  it('opens as a dialog, which the properties popover counts as its own', async () => {
    await openViewer()
    expect(viewer()).not.toBeNull()
    expect(viewer()!.getAttribute('aria-modal')).toBe('true')
  })

  it('closes when the popover hides the row, and stays closed when it shows again', async () => {
    // The viewer's "1 / 2" counter: on screen while it's open, whatever it's marked up as.
    const counterShown = () => document.body.textContent!.includes('1 / 2')
    await openViewer()
    expect(counterShown()).toBe(true)
    await render(false)
    await render(true)
    expect(counterShown()).toBe(false)
  })

  it('Escape closes the viewer alone, never the popover under it', async () => {
    await openViewer()
    const popoverEscape = vi.fn()
    document.addEventListener('keydown', popoverEscape, true)
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    document.removeEventListener('keydown', popoverEscape, true)
    expect(viewer()).toBeNull()
    expect(popoverEscape).not.toHaveBeenCalled()
  })

  it('leaves other keys alone', async () => {
    await openViewer()
    const other = vi.fn()
    document.addEventListener('keydown', other, true)
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    })
    document.removeEventListener('keydown', other, true)
    expect(other).toHaveBeenCalled()
    expect(viewer()).not.toBeNull()
  })
})
