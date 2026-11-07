'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { LogIn, Send, Loader2, X, MessageSquareQuote, Sparkles } from 'lucide-react'
import { useInlineComments } from './inline-comment-context'

import type { SelectionState } from './types'

/**
 * Apply a temporary highlight to text matching the selection state.
 * Uses the anchor data (text, prefix, suffix) to find the text in the DOM,
 * so it works even after the browser clears the native selection.
 */
function applyTempHighlight(state: SelectionState): (() => void) | null {
  // First try using the live browser selection, but NEVER mutate DOM inside a
  // ProseMirror editor — wrapping nodes there corrupts the editor's position
  // mapping and throws IndexSizeError on the next selection sync. For editor
  // content we rely on Tiptap's decoration system for the real highlight once
  // the comment is submitted, so a missing temp highlight is acceptable.
  const sel = window.getSelection()
  if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0)
    const startEl =
      range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement
    const endEl =
      range.endContainer instanceof Element
        ? range.endContainer
        : range.endContainer.parentElement
    const insideEditor =
      !!startEl?.closest('.ProseMirror') || !!endEl?.closest('.ProseMirror')

    if (!insideEditor) {
      const selectedText = sel.toString().trim()
      if (selectedText && selectedText.length >= 2) {
        const result = highlightRange(range)
        if (result) return result
      }
    }
  }

  // Fallback: find the text in the DOM using anchor data. Only search in
  // annotated-content containers; ProseMirror editors are intentionally
  // excluded for the same reason as above.
  const containers = document.querySelectorAll('[data-annotated-content]')
  for (const container of containers) {
    // If this container IS a ProseMirror (or contains only one), skip it.
    if ((container as HTMLElement).classList.contains('ProseMirror')) continue
    const result = highlightByAnchor(container as HTMLElement, state)
    if (result) return result
  }

  return null
}

function highlightRange(range: Range): (() => void) | null {
  try {
    const mark = document.createElement('mark')
    mark.dataset.pendingComment = 'true'
    range.surroundContents(mark)
    return () => unwrapMark(mark)
  } catch {
    // surroundContents fails across element boundaries — wrap per text node
    return highlightTextNodesInRange(range)
  }
}

function highlightTextNodesInRange(range: Range): (() => void) | null {
  const marks: HTMLElement[] = []
  const walker = document.createTreeWalker(
    range.commonAncestorContainer,
    NodeFilter.SHOW_TEXT,
  )
  const textNodes: Text[] = []
  let node = walker.nextNode()
  while (node) {
    if (range.intersectsNode(node)) textNodes.push(node as Text)
    node = walker.nextNode()
  }

  for (const textNode of textNodes) {
    const nodeRange = document.createRange()
    nodeRange.selectNodeContents(textNode)
    if (textNode === range.startContainer) nodeRange.setStart(textNode, range.startOffset)
    if (textNode === range.endContainer) nodeRange.setEnd(textNode, range.endOffset)
    if (nodeRange.toString().length === 0) continue
    try {
      const mark = document.createElement('mark')
      mark.dataset.pendingComment = 'true'
      nodeRange.surroundContents(mark)
      marks.push(mark)
    } catch { /* skip */ }
  }

  if (marks.length === 0) return null
  return () => marks.forEach(unwrapMark)
}

