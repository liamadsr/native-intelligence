/**
 * SNIPPETS IN THE EDITOR (docs/plans/snippets.md): `;` typed at the start of a
 * word opens the person's snippets; picking one puts its body where `;query`
 * was. The same pattern as the `@` picker (record-mention.ts): Tiptap's
 * suggestion plugin tracks the query and its place and hands them to a tiny
 * store; the menu (SnippetSuggestionMenu, mounted beside the editor) reads it
 * and hands its key handler back.
 *
 * It does not open inside a code block or inline code, inside a link, in the
 * middle of a word, or while the person has no snippets (then `;` is only a
 * character). Its own file and plugin key: the `@` and `#` pickers are
 * untouched.
 *
 * A body is markdown. It goes in as the editor's own nodes, fitted to what
 * this editor holds (fitToSchema: a heading in the mail composer becomes a
 * paragraph); a one-paragraph body goes in inline, at the caret.
 */
import { Extension, type Editor, type JSONContent, type Range } from '@tiptap/core'
import { PluginKey, type EditorState } from '@tiptap/pm/state'
import { Fragment, Slice, type Schema } from '@tiptap/pm/model'
import Suggestion from '@tiptap/suggestion'
import { markdownToJSONContent } from '@/app/account/(dashboard)/views/markdown-conversion'
import { isSnippetQuery, SNIPPET_TRIGGER } from '@/lib/snippets/trigger'
import { currentSnippets, ensureSnippets } from '@/components/snippets/use-snippets'

export interface SnippetSuggestionState {
  query: string
  /** The `;query` text's box on screen (viewport coordinates). */
  rect: { left: number; top: number; bottom: number }
  /** Put a body (markdown, fill-ins already applied) where `;query` is. */
  pick: (markdown: string) => void
}

export interface SnippetSuggestionStore {
  get: () => SnippetSuggestionState | null
  subscribe: (listener: () => void) => () => void
  set: (state: SnippetSuggestionState | null) => void
  keys: { current: ((e: KeyboardEvent) => boolean) | null }
  setKeys: (keys: ((e: KeyboardEvent) => boolean) | null) => void
  dismiss: () => void
}

