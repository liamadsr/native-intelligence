/**
 * Folding a document's sections (docs/plans/doc-editor-extras.md, phase 1).
 *
 * Every top-level heading gets an arrow; folding it hides the blocks under it,
 * up to the next heading of the same or a higher level. ⌘↵ with the caret in a
 * heading does the same. A fold is a VIEW: decorations only, the document and
 * its markdown never change, so a fold is never saved, synced or seen by
 * anyone else, and a reader can fold too.
 *
 * Folds are remembered on this device (`localStorage`, under the extension's
 * `storageKey`, one per document), keyed by the heading's text and which
 * occurrence of that text it is, so they survive a reload and other people's
 * edits elsewhere. Renaming a folded heading unfolds it.
 *
 * A fold opens by itself when the caret lands inside it (an arrow key, a find
 * match, an outline jump: see `revealPos`).
 */
import { Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'

export interface HeadingInfo {
  /** Stable across reloads: the heading's text and its occurrence (`Notes#1`). */
  key: string
  level: number
  text: string
  /** The heading's position in the document (before its opening token). */
  pos: number
}

interface FoldState {
  folded: ReadonlySet<string>
}

type FoldMeta = { toggle: string } | { unfold: readonly string[] } | { set: readonly string[] }

export const headingFoldKey = new PluginKey<FoldState>('niHeadingFold')

/** The document's top-level headings, in order, each with its fold key. Pure. */
export function listHeadings(doc: PMNode): HeadingInfo[] {
  const seen = new Map<string, number>()
  const out: HeadingInfo[] = []
  doc.forEach((node, offset) => {
    if (node.type.name !== 'heading') return
    const text = node.textContent.trim()
    const n = seen.get(text) ?? 0
    seen.set(text, n + 1)
    out.push({ key: `${text}#${n}`, level: Number(node.attrs.level) || 1, text, pos: offset })
  })
  return out
}

export interface FoldedSection {
  key: string
  /** The heading's position. */
  headingPos: number
  /** The hidden span: from the end of the heading to the start of the next heading at its level or above (or the end). */
  from: number
  to: number
}

/**
 * The sections the folds hide, outermost first; a fold inside a folded section
 * adds nothing (it is hidden already). Pure.
 */
export function foldedSections(doc: PMNode, folded: ReadonlySet<string>): FoldedSection[] {
  if (folded.size === 0) return []
  const headings = listHeadings(doc)
  const out: FoldedSection[] = []
  let hiddenUntil = -1
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i]
    if (h.pos < hiddenUntil || !folded.has(h.key)) continue
    const headingNode = doc.nodeAt(h.pos)
    if (!headingNode) continue
    const from = h.pos + headingNode.nodeSize
    let to = doc.content.size
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= h.level) {
        to = headings[j].pos
        break
      }
    }
    if (to > from) {
      out.push({ key: h.key, headingPos: h.pos, from, to })
      hiddenUntil = to
    }
  }
  return out
}

/** The folded sections that hold `pos` (the ones to open to show it). Pure. */
export function foldsHiding(doc: PMNode, folded: ReadonlySet<string>, pos: number): string[] {
  return foldedSections(doc, folded)
    .filter((s) => pos >= s.from && pos < s.to)
    .map((s) => s.key)
}

function readStored(storageKey: string | null): Set<string> {
  if (!storageKey || typeof window === 'undefined') return new Set()
  try {
    const raw = window.localStorage.getItem(storageKey)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeStored(storageKey: string | null, folded: ReadonlySet<string>) {
  if (!storageKey || typeof window === 'undefined') return
  try {
    if (folded.size === 0) window.localStorage.removeItem(storageKey)
    else window.localStorage.setItem(storageKey, JSON.stringify([...folded]))
  } catch {
    // Private mode or a full store: the fold still works, it just isn't remembered.
  }
}

/** Is this heading folded now? */
export function isFolded(state: EditorState, key: string): boolean {
  return headingFoldKey.getState(state)?.folded.has(key) ?? false
}

/** Fold or unfold one heading (by its key). */
export function toggleFold(view: EditorView, key: string) {
  view.dispatch(view.state.tr.setMeta(headingFoldKey, { toggle: key } satisfies FoldMeta))
}

/** Open every fold that hides `pos`; true when one was opened. */
export function revealPos(view: EditorView, pos: number): boolean {
  const folded = headingFoldKey.getState(view.state)?.folded
  if (!folded) return false
  const keys = foldsHiding(view.state.doc, folded, pos)
  if (keys.length === 0) return false
  view.dispatch(view.state.tr.setMeta(headingFoldKey, { unfold: keys } satisfies FoldMeta))
  return true
}

/** The heading the caret is in, when it is a top-level one. */
function headingAtSelection(state: EditorState): HeadingInfo | null {
  const { $from } = state.selection
  if ($from.depth !== 1 || $from.parent.type.name !== 'heading') return null
  const pos = $from.before(1)
  return listHeadings(state.doc).find((h) => h.pos === pos) ?? null
}

function arrowButton(view: EditorView, key: string, folded: boolean, text: string): HTMLElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.contentEditable = 'false'
  button.className = folded ? 'ni-fold-toggle ni-fold-toggle--folded' : 'ni-fold-toggle'
  button.setAttribute('aria-expanded', folded ? 'false' : 'true')
  button.setAttribute('aria-label', `${folded ? 'Unfold' : 'Fold'} ${text || 'section'}`)
  button.title = folded ? 'Unfold (⌘↵)' : 'Fold (⌘↵)'
  button.tabIndex = -1
  // An SVG chevron, drawn here (no icon library inside ProseMirror's DOM).
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(ns, 'path')
  path.setAttribute('d', 'M4 6l4 4 4-4')
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '1.6')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  svg.appendChild(path)
  button.appendChild(svg)
  // Mousedown, not click: keep the caret where it was and don't start a selection.
  button.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    toggleFold(view, key)
  })
  return button
}

