// @vitest-environment jsdom
/**
 * Memoization contract for useDisplayTranscriptSegments (live-capture-header).
 *
 * The live segment array gets a FRESH identity on every ~150ms flush
 * (TranscriptMerger.getTranscript returns a copy), so a memo that keys the
 * prior-transcript parse on it re-runs parseTranscriptText over the entire —
 * never changing — prior transcript ~7×/s for the whole session on resumed
 * captures. The hook keys the prior/persisted parses on their strings alone;
 * these tests pin that a new liveSegments identity does NOT re-parse, while a
 * changed string does.
 *
 * parseTranscriptText is wrapped in a call-counting spy around the REAL
 * implementation; the header module's sibling imports with heavy transitive
 * deps (recording provider, desktop search) are stubbed so it mounts in jsdom.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { TranscriptSegment } from '@/lib/deepgram-stream'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// The Voice ID carousel watches its row for overflow; jsdom lays nothing out.
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// Count parseTranscriptText calls while keeping the real parsing behavior.
vi.mock('@/lib/deepgram-stream', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/deepgram-stream')>()
  return { ...actual, parseTranscriptText: vi.fn(actual.parseTranscriptText) }
})

// Controllable returns for the leaf-store hooks the live leaves (Voice ID, the
// transcript) read internally (per-utterance signals — audit finding 7).
// Reset per test.
const hookState = {
  transcriptSegments: [] as TranscriptSegment[],
  agentActivity: [] as import('@/hooks/use-recording').AgentActivityEvent[],
  detectedSpeakers: [] as string[],
  finalSegmentCount: 0,
}

// Inert stubs for the header's other imports — the hook under test touches
// none of them, but importing the module evaluates them all.
vi.mock('@/hooks/recording-context', () => ({
  useTranscriptSegments: () => hookState.transcriptSegments,
  useAgentActivity: () => hookState.agentActivity,
  useDetectedSpeakers: () => hookState.detectedSpeakers,
  useFinalSegmentCount: () => hookState.finalSegmentCount,
  useLiveAgentStatus: () => 'idle',
  // The derived live leaves: their values over the live segments (the real
  // hooks derive the same from the store's snapshot).
  useHasLiveTranscriptSegments: () => hookState.transcriptSegments.length > 0,
  useLiveActiveSpeaker: () => activeSpeakerOf(hookState.transcriptSegments),
  useAutoAcceptCountdown: (suggestion: { autoAcceptCountdown?: number }) => suggestion.autoAcceptCountdown,
}))
// Every speaker label a transcript row (or pill) resolved — one per row render,
// so it doubles as a per-row render probe.
const displayNameCalls = vi.hoisted(() => [] as string[])
// Only getSpeakerDisplayName is stubbed; releaseSessionSegments is kept REAL so
// the post-stop test below exercises the actual accumulator-release shape the
// provider hands the pane, not a hand-rolled imitation of it.
vi.mock('@/hooks/use-recording', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-recording')>()
  return {
    releaseSessionSegments: actual.releaseSessionSegments,
    getSpeakerDisplayName: (speaker: string) => {
      displayNameCalls.push(speaker)
      return speaker
    },
  }
})
// The real picker fetches contacts; this one renders its trigger plus a bare
// (textless) button that picks a fixed contact — enough to prove a speaker is
// still assignable without dragging the contacts API in.
vi.mock('@/components/desktop/speaker-contact-search', async () => {
  const { createElement, Fragment } = await import('react')
  return {
    SpeakerContactSearch: ({ children, speakerId, onAssign }: {
      children?: React.ReactNode
      speakerId: string
      onAssign?: (contactId: string, contactName: string) => void
    }) =>
      createElement(Fragment, null, children ?? null, createElement('button', {
        type: 'button',
        'data-assign': speakerId,
        onClick: () => onAssign?.('contact-1', 'Ada Lovelace'),
      })),
  }
})

import {
  activeSpeakerOf,
  TranscriptView,
  useCaptureActiveSpeaker,
  useCaptureFinalSegmentCount,
  useCaptureTranscript,
  useDisplayTranscriptSegments,
  LiveVoiceIdRow,
} from '../live-capture-header'
import { parseTranscriptText } from '@/lib/deepgram-stream'
import { releaseSessionSegments } from '@/hooks/use-recording'

const parseSpy = vi.mocked(parseTranscriptText)

/** Calls of the spy whose argument was exactly `text`. */
function parseCalls(text: string): number {
  return parseSpy.mock.calls.filter(([arg]) => arg === text).length
}

