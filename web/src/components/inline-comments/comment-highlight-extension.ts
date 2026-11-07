import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { InlineComment } from './types'

const COMMENT_HIGHLIGHT_PLUGIN_KEY = new PluginKey('commentHighlights')

interface HighlightMeta {
  type: 'setComments'
  comments: InlineComment[]
  activeId: string | null
}

function findNthOccurrence(text: string, search: string, n: number): number {
  let count = 0
  let pos = 0
  while (pos < text.length) {
    const idx = text.indexOf(search, pos)
    if (idx === -1) return -1
    if (count === n) return idx
    count++
    pos = idx + 1
  }
  return -1
}

function findAnchorPosition(
  fullText: string,
  anchorText: string,
  prefix: string,
  suffix: string,
  occurrenceIndex: number,
): { start: number; end: number } | null {
  // Strategy 1: Full context match (prefix + text + suffix)
  if (prefix || suffix) {
    const searchStr = prefix + anchorText + suffix
    const idx = fullText.indexOf(searchStr)
    if (idx !== -1) {
      return { start: idx + prefix.length, end: idx + prefix.length + anchorText.length }
    }
  }

  // Strategy 2: Text with occurrence index
  const idx = findNthOccurrence(fullText, anchorText, occurrenceIndex)
  if (idx !== -1) {
    return { start: idx, end: idx + anchorText.length }
  }

  // Strategy 3: First occurrence fallback
  const firstIdx = fullText.indexOf(anchorText)
  if (firstIdx !== -1) {
    return { start: firstIdx, end: firstIdx + anchorText.length }
  }

  return null
}

/**
 * Convert a character offset in the plain-text content to a ProseMirror document position.
 * ProseMirror positions include structural offsets (for nodes like paragraphs, headings, etc.),
 * so we walk the doc's text nodes to find the mapping.
 */
function charOffsetToDocPos(doc: any, charOffset: number): number {
  let accumulated = 0
  let result = -1

  doc.descendants((node: any, pos: number) => {
    if (result !== -1) return false // already found
    if (node.isText) {
      const len = node.text!.length
      if (accumulated + len > charOffset) {
        // The target is within this text node
        result = pos + (charOffset - accumulated)
        return false
      }
      accumulated += len
    }
    return true
  })

  // If charOffset is exactly at the end
  if (result === -1 && accumulated === charOffset) {
    result = doc.content.size
  }

  return result
}

function buildDecorations(
  doc: any,
  comments: InlineComment[],
  activeId: string | null,
): DecorationSet {
  const fullText = doc.textContent || ''
  if (!fullText) return DecorationSet.empty

  const decorations: Decoration[] = []

  for (const comment of comments) {
    if (comment.is_resolved) continue

    const pos = findAnchorPosition(
      fullText,
      comment.anchor_text,
      comment.anchor_prefix,
      comment.anchor_suffix,
      comment.anchor_occurrence,
    )
    if (!pos) continue

    const from = charOffsetToDocPos(doc, pos.start)
    const to = charOffsetToDocPos(doc, pos.end)
    if (from === -1 || to === -1 || from >= to) continue

    const isActive = comment.id === activeId
    decorations.push(
      Decoration.inline(from, to, {
        class: isActive
          ? 'comment-highlight comment-highlight-active'
          : 'comment-highlight',
        'data-comment-id': comment.id,
      }),
    )
  }

  return DecorationSet.create(doc, decorations)
}

export interface CommentHighlightOptions {
  onHighlightClick?: (commentId: string) => void
}

export const CommentHighlightExtension = Extension.create<CommentHighlightOptions>({
  name: 'commentHighlights',

  addOptions() {
    return {
      onHighlightClick: undefined,
    }
  },

  addProseMirrorPlugins() {
    const extensionThis = this

    return [
      new Plugin({
        key: COMMENT_HIGHLIGHT_PLUGIN_KEY,
        state: {
          init() {
            return {
              decorations: DecorationSet.empty,
              comments: [] as InlineComment[],
              activeId: null as string | null,
            }
          },
          apply(tr, value, _oldState, newState) {
            const meta = tr.getMeta(COMMENT_HIGHLIGHT_PLUGIN_KEY) as HighlightMeta | undefined
            if (meta?.type === 'setComments') {
              return {
                comments: meta.comments,
                activeId: meta.activeId,
                decorations: buildDecorations(newState.doc, meta.comments, meta.activeId),
              }
            }
            // Map decorations on document change
            if (tr.docChanged) {
              return {
                ...value,
                decorations: buildDecorations(newState.doc, value.comments, value.activeId),
              }
            }
            return value
          },
        },
        props: {
          decorations(state) {
            return COMMENT_HIGHLIGHT_PLUGIN_KEY.getState(state)?.decorations || DecorationSet.empty
          },
          handleClick(view, pos, event) {
            const target = event.target as HTMLElement
            const commentEl = target.closest?.('[data-comment-id]') as HTMLElement | null
            if (commentEl?.dataset.commentId) {
              extensionThis.options.onHighlightClick?.(commentEl.dataset.commentId)
              return true
            }
            return false
          },
        },
      }),
    ]
  },
})

/**
 * Dispatch a transaction to update comment highlights in the editor.
 */
export function setEditorComments(
  editor: any,
  comments: InlineComment[],
  activeId: string | null,
) {
  if (!editor?.view) return
  // Ensure plugin is registered before dispatching
  const pluginState = COMMENT_HIGHLIGHT_PLUGIN_KEY.getState(editor.view.state)
  if (pluginState === undefined) return

  const tr = editor.view.state.tr.setMeta(COMMENT_HIGHLIGHT_PLUGIN_KEY, {
    type: 'setComments',
    comments,
    activeId,
  } as HighlightMeta)
  editor.view.dispatch(tr)
}

/**
 * Scroll the editor view to show the highlight for a specific comment.
 */
function scrollEditorToComment(editor: any, commentId: string) {
  if (!editor?.view) return
  const el = editor.view.dom.querySelector(`[data-comment-id="${commentId}"]`)
  if (el) {
    const rect = el.getBoundingClientRect()
    const targetY = window.scrollY + rect.top - 120
    window.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' })
  }
}
