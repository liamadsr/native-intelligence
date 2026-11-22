'use client'

/**
 * Comments on a canvas: a panel of threads, and a pin on each item that has
 * an open one. A thread is about the canvas, or about the one item that was
 * selected when it was started. Anyone who can open the canvas writes and
 * resolves; only its author changes or deletes a comment (the database's
 * rules, migration 682; this only hides the buttons that would be refused).
 */
import * as React from 'react'
import { Check, CornerDownRight, Loader2, MessageSquare, Pencil, RotateCcw, Sparkles, Trash2, X } from 'lucide-react'
import { MentionTextarea } from '@/components/mentions/mention-textarea'
import { useCommentMentions, useMentionMembers, type CommentMentionsPayload } from '@/components/mentions/use-comment-mentions'
import type { ComposerMentionOption } from '@/app/account/(dashboard)/chat/command-menu-model'
import { FLOATING_CARD_CLASS } from '@/components/attention/card-skin'
import { createClient } from '@/lib/supabase/client'
import { threadsOf, type CanvasComment, type CanvasThread } from '@/lib/canvas/comments'
import { toScreen } from '@/lib/canvas/engine/camera'
import { aabb } from '@/lib/canvas/engine/geometry'
import { cn } from '@/lib/utils'
import { useCamera, useCanvas, useCanvasStore } from './use-canvas'

export type CommentsState = 'loading' | 'ready' | 'off' | 'error'

export interface CanvasComments {
  state: CommentsState
  threads: CanvasThread[]
  me: string | null
  /** Threads nobody has resolved. */
  open: number
  add: (input: { body: string; parent_id?: string; item_id?: string | null; x?: number; y?: number } & Partial<CommentMentionsPayload>) => Promise<string | null>
  resolve: (id: string, resolved: boolean) => Promise<string | null>
  /** New words for one's own comment. */
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

/** The canvas's comments, kept current: read once, again after every change here, and when someone else's arrives. */
export function useCanvasComments(canvasId: string): CanvasComments {
  const [state, setState] = React.useState<CommentsState>('loading')
  const [comments, setComments] = React.useState<CanvasComment[]>([])
  const [me, setMe] = React.useState<string | null>(null)
  const base = `/api/account/canvases/${canvasId}/comments`
  const held = React.useRef(new Set<string>())
  React.useEffect(() => {
    held.current = new Set(comments.map((c) => c.id))
  }, [comments])

  const load = React.useCallback(async () => {
    try {
      const r = await fetch(base)
      if (r.status === 503) return setState('off')
      if (!r.ok) return setState((s) => (s === 'ready' ? s : 'error'))
      const j = (await r.json()) as { comments: CanvasComment[]; me: string }
      setComments(j.comments)
      setMe(j.me)
      setState('ready')
    } catch {
      setState((s) => (s === 'ready' ? s : 'error'))
    }
  }, [base])

  React.useEffect(() => {
    setState('loading')
    setComments([])
    void load()
  }, [load])

  // Other people's comments: any change to this canvas's rows reads them again (the read is what RLS filters).
  const ready = state === 'ready'
  React.useEffect(() => {
    if (!ready) return
    const supabase = createClient()
    let timer: ReturnType<typeof setTimeout> | null = null
    const again = () => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        void load()
      }, 300)
    }
    const channel = supabase
      .channel(`canvas-comments:${canvasId}:${Math.random().toString(36).slice(2, 8)}`)
      .on('postgres_changes' as any, { event: 'INSERT', schema: 'public', table: 'canvas_comment', filter: `canvas_id=eq.${canvasId}` }, again)
      .on('postgres_changes' as any, { event: 'UPDATE', schema: 'public', table: 'canvas_comment', filter: `canvas_id=eq.${canvasId}` }, again)
      // A delete carries only the row's id and cannot be filtered by canvas: read again when it is one shown here.
      .on('postgres_changes' as any, { event: 'DELETE', schema: 'public', table: 'canvas_comment' }, (p: { old?: { id?: string } | null }) => {
        if (p.old?.id && held.current.has(p.old.id)) again()
      })
      .subscribe()
    return () => {
      if (timer) clearTimeout(timer)
      void supabase.removeChannel(channel)
    }
  }, [ready, canvasId, load])

  const threads = React.useMemo(() => threadsOf(comments), [comments])
  const open = React.useMemo(() => threads.filter((t) => !t.root.resolved_at).length, [threads])
  const after = React.useCallback(
    async (err: string | null) => {
      if (!err) await load()
      return err
    },
    [load],
  )
  return React.useMemo(
    () => ({
      state,
      threads,
      me,
      open,
      add: (input) => call(base, 'POST', input).then(after),
      resolve: (id, resolved) => call(`${base}/${id}`, 'PATCH', { resolved }).then(after),
      edit: (id, body, named) => call(`${base}/${id}`, 'PATCH', { body, ...(named ?? {}) }).then(after),
      remove: (id) => call(`${base}/${id}`, 'DELETE').then(after),
    }),
    [state, threads, me, open, base, after],
  )
}

