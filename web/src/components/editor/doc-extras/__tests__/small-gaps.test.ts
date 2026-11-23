// @vitest-environment jsdom
/**
 * The small gaps (docs/plans/doc-editor-extras.md, phase 6):
 *  - word and character counts (../word-count.tsx);
 *  - `:shortcode:` emoji (../emoji-shortcodes.ts): only for a known name, only
 *    at the start of a word, never in code;
 *  - highlighted code blocks (../code-block.ts): highlighted, a language
 *    picker that sets the fence language, a reader sees a label; markdown
 *    unchanged.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Editor, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { jsonContentToMarkdown, markdownToJSONContent } from '@/app/account/(dashboard)/views/markdown-conversion'
import { countText } from '../word-count'
import { EmojiShortcodes, __setEmojiTableForTests, buildEmojiTable, emojiFor } from '../emoji-shortcodes'
import { CODE_LANGUAGES, highlightedCodeBlock, languageLabel } from '../code-block'

let editors: Editor[] = []
afterEach(() => {
  for (const e of editors) e.destroy()
  editors = []
  document.body.innerHTML = ''
})

function make(content: JSONContent | string, opts: { editable?: boolean; code?: boolean } = {}) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const editor = new Editor({
    element: el,
    editable: opts.editable ?? true,
    extensions: opts.code
      ? [StarterKit.configure({ codeBlock: false }), highlightedCodeBlock({ preClass: 'code-pre' })]
      : [StarterKit, EmojiShortcodes],
    content: typeof content === 'string' ? markdownToJSONContent(content) : content,
  })
  editors.push(editor)
  return editor
}

function type(e: Editor, text: string) {
  for (const ch of text) {
    const { from, to } = e.state.selection
    const handled = e.view.someProp('handleTextInput', (f) => f(e.view, from, to, ch, () => e.state.tr.insertText(ch, from, to)))
    if (!handled) e.view.dispatch(e.state.tr.insertText(ch, from, to))
  }
}

describe('countText', () => {
  it('counts words and characters', () => {
    expect(countText('')).toEqual({ words: 0, characters: 0 })
    expect(countText("It's a well-known test, v2.1 — done.")).toEqual({ words: 6, characters: 36 })
    expect(countText('one\ntwo')).toEqual({ words: 2, characters: 6 })
    // Each CJK character is a word; emoji count as characters, not words.
    expect(countText('日本語 and 🎉')).toEqual({ words: 4, characters: 9 })
  })
})

describe('emoji shortcodes', () => {
  beforeAll(() => {
    __setEmojiTableForTests(buildEmojiTable({ emojis: { tada: { skins: [{ native: '🎉' }] }, '+1': { skins: [{ native: '👍' }] } }, aliases: { thumbsup: '+1' } }))
  })

  it('builds the table with aliases', () => {
    expect(emojiFor('tada')).toBe('🎉')
    expect(emojiFor('THUMBSUP')).toBe('👍')
    expect(emojiFor('nope')).toBeNull()
  })

  it('turns a typed :name: into its emoji, and leaves other colons alone', () => {
    const e = make('')
    type(e, 'Shipped :tada: and :+1: but not :nope: or 10:30:00')
    expect(e.state.doc.textContent).toBe('Shipped 🎉 and 👍 but not :nope: or 10:30:00')
  })

  it('never inside code', () => {
    const e = make({ type: 'doc', content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'x' }] }] })
    e.commands.setTextSelection(2)
    type(e, ' :tada:')
    expect(e.state.doc.textContent).toBe('x :tada:')
  })
})

describe('highlighted code blocks', () => {
  const MD = '```ts\nconst x: number = 1\n```'

  it('highlights, keeps the fence language and round-trips', () => {
    const e = make(MD, { code: true })
    const pre = e.view.dom.querySelector('pre')!
    expect(pre.className).toBe('code-pre')
    expect(pre.querySelector('code')?.className).toBe('language-ts')
    expect(pre.querySelector('.hljs-keyword')?.textContent).toBe('const')
    expect(jsonContentToMarkdown(e.getJSON())).toBe(MD)
  })

  it('the picker sets the language; an alias it doesn’t list is kept as written', () => {
    const e = make(MD, { code: true })
    const select = e.view.dom.querySelector<HTMLSelectElement>('select.ni-code-language')!
    expect(select.value).toBe('ts')
    expect([...select.options].map((o) => o.value)).toContain('python')
    select.value = 'python'
    select.dispatchEvent(new Event('change'))
    expect(jsonContentToMarkdown(e.getJSON())).toBe('```python\nconst x: number = 1\n```')
    select.value = ''
    select.dispatchEvent(new Event('change'))
    expect(jsonContentToMarkdown(e.getJSON())).toBe('```\nconst x: number = 1\n```')
  })

  it('a reader sees the language, not a picker', () => {
    const e = make('```python\nprint(1)\n```', { code: true, editable: false })
    expect(e.view.dom.querySelector('select')).toBeNull()
    expect(e.view.dom.querySelector('.ni-code-language')?.textContent).toBe('Python')
  })

  it('names its languages', () => {
    expect(CODE_LANGUAGES).toContain('typescript')
    expect(CODE_LANGUAGES).not.toContain('plaintext')
    expect(languageLabel('cpp')).toBe('C++')
    expect(languageLabel(null)).toBe('Auto')
  })
})
