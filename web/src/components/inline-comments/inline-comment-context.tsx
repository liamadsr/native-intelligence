'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { InlineComment, SelectionState, UnifiedComment, CommentIdentity, CommentAPI } from './types'

interface InlineCommentContextValue {
  comments: InlineComment[]
  activeCommentId: string | null
  selectionState: SelectionState | null
  identity: CommentIdentity
  setActiveComment: (id: string | null) => void
  setSelectionState: (state: SelectionState | null) => void
  addInlineComment: (content: string) => Promise<UnifiedComment | null>
  addReply: (parentId: string, content: string) => Promise<UnifiedComment | null>
  resolveComment: (commentId: string, resolved: boolean) => Promise<void>
  scrollToComment: (id: string) => void
  scrollTarget: string | null
  activeSection: string | null
  setActiveSection: (section: string | null) => void
  sectionCommentCounts: Record<string, number>
  highlightPositions: Map<string, number>
  setHighlightPositions: (positions: Map<string, number>) => void
  editComment: (commentId: string, content: string) => Promise<boolean>
  deleteComment: (commentId: string) => Promise<boolean>
}

const InlineCommentContext = createContext<InlineCommentContextValue | null>(null)

// Field-level equality for the hydrate merge below. It must be by VALUE, not
// reference: some callers (the share page) build `initialComments` with a
// fresh map() every render, and a reference check would flag every row as
// changed → setState → re-render → fresh array → an infinite loop.
function sameComment(a: UnifiedComment, b: UnifiedComment): boolean {
  return (
    a.id === b.id &&
    a.content === b.content &&
    a.author_name === b.author_name &&
    a.author_avatar === b.author_avatar &&
    a.author_id === b.author_id &&
    a.author_email === b.author_email &&
    a.is_guest === b.is_guest &&
    a.parent_id === b.parent_id &&
    a.created_at === b.created_at &&
    a.edited_at === b.edited_at &&
    a.anchor_text === b.anchor_text &&
    a.anchor_prefix === b.anchor_prefix &&
    a.anchor_suffix === b.anchor_suffix &&
    a.anchor_section === b.anchor_section &&
    a.anchor_occurrence === b.anchor_occurrence &&
    a.is_resolved === b.is_resolved
  )
}

export function useInlineComments() {
  const ctx = useContext(InlineCommentContext)
  if (!ctx) throw new Error('useInlineComments must be used within InlineCommentProvider')
  return ctx
}

