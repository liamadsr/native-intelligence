'use client'

import { useMemo, useState } from 'react'
import { CalendarCheck, Globe, MapPin, Video } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { SchedulingMeta, SchedulingNotice, SchedulingShell, TimeButton } from '@/components/scheduling/scheduling-shell'
import { useGuestTimeZone } from '@/components/scheduling/use-guest-time-zone'
import { answerFailure, groupByDay, shortDayLabel, clockLabel, waitingLabel, whenLabel, zoneShort, type AnsweredPoll, type PublicPollData } from '@/lib/time-offers/display'
import { POLL_NOTE_MAX } from '@/lib/time-offers/types'

/** A page that is only a heading and a line: the poll's final states. */
function Final({ title, children, ...rest }: { title: string; children?: React.ReactNode } & Record<`data-${string}`, string>) {
  return (
    <SchedulingShell>
      <CardHeader {...rest}>
        <CardTitle>{title}</CardTitle>
        {children && <CardDescription className="space-y-2 pt-1">{children}</CardDescription>}
      </CardHeader>
    </SchedulingShell>
  )
}

/** The marks that are still one of the open times. */
function openMarks(works: readonly string[], slots: PublicPollData['slots']): string[] {
  const open = new Set(slots.map((s) => s.start))
  return works.filter((start) => open.has(start))
}

/**
 * One guest's page of a poll (availability phase 5): the times the host is
 * asking several people about; they mark every one that works (or none),
 * and can change it until it is booked. Of the others only counts.
 */
