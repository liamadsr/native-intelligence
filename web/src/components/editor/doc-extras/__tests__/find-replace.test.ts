// @vitest-environment jsdom
/**
 * Find and replace (../find-replace.ts), on a real TipTap editor:
 *  - plain, match-case, whole-word and regex searches; a bad regex is an
 *    error, not a throw; matches never cross a block or an inline atom;
 *  - next / previous wrap; replace one moves on; replace all is one undo step;
 *    `$1` fills in a group in regex mode only;
 *  - matches follow edits (typing, someone else's setContent);
 *  - a read-only editor finds but never replaces; ⌘⇧F calls onOpen with the
 *    selected text; the search itself never changes the document;
 *  - the active match opens a fold that hides it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { undo, undoDepth } from '@tiptap/pm/history'
import { MathExtensions } from '../math'
import { FindReplace, buildPattern, clearSearch, expandReplacement, getFindState, replaceActive, replaceAll, setSearch, stepMatch } from '../find-replace'
import { HeadingFold, isFolded, toggleFold } from '../heading-fold'

const p = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content })
const t = (text: string): JSONContent => ({ type: 'text', text })

let editors: Editor[] = []
afterEach(() => {
  for (const e of editors) e.destroy()
  editors = []
  document.body.innerHTML = ''
})

function make(content: JSONContent, opts: { editable?: boolean; onOpen?: (s: string) => void } = {}) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const editor = new Editor({
    element: el,
    editable: opts.editable ?? true,
    extensions: [StarterKit, ...MathExtensions, HeadingFold.configure({ storageKey: null }), FindReplace.configure({ onOpen: opts.onOpen ?? null })],
    content,
  })
  editors.push(editor)
  return editor
}

const text = (e: Editor) => e.state.doc.textBetween(0, e.state.doc.content.size, '\n', '¤')
const found = (e: Editor) => getFindState(e.state).matches.map((m) => e.state.doc.textBetween(m.from, m.to))

const DOC: JSONContent = {
  type: 'doc',
  content: [p(t('The cat sat. A Cat, a category, a cat.')), p(t('cat')), p(t('price 10 and 20'))],
}

describe('searching', () => {
  it('finds case-insensitively by default, and narrows with match case and whole word', () => {
    const e = make(DOC)
    setSearch(e.view, { query: 'cat' })
    expect(found(e)).toEqual(['cat', 'Cat', 'cat', 'cat', 'cat'])
    setSearch(e.view, { caseSensitive: true })
    expect(found(e)).toEqual(['cat', 'cat', 'cat', 'cat'])
    setSearch(e.view, { caseSensitive: false, wholeWord: true })
    expect(found(e)).toEqual(['cat', 'Cat', 'cat', 'cat'])
  })

  it('searches by regular expression, and calls a bad one an error', () => {
    const e = make(DOC)
    setSearch(e.view, { query: '\\d+', regex: true })
    expect(found(e)).toEqual(['10', '20'])
    setSearch(e.view, { query: '(' })
    expect(getFindState(e.state).error).toBeTruthy()
    expect(getFindState(e.state).matches).toEqual([])
    // Without regex, the same text is literal.
    setSearch(e.view, { regex: false, query: 'c.t' })
    expect(found(e)).toEqual([])
    setSearch(e.view, { regex: true })
    expect(found(e)).toHaveLength(5)
    expect(buildPattern('', { caseSensitive: false, wholeWord: false, regex: false }).re).toBeNull()
  })

  it('never matches across a block or an inline atom', () => {
    const e = make({ type: 'doc', content: [p(t('ab')), p(t('cd')), p(t('x'), { type: 'mathInline', attrs: { latex: 'y' } }, t('z'))] })
    setSearch(e.view, { query: 'bc' })
    expect(found(e)).toEqual([])
    setSearch(e.view, { query: 'x.z', regex: true })
    expect(found(e)).toEqual([])
    setSearch(e.view, { query: 'z', regex: false })
    expect(found(e)).toEqual(['z'])
  })

  it('steps forward and back, wrapping round', () => {
    const e = make(DOC)
    e.commands.setTextSelection(1)
    setSearch(e.view, { query: 'cat' })
    expect(getFindState(e.state).active).toBe(0)
    stepMatch(e.view, -1)
    expect(getFindState(e.state).active).toBe(4)
    stepMatch(e.view, 1)
    expect(getFindState(e.state).active).toBe(0)
  })

  it('follows edits: typing and a replaced document', () => {
    const e = make(DOC)
    setSearch(e.view, { query: 'cat', wholeWord: true })
    e.commands.insertContentAt(1, 'cat ')
    expect(found(e)).toHaveLength(5)
    e.commands.setContent({ type: 'doc', content: [p(t('no felines here'))] })
    expect(found(e)).toEqual([])
    e.commands.setContent({ type: 'doc', content: [p(t('cat cat'))] })
    expect(found(e)).toEqual(['cat', 'cat'])
  })

  it('never changes the document or the history', () => {
    const e = make(DOC)
    const before = JSON.stringify(e.getJSON())
    setSearch(e.view, { query: 'cat' })
    stepMatch(e.view, 1)
    clearSearch(e.view)
    expect(JSON.stringify(e.getJSON())).toBe(before)
    expect(undoDepth(e.state)).toBe(0)
    expect(getFindState(e.state).query).toBe('')
  })
})

describe('replacing', () => {
  it('replaces the active match and moves to the next', () => {
    const e = make(DOC)
    e.commands.setTextSelection(1)
    setSearch(e.view, { query: 'cat', wholeWord: true })
    expect(replaceActive(e.view, 'dog')).toBe(true)
    expect(text(e).startsWith('The dog sat. A Cat')).toBe(true)
    expect(found(e)).toEqual(['Cat', 'cat', 'cat'])
    expect(getFindState(e.state).active).toBe(0)
  })

  it('replaces all in one undo step', () => {
    const e = make(DOC)
    setSearch(e.view, { query: 'cat', wholeWord: true })
    expect(replaceAll(e.view, 'dog')).toBe(4)
    expect(text(e)).toBe('The dog sat. A dog, a category, a dog.\ndog\nprice 10 and 20')
    undo(e.state, e.view.dispatch)
    expect(text(e)).toBe('The cat sat. A Cat, a category, a cat.\ncat\nprice 10 and 20')
  })

  it('fills in groups in regex mode only, and an empty replacement deletes', () => {
    const e = make(DOC)
    setSearch(e.view, { query: '(\\d+) and (\\d+)', regex: true })
    replaceAll(e.view, '$2–$1 ($$)')
    expect(text(e).endsWith('price 20–10 ($)')).toBe(true)
    const m = { from: 0, to: 1, groups: ['ab', 'a'] }
    expect(expandReplacement('$1!', m, false)).toBe('$1!')
    expect(expandReplacement('$1$&$9', m, true)).toBe('aab$9')
    setSearch(e.view, { query: 'price ', regex: false })
    replaceAll(e.view, '')
    expect(text(e).endsWith('\n20–10 ($)')).toBe(true)
  })

  it('a read-only editor finds but does not replace', () => {
    const e = make(DOC, { editable: false })
    setSearch(e.view, { query: 'cat' })
    expect(found(e)).toHaveLength(5)
    expect(replaceActive(e.view, 'dog')).toBe(false)
    expect(replaceAll(e.view, 'dog')).toBe(0)
    expect(text(e).includes('dog')).toBe(false)
  })
})

describe('the extension', () => {
  it('⌘⇧F calls onOpen with the selected text', () => {
    const onOpen = vi.fn()
    const e = make(DOC, { onOpen })
    e.commands.setTextSelection({ from: 5, to: 8 })
    const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })
    e.view.someProp('handleKeyDown', (f) => f(e.view, event))
    expect(onOpen).toHaveBeenCalledWith('cat')
  })

  it('opens the fold that hides the active match', () => {
    const e = make({
      type: 'doc',
      content: [{ type: 'heading', attrs: { level: 2 }, content: [t('Notes')] }, p(t('hidden needle'))],
    })
    toggleFold(e.view, 'Notes#0')
    expect(isFolded(e.state, 'Notes#0')).toBe(true)
    setSearch(e.view, { query: 'needle' })
    expect(isFolded(e.state, 'Notes#0')).toBe(false)
  })
})
