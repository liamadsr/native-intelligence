'use client'

/**
 * Comment threads on a spreadsheet's cells (phase 5). A thread is anchored to a
 * cell range: the grid shows a small corner marker on a cell with an open
 * thread, clicking it opens the thread beside the cell, and a side panel lists
 * every thread grouped by sheet. Threads follow their cells when rows or
 * columns are inserted or deleted (the editor calls `shiftAnchors`).
 *
 * The state lives in `useSpreadsheetComments`; the overlay (markers and the
 * open thread) draws in the sheet's content space so it scrolls with the
 * cells, and the panel is a card at the grid's right.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { Check, MessageSquarePlus, Pencil, RotateCcw, Sparkles, Trash2, X } from 'lucide-react'
import { MentionTextarea } from '@/components/mentions/mention-textarea'
import { useCommentMentions, useMentionMembers, type CommentMentionsPayload } from '@/components/mentions/use-comment-mentions'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { FLOATING_CARD_CLASS } from '@/components/attention/card-skin'
import { parseRange, rangeName } from '@/lib/spreadsheets/a1'
import type { SheetLayout, WorkbookController } from '@/lib/spreadsheets/controller'
import { shiftCommentAnchor, type ExtrasChange } from '@/lib/spreadsheets/extras'
import type { CommentThread, SpreadsheetComment } from '@/lib/spreadsheets/comments'

const CARD_WIDTH = 288

function relative(iso: string): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  try {
    return formatDistanceToNow(new Date(at), { addSuffix: true })
  } catch {
    return ''
  }
}

export interface CommentsApi {
  threads: CommentThread[]
  openCount: number
  loading: boolean
  /** Thread ids whose cells were deleted in this session. */
  orphaned: Set<string>
  reload: () => Promise<void>
  /** `named`: the teammates and records the words `@`-mention (use-comment-mentions.ts). */
  createThread: (input: { sheetId: number; anchor: string; body: string }, named?: CommentMentionsPayload) => Promise<boolean>
  createReply: (parentId: string, body: string, named?: CommentMentionsPayload) => Promise<boolean>
  editComment: (commentId: string, body: string, named?: CommentMentionsPayload) => Promise<boolean>
  setResolved: (commentId: string, resolved: boolean) => Promise<boolean>
  remove: (commentId: string) => Promise<boolean>
  /**
   * May this person write threads (start, reply, resolve)? False for someone
   * it was shared with to view (migration 688 refuses their comments): they
   * read the threads, and the composer, the reply box and Resolve are not shown.
   */
  canComment: boolean
  /** Move the anchors of threads affected by a structural change, and save them. Undo sends the inverse. */
  shiftAnchors: (change: ExtrasChange) => void
}

