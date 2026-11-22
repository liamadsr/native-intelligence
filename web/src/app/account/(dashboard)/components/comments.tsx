'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
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
import { MoreHorizontal, Pencil, Trash2, Reply, X, ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { cachedJson } from '@/lib/cached-fetch'
import { useWorkspaceId } from '@/app/account/workspace-switcher'
import { MentionText } from '@/components/entity-refs/mention-text'
import type { LabeledMentionRef } from '@/lib/entity-links/mentionable'
import { hasMention } from '@/lib/team-chat/compose'
import { MENTION_PICKER_KINDS, menuRowMention, type MenuSearchRow } from '@/lib/search/menu-search'
import { ChatInput, type ChatInputUnavailable, type ChatInputVoice } from '@/app/account/(dashboard)/chat/chat-input'
import type { ComposerMentionList, ComposerMentionOption } from '@/app/account/(dashboard)/chat/command-menu-model'
import { useVoiceAvailability } from '@/hooks/use-voice-availability'
import { useOptionalRecordingStable } from '@/hooks/recording-context'
import { memberName, type Member } from '../views/team-chat-message-parts'

type CommentableType = 'action' | 'capture' | 'document' | 'project' | 'contact' | 'company'

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
  /** The members it @-mentions (ids), and the records: the one mention format (migration 671). */
  mentions?: string[]
  record_mentions?: LabeledMentionRef[]
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

/** A comment that didn't post: its words stay in the box. */
const COMMENT_NOT_POSTED = 'Your comment wasn’t posted. Try again.'
const NO_NOTES: never[] = []
const NO_FILES: never[] = []
const noop = () => {}

/** A comment is words only: the + menu says so, and a drop or a paste is refused. */
const COMMENT_UNAVAILABLE: ChatInputUnavailable = {
  files: { label: 'Files and photos', reason: 'Comments take text only' },
}

const ROUTE_MAP: Record<CommentableType, string> = {
  action: 'actions',
  capture: 'captures',
  document: 'documents',
  project: 'projects',
  contact: 'contacts',
  company: 'companies',
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
  memberNames,
  repliesVersion = 0,
  depth = 0,
}: {
  comment: Comment
  /** Each member's name by id, for the people a comment mentions. */
  memberNames: ReadonlyMap<string, string>
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
          <p className="select-text mt-0.5 text-sm whitespace-pre-wrap">
            <MentionText
              text={comment.body}
              people={(comment.mentions ?? []).flatMap((id) => memberNames.get(id) ?? [])}
              records={comment.record_mentions ?? []}
              from="comment"
            />
          </p>
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
                    memberNames={memberNames}
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
  // A post on its way: a second Enter meanwhile (before a render) posts nothing.
  const submittingRef = useRef(false)
  const [replyingTo, setReplyingTo] = useState<Comment | null>(null)
  const [editing, setEditing] = useState<Comment | null>(null)
  const [editBody, setEditBody] = useState('')
  // What the edit box has picked (teammates and records): started from the
  // comment's stored mentions, grown by new `@` picks; only what the edited
  // words still name is sent.
  const [editPicked, setEditPicked] = useState<Array<{ id: string; label: string }>>([])
  const [editPickedRecords, setEditPickedRecords] = useState<LabeledMentionRef[]>([])
  const [deleting, setDeleting] = useState<Comment | null>(null)
  // Bumped whenever a reply changes, so each thread's loaded replies refetch.
  const [repliesVersion, setRepliesVersion] = useState(0)
  const [fetchedMemberId, setFetchedMemberId] = useState<string | null>(null)
  const workspaceId = useWorkspaceId()
  // The composer (the main chat's ChatInput) owns its field; this is its box, to reach the field for focus.
  const composerRef = useRef<HTMLDivElement>(null)
  const [members, setMembers] = useState<Member[]>([])
  // What `@` picked for the comment being written: teammates, and records (a task, a doc, a capture…).
  const [picked, setPicked] = useState<Array<{ id: string; label: string }>>([])
  const [pickedRecords, setPickedRecords] = useState<LabeledMentionRef[]>([])

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

  // The workspace's members, for `@` in the box (team chat's list, shared through cachedJson).
  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false
    cachedJson<{ members?: Member[] }>('/api/account/workspace/members', { scope: workspaceId })
      .then((data) => {
        if (!cancelled) setMembers(Array.isArray(data?.members) ? data.members : [])
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [workspaceId])

  // Dictation into the box, as in the main chat and team chat (the desktop
  // app). Dictation only: no voice mode, which is a conversation with the agent.
  const recording = useOptionalRecordingStable()
  const availability = useVoiceAvailability({ recording: !!(recording?.isRecording || recording?.isStarting) })
  const voice = useMemo<ChatInputVoice | undefined>(
    () => (availability.dictation ? { availability: { ...availability, conversation: false, visible: true } } : undefined),
    [availability],
  )

  // `@` lists the teammates (not the viewer), then any record the one picker
  // finds: a pick puts "@Name" in the words and rides with the comment. The new
  // comment box and each edit box share the list; they only differ in where the
  // picks are kept, so the builder takes the two setters.
  const makeMentionList = useCallback(
    (
      setMembersPicked: typeof setPicked,
      setRecordsPicked: typeof setPickedRecords,
    ): ComposerMentionList => ({
      options: members
        .filter((m) => m.id !== currentMemberId)
        .map<ComposerMentionOption>((m) => ({ id: m.id, label: memberName(m) })),
      // A teammate picked is kept: their mention goes with the comment while "@Name" is still in it.
      onPick: (o) => setMembersPicked((prev) => (prev.some((p) => p.id === o.id) ? prev : [...prev, { id: o.id, label: o.label }])),
      // Any record, as in team chat: the one picker's kinds, found by the composer's own search.
      records: {
        kinds: MENTION_PICKER_KINDS,
        onPick: (row: MenuSearchRow) => {
          const m = menuRowMention(row)
          if (!m) return
          setRecordsPicked((prev) => (prev.some((p) => p.type === m.type && p.id === m.id) ? prev : [...prev, m]))
        },
      },
    }),
    [members, currentMemberId],
  )
  const mentionList = useMemo(() => makeMentionList(setPicked, setPickedRecords), [makeMentionList])
  const editMentionList = useMemo(() => makeMentionList(setEditPicked, setEditPickedRecords), [makeMentionList])
  const memberNames = useMemo(() => new Map(members.map((m) => [m.id, memberName(m)])), [members])

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
    if (!text || submittingRef.current) return

    submittingRef.current = true
    const payload: { body: string; parent_id?: string; mentions?: string[]; records?: LabeledMentionRef[] } = { body: text }
    if (replyingTo) payload.parent_id = replyingTo.id
    // Only what is still in the words (a pick deleted from the text mentions no one).
    const mentions = picked.filter((p) => hasMention(text, p.label)).map((p) => p.id)
    const records = pickedRecords.filter((r) => hasMention(text, r.label))
    if (mentions.length) payload.mentions = mentions
    if (records.length) payload.records = records

    // A comment that doesn't post says so and keeps its words (it used to do
    // nothing at all, and a dropped connection left every later send ignored).
    try {
      const res = await fetch(`/api/account/${routeBase}/${commentableId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (res.ok) {
        setBody('')
        setPicked([])
        setPickedRecords([])
        setReplyingTo(null)
        await fetchComments()
        if (payload.parent_id) setRepliesVersion((v) => v + 1)
      } else {
        toast.error(COMMENT_NOT_POSTED)
      }
    } catch {
      toast.error(COMMENT_NOT_POSTED)
    } finally {
      submittingRef.current = false
    }
  }

  const handleEdit = async () => {
    if (!editing || !editBody.trim()) return
    const text = editBody.trim()

    // Only what the edited words still name (stored mentions plus new picks).
    const mentions = editPicked.filter((p) => hasMention(text, p.label)).map((p) => p.id)
    const records = editPickedRecords.filter((r) => hasMention(text, r.label))

    const res = await fetch(`/api/account/comments/${editing.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: text, mentions, records }),
    }).catch(() => null)

    if (!res?.ok) {
      toast.error('Your edit wasn’t saved. Try again.')
      return
    }
    const data = await res.json()
    setComments((prev) =>
      prev.map((c) => (c.id === editing.id ? { ...c, ...data.comment } : c)),
    )
    if (editing.parent_id) setRepliesVersion((v) => v + 1)
    setEditing(null)
    setEditBody('')
    setEditPicked([])
    setEditPickedRecords([])
  }

  const handleDelete = async () => {
    if (!deleting) return

    const res = await fetch(`/api/account/comments/${deleting.id}`, {
      method: 'DELETE',
    }).catch(() => null)

    if (!res?.ok) {
      toast.error('The comment wasn’t deleted. Try again.')
      return
    }
    setComments((prev) => prev.filter((c) => c.id !== deleting.id))
    if (deleting.parent_id) {
      // A reply: its parent's count and loaded replies both change.
      setRepliesVersion((v) => v + 1)
      void fetchComments()
    }
    setDeleting(null)
  }

  // The box is memoized: hand it one stable send that reads the latest draft.
  const submitRef = useRef(handleSubmit)
  submitRef.current = handleSubmit
  const onComposerSubmit = useCallback(() => void submitRef.current(), [])
  // The same for the edit box (which also owns its field and is memoized).
  const editSubmitRef = useRef(handleEdit)
  editSubmitRef.current = handleEdit
  const onEditSubmit = useCallback(() => void editSubmitRef.current(), [])

  const focusComposer = () => {
    requestAnimationFrame(() => composerRef.current?.querySelector('textarea')?.focus())
  }

  const startReply = (comment: Comment) => {
    setReplyingTo(comment)
    setEditing(null)
    focusComposer()
  }

  const startEdit = (comment: Comment) => {
    setEditing(comment)
    setEditBody(comment.body)
    // Seed the picks from what the comment already mentions, so a save that
    // doesn't touch them keeps them (and a new `@` pick adds to them).
    setEditPicked((comment.mentions ?? []).flatMap((id) => {
      const label = memberNames.get(id)
      return label ? [{ id, label }] : []
    }))
    setEditPickedRecords(comment.record_mentions ?? [])
    setReplyingTo(null)
  }

  const cancelEdit = () => {
    setEditing(null)
    setEditBody('')
    setEditPicked([])
    setEditPickedRecords([])
  }

  const renderEditor = (comment: Comment) =>
    editing?.id === comment.id ? (
      <div key={comment.id} data-comment-edit="" className="py-2">
        <ChatInput
          value={editBody}
          onChange={setEditBody}
          onSubmit={onEditSubmit}
          onStop={noop}
          isLoading={false}
          attachedNotes={NO_NOTES}
          onAttachNote={noop}
          onRemoveNote={noop}
          attachedFiles={NO_FILES}
          onAttachFiles={noop}
          onRemoveFile={noop}
          unavailable={COMMENT_UNAVAILABLE}
          placeholder="Edit comment…"
          mainComposer={false}
          mentionList={editMentionList}
          autoFocus
          layout="inline"
        />
        <div className="mt-1.5 flex gap-1.5">
          <Button size="sm" onClick={handleEdit} className="h-7 text-xs">
            Save
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={cancelEdit}
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
                  memberNames={memberNames}
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

      {/* The box: the main chat's composer (ChatInput, not the main one), in
          team chat's one-row pill ("+", the field, the mic, send). Enter
          posts, Shift+Enter is a new line. A reply says whom it answers just
          above the pill. */}
      <div ref={composerRef} data-comment-composer="" className="pt-2">
        {replyingTo && (
          <div data-comment-replying="" className="mb-1 flex items-center gap-2 px-4 text-xs text-muted-foreground">
            <Reply className="h-3 w-3" />
            <span>
              Replying to <span className="font-medium text-foreground">{replyingTo.author_name}</span>
            </span>
            <button
              type="button"
              aria-label="Cancel reply"
              onClick={() => setReplyingTo(null)}
              className="ml-auto hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
        <ChatInput
          value={body}
          onChange={setBody}
          onSubmit={onComposerSubmit}
          onStop={noop}
          isLoading={false}
          attachedNotes={NO_NOTES}
          onAttachNote={noop}
          onRemoveNote={noop}
          attachedFiles={NO_FILES}
          onAttachFiles={noop}
          onRemoveFile={noop}
          unavailable={COMMENT_UNAVAILABLE}
          placeholder={replyingTo ? `Reply to ${replyingTo.author_name || 'comment'}…` : 'Leave a comment…'}
          mainComposer={false}
          mentionList={mentionList}
          voice={voice}
          layout="inline"
        />
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