export interface HeadingFoldOptions {
  /** Where this document's folds are remembered (`localStorage`); null remembers nothing. */
  storageKey: string | null
}

/** The `localStorage` key for a document's folds. */
export function foldStorageKey(documentId: string): string {
  return `ni:doc-folds:${documentId}`
}

export const HeadingFold = Extension.create<HeadingFoldOptions>({
  name: 'niHeadingFold',
  // Before HardBreak's own ⌘↵, which still runs outside a heading.
  priority: 1000,

  addOptions() {
    return { storageKey: null }
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Enter': ({ editor }) => {
        const heading = headingAtSelection(editor.state)
        if (!heading) return false
        toggleFold(editor.view, heading.key)
        return true
      },
    }
  },

  addProseMirrorPlugins() {
    const storageKey = this.options.storageKey
    return [
      new Plugin<FoldState>({
        key: headingFoldKey,
        state: {
          init: () => ({ folded: readStored(storageKey) }),
          apply(tr: Transaction, value: FoldState): FoldState {
            const meta = tr.getMeta(headingFoldKey) as FoldMeta | undefined
            if (!meta) return value
            const next = new Set(value.folded)
            if ('toggle' in meta) {
              if (next.has(meta.toggle)) next.delete(meta.toggle)
              else next.add(meta.toggle)
            } else if ('unfold' in meta) {
              for (const k of meta.unfold) next.delete(k)
            } else {
              next.clear()
              for (const k of meta.set) next.add(k)
            }
            writeStored(storageKey, next)
            return { folded: next }
          },
        },
        // The caret landed inside a fold (arrow keys, a click on the edge, a
        // programmatic jump): open it, so it is never typing into nothing.
        appendTransaction(trs, _old, state) {
          if (!trs.some((tr) => tr.selectionSet || tr.docChanged)) return null
          if (trs.some((tr) => tr.getMeta(headingFoldKey))) return null
          const folded = headingFoldKey.getState(state)?.folded
          if (!folded || folded.size === 0) return null
          const keys = foldsHiding(state.doc, folded, state.selection.from)
          if (keys.length === 0) return null
          return state.tr.setMeta(headingFoldKey, { unfold: keys } satisfies FoldMeta)
        },
        props: {
          decorations(state) {
            const folded = headingFoldKey.getState(state)?.folded ?? new Set<string>()
            const decorations: Decoration[] = []
            const hidden = foldedSections(state.doc, folded)
            for (const h of listHeadings(state.doc)) {
              const isHidden = hidden.some((s) => h.pos >= s.from && h.pos < s.to)
              if (isHidden) continue
              const on = folded.has(h.key) && hidden.some((s) => s.key === h.key)
              const node = state.doc.nodeAt(h.pos)
              if (!node) continue
              decorations.push(
                Decoration.widget(h.pos + 1, (view) => arrowButton(view, h.key, on, h.text), {
                  side: -1,
                  ignoreSelection: true,
                  key: `fold:${h.key}:${on ? 1 : 0}`,
                }),
              )
              decorations.push(
                Decoration.node(h.pos, h.pos + node.nodeSize, { class: on ? 'ni-fold-heading ni-fold-heading--folded' : 'ni-fold-heading' }),
              )
            }
            for (const s of hidden) {
              state.doc.nodesBetween(s.from, s.to, (node, pos) => {
                if (pos >= s.from && pos + node.nodeSize <= s.to) {
                  decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'ni-fold-hidden' }))
                }
                return false
              })
            }
            return DecorationSet.create(state.doc, decorations)
          },
        },
      }),
    ]
  },
})
