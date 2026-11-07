// @vitest-environment jsdom
/**
 * The REAL NoteEditor's two ways of receiving external content.
 *
 * `externalContent` (a prop, applied in an effect) and `externalContentSink`
 * (a receiver the owner calls directly, so an animation's frames don't
 * re-render the owner) must land in the same place, and a value that already
 * arrived through the sink must be a no-op when the owner later sets it as the
 * prop. A frame that strictly extends the last applied text is an animation
 * frame: it goes straight to the parse, without the two whole-document
 * markdown round trips used to detect "already in sync".
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
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

// Pass-through spies on the whole-document conversions, to count them.
const conversions = vi.hoisted(() => ({
  toJSON: null as unknown as Mock,
  toMarkdown: null as unknown as Mock,
}))
vi.mock('../markdown-conversion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../markdown-conversion')>()
  conversions.toJSON = vi.fn(actual.markdownToJSONContent)
  conversions.toMarkdown = vi.fn(actual.jsonContentToMarkdown)
  return {
    ...actual,
    markdownToJSONContent: conversions.toJSON,
    jsonContentToMarkdown: conversions.toMarkdown,
  }
})

import { NoteEditor, type NoteEditorProps } from '../note-editor'

type Sink = (markdown: string) => void

let container: HTMLDivElement
let root: Root
let editor: Editor | null
let sinkRef: { current: Sink | null }
const onUpdate = vi.fn()

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function render(props: Partial<NoteEditorProps> = {}) {
  return act(async () =>
    root.render(
      h(NoteEditor, {
        initialContent: 'Intro.',
        onUpdate,
        externalContentSink: sinkRef,
        onEditorReady: (ed: Editor) => {
          editor = ed
        },
        ...props,
      }),
    ),
  )
}

async function mount(props: Partial<NoteEditorProps> = {}) {
  await render(props)
  await settle()
  if (!editor) throw new Error('the editor did not mount')
  return editor
}

async function push(markdown: string) {
  await act(async () => sinkRef.current!(markdown))
  await settle()
}

function resetConversionCounts() {
  conversions.toJSON.mockClear()
  conversions.toMarkdown.mockClear()
}

beforeEach(() => {
  editor = null
  sinkRef = { current: null }
  onUpdate.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  await settle()
  container.remove()
})

describe('NoteEditor — externalContentSink', () => {
  it('a sink push applies the content; the same value later set as externalContent is a no-op', async () => {
    const ed = await mount({ externalContent: 'Intro.' })
    expect(typeof sinkRef.current).toBe('function')

    await push('Intro. The team agreed to ship on Friday.')
    expect(ed.getText()).toBe('Intro. The team agreed to ship on Friday.')

    // The owner's animation ends: its last frame goes into state and arrives
    // as the prop. NoteEditor already holds it — nothing is converted or applied.
    const transactions = vi.fn()
    ed.on('transaction', transactions)
    resetConversionCounts()
    await render({ externalContent: 'Intro. The team agreed to ship on Friday.' })
    await settle()
    expect(transactions).not.toHaveBeenCalled()
    expect(conversions.toJSON).not.toHaveBeenCalled()
    expect(conversions.toMarkdown).not.toHaveBeenCalled()
    expect(ed.getText()).toBe('Intro. The team agreed to ship on Friday.')
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('unmounting hands the sink back as null', async () => {
    await mount()
    expect(typeof sinkRef.current).toBe('function')
    await act(async () => root.unmount())
    expect(sinkRef.current).toBeNull()
    root = createRoot(container) // for afterEach
  })

  it('a strict-extension frame skips the round trips and still ends showing the extended text', async () => {
    const ed = await mount()

    // First frame: nothing applied yet, so the full comparison path runs.
    resetConversionCounts()
    await push('Alpha')
    expect(ed.getText()).toBe('Alpha')
    expect(conversions.toMarkdown).toHaveBeenCalled()

    // Next frames extend it — one parse each, no serialisation of the doc.
    resetConversionCounts()
    await push('Alpha beta')
    expect(conversions.toMarkdown).not.toHaveBeenCalled()
    expect(conversions.toJSON).toHaveBeenCalledTimes(1)
    expect(ed.getText()).toBe('Alpha beta')

    // Same through the prop path.
    resetConversionCounts()
    await render({ externalContent: 'Alpha beta gamma' })
    await settle()
    expect(conversions.toMarkdown).not.toHaveBeenCalled()
    expect(conversions.toJSON).toHaveBeenCalledTimes(1)
    expect(ed.getText()).toBe('Alpha beta gamma')

    // Markdown that resolves mid-animation still renders as markup.
    await push('Alpha beta gamma\n\n## Plan\n\n- Book the room')
    expect(container.querySelector('.ProseMirror h2')?.textContent).toBe('Plan')
    expect(container.querySelector('.ProseMirror li')?.textContent).toBe('Book the room')
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('a value that does not extend the last applied text takes the full comparison path', async () => {
    const ed = await mount()
    await push('Alpha beta')

    resetConversionCounts()
    await push('Something else entirely')
    expect(conversions.toMarkdown).toHaveBeenCalled()
    expect(ed.getText()).toBe('Something else entirely')
  })

  it('a push that matches the document after normalisation leaves it alone', async () => {
    const ed = await mount({ initialContent: 'Intro.' })
    const transactions = vi.fn()
    ed.on('transaction', transactions)

    // Not a strict extension of anything applied (nothing has been), and it
    // round-trips to the doc already showing — no replace.
    await push('Intro.\n\n')
    expect(transactions).not.toHaveBeenCalled()
    expect(ed.getText()).toBe('Intro.')
  })
})
