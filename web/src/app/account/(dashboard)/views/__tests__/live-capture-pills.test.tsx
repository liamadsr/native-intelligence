// @vitest-environment jsdom
/**
 * The capture page's Transcripts and Tools pills — the old Live Agent card's
 * "More" tabs, brought up to the composer's top row as pills of their own.
 *
 * Each is a LEAF over the recording stores: Transcripts counts the final lines
 * and its card shows the transcript (headed by the system-audio notice while
 * recording, and flagged on the pill when the other side is lost); Tools
 * counts the live agent's calls and its card lists them.
 *
 * LiveCapturePills is the pair as the composer holds them: Transcripts (not
 * while a live desktop call shows it in the HUD, unless it flags lost audio),
 * Tools only while the capture is recording — the agent's calls exist only
 * then, so after it Tools would open onto nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, forwardRef, Profiler, type ReactNode } from 'react'
import type { TranscriptSegment } from '@/lib/deepgram-stream'
import type { AgentActivityEvent } from '@/hooks/use-recording'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// The live transcript as a tiny external store, like the real ref-backed one:
// the leaf hooks below subscribe with useSyncExternalStore, so a publish
// re-renders exactly the components whose snapshot changed.
const store = vi.hoisted(() => ({
  segments: [] as TranscriptSegment[],
  finalCount: 0,
  activity: [] as AgentActivityEvent[],
  listeners: new Set<() => void>(),
}))

/** A transcript flush, as useRecording publishes it: the new segment array,
 *  the final count derived from it, then every subscriber notified. */
function publish(segments: TranscriptSegment[]) {
  store.segments = segments
  store.finalCount = segments.filter((s) => s.isFinal).length
  store.listeners.forEach((cb) => cb())
}

vi.mock('@/hooks/recording-context', async () => {
  const { useSyncExternalStore } = await import('react')
  const subscribe = (cb: () => void) => {
    store.listeners.add(cb)
    return () => {
      store.listeners.delete(cb)
    }
  }
  return {
    useTranscriptSegments: () => useSyncExternalStore(subscribe, () => store.segments),
    useFinalSegmentCount: () => useSyncExternalStore(subscribe, () => store.finalCount),
    // Primitive snapshots, as the real derived leaves return.
    useHasLiveTranscriptSegments: () => useSyncExternalStore(subscribe, () => store.segments.length > 0),
    useLiveActiveSpeaker: () => null,
    useDetectedSpeakers: () => [],
    useAgentActivity: () => store.activity,
  }
})
vi.mock('@/hooks/use-recording', () => ({
  getSpeakerDisplayName: (speaker: string) => speaker,
}))
vi.mock('@/components/desktop/speaker-contact-search', () => ({
  SpeakerContactSearch: ({ children }: { children?: ReactNode }) => children,
}))
vi.mock('liquid-gooey', () => {
  const Liquid = Object.assign(
    forwardRef<HTMLDivElement, Record<string, unknown>>(function Liquid(props, ref) {
      const { blur: _b, contrast: _c, fill: _f, shadow: _s, filterPadding: _p, children, ...rest } = props
      return h('div', { ...rest, ref }, children as ReactNode)
    }),
    {
      Item: ({ className, children }: { className?: string; children?: ReactNode }) =>
        h('div', { className }, children),
    },
  )
  return { Liquid }
})

import { LiveCapturePills, LiveToolsPill, LiveTranscriptsPill } from '../live-capture-pills'

let container: HTMLDivElement
let root: Root

function seg(id: string, text: string, speaker = 'local_1'): TranscriptSegment {
  return { id, text, stream: 'mic', speaker, startTime: 0, endTime: 0, isFinal: true, words: [] }
}

const pillButton = (name: string) =>
  container.querySelector<HTMLElement>(`[data-composer-pill="${name}"]`)!.querySelector('button')!
const cardOf = (name: string) =>
  container.querySelector<HTMLElement>(`[data-composer-pill="${name}"] [role="dialog"]`)!

