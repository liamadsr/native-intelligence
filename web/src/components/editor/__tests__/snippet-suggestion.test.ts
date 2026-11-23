// @vitest-environment jsdom
/**
 * `;` snippets in the editor (../snippet-suggestion.ts), on a real TipTap editor:
 *  - `;` at a word's start opens the store with what's typed after it; a pick
 *    puts the body (markdown, as nodes) where `;query` was;
 *  - it doesn't open mid-word, in code, in a link, or with no snippets;
 *  - a body is fitted to the editor: a heading in an editor with none (mail)
 *    becomes a paragraph; a one-paragraph body goes in inline.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor, getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import { jsonContentToMarkdown, markdownToJSONContent } from '@/app/account/(dashboard)/views/markdown-conversion'

const snippets = vi.hoisted(() => ({ list: [{ id: 's1' }] as unknown[] }))
vi.mock('@/components/snippets/use-snippets', () => ({
  currentSnippets: () => snippets.list,
  ensureSnippets: () => {},
}))

import { SnippetSuggestion, createSnippetSuggestionStore, snippetContent, type SnippetSuggestionStore } from '../snippet-suggestion'

let editor: Editor
let store: SnippetSuggestionStore

function make(markdown: string, extensions: unknown[] = [StarterKit]) {
  store = createSnippetSuggestionStore()
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor = new Editor({
    element: el,
    extensions: [...(extensions as never[]), SnippetSuggestion.configure({ store })],
    content: markdownToJSONContent(markdown),
  })
}

afterEach(() => {
  editor?.destroy()
  document.body.innerHTML = ''
  snippets.list = [{ id: 's1' }]
})

async function type(text: string) {
  editor.commands.focus('end')
  editor.commands.insertContent(text)
  await new Promise((r) => setTimeout(r, 0))
}

describe('SnippetSuggestion', () => {
  it('opens on `;` at a word start, follows the query, and a pick puts the body there', async () => {
    make('Thanks')
    await type(' ;si')
    expect(store.get()?.query).toBe('si')
    await type('g')
    expect(store.get()?.query).toBe('sig')
    store.get()!.pick('Best,\n\n**Maya**')
    expect(store.get()).toBeNull()
    expect(editor.getJSON().content?.map((p) => p.content?.map((t) => t.text).join(''))).toEqual(['Thanks Best,', 'Maya'])
  })

  it('what followed the caret carries on after the last paragraph', async () => {
    make('Dear all')
    editor.commands.focus('end')
    editor.commands.insertContent(' ;x')
    // The caret back before " and more": typed into the middle of a line.
    editor.commands.insertContent(' and more')
    editor.commands.setTextSelection(editor.state.doc.content.size - 1 - ' and more'.length)
    await new Promise((r) => setTimeout(r, 0))
    store.get()!.pick('One\n\nTwo')
    expect(editor.getJSON().content?.map((p) => p.content?.map((t) => t.text).join(''))).toEqual(['Dear all One', 'Two and more'])
  })

  it('a one-paragraph body goes in inline, at the caret', async () => {
    make('Hello')
    await type(' ;x')
    store.get()!.pick('*world*')
    expect(jsonContentToMarkdown(editor.getJSON())).toBe('Hello _world_')
  })

  it('opens on a bare `;` at the start', async () => {
    make('')
    await type(';')
    expect(store.get()?.query).toBe('')
  })

  it('does not open mid-word, after punctuation, or with no snippets', async () => {
    make('word')
    await type(';x')
    expect(store.get()).toBeNull()
    editor.destroy()
    make('a,')
    await type(';x')
    expect(store.get()).toBeNull()
    editor.destroy()
    snippets.list = []
    make('Hi')
    await type(' ;x')
    expect(store.get()).toBeNull()
  })

  it('does not open in code or a link', async () => {
    make('')
    editor.commands.setContent({ type: 'doc', content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'x' }] }] })
    await type(' ;x')
    expect(store.get()).toBeNull()
    editor.destroy()
    make('', [StarterKit])
    editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a ', marks: [] }, { type: 'text', text: '`', marks: [] }] }] })
    editor.commands.focus('end')
    editor.chain().setMark('code').insertContent(' ;x').run()
    await new Promise((r) => setTimeout(r, 0))
    expect(store.get()).toBeNull()
    editor.destroy()
    make('', [StarterKit, Link])
    editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'see ;x', marks: [{ type: 'link', attrs: { href: 'https://a.example' } }] }] }] })
    editor.commands.focus('end')
    editor.commands.insertContent({ type: 'text', text: 'y', marks: [{ type: 'link', attrs: { href: 'https://a.example' } }] })
    await new Promise((r) => setTimeout(r, 0))
    expect(store.get()).toBeNull()
  })

  it('Esc closes it', async () => {
    make('Hi')
    await type(' ;x')
    store.dismiss()
    expect(store.get()).toBeNull()
  })
})

describe('snippetContent', () => {
  it('fits a body to an editor that has no headings or code blocks (mail)', () => {
    const schema = getSchema([StarterKit.configure({ heading: false, codeBlock: false, horizontalRule: false })])
    const content = snippetContent('## Next steps\n\n- one\n- two\n\n```\nnpm i\n```', schema)
    expect(content.map((n) => n.type)).toEqual(['paragraph', 'bulletList', 'paragraph'])
    expect(content[0].content?.[0]).toMatchObject({ type: 'text', text: 'Next steps' })
  })

  it('keeps what the editor holds', () => {
    const schema = getSchema([StarterKit])
    expect(snippetContent('# Title\n\nBody', schema).map((n) => n.type)).toEqual(['heading', 'paragraph'])
    expect(snippetContent('Just **one** line', schema).map((n) => n.type)).toEqual(['text', 'text', 'text'])
  })

  it('drops marks the editor has no room for', () => {
    const schema = getSchema([StarterKit.configure({ strike: false })])
    const content = snippetContent('~~gone~~ kept', schema)
    expect(content.every((n) => !n.marks?.some((m) => m.type === 'strike'))).toBe(true)
  })
})
