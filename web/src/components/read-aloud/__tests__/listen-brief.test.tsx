// @vitest-environment jsdom
/**
 * The Listen brief (../listen-brief + @/lib/read-aloud/listen-briefs), with
 * the real section player, fetch and the desktop bridge mocked:
 *  - in listen mode, an item opening lights up at once, asks the route for
 *    its brief (kind, id, the user's time zone, any `input`) and speaks its
 *    sentences, keyed `brief:<kind>:<id>`;
 *  - no brief (a 404, the network, an empty or unreadable answer): the item's
 *    fallback line instead, and nothing at all without one;
 *  - closing the item aborts the request, stops the voice and forgets any
 *    place (also one the toggle's pause kept): reopened, it starts over;
 *  - skimming: an item passed by within the settle time is never asked for;
 *  - plainLine / namesLine, the fallback's words.
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
    ttsSpeak: async (args: { id: string; text: string }) => {
      bridge.calls.push(['speak', args.text])
      bridge.ids.push(args.id)
    },
    ttsCancel: async () => {
      bridge.calls.push(['cancel'])
    },
    ttsPrepare: async () => {},
    onTtsState: (cb: (p: TtsStatePayload) => void) => {
      bridge.listeners.add(cb)
      return () => bridge.listeners.delete(cb)
    },
  },
}))

import { ListenBrief } from '../listen-brief'
import {
  BRIEF_SETTLE_MS,
  LISTEN_BRIEF_ENDPOINT,
  __clearHeardBriefsForTests,
  __setBriefSettleForTests,
  namesLine,
  plainLine,
} from '@/lib/read-aloud/listen-briefs'
import {
  __resetSectionPlayerForTests,
  getSectionPlayerSnapshot,
  setSectionPlayerSupported,
} from '@/lib/read-aloud/section-player'
import { __resetResumePointsForTests, getResumePoint } from '@/lib/read-aloud/resume-points'
import { __resetListenModeForTests, setListenMode } from '@/lib/read-aloud/listen-mode'

let container: HTMLDivElement
let root: Root

const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  })

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
const spoken = () => bridge.calls.filter((c) => c[0] === 'speak').map((c) => c[1] as string)

/** The route's answer. */
const brief200 = (sentences: string[]) =>
  new Response(JSON.stringify({ sentences }), { status: 200, headers: { 'content-type': 'application/json' } })

/** An answer the test hands over when it chooses. */
function pending() {
  let resolve!: (r: Response) => void
  const promise = new Promise<Response>((r) => (resolve = r))
  return { promise, answer: async (r: Response) => {
    resolve(r)
    await flush()
  } }
}

let fetchMock: ReturnType<typeof vi.fn>

const brief = (id = 'cap-1', fallback?: () => string[], input?: unknown) =>
  h(ListenBrief, { kind: 'capture', id, fallback, input })

beforeEach(() => {
  __resetSectionPlayerForTests()
  __resetResumePointsForTests()
  __resetListenModeForTests()
  bridge.calls = []
  bridge.ids = []
  bridge.listeners.clear()
  setSectionPlayerSupported(true)
  __setBriefSettleForTests(0)
  __clearHeardBriefsForTests()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  __setBriefSettleForTests(BRIEF_SETTLE_MS)
  __resetSectionPlayerForTests()
  __resetResumePointsForTests()
  __resetListenModeForTests()
})

