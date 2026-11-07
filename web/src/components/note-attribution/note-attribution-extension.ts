import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export interface NoteAttribution {
  id: string
  original_note: string
  enhanced_text: string
}

const NOTE_ATTRIBUTION_PLUGIN_KEY = new PluginKey('noteAttributions')

interface AttributionMeta {
  type: 'setAttributions'
  attributions: NoteAttribution[]
  activeId: string | null
}

/**
 * Convert a character offset in the plain-text content to a ProseMirror document position.
 */
function charOffsetToDocPos(doc: any, charOffset: number): number {
  let accumulated = 0
  let result = -1

  doc.descendants((node: any, pos: number) => {
    if (result !== -1) return false
    if (node.isText) {
      const len = node.text!.length
      if (accumulated + len > charOffset) {
        result = pos + (charOffset - accumulated)
        return false
      }
      accumulated += len
    }
    return true
  })

  if (result === -1 && accumulated === charOffset) {
    result = doc.content.size
  }

  return result
}

/**
 * Find the position of enhanced_text in the document's plain text.
 * Uses prefix matching — the AI outputs the first ~80 chars of the paragraph.
 */
function findAttributionPosition(
  fullText: string,
  enhancedText: string,
): { start: number; end: number } | null {
  if (!enhancedText) return null

  // Direct substring match
  const idx = fullText.indexOf(enhancedText)
  if (idx !== -1) {
    return { start: idx, end: idx + enhancedText.length }
  }

  // Try a shorter prefix (first 40 chars) for more resilient matching
  if (enhancedText.length > 40) {
    const shortPrefix = enhancedText.slice(0, 40)
    const shortIdx = fullText.indexOf(shortPrefix)
    if (shortIdx !== -1) {
      // Extend to end of the line/paragraph for a natural highlight range
      const lineEnd = fullText.indexOf('\n', shortIdx)
      const end = lineEnd !== -1 ? lineEnd : shortIdx + enhancedText.length
      return { start: shortIdx, end: Math.min(end, fullText.length) }
    }
  }

  return null
}

function buildDecorations(
  doc: any,
  attributions: NoteAttribution[],
  activeId: string | null,
): DecorationSet {
  const fullText = doc.textContent || ''
  if (!fullText || attributions.length === 0) return DecorationSet.empty

  const decorations: Decoration[] = []

  for (const attr of attributions) {
    const pos = findAttributionPosition(fullText, attr.enhanced_text)
    if (!pos) continue

    const from = charOffsetToDocPos(doc, pos.start)
    const to = charOffsetToDocPos(doc, pos.end)
    if (from === -1 || to === -1 || from >= to) continue

    const isActive = attr.id === activeId
    decorations.push(
      Decoration.inline(from, to, {
        class: isActive
          ? 'note-attribution note-attribution-active'
          : 'note-attribution',
        'data-attribution-id': attr.id,
        'data-original-note': attr.original_note,
      }),
    )
  }

  return DecorationSet.create(doc, decorations)
}

export interface NoteAttributionOptions {
  onAttributionClick?: (attributionId: string) => void
}

export const NoteAttributionExtension = Extension.create<NoteAttributionOptions>({
  name: 'noteAttributions',

  addOptions() {
    return {
      onAttributionClick: undefined,
    }
  },

  addProseMirrorPlugins() {
    const extensionThis = this

    return [
      new Plugin({
        key: NOTE_ATTRIBUTION_PLUGIN_KEY,
        state: {
          init() {
            return {
              decorations: DecorationSet.empty,
              attributions: [] as NoteAttribution[],
              activeId: null as string | null,
            }
          },
          apply(tr, value, _oldState, newState) {
            const meta = tr.getMeta(NOTE_ATTRIBUTION_PLUGIN_KEY) as AttributionMeta | undefined
            if (meta?.type === 'setAttributions') {
              return {
                attributions: meta.attributions,
                activeId: meta.activeId,
                decorations: buildDecorations(newState.doc, meta.attributions, meta.activeId),
              }
            }
            if (tr.docChanged) {
              return {
                ...value,
                decorations: buildDecorations(newState.doc, value.attributions, value.activeId),
              }
            }
            return value
          },
        },
        props: {
          decorations(state) {
            return NOTE_ATTRIBUTION_PLUGIN_KEY.getState(state)?.decorations || DecorationSet.empty
          },
          handleClick(view, pos, event) {
            const target = event.target as HTMLElement
            const attrEl = target.closest?.('[data-attribution-id]') as HTMLElement | null
            if (attrEl?.dataset.attributionId) {
              extensionThis.options.onAttributionClick?.(attrEl.dataset.attributionId)
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
 * Dispatch a transaction to update note attribution decorations in the editor.
 */
export function setEditorAttributions(
  editor: any,
  attributions: NoteAttribution[],
  activeId: string | null,
) {
  if (!editor?.view) return
  const pluginState = NOTE_ATTRIBUTION_PLUGIN_KEY.getState(editor.view.state)
  if (pluginState === undefined) return

  const tr = editor.view.state.tr.setMeta(NOTE_ATTRIBUTION_PLUGIN_KEY, {
    type: 'setAttributions',
    attributions,
    activeId,
  } as AttributionMeta)
  editor.view.dispatch(tr)
}
