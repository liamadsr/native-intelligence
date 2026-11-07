// @vitest-environment jsdom
/**
 * The `row` variant of AttachmentsCarousel — Attachments as a property row
 * inside the Properties group, mirroring Participants.
 *
 * The row replaced a standalone titled card, and the thumbnails it used to
 * show unconditionally now live behind an expand toggle. That makes two things
 * worth pinning:
 *
 *  - the toggle actually reveals the attachments (a row that can't open is a
 *    strictly worse card — the files become unreachable from the panel);
 *  - the add button still fires onAddClick, since it is the only path to the
 *    hidden file input that both detail panels keep mounted for it.
 *
 * The default `card` variant is covered too: both detail panels pass
 * variant="row", but the prop defaults to `card`, and a regression there would
 * silently change any future caller that omits it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The carousel's Supabase client is only reached for image signed-URLs; these
// fixtures are documents, so the stub just has to exist.
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null }) }) },
  }),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { AttachmentsCarousel } from '../attachments-carousel'

const ATTACHMENTS = [
  { id: 'a1', file_name: 'notes.pdf', file_category: 'document', storage_path: 'p/notes.pdf' },
  { id: 'a2', file_name: 'deck.pdf', file_category: 'document', storage_path: 'p/deck.pdf' },
]

let container: HTMLDivElement
let root: Root

/** Mount and let the attachments fetch resolve. */
async function mount(ui: React.ReactElement) {
  await act(async () => {
    root.render(ui)
  })
  // Flush the fetch .then chain inside the effect.
  await act(async () => {
    await Promise.resolve()
  })
}

function click(el: Element) {
  return act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** The row's expand toggle is the first button; the add button the second. */
function buttons() {
  return Array.from(container.querySelectorAll('button'))
}

beforeEach(() => {
  // embla (the carousel under the thumbnails) reaches for three browser APIs
  // jsdom does not implement. They only affect layout/visibility maths, which
  // these assertions do not depend on — inert stubs are enough to let it mount.
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
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ attachments: ATTACHMENTS }),
  })) as unknown as typeof fetch)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('AttachmentsCarousel — row variant', () => {
  it('summarises the count and hides thumbnails until expanded', async () => {
    await mount(<AttachmentsCarousel variant="row" captureId="c1" />)

    expect(container.textContent).toContain('2 attachments')
    // Collapsed: the file names are not in the DOM.
    expect(container.textContent).not.toContain('notes.pdf')
  })

  it('reveals the attachments when the row is expanded', async () => {
    await mount(<AttachmentsCarousel variant="row" captureId="c1" />)
    await click(buttons()[0])

    expect(container.textContent).toContain('notes.pdf')
    expect(container.textContent).toContain('deck.pdf')
  })

  it('collapses again on a second click', async () => {
    await mount(<AttachmentsCarousel variant="row" captureId="c1" />)
    await click(buttons()[0])
    await click(buttons()[0])

    expect(container.textContent).not.toContain('notes.pdf')
  })

  it('singularises the count for one attachment', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ attachments: [ATTACHMENTS[0]] }),
    })) as unknown as typeof fetch)
    await mount(<AttachmentsCarousel variant="row" captureId="c1" />)

    expect(container.textContent).toContain('1 attachment')
    expect(container.textContent).not.toContain('1 attachments')
  })

  it('says so when there is nothing attached, and cannot be expanded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ attachments: [] }),
    })) as unknown as typeof fetch)
    await mount(<AttachmentsCarousel variant="row" captureId="c1" />)

    expect(container.textContent).toContain('No attachments')
    expect((buttons()[0] as HTMLButtonElement).disabled).toBe(true)
  })

  it('fires onAddClick — the only route to the panels’ hidden file input', async () => {
    const onAddClick = vi.fn()
    await mount(<AttachmentsCarousel variant="row" captureId="c1" onAddClick={onAddClick} />)
    // Second button is Add; the first is the expand toggle.
    await click(buttons()[1])

    expect(onAddClick).toHaveBeenCalledOnce()
  })

  it('disables Add while an upload is in flight', async () => {
    await mount(
      <AttachmentsCarousel variant="row" captureId="c1" onAddClick={vi.fn()} uploading />,
    )

    expect((buttons()[1] as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('AttachmentsCarousel — card variant (unchanged default)', () => {
  it('still renders the titled card with thumbnails, no expansion needed', async () => {
    await mount(<AttachmentsCarousel captureId="c1" />)

    expect(container.textContent).toContain('Attachments')
    expect(container.textContent).toContain('notes.pdf')
  })
})
