'use client'

import { useCallback, useEffect, useRef } from 'react'
import type { InlineComment } from './types'

interface TextNodeEntry {
  node: Text
  start: number
  end: number
}

function findNthOccurrence(text: string, search: string, n: number): number {
  let idx = -1
  let count = 0
  let pos = 0
  while (pos < text.length) {
    idx = text.indexOf(search, pos)
    if (idx === -1) return -1
    if (count === n) return idx
    count++
    pos = idx + 1
  }
  return -1
}

function buildTextNodeMap(container: HTMLElement): { fullText: string; entries: TextNodeEntry[] } {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const entries: TextNodeEntry[] = []
  let fullText = ''

  let node = walker.nextNode()
  while (node) {
    const textNode = node as Text
    const content = textNode.textContent || ''
    entries.push({ node: textNode, start: fullText.length, end: fullText.length + content.length })
    fullText += content
    node = walker.nextNode()
  }

  return { fullText, entries }
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

  // Strategy 3: First occurrence as last resort
  const firstIdx = fullText.indexOf(anchorText)
  if (firstIdx !== -1) {
    return { start: firstIdx, end: firstIdx + anchorText.length }
  }

  return null
}

function wrapRange(
  entries: TextNodeEntry[],
  rangeStart: number,
  rangeEnd: number,
  commentId: string,
  isActive: boolean,
): HTMLElement[] {
  const marks: HTMLElement[] = []

  for (const entry of entries) {
    if (entry.end <= rangeStart || entry.start >= rangeEnd) continue

    const nodeStart = Math.max(0, rangeStart - entry.start)
    const nodeEnd = Math.min(entry.node.textContent!.length, rangeEnd - entry.start)

    const textNode = entry.node
    const parent = textNode.parentNode
    if (!parent) continue

    if (
      parent instanceof HTMLElement &&
      parent.tagName === 'MARK' &&
      parent.dataset.commentId === commentId
    ) {
      continue
    }

    const before = textNode.textContent!.slice(0, nodeStart)
    const highlighted = textNode.textContent!.slice(nodeStart, nodeEnd)
    const after = textNode.textContent!.slice(nodeEnd)

    const mark = document.createElement('mark')
    mark.dataset.commentId = commentId
    mark.textContent = highlighted
    if (isActive) mark.classList.add('active')

    const frag = document.createDocumentFragment()
    if (before) frag.appendChild(document.createTextNode(before))
    frag.appendChild(mark)
    if (after) frag.appendChild(document.createTextNode(after))

    parent.replaceChild(frag, textNode)
    marks.push(mark)
  }

  return marks
}

function clearHighlights(container: HTMLElement) {
  const marks = container.querySelectorAll('mark[data-comment-id]')
  marks.forEach((mark) => {
    const parent = mark.parentNode
    if (!parent) return
    const text = document.createTextNode(mark.textContent || '')
    parent.replaceChild(text, mark)
    parent.normalize()
  })
}

export function useTextAnchoring(
  containerRef: React.RefObject<HTMLElement | null>,
  comments: InlineComment[],
  activeCommentId: string | null,
  onHighlightClick: (commentId: string) => void,
  onPositionsUpdate?: (positions: Map<string, number>) => void,
) {
  const markElementsRef = useRef<Map<string, HTMLElement[]>>(new Map())
  const onPositionsUpdateRef = useRef(onPositionsUpdate)
  onPositionsUpdateRef.current = onPositionsUpdate

  const applyHighlights = useCallback(() => {
    const container = containerRef.current
    if (!container) return

    clearHighlights(container)
    markElementsRef.current.clear()

    const { fullText, entries } = buildTextNodeMap(container)
    if (!fullText) return

    const positioned = comments
      .filter((c) => !c.is_resolved)
      .map((c) => ({
        comment: c,
        position: findAnchorPosition(
          fullText,
          c.anchor_text,
          c.anchor_prefix,
          c.anchor_suffix,
          c.anchor_occurrence,
        ),
      }))
      .filter((p) => p.position !== null)
      .sort((a, b) => a.position!.start - b.position!.start)

    for (let i = positioned.length - 1; i >= 0; i--) {
      const { comment } = positioned[i]
      const currentMap = buildTextNodeMap(container)
      const currentPos = findAnchorPosition(
        currentMap.fullText,
        comment.anchor_text,
        comment.anchor_prefix,
        comment.anchor_suffix,
        comment.anchor_occurrence,
      )
      if (!currentPos) continue

      const isActive = comment.id === activeCommentId
      const marks = wrapRange(
        currentMap.entries,
        currentPos.start,
        currentPos.end,
        comment.id,
        isActive,
      )
      markElementsRef.current.set(comment.id, marks)
    }

    const positions = new Map<string, number>()
    const containerRect = container.getBoundingClientRect()

    container.querySelectorAll('mark[data-comment-id]').forEach((mark) => {
      const el = mark as HTMLElement
      el.addEventListener('click', () => {
        const commentId = el.dataset.commentId
        if (commentId) onHighlightClick(commentId)
      })

      const commentId = el.dataset.commentId
      if (commentId && !positions.has(commentId)) {
        const markRect = el.getBoundingClientRect()
        positions.set(commentId, markRect.top - containerRect.top)
      }
    })

    onPositionsUpdateRef.current?.(positions)
  }, [containerRef, comments, activeCommentId, onHighlightClick])

  useEffect(() => {
    applyHighlights()
  }, [applyHighlights])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    container.querySelectorAll('mark[data-comment-id]').forEach((mark) => {
      const el = mark as HTMLElement
      if (el.dataset.commentId === activeCommentId) {
        el.classList.add('active')
      } else {
        el.classList.remove('active')
      }
    })
  }, [activeCommentId, containerRef])

  const scrollToHighlight = useCallback(
    (commentId: string) => {
      const container = containerRef.current
      if (!container) return
      const mark = container.querySelector(`mark[data-comment-id="${commentId}"]`)
      if (mark) {
        const markRect = mark.getBoundingClientRect()
        const targetY = window.scrollY + markRect.top - 120
        window.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' })
      }
    },
    [containerRef],
  )

  return { applyHighlights, scrollToHighlight, markElementsRef }
}