export function PollView({ token, initial }: { token: string; initial: PublicPollData }) {
  const [poll, setPoll] = useState<PublicPollData>(initial)
  const [missing, setMissing] = useState(false)
  const [editing, setEditing] = useState(!initial.answer)
  // Only times still open are marked: one that passed or was taken has no button to unmark.
  const [marked, setMarked] = useState<string[]>(() => openMarks(initial.answer?.works ?? [], initial.slots))
  const [none, setNone] = useState(initial.answer?.none ?? false)
  const [note, setNote] = useState(initial.answer?.note ?? '')
  const [website, setWebsite] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const zone = useGuestTimeZone(poll.time_zone)
  const days = useMemo(() => groupByDay(poll.slots, zone), [poll.slots, zone])

  if (missing) {
    return (
      <Final title="This link doesn't work" data-poll-state="missing">
        It may have been mistyped or replaced. Ask the person who sent it for a new one.
      </Final>
    )
  }

  const host = poll.host_name
  const at = Date.parse(poll.slots[0]?.start ?? poll.booked?.start ?? poll.expires_at)
  const zoneName = zoneShort(zone, at)
  const hostZone = zoneShort(poll.time_zone, at)

  if (poll.state === 'booked') {
    const b = poll.booked
    if (b && !b.attending) {
      return (
        <Final title="A time was booked without you" data-poll-state="left-out">
          <span className="block">
            {host} booked {poll.title} with the others. If you&apos;d like to join, reply to {host}.
          </span>
        </Final>
      )
    }
    return (
      <SchedulingShell>
        <CardHeader data-poll-state="booked">
          <p className="text-sm font-medium text-muted-foreground">{host}</p>
          <CardTitle className="text-2xl">It&apos;s booked</CardTitle>
          <CardDescription>
            {poll.title} with {host}.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {b && (
            <p className="text-sm font-medium" data-poll-when>
              {whenLabel(b.start, b.end, zone)}
            </p>
          )}
          {b?.conference_url ? (
            <p className="flex min-w-0 items-center gap-2 text-sm">
              <Video aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <a href={b.conference_url} target="_blank" rel="noreferrer" className="truncate text-foreground underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground" data-poll-video>
                {b.conference_url.replace(/^https?:\/\//, '')}
              </a>
            </p>
          ) : b?.video ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Video aria-hidden className="size-4 shrink-0" />
              The video link will be in the invitation.
            </p>
          ) : b?.location ? (
            <p className="flex items-center gap-2 text-sm">
              <MapPin aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              {b.location}
            </p>
          ) : null}
          {b?.manage_url && (
            <p className="text-sm text-muted-foreground">
              Can&apos;t make it after all?{' '}
              <a href={b.manage_url} className="font-medium text-foreground underline underline-offset-4" data-poll-manage>
                Let {host} know
              </a>
              .
            </p>
          )}
        </CardContent>
      </SchedulingShell>
    )
  }
  if (poll.state === 'expired') {
    return (
      <Final title="These times have expired" data-poll-state="expired">
        They&apos;re no longer held. Ask {host} for new times.
      </Final>
    )
  }
  if (poll.state === 'withdrawn') {
    return (
      <Final title="These times are no longer offered" data-poll-state="withdrawn">
        {host} took them back. Reach out to {host} to find another time.
      </Final>
    )
  }
  if (!days.length) {
    return (
      <Final title="No times are left" data-poll-state="empty">
        Every time has passed or been taken. Ask {host} for new times.
      </Final>
    )
  }

  const header = (
    <CardHeader data-poll-state={editing ? 'open' : 'answered'}>
      <p className="text-sm font-medium text-muted-foreground">{host}</p>
      <CardTitle className="text-2xl">{poll.title}</CardTitle>
      <SchedulingMeta minutes={poll.duration_minutes} video={poll.video} location={poll.location} />
      {poll.message && (
        <blockquote className="mt-2 border-l-2 pl-3 text-sm italic text-foreground/80" data-poll-message>
          {poll.message}
        </blockquote>
      )}
    </CardHeader>
  )
  const zoneLine = (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-poll-zone>
      <Globe aria-hidden className="size-3.5" />
      Times in {zoneName}
      {zoneName !== hostZone ? ` (${host} is on ${hostZone})` : ''}
    </p>
  )
  const waiting = waitingLabel(poll.waiting, !!poll.answer)

  if (!editing && poll.answer) {
    const answer = poll.answer
    const works = poll.slots.filter((s) => answer.works.includes(s.start))
    return (
      <SchedulingShell>
        {header}
        <CardContent className="space-y-5">
          {answer.from_calendar ? (
            <SchedulingNotice tone="info" data-poll-calendar="">
              <span className="flex items-start gap-2">
                <CalendarCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
                <span>Your answer was filled in from your calendar: the times you&apos;re free. Change it if it&apos;s not right.</span>
              </span>
            </SchedulingNotice>
          ) : (
            <SchedulingNotice tone="info" data-poll-saved="">
              Your answer is saved. Once everyone has answered, the time that works for all is booked and you&apos;ll get the details.
            </SchedulingNotice>
          )}
          <div className="space-y-2" data-poll-answer>
            <p className="text-sm font-medium">
              {answer.none ? 'None of these times work for you.' : works.length ? 'These times work for you:' : 'The times you marked have passed or been taken. Change your answer to mark others.'}
            </p>
            {!answer.none && works.length > 0 && (
              <ul className="space-y-1 text-sm">
                {works.map((s) => (
                  <li key={s.start} className="tabular-nums">
                    {shortDayLabel(s.start, zone)}, {clockLabel(s.start, zone)}
                  </li>
                ))}
              </ul>
            )}
            {answer.note && <p className="text-sm text-muted-foreground">&ldquo;{answer.note}&rdquo;</p>}
            {!answer.none && works.length > 0 && zoneLine}
          </div>
          {waiting && (
            <p className="text-sm text-muted-foreground" data-poll-waiting>
              {waiting}
            </p>
          )}
          <Button variant="outline" className="w-full border" onClick={() => setEditing(true)} data-poll-change="">
            Change my answer
          </Button>
        </CardContent>
      </SchedulingShell>
    )
  }

  function toggle(start: string) {
    setNone(false)
    setMarked((m) => (m.includes(start) ? m.filter((s) => s !== start) : [...m, start]))
  }

  /** Back to the saved answer: the edits made since are dropped. */
  function keepAnswer() {
    setMarked(openMarks(poll.answer?.works ?? [], poll.slots))
    setNone(poll.answer?.none ?? false)
    setNote(poll.answer?.note ?? '')
    setError('')
    setEditing(false)
  }

  /** The poll as it is now: after it was booked meanwhile, its time and the guest's own manage link. */
  async function reload(): Promise<boolean> {
    try {
      const res = await fetch(`/api/public/time-offers/${encodeURIComponent(token)}`, { cache: 'no-store' })
      const data = (await res.json().catch(() => null)) as { poll?: PublicPollData } | null
      if (!res.ok || !data?.poll) return false
      setPoll(data.poll)
      return true
    } catch {
      return false
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/public/time-offers/${encodeURIComponent(token)}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ works: none ? [] : marked, none, note: note.trim() || undefined, website }),
      })
      const data = (await res.json().catch(() => null)) as (AnsweredPoll & { error?: string; code?: string }) | null
      if (res.ok && data?.ok && data.poll) {
        setPoll(data.poll)
        setMarked(data.poll.answer?.works ?? marked)
        setEditing(false)
      } else {
        const failure = answerFailure(res.status, data)
        if (failure.kind === 'closed') {
          // Booked meanwhile: read it again for the time and the guest's link; else the bare state.
          if (!(failure.state === 'booked' && (await reload()))) setPoll({ ...poll, state: failure.state, slots: [] })
        } else if (failure.kind === 'missing') setMissing(true)
        else if (failure.kind === 'slots') {
          setPoll({ ...poll, slots: failure.slots })
          setMarked((m) => openMarks(m, failure.slots))
          setError(failure.message)
        } else setError(failure.message)
      }
    } catch {
      setError("That didn't go through. Try again in a moment.")
    }
    setBusy(false)
  }

  const ready = none || marked.length > 0
  return (
    <SchedulingShell>
      {header}
      <CardContent>
        <form onSubmit={submit} className="space-y-6" data-poll-form>
          <div className="space-y-1">
            <p className="text-sm">
              {host} is finding a time for {poll.guests > 1 ? `${poll.guests} people` : 'you'}. Mark every time that works.
            </p>
            {zoneLine}
          </div>
          <div className="space-y-4" data-poll-slots>
            {days.map((d) => (
              <div key={d.key}>
                <p className="mb-2 text-sm font-medium">{d.label}</p>
                <div className="flex flex-wrap gap-2">
                  {d.slots.map((slot) => (
                    <TimeButton key={slot.start} on={!none && marked.includes(slot.start)} onClick={() => toggle(slot.start)}>
                      {slot.time}
                    </TimeButton>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm" data-poll-none>
            <input
              type="checkbox"
              checked={none}
              onChange={(e) => {
                setNone(e.target.checked)
                if (e.target.checked) setMarked([])
              }}
              className="size-4 accent-foreground"
            />
            None of these work
          </label>
          <div className="space-y-1.5">
            <Label htmlFor="poll-note">{none ? `Anything ${host} should know, like what would work? (optional)` : `A note for ${host} (optional)`}</Label>
            <Textarea id="poll-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={POLL_NOTE_MAX} />
          </div>
          {/* A field people never see: bots fill it. */}
          <input type="text" name="website" value={website} onChange={(e) => setWebsite(e.target.value)} tabIndex={-1} autoComplete="off" aria-hidden="true" className="hidden" />
          {error && <SchedulingNotice data-poll-error="">{error}</SchedulingNotice>}
          <div className="flex gap-2">
            {poll.answer && (
              <Button type="button" variant="outline" className="border" onClick={keepAnswer} disabled={busy}>
                Keep my answer
              </Button>
            )}
            <Button type="submit" className="flex-1" disabled={busy || !ready}>
              {busy ? 'Saving…' : 'Save answer'}
            </Button>
          </div>
        </form>
      </CardContent>
    </SchedulingShell>
  )
}
