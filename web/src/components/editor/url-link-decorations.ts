/**
 * UrlLinkDecorations — links in the editor read and click as links:
 *
 *  • Bare URLs are drawn as links ("Register: https://partiful.com/e/…" in a
 *    document an agent wrote), without changing the document. A URL only
 *    becomes a link MARK when it's typed and followed by a space, or pasted with
 *    other text (TipTap's Link autolink); text loaded from markdown, an agent's
 *    edit or a synced change never goes through that, so its URLs stayed plain.
 *    Each is drawn as an <a href target=_blank>, the element a link mark
 *    renders. Pure decoration (Decoration.inline), like the identifier
 *    underlines (components/entity-refs/entity-ref-tiptap.ts): the saved
 *    markdown, undo history and the read-aloud text never see it. Skips text
 *    already in a link mark, inline code and code blocks. Rebuilt on a doc
 *    change only; a text node without "://" costs one substring check.
 *
 *  • A click on a link while editing (a link mark or a drawn URL) opens it in
 *    the user's browser, or a new tab on the web (noopener). TipTap's own click
 *    handler is off (note-editor.tsx: openOnClick false): its window.open passes
 *    no noopener, so the opened page could reach back into the app. The click
 *    is taken whole — default prevented, and the anchor's target hidden for it,
 *    so the desktop shell's script on <body> doesn't open it too (as
 *    chat-file-part.tsx does). A read-only editor leaves its links to the
 *    browser, like any other link.
 */

import { Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { findUrls } from '@/lib/linkify'
import { hideTarget, isOpenableUrl, openUrlForClick } from '@/lib/open-external'

/** How a link reads in the editor: link marks (note-editor.tsx) and these. */
export const EDITOR_LINK_CLASS =
  'text-muted-foreground underline underline-offset-[3px] hover:text-primary transition-colors cursor-pointer'

/** Marks a decorated URL's element (tests, and anything that must tell it from a link mark). */
export const URL_LINK_ATTR = 'data-url-link'

export const URL_LINK_DECORATIONS_KEY = new PluginKey<DecorationSet>('urlLinkDecorations')

function buildDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    // Code blocks are verbatim.
    if (node.type.spec.code) return false
    if (!node.isText || !node.text || !node.text.includes('://')) return undefined
    // Already a link, or inline code (PM splits text runs on mark boundaries,
    // so the whole node carries the mark).
    if (node.marks.some((m) => m.type.name === 'link' || m.type.name === 'code')) return undefined
    for (const match of findUrls(node.text)) {
      decorations.push(
        Decoration.inline(pos + match.start, pos + match.end, {
          nodeName: 'a',
          href: match.url,
          target: '_blank',
          rel: 'noopener noreferrer nofollow',
          class: EDITOR_LINK_CLASS,
          [URL_LINK_ATTR]: '',
        }),
      )
    }
    return undefined
  })
  return decorations.length ? DecorationSet.create(doc, decorations) : DecorationSet.empty
}

/** The link a click in the editor's text is on, if any. */
function anchorIn(dom: HTMLElement, target: EventTarget | null): HTMLAnchorElement | null {
  const el = target instanceof Element ? target : (target as Node | null)?.parentElement ?? null
  const a = el?.closest?.('a[href]') as HTMLAnchorElement | null
  return a && dom.contains(a) ? a : null
}

export const UrlLinkDecorations = Extension.create({
  name: 'urlLinkDecorations',

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: URL_LINK_DECORATIONS_KEY,
        state: {
          init: (_config, state) => buildDecorations(state.doc),
          apply: (tr, old) => (tr.docChanged ? buildDecorations(tr.doc) : old),
        },
        props: {
          decorations: (state) => URL_LINK_DECORATIONS_KEY.getState(state),
          handleDOMEvents: {
            click: (view, event) => {
              if (!view.editable || event.button !== 0 || event.defaultPrevented || event.ctrlKey) return false
              const a = anchorIn(view.dom, event.target)
              if (!a) return false
              const href = a.getAttribute('href') ?? ''
              if (href.startsWith('mailto:')) {
                event.preventDefault()
                window.location.href = href
                return true
              }
              if (!isOpenableUrl(href)) return false
              event.preventDefault()
              const restore = hideTarget(a)
              if (restore) setTimeout(restore, 0)
              void openUrlForClick(href, event)
              return true
            },
          },
        },
      }),
    ]
  },
})

export default UrlLinkDecorations