export function createSnippetSuggestionStore(): SnippetSuggestionStore {
  let state: SnippetSuggestionState | null = null
  const listeners = new Set<() => void>()
  const store: SnippetSuggestionStore = {
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

// ── Fitting a body to an editor ──────────────────────────────────────────────

function textOf(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  return (node.content ?? []).map(textOf).join('')
}

function fitMarks(marks: JSONContent['marks'], schema: Schema): JSONContent['marks'] {
  const kept = (marks ?? []).filter((m) => !!schema.marks[m.type])
  return kept.length ? kept : undefined
}

/** One node, as this schema holds it (none, one, or its parts). */
function fitNode(node: JSONContent, schema: Schema): JSONContent[] {
  const type = node.type ?? ''
  if (type === 'text') {
    if (!node.text) return []
    const marks = fitMarks(node.marks, schema)
    return [{ type: 'text', text: node.text, ...(marks ? { marks } : {}) }]
  }
  if (schema.nodes[type]) {
    const spec = schema.nodes[type]
    if (!node.content) return [{ ...node }]
    const children = node.content.flatMap((c) => fitNode(c, schema))
    // A textblock holds inline nodes only: block children collapse to their text.
    if (spec.isTextblock && children.some((c) => c.type && schema.nodes[c.type]?.isBlock)) {
      const text = textOf({ type: 'doc', content: children })
      return [{ type, ...(node.attrs ? { attrs: node.attrs } : {}), content: text ? [{ type: 'text', text }] : [] }]
    }
    return [{ ...node, content: children }]
  }
  // Not in this editor: a block that holds text becomes paragraphs of it; a list
  // with no list here, one paragraph an item; anything else, its words or nothing.
  const inlineHolder = type === 'heading' || type === 'codeBlock' || type === 'blockquote'
  if (inlineHolder && node.content?.every((c) => c.type === 'text' || c.type === 'hardBreak')) {
    const content = node.content.flatMap((c) => fitNode(c, schema))
    return [{ type: 'paragraph', content }]
  }
  if (node.content?.length) return node.content.flatMap((c) => fitNode(c, schema))
  const text = textOf(node)
  return text ? [{ type: 'paragraph', content: [{ type: 'text', text }] }] : []
}

/** A markdown body as this editor's nodes: inline content for a one-paragraph body, else blocks. */
export function snippetContent(markdown: string, schema: Schema): JSONContent[] {
  const doc = markdownToJSONContent(markdown)
  const blocks = (doc.content ?? []).flatMap((n) => fitNode(n, schema)).filter((n) => n.type !== 'paragraph' || n.content?.length)
  if (blocks.length === 1 && blocks[0].type === 'paragraph') return blocks[0].content ?? []
  return blocks
}

/**
 * The body in place of `;query`. Blocks go in open at both ends: the first
 * paragraph carries on the line the `;` was on, and what followed the caret
 * carries on after the last one, as a paste does.
 */
export function insertSnippet(editor: Editor, range: Range, markdown: string): void {
  const { schema } = editor
  const content = snippetContent(markdown, schema)
  if (!content.length) return
  const nodes = content.map((json) => schema.nodeFromJSON(json))
  if (nodes.every((n) => n.isInline)) {
    editor.chain().focus().insertContentAt(range, content).run()
    return
  }
  const slice = new Slice(Fragment.from(nodes), nodes[0].isTextblock ? 1 : 0, nodes[nodes.length - 1].isTextblock ? 1 : 0)
  editor.view.dispatch(editor.state.tr.replaceRange(range.from, range.to, slice).scrollIntoView())
  editor.commands.focus()
}

// ── The extension ───────────────────────────────────────────────────────────

/** Whether `;` may open at `range` (the `;query` text): see the file's header. */
export function snippetAllowedAt(state: EditorState, range: Range): boolean {
  const $from = state.doc.resolve(range.from)
  if ($from.parent.type.spec.code) return false
  const marks = state.doc.resolve(range.from + 1).marks()
  if (marks.some((m) => m.type.name === 'code' || m.type.name === 'link')) return false
  // The query ends at the caret: a word going on after it is no shortcut being typed.
  if (range.to !== state.selection.from || !state.selection.empty) return false
  const after = state.doc.textBetween(range.to, Math.min(range.to + 1, $from.end()), '\n')
  if (/[A-Za-z0-9_-]/.test(after)) return false
  const query = state.doc.textBetween(range.from + 1, range.to, '\n')
  return isSnippetQuery(query)
}

export interface SnippetSuggestionOptions {
  store: SnippetSuggestionStore | null
}

export const SnippetSuggestion = Extension.create<SnippetSuggestionOptions>({
  name: 'snippetSuggestion',

  addOptions() {
    return { store: null }
  },

  onFocus() {
    ensureSnippets()
  },

  addProseMirrorPlugins() {
    const store = this.options.store
    if (!store) return []
    const show = (props: { editor: Editor; range: Range; query: string; clientRect?: (() => DOMRect | null) | null }) => {
      const box = props.clientRect?.()
      if (!box || !isSnippetQuery(props.query)) {
        store.set(null)
        return
      }
      store.set({
        query: props.query,
        rect: { left: box.left, top: box.top, bottom: box.bottom },
        pick: (markdown) => {
          store.set(null)
          insertSnippet(props.editor, props.range, markdown)
        },
      })
    }
    return [
      Suggestion({
        editor: this.editor,
        pluginKey: new PluginKey('snippetSuggestion'),
        char: SNIPPET_TRIGGER,
        allowSpaces: false,
        // At a word's start: the start of a line, a space, an opening bracket or quote.
        allowedPrefixes: [' ', ' ', '(', '{', '"', "'", '“', '‘'],
        // `state` is the state being made (editor.state is the one before it).
        allow: ({ state, range }) => {
          if (!snippetAllowedAt(state, range)) return false
          if (currentSnippets().length > 0) return true
          // Not loaded yet (or none): ask, and open on the next key once they're here.
          ensureSnippets()
          return false
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