function highlightByAnchor(container: HTMLElement, state: SelectionState): (() => void) | null {
  const fullText = container.textContent || ''
  if (!fullText) return null

  // Find anchor position using same strategies as useTextAnchoring
  let start = -1
  let end = -1

  // Strategy 1: context match
  if (state.prefix || state.suffix) {
    const searchStr = state.prefix + state.text + state.suffix
    const idx = fullText.indexOf(searchStr)
    if (idx !== -1) {
      start = idx + state.prefix.length
      end = start + state.text.length
    }
  }

  // Strategy 2: nth occurrence
  if (start === -1) {
    let count = 0
    let pos = 0
    while (pos < fullText.length) {
      const idx = fullText.indexOf(state.text, pos)
      if (idx === -1) break
      if (count === state.occurrenceIndex) { start = idx; end = idx + state.text.length; break }
      count++
      pos = idx + 1
    }
  }

  // Strategy 3: first occurrence
  if (start === -1) {
    const idx = fullText.indexOf(state.text)
    if (idx !== -1) { start = idx; end = idx + state.text.length }
  }

  if (start === -1) return null

  // Walk text nodes to find the range. Skip subtrees inside a ProseMirror
  // editor — those are managed by Tiptap and mutating them here corrupts the
  // editor's internal position map.
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parentEl = node.parentElement
      if (parentEl && parentEl.closest('.ProseMirror')) {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })
  let charOffset = 0
  const marks: HTMLElement[] = []
  let textNode = walker.nextNode()

  while (textNode) {
    const len = (textNode.textContent || '').length
    const nodeStart = charOffset
    const nodeEnd = charOffset + len

    if (nodeEnd > start && nodeStart < end) {
      const rangeStart = Math.max(0, start - nodeStart)
      const rangeEnd = Math.min(len, end - nodeStart)

      const text = textNode as Text
      const parent = text.parentNode
      if (parent && !(parent instanceof HTMLElement && parent.tagName === 'MARK' && parent.dataset.pendingComment)) {
        const before = text.textContent!.slice(0, rangeStart)
        const highlighted = text.textContent!.slice(rangeStart, rangeEnd)
        const after = text.textContent!.slice(rangeEnd)

        const mark = document.createElement('mark')
        mark.dataset.pendingComment = 'true'
        mark.textContent = highlighted

        const frag = document.createDocumentFragment()
        if (before) frag.appendChild(document.createTextNode(before))
        frag.appendChild(mark)
        if (after) frag.appendChild(document.createTextNode(after))

        parent.replaceChild(frag, text)
        marks.push(mark)
      }
    }

    charOffset += len
    if (charOffset >= end) break
    textNode = walker.nextNode()
  }

  if (marks.length === 0) return null
  return () => marks.forEach(unwrapMark)
}

function unwrapMark(mark: HTMLElement) {
  const parent = mark.parentNode
  if (!parent) return
  while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
  parent.removeChild(mark)
  parent.normalize()
}

export function SelectionPopover() {
  const { selectionState, setSelectionState, addInlineComment, identity } = useInlineComments()
  const pathname = usePathname()
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const removeTempHighlightRef = useRef<(() => void) | null>(null)

  const isAuthenticated = identity.mode === 'authenticated'

  // Reset form + apply the temporary highlight whenever a new selection arrives.
  useEffect(() => {
    if (selectionState) {
      setContent('')
      setError(null)
      removeTempHighlightRef.current = applyTempHighlight(selectionState)
    } else {
      removeTempHighlightRef.current?.()
      removeTempHighlightRef.current = null
    }
  }, [selectionState])

  // Focus textarea when the popover opens (authenticated only — guests see
  // a CTA instead of the input).
  useEffect(() => {
    if (selectionState && isAuthenticated && textareaRef.current) {
      const timer = setTimeout(() => textareaRef.current?.focus(), 50)
      return () => clearTimeout(timer)
    }
  }, [selectionState, isAuthenticated])

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setSelectionState(null)
      }
    }
    if (selectionState) {
      const timer = setTimeout(() => {
        document.addEventListener('mousedown', handleClickOutside)
      }, 100)
      return () => {
        clearTimeout(timer)
        document.removeEventListener('mousedown', handleClickOutside)
      }
    }
  }, [selectionState, setSelectionState])

  // Close on Escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setSelectionState(null)
      }
    }
    if (selectionState) {
      document.addEventListener('keydown', handleKeyDown)
      return () => document.removeEventListener('keydown', handleKeyDown)
    }
  }, [selectionState, setSelectionState])

  const handleSubmit = useCallback(async () => {
    if (!content.trim()) return
    if (!isAuthenticated) return

    setSubmitting(true)
    setError(null)

    const comment = await addInlineComment(content.trim())

    if (comment) {
      setContent('')
      // Clean up temp highlight — the real highlight will take over
      removeTempHighlightRef.current?.()
      removeTempHighlightRef.current = null
    } else {
      setError('Failed to post comment. Please try again.')
    }
    setSubmitting(false)
  }, [content, addInlineComment, isAuthenticated])

  if (!selectionState) return null

  const popoverWidth = isAuthenticated ? 304 : 340
  const { rect } = selectionState
  const spaceBelow = window.innerHeight - rect.bottom
  const top = spaceBelow > 250 ? rect.bottom + 8 : rect.top - 8
  const left = Math.max(
    16,
    Math.min(rect.left + rect.width / 2 - popoverWidth / 2, window.innerWidth - popoverWidth - 16),
  )
  const showAbove = spaceBelow <= 250

  return (
    <div
      ref={popoverRef}
      className={`fixed z-50 animate-in fade-in-0 zoom-in-95 overflow-hidden rounded-xl border bg-popover shadow-xl ${
        isAuthenticated ? 'w-[304px]' : 'w-[340px]'
      }`}
      style={
        showAbove
          ? { bottom: `${window.innerHeight - top}px`, left: `${left}px` }
          : { top: `${top}px`, left: `${left}px` }
      }
    >
      {isAuthenticated ? (
        <div className="space-y-3 p-4">
          {/* Author info + close */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Avatar className="h-7 w-7">
                <AvatarImage src={identity.avatarUrl || undefined} />
                <AvatarFallback className="text-xs bg-primary/10 text-primary">
                  {identity.displayName.charAt(0).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <span className="text-xs font-medium">{identity.displayName}</span>
            </div>
            <button
              onClick={() => setSelectionState(null)}
              className="rounded-md p-1 text-muted-foreground/40 transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <Textarea
            ref={textareaRef}
            placeholder="Write your comment..."
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="min-h-[72px] resize-none text-sm"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit()
            }}
          />

          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-1.5 text-xs text-destructive">{error}</p>
          )}

          <div className="flex items-center justify-between">
            <p className="text-[10px] text-muted-foreground">
              <kbd className="rounded bg-muted px-1 py-0.5 font-mono">&#8984;Enter</kbd> to submit
            </p>
            <Button
              size="sm"
              className="h-8 gap-1.5 px-4"
              onClick={handleSubmit}
              disabled={submitting || !content.trim()}
            >
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              Comment
            </Button>
          </div>
        </div>
      ) : (
        <GuestSignInCTA
          pathname={pathname}
          onClose={() => setSelectionState(null)}
        />
      )}
    </div>
  )
}

