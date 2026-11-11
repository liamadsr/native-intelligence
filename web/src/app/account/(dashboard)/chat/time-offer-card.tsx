'use client'

/**
 * The time-offer cards (availability phase 3b): what offer_times held and
 * for whom, with its link to copy; the meeting accept_time_offer booked; and
 * list_time_offers' offers and bookings. The find_times card's frame
 * (./find-times-card.tsx): a small bordered box under the reply, one line per
 * item. The link and the paste text copy; nothing here sends or books.
 * A poll (phase 5: offer_times to several guests) is a small grid, guests by
 * times: works, doesn't, still waiting (answered from their calendar
 * marked), each guest's own link to copy, and the booked meeting or the time
 * most can make.
 * Never animated, so a stored reply costs nothing to draw again.
 */
import { memo, useState } from 'react'
import { CalendarCheck, Check, Copy, X } from 'lucide-react'
import { copyTextToClipboard } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import type { BookedCardData, OfferCardData, OfferListCardData, PollCardData, TimeOfferCardData } from '@/lib/time-offers/offer-card'
import type { MeetingBookingState, OfferState } from '@/lib/time-offers/types'

const FRAME = 'w-fit max-w-full self-start rounded-xl border border-border/60 bg-background px-3 py-2'
const HEADING = 'mb-1.5 text-[11px] font-medium text-muted-foreground'

