// @vitest-environment jsdom
/**
 * The recording poll must not re-render the capture panel when nothing moved.
 *
 * useRecordingPollFallback refetches the capture row every 25s for the whole
 * meeting. Its merge used to hand setCapture a fresh object every tick, so the
 * ~4k-line panel re-rendered each time, a main-thread stall in the desktop
 * app's WKWebView. The contract now:
 *
 *  - a row that reads the same as state never reaches setCapture, and nothing
 *    re-renders;
 *  - the poll reads the meta payload (no transcript, content or
 *    note_attributions), which keeps state's copies of those columns;
 *  - while this client records, a row whose only news is its own transcript
 *    auto-save (transcript + updated_at) counts as unchanged, and the saved
 *    transcript goes into state when the recording stops;
 *  - anything else that changed (title, status, summary, …) still lands on the
 *    tick that fetched it.
 *
 * The panel module can't be rendered in isolation, so `Host` runs the real
 * poll hook and the panel's real commit helper against a Profiler-wrapped leaf.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, Profiler, useCallback, useRef, useState } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The panel's editor stack reaches react-tweet, which ships raw CSS modules
// node can't load — stub the editor at its module boundary. These tests only
// exercise the pure helpers the panel exports.
vi.mock('@/app/account/(dashboard)/views/note-editor', () => ({ NoteEditor: () => null }))

import {
  commitRefetchedCapture,
  mergeRefetchedCapture,
  mergeSavedTranscript,
} from '../capture-detail-panel'
import { useRecordingPollFallback } from '@/hooks/use-recording-poll-fallback'
import type { CaptureDetail } from '@/lib/capture-cache'

function row(overrides: Partial<CaptureDetail> = {}): CaptureDetail {
  return {
    id: 'cap-1',
    title: 'Weekly sync',
    user_id: 'user-1',
    visibility: 'workspace',
    content: null,
    summary: null,
    transcript: '[Liam] Morning all.',
    user_notes: null,
    audio_url: null,
    duration_seconds: null,
    source_url: null,
    calendar_event_id: null,
    meeting_url: null,
    location: null,
    organizer_email: null,
    participants: [{ email: 'sam@example.com', name: 'Sam' }],
    project_id: null,
    project_name: null,
    tags: ['team'],
    labels: [{ id: 'l1', name: 'Sync', color: '#00f' }],
    metadata: { live_mode: true, source: 'desktop' },
    ai_processed: false,
    ai_summary: '## Notes\n- kickoff',
    note_attributions: null,
    decision_count: 0,
    suggested_decision_count: 0,
    status: 'recording',
    is_pinned: false,
    started_at: '2026-10-19T14:00:00.000Z',
    ended_at: null,
    recorded_at: '2026-10-19T14:00:00.000Z',
    package_ids: [],
    created_at: '2026-10-19T14:00:00.000Z',
    updated_at: '2026-10-19T14:05:00.000Z',
    ...overrides,
  }
}

/** The poll's `?fields=meta` row: the heavy text columns' keys are absent. */
function metaRow(overrides: Partial<CaptureDetail> = {}): CaptureDetail {
  const { transcript: _t, content: _c, note_attributions: _n, ...meta } = row(overrides)
  void _t
  void _c
  void _n
  return meta as CaptureDetail
}

