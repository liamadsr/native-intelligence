// @vitest-environment jsdom
/**
 * Undo-history retention for programmatic document writes.
 *
 * The capture editor replaces its whole document programmatically: the AI
 * summary streams in a frame at a time, external syncs land, and proposal
 * markers re-resolve into atoms. Tiptap's `setContent` sets only
 * `preventUpdate` — it does NOT opt out of history — so each of those replaces
 * pushed an inverted step holding the ENTIRE previous document onto the undo
 * stack. ProseMirror prunes by EVENT and merges transactions less than 500ms
 * apart into one, so a per-frame animation packed thousands of full-document
 * snapshots into a single event that depth pruning could never reclaim:
 * hundreds of MB to a GB retained on a long capture.
 *
 * These tests drive a REAL editor and read the history plugin's own item list
 * rather than `undoDepth` (which counts merged events and would report "1" for
 * a thousand snapshots — exactly how the leak stayed invisible).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { Editor, type JSONContent } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import History from '@tiptap/extension-history'
import { undoDepth } from '@tiptap/pm/history'

const UNDO_DEPTH = 30

/** Mirrors note-editor's helper — the behavior under test. */
function setContentWithoutHistory(editor: Editor, content: JSONContent) {
  editor.chain().setMeta('addToHistory', false).setContent(content, false).run()
}

function doc(text: string): JSONContent {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
}

let editor: Editor | null = null

function makeEditor() {
  editor = new Editor({
    extensions: [Document, Paragraph, Text, History.configure({ depth: UNDO_DEPTH })],
    content: doc('start'),
  })
  return editor
}

/**
 * Retained undo ITEMS, not events — this distinction is the whole bug.
 *
 * prosemirror-history stores one item per inverted step, and an inverted
 * whole-document replace holds a complete copy of the previous document. It
 * prunes by `eventCount`, and sub-500ms transactions merge into one event, so
 * 25 programmatic replaces measure as eventCount 1 / items 25: `undoDepth`
 * reports "1" while 25 documents sit in memory, and depth pruning sees nothing
 * to reclaim. Asserting on undoDepth here would pass with the leak intact.
 */
function historyItemCount(ed: Editor): number {
  const state = ed.state as unknown as Record<string, unknown>
  const key = Object.keys(state).find((k) => k.startsWith('history$'))
  if (!key) throw new Error('history plugin state not found')
  const done = (state[key] as { done?: { items?: { length: number } } }).done
  return done?.items?.length ?? 0
}

afterEach(() => {
  editor?.destroy()
  editor = null
})

describe('programmatic document writes stay out of undo history', () => {
  it('records nothing for a single external replace', () => {
    const ed = makeEditor()
    const before = historyItemCount(ed)

    setContentWithoutHistory(ed, doc('replaced by an external sync'))

    expect(historyItemCount(ed)).toBe(before)
    expect(ed.getText()).toBe('replaced by an external sync')
  })

  it('records nothing across an animation-cadence stream of replaces', () => {
    // The shape that caused the incident: a summary typed in one frame at a
    // time. Every frame replaced the whole document, and all of them merged
    // into a single unprunable undo event.
    const ed = makeEditor()
    const target = 'The quarterly roadmap is locked and Sam owns the migration.'

    for (let i = 1; i <= target.length; i++) {
      setContentWithoutHistory(ed, doc(target.slice(0, i)))
    }

    expect(historyItemCount(ed)).toBe(0)
    expect(ed.getText()).toBe(target)
  })

  it('a plain setContent DOES retain a snapshot per call (the defect this prevents)', () => {
    // Guards the premise: if a future Tiptap upgrade makes setContent
    // history-free on its own, this test fails and the helper can be revisited.
    const ed = makeEditor()

    for (let i = 0; i < 25; i++) {
      ed.commands.setContent(doc(`frame ${i}`), false)
    }

    expect(historyItemCount(ed)).toBe(25)
  })
})

describe('the user still gets a normal undo stack', () => {
  it('records the user’s own edits and undoes them', () => {
    const ed = makeEditor()

    ed.commands.insertContent(' typed by the user')
    expect(undoDepth(ed.state)).toBeGreaterThan(0)

    ed.commands.undo()
    expect(ed.getText()).toBe('start')
  })

  it('undoes past an external write to reach the user’s previous edit', () => {
    // History-free writes must not sever the chain: after the AI writes, undo
    // should still walk back to what the user last typed.
    const ed = makeEditor()

    ed.commands.setTextSelection(ed.state.doc.content.size)
    ed.commands.insertContent(' user text')
    const afterTyping = ed.getText()

    setContentWithoutHistory(ed, doc('AI-written summary'))
    expect(ed.getText()).toBe('AI-written summary')

    ed.commands.undo()
    expect(ed.getText()).not.toBe(afterTyping)
    expect(undoDepth(ed.state)).toBe(0)
  })

  it('caps retained history at UNDO_DEPTH events', () => {
    const ed = makeEditor()

    // Separate events: each insert is its own undo step (the 500ms merge
    // window is wall-clock, and these run far apart in ProseMirror's terms
    // because each carries an explicit new-group meta).
    for (let i = 0; i < UNDO_DEPTH + 20; i++) {
      ed.chain().setMeta('addToHistory', true).insertContent(`${i} `).run()
    }

    expect(undoDepth(ed.state)).toBeLessThanOrEqual(UNDO_DEPTH)
  })
})
