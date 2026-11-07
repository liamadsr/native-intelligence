'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Loader2,
  MoreHorizontal,
  Check,
  RotateCcw,
  Pencil,
  Trash2,
  X,
} from 'lucide-react'
import { useInlineComments } from './inline-comment-context'
import { GuestBadge } from './guest-badge'
import type { UnifiedComment } from './types'
import { Linkify } from '@/components/ui/linkify'

function relativeTime(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function getAvatarColor(name: string) {
  const colors = [
    'bg-blue-500/15 text-blue-600 dark:text-blue-400',
    'bg-violet-500/15 text-violet-600 dark:text-violet-400',
    'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    'bg-rose-500/15 text-rose-600 dark:text-rose-400',
    'bg-cyan-500/15 text-cyan-600 dark:text-cyan-400',
  ]
  const idx = name.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) % colors.length
  return colors[idx]
}

function ReplyBubble({ reply }: { reply: UnifiedComment }) {
  const { editComment, deleteComment, identity } = useInlineComments()
  const isAuthenticated = identity.mode === 'authenticated'
  // A non-member viewer has memberId null, as does a guest's comment: null ===
  // null is not authorship.
  const memberId = isAuthenticated ? (identity as { memberId: string | null }).memberId : null
  const isAuthor = memberId != null && reply.author_id === memberId

  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [editSubmitting, setEditSubmitting] = useState(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)

  const handleEdit = async () => {
    if (!editContent.trim()) return
    setEditSubmitting(true)
    const ok = await editComment(reply.id, editContent.trim())
    if (ok) setEditing(false)
    setEditSubmitting(false)
  }

  return (
    <div className="group/reply flex gap-2.5 py-2 first:pt-0">
      <Avatar className="h-6 w-6 shrink-0 mt-0.5">
        <AvatarImage src={reply.author_avatar || undefined} />
        <AvatarFallback className={`text-[9px] font-semibold ${getAvatarColor(reply.author_name)}`}>
          {reply.author_name.charAt(0).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between">
          <div className="flex items-baseline gap-1.5">
            <span className="text-xs font-medium">{reply.author_name}</span>
            {reply.is_guest && <GuestBadge />}
            <span className="text-[10px] text-muted-foreground/50">{relativeTime(reply.created_at)}</span>
            {reply.edited_at && (
              <span className="text-[9px] text-muted-foreground/30">(edited)</span>
            )}
          </div>

          {isAuthor && (
            <DropdownMenu onOpenChange={setDropdownOpen}>
              <DropdownMenuTrigger asChild>
                <button className="-mr-1 rounded-md p-0.5 text-muted-foreground/30 transition-colors hover:bg-muted hover:text-foreground">
                  <MoreHorizontal className="h-3 w-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-32">
                <DropdownMenuItem onClick={() => { setEditContent(reply.content); setEditing(true) }}>
                  <Pencil className="mr-2 h-3.5 w-3.5" />Edit
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => deleteComment(reply.id)}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="mr-2 h-3.5 w-3.5" />Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {editing ? (
          <div className="mt-1.5 space-y-1.5">
            <Textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="min-h-[40px] resize-none border-border/50 bg-transparent text-xs focus-visible:ring-1"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleEdit()
                if (e.key === 'Escape') setEditing(false)
              }}
            />
            <div className="flex justify-end gap-1">
              <Button variant="ghost" size="sm" className="h-5 px-2 text-[10px]" onClick={() => setEditing(false)}>Cancel</Button>
              <Button size="sm" className="h-5 px-2 text-[10px]" onClick={handleEdit} disabled={editSubmitting || !editContent.trim()}>
                {editSubmitting && <Loader2 className="mr-1 h-2.5 w-2.5 animate-spin" />}Save
              </Button>
            </div>
          </div>
        ) : (
          <p className="mt-0.5 text-[12px] leading-relaxed text-foreground/80"><Linkify text={reply.content} /></p>
        )}
      </div>
    </div>
  )
}

