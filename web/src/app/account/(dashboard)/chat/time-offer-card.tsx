'use client'

/**
 * The time-offer cards (availability phase 3b): what offer_times held and
 * for whom, with its link to copy; the meeting accept_time_offer booked; and
 * list_time_offers' offers and bookings. The find_times card's frame
 * (./find-times-card.tsx): a small bordered box under the reply, one line per
 * item. The link and the paste text copy; nothing here sends or books.
 * Never animated, so a stored reply costs nothing to draw again.
 */
import { memo, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { BookedCardData, OfferCardData, OfferListCardData, TimeOfferCardData } from '@/lib/time-offers/offer-card'
import type { MeetingBookingState, OfferState } from '@/lib/time-offers/types'

const FRAME = 'w-fit max-w-full self-start rounded-xl border border-border/60 bg-background px-3 py-2'
const HEADING = 'mb-1.5 text-[11px] font-medium text-muted-foreground'

function CopyButton({ value, label, ...rest }: { value: string; label: string } & Record<`data-${string}`, string>) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* no clipboard: it's on screen to select */
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      {...rest}
      className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      aria-label={copied ? 'Copied' : label}
    >
      {copied ? <Check aria-hidden className="size-3 text-emerald-600 dark:text-emerald-400" /> : <Copy aria-hidden className="size-3" />}
      {copied ? 'Copied' : label}
    </button>
  )
}

function OfferCard({ data }: { data: OfferCardData }) {
  const length = data.durationMinutes ? ` · ${data.durationMinutes} min` : ''
  const status =
    data.sentVia === 'link'
      ? `Held until they pick one${data.expires ? ` or ${data.expires}` : ''}. Nothing was sent: share the link.`
      : `Sent by ${data.sentVia}${data.to ? ` to ${data.to}` : ''}. Held until they pick one${data.expires ? ` or ${data.expires}` : ''}.`
  return (
    <div data-time-offer-card="offer" className={FRAME}>
      <p className={HEADING}>
        {data.recipient ? `Times offered to ${data.recipient}` : 'Times offered'}
        {length}
      </p>
      {data.title && <p className="mb-1 text-xs font-medium text-foreground">{data.title}</p>}
      <ul data-time-offer-times="" className="space-y-1">
        {data.times.map((label) => (
          <li key={label} className="text-xs text-foreground">
            {label}
          </li>
        ))}
      </ul>
      <div className="mt-2 flex min-w-0 items-center gap-1 rounded-md bg-muted/60 py-0.5 pl-2 pr-0.5">
        <a href={data.link} target="_blank" rel="noreferrer" className="min-w-0 truncate font-mono text-[11px] text-foreground/80 hover:underline" data-time-offer-link="">
          {data.link.replace(/^https?:\/\//, '')}
        </a>
        <CopyButton value={data.link} label="Copy link" data-time-offer-copy="link" />
        {data.pasteText && <CopyButton value={data.pasteText} label="Copy message" data-time-offer-copy="message" />}
      </div>
      <p data-time-offer-status="" className="mt-1.5 text-[11px] text-muted-foreground">
        {status}
      </p>
    </div>
  )
}

function BookedCard({ data }: { data: BookedCardData }) {
  return (
    <div data-time-offer-card="booked" className={FRAME}>
      <p className={HEADING}>{data.already ? `Already booked with ${data.guest}` : `Booked with ${data.guest}`}</p>
      <p className="text-xs font-medium text-foreground">{data.title}</p>
      <p className="text-xs text-foreground">{data.when}</p>
      {data.videoLink && (
        <a href={data.videoLink} target="_blank" rel="noreferrer" className="mt-1 block max-w-full truncate font-mono text-[11px] text-foreground/80 underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground">
          {data.videoLink.replace(/^https?:\/\//, '')}
        </a>
      )}
      {data.state === 'booking' && <p className="mt-1.5 text-[11px] text-muted-foreground">The calendar event is still being written.</p>}
    </div>
  )
}

const OFFER_STATE_LABEL: Record<OfferState, string> = {
  pending_send: 'waiting on your card',
  open: 'waiting for a pick',
  booked: 'booked',
  expired: 'expired',
  withdrawn: 'withdrawn',
  declined: 'not sent',
}

const BOOKING_STATE_LABEL: Record<MeetingBookingState, string> = {
  booking: 'being booked',
  confirmed: 'booked',
  cancelled: 'cancelled',
  failed: "couldn't be booked",
}

const live = (state: OfferState | MeetingBookingState) => state === 'open' || state === 'pending_send' || state === 'confirmed' || state === 'booking'

function ListCard({ data }: { data: OfferListCardData }) {
  return (
    <div data-time-offer-card="list" className={FRAME}>
      {data.offers.length > 0 && (
        <>
          <p className={HEADING}>Time offers</p>
          <ul data-time-offer-offers="" className="space-y-1.5">
            {data.offers.map((o) => (
              <li key={o.id} data-state={o.state} className="text-xs">
                <span className="text-foreground">
                  {o.recipient} · {o.title}
                </span>
                <span className={cn(live(o.state) ? 'text-foreground/80' : 'text-muted-foreground')}> · {OFFER_STATE_LABEL[o.state]}</span>
                {o.state === 'open' && o.times.length > 0 && <span className="block text-muted-foreground">{o.times.map((t) => t.label).join('; ')}</span>}
                {o.state === 'booked' && o.times.some((t) => t.booked) && <span className="block text-muted-foreground">{o.times.find((t) => t.booked)!.label}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {data.bookings.length > 0 && (
        <>
          <p className={cn(HEADING, data.offers.length > 0 && 'mt-2 border-t border-border/50 pt-2')}>Meetings booked from offers</p>
          <ul data-time-offer-bookings="" className="space-y-1">
            {data.bookings.map((b) => (
              <li key={b.id} data-state={b.state} className="text-xs">
                <span className={b.state === 'cancelled' || b.state === 'failed' ? 'text-muted-foreground' : 'text-foreground'}>
                  {b.guest} · {b.when}
                </span>
                <span className="text-muted-foreground"> · {BOOKING_STATE_LABEL[b.state]}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function TimeOfferCardImpl({ data }: { data: TimeOfferCardData }) {
  if (data.kind === 'offer') return <OfferCard data={data} />
  if (data.kind === 'booked') return <BookedCard data={data} />
  return <ListCard data={data} />
}

export const TimeOfferCard = memo(TimeOfferCardImpl)
