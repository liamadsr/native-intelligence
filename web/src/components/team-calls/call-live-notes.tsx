'use client'

/**
 * A call's shared live notes, in the call (phase 2: the live agent writes
 * them on the server as people speak, src/lib/team-calls/live-turns.ts).
 *
 *   - Members (./call-panel.tsx): the capture's summary as it fills in, and a
 *     line saying what the agent is doing ("Writing as people speak…",
 *     "Updated 2 minutes ago", a turn that failed, the notes paused). Open
 *     shows the whole capture in the app's own capture panel, beside the
 *     call. Read once from the call's live-notes route, then followed on the
 *     capture's row over Realtime, the road the fed transcript takes to the
 *     capture page: no timer, no polling.
 *   - A meeting guest (src/components/meeting-links/guest-meeting.tsx): only
 *     what has been said since they were let in, never the summary
 *     (src/lib/team-calls/live-notes.ts says why). Closed until they open
 *     it; while open and on screen, their page asks every few seconds (a
 *     guest has no database session, so no Realtime).
 *
 * Nothing to show, nothing drawn.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, NotebookPen } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  guestLinesOf,
  hasLiveNotes,
  liveNotesStateOf,
  liveNotesStatusLine,
  summaryBlocks,
  type GuestNoteLine,
  type LiveNotes,
} from '@/lib/team-calls/live-notes'

// ── Members ─────────────────────────────────────────────────────────────────

/** The members' notes as drawn: pure, so it can be shown without a call (tests, screenshots). */
export function CallLiveNotesView({ notes, onOpen, now }: { notes: LiveNotes | null; onOpen?: () => void; now?: number }) {
  const [open, setOpen] = useState(true)
  const blocks = useMemo(() => summaryBlocks(notes?.summary ?? ''), [notes?.summary])
  if (!notes || !hasLiveNotes(notes)) return null
  const status = liveNotesStatusLine(notes.state, now)
  const failed = notes.state?.phase === 'failed'
  const working = notes.state?.phase === 'working'
  return (
    <section data-team-call-live-notes={notes.state?.phase ?? 'ready'} aria-label="Live notes" className="mt-2 rounded-2xl border border-border bg-muted/40 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <NotebookPen className="h-4 w-4 shrink-0 text-sky-700 dark:text-sky-300" aria-hidden />
          <span className="shrink-0 text-xs font-semibold text-foreground">Live notes</span>
          {working && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500" aria-hidden />}
          {status && (
            <span className={cn('min-w-0 truncate text-xs', failed ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground')} data-team-call-live-notes-status="">
              {status}
            </span>
          )}
          <ChevronDown className={cn('ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground', open ? '' : '-rotate-90')} aria-hidden />
        </button>
        {onOpen && (
          <button type="button" onClick={onOpen} data-team-call-live-notes-open="" className="shrink-0 rounded-full bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent">
            Open
          </button>
        )}
      </div>
      {open && blocks.length > 0 && (
        <div className="mt-2 max-h-48 space-y-1 overflow-y-auto pr-1 text-sm leading-snug" data-team-call-live-notes-body="">
          {blocks.map((b, i) =>
            b.kind === 'heading' ? (
              <p key={i} className={cn('text-xs font-semibold text-foreground', i > 0 && 'pt-1.5')}>
                {b.text}
              </p>
            ) : b.kind === 'bullet' ? (
              <p key={i} className="flex gap-1.5 text-foreground/90">
                <span className="select-none text-muted-foreground" aria-hidden>
                  •
                </span>
                <span className="min-w-0">{b.text}</span>
              </p>
            ) : (
              <p key={i} className="text-foreground/90">
                {b.text}
              </p>
            ),
          )}
        </div>
      )}
      {open && blocks.length === 0 && working && <p className="mt-1.5 text-xs text-muted-foreground">The first notes show here in a minute or so.</p>}
    </section>
  )
}

/** The call's live notes for someone in it: read once, then followed over Realtime. */
export function CallLiveNotes({ callId, captureId, onOpen }: { callId: string; captureId: string; onOpen?: () => void }) {
  const [notes, setNotes] = useState<LiveNotes | null>(null)
  useEffect(() => {
    let alive = true
    setNotes(null)
    void fetch(`/api/account/team-calls/${callId}/live-notes`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((json: { captureId?: string | null; summary?: string; state?: LiveNotes['state'] } | null) => {
        if (!alive || !json || json.captureId !== captureId) return
        setNotes((prev) => prev ?? { summary: json.summary ?? '', state: json.state ?? null })
      })
      .catch(() => undefined)
    let channel: { unsubscribe: () => unknown } | null = null
    let client: { removeChannel: (c: never) => unknown } | null = null
    void import('@/lib/supabase/client').then(({ createClient }) => {
      if (!alive) return
      const supabase = createClient()
      client = supabase as unknown as { removeChannel: (c: never) => unknown }
      channel = supabase
        .channel(`call-live-notes:${captureId}:${Math.random().toString(36).slice(2)}`)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'captures', filter: `id=eq.${captureId}` }, (payload) => {
          const row = payload.new as { ai_summary?: string | null; metadata?: unknown }
          const summary = typeof row.ai_summary === 'string' ? row.ai_summary : null
          const state = liveNotesStateOf(row.metadata)
          // The row comes again with every transcript batch: keep the same object when nothing changed.
          setNotes((prev) => {
            const next = { summary: summary ?? prev?.summary ?? '', state: state ?? prev?.state ?? null }
            return prev && prev.summary === next.summary && prev.state?.phase === next.state?.phase && prev.state?.at === next.state?.at ? prev : next
          })
        })
        .subscribe()
    })
    return () => {
      alive = false
      if (channel && client) void client.removeChannel(channel as never)
    }
  }, [callId, captureId])
  return <CallLiveNotesView notes={notes} onOpen={onOpen} />
}

// ── A meeting guest ─────────────────────────────────────────────────────────

/** How often a guest's open notes ask again while on screen. */
export const GUEST_NOTES_POLL_MS = 8_000

export type GuestNotesState = 'closed' | 'loading' | 'ready' | 'failed'

/** A guest's view as drawn: pure. */
export function GuestCallNotesView({
  state,
  lines,
  onToggle,
}: {
  state: GuestNotesState
  lines: GuestNoteLine[]
  onToggle: () => void
}) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'nearest' })
  }, [lines.length])
  const open = state !== 'closed'
  return (
    <section data-guest-notes={state} aria-label="What’s been said" className="mt-3 rounded-2xl border border-border bg-muted/40 px-3 py-2.5">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-2 text-left">
        <NotebookPen className="h-4 w-4 shrink-0 text-sky-700 dark:text-sky-300" aria-hidden />
        <span className="text-xs font-semibold text-foreground">What’s been said</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{open ? 'Since you joined' : 'Show the notes of this call'}</span>
        <ChevronDown className={cn('ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground', open ? '' : '-rotate-90')} aria-hidden />
      </button>
      {open && (
        <div className="mt-2 max-h-56 space-y-1.5 overflow-y-auto pr-1 text-sm leading-snug" data-guest-notes-body="">
          {state === 'loading' && lines.length === 0 && <p className="text-xs text-muted-foreground">Loading…</p>}
          {state === 'failed' && lines.length === 0 && <p className="text-xs text-amber-700 dark:text-amber-300">Couldn’t load the notes. Trying again…</p>}
          {state === 'ready' && lines.length === 0 && <p className="text-xs text-muted-foreground">Nothing has been said yet since you joined.</p>}
          {lines.map((l) => (
            <p key={`${l.at}-${l.speaker}-${l.text.slice(0, 24)}`} className="text-foreground/90">
              <span className="font-medium text-foreground">{l.speaker}</span> {l.text}
            </p>
          ))}
          <div ref={end} />
        </div>
      )}
    </section>
  )
}

