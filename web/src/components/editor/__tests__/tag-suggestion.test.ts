// @vitest-environment jsdom
/**
 * Tags in the editor (../tag-suggestion.ts) on a real TipTap editor:
 *  - a tag link in the markdown loads as a pill and saves back the same;
 *  - `#` at a word start opens the menu's store; a pick lands the pill and tells onPick;
 *  - never mid-word, in a URL, in code, or for a `# ` heading;
 *  - a pill paints in its tag's color and a click asks to list the tag.
 * Ids are made up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { jsonContentToMarkdown, markdownToJSONContent, TAG_NODE } from '@/app/account/(dashboard)/views/markdown-conversion'
import { TagPill, TagSuggestion, TAG_OPEN_EVENT, createTagSuggestionStore, type TagSuggestionStore } from '../tag-suggestion'
import { tagColorStore } from '@/lib/tags/color-store'

const T = '7a000000-0000-4000-8000-000000000001'

let editor: Editor
let store: TagSuggestionStore
const picks: string[] = []

function make(markdown: string) {
  store = createTagSuggestionStore()
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor = new Editor({
    element: el,
    extensions: [StarterKit, TagPill, TagSuggestion.configure({ store, onPick: (t) => picks.push(t.id) })],
    content: markdownToJSONContent(markdown),
  })
}

afterEach(() => {
  editor?.destroy()
  document.body.innerHTML = ''
  picks.length = 0
  tagColorStore.reset()
})

async function type(text: string) {
  editor.commands.focus('end')
  editor.commands.insertContent(text)
  await new Promise((r) => setTimeout(r, 0))
}

describe('TagPill', () => {
  it('loads a tag link as a pill in its color and saves it back', () => {
    tagColorStore.put([{ id: T, color: '#22c55e' }])
    const md = `Ship [#Renewal](tag://${T}) now`
    make(md)
    const pill = editor.view.dom.querySelector<HTMLElement>('span[data-tag-id]')
    expect(pill?.textContent).toBe('#Renewal')
    expect(pill?.style.getPropertyValue('--tag-color')).toBe('#22c55e')
    tagColorStore.put([{ id: T, color: '#ef4444' }])
    expect(pill?.style.getPropertyValue('--tag-color')).toBe('#ef4444')
    expect(jsonContentToMarkdown(editor.getJSON())).toBe(md)
  })

  it('a click asks the app to list the tag', () => {
    make(`See [#Renewal](tag://${T})`)
    const heard: unknown[] = []
    const on = (e: Event) => heard.push((e as CustomEvent).detail)
    window.addEventListener(TAG_OPEN_EVENT, on)
    let pos = -1
    editor.state.doc.descendants((n, p) => {
      if (n.type.name === TAG_NODE) pos = p
    })
    const node = editor.state.doc.nodeAt(pos)!
    const handled = editor.view.someProp('handleClickOn', (f) => f(editor.view, pos + 1, node, pos, new MouseEvent('click'), true))
    window.removeEventListener(TAG_OPEN_EVENT, on)
    expect(handled).toBe(true)
    expect(heard).toEqual([{ id: T, name: 'Renewal' }])
  })
})

describe('TagSuggestion', () => {
  it('`#` at a word start opens the menu; a pick lands the pill and tells onPick', async () => {
    make('Ship it')
    await type(' #ren')
    expect(store.get()?.query).toBe('ren')
    store.get()!.pick({ id: T, name: 'Renewal', color: '#22c55e' })
    expect(store.get()).toBeNull()
    expect(picks).toEqual([T])
    expect(jsonContentToMarkdown(editor.getJSON())).toBe(`Ship it [#Renewal](tag://${T}) `)
  })

  it('opens at the start of an empty paragraph', async () => {
    make('')
    await type('#q')
    expect(store.get()?.query).toBe('q')
  })

  it('never mid-word, in a URL, in code, or after a space (a heading)', async () => {
    make('C')
    await type('#x')
    expect(store.get()).toBeNull()
    editor.destroy()
    make('see example.com/')
    await type('#top')
    expect(store.get()).toBeNull()
    editor.destroy()
    make('')
    editor.commands.setContent({ type: 'doc', content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'x ' }] }] })
    await type('#y')
    expect(store.get()).toBeNull()
    editor.destroy()
    make('')
    await type('# ')
    expect(store.get()).toBeNull()
  })
})
