// @vitest-environment jsdom
/**
 * The editor's record mentions (../record-mention.ts), on a real TipTap editor:
 *  - a mention in the markdown loads as the chip (an inline atom drawn
 *    `@label`, its kind and id on it) and saves as the same markdown;
 *  - `@` typed at the start of a word opens the picker's store with what's
 *    typed after it; a pick puts the chip (and a space) where `@query` was;
 *    Esc closes it; a sentence after an `@`, or one in code, is no mention;
 *  - a click on a chip opens what it names.
 * Names and ids are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { jsonContentToMarkdown, markdownToJSONContent } from '@/app/account/(dashboard)/views/markdown-conversion'

const opened = vi.hoisted(() => [] as Array<{ type: string; id: string }>)
vi.mock('@/lib/entity-links/open-mention', () => ({
  openMention: async (ref: { type: string; id: string }) => {
    opened.push({ type: ref.type, id: ref.id })
    return true
  },
}))

import {
  RecordMention,
  RecordMentionSuggestion,
  createMentionSuggestionStore,
  isMentionQuery,
  type MentionSuggestionStore,
} from '../record-mention'

const MAYA = '6f1c0000-0000-4000-8000-000000000001'
const DEAL = 'de000000-0000-4000-8000-000000000001'

let editor: Editor
let store: MentionSuggestionStore

function make(markdown: string) {
  store = createMentionSuggestionStore()
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor = new Editor({
    element: el,
    extensions: [StarterKit, RecordMention, RecordMentionSuggestion.configure({ store })],
    content: markdownToJSONContent(markdown),
  })
}

beforeEach(() => {
  opened.length = 0
})
afterEach(() => {
  editor?.destroy()
  document.body.innerHTML = ''
})

/** Type at the end of the doc, as the keyboard would (one transaction per call). */
async function type(text: string) {
  editor.commands.focus('end')
  editor.commands.insertContent(text)
  // The suggestion plugin tells its renderer after a microtask (it awaits its items).
  await new Promise((r) => setTimeout(r, 0))
}

describe('RecordMention', () => {
  it('loads a mention as its chip and saves it back as the same markdown', () => {
    const md = `Ask [@Maya Chen](mention://contact/${MAYA}) today`
    make(md)
    const chip = editor.view.dom.querySelector('span[data-record-mention]')
    expect(chip?.getAttribute('data-record-mention')).toBe('contact')
    expect(chip?.getAttribute('data-mention-id')).toBe(MAYA)
    expect(chip?.textContent).toBe('@Maya Chen')
    expect(jsonContentToMarkdown(editor.getJSON())).toBe(md)
  })

  it('a click on the chip opens what it names', () => {
    make(`See [@Renewal](mention://deal/${DEAL})`)
    let chipPos = -1
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'recordMention') chipPos = pos
    })
    const node = editor.state.doc.nodeAt(chipPos)!
    const handled = editor.view.someProp('handleClickOn', (f) =>
      f(editor.view, chipPos + 1, node, chipPos, new MouseEvent('click'), true),
    )
    expect(handled).toBe(true)
    expect(opened).toEqual([{ type: 'deal', id: DEAL }])
  })
})

describe('RecordMentionSuggestion', () => {
  it('`@` opens the picker with what is typed after it, and a pick puts the chip there', async () => {
    make('Talk to')
    await type(' @ma')
    expect(store.get()?.query).toBe('ma')
    await type('ya')
    expect(store.get()?.query).toBe('maya')
    store.get()!.pick({ type: 'contact', id: MAYA, label: 'Maya Chen' })
    expect(store.get()).toBeNull()
    expect(jsonContentToMarkdown(editor.getJSON())).toBe(`Talk to [@Maya Chen](mention://contact/${MAYA}) `)
  })

  it('Esc closes it', async () => {
    make('Hi')
    await type(' @ma')
    expect(store.get()).not.toBeNull()
    store.dismiss()
    expect(store.get()).toBeNull()
  })

  it('an @ inside a word, a sentence after an @, or one in code is no mention', async () => {
    make('mail')
    await type('@ma')
    expect(store.get()).toBeNull()
    expect(isMentionQuery('maya chen')).toBe(true)
    expect(isMentionQuery('this is a whole sentence now')).toBe(false)
    expect(isMentionQuery(' leading')).toBe(false)
    editor.destroy()
    make('')
    editor.commands.setContent({ type: 'doc', content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'x' }] }] })
    await type(' @ma')
    expect(store.get()).toBeNull()
  })
})