/**
 * A guest's notes of the call (GET /m/<token>/notes): closed until they open
 * them; open and on screen, asked every GUEST_NOTES_POLL_MS. Refused (they are
 * no longer in the call, or its notes are over): nothing drawn.
 */
export function GuestCallNotes({ base }: { base: string }) {
  const [state, setState] = useState<GuestNotesState>('closed')
  const [lines, setLines] = useState<GuestNoteLine[]>([])
  const [refused, setRefused] = useState(false)
  const open = state !== 'closed'
  useEffect(() => {
    if (!open || refused) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const ask = async () => {
      timer = null
      if (stopped || document.visibilityState !== 'visible') return
      try {
        const res = await fetch(`${base}/notes`, { cache: 'no-store' })
        if (stopped) return
        if (res.status === 403 || res.status === 401 || res.status === 404) {
          setRefused(true)
          return
        }
        const json = res.ok ? ((await res.json().catch(() => null)) as { lines?: unknown } | null) : null
        if (stopped) return
        if (json) {
          setLines(guestLinesOf(json.lines))
          setState('ready')
        } else setState((s) => (s === 'closed' ? s : 'failed'))
      } catch {
        if (!stopped) setState((s) => (s === 'closed' ? s : 'failed'))
      }
      if (!stopped) timer = setTimeout(() => void ask(), GUEST_NOTES_POLL_MS)
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !timer) void ask()
    }
    document.addEventListener('visibilitychange', onVisible)
    void ask()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [open, refused, base])
  if (refused) return null
  return <GuestCallNotesView state={state} lines={lines} onToggle={() => setState((s) => (s === 'closed' ? 'loading' : 'closed'))} />
}
