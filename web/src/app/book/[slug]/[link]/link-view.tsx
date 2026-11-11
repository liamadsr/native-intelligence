'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Globe, MapPin, Users, Video } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { MobileInput } from '@/components/scheduling/mobile-input'
import { SchedulingMeta, SchedulingNotice, SchedulingShell, TimeButton } from '@/components/scheduling/scheduling-shell'
import { useGuestTimeZone } from '@/components/scheduling/use-guest-time-zone'
import { hostsLine, hostsNote, linkBookFailure, slotsByDay, stripCount, stripDays, stripHeading, STRIP_DAYS, todayKey, type TimedSlot } from '@/lib/booking-links/page'
import { ANSWER_MAX, LINK_NOTE_MAX, type PublicLinkBooked, type PublicLinkData, type PublicLinkTimes } from '@/lib/booking-links/types'
import { formatE164ForDisplay, isCompleteNanp, isImpossibleNanp, nanpE164 } from '@/lib/sms/phone-format'
import { clockLabel, dayLabel, whenLabel, zoneShort, type PageLoad } from '@/lib/time-offers/display'
import { EMAIL_MAX, RECIPIENT_NAME_MAX } from '@/lib/time-offers/types'
import { cn } from '@/lib/utils'

/** One strip's times: being read, read, or not readable just now. */
type StripTimes = { kind: 'loading' } | { kind: 'ready'; byDay: Record<string, TimedSlot[]> } | { kind: 'unavailable' } | { kind: 'error' }

/** A page that is only a heading and a line: not found, turned off, unreadable. */
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

/** The days of one strip: each a button, the ones with no times visibly empty. */
function DayStrip({ days, times, selected, onSelect }: { days: ReturnType<typeof stripDays>; times: StripTimes; selected: string | null; onSelect: (key: string) => void }) {
  return (
    <div className="grid grid-cols-7 gap-1" data-link-days="">
      {days.map((d) => {
        const count = times.kind === 'ready' ? (times.byDay[d.key]?.length ?? 0) : null
        const empty = d.outside || count === 0
        const on = selected === d.key
        return (
          <button
            key={d.key}
            type="button"
            disabled={d.outside}
            onClick={() => onSelect(d.key)}
            aria-pressed={on}
            aria-label={`${d.weekday} ${d.month} ${d.date}${count === 0 ? ', no times' : ''}`}
            data-day={d.key}
            data-empty={empty ? '' : undefined}
            className={cn(
              'flex flex-col items-center rounded-md border py-1.5 text-center transition-colors disabled:cursor-default',
              on ? 'border-foreground bg-foreground text-background' : empty ? 'border-transparent text-muted-foreground/60' : 'hover:bg-muted',
              d.outside && 'opacity-40',
            )}
          >
            <span className={cn('text-[11px] uppercase tracking-wide', on ? 'text-background/80' : 'text-muted-foreground')}>{d.weekday}</span>
            <span className={cn('text-base tabular-nums', empty && !on ? 'font-normal' : 'font-medium')}>{d.date}</span>
            <span aria-hidden className={cn('mt-0.5 size-1 rounded-full', count ? (on ? 'bg-background' : 'bg-foreground') : 'bg-transparent')} />
          </button>
        )
      })}
    </div>
  )
}

