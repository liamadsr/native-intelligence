'use client'

/**
 * A call's shared live notes, in the call (phase 2: the live agent writes
 * them on the server as people speak, src/lib/team-calls/live-turns.ts).
 *
 *   - Members (./call-panel.tsx): the capture's summary as it fills in, and a
 *     line saying what the agent is doing ("Writing as people speak…",
 *     "Updated 2 minutes ago", a turn that failed, the notes paused). Open
 *     shows the whole capture in the app's own capture panel, beside the
 *     call. Read once from the call's live-notes route, then followed over
 *     Realtime on 655's small live notes row (never the capture's own row,
 *     which carries the whole transcript and changes with every batch of
 *     words): no polling. One timer at most, at the running turn's end, so a
 *     turn whose process died stops reading "writing". When the call's words
 *     are not being written (the recorder's health, 668), one plain line says
 *     why, from the same row, until it recovers.
 *   - A meeting guest (src/components/meeting-links/guest-meeting.tsx): the
 *     agent's notes of the call as plain words, and under them what has been
 *     said since they were let in (src/lib/team-calls/live-notes.ts says
 *     what a guest is given). Closed until they open it; while open and on
 *     screen, their page asks every few seconds (a guest has no database
 *     session, so no Realtime).
 *
 * Nothing to show, nothing drawn.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, NotebookPen } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  feedHealthLine,
  guestLinesOf,
  guestSummaryBlocksOf,
  hasLiveNotes,
  liveNotesOf,
  liveNotesStatusLine,
  liveNotesWriting,
  summaryBlocks,
  type GuestNoteLine,
  type SummaryBlock,
  type LiveNotes,
} from '@/lib/team-calls/live-notes'

/** The agent's notes as drawn: headings, bullets and lines of words. */
function SummaryBlocks({ blocks }: { blocks: SummaryBlock[] }) {
  return (
    <>
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
    </>
  )
}

// ── Members ─────────────────────────────────────────────────────────────────

/** The members' notes as drawn: pure, so it can be shown without a call (tests, screenshots). */
export function CallLiveNotesView({ notes, onOpen, now }: { notes: LiveNotes | null; onOpen?: () => void; now?: number }) {
  const [open, setOpen] = useState(true)
  const blocks = useMemo(() => summaryBlocks(notes?.summary ?? ''), [notes?.summary])
  if (!notes || !hasLiveNotes(notes, now)) return null
  const status = liveNotesStatusLine(notes.state, now)
  const feedLine = feedHealthLine(notes.feed)
  const failed = notes.state?.phase === 'failed' || (notes.state?.phase === 'stopped' && notes.state.reason !== 'bound')
  const working = liveNotesWriting(notes.state, now)
  return (
    <section data-team-call-live-notes={notes.state?.phase ?? 'ready'} aria-label="Live notes" className="mt-2 rounded-2xl border border-border bg-muted/40 px-3 py-2.5">
      {feedLine && (
        <p role="status" data-team-call-notes-health={notes.feed ?? ''} className="mb-2 rounded-xl bg-amber-500/10 px-2.5 py-1.5 text-xs font-medium text-amber-800 dark:text-amber-200">
          {feedLine}
        </p>
      )}
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
          <SummaryBlocks blocks={blocks} />
        </div>
      )}
      {open && blocks.length === 0 && working && <p className="mt-1.5 text-xs text-muted-foreground">The first notes show here in a minute or so.</p>}
    </section>
  )
}

