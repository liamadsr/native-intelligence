/**
 * RECORD MENTIONS IN THE EDITOR: a person or record @-mentioned in a document,
 * drawn as an inline chip that opens its card.
 *
 *  • RecordMention: the chip, an inline atom node ({ kind, id, label }). It is
 *    in every editor (note-editor's defaults), so a body holding one always
 *    draws it; its markdown is `[@label](mention://kind/id)`
 *    (src/lib/documents/mention-markdown.ts, markdown-conversion.ts). A click
 *    opens what it names (openMention: a file opens the record it hangs off).
 *
 *  • RecordMentionSuggestion: `@` typed at the start of a word, for the
 *    documents' editor only (document-detail-panel.tsx). It tracks the query
 *    and its place with Tiptap's suggestion plugin and hands them to a store;
 *    the menu itself is the one `@` picker (CommandMenu, drawn by
 *    RecordMentionMenu), fed from that store. Picking a row puts the chip
 *    where `@query` was.
 *
 * No timers, no per-frame work: the store changes on keystrokes only.
 */
import { Extension, Node, mergeAttributes, type Editor, type Range } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import Suggestion from '@tiptap/suggestion'
import { RECORD_MENTION_NODE } from '@/app/account/(dashboard)/views/markdown-conversion'
import { isMentionableType } from '@/lib/entity-links/mentionable'
import { openMention } from '@/lib/entity-links/open-mention'
import { mentionLabelText } from '@/lib/documents/mention-markdown'
import type { MenuRowMention } from '@/lib/search/menu-search'

/** A mention's query this long, or this many words, is no mention: the menu steps aside. */
const MAX_QUERY = 48
const MAX_WORDS = 4

export const RecordMention = Node.create({
  name: RECORD_MENTION_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      kind: { default: null, parseHTML: (el) => el.getAttribute('data-record-mention') },
      id: { default: null, parseHTML: (el) => el.getAttribute('data-mention-id') },
      label: { default: '', parseHTML: (el) => (el.textContent ?? '').replace(/^@/, '') },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-record-mention]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        class: 'record-mention',
        'data-record-mention': node.attrs.kind,
        'data-mention-id': node.attrs.id,
        // Read as one word, not a link (it opens a card in the app).
        role: 'button',
        tabindex: '-1',
      }),
      `@${mentionLabelText(String(node.attrs.label ?? ''))}`,
    ]
  },

  renderText({ node }) {
    return `@${node.attrs.label ?? ''}`
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('recordMentionClick'),
        props: {
          handleClickOn(_view, _pos, node, _nodePos, event) {
            if (node.type.name !== RECORD_MENTION_NODE) return false
            const { kind, id, label } = node.attrs as { kind: unknown; id: unknown; label: unknown }
            if (!isMentionableType(kind) || typeof id !== 'string') return false
            event.preventDefault()
            void openMention({ type: kind, id, label: typeof label === 'string' ? label : null }, 'document')
            return true
          },
        },
      }),
    ]
  },
})

// ── The `@` picker's store ───────────────────────────────────────────────────

/** What the open `@` shows: what's typed after it, where it sits, and how a pick lands. */
export interface MentionSuggestionState {
  query: string
  /** The `@query` text's box on screen (viewport coordinates), to open the menu under. */
  rect: { left: number; top: number; bottom: number }
  /** Put the picked record's chip where `@query` is. */
  pick: (mention: MenuRowMention) => void
}

/** What the menu answers a key with (CommandMenuHandle.handleKey). */
export type MentionMenuKeys = (e: KeyboardEvent) => boolean

/**
 * One editor's open `@`: a tiny external store (useSyncExternalStore) that the
 * suggestion plugin writes and RecordMentionMenu reads, plus the menu's key
 * handler going the other way.
 */
export interface MentionSuggestionStore {
  get: () => MentionSuggestionState | null
  subscribe: (listener: () => void) => () => void
  set: (state: MentionSuggestionState | null) => void
  /** The menu's keys while it shows (null: none). */
  keys: { current: MentionMenuKeys | null }
  /** The menu hands over its key handler (null when it goes). */
  setKeys: (keys: MentionMenuKeys | null) => void
  /** Esc: the menu closes (the next key typed in the `@…` opens it again). */
  dismiss: () => void
}

export function createMentionSuggestionStore(): MentionSuggestionStore {
  let state: MentionSuggestionState | null = null
  const listeners = new Set<() => void>()
  const store: MentionSuggestionStore = {
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

/** Whether a query reads as a name being typed (a few words at most), not a sentence after an `@`. */
export function isMentionQuery(query: string): boolean {
  return query.length <= MAX_QUERY && !/^\s/.test(query) && !query.includes('  ') && query.split(' ').length <= MAX_WORDS
}

/** The chip for a pick, then one space, in place of `@query`. */
export function insertRecordMention(editor: Editor, range: Range, mention: MenuRowMention): void {
  editor
    .chain()
    .focus()
    .insertContentAt(range, [
      { type: RECORD_MENTION_NODE, attrs: { kind: mention.type, id: mention.id, label: mention.label } },
      { type: 'text', text: ' ' },
    ])
    .run()
}

export interface RecordMentionSuggestionOptions {
  store: MentionSuggestionStore | null
}

export const RecordMentionSuggestion = Extension.create<RecordMentionSuggestionOptions>({
  name: 'recordMentionSuggestion',

  addOptions() {
    return { store: null }
  },

  addProseMirrorPlugins() {
    const store = this.options.store
    if (!store) return []
    const show = (props: { editor: Editor; range: Range; query: string; clientRect?: (() => DOMRect | null) | null }) => {
      const box = props.clientRect?.()
      if (!box || !isMentionQuery(props.query)) {
        store.set(null)
        return
      }
      store.set({
        query: props.query,
        rect: { left: box.left, top: box.top, bottom: box.bottom },
        pick: (mention) => {
          store.set(null)
          insertRecordMention(props.editor, props.range, mention)
        },
      })
    }
    return [
      Suggestion({
        editor: this.editor,
        pluginKey: new PluginKey('recordMentionSuggestion'),
        char: '@',
        // A name has spaces in it (`@Maya Chen`); isMentionQuery ends it after a few words.
        allowSpaces: true,
        // Never inside code.
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from)
          return !$from.parent.type.spec.code && !$from.marks().some((m) => m.type.name === 'code')
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