export function useSpreadsheetComments(spreadsheetId: string, onError: (message: string) => void, opts: { canComment?: boolean } = {}): CommentsApi {
  const canComment = opts.canComment !== false
  const [threads, setThreads] = useState<CommentThread[]>([])
  const [loading, setLoading] = useState(true)
  const [orphaned, setOrphaned] = useState<Set<string>>(new Set())
  const threadsRef = useRef<CommentThread[]>([])
  threadsRef.current = threads

  const base = `/api/account/spreadsheets/${spreadsheetId}/comments`

  const reload = useCallback(async () => {
    try {
      const res = await fetch(base)
      const json = (await res.json().catch(() => ({}))) as { threads?: CommentThread[]; error?: string }
      if (!res.ok) throw new Error(json.error || 'Could not load comments')
      setThreads(json.threads ?? [])
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not load comments')
    } finally {
      setLoading(false)
    }
  }, [base, onError])

  useEffect(() => {
    void reload()
  }, [reload])

  const post = useCallback(
    async (body: unknown): Promise<boolean> => {
      try {
        const res = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        const json = (await res.json().catch(() => ({}))) as { error?: string }
        if (!res.ok) throw new Error(json.error || 'Could not save the comment')
        await reload()
        return true
      } catch (e) {
        onError(e instanceof Error ? e.message : 'Could not save the comment')
        return false
      }
    },
    [base, onError, reload],
  )

  const patch = useCallback(
    async (commentId: string, body: unknown): Promise<boolean> => {
      try {
        const res = await fetch(`${base}/${commentId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        const json = (await res.json().catch(() => ({}))) as { error?: string }
        if (!res.ok) throw new Error(json.error || 'Could not change the comment')
        await reload()
        return true
      } catch (e) {
        onError(e instanceof Error ? e.message : 'Could not change the comment')
        return false
      }
    },
    [base, onError, reload],
  )

  // A view-only reader (688) writes no thread: said here once, whichever control asked.
  const refused = useCallback(async () => {
    onError('You can view this spreadsheet but not comment on it.')
    return false
  }, [onError])
  const createThread = useCallback((input: { sheetId: number; anchor: string; body: string }, named?: CommentMentionsPayload) => (canComment ? post({ sheet_id: input.sheetId, anchor: input.anchor, body: input.body, ...(named ?? {}) }) : refused()), [post, canComment, refused])
  const createReply = useCallback((parentId: string, body: string, named?: CommentMentionsPayload) => (canComment ? post({ parent_id: parentId, body, ...(named ?? {}) }) : refused()), [post, canComment, refused])
  const editComment = useCallback((commentId: string, body: string, named?: CommentMentionsPayload) => (canComment ? patch(commentId, { body, ...(named ?? {}) }) : refused()), [patch, canComment, refused])
  const setResolved = useCallback((commentId: string, resolved: boolean) => (canComment ? patch(commentId, { resolved }) : refused()), [patch, canComment, refused])

  const remove = useCallback(
    async (commentId: string): Promise<boolean> => {
      try {
        const res = await fetch(`${base}/${commentId}`, { method: 'DELETE' })
        const json = (await res.json().catch(() => ({}))) as { error?: string }
        if (!res.ok) throw new Error(json.error || 'Could not delete the comment')
        await reload()
        return true
      } catch (e) {
        onError(e instanceof Error ? e.message : 'Could not delete the comment')
        return false
      }
    },
    [base, onError, reload],
  )

  const shiftAnchors = useCallback(
    (change: ExtrasChange) => {
      const affectedSheet = change.type === 'duplicateSheet' ? -1 : change.sheetId
      let touched = false
      const nextOrphan = new Set(orphanedRef.current)
      const next = threadsRef.current.map((thread) => {
        if (thread.sheet_id !== affectedSheet || !thread.anchor) return thread
        const parsed = parseRange(thread.anchor)
        if (!parsed) return thread
        const { range, removed } = shiftCommentAnchor(parsed, change)
        const anchor = rangeName(range)
        if (removed) nextOrphan.add(thread.id)
        else nextOrphan.delete(thread.id)
        if (anchor !== thread.anchor) {
          touched = true
          // Save the moved anchor; a failure is quiet (the next load corrects it).
          void fetch(`${base}/${thread.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ anchor }),
          }).catch(() => undefined)
          return { ...thread, anchor, root: { ...thread.root, anchor } }
        }
        return thread
      })
      setOrphaned(nextOrphan)
      if (touched) setThreads(next)
    },
    [base],
  )
  const orphanedRef = useRef(orphaned)
  orphanedRef.current = orphaned

  const openCount = useMemo(() => threads.filter((t) => !t.resolved_at).length, [threads])

  return { threads, openCount, loading, orphaned, reload, createThread, createReply, editComment, setResolved, remove, canComment, shiftAnchors }
}

// ── The overlay: markers and the open thread, in the sheet's content space ───

interface OverlayProps {
  workbook: WorkbookController
  sheet: number
  layout: SheetLayout
  comments: CommentsApi
  memberId: string
  openThreadId: string | null
  composingAnchor: string | null
  onOpenThread: (id: string | null) => void
  onCloseComposer: () => void
}