/** `iconOnly`: the label is the button's name, not its text (a grid's row). */
export function CopyButton({ value, label, iconOnly, ...rest }: { value: string; label: string; iconOnly?: boolean } & Record<`data-${string}`, string>) {
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null)
  const copy = async () => {
    // A webview without the clipboard falls back to the old copy; one that refuses both says so (the text is on screen to select).
    setCopied((await copyTextToClipboard(value)) ? 'yes' : 'no')
    setTimeout(() => setCopied(null), 1500)
  }
  return (
    <button
      type="button"
      onClick={copy}
      {...rest}
      className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      aria-label={copied === 'yes' ? 'Copied' : copied === 'no' ? "Couldn't copy" : label}
    >
      {copied === 'yes' ? <Check aria-hidden className="size-3 text-emerald-600 dark:text-emerald-400" /> : <Copy aria-hidden className="size-3" />}
      {iconOnly ? null : copied === 'yes' ? 'Copied' : copied === 'no' ? "Couldn't copy" : label}
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

/** The zone a time's label ends in ("EST" of "Tue, Nov 17, 10:00 AM EST"), or null. Pure. */
function zoneOfLabel(label: string | undefined): string | null {
  const m = label ? /\d\s?(?:AM|PM)\s+([A-Z][A-Za-z0-9+:-]*)$/.exec(label) : null
  return m ? m[1] : null
}

/** "Tue, Nov 17, 10:00 AM EST" as a column head: the day over the clock, no zone. Pure. */
function columnHead(label: string): { day: string; time: string } {
  const cut = label.lastIndexOf(', ')
  if (cut < 0) return { day: label, time: '' }
  return { day: label.slice(0, cut), time: label.slice(cut + 2).replace(/\s+[A-Z][A-Za-z0-9+:-]*$/, '') }
}

/** The poll's state in one line: booked, stuck, or how many are still to answer. */
function pollStatus(data: PollCardData): string {
  const booked = data.times.find((t) => t.booked)
  if (data.state === 'booked') return `Booked: ${data.booking?.when ?? booked?.label ?? 'see the list of offers'}.`
  if (data.state === 'expired') return 'Expired: nothing was booked.'
  if (data.state === 'withdrawn' || data.state === 'declined') return 'Withdrawn.'
  if (data.state === 'pending_send') return 'Waiting on your card.'
  if (data.best) return `No time works for everyone. Most can make ${data.best}.`
  const waiting = data.guests.filter((g) => !g.answered).length
  const held = data.expires ? ` Held until everyone answers or ${data.expires}.` : ''
  const share = data.sentVia === 'link' ? " Nothing was sent: share each guest's link." : ''
  return `${waiting ? `${waiting} of ${data.guests.length} still to answer.` : 'Everyone answered.'}${held}${share}`
}

/** A poll's grid: each guest by each time (see the header). */
function PollGrid({ data }: { data: PollCardData }) {
  const open = data.state === 'open'
  return (
    <div data-time-offer-grid="" className="min-w-0">
      <div className="max-w-full overflow-x-auto">
        <table className="border-separate border-spacing-0 text-[11px]">
          <thead>
            <tr>
              <th className="sr-only">Guest</th>
              {data.times.map((t) => {
                const head = columnHead(t.label)
                return (
                  <th
                    key={t.start}
                    scope="col"
                    data-booked={t.booked ? '' : undefined}
                    className={cn('px-1.5 pb-1 text-center font-normal leading-tight text-muted-foreground', t.booked && 'rounded-t-md bg-emerald-50 font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300')}
                  >
                    <span className="block whitespace-nowrap">{head.day}</span>
                    <span className="block whitespace-nowrap tabular-nums">{head.time}</span>
                  </th>
                )
              })}
              <th className="sr-only">Link</th>
            </tr>
          </thead>
          <tbody>
            {data.guests.map((g) => (
              <tr key={g.id} data-guest={g.name}>
                <th scope="row" className={cn('max-w-[9rem] truncate py-0.5 pr-2 text-left font-normal text-foreground', g.attending === false && 'text-muted-foreground line-through decoration-muted-foreground/50')}>
                  <span className="inline-flex items-center gap-1">
                    {g.name}
                    {g.fromCalendar && <CalendarCheck aria-label="Answered from their calendar" className="size-3 shrink-0 text-muted-foreground" data-from-calendar="" />}
                  </span>
                </th>
                {data.times.map((t) => {
                  const mark = !g.answered ? 'waiting' : g.works.includes(t.start) ? 'works' : 'no'
                  return (
                    <td key={t.start} data-mark={mark} className={cn('px-1.5 py-0.5 text-center', t.booked && 'bg-emerald-50 dark:bg-emerald-900/30')}>
                      {mark === 'works' ? (
                        <Check aria-label="Works" className="mx-auto size-3.5 text-emerald-600 dark:text-emerald-400" />
                      ) : mark === 'no' ? (
                        <X aria-label="Doesn't work" className="mx-auto size-3.5 text-red-500/80 dark:text-red-400/80" />
                      ) : (
                        <span aria-label="Waiting" className="text-muted-foreground/60">
                          ·
                        </span>
                      )}
                    </td>
                  )
                })}
                <td className="py-0.5 pl-1">{open && g.link && <CopyButton value={g.link} label={`Copy ${g.name}'s link`} iconOnly data-time-offer-copy={`guest:${g.id}`} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.booking?.videoLink && (
        <a href={data.booking.videoLink} target="_blank" rel="noreferrer" className="mt-1 block max-w-full truncate font-mono text-[11px] text-foreground/80 underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground">
          {data.booking.videoLink.replace(/^https?:\/\//, '')}
        </a>
      )}
      <p data-time-offer-status="" className="mt-1.5 text-[11px] text-muted-foreground">
        {pollStatus(data)}
      </p>
    </div>
  )
}

function PollCard({ data }: { data: PollCardData }) {
  const length = data.durationMinutes ? ` · ${data.durationMinutes} min` : ''
  const hosts = data.coHosts ? ` · with ${data.coHosts === 1 ? 'a teammate' : `${data.coHosts} teammates`}` : ''
  // The grid's heads drop the zone, so the heading says it once.
  const zone = zoneOfLabel(data.times[0]?.label)
  return (
    <div data-time-offer-card="poll" className={FRAME}>
      <p className={HEADING}>
        Times asked of {data.guests.length} {data.guests.length === 1 ? 'person' : 'people'}
        {length}
        {hosts}
        {zone && <span data-time-offer-zone="">{` · ${zone}`}</span>}
      </p>
      {data.title && <p className="mb-1.5 text-xs font-medium text-foreground">{data.title}</p>}
      <PollGrid data={data} />
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
  requested: 'waiting on your yes',
  booking: 'being booked',
  confirmed: 'booked',
  declined: 'declined',
  expired: 'expired',
  cancelled: 'cancelled',
  failed: "couldn't be booked",
}

const live = (state: OfferState | MeetingBookingState) => state === 'open' || state === 'pending_send' || state === 'confirmed' || state === 'booking' || state === 'requested'

/** Where the meetings came from: offers, booking links, or both. */
function bookingsHeading(bookings: OfferListCardData['bookings']): string {
  const fromLinks = bookings.filter((b) => b.fromLink).length
  if (!fromLinks) return 'Meetings booked from offers'
  return fromLinks === bookings.length ? 'Meetings booked from your links' : 'Meetings booked'
}

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
                {!o.poll && <span className={cn(live(o.state) ? 'text-foreground/80' : 'text-muted-foreground')}> · {OFFER_STATE_LABEL[o.state]}</span>}
                {o.poll ? (
                  <div className="mt-1">
                    <PollGrid data={o.poll} />
                  </div>
                ) : (
                  <>
                    {o.state === 'open' && o.times.length > 0 && <span className="block text-muted-foreground">{o.times.map((t) => t.label).join('; ')}</span>}
                    {o.state === 'booked' && o.times.some((t) => t.booked) && <span className="block text-muted-foreground">{o.times.find((t) => t.booked)!.label}</span>}
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {data.bookings.length > 0 && (
        <>
          <p className={cn(HEADING, data.offers.length > 0 && 'mt-2 border-t border-border/50 pt-2')}>{bookingsHeading(data.bookings)}</p>
          <ul data-time-offer-bookings="" className="space-y-1">
            {data.bookings.map((b) => (
              <li key={b.id} data-state={b.state} className="text-xs">
                <span className={b.state === 'cancelled' || b.state === 'failed' ? 'text-muted-foreground' : 'text-foreground'}>
                  {b.guest} · {b.when}
                </span>
                {b.fromLink && b.title && <span className="text-muted-foreground"> · {b.title}</span>}
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
  if (data.kind === 'poll') return <PollCard data={data} />
  if (data.kind === 'booked') return <BookedCard data={data} />
  return <ListCard data={data} />
}

export const TimeOfferCard = memo(TimeOfferCardImpl)
