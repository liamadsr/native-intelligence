'use client'

/**
 * The booking link cards (availability phase 4b): the link
 * create_booking_link made or update_booking_link changed, with its address
 * to copy, its length and hosts, and whether it's on; list_booking_links'
 * links. The time-offer cards' frame (./time-offer-card.tsx). The address
 * copies; nothing here changes a link. Never animated.
 */
import { memo } from 'react'
import { cn } from '@/lib/utils'
import { linkCardLine, type BookingLinkCardData, type LinkCardItem } from '@/lib/booking-links/link-card'
import { CopyButton } from './time-offer-card'

const FRAME = 'w-fit max-w-full self-start rounded-xl border border-border/60 bg-background px-3 py-2'
const HEADING = 'mb-1.5 text-[11px] font-medium text-muted-foreground'

function OnOff({ active }: { active: boolean }) {
  return (
    <span data-booking-link-state={active ? 'on' : 'off'} className={cn('shrink-0 rounded px-1.5 py-px text-[10px] font-medium', active ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'bg-muted text-muted-foreground')}>
      {active ? 'On' : 'Off'}
    </span>
  )
}

function Address({ url }: { url: string }) {
  return (
    <div className="mt-1 flex min-w-0 items-center gap-1 rounded-md bg-muted/60 py-0.5 pl-2 pr-0.5">
      <a href={url} target="_blank" rel="noreferrer" className="min-w-0 truncate font-mono text-[11px] text-foreground/80 hover:underline" data-booking-link-url="">
        {url.replace(/^https?:\/\//, '')}
      </a>
      <CopyButton value={url} label="Copy link" data-booking-link-copy="" />
    </div>
  )
}

const HEADINGS = { made: 'Booking link made', changed: 'Booking link changed', off: 'Booking link turned off' } as const

function LinkCard({ verb, link }: { verb: keyof typeof HEADINGS; link: LinkCardItem }) {
  return (
    <div data-booking-link-card="link" className={FRAME}>
      <p className={HEADING}>{HEADINGS[verb]}</p>
      <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
        <span className="truncate">{link.title}</span>
        <OnOff active={link.active} />
      </p>
      <p className="text-xs text-muted-foreground">
        {linkCardLine(link)}
        {link.askFirst ? ' · asks you first' : ''}
      </p>
      {link.url && link.active && <Address url={link.url} />}
      {!link.active && <p className="mt-1.5 text-[11px] text-muted-foreground">Its page takes no bookings; the meetings it booked stay.</p>}
    </div>
  )
}

function ListCard({ links }: { links: LinkCardItem[] }) {
  return (
    <div data-booking-link-card="list" className={FRAME}>
      <p className={HEADING}>Booking links</p>
      <ul className="space-y-2" data-booking-links="">
        {links.map((link) => (
          <li key={link.id} className="min-w-0 text-xs">
            <p className="flex items-center gap-1.5">
              <span className={cn('truncate font-medium', link.active ? 'text-foreground' : 'text-muted-foreground')}>{link.title}</span>
              <OnOff active={link.active} />
            </p>
            <p className="text-muted-foreground">{linkCardLine(link)}</p>
            {link.url && link.active && <Address url={link.url} />}
          </li>
        ))}
      </ul>
    </div>
  )
}

function BookingLinkCardImpl({ data }: { data: BookingLinkCardData }) {
  if (data.kind === 'links') return <ListCard links={data.links} />
  return <LinkCard verb={data.verb} link={data.link} />
}

export const BookingLinkCard = memo(BookingLinkCardImpl)