export function LinkView({ profile, slug, load }: { profile: string; slug: string; load: PageLoad<PublicLinkData> }) {
  const link = load.kind === 'found' ? load.data : null
  const zone = useGuestTimeZone(link?.time_zone ?? 'UTC')
  // The server's read time: its render and the browser's agree.
  const [now] = useState(() => (load.kind === 'found' && load.at) || Date.now())
  const timesRef = useRef<HTMLDivElement>(null)
  const today = todayKey(now, zone)
  const [page, setPage] = useState(0)
  const [cache, setCache] = useState<Record<string, StripTimes>>({})
  const [reload, setReload] = useState(0)
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [picked, setPicked] = useState<TimedSlot | null>(null)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [digits, setDigits] = useState('')
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  const [website, setWebsite] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null)
  const [taken, setTaken] = useState(false)
  const [closed, setClosed] = useState<'missing' | 'closed' | null>(null)
  const [done, setDone] = useState<PublicLinkBooked | null>(null)

  const windowDays = link?.window_days ?? 30
  const days = useMemo(() => stripDays(today, page, windowDays), [today, page, windowDays])
  const first = days[0].key
  const cacheKey = `${zone}|${first}`
  const times: StripTimes = cache[cacheKey] ?? { kind: 'loading' }

  // One read per strip (and zone), when it is first shown or asked for again; nothing polls.
  useEffect(() => {
    if (!link) return
    if (cache[cacheKey] && reload === 0) return
    const controller = new AbortController()
    // A tick later: the guest's zone settles right after hydration, and only that strip is read.
    const timer = setTimeout(async () => {
      setCache((c) => ({ ...c, [cacheKey]: { kind: 'loading' } }))
      try {
        const res = await fetch(`/api/public/booking-links/${encodeURIComponent(profile)}/${encodeURIComponent(slug)}/times?from=${first}&days=${STRIP_DAYS}&tz=${encodeURIComponent(zone)}`, { cache: 'no-store', signal: controller.signal })
        if (res.status === 404) return setClosed('missing')
        const body = (await res.json().catch(() => null)) as PublicLinkTimes | null
        const next: StripTimes = res.ok && body ? { kind: 'ready', byDay: slotsByDay(body.slots, zone) } : res.status === 503 ? { kind: 'unavailable' } : { kind: 'error' }
        setCache((c) => ({ ...c, [cacheKey]: next }))
      } catch {
        if (!controller.signal.aborted) setCache((c) => ({ ...c, [cacheKey]: { kind: 'error' } }))
      } finally {
        if (!controller.signal.aborted) setReload(0)
      }
    }, 0)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
    // `cache` is read, not followed: a strip is read once, or again on `reload`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link, cacheKey, reload, first, zone, profile, slug])

  if (closed === 'missing' || (!link && load.kind === 'missing')) {
    return (
      <Final title="This booking page doesn't exist" data-link-state="missing">
        It may have been turned off, or the link mistyped. Ask the person who sent it for a new one.
      </Final>
    )
  }
  if (closed === 'closed') {
    return (
      <Final title="This booking page is turned off" data-link-state="closed">
        It isn&apos;t taking bookings right now. Reach out to the person who sent it to find a time.
      </Final>
    )
  }
  if (!link) {
    return (
      <Final title="This page isn't available right now" data-link-state="error">
        Try again in a minute.
      </Final>
    )
  }

  const host = hostsLine(link.host_names, link.host_mode)
  const together = hostsNote(link.host_names, link.host_mode)
  const zoneName = zoneShort(zone, now)
  const hostZone = zoneShort(link.time_zone, now)
  const byDay = times.kind === 'ready' ? times.byDay : {}
  const firstWithTimes = days.find((d) => !d.outside && byDay[d.key]?.length)?.key ?? null
  const day = selectedDay && days.some((d) => d.key === selectedDay) ? selectedDay : (firstWithTimes ?? days.find((d) => !d.outside)?.key ?? first)
  const dayTimes = byDay[day] ?? []
  const pages = stripCount(windowDays)
  const askEmail = link.contact !== 'phone'
  const askPhone = link.contact !== 'email'
  const phoneOnly = askPhone && !email.trim() && digits.length > 0
  const phoneBad = isImpossibleNanp(digits) || (digits.length > 0 && digits.length < 10 && fieldError?.field === 'phone')
  const contactReady = link.contact === 'email' ? !!email.trim() : link.contact === 'phone' ? isCompleteNanp(digits) : !!email.trim() || isCompleteNanp(digits)
  const answered = link.questions.every((q) => !q.required || answers[q.id]?.trim())
  const errorFor = (field: string) => (fieldError?.field === field ? fieldError.message : null)

  if (done) {
    const b = done.booking
    const requested = done.status === 'requested'
    const held = done.status === 'booking'
    const by = email.trim() ? email.trim() : digits ? formatE164ForDisplay(nanpE164(digits)) : null
    return (
      <SchedulingShell>
        <CardHeader data-link-state={done.status}>
          <p className="text-sm font-medium text-muted-foreground">{b.host_name}</p>
          <CardTitle className="text-2xl">{requested ? 'Request sent' : 'You’re booked'}</CardTitle>
          <CardDescription>
            {b.title} with {b.host_name}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm font-medium" data-link-when>
            {whenLabel(b.start, b.end, zone)}
          </p>
          {b.conference_url ? (
            <p className="flex min-w-0 items-center gap-2 text-sm">
              <Video aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <a href={b.conference_url} target="_blank" rel="noreferrer" className="truncate text-foreground underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground" data-link-video>
                {b.conference_url.replace(/^https?:\/\//, '')}
              </a>
            </p>
          ) : b.video ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Video aria-hidden className="size-4 shrink-0" />
              The video link will be in the invitation.
            </p>
          ) : b.location ? (
            <p className="flex items-center gap-2 text-sm">
              <MapPin aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              {b.location}
            </p>
          ) : null}
          <SchedulingNotice tone="info" data-link-invite="">
            {requested
              ? `${b.host_name} will confirm. Nothing is booked until then: the time is held for you${email.trim() ? `, and the invitation goes to ${email.trim()} once it's a yes` : by ? `, and you'll get a text at ${by} once it's a yes` : ''}.`
              : held
                ? `Your time is held. The invitation follows in a minute${by ? `, to ${by}` : ''}.`
                : `An invitation is on its way to ${by ?? 'your inbox'}.`}
          </SchedulingNotice>
          {done.manage_url && (
            <p className="text-sm text-muted-foreground">
              {requested ? 'Changed your mind?' : 'Need to change it?'}{' '}
              <a href={done.manage_url} className="font-medium text-foreground underline underline-offset-4" data-link-manage>
                {requested ? 'Cancel the request' : 'Reschedule or cancel'}
              </a>
              {requested ? '.' : '. The link is in the invitation too.'}
            </p>
          )}
        </CardContent>
      </SchedulingShell>
    )
  }

  function chooseDay(key: string) {
    setSelectedDay(key)
    setPicked(null)
    setTaken(false)
  }

  function turn(by: number) {
    setPage((p) => Math.min(pages - 1, Math.max(0, p + by)))
    setSelectedDay(null)
    setPicked(null)
    setTaken(false)
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!picked || !link) return
    setBusy(true)
    setError('')
    setFieldError(null)
    setTaken(false)
    try {
      const res = await fetch(`/api/public/booking-links/${encodeURIComponent(profile)}/${encodeURIComponent(slug)}/book`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start: picked.start,
          name,
          ...(email.trim() ? { email: email.trim() } : {}),
          ...(digits ? { phone: nanpE164(digits) } : {}),
          answers: Object.fromEntries(Object.entries(answers).filter(([, v]) => v.trim())),
          note,
          time_zone: zone,
          website,
        }),
      })
      const data = (await res.json().catch(() => null)) as (PublicLinkBooked & { error?: string; code?: string; details?: unknown }) | null
      if (res.ok && data?.ok && data.booking) {
        setDone(data)
      } else {
        const failure = linkBookFailure(res.status, data, host)
        if (failure.kind === 'slot_taken') {
          // That day's times again, fresh: the server dropped what it kept.
          setPicked(null)
          setTaken(true)
          setReload((n) => n + 1)
          // The form goes with the pick: keep the place on the day's times.
          timesRef.current?.focus()
        } else if (failure.kind === 'closed') {
          setClosed('closed')
        } else if (failure.kind === 'missing') {
          setClosed('missing')
        } else if (failure.kind === 'field') {
          setFieldError({ field: failure.field, message: failure.message })
        } else {
          setError(failure.message)
        }
      }
    } catch {
      setError("That didn't go through. Try again in a moment.")
    }
    setBusy(false)
  }

  return (
    <SchedulingShell>
      <CardHeader data-link-state="open">
        <p className="text-sm font-medium text-muted-foreground" data-link-hosts>
          {host}
        </p>
        <CardTitle className="text-2xl">{link.title}</CardTitle>
        <SchedulingMeta minutes={link.duration_minutes} video={link.video} location={link.location}>
          {together && (
            <span className="flex items-center gap-1.5" data-link-together>
              <Users aria-hidden className="size-4" />
              {together}
            </span>
          )}
        </SchedulingMeta>
        {link.description && (
          <p className="whitespace-pre-line pt-1 text-sm text-foreground/80" data-link-description>
            {link.description}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium" data-link-month>
              {stripHeading(days)}
            </p>
            <div className="flex items-center gap-1">
              <Button type="button" variant="ghost" size="icon" className="size-8" aria-label="Earlier days" disabled={page === 0} onClick={() => turn(-1)}>
                <ChevronLeft className="size-4" />
              </Button>
              <Button type="button" variant="ghost" size="icon" className="size-8" aria-label="Later days" disabled={page >= pages - 1} onClick={() => turn(1)}>
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
          <DayStrip days={days} times={times} selected={day} onSelect={chooseDay} />
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-link-zone>
            <Globe aria-hidden className="size-3.5" />
            Times in {zoneName}
            {zoneName !== hostZone ? ` (${link.host_names.length > 1 ? 'the hosts are' : `${host} is`} on ${hostZone})` : ''}
          </p>
        </div>

        {taken && <SchedulingNotice data-link-taken="">That time was just taken. Here&apos;s what&apos;s still open.</SchedulingNotice>}

        <div ref={timesRef} tabIndex={-1} className="outline-none" data-link-times="">
          <p className="mb-2 text-sm font-medium">{dayLabel(`${day}T12:00:00Z`, 'UTC')}</p>
          {times.kind === 'loading' ? (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4" aria-label="Loading times">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-8" />
              ))}
            </div>
          ) : times.kind === 'unavailable' || times.kind === 'error' ? (
            <div className="space-y-2" data-link-unavailable="">
              <SchedulingNotice>
                {times.kind === 'unavailable' ? `We couldn't check ${host}'s calendar just now. Try again in a minute.` : "The times didn't load. Try again in a moment."}
              </SchedulingNotice>
              <Button type="button" variant="outline" size="sm" onClick={() => setReload((n) => n + 1)}>
                Try again
              </Button>
            </div>
          ) : dayTimes.length === 0 ? (
            <p className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground" data-link-empty="">
              {firstWithTimes ? 'No open times this day. Pick another.' : page < pages - 1 ? 'No open times these days. Try the next ones.' : 'No open times left in this window.'}
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {dayTimes.map((slot) => {
                const on = picked?.start === slot.start
                return (
                  <TimeButton key={slot.start} on={on} onClick={() => setPicked(on ? null : slot)}>
                    {slot.time}
                  </TimeButton>
                )
              })}
            </div>
          )}
        </div>

        {picked && (
          <form onSubmit={submit} className="space-y-4 border-t pt-6" data-link-form noValidate>
            <p className="text-sm">
              {link.title} on{' '}
              <strong>
                {dayLabel(picked.start, zone)}, {clockLabel(picked.start, zone)} {zoneName}
              </strong>
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="link-name">Your name</Label>
              <Input id="link-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required maxLength={RECIPIENT_NAME_MAX} aria-invalid={!!errorFor('name') || undefined} />
              {errorFor('name') && <p className="text-xs text-destructive">{errorFor('name')}</p>}
            </div>
            {askEmail && (
              <div className="space-y-1.5">
                <Label htmlFor="link-email">Email</Label>
                <Input id="link-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" inputMode="email" maxLength={EMAIL_MAX} aria-invalid={!!errorFor('email') || undefined} />
                {errorFor('email') ? <p className="text-xs text-destructive">{errorFor('email')}</p> : <p className="text-xs text-muted-foreground">The calendar invitation goes here.</p>}
              </div>
            )}
            {askPhone && (
              <div className="space-y-1.5">
                <Label htmlFor="link-phone">{askEmail ? 'Mobile number (optional)' : 'Mobile number'}</Label>
                <MobileInput id="link-phone" digits={digits} onDigits={setDigits} invalid={phoneBad || !!errorFor('phone')} />
                {phoneBad || errorFor('phone') ? (
                  <p className="text-xs text-destructive">{errorFor('phone') ?? 'Not a valid US or Canadian number.'}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">{askEmail ? (phoneOnly ? `With a mobile number only, ${host} confirms first and you get a text.` : 'Email or mobile: one is enough.') : 'Your confirmation comes by text.'}</p>
                )}
              </div>
            )}
            {errorFor('contact') && <SchedulingNotice data-link-error="">{errorFor('contact')}</SchedulingNotice>}
            {link.questions.map((q) => (
              <div key={q.id} className="space-y-1.5" data-link-question={q.id}>
                <Label htmlFor={`link-q-${q.id}`}>
                  {q.label}
                  {q.required ? '' : ' (optional)'}
                </Label>
                {q.kind === 'long' ? (
                  <Textarea id={`link-q-${q.id}`} value={answers[q.id] ?? ''} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} rows={3} maxLength={ANSWER_MAX} required={q.required} aria-invalid={!!errorFor(q.id) || undefined} />
                ) : (
                  <Input id={`link-q-${q.id}`} value={answers[q.id] ?? ''} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} maxLength={ANSWER_MAX} required={q.required} aria-invalid={!!errorFor(q.id) || undefined} />
                )}
                {errorFor(q.id) && <p className="text-xs text-destructive">{errorFor(q.id)}</p>}
              </div>
            ))}
            <div className="space-y-1.5">
              <Label htmlFor="link-note">Anything {host} should know? (optional)</Label>
              <Textarea id="link-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={LINK_NOTE_MAX} />
            </div>
            {/* A field people never see: bots fill it. */}
            <input type="text" name="website" value={website} onChange={(e) => setWebsite(e.target.value)} tabIndex={-1} autoComplete="off" aria-hidden="true" className="hidden" />
            {error && <SchedulingNotice data-link-error="">{error}</SchedulingNotice>}
            <Button type="submit" className="w-full" disabled={busy || !name.trim() || !contactReady || !answered}>
              {busy ? (link.ask_first || phoneOnly ? 'Sending…' : 'Booking…') : `${link.ask_first || phoneOnly ? 'Request' : 'Confirm'} ${clockLabel(picked.start, zone)}`}
            </Button>
            {link.ask_first && <p className="text-center text-xs text-muted-foreground">{host} confirms each booking. The time is held for you until then.</p>}
            {askPhone && digits && <p className="text-center text-xs text-muted-foreground">You agree to get texts about this booking. Msg &amp; data rates may apply. Reply STOP to opt out.</p>}
          </form>
        )}
      </CardContent>
    </SchedulingShell>
  )
}
