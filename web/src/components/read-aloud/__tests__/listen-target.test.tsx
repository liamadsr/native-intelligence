// @vitest-environment jsdom
/**
 * The Listen target (../listen-target), the headless reader every email,
 * action and document mounts, with the real section player and the desktop
 * bridge mocked:
 *  - `<ListenTarget>` renders nothing, even while it reads;
 *  - listen mode on: it reads its item when it mounts, and when its key
 *    changes (pausing the previous one, which keeps its place and resumes when
 *    it comes back), and when listen mode turns on while it is shown;
 *  - unmounting pauses its read, and leaves another key's read alone;
 *  - listen mode off, or a window the user isn't in: nothing reads on its own;
 *  - reading follows the window in front: another window (or this Native Intelligence
 *    window coming back) holding a target reads it once it has stayed in
 *    front for the settle, pausing what read elsewhere, which resumes where it
 *    was when its window comes back; one read to its end isn't read again;
 *    flicking past a window changes nothing; listen mode off, nothing moves.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactElement } from 'react'
import type { TtsStatePayload } from '@/lib/tauri-bridge'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const bridge = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown?]>,
  ids: [] as string[],
  listeners: new Set<(p: TtsStatePayload) => void>(),
}))

vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    ttsSpeak: async (args: { id: string; text: string; voice?: string }) => {
      bridge.calls.push(['speak', args.text])
      bridge.ids.push(args.id)
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

import { LISTEN_FOLLOW_SETTLE_MS, ListenTarget } from '../listen-target'
import { __resetAppFocusForTests } from '@/lib/read-aloud/app-focus'
import {
  __resetSectionPlayerForTests,
  getSectionPlayerSnapshot,
  playSection,
  setSectionPlayerSupported,
} from '@/lib/read-aloud/section-player'
import { __resetResumePointsForTests, getResumePoint } from '@/lib/read-aloud/resume-points'
import { __resetListenModeForTests, isListenModeOn, setListenMode } from '@/lib/read-aloud/listen-mode'
import { WindowFocusProvider } from '@/components/views/unified-view-layout'

let container: HTMLDivElement
let root: Root

const flush = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
})

const EMAILS: Record<string, string[]> = {
  'email:m1': ['From Sarah, about Q3.', 'Tuesday works.', 'Best, Sarah'],
  'email:m2': ['From Sam, about the invoice.', 'Paid in full.'],
}

const target = (listenKey: string, sentences = EMAILS[listenKey] ?? ['One.', 'Two.']) =>
  h(ListenTarget, { listenKey, getSentences: () => sentences })

async function render(node: ReactElement | null) {
  await act(async () => root.render(node))
  await flush()
}

async function emit(p: TtsStatePayload) {
  await act(async () => {
    for (const cb of [...bridge.listeners]) cb(p)
  })
}

const playing = () => getSectionPlayerSnapshot().playingKey
/** What was spoken, in order (cancels and prepares left out). */
const spoken = () => bridge.calls.filter((c) => c[0] === 'speak').map((c) => c[1] as string)

beforeEach(() => {
  __resetSectionPlayerForTests()
  __resetResumePointsForTests()
  __resetListenModeForTests()
  bridge.calls = []
  bridge.ids = []
  bridge.listeners.clear()
  setSectionPlayerSupported(true)
  __resetAppFocusForTests()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  __resetAppFocusForTests()
  __resetSectionPlayerForTests()
  __resetResumePointsForTests()
  __resetListenModeForTests()
})

