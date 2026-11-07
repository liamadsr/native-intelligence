/**
 * EntityRefDecorations — a TipTap/ProseMirror extension that underlines action
 * identifiers (GEN-297, …) in a document and opens the quick-edit popover when
 * one is clicked, WITHOUT changing the document content.
 *
 * It is pure decoration (Decoration.inline): the identifiers stay ordinary
 * text, so the markdown the editor saves is untouched and undo history never
 * sees these. Only identifiers that RESOLVE to a real action are decorated;
 * resolution runs through the same module-level batcher the chips use, and the
 * plugin re-runs its decorations via a meta-only transaction as the cache
 * fills. Text inside code marks, code blocks, links and bare URLs is skipped.
 *
 * Register it for DOCUMENTS only (document-detail-panel.tsx), not the capture
 * page. The click handler reports the identifier and the clicked element's
 * rect to `onEntityRefClick`; a React host in the panel renders the popover
 * anchored there.
 */

import { Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import {
  getEntityRefState,
  requestEntityRef,
  subscribeEntityRefs,
} from './entity-ref-batcher'
import { findUrls } from '@/lib/linkify'
import { findEntityRefRanges } from './entity-ref-decorations'

export interface EntityRefDecorationsOptions {
  /** Called when a decorated identifier is clicked. `rect` is viewport-relative
   *  (getBoundingClientRect of the clicked span) so a host can anchor a popover. */
  onEntityRefClick: (identifier: string, rect: DOMRect) => void
}

export const ENTITY_REF_DECORATIONS_KEY = new PluginKey<DecorationSet>('entityRefDecorations')

/** Meta flag: rebuild decorations (cache filled) without a doc change. */
const REBUILD = Symbol('entity-ref-rebuild')

/** Does this node's content read as code (a code block / fenced block)? */
function isCodeBlock(node: PMNode): boolean {
  return node.type.spec.code === true
}

/** Build the decoration set from everything in the doc that resolves. Requests
 *  any not-yet-seen identifier through the batcher as a side effect. */
function buildDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = []

  doc.descendants((node, pos) => {
    // Don't descend into code blocks — their content is verbatim.
    if (isCodeBlock(node)) return false
    if (!node.isText || !node.text) return undefined
    // Skip inline code and links: the whole text node carries the mark (PM
    // splits text runs on mark boundaries). An identifier inside a link or a
    // bare URL (…/browse/GEN-24) is part of the link, which opens on click.
    if (node.marks.some((m) => m.type.name === 'code' || m.type.name === 'link')) return undefined
    const urls = findUrls(node.text)

    for (const range of findEntityRefRanges(node.text, pos)) {
      if (urls.some((u) => range.from < pos + u.end && range.to > pos + u.start)) continue
      requestEntityRef(range.identifier)
      if (getEntityRefState(range.identifier).status === 'found') {
        decorations.push(
          Decoration.inline(range.from, range.to, {
            class: 'entity-ref-decoration',
            'data-entity-ref': range.identifier,
          }),
        )
      }
    }
    return undefined
  })

  return DecorationSet.create(doc, decorations)
}

export const EntityRefDecorations = Extension.create<EntityRefDecorationsOptions>({
  name: 'entityRefDecorations',

  addOptions() {
    return { onEntityRefClick: () => {} }
  },

  addProseMirrorPlugins() {
    const onEntityRefClick = this.options.onEntityRefClick

    return [
      new Plugin<DecorationSet>({
        key: ENTITY_REF_DECORATIONS_KEY,

        state: {
          init: (_config, state) => buildDecorations(state.doc),
          apply(tr, old, _oldState, newState) {
            if (tr.docChanged || tr.getMeta(ENTITY_REF_DECORATIONS_KEY) === REBUILD) {
              return buildDecorations(newState.doc)
            }
            // Positions are stable without a doc change; keep the set as-is.
            return old
          },
        },

        props: {
          decorations: (state) => ENTITY_REF_DECORATIONS_KEY.getState(state),
          handleClick: (_view, _pos, event) => {
            const target = event.target as HTMLElement | null
            const el = target?.closest?.('[data-entity-ref]') as HTMLElement | null
            if (!el) return false
            const identifier = el.getAttribute('data-entity-ref')
            if (!identifier) return false
            onEntityRefClick(identifier, el.getBoundingClientRect())
            return true
          },
        },

        view: (view) => {
          // Re-decorate as identifiers resolve. A meta-only transaction, so the
          // document (and NoteEditor's save) never sees it.
          const unsubscribe = subscribeEntityRefs(() => {
            if (view.isDestroyed) return
            view.dispatch(view.state.tr.setMeta(ENTITY_REF_DECORATIONS_KEY, REBUILD))
          })
          return { destroy: unsubscribe }
        },
      }),
    ]
  },
})

export default EntityRefDecorations