/** The call's live notes for someone in it: read once, then followed over Realtime on the small notes row. */
export function CallLiveNotes({ callId, captureId, onOpen }: { callId: string; captureId: string; onOpen?: () => void }) {
  const [notes, setNotes] = useState<LiveNotes | null>(null)
  // Re-drawn once when a running turn's lease runs out (its process may have died): no loop.
  const [, setTick] = useState(0)
  const until = notes?.state?.phase === 'working' && notes.state.until ? Date.parse(notes.state.until) : Number.NaN
  useEffect(() => {
    if (!Number.isFinite(until)) return
    const wait = until - Date.now()
    if (wait <= 0) return
    const timer = setTimeout(() => setTick((n) => n + 1), Math.min(wait + 500, 10 * 60_000))
    return () => clearTimeout(timer)
  }, [until])
  useEffect(() => {
    let alive = true
    setNotes(null)
    void fetch(`/api/account/team-calls/${callId}/live-notes`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((json: { captureId?: string | null; summary?: string; state?: LiveNotes['state']; feed?: LiveNotes['feed'] } | null) => {
        if (!alive || !json || json.captureId !== captureId) return
        setNotes((prev) => prev ?? { summary: json.summary ?? '', state: json.state ?? null, feed: json.feed ?? null })
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
        .on('postgres_changes', { event: '*', schema: 'public', table: 'team_call_live_notes', filter: `capture_id=eq.${captureId}` }, (payload) => {
          const row = payload.new as Parameters<typeof liveNotesOf>[0] | null
          if (!row || typeof row !== 'object' || !('state' in row)) return
          setNotes(liveNotesOf(row))
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

/**
 * A guest's view as drawn: pure. The agent's notes first (when it has written
 * any), then what has been said since the guest joined. `pad`: a notepad
 * beside the call (the guest's page), tall where there is room.
 */
export function GuestCallNotesView({
  state,
  lines,
  summary = [],
  onToggle,
  pad = false,
  className,
}: {
  state: GuestNotesState
  lines: GuestNoteLine[]
  summary?: SummaryBlock[]
  onToggle: () => void
  pad?: boolean
  className?: string
}) {
  const said = useRef<HTMLDivElement>(null)
  // Was the reader at the newest line before this draw? Only then is the next one followed.
  const atEnd = useRef(true)
  const last = lines.length > 0 ? `${lines[lines.length - 1].at}-${lines[lines.length - 1].text.length}` : ''
  useEffect(() => {
    const box = said.current
    if (box && atEnd.current) box.scrollTop = box.scrollHeight
  }, [last])
  const open = state !== 'closed'
  const noted = summary.length > 0
  return (
    <section
      data-guest-notes={state}
      aria-label={noted || pad ? 'Notes' : 'What’s been said'}
      className={cn(pad ? 'flex min-h-0 flex-col rounded-3xl p-4 lg:h-full' : 'mt-3 rounded-2xl border border-border bg-muted/40 px-3 py-2.5', className)}
    >
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full shrink-0 items-center gap-2 text-left">
        <NotebookPen className="h-4 w-4 shrink-0 text-sky-700 dark:text-sky-300" aria-hidden />
        <span className={cn('font-semibold text-foreground', pad ? 'text-sm' : 'text-xs')}>{pad || noted ? 'Notes' : 'What’s been said'}</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{!open ? 'Show the notes of this call' : noted ? 'Of this call' : 'Since you joined'}</span>
        <ChevronDown className={cn('ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground', open ? '' : '-rotate-90')} aria-hidden />
      </button>
      {open && (
        <div className={cn('mt-2 flex min-h-0 flex-col gap-2.5 text-sm', pad ? 'max-h-[32dvh] lg:max-h-none lg:flex-1' : 'max-h-72')} data-guest-notes-body="">
          {noted && (
            <div className="max-h-[45%] shrink-0 space-y-1 overflow-y-auto pr-1 leading-snug" data-guest-notes-summary="">
              <SummaryBlocks blocks={summary} />
            </div>
          )}
          {noted && (
            <p className="shrink-0 border-t border-foreground/10 pt-2.5 text-xs font-semibold text-foreground" data-guest-notes-said="">
              What’s been said <span className="font-normal text-muted-foreground">since you joined</span>
            </p>
          )}
          <div
            ref={said}
            onScroll={(e) => {
              const box = e.currentTarget
              atEnd.current = box.scrollHeight - box.scrollTop - box.clientHeight < 32
            }}
            className={cn('min-h-0 flex-1 overflow-y-auto pr-1', pad ? 'space-y-2.5 leading-relaxed' : 'space-y-1.5 leading-snug')}
          >
          {state === 'loading' && lines.length === 0 && !noted && <p className="text-xs text-muted-foreground">Loading…</p>}
          {state === 'failed' && lines.length === 0 && !noted && <p className="text-xs text-amber-700 dark:text-amber-300">Couldn’t load the notes. Trying again…</p>}
          {state === 'ready' && lines.length === 0 && <p className="text-xs text-muted-foreground">Nothing has been said yet since you joined.</p>}
          {lines.map((l) =>
            pad ? (
              <p key={`${l.at}-${l.speaker}-${l.text.slice(0, 24)}`} className="text-foreground/90">
                <span className="block text-xs font-semibold text-foreground">{l.speaker}</span>
                {l.text}
              </p>
            ) : (
              <p key={`${l.at}-${l.speaker}-${l.text.slice(0, 24)}`} className="text-foreground/90">
                <span className="font-medium text-foreground">{l.speaker}</span> {l.text}
              </p>
            ),
          )}
          </div>
        </div>
      )}
      {pad && open && <p className="mt-3 shrink-0 border-t border-foreground/10 pt-2.5 text-xs text-muted-foreground">Written by Native Intelligence as people speak.</p>}
    </section>
  )
}

/**
 * A guest's notes of the call (GET /m/<token>/notes): closed until they open
 * them (as a pad on a wide screen, open from the start); open and on screen,
 * asked every GUEST_NOTES_POLL_MS. Refused (they are no longer in the call, or
 * its notes are over): nothing drawn.
 */
export function GuestCallNotes({ base, pad = false, className }: { base: string; pad?: boolean; className?: string }) {
  const [state, setState] = useState<GuestNotesState>(() => (pad && typeof window !== 'undefined' && window.matchMedia?.('(min-width: 1024px)').matches ? 'loading' : 'closed'))
  const [lines, setLines] = useState<GuestNoteLine[]>([])
  const [summary, setSummary] = useState<SummaryBlock[]>([])
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
        const json = res.ok ? ((await res.json().catch(() => null)) as { lines?: unknown; summary?: unknown } | null) : null
        if (stopped) return
        if (json) {
          setLines(guestLinesOf(json.lines))
          setSummary(guestSummaryBlocksOf(json.summary))
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
  return <GuestCallNotesView state={state} lines={lines} summary={summary} pad={pad} className={className} onToggle={() => setState((s) => (s === 'closed' ? 'loading' : 'closed'))} />
}