describe('<ListenBrief>', () => {
  it('lights up at once, asks for the brief, and speaks its sentences', async () => {
    const res = pending()
    fetchMock.mockReturnValue(res.promise)
    setListenMode(true)
    await render(brief('cap-1', undefined, { title: 'Sync' }))

    expect(playing()).toBe('brief:capture:cap-1') // before a word arrived
    expect(container.innerHTML).toBe('')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(LISTEN_BRIEF_ENDPOINT)
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({ kind: 'capture', id: 'cap-1', input: { title: 'Sync' } })
    expect(typeof body.timeZone).toBe('string')

    await res.answer(brief200(['Pricing sync, on Tuesday, with Jessa Lin.', 'We agreed to hold the price.']))
    expect(spoken()).toEqual(['Pricing sync, on Tuesday, with Jessa Lin.', 'We agreed to hold the price.'])
    for (const id of bridge.ids) await emit({ id, state: 'done' })
    expect(playing()).toBeNull()
  })

  it('no brief (404, offline, an empty or unreadable answer): the fallback line, or nothing without one', async () => {
    setListenMode(true)
    fetchMock.mockResolvedValueOnce(new Response('{"error":"Not found"}', { status: 404 }))
    await render(brief('cap-1', () => ['Pricing sync, with Jessa Lin.']))
    expect(spoken()).toEqual(['Pricing sync, with Jessa Lin.'])

    bridge.calls = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await render(brief('cap-2', () => ['Standup.']))
    expect(spoken()).toEqual(['Standup.'])

    bridge.calls = []
    fetchMock.mockResolvedValueOnce(brief200(['  ']))
    await render(brief('cap-3', () => ['Offsite.']))
    expect(spoken()).toEqual(['Offsite.'])

    bridge.calls = []
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }))
    await render(brief('cap-4', () => ['Retro.']))
    expect(spoken()).toEqual(['Retro.'])

    bridge.calls = []
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }))
    await render(brief('cap-5'))
    expect(spoken()).toEqual([])
    expect(playing()).toBeNull()
    warn.mockRestore()
  })

  it('closing the item aborts the request and says nothing after; reopened, it starts over', async () => {
    const res = pending()
    fetchMock.mockReturnValueOnce(res.promise)
    setListenMode(true)
    await render(brief('cap-1', () => ['Fallback.']))
    const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal as AbortSignal

    await render(null)
    expect(signal.aborted).toBe(true)
    expect(playing()).toBeNull()
    await res.answer(brief200(['Too late.']))
    expect(spoken()).toEqual([])

    fetchMock.mockResolvedValueOnce(brief200(['One.', 'Two.']))
    await render(brief('cap-1'))
    await emit({ id: bridge.ids[1], state: 'speaking' })
    await render(null)
    expect(getResumePoint('brief:capture:cap-1')).toBeNull()

    fetchMock.mockResolvedValueOnce(brief200(['One.', 'Two.']))
    bridge.calls = []
    await render(brief('cap-1'))
    expect(spoken()).toEqual(['One.', 'Two.'])
  })

  it('paused part-way and played again, it resumes from the very sentences it said, with no new request', async () => {
    fetchMock.mockResolvedValueOnce(brief200(['One.', 'Two.', 'Three.']))
    setListenMode(true)
    await render(brief('cap-1'))
    await emit({ id: bridge.ids[1], state: 'speaking' })
    await act(async () => setListenMode(false)) // paused at "Two."
    bridge.calls = []
    fetchMock.mockClear()
    await act(async () => setListenMode(true))
    await flush()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(spoken()).toEqual(['Two.', 'Three.'])
  })

  it('a place kept by the toggle’s pause is forgotten when the item closes', async () => {
    fetchMock.mockResolvedValueOnce(brief200(['One.', 'Two.']))
    setListenMode(true)
    await render(brief('cap-1'))
    await emit({ id: bridge.ids[1], state: 'speaking' })
    await act(async () => setListenMode(false))
    expect(getResumePoint('brief:capture:cap-1')).toBe(1)

    await render(null)
    expect(getResumePoint('brief:capture:cap-1')).toBeNull()
  })
})

describe('<ListenBrief> — skimming', () => {
  it('items passed by quickly are never asked for; the one it stops on is', async () => {
    __setBriefSettleForTests(40)
    fetchMock.mockImplementation(async () => brief200(['Jessa runs ops at Acme.']))
    setListenMode(true)
    await render(brief('cap-1'))
    await render(brief('cap-2'))
    await render(brief('cap-3'))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(playing()).toBe('brief:capture:cap-3') // lit while it waits

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60))
    })
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).id).toBe('cap-3')
    expect(spoken()).toEqual(['Jessa runs ops at Acme.'])
  })
})

describe('plainLine / namesLine', () => {
  it('an item’s plain line', () => {
    expect(plainLine('Pricing sync', 'with Jessa Lin', null, false, '  ')).toEqual(['Pricing sync, with Jessa Lin.'])
    expect(plainLine('  ', 'with Jessa')).toEqual([])
    expect(plainLine(null)).toEqual([])
  })

  it('names, the way they are said', () => {
    expect(namesLine([])).toBeNull()
    expect(namesLine(['Jessa Lin', null, ' '])).toBe('Jessa Lin')
    expect(namesLine(['Jessa', 'Jordan'])).toBe('Jessa and Jordan')
    expect(namesLine(['Jessa', 'Jordan', 'Sam'])).toBe('Jessa, Jordan and Sam')
    expect(namesLine(['Jessa', 'Jordan', 'Sam', 'Ada', 'Lee'])).toBe('Jessa, Jordan and 3 others')
  })
})
