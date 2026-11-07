'use client'

/**
 * Local agents dev console (L0 contract §5). Plain and functional on purpose:
 * status, grants, a start form, the jobs, and the selected job's transcript
 * with a message box, Stop and Resume.
 *
 * Transcript: on select (and on mount, which restores the last selection)
 * `events(jobId, 0)` backfills from the desktop's ring, then the live
 * `local-agent://event` stream follows, deduped by seq in `applyEnvelopes`.
 * Live events wait while the backfill is in flight, so a reloaded webview
 * rebuilds the same transcript. They are batched once per frame (rAF, with a
 * timer for a hidden webview where rAF doesn't fire), and rows are memoized
 * per item, so a streaming delta re-renders one row, not the list.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { isDesktopApp } from '@/lib/platform'
import {
  tauriBridge,
  type LocalAgentEventEnvelope,
  type LocalAgentGrant,
  type LocalAgentJob,
  type LocalAgentJobStatus,
  type LocalAgentPolicy,
  type LocalAgentResult,
  type LocalAgentStatus,
} from '@/lib/tauri-bridge'
import { cn } from '@/lib/utils'
import {
  appendSent,
  applyEnvelopes,
  canResumeJob,
  emptyTranscript,
  isJobLive,
  truncate,
  type Transcript,
  type TranscriptItem,
} from '@/lib/local-agent/transcript-view'

const SELECTED_JOB_KEY = 'dial8.dev.localAgent.selectedJob'
/** A hidden webview never runs rAF; this timer flushes instead. */
const FLUSH_FALLBACK_MS = 250
/** Status events (turn boundaries, exits) → one status() refresh. */
const REFRESH_DEBOUNCE_MS = 300

function readSelectedJob(): string | null {
  try {
    return sessionStorage.getItem(SELECTED_JOB_KEY)
  } catch {
    return null
  }
}

function writeSelectedJob(jobId: string | null) {
  try {
    if (jobId) sessionStorage.setItem(SELECTED_JOB_KEY, jobId)
    else sessionStorage.removeItem(SELECTED_JOB_KEY)
  } catch {
    /* storage blocked */
  }
}

function newestJobId(jobs: readonly LocalAgentJob[]): string | null {
  let best: LocalAgentJob | null = null
  for (const job of jobs) if (!best || job.createdAt >= best.createdAt) best = job
  return best?.id ?? null
}

function formatTime(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}

const NO_GRANTS: readonly LocalAgentGrant[] = []
const NO_JOBS: readonly LocalAgentJob[] = []

const STATUS_VARIANT: Record<LocalAgentJobStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  starting: 'default',
  running: 'default',
  waiting: 'secondary',
  completed: 'outline',
  failed: 'destructive',
  cancelled: 'outline',
  interrupted: 'outline',
}

function StatusBadge({ status }: { status: LocalAgentJobStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{status}</Badge>
}

function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-md border border-border p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  )
}

export default function LocalAgentDev() {
  if (!isDesktopApp()) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Local agents run only in a debug build of the Dial8 desktop app. Open this page there.
      </div>
    )
  }
  return <LocalAgentConsole />
}

