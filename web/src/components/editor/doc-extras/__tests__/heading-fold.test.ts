// @vitest-environment jsdom
/**
 * Folding a document's sections (../heading-fold.ts), on a real TipTap editor:
 *  - a fold hides the blocks under its heading up to the next heading of the
 *    same or a higher level, and draws an arrow on every heading;
 *  - ⌘↵ in a heading folds and unfolds it; elsewhere it is still a line break;
 *  - folds are remembered per document (localStorage) by heading text and
 *    occurrence, and come back on a new editor;
 *  - the caret landing inside a fold opens it; revealPos opens what hides a
 *    position;
 *  - folding never changes the document or its undo history.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Editor, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { undoDepth } from '@tiptap/pm/history'
import {
  HeadingFold,
  foldStorageKey,
  foldedSections,
  foldsHiding,
  isFolded,
  listHeadings,
  revealPos,
  toggleFold,
} from '../heading-fold'

const h = (level: number, text: string): JSONContent => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] })
const p = (text: string): JSONContent => ({ type: 'paragraph', content: [{ type: 'text', text }] })

const DOC: JSONContent = {
  type: 'doc',
  content: [h(1, 'Plan'), p('intro'), h(2, 'Goals'), p('ship'), h(3, 'Detail'), p('fine print'), h(2, 'Risks'), p('late'), h(2, 'Goals'), p('again')],
}

let editors: Editor[] = []
function make(storageKey: string | null = 'test:folds', content: JSONContent = DOC) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const editor = new Editor({ element: el, extensions: [StarterKit, HeadingFold.configure({ storageKey })], content })
  editors.push(editor)
  return editor
}

beforeEach(() => window.localStorage.clear())
afterEach(() => {
  for (const e of editors) e.destroy()
  editors = []
  document.body.innerHTML = ''
})

// A real keydown (the keyboardShortcut command keeps only a handler's steps, not its metadata).
function press(editor: Editor, key: string, mods: { ctrl?: boolean; meta?: boolean } = { ctrl: true }) {
  const event = new KeyboardEvent('keydown', { key, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, bubbles: true, cancelable: true })
  editor.view.someProp('handleKeyDown', (f) => f(editor.view, event))
}

function hiddenTexts(editor: Editor): string[] {
  return [...editor.view.dom.querySelectorAll('.ni-fold-hidden')].map((n) => n.textContent ?? '')
}

describe('listHeadings', () => {
  it('keys each top-level heading by its text and occurrence', () => {
    const editor = make(null)
    expect(listHeadings(editor.state.doc).map((x) => [x.key, x.level])).toEqual([
      ['Plan#0', 1],
      ['Goals#0', 2],
      ['Detail#0', 3],
      ['Risks#0', 2],
      ['Goals#1', 2],
    ])
  })
})

describe('foldedSections', () => {
  it('hides up to the next heading at the same level or above, and nothing inside a fold twice', () => {
    const editor = make(null)
    const doc = editor.state.doc
    const goals = foldedSections(doc, new Set(['Goals#0']))
    expect(goals).toHaveLength(1)
    expect(doc.textBetween(goals[0].from, goals[0].to, '|')).toBe('ship|Detail|fine print')
    // Plan (H1) hides everything after it; a fold inside it adds nothing.
    const plan = foldedSections(doc, new Set(['Plan#0', 'Detail#0']))
    expect(plan.map((s) => s.key)).toEqual(['Plan#0'])
    expect(plan[0].to).toBe(doc.content.size)
    expect(foldsHiding(doc, new Set(['Goals#0']), goals[0].from + 1)).toEqual(['Goals#0'])
  })
})

describe('the extension', () => {
  it('draws an arrow per heading, and a click on one folds that section', () => {
    const editor = make()
    const arrows = editor.view.dom.querySelectorAll('.ni-fold-toggle')
    expect(arrows).toHaveLength(5)
    arrows[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    expect(hiddenTexts(editor)).toEqual(['ship', 'Detail', 'fine print'])
    expect(editor.view.dom.querySelector('.ni-fold-toggle--folded')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('⌘↵ in a heading folds and unfolds it; in a paragraph it is a line break', () => {
    const editor = make()
    const goals = listHeadings(editor.state.doc)[1]
    editor.commands.setTextSelection(goals.pos + 2)
    press(editor, 'Enter')
    expect(isFolded(editor.state, 'Goals#0')).toBe(true)
    press(editor, 'Enter')
    expect(isFolded(editor.state, 'Goals#0')).toBe(false)

    const before = editor.getJSON()
    editor.commands.setTextSelection(2 + listHeadings(editor.state.doc)[0].pos + 'Plan'.length + 2)
    press(editor, 'Enter')
    expect(JSON.stringify(editor.getJSON())).toContain('hardBreak')
    expect(before).not.toEqual(editor.getJSON())
  })

  it('remembers folds per document and brings them back', () => {
    const one = make(foldStorageKey('doc-1'))
    toggleFold(one.view, 'Risks#0')
    expect(JSON.parse(window.localStorage.getItem('ni:doc-folds:doc-1') ?? '[]')).toEqual(['Risks#0'])
    const again = make(foldStorageKey('doc-1'))
    expect(isFolded(again.state, 'Risks#0')).toBe(true)
    expect(hiddenTexts(again)).toEqual(['late'])
    const other = make(foldStorageKey('doc-2'))
    expect(isFolded(other.state, 'Risks#0')).toBe(false)
    toggleFold(again.view, 'Risks#0')
    expect(window.localStorage.getItem('ni:doc-folds:doc-1')).toBeNull()
  })

  it('opens a fold when the caret lands in it, and revealPos opens what hides a position', () => {
    const editor = make()
    toggleFold(editor.view, 'Goals#0')
    const [section] = foldedSections(editor.state.doc, new Set(['Goals#0']))
    editor.commands.setTextSelection(section.from + 2)
    expect(isFolded(editor.state, 'Goals#0')).toBe(false)

    toggleFold(editor.view, 'Plan#0')
    expect(revealPos(editor.view, section.from + 2)).toBe(true)
    expect(isFolded(editor.state, 'Plan#0')).toBe(false)
    expect(revealPos(editor.view, section.from + 2)).toBe(false)
  })

  it('never changes the document or the undo history', () => {
    const editor = make()
    const before = JSON.stringify(editor.getJSON())
    let updates = 0
    editor.on('update', () => updates++)
    toggleFold(editor.view, 'Goals#0')
    toggleFold(editor.view, 'Plan#0')
    expect(JSON.stringify(editor.getJSON())).toBe(before)
    expect(updates).toBe(0)
    expect(undoDepth(editor.state)).toBe(0)
  })
})