export function CommentOverlay({ workbook, sheet, layout, comments, memberId, openThreadId, composingAnchor, onOpenThread, onCloseComposer }: OverlayProps) {
  const sheetId = workbook.sheetIdAt(sheet)
  const onSheet = comments.threads.filter((t) => t.sheet_id === sheetId && t.anchor)

  // One marker per cell that has an open thread; it opens the newest there.
  const markers = new Map<string, { row: number; column: number; threadId: string }>()
  for (const thread of onSheet) {
    if (thread.resolved_at) continue
    const range = thread.anchor ? parseRange(thread.anchor) : null
    if (!range) continue
    markers.set(`${range.r1}:${range.c1}`, { row: range.r1, column: range.c1, threadId: thread.id })
  }

  const open = openThreadId ? onSheet.find((t) => t.id === openThreadId) ?? null : null
  const openRange = open?.anchor ? parseRange(open.anchor) : null
  const composeRange = composingAnchor ? parseRange(composingAnchor) : null

  const cardAt = (row: number, column: number) => {
    const left = Math.min(layout.columnStarts[Math.min(column, layout.columns)] ?? 0, Math.max(0, layout.columnStarts[layout.columns] - CARD_WIDTH))
    const top = layout.rowStarts[Math.min(row, layout.rows) - 1] ?? 0
    return { left, top }
  }

  return (
    <>
      {[...markers.values()].map((m) => (
        <button
          key={m.threadId}
          type="button"
          aria-label={`Open comment on ${rangeName({ r1: m.row, c1: m.column, r2: m.row, c2: m.column })}`}
          data-comment-marker={`${m.row}:${m.column}`}
          className="absolute z-[14] h-0 w-0 border-l-[8px] border-t-[8px] border-l-transparent border-t-amber-500 hover:border-t-amber-600"
          style={{ left: (layout.columnStarts[m.column] ?? 0) - 8, top: layout.rowStarts[m.row - 1] ?? 0 }}
          onPointerDown={(e) => {
            e.stopPropagation()
            onOpenThread(m.threadId)
          }}
        />
      ))}

      {open && openRange && (
        <div className="absolute z-30 max-[480px]:!fixed max-[480px]:!inset-x-2 max-[480px]:!bottom-2 max-[480px]:!top-auto max-[480px]:!z-50" style={cardAt(openRange.r1, openRange.c1 + (openRange.c2 - openRange.c1) + 1)} onPointerDown={(e) => e.stopPropagation()}>
          <ThreadCard thread={open} comments={comments} memberId={memberId} orphaned={comments.orphaned.has(open.id)} onClose={() => onOpenThread(null)} />
        </div>
      )}

      {composeRange && !openThreadId && comments.canComment && (
        <div className="absolute z-30 max-[480px]:!fixed max-[480px]:!inset-x-2 max-[480px]:!bottom-2 max-[480px]:!top-auto max-[480px]:!z-50" style={cardAt(composeRange.r1, composeRange.c2 + 1)} onPointerDown={(e) => e.stopPropagation()}>
          <Composer
            anchorLabel={composingAnchor ?? ''}
            onCancel={onCloseComposer}
            memberId={memberId}
            onSubmit={async (body, named) => {
              const ok = await comments.createThread({ sheetId, anchor: composingAnchor ?? '', body }, named)
              if (ok) onCloseComposer()
            }}
          />
        </div>
      )}
    </>
  )
}