function seg(id: string, text: string): TranscriptSegment {
  return { id, text, stream: 'mic', speaker: 'local_1', startTime: 0, endTime: 0, isFinal: true, words: [] }
}

interface ProbeProps {
  isActiveRecording: boolean
  liveSegments: TranscriptSegment[]
  resumedPriorTranscript: string | null
  persistedTranscript: string | null
}

/** The most recent render's hook value. */
let latest: TranscriptSegment[]

function Probe({ isActiveRecording, liveSegments, resumedPriorTranscript, persistedTranscript }: ProbeProps) {
  latest = useDisplayTranscriptSegments(
    isActiveRecording,
    liveSegments,
    resumedPriorTranscript,
    persistedTranscript,
  )
  return null
}

let container: HTMLDivElement
let root: Root

function render(props: ProbeProps) {
  act(() => {
    root.render(h(Probe, props))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  parseSpy.mockClear()
  hookState.transcriptSegments = []
  hookState.agentActivity = []
  hookState.detectedSpeakers = []
  hookState.finalSegmentCount = 0
  displayNameCalls.length = 0
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('useDisplayTranscriptSegments', () => {
  const PRIOR = '[Alice] hello\n[Bob] hi there'

  it('parses a resumed prior transcript once, not per liveSegments identity', () => {
    render({
      isActiveRecording: true,
      liveSegments: [seg('l1', 'one')],
      resumedPriorTranscript: PRIOR,
      persistedTranscript: null,
    })
    expect(parseCalls(PRIOR)).toBe(1)
    expect(latest.map((s) => s.text)).toEqual(['hello', 'hi there', 'one'])

    // Two more flushes — each publish mints a fresh array identity, exactly
    // like TranscriptMerger.getTranscript's copy does ~7×/s in production.
    render({
      isActiveRecording: true,
      liveSegments: [seg('l1', 'one'), seg('l2', 'two')],
      resumedPriorTranscript: PRIOR,
      persistedTranscript: null,
    })
    render({
      isActiveRecording: true,
      liveSegments: [seg('l1', 'one'), seg('l2', 'two'), seg('l3', 'three')],
      resumedPriorTranscript: PRIOR,
      persistedTranscript: null,
    })

    expect(parseCalls(PRIOR)).toBe(1)
    expect(latest.map((s) => s.text)).toEqual(['hello', 'hi there', 'one', 'two', 'three'])
  })

  it('re-parses when the prior transcript string itself changes', () => {
    const OTHER = '[Carol] different session'
    render({
      isActiveRecording: true,
      liveSegments: [seg('l1', 'one')],
      resumedPriorTranscript: PRIOR,
      persistedTranscript: null,
    })
    render({
      isActiveRecording: true,
      liveSegments: [seg('l1', 'one')],
      resumedPriorTranscript: OTHER,
      persistedTranscript: null,
    })

    expect(parseCalls(PRIOR)).toBe(1)
    expect(parseCalls(OTHER)).toBe(1)
    expect(latest.map((s) => s.text)).toEqual(['different session', 'one'])
  })

  it('returns the live array by reference when there is no prior transcript', () => {
    const live = [seg('l1', 'one')]
    render({
      isActiveRecording: true,
      liveSegments: live,
      resumedPriorTranscript: null,
      persistedTranscript: null,
    })
    expect(latest).toBe(live)
  })

  // ── The post-stop blank-pane contract (recording-cache review, critical) ──
  // At Stop the provider calls clearSessionAccumulators, which hands this hook
  // the RELEASED segment array. If that release empties the array, the hook
  // falls through to `persistedTranscript` — a capture row the panel's one-shot
  // loadTranscript() may have filled from BEFORE the final force-save (null on
  // a fresh capture, truncated on a long one). These pin that the released array
  // still backs the pane, so the fallback timing can never blank or truncate it.
  it('keeps the meeting text on screen after stop even when the persisted row is null', () => {
    const live = [seg('l1', 'so the migration ships Friday'), seg('l2', 'Sam owns the rollout')]

    // Recording: the live buffer is the source.
    render({
      isActiveRecording: true,
      liveSegments: live,
      resumedPriorTranscript: null,
      persistedTranscript: null,
    })
    expect(latest.map((s) => s.text)).toEqual([
      'so the migration ships Friday',
      'Sam owns the rollout',
    ])

    // Stop: isActiveRecording flips false and the accumulators are released.
    // The persisted row is still null (a fresh capture whose loadTranscript
    // raced the final save), so the ONLY thing that can keep the pane populated
    // is the released array.
    render({
      isActiveRecording: false,
      liveSegments: releaseSessionSegments(live),
      resumedPriorTranscript: null,
      persistedTranscript: null,
    })
    expect(latest.length).toBe(2)
    expect(latest.map((s) => s.text)).toEqual([
      'so the migration ships Friday',
      'Sam owns the rollout',
    ])
  })

  it('prefers the released live buffer over a TRUNCATED persisted transcript after stop', () => {
    const live = [
      seg('l1', 'first thing we agreed'),
      seg('l2', 'second thing we agreed'),
      seg('l3', 'and the final decision'),
    ]
    // What a pre-final-save loadTranscript actually returns: the tail is missing.
    const TRUNCATED = '[local_1] first thing we agreed'

    render({
      isActiveRecording: false,
      liveSegments: releaseSessionSegments(live),
      resumedPriorTranscript: null,
      persistedTranscript: TRUNCATED,
    })

    expect(latest.map((s) => s.text)).toEqual([
      'first thing we agreed',
      'second thing we agreed',
      'and the final decision',
    ])
  })

  it('falls back to the persisted transcript on the DISCARD release (segments dropped)', () => {
    const live = [seg('l1', 'discarded chatter')]
    // Discard drops the array outright; there is no capture row left to show,
    // and the persisted branch is what the hook must take.
    render({
      isActiveRecording: false,
      liveSegments: releaseSessionSegments(live, true),
      resumedPriorTranscript: null,
      persistedTranscript: null,
    })
    expect(latest).toEqual([])
  })

  it('parses the persisted transcript once across re-renders when not recording', () => {
    const PERSISTED = '[Alice] saved line'
    render({
      isActiveRecording: false,
      liveSegments: [],
      resumedPriorTranscript: null,
      persistedTranscript: PERSISTED,
    })
    expect(latest.map((s) => s.text)).toEqual(['saved line'])
    expect(parseCalls(PERSISTED)).toBe(1)

    // Fresh (empty) liveSegments identity — the parse must not re-run.
    render({
      isActiveRecording: false,
      liveSegments: [],
      resumedPriorTranscript: null,
      persistedTranscript: PERSISTED,
    })
    expect(parseCalls(PERSISTED)).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────
// The live leaves read the per-utterance signals from the leaf-store hooks
// INTERNALLY (audit finding 7) — never through the capture page's props.
// Voice ID (LiveVoiceIdRow, the composer's speakers row) and the transcript's
// count (useCaptureTranscript, behind the Transcripts pill) are pinned here.
// ─────────────────────────────────────────────────────────────────
describe('live leaves read the recording stores', () => {
  const noop = () => {}

  function mountVoiceId(overrides: { assignContact?: (speaker: string, contactId: string, contactName: string) => void } = {}) {
    act(() => {
      root.render(
        h(LiveVoiceIdRow, {
          isActiveRecording: true,
          resumedPriorTranscript: null,
          persistedTranscript: null,
          speakerNames: {},
          speakerContacts: {},
          assignContact: noop,
          acceptSuggestion: noop,
          dismissSuggestion: noop,
          unlinkSpeaker: noop,
          ...overrides,
        }),
      )
    })
  }

  it('renders the speakers from the leaf store, with no prop plumbing', () => {
    hookState.detectedSpeakers = ['local_9']
    mountVoiceId()
    expect(container.textContent).toContain('local_9')
  })

  it("shows no speakers on another capture's page (they are the stopped call's)", () => {
    hookState.detectedSpeakers = ['local_9']
    act(() => {
      root.render(
        h(LiveVoiceIdRow, {
          isActiveRecording: false,
          resumedPriorTranscript: null,
          persistedTranscript: null,
          holdsLiveSegments: false,
          speakerNames: {},
          speakerContacts: {},
          assignContact: noop,
          acceptSuggestion: noop,
          dismissSuggestion: noop,
          unlinkSpeaker: noop,
        }),
      )
    })
    expect(container.childElementCount).toBe(0)
  })

  it('renders nothing until someone is heard, so the composer row stays collapsed', () => {
    hookState.detectedSpeakers = []
    mountVoiceId()
    expect(container.childElementCount).toBe(0)
  })

  it('keeps Voice ID: a detected speaker can still be assigned to a contact', () => {
    hookState.detectedSpeakers = ['local_1']
    const assignContact = vi.fn()
    mountVoiceId({ assignContact })
    expect(container.textContent).toContain('local_1')

    const assign = container.querySelector<HTMLButtonElement>('button[data-assign="local_1"]')
    expect(assign).not.toBeNull()
    act(() => assign!.click())
    expect(assignContact).toHaveBeenCalledWith('local_1', 'contact-1', 'Ada Lovelace')
  })

  it('counts the transcript from the leaf stores — the live final count while recording, the lines after', () => {
    let counted: ReturnType<typeof useCaptureTranscript> | null = null
    function Count(props: { isActiveRecording: boolean; persistedTranscript: string | null }) {
      counted = useCaptureTranscript({ ...props, resumedPriorTranscript: null })
      return null
    }

    hookState.finalSegmentCount = 7
    hookState.transcriptSegments = [seg('l1', 'live words')]
    act(() => {
      root.render(h(Count, { isActiveRecording: true, persistedTranscript: null }))
    })
    // While recording: the store's final count (7), and the live segments.
    expect(counted!.finalSegmentCount).toBe(7)
    expect(counted!.segments.map((s) => s.text)).toEqual(['live words'])

    // A saved capture, nothing live: its persisted lines, counted.
    hookState.finalSegmentCount = 0
    hookState.transcriptSegments = []
    act(() => {
      root.render(h(Count, { isActiveRecording: false, persistedTranscript: '[Alice] one\n[Bob] two' }))
    })
    expect(counted!.finalSegmentCount).toBe(2)
    expect(counted!.segments.map((s) => s.text)).toEqual(['one', 'two'])
  })
})

// ─────────────────────────────────────────────────────────────────
// The narrow leaves — the Transcripts pill's count (useCaptureFinalSegmentCount)
// and Voice ID's talker (useCaptureActiveSpeaker) — read only the stores that
// can change what they show, never the whole transcript. They must show
// EXACTLY what the whole-transcript derivation did: the count useCaptureTranscript
// returns, and activeSpeakerOf over the segments it returns.
// ─────────────────────────────────────────────────────────────────
describe('the narrow leaves agree with the whole-transcript derivation', () => {
  function line(id: string, text: string, speaker: string, isFinal = true): TranscriptSegment {
    return { id, text, stream: 'mic', speaker, startTime: 0, endTime: 0, isFinal, words: [] }
  }

  const PRIOR = '[Alice] hello\n[Bob] hi there'
  const PERSISTED = '[Carol] saved one\n[Dan] saved two'

  const cases: Array<{
    name: string
    isActiveRecording: boolean
    live: TranscriptSegment[]
    resumedPriorTranscript: string | null
    persistedTranscript: string | null
    holdsLiveSegments?: boolean
    count: number
    speaker: string | null
  }> = [
    { name: 'recording, nothing heard yet', isActiveRecording: true, live: [], resumedPriorTranscript: null, persistedTranscript: PERSISTED, count: 0, speaker: null },
    { name: 'resumed, nothing heard yet', isActiveRecording: true, live: [], resumedPriorTranscript: PRIOR, persistedTranscript: PERSISTED, count: 0, speaker: 'Bob' },
    {
      name: 'resumed, a line forming',
      isActiveRecording: true,
      live: [line('l1', 'one', 'local_1'), line('l2', 'tw', 'remote_1', false)],
      resumedPriorTranscript: PRIOR,
      persistedTranscript: null,
      count: 1,
      speaker: 'remote_1',
    },
    {
      name: 'resumed, every line settled',
      isActiveRecording: true,
      live: [line('l1', 'one', 'remote_1'), line('l2', 'two', 'local_1')],
      resumedPriorTranscript: PRIOR,
      persistedTranscript: null,
      count: 2,
      speaker: 'local_1',
    },
    {
      name: 'an interim behind a later final',
      isActiveRecording: true,
      live: [line('l1', 'one', 'local_1'), line('l2', 'tw', 'remote_1', false), line('l3', 'three', 'local_2')],
      resumedPriorTranscript: null,
      persistedTranscript: null,
      count: 2,
      speaker: 'remote_1',
    },
    { name: 'a saved capture', isActiveRecording: false, live: [], resumedPriorTranscript: null, persistedTranscript: PERSISTED, count: 2, speaker: 'Dan' },
    { name: 'a saved capture with no transcript', isActiveRecording: false, live: [], resumedPriorTranscript: null, persistedTranscript: null, count: 0, speaker: null },
    {
      name: 'stopped, the released live buffer still showing',
      isActiveRecording: false,
      live: [line('l1', 'one', 'local_1'), line('l2', 'tw', 'remote_1', false)],
      resumedPriorTranscript: PRIOR,
      persistedTranscript: PERSISTED,
      count: 1,
      speaker: 'remote_1',
    },
    {
      // GEN-41: the buffer kept after a stop belongs to the page that recorded it.
      name: "another capture's page after a stop: its own transcript, never the kept buffer",
      isActiveRecording: false,
      live: [line('l1', 'one', 'local_1'), line('l2', 'tw', 'remote_1', false)],
      resumedPriorTranscript: null,
      persistedTranscript: PERSISTED,
      holdsLiveSegments: false,
      count: 2,
      speaker: 'Dan',
    },
  ]

  for (const c of cases) {
    it(c.name, () => {
      hookState.transcriptSegments = c.live
      hookState.finalSegmentCount = c.live.filter((s) => s.isFinal).length
      const source = {
        isActiveRecording: c.isActiveRecording,
        resumedPriorTranscript: c.resumedPriorTranscript,
        persistedTranscript: c.persistedTranscript,
        holdsLiveSegments: c.holdsLiveSegments,
      }
      let seen: { whole: ReturnType<typeof useCaptureTranscript>; count: number; speaker: string | null } | null = null
      function Both() {
        seen = {
          whole: useCaptureTranscript(source),
          count: useCaptureFinalSegmentCount(source),
          speaker: useCaptureActiveSpeaker(source),
        }
        return null
      }
      act(() => {
        root.render(h(Both))
      })
      expect(seen!.count).toBe(seen!.whole.finalSegmentCount)
      expect(seen!.speaker).toBe(activeSpeakerOf(seen!.whole.segments))
      expect(seen!.count).toBe(c.count)
      expect(seen!.speaker).toBe(c.speaker)
      if (c.holdsLiveSegments === false) {
        expect(seen!.whole.segments.map((s) => s.text)).toEqual(['saved one', 'saved two'])
      }
    })
  }
})

// ─────────────────────────────────────────────────────────────────
// TranscriptView's rows are memoized on their line's primitives: a ~150ms
// flush that grows the forming (interim) line re-renders that one row, and
// every settled line above it bails out — even when the flush hands over fresh
// segment objects.
// ─────────────────────────────────────────────────────────────────
describe('TranscriptView rows', () => {
  function line(id: string, text: string, speaker: string, isFinal = true): TranscriptSegment {
    return { id, text, stream: 'mic', speaker, startTime: 0, endTime: 0, isFinal, words: [] }
  }

  // One identity across renders, as the page's speaker names are between changes.
  const NO_NAMES: Record<string, string> = {}
  function renderView(segments: TranscriptSegment[], speakerNames: Record<string, string> = NO_NAMES) {
    act(() => {
      root.render(h(TranscriptView, { segments, speakerNames }))
    })
  }
  /** The row (bubble) whose line reads `text`. */
  const rowOf = (text: string) =>
    Array.from(container.querySelectorAll('p')).find((p) => p.textContent === text)!.parentElement!

  it('an interim update re-renders only the forming row; a settled row keeps its element', () => {
    const settled = line('f1', 'we ship Friday', 'local_1')
    renderView([settled, line('i1', 'Sam', 'remote_1', false)])
    const settledRow = rowOf('we ship Friday')
    displayNameCalls.length = 0

    // Two flushes grow the forming line; the second hands the settled line
    // over as a fresh object, as a copy of the array can.
    renderView([settled, line('i1', 'Sam owns', 'remote_1', false)])
    renderView([{ ...settled }, line('i1', 'Sam owns it', 'remote_1', false)])

    // The settled row rendered neither time (it resolves its speaker's name on
    // every render); the forming row rendered for each flush.
    expect(displayNameCalls.filter((s) => s === 'local_1')).toHaveLength(0)
    expect(displayNameCalls.filter((s) => s === 'remote_1')).toHaveLength(2)
    expect(rowOf('we ship Friday')).toBe(settledRow)
    expect(rowOf('Sam owns it').className).toContain('opacity-50')

    // The forming line settles: that row re-renders (no longer faded).
    renderView([settled, line('i1', 'Sam owns it', 'remote_1')])
    expect(rowOf('Sam owns it').className).not.toContain('opacity-50')
    expect(displayNameCalls.filter((s) => s === 'local_1')).toHaveLength(0)
  })

  it('a change of speaker names re-renders every row', () => {
    const segments = [line('f1', 'one', 'local_1'), line('f2', 'two', 'remote_1')]
    renderView(segments)
    displayNameCalls.length = 0
    renderView(segments, { remote_1: 'Sam' })
    expect(displayNameCalls.sort()).toEqual(['local_1', 'remote_1'])
  })
})
