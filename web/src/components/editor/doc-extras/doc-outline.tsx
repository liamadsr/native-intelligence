'use client'

/**
 * A document's outline (docs/plans/doc-editor-extras.md, phase 1): its
 * top-level headings (H1–H3) down the side, once it has three or more. A click
 * opens any fold hiding the heading, scrolls to it and puts the caret there;
 * the heading being read is marked as the text scrolls.
 */
import { useCallback, useEffect, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { cn } from '@/lib/utils'
import { listHeadings, revealPos, type HeadingInfo } from './heading-fold'

/** The headings an outline lists: top-level H1–H3. Pure. */
export function outlineHeadings(headings: readonly HeadingInfo[]): HeadingInfo[] {
  return headings.filter((h) => h.level <= 3 && h.text.length > 0)
}

/** An outline shows from this many headings up. */
export const OUTLINE_MIN_HEADINGS = 3

/** Re-render with the editor's document: its headings, after every change. */
function useHeadings(editor: Editor | null): HeadingInfo[] {
  const [headings, setHeadings] = useState<HeadingInfo[]>(() => (editor ? outlineHeadings(listHeadings(editor.state.doc)) : []))
  useEffect(() => {
    if (!editor) {
      setHeadings([])
      return
    }
    let last = ''
    const read = () => {
      if (editor.isDestroyed) return
      const next = outlineHeadings(listHeadings(editor.state.doc))
      const sig = next.map((h) => `${h.pos}:${h.level}:${h.key}`).join('|')
      if (sig === last) return
      last = sig
      setHeadings(next)
    }
    read()
    editor.on('update', read)
    editor.on('create', read)
    // A setContent from outside (another person's edit) doesn't emit 'update'.
    editor.on('transaction', read)
    return () => {
      editor.off('update', read)
      editor.off('create', read)
      editor.off('transaction', read)
    }
  }, [editor])
  return headings
}

/** The heading being read: the last one whose top has scrolled past the top of the view. */
function useActiveHeading(editor: Editor | null, headings: readonly HeadingInfo[]): string | null {
  const [active, setActive] = useState<string | null>(null)
  useEffect(() => {
    if (!editor || headings.length === 0) return
    let frame = 0
    const measure = () => {
      frame = 0
      if (editor.isDestroyed) return
      let current: string | null = headings[0]?.key ?? null
      for (const h of headings) {
        const dom = editor.view.nodeDOM(h.pos)
        if (!(dom instanceof HTMLElement) || dom.offsetParent === null) continue
        if (dom.getBoundingClientRect().top <= 140) current = h.key
        else break
      }
      setActive(current)
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    measure()
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('scroll', onScroll, true)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [editor, headings])
  return active
}

export function DocumentOutline({ editor, className }: { editor: Editor | null; className?: string }) {
  const headings = useHeadings(editor)
  const active = useActiveHeading(editor, headings)

  const jump = useCallback(
    (h: HeadingInfo) => {
      if (!editor || editor.isDestroyed) return
      const view = editor.view
      revealPos(view, h.pos)
      // After the fold opens (the next frame), the heading has a box to scroll to.
      requestAnimationFrame(() => {
        if (editor.isDestroyed) return
        const dom = editor.view.nodeDOM(h.pos)
        if (dom instanceof HTMLElement) dom.scrollIntoView({ block: 'start', behavior: 'smooth' })
        const node = editor.state.doc.nodeAt(h.pos)
        if (node && editor.isEditable) {
          editor.chain().setTextSelection(h.pos + node.nodeSize - 1).focus(undefined, { scrollIntoView: false }).run()
        }
      })
    },
    [editor],
  )

  if (headings.length < OUTLINE_MIN_HEADINGS) return null
  const top = Math.min(...headings.map((h) => h.level))

  return (
    <nav aria-label="Outline" className={cn('text-xs', className)}>
      <p className="mb-2 px-2 font-medium text-muted-foreground">Outline</p>
      <ol className="flex flex-col gap-px">
        {headings.map((h) => (
          <li key={`${h.key}:${h.pos}`}>
            <button
              type="button"
              onClick={() => jump(h)}
              aria-current={active === h.key ? 'location' : undefined}
              style={{ paddingLeft: `${0.5 + (h.level - top) * 0.75}rem` }}
              className={cn(
                'block w-full truncate rounded-md py-1 pr-2 text-left transition-colors',
                active === h.key ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
              )}
              title={h.text}
            >
              {h.text}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
}
