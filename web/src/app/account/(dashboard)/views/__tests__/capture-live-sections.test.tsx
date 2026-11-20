// @vitest-environment jsdom
/**
 * The capture page's Transcripts and Tools tabs (capture-live-sections.tsx),
 * which replaced the pills at the foot of its card.
 *
 * Each piece is a LEAF over the recording stores: the Transcripts tab's label
 * counts the final lines and its page shows the transcript (headed by the
 * system-audio notice and Voice ID), the label flagging lost system audio;
 * the Tools tab counts the live agent's calls and its page lists them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, Profiler, type ReactNode } from 'react'
import type { TranscriptSegment } from '@/lib/deepgram-stream'
import type { AgentActivityEvent } from '@/hooks/use-recording'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The live transcript as a tiny external store, like the real ref-backed one.
const store = vi.hoisted(() => ({
  segments: [] as TranscriptSegment[],
  finalCount: 0,
  activity: [] as AgentActivityEvent[],
  listeners: new Set<() => void>(),
}))

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

import { ToolsSection, ToolsTabLabel, TranscriptsSection, TranscriptsTabLabel } from '../capture-live-sections'

let container: HTMLDivElement
let root: Root

function seg(id: string, text: string, speaker = 'local_1'): TranscriptSegment {
  return { id, text, stream: 'mic', speaker, startTime: 0, endTime: 0, isFinal: true, words: [] }
}

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

const count = () => container.querySelector('[data-capture-tab-count]')?.textContent ?? null
const section = () => container.querySelector<HTMLElement>('[data-capture-section="transcripts"]')!

function renderSection(props: { active?: boolean; notice?: ReactNode; voiceId?: ReactNode; isActiveRecording?: boolean; persistedTranscript?: string | null } = {}) {
  act(() => {
    root.render(
      h(TranscriptsSection, {
        active: props.active ?? true,
        isActiveRecording: props.isActiveRecording ?? true,
        resumedPriorTranscript: null,
        persistedTranscript: props.persistedTranscript ?? null,
        speakerNames: {},
        notice: props.notice,
        voiceId: props.voiceId,
      }),
    )
  })
}

describe('TranscriptsTabLabel', () => {
  const renderLabel = (props: { alert?: boolean; isActiveRecording?: boolean; persistedTranscript?: string | null } = {}) =>
    act(() => {
      root.render(
        h(TranscriptsTabLabel, {
          isActiveRecording: props.isActiveRecording ?? true,
          persistedTranscript: props.persistedTranscript ?? null,
          alert: props.alert,
        }),
      )
    })

  it('names the tab and counts the final lines, with no count at zero', () => {
    renderLabel()
    expect(container.textContent).toBe('Transcripts')
    expect(count()).toBeNull()
    act(() => publish([seg('a', 'we ship Friday'), seg('b', 'Sam owns it', 'remote_1')]))
    expect(count()).toBe('2')
  })

  it('counts the saved transcript once the capture is no longer recording', () => {
    renderLabel({ isActiveRecording: false, persistedTranscript: '[Alice] saved line' })
    expect(count()).toBe('1')
  })

  it('flags lost system audio on the tab itself', () => {
    renderLabel({ alert: true })
    expect(container.querySelector('[title]')?.getAttribute('title')).toMatch(/System audio isn't being captured/)
    renderLabel({ alert: false })
    expect(container.querySelector('[title]')).toBeNull()
  })

  it('re-renders on a new final line, never on an interim flush', () => {
    const settled = seg('a', 'we ship Friday')
    publish([settled])
    let commits = 0
    act(() => {
      root.render(
        h(Profiler, { id: 'label', onRender: () => { commits++ } },
          h(TranscriptsTabLabel, { isActiveRecording: true, persistedTranscript: null })),
      )
    })
    const settledCommits = commits
    for (const text of ['Sam', 'Sam owns', 'Sam owns it']) {
      act(() => publish([settled, { ...seg('b', text, 'remote_1'), isFinal: false }]))
    }
    expect(commits).toBe(settledCommits)
    act(() => publish([settled, seg('b', 'Sam owns it', 'remote_1')]))
    expect(commits).toBeGreaterThan(settledCommits)
    expect(count()).toBe('2')
  })
})

describe('TranscriptsSection', () => {
  it('shows the transcript under the notice and Voice ID, with Copy', () => {
    publish([seg('a', 'we ship Friday'), seg('b', 'Sam owns it', 'remote_1')])
    renderSection({
      notice: h('div', { 'data-notice': '' }, 'Recording your mic only'),
      voiceId: h('div', { 'data-voice': '' }, 'Speakers'),
    })
    const page = section()
    expect(page.className).not.toContain('hidden')
    const text = page.textContent!
    expect(text.indexOf('Recording your mic only')).toBeLessThan(text.indexOf('Speakers'))
    expect(text.indexOf('Speakers')).toBeLessThan(text.indexOf('we ship Friday'))
    expect(text).toContain('Sam owns it')
    expect(text).toContain('Copy')
  })

  it('on another tab: hidden, the lines unmounted, the notice and Voice ID kept', () => {
    publish([seg('a', 'we ship Friday')])
    renderSection({
      active: false,
      notice: h('div', { 'data-notice': '' }, 'notice'),
      voiceId: h('div', { 'data-voice': '' }, 'Speakers'),
    })
    expect(section().className).toBe('hidden')
    expect(section().textContent).not.toContain('we ship Friday')
    expect(section().querySelector('[data-notice]')).not.toBeNull()
    expect(section().querySelector('[data-voice]')).not.toBeNull()
  })

  it('shows the saved transcript once the capture is no longer recording', () => {
    renderSection({ isActiveRecording: false, persistedTranscript: '[Alice] saved line' })
    expect(section().textContent).toContain('saved line')
  })

  it('follows the forming line flush by flush while shown', () => {
    const settled = seg('a', 'we ship Friday')
    publish([settled])
    renderSection()
    act(() => publish([settled, { ...seg('b', 'Sam owns the rollout', 'remote_1'), isFinal: false }]))
    expect(section().textContent).toContain('Sam owns the rollout')
  })

  it('says so when there is no transcript yet', () => {
    renderSection()
    expect(section().textContent).toContain('No transcript yet')
  })
})

describe('the Tools tab', () => {
  it('counts the live agent’s calls on its label, and its page lists them', () => {
    store.activity = [{ id: 't1', toolName: 'propose_change', args: {}, state: 'result', timestamp: 1 }]
    act(() => root.render(h('div', null, h(ToolsTabLabel), h(ToolsSection))))
    expect(count()).toBe('1')
    expect(container.querySelector('[data-capture-section="tools"]')!.textContent).toContain('Propose change')
  })

  it('says so when the agent has made no calls yet', () => {
    act(() => root.render(h('div', null, h(ToolsTabLabel), h(ToolsSection))))
    expect(count()).toBeNull()
    expect(container.textContent).toContain('No tool calls yet')
  })
})
