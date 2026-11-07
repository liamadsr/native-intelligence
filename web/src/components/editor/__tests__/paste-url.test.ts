// @vitest-environment jsdom
/**
 * Pasting a URL on its own (../paste-url, NoteEditor's handlePaste): a card on
 * an empty line, the selected text linked when there is a selection, and a
 * link where it was pasted anywhere else (it used to land at the END of the
 * document as a card). A code block keeps the editor's own paste.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Editor, Node } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import { pasteUrlTransaction } from '../paste-url'

/** The card's schema (link-preview-extension.tsx), without its React view. */
const LinkPreviewStub = Node.create({
  name: 'linkPreview',
  group: 'block',
  atom: true,
  addAttributes: () => ({ url: { default: null } }),
  parseHTML: () => [{ tag: 'div[data-link-preview]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', { 'data-link-preview': '', ...HTMLAttributes }],
})

let editor: Editor | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
})

function mount(content: string) {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit, Link, LinkPreviewStub],
    content,
  })
  return editor
}

function paste(e: Editor, url: string) {
  const tr = pasteUrlTransaction(e.state, url)
  if (tr) e.view.dispatch(tr)
  return tr
}

const URL = 'https://partiful.com/e/abc'

/** Position just after the first occurrence of `text`. */
function after(e: Editor, text: string): number {
  let at = -1
  e.state.doc.descendants((node, pos) => {
    if (at >= 0 || !node.isText) return
    const i = node.text!.indexOf(text)
    if (i >= 0) at = pos + i + text.length
  })
  return at
}

describe('pasteUrlTransaction', () => {
  it('on an empty line: a card, then a fresh line with the cursor in it', () => {
    const e = mount('<p>Intro</p><p></p>')
    e.commands.setTextSelection(e.state.doc.content.size - 1)
    paste(e, URL)
    expect(e.getJSON().content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'Intro' }] },
      { type: 'linkPreview', attrs: { url: URL } },
      { type: 'paragraph' },
    ])
    expect(e.state.selection.$from.parent.type.name).toBe('paragraph')
    expect(e.state.selection.$from.parent.textContent).toBe('')
  })

  it('mid-line: a link where it was pasted, not a card at the end', () => {
    // (HTML parsing drops a paragraph's trailing space: text follows the spot.)
    const e = mount('<p>Register: today</p><p>Later paragraph</p>')
    e.commands.setTextSelection(after(e, 'Register: '))
    paste(e, URL)
    const json = e.getJSON()
    expect(json.content).toHaveLength(2)
    expect(json.content![0]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Register: ' },
        {
          type: 'text',
          text: URL,
          marks: [{ type: 'link', attrs: expect.objectContaining({ href: URL }) }],
        },
        { type: 'text', text: 'today' },
      ],
    })
    expect(json.content![1]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'Later paragraph' }] })
  })

  it('mid-line: what is typed next is not part of the link', () => {
    const e = mount('<p>See it</p>')
    e.commands.setTextSelection(after(e, 'See '))
    paste(e, URL)
    // As typing does: tr.insertText takes the stored marks (a link is inclusive,
    // so without the paste clearing it the typing would extend the link).
    e.view.dispatch(e.state.tr.insertText(' now '))
    expect(e.getJSON().content![0].content).toEqual([
      { type: 'text', text: 'See ' },
      { type: 'text', text: URL, marks: [{ type: 'link', attrs: expect.objectContaining({ href: URL }) }] },
      { type: 'text', text: ' now it' },
    ])
  })

  it('over selected text: that text becomes the link', () => {
    const e = mount('<p>Sign up here today</p>')
    const end = after(e, 'Sign up here')
    e.commands.setTextSelection({ from: end - 'here'.length, to: end })
    paste(e, URL)
    expect(e.getJSON().content![0].content).toEqual([
      { type: 'text', text: 'Sign up ' },
      { type: 'text', text: 'here', marks: [{ type: 'link', attrs: expect.objectContaining({ href: URL }) }] },
      { type: 'text', text: ' today' },
    ])
  })

  it('in a code block: left to the editor', () => {
    const e = mount('<pre><code>curl </code></pre>')
    e.commands.setTextSelection(after(e, 'curl '))
    expect(paste(e, URL)).toBeNull()
  })
})
