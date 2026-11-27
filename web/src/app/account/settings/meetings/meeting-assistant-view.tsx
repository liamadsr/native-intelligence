'use client'

/**
 * Settings › Meetings: your AI assistant in meetings (roadmap #12 phase 2,
 * docs/plans/agent-joins-meetings.md §5). The meetings you sent it to, with
 * what it's doing now (scheduled, calling in, in the meeting, attended), the
 * questions it put to you and whether you answered, and a way out: cancel it,
 * skip one occurrence of a series, or pull it out of a meeting in progress.
 * Below, the recurring meetings it attends, each paused or stopped here.
 *
 * Sending it is from the chat ("go to my 3pm for me"): its card shows the
 * brief to approve. Everything reads and writes /api/account/meeting-agent;
 * the page only exists while MEETING_AGENT is on (./page.tsx).
 */
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Headphones } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { attendanceActions, attendanceStatusLine, type AttendanceStatusName } from '@/lib/meeting-agent/status-copy'

export const MEETING_AGENT_URL = '/api/account/meeting-agent'

interface Ask {
  at: string
  question: string
  messageId: string
}

interface Attendance {
  id: string
  title: string
  startsAt: string
  status: AttendanceStatusName
  statusDetail: string | null
  displayName: string
  asks: Ask[]
  captureId: string | null
  /** The series that sent it (727), or null for a meeting sent alone. */
  seriesRef: string | null
}

interface Series {
  id: string
  title: string
  pausedAt: string | null
}

interface Loaded {
  attendances: Attendance[]
  series: Series[]
}

const ACTION_LABEL = { cancel: 'Cancel', skip: 'Skip this one', pull_out: 'Pull it out' } as const

function when(iso: string): string {
  const d = new Date(iso)
  return Number.isFinite(d.getTime()) ? d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''
}

export function MeetingAssistantView() {
  const [data, setData] = useState<Loaded | null>(null)
  const [off, setOff] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(MEETING_AGENT_URL)
      if (res.status === 403) {
        setOff(true)
        return
      }
      if (!res.ok) throw new Error(String(res.status))
      setData((await res.json()) as Loaded)
    } catch {
      toast.error("Couldn't load your assistant's meetings.")
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const act = async (key: string, init: { url: string; method: 'DELETE' | 'PATCH'; body?: unknown }, done: string) => {
    setBusy(key)
    try {
      const res = await fetch(init.url, { method: init.method, ...(init.body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) } : {}) })
      if (!res.ok) throw new Error(String(res.status))
      toast.success(done)
      await load()
    } catch {
      toast.error('That didn’t go through. Try again.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-8 py-8">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white shadow-sm dark:bg-zinc-800">
            <Headphones className="h-5 w-5 text-sky-500" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Meetings</h1>
            <p className="text-sm text-muted-foreground">
              Your AI assistant can attend a meeting for you by phone. It says it is your AI assistant taking notes, speaks only from the brief you approve, and texts you when it needs you. Ask in the chat: “go to my 3pm for me”.
            </p>
          </div>
        </div>

        {off ? (
          <p className="mt-8 text-sm text-muted-foreground">Sending your assistant to meetings isn’t turned on yet.</p>
        ) : !data ? (
          <p className="mt-8 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <section className="mt-8">
              <h2 className="text-sm font-medium">Meetings</h2>
              {data.attendances.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">You haven’t sent your assistant to a meeting yet.</p>
              ) : (
                <ul className="mt-2 divide-y rounded-lg border">
                  {data.attendances.map((a) => {
                    const fromSeries = !!a.seriesRef
                    return (
                      <li key={a.id} className="flex items-start justify-between gap-4 p-3" data-attendance={a.id}>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{a.title || 'Meeting'}</p>
                          <p className="text-xs text-muted-foreground">{when(a.startsAt)}</p>
                          <p className="mt-1 text-sm">{attendanceStatusLine(a.status, a.statusDetail)}</p>
                          {a.asks.length > 0 && (
                            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                              {a.asks.map((q) => (
                                <li key={q.messageId}>Asked you: {q.question}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                        <div className="flex shrink-0 gap-2">
                          {attendanceActions(a.status, fromSeries).map((action) => (
                            <Button
                              key={action}
                              size="sm"
                              variant="outline"
                              disabled={busy !== null}
                              onClick={() => act(`${a.id}:${action}`, { url: `${MEETING_AGENT_URL}?id=${encodeURIComponent(a.id)}`, method: 'DELETE' }, action === 'pull_out' ? 'Your assistant is leaving the meeting.' : 'Cancelled.')}
                            >
                              {ACTION_LABEL[action]}
                            </Button>
                          ))}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>

            {data.series.length > 0 && (
              <section className="mt-8">
                <h2 className="text-sm font-medium">Recurring meetings</h2>
                <ul className="mt-2 divide-y rounded-lg border">
                  {data.series.map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-4 p-3" data-series={s.id}>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{s.title || 'Recurring meeting'}</p>
                        <p className="text-xs text-muted-foreground">{s.pausedAt ? 'Paused.' : 'Attends every occurrence with the same brief.'}</p>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => act(`${s.id}:pause`, { url: MEETING_AGENT_URL, method: 'PATCH', body: { series_id: s.id, paused: !s.pausedAt } }, s.pausedAt ? 'Turned back on.' : 'Paused.')}>
                          {s.pausedAt ? 'Turn on' : 'Pause'}
                        </Button>
                        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => act(`${s.id}:stop`, { url: `${MEETING_AGENT_URL}?series_id=${encodeURIComponent(s.id)}`, method: 'DELETE' }, 'Stopped.')}>
                          Stop
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}
