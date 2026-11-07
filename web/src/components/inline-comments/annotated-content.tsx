'use client'

import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { useInlineComments } from './inline-comment-context'
import { useTextAnchoring } from './use-text-anchoring'
import type { ContentSection } from './types'

export function AnnotatedContent({
  children,
  section,
  className,
}: {
  children: ReactNode
  section: ContentSection
  className?: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const {
    comments,
    activeCommentId,
    setActiveComment,
    setSelectionState,
    setActiveSection,
    setHighlightPositions,
    scrollTarget,
  } = useInlineComments()

  // Filter comments for this section
  const sectionComments = comments.filter((c) => c.anchor_section === section)

  const onHighlightClick = useCallback(
    (commentId: string) => {
      setActiveComment(commentId)
    },
    [setActiveComment],
  )

  const prevPositionsRef = useRef<string>('')
  const onPositionsUpdate = useCallback(
    (positions: Map<string, number>) => {
      const key = JSON.stringify([...positions.entries()])
      if (key !== prevPositionsRef.current) {
        prevPositionsRef.current = key
        setHighlightPositions(positions)
      }
    },
    [setHighlightPositions],
  )

  // Only apply DOM-based highlights for non-ProseMirror content.
  // ProseMirror editors use CommentableEditor + Tiptap decorations instead.
  const hasProseMirror = useRef(false)
  useEffect(() => {
    hasProseMirror.current = !!containerRef.current?.querySelector('.ProseMirror')
  })

  const { scrollToHighlight } = useTextAnchoring(
    containerRef,
    // Pass empty array if container has ProseMirror — decorations handle it
    hasProseMirror.current ? [] : sectionComments,
    activeCommentId,
    onHighlightClick,
    onPositionsUpdate,
  )

  // Set active section when this content is visible
  useEffect(() => {
    setActiveSection(section)
  }, [section, setActiveSection])

  // Scroll to highlight when requested via sidebar (for non-editor content)
  useEffect(() => {
    if (!scrollTarget) return
    const isInThisSection = sectionComments.some((c) => c.id === scrollTarget)
    if (isInThisSection && !hasProseMirror.current) {
      setTimeout(() => scrollToHighlight(scrollTarget), 50)
    }
  }, [scrollTarget, sectionComments, scrollToHighlight])

  // Handle text selection (only for non-ProseMirror content)
  useEffect(() => {
    function handleMouseUp() {
      setTimeout(() => {
        const container = containerRef.current
        if (!container) return

        const sel = window.getSelection()
        if (!sel || sel.isCollapsed || !sel.rangeCount) return

        const range = sel.getRangeAt(0)

        const startNode = range.startContainer
        const endNode = range.endContainer
        if (!container.contains(startNode) && !container.contains(endNode)) return

        // Don't show comment popover when selecting inside a ProseMirror editor
        // (the editor's bubble menu handles commenting instead).
        const startEl = startNode instanceof Element ? startNode : startNode.parentElement
        const endEl = endNode instanceof Element ? endNode : endNode.parentElement
        if (startEl?.closest('.ProseMirror') || endEl?.closest('.ProseMirror')) return

        const selectedText = sel.toString().trim()
        if (!selectedText || selectedText.length < 2) return

        const fullText = container.textContent || ''

        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
        let charOffset = 0
        let selStart = -1
        let node = walker.nextNode()

        while (node) {
          const textNode = node as Text
          const len = (textNode.textContent || '').length

          if (range.startContainer === textNode) {
            selStart = charOffset + range.startOffset
            break
          } else if (range.startContainer.contains(textNode) && selStart === -1) {
            if (range.startContainer.nodeType === Node.ELEMENT_NODE) {
              const children = Array.from(range.startContainer.childNodes)
              const targetChild = children[range.startOffset]
              if (targetChild === textNode || targetChild?.contains(textNode)) {
                selStart = charOffset
                break
              }
            }
          }

          charOffset += len
          node = walker.nextNode()
        }

        if (selStart === -1) {
          selStart = fullText.indexOf(selectedText)
        }
        if (selStart === -1) selStart = 0

        const prefix = selStart > 0 ? fullText.slice(Math.max(0, selStart - 50), selStart) : ''
        const suffix = fullText.slice(
          selStart + selectedText.length,
          Math.min(fullText.length, selStart + selectedText.length + 50),
        )

        let occurrenceIndex = 0
        let searchPos = 0
        while (searchPos < selStart) {
          const idx = fullText.indexOf(selectedText, searchPos)
          if (idx === -1 || idx >= selStart) break
          occurrenceIndex++
          searchPos = idx + 1
        }

        const rect = range.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) return

        setSelectionState({
          text: selectedText.slice(0, 1000),
          prefix,
          suffix,
          section,
          occurrenceIndex,
          rect,
        })
      }, 20)
    }

    document.addEventListener('mouseup', handleMouseUp)
    return () => document.removeEventListener('mouseup', handleMouseUp)
  }, [section, setSelectionState])

  return (
    <div ref={containerRef} className={className} data-annotated-content>
      {children}
    </div>
  )
}
