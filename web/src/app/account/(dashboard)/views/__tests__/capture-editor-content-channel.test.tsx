// @vitest-environment jsdom
/**
 * The capture panel's editor-content channel, against the REAL NoteEditor.
 *
 * The panel's two animations (streaming typewriter, live summary reveal) push
 * each frame straight into the editor through `externalContentSink` instead
 * of a setState per frame, so a frame no longer re-renders the ~4k-line panel.
 * That must be invisible: for any interleaving of frames and ordinary sets,
 * the editor has to show exactly what it showed when every frame was a
 * setState. The traps are React's own — a set equal to the (stale) state is
 * dropped by the same-value bail-out, and a set still waiting to render would
 * land AFTER a sink frame — which is what the panel's bookkeeping handles.
 *
 * The panel module can't be rendered in isolation, so `Owner` mirrors its
 * helpers (setEditorContent / showInEditor / settleEditorContent in
 * capture-detail-panel.tsx) — keep the two in step. Each scenario runs twice,
 * frames through the sink and frames through state, and must read the same.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    ttsSpeak: async () => {},
    ttsCancel: async () => {},
    ttsPrepare: async () => {},
    onTtsState: () => () => {},
  },
}))
vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn() }))
// The selection bubble menu builds a tippy.js tooltip on the first document
// replace, and tippy's default export doesn't resolve to a function in this
// jsdom setup. It plays no part in external content — leave it out.
vi.mock('novel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('novel')>()),
  EditorBubble: () => null,
  EditorBubbleItem: () => null,
}))

import { NoteEditor } from '../note-editor'

type Channel = {
  /** A non-animated write (setSummaryDirect, the batch clear, …). */
  set: (markdown: string) => void
  /** One animation frame. */
  frame: (markdown: string) => void
  /** The animation stopped. */
  settle: () => void
}

let channel: Channel
let ownerRenders = 0
let editor: Editor | null = null

/** Mirrors capture-detail-panel's editor-content channel. With `sink` false,
 *  frames are plain setStates — the behaviour the sink path must reproduce. */
function Owner({ sink: useSink }: { sink: boolean }) {
  ownerRenders++
  const [externalEditorContent, setExternalEditorContent] = useState<string | undefined>(undefined)
  const editorSinkRef = useRef<((markdown: string) => void) | null>(null)
  const externalEditorContentRef = useRef('')
  const editorFramesAheadRef = useRef(false)
  const editorStateSetRef = useRef<string | undefined>(undefined)
  const editorStateRenderedRef = useRef<string | undefined>(undefined)
  editorStateRenderedRef.current = externalEditorContent
  const editorStateSeenRef = useRef<string | undefined>(undefined)
  const editorReceivedRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    editorStateSeenRef.current = externalEditorContent
    editorReceivedRef.current = externalEditorContent
  }, [externalEditorContent])

  const setEditorContent = useCallback((markdown: string) => {
    externalEditorContentRef.current = markdown
    editorFramesAheadRef.current = false
    editorStateSetRef.current = markdown
    setExternalEditorContent(markdown)
    const rendered = editorStateRenderedRef.current
    if (
      markdown === rendered &&
      rendered === editorStateSeenRef.current &&
      editorReceivedRef.current !== markdown
    ) {
      const sink = editorSinkRef.current
      if (sink) {
        editorReceivedRef.current = markdown
        sink(markdown)
      }
    }
  }, [])

  const showInEditor = useCallback((markdown: string) => {
    const sink = editorSinkRef.current
    const rendered = editorStateRenderedRef.current
    if (!sink || editorStateSetRef.current !== rendered || rendered !== editorStateSeenRef.current) {
      setEditorContent(markdown)
      return
    }
    externalEditorContentRef.current = markdown
    editorFramesAheadRef.current = true
    editorReceivedRef.current = markdown
    sink(markdown)
  }, [setEditorContent])

  const settleEditorContent = useCallback(() => {
    if (editorFramesAheadRef.current) setEditorContent(externalEditorContentRef.current)
  }, [setEditorContent])

  channel = {
    set: setEditorContent,
    frame: useSink ? showInEditor : setEditorContent,
    settle: useSink ? settleEditorContent : () => {},
  }
  return h(NoteEditor, {
    initialContent: 'Old summary',
    onUpdate: () => {},
    externalContent: externalEditorContent,
    externalContentSink: useSink ? editorSinkRef : undefined,
    onEditorReady: (ed: Editor) => {
      editor = ed
    },
  })
}

