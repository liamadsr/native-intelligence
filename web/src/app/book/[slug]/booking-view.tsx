'use client'

import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { SchedulingNotice, SchedulingShell as Shell, TimeButton } from '@/components/scheduling/scheduling-shell'
import { formatE164ForDisplay } from '@/lib/sms/phone-format'
import type { BookingPageSlot, BookingPageState } from '@/lib/customers/booking-link'

/** The days the page offers, each with its open times, in order. */
function byDay(slots: readonly BookingPageSlot[]): Array<{ day: string; slots: BookingPageSlot[] }> {
  const days: Array<{ day: string; slots: BookingPageSlot[] }> = []
  for (const slot of slots) {
    const last = days[days.length - 1]
    if (last && last.day === slot.day) last.slots.push(slot)
    else days.push({ day: slot.day, slots: [slot] })
  }
  return days
}

function capitalized(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

export function BookingView({ slug, state }: { slug: string; state: BookingPageState }) {
  const [picked, setPicked] = useState<BookingPageSlot | null>(null)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [address, setAddress] = useState('')
  const [note, setNote] = useState('')
  const [website, setWebsite] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<string | null>(null)
  const days = useMemo(() => (state.kind === 'open' ? byDay(state.slots) : []), [state])

  if (state.kind === 'missing') {
    return (
      <Shell>
        <CardHeader>
          <CardTitle>This booking page doesn&apos;t exist</CardTitle>
          <CardDescription>Check the link you were sent, or contact the business directly.</CardDescription>
        </CardHeader>
      </Shell>
    )
  }

  const text = state.phone ? formatE164ForDisplay(state.phone) : null
  if (state.kind === 'unavailable') {
    return (
      <Shell>
        <CardHeader>
          <CardTitle>{state.businessName}</CardTitle>
          <CardDescription>Online booking isn&apos;t open right now.{text ? ` Text us at ${text} and we'll find you a time.` : ' Please contact us directly.'}</CardDescription>
        </CardHeader>
      </Shell>
    )
  }

  const kind = state.bookingKind

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!picked) return
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/public/book/${encodeURIComponent(slug)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start: picked.start, name, phone, address, note, website }),
      })
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; when?: string; error?: string; code?: string }
      if (!res.ok || !data.ok) {
        setError(data.error ?? 'Something went wrong. Try again.')
        if (data.code === 'SLOT_TAKEN') setPicked(null)
        setBusy(false)
        return
      }
      setDone(data.when ?? picked.label)
    } catch {
      setError('Something went wrong. Try again.')
    }
    setBusy(false)
  }

  if (done) {
    return (
      <Shell>
        <CardHeader>
          <CardTitle>Requested: {done}</CardTitle>
          <CardDescription data-booking-done>
            If {state.businessName} can do it, they&apos;ll text you at {formatE164ForDisplay(phone.startsWith('+') ? phone : `+1${phone.replace(/\D/g, '').slice(-10)}`)} to confirm your {kind}. Nothing is booked until then.
          </CardDescription>
        </CardHeader>
      </Shell>
    )
  }

  return (
    <Shell>
      <CardHeader>
        <p className="text-sm font-medium text-muted-foreground">{state.businessName}</p>
        <CardTitle className="text-2xl">Book a {kind}</CardTitle>
        <CardDescription>Pick a time that works for you. We&apos;ll text you once it&apos;s confirmed.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {days.length === 0 ? (
          <div className="rounded-lg border px-4 py-3 text-sm text-muted-foreground" data-booking-empty>
            No times are open in the next two weeks.{text ? ` Text us at ${text} and we'll find one.` : ''}
          </div>
        ) : (
          <div className="space-y-4" data-booking-slots>
            {days.map((d) => (
              <div key={d.day}>
                <p className="mb-2 text-sm font-medium">{d.day}</p>
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
        )}

        {picked && (
          <form onSubmit={submit} className="space-y-4 border-t pt-6" data-booking-form>
            <p className="text-sm">
              {capitalized(kind)} on <strong>{picked.label}</strong>
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="booking-name">Name</Label>
              <Input id="booking-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required maxLength={120} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="booking-phone">Mobile number</Label>
              <Input id="booking-phone" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" inputMode="tel" required placeholder="(555) 555-5555" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="booking-address">{capitalized(kind)} address</Label>
              <Input id="booking-address" value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="street-address" maxLength={300} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="booking-note">Anything we should know? (optional)</Label>
              <Textarea id="booking-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={1000} />
            </div>
            {/* A field people never see: bots fill it. */}
            <input type="text" name="website" value={website} onChange={(e) => setWebsite(e.target.value)} tabIndex={-1} autoComplete="off" aria-hidden="true" className="hidden" />
            {error && (
              <SchedulingNotice data-booking-error="">{error}</SchedulingNotice>
            )}
            <Button type="submit" className="w-full" disabled={busy || !name.trim() || !phone.trim()}>
              {busy ? 'Sending…' : `Request ${picked.time}`}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              By requesting, you agree to get texts about this booking from {state.businessName}. Msg &amp; data rates may apply. Reply STOP to opt out.
            </p>
          </form>
        )}
      </CardContent>
    </Shell>
  )
}

