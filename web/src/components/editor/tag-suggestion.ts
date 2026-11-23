/**
 * TAGS IN THE EDITOR: `#` typed at the start of a word opens the tag menu; a
 * pick puts a colored pill in the text (docs/plans/tags.md, phase 2).
 *
 *  • TagPill: the pill, an inline atom node ({ id, name }). It is in every
 *    editor (note-editor's defaults), so a body holding one always draws it;
 *    its markdown is `[#name](tag://id)` (src/lib/tags/markdown.ts,
 *    markdown-conversion.ts). Its color is the tag's current one, read from
 *    the tag color store, so a recolor shows everywhere at once. A click asks
 *    the app to list everything with that tag (TAG_OPEN_EVENT).
 *
 *  • TagSuggestion: the `#` trigger, in the editors that take it. Never in
 *    code, never mid-word (`C#`, `/#anchor`), never `# ` (a heading), and the
 *    query is one word of tag characters (src/lib/tags/trigger.ts). It hands
 *    the query and its place to a store; TagMenu draws the menu from it.
 *
 * Kept in its own file: other editor features (the `@` picker, snippets after
 * `;`) live beside it and do not share its trigger.
 */
import { Extension, Node, mergeAttributes, type Editor, type Range } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import Suggestion from '@tiptap/suggestion'
import { TAG_NODE } from '@/app/account/(dashboard)/views/markdown-conversion'
import { tagLabelText } from '@/lib/tags/markdown'
import { canStartTag, isTagQuery } from '@/lib/tags/trigger'
import { tagColorStore } from '@/lib/tags/color-store'
import { TAG_DEFAULT_COLOR } from '@/lib/tags/palette'

/** Fired on window when a pill is clicked: the app lists what has the tag. */
export const TAG_OPEN_EVENT = 'ni:open-tag'

export interface TagOpenDetail {
  id: string
  name: string
}

export function openTag(detail: TagOpenDetail): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<TagOpenDetail>(TAG_OPEN_EVENT, { detail }))
}

/** A pick from the menu: the tag, as it is stored. */
export interface PickedTag {
  id: string
  name: string
  color: string
}

function paintPill(el: HTMLElement, id: string) {
  const color = tagColorStore.get(id) ?? TAG_DEFAULT_COLOR
  el.style.setProperty('--tag-color', color)
}

export const TagPill = Node.create({
  name: TAG_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      id: { default: null, parseHTML: (el) => el.getAttribute('data-tag-id') },
      name: { default: '', parseHTML: (el) => (el.textContent ?? '').replace(/^#/, '') },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-tag-id]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { class: 'tag-pill', 'data-tag-id': node.attrs.id, role: 'button', tabindex: '-1' }),
      `#${tagLabelText(String(node.attrs.name ?? ''))}`,
    ]
  },

  renderText({ node }) {
    return `#${node.attrs.name ?? ''}`
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('span')
      dom.className = 'tag-pill'
      dom.setAttribute('role', 'button')
      dom.setAttribute('tabindex', '-1')
      const id = String(node.attrs.id ?? '')
      dom.dataset.tagId = id
      dom.textContent = `#${tagLabelText(String(node.attrs.name ?? ''))}`
      paintPill(dom, id)
      const unsubscribe = tagColorStore.subscribe(() => paintPill(dom, id))
      return {
        dom,
        destroy: unsubscribe,
      }
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('tagPillClick'),
        props: {
          handleClickOn(_view, _pos, node, _nodePos, event) {
            if (node.type.name !== TAG_NODE || typeof node.attrs.id !== 'string') return false
            event.preventDefault()
            openTag({ id: node.attrs.id, name: String(node.attrs.name ?? '') })
            return true
          },
        },
      }),
    ]
  },
})

// ── The `#` menu's store ─────────────────────────────────────────────────────

export interface TagSuggestionState {
  query: string
  rect: { left: number; top: number; bottom: number }
  pick: (tag: PickedTag) => void
}

export type TagMenuKeys = (e: KeyboardEvent) => boolean

export interface TagSuggestionStore {
  get: () => TagSuggestionState | null
  subscribe: (listener: () => void) => () => void
  set: (state: TagSuggestionState | null) => void
  keys: { current: TagMenuKeys | null }
  setKeys: (keys: TagMenuKeys | null) => void
  dismiss: () => void
}

export function createTagSuggestionStore(): TagSuggestionStore {
  let state: TagSuggestionState | null = null
  const listeners = new Set<() => void>()
  const store: TagSuggestionStore = {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (next) => {
      state = next
      for (const l of listeners) l()
    },
    keys: { current: null },
    setKeys: (keys) => {
      store.keys.current = keys
    },
    dismiss: () => store.set(null),
  }
  return store
}

/** The pill, then one space, in place of `#query`. */
export function insertTagPill(editor: Editor, range: Range, tag: PickedTag): void {
  tagColorStore.put([{ id: tag.id, color: tag.color }])
  editor
    .chain()
    .focus()
    .insertContentAt(range, [
      { type: TAG_NODE, attrs: { id: tag.id, name: tag.name } },
      { type: 'text', text: ' ' },
    ])
    .run()
}

export interface TagSuggestionOptions {
  store: TagSuggestionStore | null
  /** Called after a pick lands in the text (a record's own text tags the record). */
  onPick: ((tag: PickedTag) => void) | null
}

export const TagSuggestion = Extension.create<TagSuggestionOptions>({
  name: 'tagSuggestion',

  addOptions() {
    return { store: null, onPick: null }
  },

  addProseMirrorPlugins() {
    const { store } = this.options
    const options = this.options
    if (!store) return []
    const show = (props: { editor: Editor; range: Range; query: string; clientRect?: (() => DOMRect | null) | null }) => {
      const box = props.clientRect?.()
      if (!box || !isTagQuery(props.query)) {
        store.set(null)
        return
      }
      store.set({
        query: props.query,
        rect: { left: box.left, top: box.top, bottom: box.bottom },
        pick: (tag) => {
          store.set(null)
          insertTagPill(props.editor, props.range, tag)
          options.onPick?.(tag)
        },
      })
    }
    return [
      Suggestion({
        editor: this.editor,
        pluginKey: new PluginKey('tagSuggestion'),
        char: '#',
        allowSpaces: false,
        // The character before `#` is checked in `allow` (an opening bracket counts too).
        allowedPrefixes: null,
        startOfLine: false,
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from)
          if ($from.parent.type.spec.code || $from.marks().some((m) => m.type.name === 'code' || m.type.name === 'link')) return false
          const before = range.from > $from.start() ? state.doc.textBetween(range.from - 1, range.from) : undefined
          return canStartTag(before)
        },
        items: () => [],
        render: () => ({
          onStart: show,
          onUpdate: show,
          onExit: () => store.set(null),
          onKeyDown: ({ event }) => {
            if (!store.get()) return false
            if (event.key === 'Escape') {
              store.dismiss()
              return true
            }
            return store.keys.current?.(event) ?? false
          },
        }),
      }),
    ]
  },
})