function ThreadCard({ thread, comments, memberId, orphaned, onClose }: { thread: CommentThread; comments: CommentsApi; memberId: string; orphaned: boolean; onClose: () => void }) {
  const [reply, setReply] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const resolved = !!thread.resolved_at
  const all = [thread.root, ...thread.replies]
  return (
    <div className={cn(FLOATING_CARD_CLASS, 'flex w-72 max-[480px]:w-auto flex-col gap-2 p-3 shadow-lg')} data-comment-thread={thread.id}>
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs text-muted-foreground">{thread.anchor}{orphaned ? ' · its cells were deleted' : ''}</span>
        <div className="flex items-center gap-1">
          {comments.canComment ? (
            <button
              type="button"
              aria-label={resolved ? 'Reopen thread' : 'Resolve thread'}
              title={resolved ? 'Reopen' : 'Resolve'}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => void comments.setResolved(thread.id, !resolved)}
            >
              {resolved ? <RotateCcw className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
            </button>
          ) : null}
          <button type="button" aria-label="Close thread" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="flex max-h-64 flex-col gap-2 overflow-y-auto">
        {all.map((c) => (
          <CommentItem
            key={c.id}
            comment={c}
            mine={c.author_id === memberId}
            editing={editing === c.id}
            onEdit={() => setEditing(c.id)}
            onCancelEdit={() => setEditing(null)}
            memberId={memberId}
            onSaveEdit={async (body, named) => {
              const ok = await comments.editComment(c.id, body, named)
              if (ok) setEditing(null)
            }}
            onDelete={() => void comments.remove(c.id)}
          />
        ))}
      </div>
      {resolved ? (
        <p className="text-xs text-muted-foreground">Resolved{thread.resolved_by_name ? ` by ${thread.resolved_by_name}` : ''}.</p>
      ) : !comments.canComment ? null : (
        <ReplyBox
          value={reply}
          onChange={setReply}
          memberId={memberId}
          onSend={async (named) => {
            const body = reply.trim()
            if (!body) return false
            const ok = await comments.createReply(thread.id, body, named(body))
            if (ok) setReply('')
            return ok
          }}
        />
      )}
    </div>
  )
}

function CommentItem({
  comment,
  mine,
  editing,
  onEdit,
  onCancelEdit,
  onSaveEdit,
  memberId,
  onDelete,
}: {
  comment: SpreadsheetComment
  mine: boolean
  editing: boolean
  onEdit: () => void
  onCancelEdit: () => void
  onSaveEdit: (body: string, named: CommentMentionsPayload) => void
  memberId: string
  onDelete: () => void
}) {
  const [draft, setDraft] = useState(comment.body)
  const mentions = useCommentMentions(useMentionMembers(memberId), comment.mentions)
  useEffect(() => setDraft(comment.body), [comment.body, editing])
  return (
    <div className="rounded-md bg-muted/40 px-2 py-1.5 text-sm">
      <div className="mb-0.5 flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate text-xs font-medium text-foreground">{comment.author_name ?? 'Someone'}</span>
          {comment.via_agent ? (
            <span data-comment-assistant title="Written by the assistant for them" className="flex shrink-0 items-center gap-0.5 rounded bg-foreground/[0.06] px-1 text-[10px] text-muted-foreground">
              <Sparkles className="h-2.5 w-2.5" /> assistant
            </span>
          ) : null}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{relative(comment.created_at)}</span>
      </div>
      {editing ? (
        <div className="flex flex-col gap-1">
          <MentionTextarea
            {...mentions.textareaProps}
            autoFocus
            aria-label="Edit comment"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (draft.trim()) onSaveEdit(draft.trim(), mentions.payload(draft.trim()))
              } else if (e.key === 'Escape') onCancelEdit()
            }}
            className="w-full resize-none rounded border border-border bg-background px-1.5 py-1 text-sm outline-none focus:border-primary"
            rows={2}
          />
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onCancelEdit}>Cancel</Button>
            <Button size="sm" className="h-6 px-2 text-xs" disabled={!draft.trim()} onClick={() => onSaveEdit(draft.trim(), mentions.payload(draft.trim()))}>Save</Button>
          </div>
        </div>
      ) : (
        <>
          <p className="whitespace-pre-wrap break-words text-foreground">{comment.body}</p>
          {mine && (
            <div className="mt-0.5 flex gap-1">
              <button type="button" aria-label="Edit comment" className="rounded p-0.5 text-muted-foreground hover:text-foreground" onClick={onEdit}>
                <Pencil className="h-3 w-3" />
              </button>
              <button type="button" aria-label="Delete comment" className="rounded p-0.5 text-muted-foreground hover:text-destructive" onClick={onDelete}>
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ReplyBox({ value, onChange, onSend, memberId }: { value: string; onChange: (v: string) => void; onSend: (named: (text: string) => CommentMentionsPayload) => Promise<boolean>; memberId: string }) {
  const mentions = useCommentMentions(useMentionMembers(memberId))
  return (
    <MentionTextarea
      {...mentions.textareaProps}
      aria-label="Reply"
      placeholder="Reply… (@ to mention, Enter to send)"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          void onSend(mentions.payload).then((ok) => ok && mentions.reset())
        }
      }}
      className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary"
      rows={2}
    />
  )
}