describe('mergeRefetchedCapture', () => {
  it('keeps the previous object when the fetched row reads the same', () => {
    const prev = row()
    // A fresh fetch: every nested column arrives as a new object.
    const fetched = row({
      participants: [{ email: 'sam@example.com', name: 'Sam' }],
      labels: [{ id: 'l1', name: 'Sync', color: '#00f' }],
      metadata: { live_mode: true, source: 'desktop' },
      tags: ['team'],
    })
    expect(mergeRefetchedCapture(prev, fetched, { stale: false })).toBe(prev)
  })

  it.each<[string, Partial<CaptureDetail>]>([
    ['title', { title: 'Weekly sync with Sam' }],
    ['status', { status: 'processing' }],
    ['ai_summary', { ai_summary: '## Notes\n- kickoff\n- budget' }],
    ['ended_at', { ended_at: '2026-10-19T14:30:00.000Z' }],
    ['labels', { labels: [] }],
    ['metadata', { metadata: { live_mode: false, source: 'desktop' } }],
  ])('returns a new object carrying a changed %s', (_field, change) => {
    const prev = row()
    const next = mergeRefetchedCapture(prev, row(change), { stale: false })
    expect(next).not.toBe(prev)
    expect(next).toMatchObject(change)
  })

  it('adopts the fetched row when there is no state yet', () => {
    const fetched = row()
    expect(mergeRefetchedCapture(null, fetched, { stale: false })).toBe(fetched)
  })

  it('a stale row still never regresses the summary, and changes nothing else', () => {
    const prev = row({ ai_summary: 'just typed', updated_at: '2026-10-19T14:06:00.000Z' })
    const fetched = row({ ai_summary: 'older text', updated_at: '2026-10-19T14:05:00.000Z' })
    expect(mergeRefetchedCapture(prev, fetched, { stale: true })).toBe(prev)
  })

  it('a stale row with a real change keeps the summary and the later updated_at', () => {
    const prev = row({ ai_summary: 'just typed', updated_at: '2026-10-19T14:06:00.000Z' })
    const fetched = row({ ai_summary: 'older text', title: 'Renamed', updated_at: '2026-10-19T14:05:00.000Z' })
    const next = mergeRefetchedCapture(prev, fetched, { stale: true })
    expect(next).toMatchObject({ title: 'Renamed', ai_summary: 'just typed', updated_at: '2026-10-19T14:06:00.000Z' })
  })

  it('a transcript-only change is a real change outside the recording poll', () => {
    const prev = row()
    const fetched = row({ transcript: prev.transcript + '\n[Sam] Hi.', updated_at: '2026-10-19T14:05:20.000Z' })
    const next = mergeRefetchedCapture(prev, fetched, { stale: false })
    expect(next).not.toBe(prev)
    expect(next.transcript).toBe(fetched.transcript)
  })

  it('the recording poll treats its own transcript save as unchanged', () => {
    const prev = row()
    const fetched = row({ transcript: prev.transcript + '\n[Sam] Hi.', updated_at: '2026-10-19T14:05:20.000Z' })
    expect(mergeRefetchedCapture(prev, fetched, { stale: false, ignoreTranscriptSaves: true })).toBe(prev)
  })

  it('a meta row that changes nothing keeps the previous object', () => {
    const prev = row()
    expect(mergeRefetchedCapture(prev, metaRow(), { stale: false })).toBe(prev)
  })

  it('a meta row keeps state\'s transcript, content and note_attributions', () => {
    const prev = row({ content: 'notes', note_attributions: [] })
    const next = mergeRefetchedCapture(prev, metaRow({ title: 'Renamed' }), { stale: false })
    expect(next).toMatchObject({ title: 'Renamed', transcript: prev.transcript, content: 'notes', note_attributions: [] })
  })

  it('on the recording poll, a meta row whose only news is updated_at is the recorder\'s own save', () => {
    const prev = row()
    const fetched = metaRow({ updated_at: '2026-10-19T14:05:20.000Z' })
    expect(mergeRefetchedCapture(prev, fetched, { stale: false, ignoreTranscriptSaves: true })).toBe(prev)
    // Off the poll the newer updated_at is real news.
    expect(mergeRefetchedCapture(prev, fetched, { stale: false })).not.toBe(prev)
  })

  it('the recording poll still lands anything else, transcript included', () => {
    const prev = row()
    const fetched = row({
      transcript: prev.transcript + '\n[Sam] Hi.',
      ai_summary: '## Notes\n- kickoff\n- hiring',
      updated_at: '2026-10-19T14:05:20.000Z',
    })
    const next = mergeRefetchedCapture(prev, fetched, { stale: false, ignoreTranscriptSaves: true })
    expect(next).not.toBe(prev)
    expect(next).toMatchObject({
      transcript: fetched.transcript,
      ai_summary: fetched.ai_summary,
      updated_at: fetched.updated_at,
    })
  })
})