function LocalAgentConsole() {
  const [status, setStatus] = useState<LocalAgentStatus | null>(null)
  const [selectedJobId, setSelectedJobId] = useState<string | null>(readSelectedJob)
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const selectedRef = useRef<string | null>(null)
  const backfillingRef = useRef(false)
  const pendingRef = useRef<LocalAgentEventEnvelope[]>([])
  const rafRef = useRef<number | null>(null)
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    const next = await tauriBridge.localAgent.status()
    setStatus(next)
    return next
  }, [])

  const flush = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    if (flushTimerRef.current !== null) clearTimeout(flushTimerRef.current)
    rafRef.current = null
    flushTimerRef.current = null
    // The backfill applies first; live events wait for it.
    if (backfillingRef.current) return
    const batch = pendingRef.current.splice(0)
    if (batch.length === 0) return
    setTranscript((t) => (t ? applyEnvelopes(t, batch) : t))
  }, [])

  const scheduleFlush = useCallback(() => {
    if (rafRef.current !== null || flushTimerRef.current !== null) return
    rafRef.current = requestAnimationFrame(flush)
    flushTimerRef.current = setTimeout(flush, FLUSH_FALLBACK_MS)
  }, [flush])

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current !== null) return
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null
      void refresh()
    }, REFRESH_DEBOUNCE_MS)
  }, [refresh])

  // First status; keep the last selection (a webview reload) or pick the newest.
  useEffect(() => {
    let live = true
    void tauriBridge.localAgent.status().then((next) => {
      if (!live) return
      setStatus(next)
      setSelectedJobId((cur) => (cur && next.jobs.some((j) => j.id === cur) ? cur : newestJobId(next.jobs)))
    })
    return () => {
      live = false
    }
  }, [])

  // One subscription for every job: status events refresh the jobs list, the
  // selected job's events feed the transcript.
  useEffect(
    () =>
      tauriBridge.localAgent.onEvent((envelope) => {
        if (envelope.event.kind === 'status') scheduleRefresh()
        if (envelope.jobId !== selectedRef.current) return
        pendingRef.current.push(envelope)
        scheduleFlush()
      }),
    [scheduleFlush, scheduleRefresh],
  )

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      if (flushTimerRef.current !== null) clearTimeout(flushTimerRef.current)
      if (refreshTimerRef.current !== null) clearTimeout(refreshTimerRef.current)
      // Null, or a StrictMode remount would think a flush is still scheduled.
      rafRef.current = null
      flushTimerRef.current = null
      refreshTimerRef.current = null
    },
    [],
  )

  // Select → backfill from seq 0, then the live events that arrived meanwhile.
  useEffect(() => {
    selectedRef.current = selectedJobId
    pendingRef.current = []
    writeSelectedJob(selectedJobId)
    if (!selectedJobId) {
      setTranscript(null)
      return
    }
    setTranscript(emptyTranscript(selectedJobId))
    backfillingRef.current = true
    let live = true
    void tauriBridge.localAgent.events(selectedJobId, 0).then((res) => {
      if (!live) return
      backfillingRef.current = false
      if (res.ok) pendingRef.current = [...res.value, ...pendingRef.current]
      else setError(`events: ${res.error}`)
      flush()
    })
    return () => {
      live = false
      backfillingRef.current = false
    }
  }, [selectedJobId, flush])

  /** Run one command; its error shows at the top. Refreshes the status after. */
  const run = useCallback(
    async <T,>(label: string, call: () => Promise<LocalAgentResult<T>>): Promise<T | undefined> => {
      setBusy(true)
      setError(null)
      try {
        const res = await call()
        if (!res.ok) {
          setError(`${label}: ${res.error}`)
          return undefined
        }
        return res.value
      } finally {
        setBusy(false)
        void refresh()
      }
    },
    [refresh],
  )

  const onAddFolder = useCallback(() => void run('add folder', () => tauriBridge.localAgent.pickFolder()), [run])
  const onRemoveGrant = useCallback(
    (grantId: string) => void run('remove folder', () => tauriBridge.localAgent.removeGrant(grantId)),
    [run],
  )
  const onStart = useCallback(
    async (grantId: string, request: string) => {
      const started = await run('start', () => tauriBridge.localAgent.start(grantId, request))
      if (!started) return false
      setSelectedJobId(started.jobId)
      return true
    },
    [run],
  )

  const job = status?.jobs.find((j) => j.id === selectedJobId) ?? null
  const onStop = useCallback(() => {
    if (selectedJobId) void run('stop', () => tauriBridge.localAgent.stop(selectedJobId))
  }, [run, selectedJobId])
  const onResume = useCallback(() => {
    if (selectedJobId) void run('resume', () => tauriBridge.localAgent.resume(selectedJobId))
  }, [run, selectedJobId])
  const onSend = useCallback(
    async (text: string, policy: LocalAgentPolicy) => {
      if (!selectedJobId) return false
      setError(null)
      const res = await tauriBridge.localAgent.send(selectedJobId, text, policy)
      if (!res.ok) {
        setError(`send: ${res.error}`)
        return false
      }
      setTranscript((t) => (t && t.jobId === selectedJobId ? appendSent(t, text, policy) : t))
      return true
    },
    [selectedJobId],
  )

  const onRefresh = useCallback(() => void refresh(), [refresh])
  const grants = status?.grants ?? NO_GRANTS

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-6 text-foreground">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-lg font-semibold">Local agents (L0 dev)</h1>
        <span className="text-xs text-muted-foreground">read mode · this Mac only</span>
      </div>
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
        <div className="space-y-4">
          <StatusBlock status={status} onRefresh={onRefresh} />
          <GrantsBlock grants={grants} busy={busy} onAdd={onAddFolder} onRemove={onRemoveGrant} />
          <StartForm grants={grants} busy={busy} disabled={!status?.available} onStart={onStart} />
          <JobsList
            jobs={status?.jobs ?? NO_JOBS}
            grants={grants}
            selectedId={selectedJobId}
            onSelect={setSelectedJobId}
          />
        </div>
        <JobPanel
          jobId={selectedJobId}
          job={job}
          grant={grants.find((g) => g.id === job?.grantId) ?? null}
          transcript={transcript}
          busy={busy}
          onStop={onStop}
          onResume={onResume}
          onSend={onSend}
        />
      </div>
    </div>
  )
}

