'use client'

/**
 * Comments on a file in the viewer (migration 706; docs/plans/drive-files.md,
 * phase 4): a panel of threads beside the file, a pin on the PDF page where
 * each thread was placed, and "Comment" mode, in which a click on a page
 * pins a new thread there. A thread may also be about the whole file.
 * @-mentions name teammates, who are told when they can open the file
 * (record-comments/notify.ts). Anyone who can read the file writes and
 * resolves; only its author changes or deletes a comment (706's rules; this
 * only hides the buttons that would be refused).
 */
import * as React from 'react'
import { Check, Loader2, MessageSquare, MessageSquarePlus, Pencil, RotateCcw, Sparkles, Trash2, X } from 'lucide-react'
import { MentionTextarea } from '@/components/mentions/mention-textarea'
import { useCommentMentions, useMentionMembers, type CommentMentionsPayload } from '@/components/mentions/use-comment-mentions'
import type { ComposerMentionOption } from '@/app/account/(dashboard)/chat/command-menu-model'
import { threadsOfFile, type FileComment, type FileTarget, type FileThread } from '@/lib/drive/file-comments'
import { cn } from '@/lib/utils'
import type { PdfPageOverlay } from './pdf-viewer'

export type FileCommentsState = 'loading' | 'ready' | 'off' | 'error'

export interface FileComments {
  state: FileCommentsState
  threads: FileThread[]
  me: string | null
  open: number
  add: (input: { body: string; parent_id?: string; page?: number; x?: number; y?: number } & Partial<CommentMentionsPayload>) => Promise<string | null>
  resolve: (id: string, resolved: boolean) => Promise<string | null>
  edit: (id: string, body: string, named?: CommentMentionsPayload) => Promise<string | null>
  remove: (id: string) => Promise<string | null>
}

async function call(url: string, method: string, body?: unknown): Promise<string | null> {
  try {
    const r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
    if (r.ok) return null
    const j = (await r.json().catch(() => null)) as { error?: string } | null
    return j?.error ?? 'That did not work.'
  } catch {
    return 'You seem to be offline.'
  }
}

/** The query that names a file to the comments route. */
export function targetQuery(t: FileTarget): string {
  return t.kind === 'attachment' ? `attachment=${encodeURIComponent(t.id)}` : `message=${encodeURIComponent(t.messageId)}&path=${encodeURIComponent(t.path)}`
}

/** A file's comments, read when it opens and again after every change here. */
export function useFileComments(target: FileTarget | null | undefined, fileName: string): FileComments {
  const [state, setState] = React.useState<FileCommentsState>('loading')
  const [comments, setComments] = React.useState<FileComment[]>([])
  const [me, setMe] = React.useState<string | null>(null)
  const key = target ? targetQuery(target) : null
  const load = React.useCallback(async () => {
    if (!key) return
    try {
      const r = await fetch(`/api/account/files/comments?${key}`)
      if (r.status === 503) return setState('off')
      if (!r.ok) return setState((s) => (s === 'ready' ? s : 'error'))
      const j = (await r.json()) as { comments: FileComment[]; me: string }
      setComments(j.comments)
      setMe(j.me)
      setState('ready')
    } catch {
      setState((s) => (s === 'ready' ? s : 'error'))
    }
  }, [key])
  React.useEffect(() => {
    setState(key ? 'loading' : 'off')
    setComments([])
    void load()
  }, [key, load])
  const threads = React.useMemo(() => threadsOfFile(comments), [comments])
  const open = React.useMemo(() => threads.filter((t) => !t.root.resolved_at).length, [threads])
  const after = React.useCallback(async (err: string | null) => {
    if (!err) await load()
    return err
  }, [load])
  return React.useMemo(() => {
    const names = target ? (target.kind === 'attachment' ? { attachment: target.id } : { message: target.messageId, path: target.path }) : {}
    return {
      state,
      threads,
      me,
      open,
      add: (input) => call('/api/account/files/comments', 'POST', { ...names, file_name: fileName, ...input }).then(after),
      resolve: (id, resolved) => call(`/api/account/files/comments/${id}`, 'PATCH', { resolved }).then(after),
      edit: (id, body, named) => call(`/api/account/files/comments/${id}`, 'PATCH', { body, ...(named ?? {}) }).then(after),
      remove: (id) => call(`/api/account/files/comments/${id}`, 'DELETE').then(after),
    }
  }, [state, threads, me, open, after, target, fileName])
}