let container: HTMLDivElement
let root: Root

async function settleTimers() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mount(sink: boolean) {
  editor = null
  await act(async () => root.render(h(Owner, { sink })))
  await settleTimers()
  if (!editor) throw new Error('the editor did not mount')
}

/** Run the steps (each one a task, like a rAF callback or a Realtime message)
 *  and record what the editor shows after each. */
async function run(sink: boolean, steps: Array<(c: Channel) => void>) {
  await mount(sink)
  const shown: string[] = []
  for (const step of steps) {
    await act(async () => step(channel))
    await settleTimers()
    shown.push(editor!.getText())
  }
  await act(async () => root.unmount())
  root = createRoot(container)
  return shown
}

beforeEach(() => {
  ownerRenders = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const scenarios: Record<string, Array<(c: Channel) => void>> = {
  'batch typewriter: clear, type, settle': [
    (c) => c.set(''),
    (c) => c.frame('The'),
    (c) => c.frame('The team'),
    (c) => c.frame('The team agreed'),
    (c) => c.settle(),
  ],
  // The canonical summary equals what state held before the frames: React
  // would bail out on it and leave the streamed preview on screen.
  'a set back to the pre-animation value after frames': [
    (c) => c.set('Old summary'),
    (c) => c.frame('Pre'),
    (c) => c.frame('Preview'),
    (c) => c.set('Old summary'),
  ],
  'the same, with another set batched in between': [
    (c) => c.set('Old summary'),
    (c) => c.frame('Pre'),
    (c) => {
      c.set('Other')
      c.set('Old summary')
    },
  ],
  'a clear after frames when state already holds the clear': [
    (c) => c.set(''),
    (c) => c.frame('abc'),
    (c) => c.set(''),
  ],
  // A set that hasn't rendered yet must not land after the frame that follows it.
  'a frame in the same task as a pending set': [
    (c) => {
      c.set('Base')
      c.frame('Base plus')
    },
    (c) => c.frame('Base plus more'),
    (c) => c.settle(),
  ],
  'frames, then a different canonical value': [
    (c) => c.frame('Alpha'),
    (c) => c.frame('Alpha beta'),
    (c) => c.set('Canonical'),
  ],
  'a reveal superseded mid-way by a shrink': [
    (c) => c.set('Summary one'),
    (c) => c.frame('Summary one. More'),
    (c) => c.set('Summary'),
    (c) => c.frame('Summary two'),
    (c) => c.settle(),
  ],
}

describe('capture editor content — sink frames are indistinguishable from per-frame setState', () => {
  for (const [name, steps] of Object.entries(scenarios)) {
    it(name, async () => {
      const viaState = await run(false, steps)
      const viaSink = await run(true, steps)
      expect(viaSink).toEqual(viaState)
    })
  }

  it('frames do not re-render the owner; settling costs one render and changes nothing shown', async () => {
    await mount(true)
    await act(async () => channel.set('x'))
    await settleTimers()

    const before = ownerRenders
    for (const f of ['x1', 'x12', 'x123', 'x1234']) {
      await act(async () => channel.frame(f))
      await settleTimers()
      expect(editor!.getText()).toBe(f)
    }
    expect(ownerRenders).toBe(before)

    await act(async () => channel.settle())
    await settleTimers()
    expect(ownerRenders).toBe(before + 1)
    expect(editor!.getText()).toBe('x1234')
  })
})