/** The header's button: the count is the threads still open. */
export function CommentsButton({ comments, pressed, onClick }: { comments: CanvasComments; pressed: boolean; onClick: () => void }) {
  if (comments.state === 'off') return null
  return (
    <button
      type="button"
      aria-label={comments.open ? `Comments, ${comments.open} open` : 'Comments'}
      aria-pressed={pressed}
      data-canvas-comments-button
      onClick={onClick}
      className={cn('flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground', pressed && 'bg-foreground/10 text-foreground')}
    >
      <MessageSquare className="h-4 w-4" strokeWidth={1.75} />
      {comments.open ? <span className="text-[11px] font-medium tabular-nums">{comments.open}</span> : null}
    </button>
  )
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

/** The teammates `@` offers in every box of the panel (the viewer is left out). */
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
          value={text}
          autoFocus={autoFocus}
          rows={1}
          maxLength={10_000}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // The canvas's own keys (delete, tools) stay out of the text.
            e.stopPropagation()
            if (e.key === 'Escape' && onCancel) onCancel()
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
          className="max-h-32 min-h-8 flex-1 resize-none rounded-md border border-border/60 bg-background/60 px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground/30 [field-sizing:content]"
        />
        <button type="button" disabled={!text.trim() || busy} onClick={() => void send()} className="flex h-8 shrink-0 items-center rounded-md bg-foreground px-2.5 text-xs font-medium text-background disabled:opacity-40">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : sendLabel}
        </button>
      </div>
      {err ? <p role="alert" className="pt-1 text-[11px] text-red-500">{err}</p> : null}
    </div>
  )
}