describe('<ListenTarget>', () => {
  it('renders nothing, even while it reads', async () => {
    setListenMode(true)
    await render(target('email:m1'))
    expect(playing()).toBe('email:m1')
    expect(container.innerHTML).toBe('')
  })

  it('listen mode on: the item opening reads itself, from the top', async () => {
    setListenMode(true)
    await render(target('email:m1'))
    expect(bridge.calls[0]).toEqual(['cancel'])
    expect(spoken()).toEqual(EMAILS['email:m1'])
  })

  it('the next key pauses the previous one, which keeps its place and resumes when it comes back', async () => {
    setListenMode(true)
    await render(target('email:m1'))
    await emit({ id: bridge.ids[1], state: 'speaking' })
    bridge.calls = []

    await render(target('email:m2'))
    expect(playing()).toBe('email:m2')
    expect(getResumePoint('email:m1')).toBe(1)
    expect(spoken()).toEqual(EMAILS['email:m2'])

    bridge.calls = []
    await render(target('email:m1'))
    expect(playing()).toBe('email:m1')
    expect(spoken()).toEqual(['Tuesday works.', 'Best, Sarah'])
  })

  it('listen mode turning on reads the item shown; turning off pauses it', async () => {
    await render(target('email:m1'))
    expect(playing()).toBeNull()
    await act(async () => setListenMode(true))
    await flush()
    expect(playing()).toBe('email:m1')

    await act(async () => setListenMode(false))
    expect(playing()).toBeNull()
    expect(getResumePoint('email:m1')).toBe(0)
  })

  it('unmounting pauses its read; it leaves another key’s read alone', async () => {
    setListenMode(true)
    await render(target('email:m1'))
    await emit({ id: bridge.ids[2], state: 'speaking' })
    await render(null)
    expect(playing()).toBeNull()
    expect(getResumePoint('email:m1')).toBe(2)

    await act(async () => setListenMode(false))
    await render(target('email:m2'))
    act(() => playSection('doc:other', ['Elsewhere.']))
    await render(null)
    expect(playing()).toBe('doc:other')
    expect(getResumePoint('email:m2')).toBeNull()
  })

  it('listen mode off: opening an item reads nothing', async () => {
    await render(target('email:m1'))
    await render(target('email:m2'))
    expect(bridge.calls).toEqual([])
    expect(playing()).toBeNull()
  })

  it('never starts on its own in a window the user is not in', async () => {
    setListenMode(true)
    await render(h(WindowFocusProvider, { isFocused: false, children: target('email:m1') }))
    await render(h(WindowFocusProvider, { isFocused: false, children: target('email:m2') }))
    expect(bridge.calls).toEqual([])
    expect(playing()).toBeNull()
  })

  it('nothing to read: nothing plays', async () => {
    setListenMode(true)
    await render(target('email:empty', []))
    expect(playing()).toBeNull()
    expect(bridge.calls).toEqual([])
  })
})

describe('<ListenTarget> — reading follows the window in front', () => {
  /** Two windows, `front` the one the user is in. */
  const windows = (front: 'a' | 'b', a = 'email:m1', b = 'email:m2') =>
    h(
      'div',
      null,
      h(WindowFocusProvider, { isFocused: front === 'a', children: target(a) }),
      h(WindowFocusProvider, { isFocused: front === 'b', children: target(b) }),
    )
  const settle = (ms = LISTEN_FOLLOW_SETTLE_MS + 30) =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms))
    })

  it('another window holding an item reads it; back again, the first resumes where it was', async () => {
    setListenMode(true)
    await render(windows('a'))
    expect(playing()).toBe('email:m1')
    await emit({ id: bridge.ids[1], state: 'speaking' }) // "Tuesday works."

    bridge.calls = []
    await render(windows('b'))
    expect(playing()).toBe('email:m1') // not before the settle
    await settle()
    expect(playing()).toBe('email:m2')
    expect(spoken()).toEqual(EMAILS['email:m2'])
    expect(getResumePoint('email:m1')).toBe(1)

    bridge.calls = []
    await render(windows('a'))
    await settle()
    expect(playing()).toBe('email:m1')
    expect(spoken()).toEqual(['Tuesday works.', 'Best, Sarah'])
    expect(getResumePoint('email:m2')).toBe(0)
  })

  it('an item read to its end is not read again when its window comes back', async () => {
    setListenMode(true)
    await render(windows('a'))
    for (const id of [...bridge.ids]) await emit({ id, state: 'done' })
    expect(playing()).toBeNull()

    await render(windows('b'))
    await settle()
    expect(playing()).toBe('email:m2')

    bridge.calls = []
    await render(windows('a'))
    await settle()
    expect(playing()).toBe('email:m2') // m1 has nothing left: m2 reads on
    expect(spoken()).toEqual([])
  })

  it('flicking past a window changes nothing; with listen mode off nothing follows', async () => {
    setListenMode(true)
    await render(windows('a'))
    bridge.calls = []
    await render(windows('b'))
    await render(windows('a'))
    await settle()
    expect(playing()).toBe('email:m1')
    expect(bridge.calls).toEqual([])

    await act(async () => setListenMode(false))
    bridge.calls = []
    await render(windows('b'))
    await settle()
    expect(playing()).toBeNull()
    expect(spoken()).toEqual([])
  })

  it('this Native Intelligence window coming back from another one resumes what that one took over', async () => {
    setListenMode(true)
    await render(windows('a'))
    const [, second, last] = bridge.ids
    await emit({ id: second, state: 'speaking' })

    // Another Native Intelligence window is in front and reads: it cancels this one's voice.
    ;(document.hasFocus as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false)
    await act(async () => {
      window.dispatchEvent(new Event('blur'))
    })
    await emit({ id: last, state: 'cancelled' })
    expect(playing()).toBeNull()
    expect(getResumePoint('email:m1')).toBe(1)

    bridge.calls = []
    ;(document.hasFocus as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await settle()
    expect(playing()).toBe('email:m1')
    expect(spoken()).toEqual(['Tuesday works.', 'Best, Sarah'])
  })
})