// Memoized like the jobs list: a streaming transcript re-renders the console
// every frame, and these don't change with it.
const StatusBlock = memo(function StatusBlock({
  status,
  onRefresh,
}: {
  status: LocalAgentStatus | null
  onRefresh: () => void
}) {
  return (
    <Section
      title="Status"
      actions={
        <Button size="sm" variant="outline" onClick={onRefresh}>
          Refresh
        </Button>
      }
    >
      {!status ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Available</dt>
          <dd className={cn(!status.available && 'text-destructive')}>
            {status.available ? 'yes' : `no${status.reason ? `: ${status.reason}` : ''}`}
          </dd>
          <dt className="text-muted-foreground">Node</dt>
          <dd className="break-all font-mono">{status.node ?? '—'}</dd>
          <dt className="text-muted-foreground">Agent dir</dt>
          <dd className="break-all font-mono">{status.agentDir ?? '—'}</dd>
          <dt className="text-muted-foreground">Built</dt>
          <dd className={cn(!status.built && 'text-destructive')}>
            {status.built ? 'yes' : 'no (run scripts/local-agent/build.sh)'}
          </dd>
        </dl>
      )}
    </Section>
  )
})

const GrantsBlock = memo(function GrantsBlock({
  grants,
  busy,
  onAdd,
  onRemove,
}: {
  grants: readonly LocalAgentGrant[]
  busy: boolean
  onAdd: () => void
  onRemove: (grantId: string) => void
}) {
  return (
    <Section
      title="Folders"
      actions={
        <Button size="sm" variant="outline" onClick={onAdd} disabled={busy}>
          Add folder…
        </Button>
      }
    >
      {grants.length === 0 ? (
        <p className="text-xs text-muted-foreground">No folders granted.</p>
      ) : (
        <ul className="space-y-2">
          {grants.map((g) => (
            <li key={g.id} className="flex items-start justify-between gap-2 text-xs">
              <div className="min-w-0">
                <div className="font-medium">
                  {g.label} <span className="text-muted-foreground">· {g.mode}</span>
                </div>
                <div className="break-all font-mono text-muted-foreground">{g.path}</div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => onRemove(g.id)} disabled={busy}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
})

const StartForm = memo(function StartForm({
  grants,
  busy,
  disabled,
  onStart,
}: {
  grants: readonly LocalAgentGrant[]
  busy: boolean
  disabled: boolean
  onStart: (grantId: string, request: string) => Promise<boolean>
}) {
  const [grantId, setGrantId] = useState('')
  const [request, setRequest] = useState('')
  const effectiveGrantId = grants.some((g) => g.id === grantId) ? grantId : (grants[0]?.id ?? '')
  const canStart = !disabled && !busy && !!effectiveGrantId && !!request.trim()

  const submit = async () => {
    if (!canStart) return
    if (await onStart(effectiveGrantId, request.trim())) setRequest('')
  }

  return (
    <Section title="Start a job">
      <Select value={effectiveGrantId} onValueChange={setGrantId} disabled={grants.length === 0}>
        <SelectTrigger>
          <SelectValue placeholder="Add a folder first" />
        </SelectTrigger>
        <SelectContent>
          {grants.map((g) => (
            <SelectItem key={g.id} value={g.id}>
              {g.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Textarea
        value={request}
        onChange={(e) => setRequest(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void submit()
          }
        }}
        placeholder="What should the agent do in this folder? (⌘↵ to start)"
        rows={4}
      />
      <Button size="sm" onClick={() => void submit()} disabled={!canStart}>
        Start
      </Button>
    </Section>
  )
})

const JobsList = memo(function JobsList({
  jobs,
  grants,
  selectedId,
  onSelect,
}: {
  jobs: readonly LocalAgentJob[]
  grants: readonly LocalAgentGrant[]
  selectedId: string | null
  onSelect: (jobId: string) => void
}) {
  const ordered = [...jobs].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
  return (
    <Section title={`Jobs (${jobs.length})`}>
      {ordered.length === 0 ? (
        <p className="text-xs text-muted-foreground">No jobs yet.</p>
      ) : (
        <ul className="space-y-1">
          {ordered.map((job) => (
            <li key={job.id}>
              <button
                type="button"
                onClick={() => onSelect(job.id)}
                className={cn(
                  'w-full rounded-md border px-3 py-2 text-left text-xs transition-colors hover:bg-accent',
                  job.id === selectedId ? 'border-foreground/30 bg-accent' : 'border-border',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">
                    {grants.find((g) => g.id === job.grantId)?.label ?? 'removed folder'}
                    <span className="ml-1 font-mono text-muted-foreground">{job.id.slice(0, 8)}</span>
                  </span>
                  <StatusBadge status={job.status} />
                </div>
                <div className="mt-1 truncate text-muted-foreground">{truncate(job.request, 120)}</div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">{formatTime(job.createdAt)}</div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
})

function JobPanel({
  jobId,
  job,
  grant,
  transcript,
  busy,
  onStop,
  onResume,
  onSend,
}: {
  jobId: string | null
  job: LocalAgentJob | null
  grant: LocalAgentGrant | null
  transcript: Transcript | null
  busy: boolean
  onStop: () => void
  onResume: () => void
  onSend: (text: string, policy: LocalAgentPolicy) => Promise<boolean>
}) {
  if (!jobId) {
    return (
      <Section title="Job">
        <p className="text-sm text-muted-foreground">Start a job or pick one from the list.</p>
      </Section>
    )
  }
  const live = job ? isJobLive(job) : false
  return (
    <Section
      title={job ? `Job ${job.id.slice(0, 8)} · ${grant?.label ?? 'removed folder'}` : `Job ${jobId.slice(0, 8)}`}
      actions={
        <div className="flex items-center gap-2">
          {job && <StatusBadge status={job.status} />}
          <Button size="sm" variant="destructive" onClick={onStop} disabled={busy || !live}>
            Stop
          </Button>
          {job && canResumeJob(job) && (
            <Button size="sm" variant="outline" onClick={onResume} disabled={busy}>
              Resume
            </Button>
          )}
        </div>
      }
    >
      {job?.request && (
        <div className="rounded-md bg-muted px-3 py-2 text-sm">
          <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">Request</div>
          <div className="whitespace-pre-wrap">{job.request}</div>
        </div>
      )}
      <TranscriptView items={transcript?.items ?? null} />
      <MessageBox disabled={!live} onSend={onSend} />
    </Section>
  )
}

/** Scrolls with the stream while the reader is at the bottom. */
function TranscriptView({ items }: { items: readonly TranscriptItem[] | null }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [items])
  return (
    <div
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      }}
      className="h-[60vh] space-y-2 overflow-y-auto rounded-md border border-border p-3"
    >
      {items === null ? (
        <p className="text-sm text-muted-foreground">Loading events…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No events yet.</p>
      ) : (
        items.map((item) => <TranscriptRow key={item.key} item={item} />)
      )}
    </div>
  )
}

const HIGHLIGHT: Record<'report' | 'ask' | 'finish' | 'error', { label: string; className: string }> = {
  report: { label: 'Report', className: 'border-sky-500 bg-sky-500/10' },
  ask: { label: 'Question for you', className: 'border-amber-500 bg-amber-500/10' },
  finish: { label: 'Finished', className: 'border-emerald-500 bg-emerald-500/10' },
  error: { label: 'Error', className: 'border-destructive bg-destructive/10 text-destructive' },
}

const TranscriptRow = memo(function TranscriptRow({ item }: { item: TranscriptItem }) {
  switch (item.type) {
    case 'assistant':
      return (
        <div className="whitespace-pre-wrap text-sm">
          {item.text}
          {item.open && <span className="text-muted-foreground">▍</span>}
        </div>
      )
    case 'tool': {
      const verdict = item.result ? (item.result.ok ? 'ok' : 'denied') : 'running'
      return (
        <details className="rounded-md border border-border text-xs">
          <summary className="flex cursor-pointer items-center gap-2 px-2 py-1">
            <span className="font-mono font-medium">{item.name || 'tool'}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
              {truncate(item.input, 100)}
              {item.result ? ` → ${truncate(item.result.output, 80)}` : ''}
            </span>
            <span
              className={cn(
                'shrink-0 rounded px-1.5 py-0.5 font-medium',
                verdict === 'ok' && 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
                verdict === 'denied' && 'bg-destructive/15 text-destructive',
                verdict === 'running' && 'bg-muted text-muted-foreground',
              )}
            >
              {verdict}
            </span>
          </summary>
          <div className="space-y-2 border-t border-border p-2">
            <pre className="whitespace-pre-wrap break-all font-mono">{item.input || '(no input)'}</pre>
            {item.result && (
              <pre className="whitespace-pre-wrap break-all font-mono text-muted-foreground">
                {item.result.output || '(no output)'}
              </pre>
            )}
          </div>
        </details>
      )
    }
    case 'report':
    case 'ask':
    case 'finish':
    case 'error': {
      const h = HIGHLIGHT[item.type]
      return (
        <div className={cn('rounded-r-md border-l-2 px-3 py-2 text-sm', h.className)}>
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide opacity-80">{h.label}</div>
          <div className="whitespace-pre-wrap">{item.text}</div>
        </div>
      )
    }
    case 'status':
      return (
        <div className="text-center text-[11px] text-muted-foreground">
          — {item.status}
          {item.reason ? `: ${item.reason}` : ''} —
        </div>
      )
    case 'sent':
    case 'inbound':
      return (
        <div className="ml-8 rounded-md bg-muted px-3 py-2 text-sm">
          <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
            {item.type === 'inbound' && item.author === 'agent' ? 'Dial8 agent' : 'You'} · {item.policy}
          </div>
          <div className="whitespace-pre-wrap">{item.text}</div>
        </div>
      )
    case 'branch':
      return (
        <div className="rounded-md border border-border px-3 py-2 font-mono text-xs">
          {item.name} · {item.commit.slice(0, 8)} · {item.filesChanged} files (+{item.insertions} −{item.deletions})
        </div>
      )
  }
})

function MessageBox({
  disabled,
  onSend,
}: {
  disabled: boolean
  onSend: (text: string, policy: LocalAgentPolicy) => Promise<boolean>
}) {
  const [text, setText] = useState('')
  const [policy, setPolicy] = useState<LocalAgentPolicy>('steer')
  const [sending, setSending] = useState(false)
  const canSend = !disabled && !sending && !!text.trim()

  const submit = async () => {
    if (!canSend) return
    setSending(true)
    try {
      if (await onSend(text.trim(), policy)) setText('')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="space-y-2">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void submit()
          }
        }}
        placeholder={disabled ? 'The job is not running (Resume it first)' : 'Message the agent (⌘↵ to send)'}
        disabled={disabled}
        rows={3}
      />
      <div className="flex items-center gap-2">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={policy}
          onValueChange={(v) => {
            if (v === 'steer' || v === 'queue') setPolicy(v)
          }}
          disabled={disabled}
        >
          <ToggleGroupItem value="steer" className="px-3">
            Steer
          </ToggleGroupItem>
          <ToggleGroupItem value="queue" className="px-3">
            Queue
          </ToggleGroupItem>
        </ToggleGroup>
        <span className="flex-1 text-[11px] text-muted-foreground">
          {policy === 'steer' ? 'Lands mid-turn.' : 'Waits for the turn to end.'} Idle, either starts a turn.
        </span>
        <Button size="sm" onClick={() => void submit()} disabled={!canSend}>
          Send
        </Button>
      </div>
    </div>
  )
}