function Words({ comment, mine, onDelete, onEdit }: { comment: CanvasComment; mine: boolean; onDelete: () => void; onEdit: (body: string, named: CommentMentionsPayload) => Promise<string | null> }) {
  const [editing, setEditing] = React.useState(false)
  if (editing) {
    return (
      <Composer
        autoFocus
        label="Edit comment"
        placeholder="Edit comment…"
        initial={comment.body}
        send="Save"
        onCancel={() => setEditing(false)}
        already={comment.mentions}
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
          <span data-canvas-comment-assistant title="Written by the assistant for them" className="flex shrink-0 items-center gap-0.5 rounded bg-foreground/[0.06] px-1 text-[10px] text-muted-foreground">
            <Sparkles className="h-2.5 w-2.5" /> assistant
          </span>
        ) : null}
        <span className="shrink-0 text-[11px] text-muted-foreground">{when(comment.created_at)}</span>
        {comment.updated_at > comment.created_at && !comment.resolved_at ? <span className="shrink-0 text-[11px] text-muted-foreground">edited</span> : null}
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

function Thread({ thread, comments, active, onFocus }: { thread: CanvasThread; comments: CanvasComments; active: boolean; onFocus: () => void }) {
  const store = useCanvasStore()
  const [replying, setReplying] = React.useState(false)
  const [err, setErr] = React.useState<string | null>(null)
  const { root, replies } = thread
  const resolved = !!root.resolved_at
  const itemThere = useCanvas(React.useCallback((s) => (root.item_id ? !!s.scene.items[root.item_id] : false), [root.item_id]))
  const act = (p: Promise<string | null>) => void p.then(setErr)
  return (
    <li data-canvas-thread={root.id} data-resolved={resolved || undefined} className={cn('rounded-lg border border-border/50 p-2.5', active && 'border-foreground/30 bg-foreground/[0.03]', resolved && 'opacity-60')}>
      {root.item_id ? (
        <button
          type="button"
          disabled={!itemThere}
          onClick={() => {
            onFocus()
            store.select([root.item_id as string])
            store.zoomToFit(true)
          }}
          className="mb-1 flex items-center gap-1 text-[11px] text-muted-foreground enabled:hover:text-foreground"
        >
          <CornerDownRight className="h-3 w-3" /> {itemThere ? 'On an item: show it' : 'On an item that was deleted'}
        </button>
      ) : null}
      <Words comment={root} mine={!!comments.me && root.author_id === comments.me} onEdit={(body, named) => comments.edit(root.id, body, named)} onDelete={() => (replies.length && !window.confirm('Delete this thread and its replies?') ? undefined : act(comments.remove(root.id)))} />
      {replies.length ? (
        <ul className="mt-2 space-y-2 border-l border-border/60 pl-2.5">
          {replies.map((r) => (
            <li key={r.id}>
              <Words comment={r} mine={!!comments.me && r.author_id === comments.me} onEdit={(body, named) => comments.edit(r.id, body, named)} onDelete={() => act(comments.remove(r.id))} />
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
          <button type="button" onClick={() => setReplying(true)} className="rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground">
            Reply
          </button>
        ) : null}
        <button type="button" onClick={() => act(comments.resolve(root.id, !resolved))} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground">
          {resolved ? <RotateCcw className="h-3 w-3" /> : <Check className="h-3 w-3" />}
          {resolved ? 'Reopen' : 'Resolve'}
        </button>
      </div>
      {err ? <p role="alert" className="pt-1 text-[11px] text-red-500">{err}</p> : null}
    </li>
  )
}

export function CommentsPanel({ comments, focus, onFocus, onClose }: { comments: CanvasComments; focus: string | null; onFocus: (threadId: string | null) => void; onClose: () => void }) {
  const store = useCanvasStore()
  const selected = useCanvas((s) => (s.selection.length === 1 ? s.selection[0] : null))
  const [showResolved, setShowResolved] = React.useState(false)
  const shown = comments.threads.filter((t) => showResolved || !t.root.resolved_at || t.root.id === focus)
  const resolvedCount = comments.threads.length - comments.open
  const list = React.useRef<HTMLUListElement>(null)
  const members = useMentionMembers(comments.me)
  React.useEffect(() => {
    if (focus) list.current?.querySelector(`[data-canvas-thread="${focus}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [focus])
  return (
    <MentionMembers.Provider value={members}>
    <aside
      data-canvas-chrome
      data-canvas-comments
      aria-label="Comments"
      className={cn(FLOATING_CARD_CLASS, 'absolute inset-x-2 bottom-[10.25rem] z-30 flex max-h-[55%] flex-col md:inset-x-auto md:bottom-16 md:right-4 md:top-4 md:max-h-none md:w-72')}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
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
      ) : comments.state === 'error' ? (
        <div className="flex-1 px-3 py-6 text-center text-xs text-muted-foreground">The comments could not be loaded.</div>
      ) : (
        <>
          <ul ref={list} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5">
            {shown.length ? (
              shown.map((t) => <Thread key={t.root.id} thread={t} comments={comments} active={t.root.id === focus} onFocus={() => onFocus(t.root.id)} />)
            ) : (
              <li className="px-1 py-6 text-center text-xs text-muted-foreground">{comments.threads.length ? 'Every thread is resolved.' : 'No comments yet. Select an item to comment on it, or write about the whole canvas.'}</li>
            )}
          </ul>
          <div className="shrink-0 border-t border-border/50 p-2.5">
            <Composer
              label={selected ? 'Comment on the selected item' : 'Comment on the canvas'}
              placeholder={selected ? 'Comment on the selected item…' : 'Comment on the canvas…'}
              onSend={(body, named) => {
                if (!selected) return comments.add({ body, ...named })
                const it = store.getState().scene.items[selected]
                const box = it && 'w' in it ? aabb(it) : null
                return comments.add({ body, item_id: selected, ...(box ? { x: box.x + box.w, y: box.y } : {}), ...named })
              }}
            />
          </div>
        </>
      )}
    </aside>
    </MentionMembers.Provider>
  )
}

/** A pin at the corner of each item with an open thread; it opens the panel on that thread. */
export function CommentPins({ comments, onOpen }: { comments: CanvasComments; onOpen: (threadId: string) => void }) {
  const camera = useCamera()
  const items = useCanvas((s) => s.scene.items)
  const pins = React.useMemo(() => {
    const byItem = new Map<string, { id: string; count: number }>()
    for (const t of comments.threads) {
      if (!t.root.item_id || t.root.resolved_at) continue
      const seen = byItem.get(t.root.item_id)
      if (seen) seen.count += 1 + t.replies.length
      else byItem.set(t.root.item_id, { id: t.root.id, count: 1 + t.replies.length })
    }
    return [...byItem.entries()]
  }, [comments.threads])
  if (!pins.length) return null
  return (
    <div data-canvas-chrome className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      {pins.map(([itemId, pin]) => {
        const it = items[itemId]
        if (!it || !('w' in it)) return null
        const box = aabb(it)
        const at = toScreen(camera, { x: box.x + box.w, y: box.y })
        return (
          <button
            key={itemId}
            type="button"
            data-canvas-comment-pin={itemId}
            aria-label={`${pin.count} comment${pin.count === 1 ? '' : 's'} on this item`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onOpen(pin.id)}
            style={{ transform: `translate(${Math.round(at.x) - 6}px, ${Math.round(at.y) - 18}px)` }}
            className="pointer-events-auto absolute left-0 top-0 flex h-6 min-w-6 items-center justify-center gap-0.5 rounded-full rounded-bl-sm border border-background bg-amber-400 px-1.5 text-[11px] font-semibold text-amber-950 shadow-sm"
          >
            <MessageSquare className="h-3 w-3" />
            {pin.count > 1 ? pin.count : null}
          </button>
        )
      })}
    </div>
  )
}