function when(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const mins = Math.round((Date.now() - d.getTime()) / 60_000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const MentionMembers = React.createContext<readonly ComposerMentionOption[]>([])

function Composer({ placeholder, label, autoFocus, initial = '', already, send: sendLabel = 'Send', onSend, onCancel }: { placeholder: string; label: string; autoFocus?: boolean; initial?: string; already?: readonly string[]; send?: string; onSend: (body: string, named: CommentMentionsPayload) => Promise<string | null>; onCancel?: () => void }) {
  const [text, setText] = React.useState(initial)
  const mentions = useCommentMentions(React.useContext(MentionMembers), already)
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState<string | null>(null)
  const send = async () => {
    const body = text.trim()
    if (!body || busy) return
    setBusy(true)
    const e = await onSend(body, mentions.payload(body))
    setBusy(false)
    setErr(e)
    if (!e) {
      setText('')
      mentions.reset()
    }
  }
  return (
    <div>
      <div className="flex items-end gap-1.5">
        <MentionTextarea
          {...mentions.textareaProps}
          aria-label={label}
          data-file-comment-input=""
          value={text}
          autoFocus={autoFocus}
          rows={1}
          maxLength={10_000}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && onCancel) {
              e.stopPropagation()
              onCancel()
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
          className="max-h-32 min-h-8 flex-1 resize-none rounded-md border border-border/60 bg-background/60 px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground/30 [field-sizing:content]"
        />
        <button type="button" data-file-comment-send="" disabled={!text.trim() || busy} onClick={() => void send()} className="flex h-8 shrink-0 items-center rounded-md bg-foreground px-2.5 text-xs font-medium text-background disabled:opacity-40">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : sendLabel}
        </button>
      </div>
      {err ? <p role="alert" className="pt-1 text-[11px] text-red-500">{err}</p> : null}
    </div>
  )
}

function Words({ comment, mine, onDelete, onEdit }: { comment: FileComment; mine: boolean; onDelete: () => void; onEdit: (body: string, named: CommentMentionsPayload) => Promise<string | null> }) {
  const [editing, setEditing] = React.useState(false)
  if (editing) {
    return (
      <Composer
        autoFocus
        label="Edit comment"
        placeholder="Edit comment…"
        initial={comment.body}
        send="Save"
        already={comment.mentions}
        onCancel={() => setEditing(false)}
        onSend={async (body, named) => {
          const e = body === comment.body ? null : await onEdit(body, named)
          if (!e) setEditing(false)
          return e
        }}
      />
    )
  }
  return (
    <div className="group/comment">
      <div className="flex items-baseline gap-1.5">
        <span className="truncate text-xs font-medium text-foreground">{comment.author_name ?? (mine ? 'You' : 'Someone')}</span>
        {comment.via_agent ? (
          <span title="Written by the assistant for them" className="flex shrink-0 items-center gap-0.5 rounded bg-foreground/[0.06] px-1 text-[10px] text-muted-foreground">
            <Sparkles className="h-2.5 w-2.5" /> assistant
          </span>
        ) : null}
        <span className="shrink-0 text-[11px] text-muted-foreground">{when(comment.created_at)}</span>
        {mine ? (
          <button type="button" aria-label="Edit comment" onClick={() => setEditing(true)} className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:text-foreground focus:opacity-100 group-hover/comment:opacity-100">
            <Pencil className="h-3 w-3" />
          </button>
        ) : null}
        {mine ? (
          <button type="button" aria-label="Delete comment" onClick={onDelete} className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:text-red-500 focus:opacity-100 group-hover/comment:opacity-100">
            <Trash2 className="h-3 w-3" />
          </button>
        ) : null}
      </div>
      <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/90">{comment.body}</p>
    </div>
  )
}

function ThreadView({ thread, comments, active, onFocus, number }: { thread: FileThread; comments: FileComments; active: boolean; onFocus: () => void; number: number | null }) {
  const [replying, setReplying] = React.useState(false)
  const [err, setErr] = React.useState<string | null>(null)
  const { root, replies } = thread
  const resolved = !!root.resolved_at
  const act = (p: Promise<string | null>) => void p.then(setErr)
  return (
    <li data-file-thread={root.id} data-resolved={resolved || undefined} className={cn('rounded-lg border border-border/50 p-2.5', active && 'border-foreground/30 bg-foreground/[0.03]', resolved && 'opacity-60')}>
      <button type="button" onClick={onFocus} className="mb-1 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
        {number !== null ? <span className="flex size-4 items-center justify-center rounded-full bg-amber-400 text-[9px] font-semibold text-black">{number}</span> : null}
        {root.page ? `Page ${root.page}` : 'The whole file'}
      </button>
      <Words comment={root} mine={!!comments.me && root.author_id === comments.me} onEdit={(b, n) => comments.edit(root.id, b, n)} onDelete={() => (replies.length && !window.confirm('Delete this thread and its replies?') ? undefined : act(comments.remove(root.id)))} />
      {replies.length ? (
        <ul className="mt-2 space-y-2 border-l border-border/60 pl-2.5">
          {replies.map((r) => (
            <li key={r.id}>
              <Words comment={r} mine={!!comments.me && r.author_id === comments.me} onEdit={(b, n) => comments.edit(r.id, b, n)} onDelete={() => act(comments.remove(r.id))} />
            </li>
          ))}
        </ul>
      ) : null}
      {replying ? (
        <div className="mt-2">
          <Composer
            autoFocus
            label="Reply"
            placeholder="Reply…"
            onCancel={() => setReplying(false)}
            onSend={async (body, named) => {
              const e = await comments.add({ body, parent_id: root.id, ...named })
              if (!e) setReplying(false)
              return e
            }}
          />
        </div>
      ) : null}
      <div className="mt-2 flex items-center gap-1">
        {!resolved && !replying ? (
          <button type="button" data-file-thread-reply="" onClick={() => setReplying(true)} className="rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground">
            Reply
          </button>
        ) : null}
        <button type="button" data-file-thread-resolve="" onClick={() => act(comments.resolve(root.id, !resolved))} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground">
          {resolved ? <RotateCcw className="h-3 w-3" /> : <Check className="h-3 w-3" />}
          {resolved ? 'Reopen' : 'Resolve'}
        </button>
      </div>
      {err ? <p role="alert" className="pt-1 text-[11px] text-red-500">{err}</p> : null}
    </li>
  )
}

export interface PendingPin {
  page: number
  x: number
  y: number
}

/** The threads that have a place, numbered in order: what the pins show. */
export function pinNumbers(threads: readonly FileThread[]): Map<string, number> {
  const out = new Map<string, number>()
  let n = 0
  for (const t of threads) if (t.root.page) out.set(t.root.id, ++n)
  return out
}

/** The panel beside the file. */
export function FileCommentsPanel({
  comments,
  focus,
  onFocus,
  pending,
  onPendingDone,
  canPlace,
  placing,
  onPlacing,
  onClose,
}: {
  comments: FileComments
  focus: string | null
  onFocus: (id: string | null) => void
  pending: PendingPin | null
  onPendingDone: () => void
  canPlace: boolean
  placing: boolean
  onPlacing: (on: boolean) => void
  onClose: () => void
}) {
  const [showResolved, setShowResolved] = React.useState(false)
  const members = useMentionMembers(comments.me)
  const numbers = pinNumbers(comments.threads)
  const shown = comments.threads.filter((t) => showResolved || !t.root.resolved_at || t.root.id === focus)
  const resolvedCount = comments.threads.length - comments.open
  const list = React.useRef<HTMLUListElement>(null)
  React.useEffect(() => {
    if (focus) list.current?.querySelector(`[data-file-thread="${focus}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [focus])
  return (
    <MentionMembers.Provider value={members}>
      <aside data-file-comments="" aria-label="Comments" className="flex w-80 shrink-0 flex-col border-l border-border bg-background">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/50 px-3">
          <span className="text-xs font-medium text-foreground">Comments</span>
          {resolvedCount ? (
            <button type="button" aria-pressed={showResolved} onClick={() => setShowResolved((v) => !v)} className="text-[11px] text-muted-foreground hover:text-foreground">
              {showResolved ? 'Hide resolved' : `Show resolved (${resolvedCount})`}
            </button>
          ) : null}
          <button type="button" aria-label="Close comments" onClick={onClose} className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        {comments.state === 'loading' ? (
          <div className="flex flex-1 items-center justify-center py-8 text-xs text-muted-foreground">
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Loading…
          </div>
        ) : comments.state === 'off' ? (
          <div className="flex-1 px-3 py-6 text-center text-xs text-muted-foreground">Comments on files aren’t set up here yet.</div>
        ) : comments.state === 'error' ? (
          <div className="flex-1 px-3 py-6 text-center text-xs text-muted-foreground">The comments could not be loaded.</div>
        ) : (
          <>
            {canPlace && (
              <div className="shrink-0 border-b border-border/50 px-2.5 py-2">
                <button
                  type="button"
                  aria-pressed={placing}
                  data-file-comment-place=""
                  onClick={() => onPlacing(!placing)}
                  className={cn('flex h-7 w-full items-center justify-center gap-1.5 rounded-md border text-xs', placing ? 'border-amber-400 bg-amber-400/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}
                >
                  <MessageSquarePlus className="h-3.5 w-3.5" />
                  {placing ? 'Click a place on a page…' : 'Comment on a place'}
                </button>
              </div>
            )}
            {pending && (
              <div className="shrink-0 border-b border-border/50 bg-amber-400/5 p-2.5" data-file-comment-pending="">
                <p className="mb-1.5 text-[11px] text-muted-foreground">New comment on page {pending.page}</p>
                <Composer
                  autoFocus
                  label="Comment on this place"
                  placeholder="Comment on this place… @ to mention"
                  onCancel={onPendingDone}
                  onSend={async (body, named) => {
                    const e = await comments.add({ body, page: pending.page, x: pending.x, y: pending.y, ...named })
                    if (!e) onPendingDone()
                    return e
                  }}
                />
              </div>
            )}
            <ul ref={list} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5">
              {shown.length ? (
                shown.map((t) => <ThreadView key={t.root.id} thread={t} comments={comments} active={t.root.id === focus} onFocus={() => onFocus(t.root.id)} number={numbers.get(t.root.id) ?? null} />)
              ) : (
                <li className="px-1 py-6 text-center text-xs text-muted-foreground">
                  {comments.threads.length ? 'Every thread is resolved.' : canPlace ? 'No comments yet. Comment on a place on a page, or on the whole file.' : 'No comments yet.'}
                </li>
              )}
            </ul>
            <div className="shrink-0 border-t border-border/50 p-2.5">
              <Composer label="Comment on the file" placeholder="Comment on the whole file… @ to mention" onSend={(body, named) => comments.add({ body, ...named })} />
            </div>
          </>
        )}
      </aside>
    </MentionMembers.Provider>
  )
}

/** The header's button: the count is the threads still open. */
export function FileCommentsButton({ comments, pressed, onClick }: { comments: FileComments; pressed: boolean; onClick: () => void }) {
  if (comments.state === 'off') return null
  return (
    <button
      type="button"
      aria-label={comments.open ? `Comments, ${comments.open} open` : 'Comments'}
      aria-pressed={pressed}
      data-file-comments-button=""
      onClick={onClick}
      className={cn('inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground', pressed && 'bg-foreground/[0.08] text-foreground')}
    >
      <MessageSquare className="size-3.5" />
      Comments{comments.open ? <span className="tabular-nums">{comments.open}</span> : null}
    </button>
  )
}

/**
 * The PDF pages' overlay: a numbered pin where each thread was placed (open
 * ones bright, resolved ones faded), the new pin being written, and, in
 * Comment mode, a layer that takes the click that places it.
 */
export function useFileCommentOverlay(opts: {
  comments: FileComments
  placing: boolean
  pending: PendingPin | null
  focus: string | null
  onPlace: (pin: PendingPin) => void
  onOpen: (threadId: string) => void
}): PdfPageOverlay {
  const { comments, placing, pending, focus, onPlace, onOpen } = opts
  const numbers = pinNumbers(comments.threads)
  return ({ pageNumber, width, height }) => (
    <>
      {placing && (
        <div
          data-file-comment-layer={pageNumber}
          className="absolute inset-0 z-10 cursor-crosshair"
          onClick={(e) => {
            const box = e.currentTarget.getBoundingClientRect()
            const x = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width))
            const y = Math.min(1, Math.max(0, (e.clientY - box.top) / box.height))
            onPlace({ page: pageNumber, x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000 })
          }}
        />
      )}
      {comments.threads
        .filter((t) => t.root.page === pageNumber && t.root.x !== null && t.root.y !== null)
        .map((t) => (
          <button
            key={t.root.id}
            type="button"
            data-file-comment-pin={t.root.id}
            aria-label={`Comment ${numbers.get(t.root.id)} on page ${pageNumber}`}
            onClick={() => onOpen(t.root.id)}
            className={cn(
              'absolute z-20 flex size-6 -translate-x-1/2 -translate-y-full items-center justify-center rounded-full rounded-bl-none text-[11px] font-semibold text-black shadow ring-2 ring-white',
              t.root.resolved_at ? 'bg-neutral-300 opacity-60' : 'bg-amber-400',
              focus === t.root.id && 'scale-110 ring-foreground',
            )}
            style={{ left: (t.root.x ?? 0) * width, top: (t.root.y ?? 0) * height }}
          >
            {numbers.get(t.root.id)}
          </button>
        ))}
      {pending && pending.page === pageNumber && (
        <span
          data-file-comment-pending-pin=""
          className="pointer-events-none absolute z-20 flex size-6 -translate-x-1/2 -translate-y-full items-center justify-center rounded-full rounded-bl-none bg-amber-400 text-[11px] font-semibold text-black shadow ring-2 ring-white"
          style={{ left: pending.x * width, top: pending.y * height }}
        >
          +
        </span>
      )}
    </>
  )
}