function PopoverReplyInput({
  parentId,
  onSubmit,
}: {
  parentId: string
  onSubmit: (parentId: string, content: string) => Promise<UnifiedComment | null>
}) {
  const { identity } = useInlineComments()
  const isAuthenticated = identity.mode === 'authenticated'

  const [open, setOpen] = useState(false)
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus()
  }, [open])

  const handleSubmit = async () => {
    if (!content.trim()) return
    if (!isAuthenticated) return

    setSubmitting(true)
    const result = await onSubmit(parentId, content.trim())
    if (result) {
      setContent('')
      setOpen(false)
    }
    setSubmitting(false)
  }

  // Guests can't reply — the whole comment flow routes them through the
  // sign-in CTA instead.
  if (!isAuthenticated) return null

  if (!open) {
    return (
      <button
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
        className="w-full rounded-lg border border-dashed border-border/60 px-3 py-2 text-left text-xs text-muted-foreground/50 transition-colors hover:border-border hover:text-muted-foreground"
      >
        Reply…
      </button>
    )
  }

  return (
    <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
      <Textarea
        ref={inputRef}
        placeholder="Write a reply…"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        className="min-h-[48px] resize-none border-border/50 bg-transparent text-xs focus-visible:ring-1"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit()
          if (e.key === 'Escape') setOpen(false)
        }}
      />
      <div className="flex items-center justify-between">
        <p className="text-[10px] text-muted-foreground/40">
          <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-[9px]">&#8984;Enter</kbd>
        </p>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[10px]"
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-6 px-3 text-[10px]"
            onClick={handleSubmit}
            disabled={submitting || !content.trim()}
          >
            {submitting && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
            Reply
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * Inline comment popover that appears on hover/click over highlighted text.
 * Replaces the sidebar comment system with contextual, Google Docs-style
 * inline comment threads.
 */
export function InlineCommentPopover() {
  const {
    comments,
    activeCommentId,
    setActiveComment,
    addReply,
    resolveComment,
    editComment,
    deleteComment,
    identity,
  } = useInlineComments()

  const popoverRef = useRef<HTMLDivElement>(null)
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const leaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // The comment we're showing in the popover
  const [hoveredCommentId, setHoveredCommentId] = useState<string | null>(null)
  // Position of the popover
  const [position, setPosition] = useState<{ top: number; left: number; showAbove: boolean } | null>(null)
  // Whether the popover is "pinned" (clicked, not just hovered)
  const [pinned, setPinned] = useState(false)
  // Edit state
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [editSubmitting, setEditSubmitting] = useState(false)
  // Track whether the dropdown is open to prevent click-outside from closing
  const [dropdownOpen, setDropdownOpen] = useState(false)

  const isAuthenticated = identity.mode === 'authenticated'

  const activeComment = comments.find((c) => c.id === (hoveredCommentId || activeCommentId))

  const computePosition = useCallback((el: HTMLElement) => {
    const rect = el.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    const showAbove = spaceBelow < 300
    const left = Math.max(16, Math.min(rect.left + rect.width / 2 - 160, window.innerWidth - 336))
    const top = showAbove ? rect.top - 8 : rect.bottom + 8
    return { top, left, showAbove }
  }, [])

  // Handle hover on highlighted elements
  useEffect(() => {
    function handleMouseEnter(e: MouseEvent) {
      const target = e.target as HTMLElement
      const commentEl = target.closest?.('[data-comment-id]') as HTMLElement | null
      if (!commentEl?.dataset.commentId) return

      // Don't override a pinned popover
      if (pinned) return

      if (leaveTimeoutRef.current) {
        clearTimeout(leaveTimeoutRef.current)
        leaveTimeoutRef.current = null
      }

      hoverTimeoutRef.current = setTimeout(() => {
        const id = commentEl.dataset.commentId!
        setHoveredCommentId(id)
        setPosition(computePosition(commentEl))
      }, 200)
    }

    function handleMouseLeave(e: MouseEvent) {
      const target = e.target as HTMLElement
      const commentEl = target.closest?.('[data-comment-id]') as HTMLElement | null
      if (!commentEl?.dataset.commentId) return

      if (pinned) return

      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current)
        hoverTimeoutRef.current = null
      }

      // Delay hiding to allow mouse to move to popover
      leaveTimeoutRef.current = setTimeout(() => {
        setHoveredCommentId(null)
        setPosition(null)
      }, 300)
    }

    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement
      const commentEl = target.closest?.('[data-comment-id]') as HTMLElement | null
      if (!commentEl?.dataset.commentId) return

      // Pin the popover on click
      const id = commentEl.dataset.commentId!
      setHoveredCommentId(id)
      setActiveComment(id)
      setPosition(computePosition(commentEl))
      setPinned(true)

      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current)
        hoverTimeoutRef.current = null
      }
    }

    document.addEventListener('mouseover', handleMouseEnter)
    document.addEventListener('mouseout', handleMouseLeave)
    document.addEventListener('click', handleClick)

    return () => {
      document.removeEventListener('mouseover', handleMouseEnter)
      document.removeEventListener('mouseout', handleMouseLeave)
      document.removeEventListener('click', handleClick)
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current)
      if (leaveTimeoutRef.current) clearTimeout(leaveTimeoutRef.current)
    }
  }, [pinned, computePosition, setActiveComment])

  // Close pinned popover on click outside
  useEffect(() => {
    if (!pinned) return

    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node

      // Don't close if interacting with the popover itself
      if (popoverRef.current?.contains(target)) return

      // Don't close if clicking on a highlight
      const el = (target as HTMLElement).closest?.('[data-comment-id]')
      if (el) return

      // Don't close if the dropdown menu is open (it renders in a portal)
      const dropdownPortal = (target as HTMLElement).closest?.('[data-radix-popper-content-wrapper]')
      if (dropdownPortal) return

      setPinned(false)
      setHoveredCommentId(null)
      setActiveComment(null)
      setPosition(null)
      setEditing(false)
    }

    // Delay to avoid catching the same click that pinned it
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside)
    }, 50)

    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [pinned, setActiveComment])

  // Close on Escape (but not if dropdown is open — let dropdown handle its own Escape)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !dropdownOpen && !editing) {
        setPinned(false)
        setHoveredCommentId(null)
        setActiveComment(null)
        setPosition(null)
        setEditing(false)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [setActiveComment, dropdownOpen, editing])

  // Keep popover alive when mouse enters it
  const handlePopoverMouseEnter = useCallback(() => {
    if (leaveTimeoutRef.current) {
      clearTimeout(leaveTimeoutRef.current)
      leaveTimeoutRef.current = null
    }
  }, [])

  const handlePopoverMouseLeave = useCallback(() => {
    if (pinned) return
    leaveTimeoutRef.current = setTimeout(() => {
      setHoveredCommentId(null)
      setPosition(null)
    }, 300)
  }, [pinned])

  const handleEdit = async () => {
    if (!activeComment || !editContent.trim()) return
    setEditSubmitting(true)
    const ok = await editComment(activeComment.id, editContent.trim())
    if (ok) setEditing(false)
    setEditSubmitting(false)
  }

  const handleClose = useCallback(() => {
    setPinned(false)
    setHoveredCommentId(null)
    setActiveComment(null)
    setPosition(null)
    setEditing(false)
  }, [setActiveComment])

  if (!activeComment || !position) return null

  const viewerMemberId = isAuthenticated ? (identity as { memberId: string | null }).memberId : null
  const isAuthor = viewerMemberId != null && activeComment.author_id === viewerMemberId

  return (
    <div
      ref={popoverRef}
      className="fixed z-50 w-[320px] animate-in fade-in-0 zoom-in-95 duration-150 rounded-xl border bg-popover shadow-lg shadow-black/8 dark:shadow-black/25"
      style={
        position.showAbove
          ? { bottom: `${window.innerHeight - position.top}px`, left: `${position.left}px` }
          : { top: `${position.top}px`, left: `${position.left}px` }
      }
      onMouseEnter={handlePopoverMouseEnter}
      onMouseLeave={handlePopoverMouseLeave}
    >
      <div className="max-h-[400px] overflow-y-auto">
        {/* Main comment */}
        <div className="px-3.5 pt-3 pb-2">
          <div className="flex items-start gap-2.5">
            <Avatar className="h-7 w-7 shrink-0 mt-0.5">
              <AvatarImage src={activeComment.author_avatar || undefined} />
              <AvatarFallback className={`text-[10px] font-semibold ${getAvatarColor(activeComment.author_name)}`}>
                {activeComment.author_name.charAt(0).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-xs font-semibold">{activeComment.author_name}</span>
                  {activeComment.is_guest && <GuestBadge />}
                  <span className="text-[10px] text-muted-foreground/50">
                    {relativeTime(activeComment.created_at)}
                  </span>
                  {activeComment.edited_at && (
                    <span className="text-[9px] text-muted-foreground/30">(edited)</span>
                  )}
                </div>

                <div className="flex items-center gap-0.5 -mr-1">
                  <DropdownMenu onOpenChange={setDropdownOpen}>
                    <DropdownMenuTrigger asChild>
                      <button className="rounded-md p-1 text-muted-foreground/30 transition-colors hover:bg-muted hover:text-foreground">
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-36">
                      <DropdownMenuItem
                        onClick={() => resolveComment(activeComment.id, !activeComment.is_resolved)}
                      >
                        {activeComment.is_resolved ? (
                          <><RotateCcw className="mr-2 h-3.5 w-3.5" />Reopen</>
                        ) : (
                          <><Check className="mr-2 h-3.5 w-3.5" />Resolve</>
                        )}
                      </DropdownMenuItem>
                      {isAuthor && (
                        <>
                          <DropdownMenuItem onClick={() => { setEditContent(activeComment.content); setEditing(true); setPinned(true) }}>
                            <Pencil className="mr-2 h-3.5 w-3.5" />Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={async () => {
                              await deleteComment(activeComment.id)
                              handleClose()
                            }}
                            className="text-destructive focus:text-destructive"
                          >
                            <Trash2 className="mr-2 h-3.5 w-3.5" />Delete
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>

                  {pinned && (
                    <button
                      onClick={handleClose}
                      className="rounded-md p-1 text-muted-foreground/30 transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {/* Comment body or edit form */}
              {editing ? (
                <div className="mt-2 space-y-2">
                  <Textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    className="min-h-[48px] resize-none border-border/50 bg-transparent text-xs focus-visible:ring-1"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleEdit()
                      if (e.key === 'Escape') setEditing(false)
                    }}
                  />
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] text-muted-foreground/40">
                      <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-[9px]">&#8984;Enter</kbd>
                    </p>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]" onClick={() => setEditing(false)}>Cancel</Button>
                      <Button size="sm" className="h-6 px-3 text-[10px]" onClick={handleEdit} disabled={editSubmitting || !editContent.trim()}>
                        {editSubmitting && <Loader2 className="mr-1 h-2.5 w-2.5 animate-spin" />}Save
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="mt-1 text-[12.5px] leading-relaxed text-foreground/85"><Linkify text={activeComment.content} /></p>
              )}
            </div>
          </div>
        </div>

        {/* Replies */}
        {activeComment.replies.length > 0 && (
          <div className="mx-3.5 border-t border-border/50 pt-2 pb-1 space-y-0">
            {activeComment.replies.map((reply) => (
              <ReplyBubble key={reply.id} reply={reply} />
            ))}
          </div>
        )}

        {/* Reply input */}
        <div className="mx-3.5 border-t border-border/50 pt-2.5 pb-3">
          <PopoverReplyInput parentId={activeComment.id} onSubmit={addReply} />
        </div>
      </div>
    </div>
  )
}