describe('mergeSavedTranscript', () => {
  it('puts the saved transcript into state, and nothing else', () => {
    const prev = row()
    const saved = prev.transcript + '\n[Sam] Bye.'
    const next = mergeSavedTranscript(prev, saved)
    expect(next).toEqual({ ...prev, transcript: saved })
  })

  it('keeps the previous object when state already holds that text', () => {
    const prev = row()
    expect(mergeSavedTranscript(prev, prev.transcript)).toBe(prev)
  })

  it('is a no-op without state', () => {
    expect(mergeSavedTranscript(null, 'x')).toBeNull()
  })
})

// ── The poll tick, rendered ─────────────────────────────────────────────────

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

function Leaf({ capture }: { capture: CaptureDetail | null }) {
  return h('h1', null, capture?.title ?? '')
}

/**
 * The panel's poll path in miniature: capture state + its render-synced
 * mirror, the real poll hook, and the panel's commit helper on each tick
 * (`legacy` replays the old always-new-object merge, for the baseline).
 */
function Host(props: {
  initial: CaptureDetail
  nextRow: () => CaptureDetail
  setSpy: (fn: unknown) => void
  onCommit: () => void
  legacy?: boolean
}) {
  const [capture, setCaptureState] = useState<CaptureDetail | null>(props.initial)
  const captureStateRef = useRef(capture)
  captureStateRef.current = capture
  const propsRef = useRef(props)
  propsRef.current = props
  const setCapture = useCallback((value: Parameters<typeof setCaptureState>[0]) => {
    propsRef.current.setSpy(value)
    setCaptureState(value)
  }, [])
  const onTick = useCallback(() => {
    const fetched = propsRef.current.nextRow()
    if (propsRef.current.legacy) {
      setCapture((prev) => (prev ? { ...prev, ...fetched, labels: fetched.labels ?? prev.labels } : fetched))
      return
    }
    commitRefetchedCapture(captureStateRef.current, fetched, { stale: false, ignoreTranscriptSaves: true }, setCapture)
  }, [setCapture])
  const isDeliveryDown = useCallback(() => false, [])
  useRecordingPollFallback(true, onTick, isDeliveryDown, 25_000)
  return h(Profiler, { id: 'panel', onRender: () => propsRef.current.onCommit() }, h(Leaf, { capture }))
}

function mount(opts: { nextRow: () => CaptureDetail; legacy?: boolean }) {
  const setSpy = vi.fn()
  const onCommit = vi.fn()
  act(() => root.render(h(Host, { initial: row(), setSpy, onCommit, ...opts })))
  onCommit.mockClear()
  return { setSpy, onCommit }
}

const tick = () => act(() => vi.advanceTimersByTime(25_000))

describe('recording poll tick → panel renders', () => {
  it('baseline: the old merge re-rendered the panel on every unchanged tick', () => {
    const { onCommit } = mount({ nextRow: () => metaRow(), legacy: true })
    tick()
    tick()
    tick()
    expect(onCommit).toHaveBeenCalledTimes(3)
  })

  it('an unchanged poll does not call setCapture and does not re-render', () => {
    const { setSpy, onCommit } = mount({ nextRow: () => metaRow() })
    tick()
    tick()
    tick()
    expect(setSpy).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('the recorder\'s own transcript saves do not re-render either', () => {
    // On the meta payload the save shows up as updated_at alone.
    let saves = 0
    const { setSpy, onCommit } = mount({
      nextRow: () => {
        saves += 1
        return metaRow({ updated_at: new Date(Date.UTC(2026, 9, 19, 14, 5 + saves)).toISOString() })
      },
    })
    tick()
    tick()
    expect(setSpy).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('a changed poll still updates, on the tick that fetched it', () => {
    let title = 'Weekly sync'
    const { setSpy, onCommit } = mount({ nextRow: () => metaRow({ title }) })
    tick()
    expect(onCommit).not.toHaveBeenCalled()

    title = 'Weekly sync with Sam'
    tick()
    expect(setSpy).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(container.textContent).toBe('Weekly sync with Sam')

    // And it settles: the same row again renders nothing.
    tick()
    expect(onCommit).toHaveBeenCalledTimes(1)
  })
})