/**
 * Shown to unauthenticated viewers when they try to comment on a shared
 * capture/document. Funnels them through sign-in, where the `redirect=`
 * query param brings them back to the same shared page post-auth.
 */
function GuestSignInCTA({
  pathname,
  onClose,
}: {
  pathname: string | null
  onClose: () => void
}) {
  const loginHref = `/login${
    pathname ? `?redirect=${encodeURIComponent(pathname)}` : ''
  }`

  return (
    <div className="relative">
      {/* Ambient background: soft gradient + decorative blur blobs */}
      <div
        className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/10 via-transparent to-primary/5"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-primary/20 blur-3xl"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -bottom-12 -left-8 h-28 w-28 rounded-full bg-primary/10 blur-3xl"
        aria-hidden
      />

      {/* Close button, floats over the artwork */}
      <button
        onClick={onClose}
        className="absolute right-2 top-2 z-10 rounded-md p-1 text-muted-foreground/40 transition-colors hover:bg-muted/60 hover:text-foreground"
        aria-label="Dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>

      <div className="relative space-y-4 p-5">
        {/* Icon badge */}
        <div className="flex justify-center pt-1">
          <div className="relative">
            <div
              className="absolute inset-0 rounded-2xl bg-primary/30 blur-lg"
              aria-hidden
            />
            <div className="relative flex h-12 w-12 items-center justify-center rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/15 to-primary/5 shadow-sm">
              <MessageSquareQuote className="h-5 w-5 text-primary" />
            </div>
            <div className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-background shadow-sm">
              <Sparkles className="h-2.5 w-2.5 text-primary" />
            </div>
          </div>
        </div>

        {/* Copy */}
        <div className="space-y-1.5 text-center">
          <h3 className="text-[15px] font-semibold tracking-tight text-foreground">
            Join the conversation
          </h3>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Create a free account to leave comments and collaborate on this capture.
          </p>
        </div>

        {/* Primary CTA */}
        <a
          href={loginHref}
          className="group relative inline-flex h-10 w-full items-center justify-center gap-1.5 overflow-hidden rounded-lg bg-primary text-sm font-medium text-primary-foreground shadow-sm transition-all hover:shadow-md hover:brightness-110 active:scale-[0.98]"
        >
          <span
            className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent opacity-0 transition-opacity duration-500 group-hover:opacity-100"
            aria-hidden
          />
          <span className="relative">Create account</span>
        </a>

        {/* Sign-in fallback */}
        <p className="text-center text-[11px] text-muted-foreground">
          Already have an account?{' '}
          <a
            href={loginHref}
            className="inline-flex items-center gap-1 font-medium text-foreground/80 underline-offset-2 hover:text-foreground hover:underline"
          >
            <LogIn className="h-3 w-3" />
            Sign in
          </a>
        </p>
      </div>
    </div>
  )
}
