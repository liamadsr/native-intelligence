'use client'

import { useCallback, useEffect, useMemo, useRef } from 'react'
// Value from the lazy wrapper (TipTap/ProseMirror is ~1MB and must stay off
// the first-load path); the type from the module itself, which costs nothing.
import { NoteEditor } from '@/app/account/(dashboard)/views/note-editor-lazy'
import type { EditorCommentSelection } from '@/app/account/(dashboard)/views/note-editor'
import { useInlineComments } from './inline-comment-context'
import {
  CommentHighlightExtension,
  setEditorComments,
} from './comment-highlight-extension'
import {
  NoteAttributionExtension,
  setEditorAttributions,
  type NoteAttribution,
} from '@/components/note-attribution/note-attribution-extension'
import type { ContentSection } from './types'

export function CommentableEditor({
  section,
  noteAttributions,
  activeAttributionId,
  onAttributionClick,
  onEditorReady: onEditorReadyProp,
  ...editorProps
}: {
  section: ContentSection
  noteAttributions?: NoteAttribution[]
  activeAttributionId?: string | null
  onAttributionClick?: (id: string) => void
  onEditorReady?: (editor: any) => void
} & Omit<React.ComponentProps<typeof NoteEditor>, 'onEditorReady'>) {
  const {
    comments,
    activeCommentId,
    setActiveComment,
    setSelectionState,
    setActiveSection,
    scrollTarget,
  } = useInlineComments()

  const editorRef = useRef<any>(null)
  // Keep latest values in refs so effects/callbacks always see current data
  const commentsRef = useRef(comments)
  const activeIdRef = useRef(activeCommentId)
  commentsRef.current = comments
  activeIdRef.current = activeCommentId

  useEffect(() => {
    setActiveSection(section)
  }, [section, setActiveSection])

  const sectionComments = useMemo(
    () => comments.filter((c) => c.anchor_section === section),
    [comments, section],
  )
  const sectionCommentsRef = useRef(sectionComments)
  sectionCommentsRef.current = sectionComments

  const highlightExtension = useMemo(
    () =>
      CommentHighlightExtension.configure({
        onHighlightClick: (commentId: string) => {
          setActiveComment(commentId)
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const attributionExtension = useMemo(
    () =>
      NoteAttributionExtension.configure({
        onAttributionClick: (attributionId: string) => {
          onAttributionClick?.(attributionId)
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // Sync comment decorations whenever comments or active comment changes
  useEffect(() => {
    const editor = editorRef.current
    if (!editor?.view || !editor.view.dom) return
    setEditorComments(editor, sectionComments, activeCommentId)
  }, [sectionComments, activeCommentId])

  // Sync note attribution decorations
  useEffect(() => {
    const editor = editorRef.current
    if (!editor?.view || !editor.view.dom) return
    if (noteAttributions && noteAttributions.length > 0) {
      setEditorAttributions(editor, noteAttributions, activeAttributionId ?? null)
    }
  }, [noteAttributions, activeAttributionId])

  // Scroll to comment highlight when sidebar is clicked
  useEffect(() => {
    if (!scrollTarget) return
    const editor = editorRef.current
    if (!editor?.view) return

    const isInThisSection = sectionCommentsRef.current.some((c) => c.id === scrollTarget)
    if (!isInThisSection) return

    // Ensure decorations are synced with this comment active
    setEditorComments(editor, sectionCommentsRef.current, scrollTarget)

    // Wait for decorations to render, then scroll the highlight
    // to align with the sidebar comment card (which is at the top after rotation)
    setTimeout(() => {
      const el = editor.view.dom.querySelector(`[data-comment-id="${scrollTarget}"]`) as HTMLElement | null
      if (!el) return

      // Find the scrollable viewport (Radix ScrollArea or nearest scrollable parent)
      const scrollViewport = el.closest('[data-radix-scroll-area-viewport]') || el.closest('.overflow-y-auto') || el.closest('.overflow-auto')
      if (scrollViewport) {
        const elRect = el.getBoundingClientRect()
        const viewportRect = scrollViewport.getBoundingClientRect()
        // Scroll so the highlight is ~80px from the top of the viewport
        // to align roughly with the sidebar's first comment card
        const targetScroll = scrollViewport.scrollTop + (elRect.top - viewportRect.top) - 80
        scrollViewport.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' })
      } else {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    }, 150)
  }, [scrollTarget])

  // Keep attribution refs current for the onEditorReady callback
  const noteAttributionsRef = useRef(noteAttributions)
  const activeAttributionIdRef = useRef(activeAttributionId)
  noteAttributionsRef.current = noteAttributions
  activeAttributionIdRef.current = activeAttributionId

  const handleEditorReady = useCallback((editor: any) => {
    editorRef.current = editor
    onEditorReadyProp?.(editor)
    // Apply highlights + attributions once editor is ready — use refs for current data
    setTimeout(() => {
      if (!editor?.view) return
      const sc = sectionCommentsRef.current
      if (sc.length > 0) {
        setEditorComments(editor, sc, activeIdRef.current)
      }
      const attrs = noteAttributionsRef.current
      if (attrs && attrs.length > 0) {
        setEditorAttributions(editor, attrs, activeAttributionIdRef.current ?? null)
      }
    }, 300)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleComment = useCallback(
    (selection: EditorCommentSelection) => {
      setSelectionState({
        text: selection.text,
        prefix: selection.prefix,
        suffix: selection.suffix,
        section,
        occurrenceIndex: 0,
        rect: selection.rect,
      })
    },
    [section, setSelectionState],
  )

  // Memoize the array reference to prevent NoteEditor re-mounting
  const hasAttributions = !!(noteAttributions && noteAttributions.length > 0)
  const parentExtensions = (editorProps as any).extraExtensions as any[] | undefined
  const extraExtensions = useMemo(
    () => {
      const base = hasAttributions
        ? [highlightExtension, attributionExtension]
        : [highlightExtension]
      return parentExtensions && parentExtensions.length > 0
        ? [...base, ...parentExtensions]
        : base
    },
    [highlightExtension, attributionExtension, hasAttributions, parentExtensions],
  )

  return (
    <NoteEditor
      {...editorProps}
      onComment={handleComment}
      extraExtensions={extraExtensions}
      onEditorReady={handleEditorReady}
    />
  )
}