function Composer({ anchorLabel, onCancel, onSubmit, memberId }: { anchorLabel: string; onCancel: () => void; onSubmit: (body: string, named: CommentMentionsPayload) => void; memberId: string }) {
  const [body, setBody] = useState('')
  const mentions = useCommentMentions(useMentionMembers(memberId))
  return (
    <div className={cn(FLOATING_CARD_CLASS, 'flex w-72 max-[480px]:w-auto flex-col gap-2 p-3 shadow-lg')} data-comment-composer>
      <span className="font-mono text-xs text-muted-foreground">{anchorLabel}</span>
      <MentionTextarea
        {...mentions.textareaProps}
        autoFocus
        aria-label="New comment"
        placeholder="Comment… (@ to mention, Enter to send)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            if (body.trim()) onSubmit(body.trim(), mentions.payload(body.trim()))
          } else if (e.key === 'Escape') onCancel()
        }}
        className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary"
        rows={3}
      />
      <div className="flex justify-end gap-1">
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onCancel}>Cancel</Button>
        <Button size="sm" className="h-7 px-2 text-xs" disabled={!body.trim()} onClick={() => body.trim() && onSubmit(body.trim(), mentions.payload(body.trim()))}>Comment</Button>
      </div>
    </div>
  )
}

// ── The side panel: every thread, grouped by sheet ───────────────────────────

interface PanelProps {
  workbook: WorkbookController
  comments: CommentsApi
  onClose: () => void
  onGoTo: (thread: CommentThread) => void
}

export function CommentsPanel({ workbook, comments, onClose, onGoTo }: PanelProps) {
  const [showResolved, setShowResolved] = useState(false)
  const sheets = workbook.sheets()
  const nameOf = (id: number | null) => sheets.find((s) => s.id === id)?.name ?? 'Deleted sheet'
  const shown = comments.threads.filter((t) => showResolved || !t.resolved_at)

  // Group by sheet id, keeping the open-first order within each group.
  const groups = new Map<number, CommentThread[]>()
  for (const thread of shown) {
    const key = thread.sheet_id ?? -1
    const list = groups.get(key) ?? []
    list.push(thread)
    groups.set(key, list)
  }

  return (
    <aside aria-label="Comments" className={cn(FLOATING_CARD_CLASS, 'absolute bottom-3 right-3 top-3 z-40 flex w-[320px] max-w-[calc(100%-1.5rem)] max-[480px]:!w-[calc(100%-1.5rem)] flex-col shadow-lg')}>
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
        <h2 className="text-sm font-semibold text-foreground">Comments</h2>
        <button type="button" aria-label="Close comments" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onClose}>
          <X className="h-4 w-4" />
        </button>
      </div>
      <label className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
        <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
        Show resolved
      </label>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {shown.length === 0 ? (
          <p className="px-1 py-6 text-center text-sm text-muted-foreground">No comments yet.</p>
        ) : (
          [...groups.entries()].map(([sheetId, list]) => (
            <div key={sheetId} className="mb-3">
              <h3 className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{nameOf(sheetId)}</h3>
              <ul className="flex flex-col gap-1">
                {list.map((thread) => (
                  <li key={thread.id}>
                    <button
                      type="button"
                      className="w-full rounded-md border border-border/60 px-2 py-1.5 text-left hover:bg-accent/50"
                      onClick={() => onGoTo(thread)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-xs text-muted-foreground">{thread.anchor ?? '—'}</span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {thread.resolved_at ? 'Resolved' : thread.reply_count > 0 ? `${thread.reply_count + 1} comments` : '1 comment'}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-sm text-foreground">{thread.root.body}</p>
                      <p className="truncate text-[11px] text-muted-foreground">{thread.root.author_name ?? 'Someone'} · {relative(thread.root.created_at)}</p>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </aside>
  )
}

export { MessageSquarePlus as CommentIcon }
