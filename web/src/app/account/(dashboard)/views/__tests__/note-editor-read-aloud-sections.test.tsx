// @vitest-environment jsdom
/**
 * The REAL NoteEditor (Novel/TipTap in jsdom) with its read-aloud sections:
 * hovering a heading shows the Play widget, playing highlights the section
 * (with a Pause widget), unmounting pauses it, and none of it ever reaches
 * NoteEditor's save path (`onUpdate`), because the
 * extension only dispatches meta transactions (see
 * components/editor/read-aloud-sections-extension.ts). `readAloudSections={false}`
 * leaves the extension out.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { TtsStatePayload } from '@/lib/tauri-bridge'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const bridge = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown?]>,
  listeners: new Set<(p: TtsStatePayload) => void>(),
}))

vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    ttsSpeak: async (args: unknown) => {
      bridge.calls.push(['speak', args])
    },
    ttsCancel: async () => {
      bridge.calls.push(['cancel'])
    },
    ttsPrepare: async () => {
      bridge.calls.push(['prepare'])
    },
    onTtsState: (cb: (p: TtsStatePayload) => void) => {
      bridge.listeners.add(cb)
      return () => bridge.listeners.delete(cb)
    },
  },
}))
vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn() }))

import { NoteEditor } from '../note-editor'
import {
  __resetSectionPlayerForTests,
  getSectionPlayerSnapshot,
  setSectionPlayerSupported,
} from '@/lib/read-aloud/section-player'

const LONG = 'The team agreed to ship the beta on Friday, after the last round of fixes lands and support has read the release notes twice.'
const MARKDOWN = `Intro line.\n\n## Plan\n\n${LONG}\n\n- Book the room\n\n## Tiny\n\nToo short to play.\n`

let container: HTMLDivElement
let root: Root
const onUpdate = vi.fn()

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mount(props: { readAloudSections?: boolean; readOnly?: boolean } = {}) {
  await act(async () => root.render(h(NoteEditor, { initialContent: MARKDOWN, onUpdate, ...props })))
  await settle()
  const dom = container.querySelector('.ProseMirror')
  if (!dom) throw new Error('the editor did not mount')
  return dom as HTMLElement
}

const block = (dom: HTMLElement, text: string) =>
  [...dom.children].find((el) => el.textContent?.replace(/\s+$/, '') === text) as HTMLElement
const widgets = (dom: HTMLElement) => [...dom.querySelectorAll('[data-read-aloud-section]')] as HTMLButtonElement[]

beforeEach(() => {
  __resetSectionPlayerForTests()
  setSectionPlayerSupported(true)
  bridge.calls = []
  bridge.listeners.clear()
  onUpdate.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  await settle()
  container.remove()
  __resetSectionPlayerForTests()
})

describe('NoteEditor — read-aloud sections', () => {
  it('hover → Play; play → Pause and highlight; the document is never saved for it', async () => {
    const dom = await mount()
    act(() => {
      block(dom, 'Plan').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    expect(widgets(dom)).toHaveLength(1)
    expect(block(dom, 'Plan').contains(widgets(dom)[0])).toBe(true)

    await act(async () => widgets(dom)[0].click())
    await settle()
    const spoken = bridge.calls.filter((c) => c[0] === 'speak').map((c) => (c[1] as { text: string }).text)
    expect(spoken).toEqual(['Plan.', LONG, 'Book the room.'])
    expect(getSectionPlayerSnapshot().playingKey).toMatch(/^pm:/)
    expect(widgets(dom)[0].getAttribute('aria-label')).toBe('Pause reading')
    expect(dom.querySelectorAll('.read-aloud-reading')).toHaveLength(3)

    act(() => {
      dom.dispatchEvent(new MouseEvent('mouseleave'))
    })
    await settle()
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('a read-only editor has them too', async () => {
    const dom = await mount({ readOnly: true })
    act(() => {
      block(dom, 'Plan').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    expect(widgets(dom)).toHaveLength(1)
  })

  it('unmounting while playing pauses the section', async () => {
    const dom = await mount()
    act(() => {
      block(dom, 'Plan').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    await act(async () => widgets(dom)[0].click())
    await settle()
    bridge.calls = []
    await act(async () => root.unmount())
    await settle()
    expect(getSectionPlayerSnapshot().playingKey).toBeNull()
    expect(bridge.calls).toEqual([['cancel']])
    root = createRoot(container) // for afterEach
  })

  it('readAloudSections={false} leaves them out', async () => {
    const dom = await mount({ readAloudSections: false })
    act(() => {
      block(dom, 'Plan').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    expect(widgets(dom)).toEqual([])
  })
})
