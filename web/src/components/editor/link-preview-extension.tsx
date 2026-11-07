'use client'

import { Node, mergeAttributes } from '@tiptap/core'
import { copyTextToClipboard } from '@/lib/clipboard'
import { openUrlForClick } from '@/lib/open-external'
import { ReactNodeViewRenderer, NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react'
import { TextSelection, NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state'
import { useEffect, useState, useCallback } from 'react'
import { Copy, Check, Globe, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'

// --- React Component ---

interface LinkMeta {
  title: string
  description: string | null
  image: string | null
  favicon: string | null
  domain: string
  url: string
}

const metaCache = new Map<string, LinkMeta>()

export function LinkPreviewComponent(props: ReactNodeViewProps) {
  const { node, editor, getPos } = props
  const url = node.attrs.url as string
  const [meta, setMeta] = useState<LinkMeta | null>(metaCache.get(url) || null)
  const [loading, setLoading] = useState(!metaCache.has(url))
  const [copied, setCopied] = useState(false)
  const [imgError, setImgError] = useState(false)

  useEffect(() => {
    if (metaCache.has(url)) {
      setMeta(metaCache.get(url)!)
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)

    fetch('/api/account/link-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: LinkMeta | null) => {
        if (cancelled || !data) return
        metaCache.set(url, data)
        setMeta(data)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [url])

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    copyTextToClipboard(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const getNodePos = useCallback(() => {
    return typeof getPos === 'function' ? getPos() : null
  }, [getPos])

  const deleteNode = useCallback(() => {
    const pos = getNodePos()
    if (pos == null) return
    const { state } = editor
    const tr = state.tr.delete(pos, pos + node.nodeSize)
    if (tr.doc.content.size === 0) {
      tr.insert(0, state.schema.nodes.paragraph.create())
    }
    editor.view.dispatch(tr)
    editor.view.focus()
  }, [editor, getNodePos, node])

  const domain = meta?.domain || (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      return url
    }
  })()

  return (
    <NodeViewWrapper className="my-1.5" data-link-preview>
      <div
        className="group inline-block max-w-sm cursor-pointer rounded-md border bg-card px-2.5 pt-1.5 pb-1 select-none transition-colors hover:bg-muted/40"
        contentEditable={false}
        title={url}
        data-link-preview-open
        onMouseDown={(e) => {
          if (!(e.target as HTMLElement).closest('button')) {
            e.stopPropagation()
          }
        }}
        onClick={(e) => {
          // The card opens its link; Copy and Remove do their own thing.
          if ((e.target as HTMLElement).closest('button')) return
          e.preventDefault()
          void openUrlForClick(url, e)
        }}
      >
        {/* Top row: favicon + title */}
        <div className="flex items-center gap-1.5">
          <div className="flex h-4 w-4 shrink-0 items-center justify-center">
            {loading ? (
              <div className="h-4 w-4 animate-pulse rounded bg-muted" />
            ) : meta?.favicon ? (
              <img
                src={meta.favicon}
                alt=""
                className="h-4 w-4 rounded-sm"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
              />
            ) : (
              <Globe className="h-3.5 w-3.5 text-muted-foreground/50" />
            )}
          </div>
          <p className="min-w-0 flex-1 truncate text-[13px] font-medium leading-none text-foreground group-hover:underline underline-offset-2">
            {loading ? '' : (meta?.title || domain)}
          </p>
        </div>
        {/* Bottom row: domain + actions */}
        <div className="mt-1 flex items-center justify-between pl-[22px]">
          {!loading ? (
            <p className="min-w-0 truncate text-[11px] leading-none text-muted-foreground/50">
              {domain}
            </p>
          ) : <span />}
          <div className="flex shrink-0 items-center">
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={handleCopy}
              className="rounded p-1 text-muted-foreground/40 transition-colors hover:bg-muted hover:text-foreground"
              title="Copy URL"
            >
              {copied ? (
                <Check className="h-3 w-3 text-green-500" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </button>
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.preventDefault(); deleteNode() }}
              className="rounded p-1 text-muted-foreground/40 transition-colors hover:bg-muted hover:text-destructive"
              title="Remove"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        </div>
      </div>
    </NodeViewWrapper>
  )
}

// --- TipTap Node Extension ---

// Plugin that protects linkPreview nodes from being replaced by typing.
// When the cursor/selection is at a linkPreview position, typing creates
// a new paragraph below instead of replacing the node.
const linkPreviewGuardPlugin = new Plugin({
  key: new PluginKey('linkPreviewGuard'),
  props: {
    handleTextInput(view, _from, _to, _text) {
      const { state } = view
      const { selection } = state
      // Check if selection is a NodeSelection on a linkPreview
      if (selection instanceof NodeSelection && selection.node.type.name === 'linkPreview') {
        const pos = selection.from + selection.node.nodeSize
        const tr = state.tr
        const paragraph = state.schema.nodes.paragraph.create(
          null,
          state.schema.text(_text),
        )
        // Insert a new paragraph after the link preview
        if (pos >= state.doc.content.size) {
          tr.insert(pos, paragraph)
        } else {
          tr.insert(pos, paragraph)
        }
        // Place cursor at end of the new text
        tr.setSelection(TextSelection.create(tr.doc, pos + _text.length + 1))
        view.dispatch(tr)
        return true
      }
      return false
    },
    handleKeyDown(view, event) {
      const { state } = view
      const { selection } = state

      if (!(selection instanceof NodeSelection) || selection.node.type.name !== 'linkPreview') {
        return false
      }

      const nodePos = selection.from
      const nodeSize = selection.node.nodeSize

      // Enter: create paragraph below and move cursor there
      if (event.key === 'Enter') {
        const pos = nodePos + nodeSize
        const tr = state.tr.insert(pos, state.schema.nodes.paragraph.create())
        tr.setSelection(TextSelection.create(tr.doc, pos + 1))
        view.dispatch(tr)
        return true
      }

      // Backspace/Delete: remove the link preview node
      if (event.key === 'Backspace' || event.key === 'Delete') {
        const tr = state.tr.delete(nodePos, nodePos + nodeSize)
        if (tr.doc.content.size === 0) {
          tr.insert(0, state.schema.nodes.paragraph.create())
        }
        view.dispatch(tr)
        return true
      }

      // Arrow down: move cursor to paragraph below (create one if needed)
      if (event.key === 'ArrowDown') {
        const afterPos = nodePos + nodeSize
        const tr = state.tr
        if (afterPos >= state.doc.content.size) {
          tr.insert(afterPos, state.schema.nodes.paragraph.create())
        }
        tr.setSelection(TextSelection.create(tr.doc, afterPos + 1))
        view.dispatch(tr)
        return true
      }

      // Arrow up: move cursor to paragraph above (create one if needed)
      if (event.key === 'ArrowUp') {
        const tr = state.tr
        if (nodePos === 0) {
          tr.insert(0, state.schema.nodes.paragraph.create())
          tr.setSelection(TextSelection.create(tr.doc, 1))
        } else {
          tr.setSelection(TextSelection.create(tr.doc, nodePos - 1))
        }
        view.dispatch(tr)
        return true
      }

      return false
    },
  },
})

export const LinkPreviewNode = Node.create({
  name: 'linkPreview',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true, // Allow selection so we can intercept it with the guard plugin

  addAttributes() {
    return {
      url: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-url'),
        renderHTML: (attributes) => ({ 'data-url': attributes.url }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-link-preview]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-link-preview': '' })]
  },

  addNodeView() {
    return ReactNodeViewRenderer(LinkPreviewComponent)
  },

  addProseMirrorPlugins() {
    return [linkPreviewGuardPlugin]
  },
})