beforeEach(() => {
  store.segments = []
  store.finalCount = 0
  store.activity = []
  store.listeners.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function renderTranscripts(props: { alert?: boolean; notice?: ReactNode; isActiveRecording?: boolean; persistedTranscript?: string | null } = {}) {
  act(() => {
    root.render(
      h(LiveTranscriptsPill, {
        isActiveRecording: props.isActiveRecording ?? true,
        resumedPriorTranscript: null,
        persistedTranscript: props.persistedTranscript ?? null,
        speakerNames: {},
        notice: props.notice,
        alert: props.alert,
      }),
    )
  })
}

describe('LiveTranscriptsPill', () => {
  it('counts the final lines, and its card shows the transcript under the notice', () => {
    store.segments = [seg('a', 'we ship Friday'), seg('b', 'Sam owns it', 'remote_1')]
    store.finalCount = 2
    renderTranscripts({ notice: h('div', { 'data-notice': '' }, 'Recording your mic only') })
    expect(pillButton('transcripts').getAttribute('aria-label')).toBe('Transcripts (2)')
    // Shut, the transcript isn't mounted — but the notice is, so its state (a
    // grant's follow-up) outlives the card closing.
    expect(cardOf('transcripts').textContent).not.toContain('we ship Friday')
    expect(cardOf('transcripts').querySelector('[data-notice]')).not.toBeNull()

    act(() => pillButton('transcripts').click())
    const card = cardOf('transcripts')
    expect(card.querySelector('[data-notice]')).not.toBeNull()
    expect(card.textContent).toContain('we ship Friday')
    expect(card.textContent).toContain('Sam owns it')
    expect(card.textContent).toContain('Copy')
  })

  it('shows the saved transcript once the capture is no longer recording', () => {
    renderTranscripts({ isActiveRecording: false, persistedTranscript: '[Alice] saved line' })
    expect(pillButton('transcripts').getAttribute('aria-label')).toBe('Transcripts (1)')
    act(() => pillButton('transcripts').click())
    expect(cardOf('transcripts').textContent).toContain('saved line')
  })

  it('flags lost system audio on the pill itself', () => {
    renderTranscripts({ alert: true })
    expect(pillButton('transcripts').title).toMatch(/System audio isn't being captured/)
    renderTranscripts({ alert: false })
    expect(pillButton('transcripts').title).toBe('')
  })

  // The pill face shows only the final-line count, so while its card is shut
  // (most of a meeting) the ~7×/s interim flushes must not re-render the pill's
  // subtree — the liquid group, its ResizeObserver, its hover hooks. The
  // Profiler's onRender fires on any commit inside it: the probe.
  it('while shut, an interim flush re-renders nothing; a new final re-renders it with the new count', () => {
    const settled = seg('a', 'we ship Friday')
    const forming = (text: string): TranscriptSegment => ({ ...seg('b', text, 'remote_1'), isFinal: false })
    publish([settled])
    let commits = 0
    act(() => {
      root.render(
        h(
          Profiler,
          { id: 'transcripts', onRender: () => { commits++ } },
          h(LiveTranscriptsPill, {
            isActiveRecording: true,
            resumedPriorTranscript: null,
            persistedTranscript: null,
            speakerNames: {},
          }),
        ),
      )
    })
    expect(pillButton('transcripts').getAttribute('aria-label')).toBe('Transcripts (1)')
    const settledCommits = commits

    // The forming line grows, flush by flush — the count stays 1.
    for (const text of ['Sam', 'Sam owns', 'Sam owns it']) {
      act(() => publish([settled, forming(text)]))
    }
    expect(commits).toBe(settledCommits)
    expect(pillButton('transcripts').getAttribute('aria-label')).toBe('Transcripts (1)')

    // It settles into a final: the count moves, and so does the pill.
    act(() => publish([settled, seg('b', 'Sam owns it', 'remote_1')]))
    expect(commits).toBeGreaterThan(settledCommits)
    expect(pillButton('transcripts').getAttribute('aria-label')).toBe('Transcripts (2)')
  })

  it('open, its card follows the forming line flush by flush', () => {
    const settled = seg('a', 'we ship Friday')
    publish([settled])
    renderTranscripts()
    act(() => pillButton('transcripts').click())
    act(() => publish([settled, { ...seg('b', 'Sam owns', 'remote_1'), isFinal: false }]))
    expect(cardOf('transcripts').textContent).toContain('Sam owns')
    act(() => publish([settled, { ...seg('b', 'Sam owns the rollout', 'remote_1'), isFinal: false }]))
    expect(cardOf('transcripts').textContent).toContain('Sam owns the rollout')
    // Still one final line.
    expect(pillButton('transcripts').getAttribute('aria-label')).toBe('Transcripts (1)')
  })

  it('counts the live finals, not the saved lines, while live segments remain after a stop', () => {
    // Stopped, but the released live buffer still backs the transcript — the
    // count is the live final count, exactly as the transcript shows the live
    // lines (useCaptureTranscript's rule).
    publish([seg('a', 'one'), seg('b', 'two'), { ...seg('c', 'thr'), isFinal: false }])
    renderTranscripts({ isActiveRecording: false, persistedTranscript: '[Alice] saved line' })
    expect(pillButton('transcripts').getAttribute('aria-label')).toBe('Transcripts (2)')
  })
})

describe('LiveToolsPill', () => {
  it('counts the live agent’s calls, and its card lists them', () => {
    store.activity = [{ id: 't1', toolName: 'propose_change', args: {}, state: 'result', timestamp: 1 }]
    act(() => {
      root.render(h(LiveToolsPill))
    })
    expect(pillButton('tools').getAttribute('aria-label')).toBe('Tools (1)')
    act(() => pillButton('tools').click())
    expect(cardOf('tools').textContent).toContain('Propose change')
  })

  it('says so when the agent has made no calls yet', () => {
    act(() => {
      root.render(h(LiveToolsPill))
    })
    expect(pillButton('tools').getAttribute('aria-label')).toBe('Tools')
    act(() => pillButton('tools').click())
    expect(cardOf('tools').textContent).toContain('No tool calls yet')
  })
})

describe('LiveCapturePills', () => {
  const renderPills = (isActiveRecording: boolean, persistedTranscript: string | null = null) =>
    act(() => {
      root.render(
        h(LiveCapturePills, {
          isActiveRecording,
          resumedPriorTranscript: null,
          persistedTranscript,
          speakerNames: {},
        }),
      )
    })
  const pill = (name: string) => container.querySelector(`[data-composer-pill="${name}"]`)

  it('while the capture records: Transcripts, then Tools', () => {
    renderPills(true)
    const names = [...container.querySelectorAll('[data-composer-pill]')].map(
      (el) => (el as HTMLElement).dataset.composerPill,
    )
    expect(names).toEqual(['transcripts', 'tools'])
  })

  it('after the recording: Transcripts stays and Tools is gone, since it would only ever be empty', () => {
    renderPills(true)
    expect(pill('tools')).not.toBeNull()

    // The capture stops: the same Transcripts pill, now on the saved transcript.
    const transcripts = pill('transcripts')
    renderPills(false, '[Alice] saved line')
    expect(pill('tools')).toBeNull()
    expect(pill('transcripts')).toBe(transcripts)
    act(() => pillButton('transcripts').click())
    expect(cardOf('transcripts').textContent).toContain('saved line')
  })

  it('never shows Tools for a capture that is not recording, even with stale tool calls left in the store', () => {
    store.activity = [{ id: 't1', toolName: 'propose_change', args: {}, state: 'result', timestamp: 1 }]
    renderPills(false, '[Alice] saved line')
    expect(pill('transcripts')).not.toBeNull()
    expect(pill('tools')).toBeNull()
  })

  it('keeps Transcripts during a live call: the HUD shows no transcript (one-chat Slice 3)', () => {
    act(() => {
      root.render(
        h(LiveCapturePills, {
          isActiveRecording: true,
          resumedPriorTranscript: null,
          persistedTranscript: null,
          speakerNames: {},
        }),
      )
    })
    expect(pill('transcripts')).not.toBeNull()
    expect(pill('tools')).not.toBeNull()
  })
})
