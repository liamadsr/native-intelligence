'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useEntityListSync } from '@/hooks/use-entity-sync'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { MoreHorizontal, Pencil, Trash2, Reply, X, ArrowUp, ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { cachedJson } from '@/lib/cached-fetch'
import { useWorkspaceId } from '@/app/account/workspace-switcher'
import { Linkify } from '@/components/ui/linkify'

type CommentableType = 'action' | 'capture' | 'document' | 'project' | 'contact'

interface Comment {
  id: string
  body: string
  author_id: string
  author_name: string | null
  author_avatar: string | null
  parent_id: string | null
  reply_count?: number
  created_at: string
  edited_at: string | null
}

interface CommentsProps {
  commentableType: CommentableType
  commentableId: string
  /**
   * The viewer's member id, when the mounting panel already knows it (the
   * detail panels all do, via the workspace-switcher context). Passing it
   * skips the fallback workspace lookup below — this component remounts on
   * every next/back step, so an unconditional fetch here paid the heaviest
   * request in the app once per step.
   */
  currentMemberId?: string | null
}

const ROUTE_MAP: Record<CommentableType, string> = {
  action: 'actions',
  capture: 'captures',
  document: 'documents',
  project: 'projects',
  contact: 'contacts',
}

function getInitials(name: string | null) {
  if (!name) return '?'
  return name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

function formatRelativeTime(dateStr: string) {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function CommentItem({
  comment,
  currentMemberId,
  onReply,
  onEdit,
  onDelete,
  renderEditor,
  repliesVersion = 0,
  depth = 0,
}: {
  comment: Comment
  currentMemberId: string | null
  onReply: (comment: Comment) => void
  onEdit: (comment: Comment) => void
  onDelete: (comment: Comment) => void
  /** The inline editor when this reply is the one being edited, else null. */
  renderEditor?: (comment: Comment) => ReactNode | null
  /** Bumped by the thread after a reply is posted, edited or deleted. */
  repliesVersion?: number
  depth?: number
}) {
  const [showReplies, setShowReplies] = useState(false)
  const [replies, setReplies] = useState<Comment[]>([])
  const [loadingReplies, setLoadingReplies] = useState(false)
  const repliesLoadedRef = useRef(false)
  const isAuthor = currentMemberId === comment.author_id

  const fetchReplies = useCallback(async (silent = false) => {
    if (!silent) setLoadingReplies(true)
    const res = await fetch(`/api/account/comments/${comment.id}/replies`)
    if (res.ok) {
      const data = await res.json()
      setReplies(data.replies || [])
      repliesLoadedRef.current = true
    }
    if (!silent) setLoadingReplies(false)
  }, [comment.id])

  // Replies live here, not in the thread's list, so a reply posted, edited or
  // deleted elsewhere in the thread refreshes them once they've been loaded.
  useEffect(() => {
    if (repliesVersion === 0 || !repliesLoadedRef.current) return
    void fetchReplies(true)
  }, [repliesVersion, fetchReplies])

  const toggleReplies = () => {
    if (!showReplies && replies.length === 0) {
      fetchReplies()
    }
    setShowReplies(!showReplies)
  }

  return (
    <div className={cn('group', depth > 0 && 'ml-8 border-l border-border/50 pl-3')}>
      <div className="flex gap-2.5 py-2">
        <Avatar className="h-6 w-6 shrink-0">
          <AvatarImage src={comment.author_avatar || undefined} />
          <AvatarFallback className="text-[10px]">
            {getInitials(comment.author_name)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium">{comment.author_name || 'Unknown'}</span>
            <span className="text-[11px] text-muted-foreground">
              {formatRelativeTime(comment.created_at)}
            </span>
            {comment.edited_at && (
              <span className="text-[10px] text-muted-foreground">(edited)</span>
            )}
          </div>
          <p className="select-text mt-0.5 text-sm whitespace-pre-wrap"><Linkify text={comment.body} /></p>
          <div className="mt-1 flex items-center gap-2">
            {depth === 0 && (
              <button
                onClick={() => onReply(comment)}
                className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                <Reply className="h-3 w-3" />
                Reply
              </button>
            )}
            {depth === 0 && (comment.reply_count || 0) > 0 && (
              <button
                onClick={toggleReplies}
                className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                {showReplies ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                {comment.reply_count} {comment.reply_count === 1 ? 'reply' : 'replies'}
              </button>
            )}
          </div>
        </div>
        {isAuthor && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onEdit(comment)}>
                <Pencil className="mr-2 h-3.5 w-3.5" />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => onDelete(comment)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Threaded replies */}
      {showReplies && (
        <div>
          {loadingReplies ? (
            <p className="ml-8 py-2 text-xs text-muted-foreground">Loading replies...</p>
          ) : (
            replies.map((reply) => (
              <div key={reply.id}>
                {renderEditor?.(reply) ?? (
                  <CommentItem
                    comment={reply}
                    currentMemberId={currentMemberId}
                    onReply={onReply}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    depth={1}
                  />
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

export function Comments({
  commentableType,
  commentableId,
  currentMemberId: currentMemberIdProp,
}: CommentsProps) {
  const [comments, setComments] = useState<Comment[]>([])
  const [loading, setLoading] = useState(true)
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [replyingTo, setReplyingTo] = useState<Comment | null>(null)
  const [editing, setEditing] = useState<Comment | null>(null)
  const [editBody, setEditBody] = useState('')
  const [deleting, setDeleting] = useState<Comment | null>(null)
  // Bumped whenever a reply changes, so each thread's loaded replies refetch.
  const [repliesVersion, setRepliesVersion] = useState(0)
  const [fetchedMemberId, setFetchedMemberId] = useState<string | null>(null)
  const workspaceId = useWorkspaceId()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const currentMemberId = currentMemberIdProp ?? fetchedMemberId
  const routeBase = ROUTE_MAP[commentableType]

  // Fallback: resolve the current member id only when the caller didn't supply
  // it — through cachedJson so repeat mounts share one cached workspace
  // response instead of each re-firing the request.
  useEffect(() => {
    if (currentMemberIdProp != null) return
    let cancelled = false
    cachedJson<{ currentMemberId?: string | null }>('/api/account/workspace', { scope: workspaceId })
      .then((data) => {
        if (!cancelled && data?.currentMemberId) setFetchedMemberId(data.currentMemberId)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [currentMemberIdProp, workspaceId])

  const fetchComments = useCallback(async () => {
    const res = await fetch(`/api/account/${routeBase}/${commentableId}/comments`)
    if (res.ok) {
      const data = await res.json()
      setComments(data.comments || [])
    }
    setLoading(false)
  }, [routeBase, commentableId])

  useEffect(() => {
    fetchComments()
  }, [fetchComments])

  // Live-sync: a comment written by a teammate (or by us on another device)
  // on THIS commentable refreshes the thread. Match when the scoping key is
  // absent — realtime DELETE payloads carry an empty fields {} (Supabase
  // strips the old row to its PK) and locally-emitted events omit fields
  // entirely — so a delete or a bare create still refetches; the (cheap,
  // singular) refetch reconciles. When realtime supplies the row columns,
  // scope on the target so a comment on a different entity doesn't refetch us.
  useEntityListSync(['comment'], fetchComments, {
    match: (d) => {
      const { commentable_id, commentable_type } = (d.fields ?? {}) as {
        commentable_id?: string
        commentable_type?: string
      }
      // Absent id (delete / local emit) → treat as a match; only reject a
      // different, present id.
      if (commentable_id != null && commentable_id !== commentableId) {
        return false
      }
      // The DB enum only spans action/capture/document; project/contact
      // threads never produce a realtime row, so only compare type when the
      // event actually carries one.
      if (commentable_type != null && commentable_type !== commentableType) {
        return false
      }
      return true
    },
  })

  const handleSubmit = async () => {
    const text = body.trim()
    if (!text || submitting) return

    setSubmitting(true)
    const payload: { body: string; parent_id?: string } = { body: text }
    if (replyingTo) payload.parent_id = replyingTo.id

    const res = await fetch(`/api/account/${routeBase}/${commentableId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    if (res.ok) {
      setBody('')
      setReplyingTo(null)
      await fetchComments()
      if (payload.parent_id) setRepliesVersion((v) => v + 1)
    }
    setSubmitting(false)
  }

  const handleEdit = async () => {
    if (!editing || !editBody.trim()) return

    const res = await fetch(`/api/account/comments/${editing.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: editBody.trim() }),
    })

    if (res.ok) {
      const data = await res.json()
      setComments((prev) =>
        prev.map((c) => (c.id === editing.id ? { ...c, ...data.comment } : c)),
      )
      if (editing.parent_id) setRepliesVersion((v) => v + 1)
      setEditing(null)
      setEditBody('')
    }
  }

  const handleDelete = async () => {
    if (!deleting) return

    const res = await fetch(`/api/account/comments/${deleting.id}`, {
      method: 'DELETE',
    })

    if (res.ok) {
      setComments((prev) => prev.filter((c) => c.id !== deleting.id))
      if (deleting.parent_id) {
        // A reply: its parent's count and loaded replies both change.
        setRepliesVersion((v) => v + 1)
        void fetchComments()
      }
      setDeleting(null)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  /**
   * Grow the composer with its content, up to the max-height the class sets
   * (past which it scrolls). Reset to 'auto' first so it shrinks back as text
   * is deleted, not just grows.
   */
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [body])

  const startReply = (comment: Comment) => {
    setReplyingTo(comment)
    setEditing(null)
    textareaRef.current?.focus()
  }

  const startEdit = (comment: Comment) => {
    setEditing(comment)
    setEditBody(comment.body)
    setReplyingTo(null)
  }

  const renderEditor = (comment: Comment) =>
    editing?.id === comment.id ? (
      <div key={comment.id} className="py-2">
        <textarea
          value={editBody}
          onChange={(e) => setEditBody(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:border-foreground/30"
          rows={2}
          autoFocus
        />
        <div className="mt-1.5 flex gap-1.5">
          <Button size="sm" onClick={handleEdit} className="h-7 text-xs">
            Save
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setEditing(null)
              setEditBody('')
            }}
            className="h-7 text-xs"
          >
            Cancel
          </Button>
        </div>
      </div>
    ) : null

  if (loading) {
    return (
      <div className="py-4 text-center text-xs text-muted-foreground">
        Loading comments...
      </div>
    )
  }

  return (
    <div className="space-y-0">
      {/* Comment list */}
      {comments.length > 0 ? (
        <div className="divide-y divide-border/50">
          {comments.map(
            (comment) =>
              renderEditor(comment) ?? (
                <CommentItem
                  key={comment.id}
                  comment={comment}
                  currentMemberId={currentMemberId}
                  onReply={startReply}
                  onEdit={startEdit}
                  onDelete={setDeleting}
                  renderEditor={renderEditor}
                  repliesVersion={repliesVersion}
                />
              ),
          )}
        </div>
      ) : (
        <p className="py-4 text-center text-xs text-muted-foreground">
          No comments yet
        </p>
      )}

      {/* Reply context — sits flush on top of the composer, which drops its own
          top border and top rounding while this shows, so the two read as one
          box rather than two stacked fields. */}
      {replyingTo && (
        <div className="flex items-center gap-2 rounded-t-md border border-b-0 border-input bg-muted/50 px-3 py-1.5">
          <Reply className="h-3 w-3 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">
            Replying to <span className="font-medium text-foreground">{replyingTo.author_name}</span>
          </span>
          <button
            onClick={() => setReplyingTo(null)}
            className="ml-auto text-muted-foreground hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Composer.
          One bordered box containing the textarea and its actions, rather than
          a field with a button parked outside it: the border is what reads as
          "the comment box", so the send control belongs within it. The wrapper
          carries the focus ring and the textarea inside is borderless, so the
          whole thing lights up as a single control when focused. */}
      <div
        data-comment-composer=""
        className={cn(
          'rounded-md border border-input bg-background transition-colors focus-within:border-foreground/30',
          replyingTo && 'rounded-t-none border-t-0',
        )}
      >
        <textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Leave a comment..."
          rows={2}
          className="block max-h-64 min-h-[60px] w-full resize-none overflow-y-auto bg-transparent px-3 pt-2.5 text-sm outline-none placeholder:text-muted-foreground"
        />
        {/* Actions sit on their own row along the bottom edge, right-aligned. */}
        <div className="flex items-center justify-end gap-1 px-2 pb-2">
          <Button
            size="icon"
            variant="ghost"
            onClick={handleSubmit}
            disabled={!body.trim() || submitting}
            aria-label="Send comment"
            // Circular and filled, so the primary action reads as a button even
            // when it sits inside the field rather than beside it.
            className="h-7 w-7 rounded-full bg-foreground text-background hover:bg-foreground/90 hover:text-background disabled:opacity-40"
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete comment?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this comment.
              {(deleting?.reply_count || 0) > 0 && ' All replies will also be deleted.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