export function InlineCommentProvider({
  children,
  initialComments,
  identity,
  api,
}: {
  children: ReactNode
  initialComments: UnifiedComment[]
  identity: CommentIdentity
  api: CommentAPI
}) {
  const [allComments, setAllComments] = useState<UnifiedComment[]>(initialComments)
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null)

  // Ids the user mutated locally this session (added / edited / resolved /
  // deleted, incl. a deleted comment's replies). The hydrate merge below must
  // never touch them: `initialComments` callers hand in FROZEN snapshots (the
  // capture panel's rawInlineComments is fetched once at mount; the share page
  // maps a server prop), so any re-derivation of the prop AFTER a local
  // mutation — e.g. an identity change rebuilding the mapped array — replays
  // stale rows: a deleted comment would resurrect via the `!existing` branch
  // and an edit/resolve would be overwritten back. Skipping a locally-mutated
  // id covers both: absent stays absent, present keeps the local copy.
  const locallyMutatedIdsRef = useRef<Set<string>>(new Set())

  // Post-mount hydrate. `initialComments` seeds useState above exactly once, so
  // a caller that mounts this provider BEFORE its comments fetch resolves (the
  // capture panel renders the editor immediately rather than gating on the
  // fetch) needs later arrivals folded in. Merge BY ID: server rows refresh or
  // append, while comments added optimistically in this session — absent from
  // an older server snapshot — are kept, never clobbered.
  const hydratedRef = useRef(initialComments)
  useEffect(() => {
    if (hydratedRef.current === initialComments) return
    hydratedRef.current = initialComments
    const locallyMutated = locallyMutatedIdsRef.current
    setAllComments((prev) => {
      if (initialComments.length === 0) return prev
      if (prev.length === 0) {
        // Even the wholesale-adopt path must not resurrect locally-deleted
        // rows (deleting the ONLY comment leaves prev empty).
        if (locallyMutated.size === 0) return initialComments
        const filtered = initialComments.filter((c) => !locallyMutated.has(c.id))
        if (filtered.length === 0) return prev
        return filtered.length === initialComments.length ? initialComments : filtered
      }
      const byId = new Map(prev.map((c) => [c.id, c]))
      let changed = false
      for (const incoming of initialComments) {
        if (locallyMutated.has(incoming.id)) continue
        const existing = byId.get(incoming.id)
        if (!existing || !sameComment(existing, incoming)) {
          byId.set(incoming.id, incoming)
          changed = true
        }
      }
      return changed ? [...byId.values()] : prev
    })
  }, [initialComments])
  const [scrollTarget, setScrollTarget] = useState<string | null>(null)
  const [selectionState, setSelectionState] = useState<SelectionState | null>(null)
  const [activeSection, setActiveSection] = useState<string | null>(null)
  const [highlightPositions, setHighlightPositions] = useState<Map<string, number>>(new Map())

  // Build inline comments with replies
  const comments = useMemo(() => {
    const inline: InlineComment[] = []
    const repliesByParent: Record<string, UnifiedComment[]> = {}

    // First pass: collect replies
    for (const c of allComments) {
      if (c.parent_id) {
        ;(repliesByParent[c.parent_id] = repliesByParent[c.parent_id] || []).push(c)
      }
    }

    // Second pass: build inline comments (top-level with anchors only)
    for (const c of allComments) {
      if (c.parent_id) continue
      if (c.anchor_text) {
        inline.push({
          ...c,
          anchor_text: c.anchor_text,
          anchor_prefix: c.anchor_prefix || '',
          anchor_suffix: c.anchor_suffix || '',
          anchor_section: c.anchor_section || 'document',
          anchor_occurrence: c.anchor_occurrence ?? 0,
          replies: repliesByParent[c.id] || [],
        })
      }
    }

    return inline
  }, [allComments])

  // Count unresolved inline comments per section
  const sectionCommentCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const c of comments) {
      if (!c.is_resolved) {
        counts[c.anchor_section] = (counts[c.anchor_section] || 0) + 1
      }
    }
    return counts
  }, [comments])

  const addInlineComment = useCallback(
    async (content: string) => {
      if (!selectionState) return null
      if (identity.mode !== 'authenticated') return null

      const body: Record<string, unknown> = {
        content,
        anchor_text: selectionState.text,
        anchor_prefix: selectionState.prefix,
        anchor_suffix: selectionState.suffix,
        anchor_section: selectionState.section,
        anchor_occurrence: selectionState.occurrenceIndex,
      }

      const comment = await api.postComment(body)
      if (comment) {
        locallyMutatedIdsRef.current.add(comment.id)
        setAllComments((prev) => [...prev, comment])
        setSelectionState(null)
        setActiveCommentId(comment.id)
      }
      return comment
    },
    [selectionState, api, identity],
  )

  const addReply = useCallback(
    async (parentId: string, content: string) => {
      if (identity.mode !== 'authenticated') return null
      const body: Record<string, unknown> = {
        content,
        parent_id: parentId,
      }

      const comment = await api.postComment(body)
      if (comment) {
        locallyMutatedIdsRef.current.add(comment.id)
        setAllComments((prev) => [...prev, comment])
      }
      return comment
    },
    [api, identity],
  )

  const resolveComment = useCallback(
    async (commentId: string, resolved: boolean) => {
      const ok = await api.resolveComment(commentId, resolved)
      if (ok) {
        locallyMutatedIdsRef.current.add(commentId)
        setAllComments((prev) =>
          prev.map((c) => (c.id === commentId ? { ...c, is_resolved: resolved } : c)),
        )
      }
    },
    [api],
  )

  const editComment = useCallback(
    async (commentId: string, content: string) => {
      if (identity.mode !== 'authenticated') return false
      const res = await fetch(`/api/account/comments/${commentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: content }),
      })
      if (res.ok) {
        const data = await res.json()
        locallyMutatedIdsRef.current.add(commentId)
        setAllComments((prev) =>
          prev.map((c) =>
            c.id === commentId
              ? { ...c, content: data.comment.body, edited_at: data.comment.edited_at }
              : c,
          ),
        )
        return true
      }
      return false
    },
    [identity],
  )

  const deleteComment = useCallback(
    async (commentId: string) => {
      if (identity.mode !== 'authenticated') return false
      const res = await fetch(`/api/account/comments/${commentId}`, {
        method: 'DELETE',
      })
      if (res.ok) {
        // Remove comment and its replies. Mark every removed id as locally
        // mutated so a later hydrate of a stale snapshot can't resurrect them
        // (marking inside the updater is idempotent — Set.add — so a repeated
        // updater invocation is harmless).
        setAllComments((prev) => {
          for (const c of prev) {
            if (c.id === commentId || c.parent_id === commentId) {
              locallyMutatedIdsRef.current.add(c.id)
            }
          }
          return prev.filter((c) => c.id !== commentId && c.parent_id !== commentId)
        })
        return true
      }
      return false
    },
    [identity],
  )

  const setActiveComment = useCallback((id: string | null) => {
    setActiveCommentId(id)
  }, [])

  const scrollToComment = useCallback((id: string) => {
    setActiveCommentId(id)
    setScrollTarget(id)
  }, [])

  const value = useMemo(
    () => ({
      comments,
      activeCommentId,
      selectionState,
      identity,
      setActiveComment,
      scrollToComment,
      scrollTarget,
      setSelectionState,
      addInlineComment,
      addReply,
      resolveComment,
      editComment,
      deleteComment,
      activeSection,
      setActiveSection,
      sectionCommentCounts,
      highlightPositions,
      setHighlightPositions,
    }),
    [
      comments,
      activeCommentId,
      selectionState,
      identity,
      setActiveComment,
      scrollToComment,
      scrollTarget,
      addInlineComment,
      addReply,
      resolveComment,
      editComment,
      deleteComment,
      activeSection,
      setActiveSection,
      sectionCommentCounts,
      highlightPositions,
    ],
  )

  return (
    <InlineCommentContext.Provider value={value}>{children}</InlineCommentContext.Provider>
  )
}
