/**
 * Find and replace inside a document (docs/plans/doc-editor-extras.md, phase 3).
 *
 * A plugin holds the search (its text and the match-case, whole-word and
 * regular-expression switches) and the matches, recomputed on every change to
 * the document, so they follow the person's typing and other people's edits as
 * they arrive. Matches are painted with decorations; replacing is an ordinary
 * edit (one undo step for "replace all"), saved like typing.
 *
 * A match never crosses a block, and an inline atom (a formula, a record chip)
 * stands for one character that no search text matches.
 *
 * ⌘⇧F opens the bar (⌘F stays the browser's, docs/plans/keyboard-shortcuts.md);
 * the extension only calls `onOpen`, the bar is the panel's.
 */
import { Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { revealPos } from './heading-fold'

export interface FindOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

export interface FindMatch {
  from: number
  to: number
  /** The regex's groups (index 0 the whole match), for `$1` in a replacement. */
  groups: string[]
  named?: Record<string, string>
}

export interface FindState extends FindOptions {
  query: string
  matches: FindMatch[]
  /** Index into `matches`, or -1. */
  active: number
  /** The regular expression doesn't read (shown instead of a count). */
  error: string | null
}

export const MAX_MATCHES = 5000

const EMPTY: FindState = { query: '', caseSensitive: false, wholeWord: false, regex: false, matches: [], active: -1, error: null }

export const findReplaceKey = new PluginKey<FindState>('niFindReplace')

type FindMeta = { search: Partial<FindOptions> & { query?: string } } | { active: number } | { clear: true }

const OBJECT = '￼'

/** The pattern a search builds, or an error. Pure. */
export function buildPattern(query: string, options: FindOptions): { re: RegExp | null; error: string | null } {
  if (!query) return { re: null, error: null }
  const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const wrapped = options.wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])` : source
  try {
    return { re: new RegExp(wrapped, `gu${options.caseSensitive ? '' : 'i'}`), error: null }
  } catch (e) {
    return { re: null, error: e instanceof Error ? e.message.replace(/^Invalid regular expression: /, '') : 'Not a valid pattern' }
  }
}

/** Every match of `re` in the document's text blocks. Pure. */
export function findMatches(doc: PMNode, re: RegExp | null): FindMatch[] {
  if (!re) return []
  const out: FindMatch[] = []
  doc.descendants((node, pos) => {
    if (out.length >= MAX_MATCHES) return false
    if (!node.isTextblock) return true
    // One character per position: text as itself, an inline atom as U+FFFC.
    let text = ''
    node.forEach((child) => {
      text += child.isText ? (child.text ?? '') : OBJECT.repeat(child.nodeSize)
    })
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++
        continue
      }
      if (m[0].includes(OBJECT)) continue
      const from = pos + 1 + m.index
      out.push({ from, to: from + m[0].length, groups: [...m].map((g) => g ?? ''), ...(m.groups ? { named: { ...m.groups } } : {}) })
      if (out.length >= MAX_MATCHES) break
    }
    return false
  })
  return out
}

/** A replacement with `$&`, `$1`…`$99`, `$<name>` and `$$` filled in (regex mode only). Pure. */
export function expandReplacement(replacement: string, match: FindMatch, regex: boolean): string {
  if (!regex) return replacement
  return replacement.replace(/\$(\$|&|\d{1,2}|<([^>]+)>)/g, (whole, token: string, name?: string) => {
    if (token === '$') return '$'
    if (token === '&') return match.groups[0] ?? ''
    if (name !== undefined) return match.named?.[name] ?? whole
    const n = Number(token)
    return n > 0 && n < match.groups.length ? match.groups[n] : whole
  })
}

function compute(doc: PMNode, base: FindState, near: number | null): FindState {
  const { re, error } = buildPattern(base.query, base)
  const matches = findMatches(doc, re)
  let active = -1
  if (matches.length > 0) {
    const anchor = near ?? 0
    active = matches.findIndex((m) => m.to > anchor)
    if (active < 0) active = 0
  }
  return { ...base, matches, active, error }
}

export function getFindState(state: EditorState): FindState {
  return findReplaceKey.getState(state) ?? EMPTY
}

/** Change the search (its text and/or switches). */
export function setSearch(view: EditorView, search: Partial<FindOptions> & { query?: string }) {
  view.dispatch(view.state.tr.setMeta(findReplaceKey, { search } satisfies FindMeta).setMeta('addToHistory', false))
  revealActive(view)
}

/** Drop the search and its highlights. */
export function clearSearch(view: EditorView) {
  view.dispatch(view.state.tr.setMeta(findReplaceKey, { clear: true } satisfies FindMeta).setMeta('addToHistory', false))
}

/** Bring the active match into view: open any fold hiding it, then scroll to it. */
function revealActive(view: EditorView) {
  const s = getFindState(view.state)
  const m = s.matches[s.active]
  if (!m) return
  revealPos(view, m.from)
  requestAnimationFrame(() => {
    try {
      const { node } = view.domAtPos(m.from)
      const el = node instanceof HTMLElement ? node : node.parentElement
      el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    } catch {
      // The view went away.
    }
  })
}

/** The next (1) or previous (-1) match. */
export function stepMatch(view: EditorView, dir: 1 | -1) {
  const s = getFindState(view.state)
  if (s.matches.length === 0) return
  const active = (s.active + dir + s.matches.length) % s.matches.length
  view.dispatch(view.state.tr.setMeta(findReplaceKey, { active } satisfies FindMeta).setMeta('addToHistory', false))
  revealActive(view)
}

/** Replace the active match, then move to the next one. False when there is none (or the view is read-only). */
export function replaceActive(view: EditorView, replacement: string): boolean {
  if (!view.editable) return false
  const s = getFindState(view.state)
  const m = s.matches[s.active]
  if (!m) return false
  const text = expandReplacement(replacement, m, s.regex)
  const tr = text ? view.state.tr.insertText(text, m.from, m.to) : view.state.tr.delete(m.from, m.to)
  tr.setMeta(findReplaceKey, { near: m.from + text.length })
  view.dispatch(tr)
  revealActive(view)
  return true
}

/** Replace every match, as one edit (one undo step). How many were replaced. */
export function replaceAll(view: EditorView, replacement: string): number {
  if (!view.editable) return 0
  const s = getFindState(view.state)
  if (s.matches.length === 0) return 0
  const tr = view.state.tr
  for (let i = s.matches.length - 1; i >= 0; i--) {
    const m = s.matches[i]
    const text = expandReplacement(replacement, m, s.regex)
    if (text) tr.insertText(text, m.from, m.to)
    else tr.delete(m.from, m.to)
  }
  view.dispatch(tr)
  return s.matches.length
}

export interface FindReplaceOptions {
  /** ⌘⇧F in the editor: open the bar, with the selected text (if any) to search for. */
  onOpen: ((selected: string) => void) | null
}

export const FindReplace = Extension.create<FindReplaceOptions>({
  name: 'niFindReplace',

  addOptions() {
    return { onOpen: null }
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Shift-f': ({ editor }) => {
        const onOpen = this.options.onOpen
        if (!onOpen) return false
        const { from, to } = editor.state.selection
        const selected = from === to ? '' : editor.state.doc.textBetween(from, to, ' ').slice(0, 200)
        onOpen(selected.includes('\n') ? '' : selected)
        return true
      },
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findReplaceKey,
        state: {
          init: () => EMPTY,
          apply(tr: Transaction, value: FindState, _old, newState): FindState {
            const meta = tr.getMeta(findReplaceKey) as FindMeta | { near: number } | undefined
            if (meta && 'clear' in meta) return EMPTY
            if (meta && 'active' in meta) return { ...value, active: Math.max(-1, Math.min(meta.active, value.matches.length - 1)) }
            if (meta && 'search' in meta) {
              const next = { ...value, ...meta.search }
              return compute(newState.doc, next, newState.selection.from)
            }
            if (!tr.docChanged || !value.query) return value
            // The document changed (typing, a replace, someone else's edit):
            // recompute, keeping the active match near where it was.
            const near = meta && 'near' in meta ? meta.near : value.matches[value.active] ? tr.mapping.map(value.matches[value.active].from) : null
            return compute(newState.doc, value, near)
          },
        },
        props: {
          decorations(state) {
            const s = getFindState(state)
            if (s.matches.length === 0) return DecorationSet.empty
            return DecorationSet.create(
              state.doc,
              s.matches.map((m, i) =>
                Decoration.inline(m.from, m.to, { class: i === s.active ? 'ni-find-match ni-find-match--active' : 'ni-find-match' }),
              ),
            )
          },
        },
      }),
    ]
  },
})

/** Put the caret on the active match (closing the bar with Enter in it, say). */
export function selectActive(view: EditorView) {
  const s = getFindState(view.state)
  const m = s.matches[s.active]
  if (!m) return
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, m.from, m.to)).scrollIntoView())
}
