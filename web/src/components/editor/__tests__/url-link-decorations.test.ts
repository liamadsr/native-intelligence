// @vitest-environment jsdom
/**
 * Links in the editor (../url-link-decorations), on a real TipTap editor:
 *  - each bare URL in loaded text is drawn as an <a href target=_blank>, the
 *    same element a link mark renders; text already in a link, inline code and
 *    code blocks are left alone; it follows edits; and none of it reaches the
 *    document (the saved markdown, undo history);
 *  - a click on a link while editing (drawn or a link mark) opens it by the
 *    link router's rules — the in-app browser (⌘ behind), ⇧ the user's browser
 *    with noopener — and takes the click whole, so nothing else opens it too;
 *    a read-only editor leaves its links to the browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import { undoDepth } from '@tiptap/pm/history'
import { EDITOR_LINK_CLASS, URL_LINK_ATTR, UrlLinkDecorations } from '../url-link-decorations'

let editor: Editor | null = null
let windowOpen: MockInstance<typeof window.open>

beforeEach(() => {
  windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null)
})

afterEach(() => {
  editor?.destroy()
  editor = null
  windowOpen.mockRestore()
})

function mount(content: string, editable = true) {
  editor = new Editor({
    element: document.createElement('div'),
    // As note-editor.tsx configures it: clicks are UrlLinkDecorations'.
    extensions: [StarterKit, Link.configure({ openOnClick: false }), UrlLinkDecorations],
    content,
    editable,
  })
  return editor
}

const decorated = (e: Editor) =>
  Array.from(e.view.dom.querySelectorAll<HTMLAnchorElement>(`a[${URL_LINK_ATTR}]`)).map((a) => ({
    href: a.getAttribute('href'),
    text: a.textContent,
    target: a.getAttribute('target'),
    rel: a.getAttribute('rel'),
  }))

describe('UrlLinkDecorations', () => {
  it('draws a bare URL in loaded text as a link, leaving the sentence punctuation out', () => {
    const e = mount('<ul><li><p>Register: https://partiful.com/e/DRRSAxuu7tPWpRYixIgb.</p></li></ul>')
    expect(decorated(e)).toEqual([
      {
        href: 'https://partiful.com/e/DRRSAxuu7tPWpRYixIgb',
        text: 'https://partiful.com/e/DRRSAxuu7tPWpRYixIgb',
        target: '_blank',
        rel: 'noopener noreferrer nofollow',
      },
    ])
    const a = e.view.dom.querySelector(`a[${URL_LINK_ATTR}]`)!
    expect(a.className).toBe(EDITOR_LINK_CLASS)
  })

  it('finds every URL, in every block', () => {
    const e = mount('<p>a https://a.com and http://b.org/x</p><h2>see https://c.net</h2>')
    expect(decorated(e).map((d) => d.href)).toEqual(['https://a.com', 'http://b.org/x', 'https://c.net'])
  })

  it('leaves links, inline code and code blocks alone', () => {
    const e = mount(
      '<p><a href="https://a.com">https://a.com</a></p>' +
        '<p><code>https://code.example/x</code></p>' +
        '<pre><code>curl https://block.example/y</code></pre>',
    )
    expect(decorated(e)).toEqual([])
    // The link mark still renders its own anchor.
    expect(e.view.dom.querySelectorAll('a[href="https://a.com"]')).toHaveLength(1)
  })

  it('follows edits: a typed URL is drawn, a deleted one goes', () => {
    const e = mount('<p>start</p>')
    e.commands.setTextSelection(e.state.doc.content.size - 1)
    e.commands.insertContent(' https://typed.example/path')
    expect(decorated(e).map((d) => d.href)).toEqual(['https://typed.example/path'])
    e.commands.setContent('<p>no links now</p>')
    expect(decorated(e)).toEqual([])
  })

  it('works read-only too', () => {
    const e = mount('<p>Register: https://partiful.com/e/abc</p>', false)
    expect(decorated(e).map((d) => d.href)).toEqual(['https://partiful.com/e/abc'])
  })

  it('never changes the document', () => {
    const e = mount('<p>Register: https://partiful.com/e/abc</p>')
    expect(e.getJSON()).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Register: https://partiful.com/e/abc' }] }],
    })
    expect(undoDepth(e.state)).toBe(0)
  })
})

function click(el: Element, init: MouseEventInit = {}) {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init })
  el.dispatchEvent(e)
  return e
}

describe('clicking a link in the editor', () => {
  const opened = (url: string) => vi.waitFor(() => expect(windowOpen).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer'))

  it('a drawn URL opens in the user’s browser, and the click is taken whole', async () => {
    const e = mount('<p>Register: https://partiful.com/e/abc</p>')
    const a = e.view.dom.querySelector(`a[${URL_LINK_ATTR}]`) as HTMLAnchorElement
    let targetDuringClick: string | null = null
    e.view.dom.parentElement!.addEventListener('click', () => {
      targetDuringClick = a.target
    })
    const ev = click(a)
    await opened('https://partiful.com/e/abc')
    expect(ev.defaultPrevented).toBe(true)
    // Hidden from the desktop shell's script on <body> for this click only.
    expect(targetDuringClick).toBe('')
    expect(a.getAttribute('target')).toBe('_blank')
  })

  it('a link mark opens the same way, with or without a modifier', async () => {
    const e = mount('<p><a href="https://x.com/a">the site</a> https://x.com/b</p>')
    click(e.view.dom.querySelector('a[href="https://x.com/a"]')!)
    await opened('https://x.com/a')
    click(e.view.dom.querySelector('a[href="https://x.com/b"]')!, { metaKey: true })
    await opened('https://x.com/b')
  })

  it('a click off any link is left alone', () => {
    const e = mount('<p>plain text https://x.com/a</p>')
    const ev = click(e.view.dom.querySelector('p')!)
    expect(ev.defaultPrevented).toBe(false)
    expect(windowOpen).not.toHaveBeenCalled()
  })

  it('read-only: the browser keeps the click', () => {
    const e = mount('<p>https://x.com/a</p>', false)
    const ev = click(e.view.dom.querySelector('a')!)
    expect(ev.defaultPrevented).toBe(false)
    expect(windowOpen).not.toHaveBeenCalled()
  })
})
