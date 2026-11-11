'use client'

import { useMemo, useRef, useState } from 'react'
import { Globe, MapPin, Video } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { SchedulingMeta, SchedulingNotice, SchedulingShell, TimeButton } from '@/components/scheduling/scheduling-shell'
import { useGuestTimeZone } from '@/components/scheduling/use-guest-time-zone'
import {
  dayLabel,
  clockLabel,
  groupByDay,
  pickFailure,
  whenLabel,
  zoneShort,
  type AcceptedBooking,
  type PageLoad,
  type PublicOfferData,
  type PublicSlot,
} from '@/lib/time-offers/display'
import { EMAIL_MAX, GUEST_NOTE_MAX, RECIPIENT_NAME_MAX } from '@/lib/time-offers/types'

/** A page that is only a heading and a line: the offer's final states. */
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

export function OfferView({ token, load }: { token: string; load: PageLoad<PublicOfferData> }) {
  const [offer, setOffer] = useState<PublicOfferData | null>(load.kind === 'found' ? load.data : null)
  const [missing, setMissing] = useState(load.kind === 'missing')
  const [picked, setPicked] = useState<PublicSlot | null>(null)
  const [name, setName] = useState(offer?.recipient_name ?? '')
  const [email, setEmail] = useState('')
  const [note, setNote] = useState('')
  const [website, setWebsite] = useState('')
  const [askEmail, setAskEmail] = useState(offer?.needs_email ?? false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [taken, setTaken] = useState(false)
  const slotsRef = useRef<HTMLDivElement>(null)
  const [done, setDone] = useState<AcceptedBooking | null>(null)
  const zone = useGuestTimeZone(offer?.time_zone ?? 'UTC')
  const days = useMemo(() => (offer ? groupByDay(offer.slots, zone) : []), [offer, zone])

  if (missing) {
    return (
      <Final title="This link doesn't work" data-offer-state="missing">
        It may have been mistyped or replaced. Ask the person who sent it for a new one.
      </Final>
    )
  }
  if (!offer) {
    return (
      <Final title="This page isn't available right now" data-offer-state="error">
        Try again in a minute.
      </Final>
    )
  }

  const host = offer.host_name
  const at = Date.parse(offer.slots[0]?.start ?? offer.booked_start ?? offer.expires_at)
  const zoneName = zoneShort(zone, at)
  const hostZone = zoneShort(offer.time_zone, at)

  if (done) {
    const b = done.booking
    const pending = done.status === 'booking'
    return (
      <SchedulingShell>
        <CardHeader data-offer-state="confirmed">
          <p className="text-sm font-medium text-muted-foreground">{b.host_name}</p>
          <CardTitle className="text-2xl">You&apos;re booked</CardTitle>
          <CardDescription>
            {b.title} with {b.host_name}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm font-medium" data-offer-when>
            {whenLabel(b.start, b.end, zone)}
          </p>
          {b.conference_url ? (
            <p className="flex min-w-0 items-center gap-2 text-sm">
              <Video aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <a href={b.conference_url} target="_blank" rel="noreferrer" className="truncate text-foreground underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground" data-offer-video>
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
          <SchedulingNotice tone="info" data-offer-invite="">
            {pending
              ? `Your time is held. The invitation follows in a minute${email ? `, to ${email}` : ''}.`
              : `An invitation is on its way to ${email ? email : 'your inbox'}.`}
          </SchedulingNotice>
          <p className="text-sm text-muted-foreground">
            Need to change it?{' '}
            <a href={done.manage_url} className="font-medium text-foreground underline underline-offset-4" data-offer-manage>
              Reschedule or cancel
            </a>
            . The link is in the invitation too.
          </p>
        </CardContent>
      </SchedulingShell>
    )
  }

  if (offer.state === 'booked') {
    const start = offer.booked_start
    return (
      <Final title="This time is booked" data-offer-state="booked">
        {start ? (
          <span className="block font-medium text-foreground" data-offer-when>
            {whenLabel(start, new Date(Date.parse(start) + offer.duration_minutes * 60_000).toISOString(), zone)}
          </span>
        ) : null}
        <span className="block">
          {offer.title} with {host}. The invitation has the link to reschedule or cancel.
        </span>
      </Final>
    )
  }
  if (offer.state === 'expired') {
    return (
      <Final title="These times have expired" data-offer-state="expired">
        They&apos;re no longer held. Ask {host} for new times.
      </Final>
    )
  }
  if (offer.state === 'withdrawn') {
    return (
      <Final title="These times are no longer offered" data-offer-state="withdrawn">
        {host} took them back. Reach out to {host} to find another time.
      </Final>
    )
  }
  if (!days.length) {
    return (
      <Final title="No times are left" data-offer-state="empty">
        {taken ? 'The last time was just taken. ' : 'Every offered time has passed or been taken. '}Ask {host} for new times.
      </Final>
    )
  }

  const needsEmail = askEmail
  async function refresh() {
    try {
      const res = await fetch(`/api/public/time-offers/${encodeURIComponent(token)}`, { cache: 'no-store' })
      if (res.status === 404) return setMissing(true)
      const data = (await res.json().catch(() => null)) as { offer?: PublicOfferData } | null
      if (res.ok && data?.offer) setOffer(data.offer)
    } catch {
      /* the page keeps what it has */
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!picked || !offer) return
    setBusy(true)
    setError('')
    setTaken(false)
    try {
      const res = await fetch(`/api/public/time-offers/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start: picked.start, name, ...(needsEmail ? { email } : {}), note, time_zone: zone, website }),
      })
      const data = (await res.json().catch(() => null)) as (AcceptedBooking & { ok?: boolean; error?: string; code?: string; details?: unknown }) | null
      if (res.ok && data?.ok && data.booking) {
        setDone(data)
      } else {
        const failure = pickFailure(res.status, data, offer.host_name)
        if (failure.kind === 'slot_taken') {
          setOffer({ ...offer, slots: failure.slots })
          setPicked(null)
          setTaken(true)
          // The form goes with the pick: keep the place on the times still open.
          slotsRef.current?.focus()
        } else if (failure.kind === 'closed') {
          setOffer({ ...offer, state: failure.state, slots: [] })
          await refresh()
        } else if (failure.kind === 'missing') {
          setMissing(true)
        } else {
          if (failure.kind === 'needs_email') setAskEmail(true)
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
      <CardHeader data-offer-state="open">
        <p className="text-sm font-medium text-muted-foreground">{host}</p>
        <CardTitle className="text-2xl">{offer.title}</CardTitle>
        <SchedulingMeta minutes={offer.duration_minutes} video={offer.video} location={offer.location} />
        {offer.message && (
          <blockquote className="mt-2 border-l-2 pl-3 text-sm italic text-foreground/80" data-offer-message>
            {offer.message}
          </blockquote>
        )}
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-1">
          <p className="text-sm">{host} is holding these times for you. Pick the one that works.</p>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-offer-zone>
            <Globe aria-hidden className="size-3.5" />
            Times in {zoneName}
            {zoneName !== hostZone ? ` (${host} is on ${hostZone})` : ''}
          </p>
        </div>
        {taken && <SchedulingNotice data-offer-taken="">That time was just taken. These are still open.</SchedulingNotice>}
        <div ref={slotsRef} tabIndex={-1} className="space-y-4 outline-none" data-offer-slots>
          {days.map((d) => (
            <div key={d.key}>
              <p className="mb-2 text-sm font-medium">{d.label}</p>
              <div className="flex flex-wrap gap-2">
                {d.slots.map((slot) => {
                  const on = picked?.start === slot.start
                  return (
                    <TimeButton key={slot.start} on={on} onClick={() => setPicked(on ? null : slot)}>
                      {slot.time}
                    </TimeButton>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        {picked && (
          <form onSubmit={submit} className="space-y-4 border-t pt-6" data-offer-form>
            <p className="text-sm">
              {offer.title} on{' '}
              <strong>
                {dayLabel(picked.start, zone)}, {clockLabel(picked.start, zone)} {zoneName}
              </strong>
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="offer-name">Your name</Label>
              <Input id="offer-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required maxLength={RECIPIENT_NAME_MAX} />
            </div>
            {needsEmail && (
              <div className="space-y-1.5">
                <Label htmlFor="offer-email">Email</Label>
                <Input id="offer-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" inputMode="email" required maxLength={EMAIL_MAX} />
                <p className="text-xs text-muted-foreground">The calendar invitation goes here.</p>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="offer-note">Anything {host} should know? (optional)</Label>
              <Textarea id="offer-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={GUEST_NOTE_MAX} />
            </div>
            {/* A field people never see: bots fill it. */}
            <input type="text" name="website" value={website} onChange={(e) => setWebsite(e.target.value)} tabIndex={-1} autoComplete="off" aria-hidden="true" className="hidden" />
            {error && <SchedulingNotice data-offer-error="">{error}</SchedulingNotice>}
            <Button type="submit" className="w-full" disabled={busy || !name.trim() || (needsEmail && !email.trim())}>
              {busy ? 'Booking…' : `Confirm ${clockLabel(picked.start, zone)}`}
            </Button>
          </form>
        )}
      </CardContent>
    </SchedulingShell>
  )
}
