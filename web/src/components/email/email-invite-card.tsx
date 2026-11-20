'use client'

/**
 * A calendar invitation, as a card above the message it came in: what it is,
 * when, where, who is invited (the organizer marked), and the person's answer.
 *
 * What it is wired to today:
 *  - the invitation itself (src/lib/email/calendar-invite.ts), read from the
 *    message;
 *  - the person's connected calendars (GET /api/calendar/events, read-only):
 *    when the event is on one, the card shows the answer the calendar holds
 *    and links to the event there.
 *
 * What it is NOT wired to: answering. No provider call for an RSVP exists
 * yet, so Yes / No / Maybe open the event in the person's calendar, where the
 * answer is given, and the card says so. Nothing here writes anywhere.
 *
 * Every value from the invitation is rendered as text (React escapes it); the
 * only links are the call link the parser accepted (http/https) and the
 * calendar's own link, both opened as any external link is.
 */
import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, Check, ExternalLink, HelpCircle, MapPin, Users, Video, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isOpenableUrl, openExternalUrl } from '@/lib/open-external'
import type { CalendarInvite, InviteAttendee, InviteResponse } from '@/lib/email/calendar-invite'

/** Guests named before "View all guest info". */
const GUESTS_SHOWN = 3

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

function toDate(value: string): Date {
  // A date-only value is a calendar day, not midnight UTC.
  if (DATE_ONLY.test(value)) {
    const [y, m, d] = value.split('-').map(Number)
    return new Date(y, m - 1, d)
  }
  return new Date(value)
}

/** "Thu, Nov 26, 2026 · 2:00 – 2:45 PM", "Tue, Dec 1 – Thu, Dec 3, 2026 · All day". Pure. */
export function inviteWhen(invite: Pick<CalendarInvite, 'start' | 'end' | 'allDay'>, locale = 'en-US'): string {
  const start = toDate(invite.start)
  if (Number.isNaN(start.getTime())) return ''
  const end = invite.end ? toDate(invite.end) : null
  const day = (d: Date, year = true) => d.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}) })
  const time = (d: Date) => d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
  if (invite.allDay) {
    return end && end.getTime() !== start.getTime() ? `${day(start, start.getFullYear() !== end.getFullYear())} – ${day(end)} · All day` : `${day(start)} · All day`
  }
  if (!end || Number.isNaN(end.getTime())) return `${day(start)} · ${time(start)}`
  if (start.toDateString() !== end.toDateString()) return `${day(start)} ${time(start)} – ${day(end)} ${time(end)}`
  const samePeriod = start.getHours() < 12 === end.getHours() < 12
  const from = samePeriod ? time(start).replace(/\s?[AP]M$/i, '') : time(start)
  return `${day(start)} · ${from} – ${time(end)}`
}

const RESPONSE_WORD: Record<InviteResponse, string> = { accepted: 'Yes', declined: 'No', tentative: 'Maybe', pending: 'Not answered' }

/** The calendar's word for the owner's answer → the card's (Google's and Microsoft's). */
function calendarResponse(value: unknown): InviteResponse | null {
  switch (value) {
    case 'accepted':
    case 'organizer':
      return 'accepted'
    case 'declined':
      return 'declined'
    case 'tentative':
    case 'tentativelyAccepted':
      return 'tentative'
    case 'needsAction':
    case 'notResponded':
      return 'pending'
    default:
      return null
  }
}

interface CalendarMatch {
  response: InviteResponse | null
  link: string | null
}

/** Find the invitation's event on the person's connected calendars (by its iCalendar UID). Null: not there, or no calendar. */
async function findOnCalendar(invite: CalendarInvite, signal: AbortSignal): Promise<CalendarMatch | null> {
  if (!invite.uid) return null
  const start = toDate(invite.start)
  if (Number.isNaN(start.getTime())) return null
  const params = new URLSearchParams({
    timeMin: new Date(start.getTime() - 24 * 3600 * 1000).toISOString(),
    timeMax: new Date(start.getTime() + 48 * 3600 * 1000).toISOString(),
    maxResults: '250',
  })
  const res = await fetch(`/api/calendar/events?${params}`, { signal })
  if (!res.ok) return null
  const data = (await res.json()) as { events?: Array<{ icalUid?: string; myResponse?: string; htmlLink?: string }> }
  const hit = (data.events ?? []).find((e) => e.icalUid === invite.uid)
  if (!hit) return null
  return { response: calendarResponse(hit.myResponse), link: hit.htmlLink && isOpenableUrl(hit.htmlLink) ? hit.htmlLink : null }
}

function guestName(guest: { name: string | null; email: string }): string {
  return guest.name || guest.email
}

export function EmailInviteCard({
  invite,
  ownAddresses,
  lookup = findOnCalendar,
}: {
  invite: CalendarInvite
  /** The person's own addresses (lowercase): which guest they are. */
  ownAddresses?: ReadonlySet<string>
  /** How the event is looked up on the person's calendars (tests pass their own). */
  lookup?: (invite: CalendarInvite, signal: AbortSignal) => Promise<CalendarMatch | null>
}) {
  const [allGuests, setAllGuests] = useState(false)
  const [match, setMatch] = useState<CalendarMatch | null | 'loading'>('loading')

  useEffect(() => {
    const controller = new AbortController()
    setMatch('loading')
    lookup(invite, controller.signal)
      .then((found) => {
        if (!controller.signal.aborted) setMatch(found)
      })
      .catch(() => {
        if (!controller.signal.aborted) setMatch(null)
      })
    return () => controller.abort()
  }, [invite, lookup])

  // The guests, organizer first.
  const guests = useMemo(() => {
    const organizerEmail = invite.organizer?.email
    const list: Array<InviteAttendee & { organizer: boolean }> = invite.attendees.map((a) => ({ ...a, organizer: a.email === organizerEmail }))
    if (invite.organizer && !list.some((g) => g.organizer)) list.unshift({ ...invite.organizer, status: 'accepted', organizer: true })
    return list.sort((a, b) => Number(b.organizer) - Number(a.organizer))
  }, [invite])

  const me = guests.find((g) => ownAddresses?.has(g.email)) ?? null
  const found = match !== 'loading' && match ? match : null
  const myAnswer: InviteResponse | null = found?.response ?? me?.status ?? null
  const cancelled = invite.method === 'CANCEL'
  const eyebrow = cancelled ? 'Cancelled' : invite.method === 'REPLY' ? 'Reply to your invitation' : invite.updated ? 'Updated invitation' : 'Invitation'
  const canAnswer = !cancelled && invite.method !== 'REPLY' && !me?.organizer
  const open = (url: string | null) => {
    if (url) void openExternalUrl(url)
  }

  const answers: Array<{ value: InviteResponse; label: string; icon: typeof Check }> = [
    { value: 'accepted', label: 'Yes', icon: Check },
    { value: 'declined', label: 'No', icon: X },
    { value: 'tentative', label: 'Maybe', icon: HelpCircle },
  ]

  return (
    <section
      data-email-invite=""
      aria-label={`${eyebrow}: ${invite.title}`}
      className="mb-3 max-w-xl overflow-hidden rounded-xl border border-border/70 bg-muted/20 text-sm"
    >
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500">
          <CalendarDays className="h-4.5 w-4.5" />
        </div>
        <div className="min-w-0">
          <p className={cn('text-[11px] font-medium uppercase tracking-wide', cancelled ? 'text-red-500' : 'text-muted-foreground')}>{eyebrow}</p>
          <h3 className={cn('select-text truncate text-base font-semibold leading-snug', cancelled && 'line-through')}>{invite.title}</h3>
        </div>
      </div>

      <dl className="space-y-2 px-4 py-3">
        <div className="flex gap-3">
          <dt className="w-14 shrink-0 text-xs font-medium text-muted-foreground">When</dt>
          <dd className="select-text">{inviteWhen(invite)}</dd>
        </div>

        {(invite.location || invite.conferenceUrl) && (
          <div className="flex gap-3">
            <dt className="w-14 shrink-0 text-xs font-medium text-muted-foreground">Where</dt>
            <dd className="min-w-0 space-y-1">
              {invite.location && (
                <p className="flex select-text items-start gap-1.5">
                  <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 break-words">{invite.location}</span>
                </p>
              )}
              {invite.conferenceUrl && (
                <button type="button" onClick={() => open(invite.conferenceUrl)} className="flex items-center gap-1.5 text-blue-500 hover:underline">
                  <Video className="h-3.5 w-3.5 shrink-0" />
                  Join the call
                </button>
              )}
            </dd>
          </div>
        )}

        {guests.length > 0 && (
          <div className="flex gap-3">
            <dt className="w-14 shrink-0 text-xs font-medium text-muted-foreground">Guests</dt>
            <dd className="min-w-0 flex-1">
              {!allGuests ? (
                <p className="flex select-text items-start gap-1.5">
                  <Users className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    {guests.slice(0, GUESTS_SHOWN).map((g, i) => (
                      <span key={g.email}>
                        {i > 0 && ', '}
                        {guestName(g)}
                        {g.organizer && <span className="text-muted-foreground"> (organizer)</span>}
                      </span>
                    ))}
                    {guests.length + invite.attendeesOmitted > GUESTS_SHOWN && (
                      <span className="text-muted-foreground"> +{guests.length + invite.attendeesOmitted - GUESTS_SHOWN} more</span>
                    )}
                  </span>
                </p>
              ) : (
                <ul className="space-y-1" data-invite-guests="">
                  {guests.map((g) => (
                    <li key={g.email} className="flex select-text items-baseline justify-between gap-3">
                      <span className="min-w-0 truncate">
                        {guestName(g)}
                        {g.name && <span className="text-muted-foreground"> · {g.email}</span>}
                        {g.organizer && <span className="text-muted-foreground"> (organizer)</span>}
                        {g.optional && <span className="text-muted-foreground"> (optional)</span>}
                      </span>
                      <span
                        className={cn(
                          'shrink-0 text-xs',
                          g.status === 'accepted' ? 'text-emerald-600 dark:text-emerald-400' : g.status === 'declined' ? 'text-red-500' : 'text-muted-foreground',
                        )}
                      >
                        {g.organizer ? 'Organizer' : RESPONSE_WORD[g.status]}
                      </span>
                    </li>
                  ))}
                  {invite.attendeesOmitted > 0 && <li className="text-xs text-muted-foreground">and {invite.attendeesOmitted} more</li>}
                </ul>
              )}
              <button type="button" onClick={() => setAllGuests((v) => !v)} className="mt-1 text-xs text-blue-500 hover:underline" aria-expanded={allGuests}>
                {allGuests ? 'Hide guest info' : 'View all guest info'}
              </button>
            </dd>
          </div>
        )}
      </dl>

      {canAnswer && (
        <div className="border-t border-border/60 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-1 text-xs text-muted-foreground">Reply{me ? <> for <span className="select-text text-foreground">{me.email}</span></> : null}</span>
            <div className="inline-flex overflow-hidden rounded-lg border border-border/70" role="group" aria-label="Your answer">
              {answers.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  data-invite-answer={value}
                  aria-pressed={myAnswer === value}
                  disabled={!found?.link}
                  onClick={() => open(found?.link ?? null)}
                  title={found?.link ? `Answer "${label}" in your calendar` : undefined}
                  className={cn(
                    'flex items-center gap-1 border-l border-border/70 px-3 py-1.5 text-xs font-medium transition-colors first:border-l-0',
                    myAnswer === value ? 'bg-foreground text-background' : 'hover:bg-muted',
                    'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              ))}
            </div>
            <button
              type="button"
              data-invite-more=""
              disabled={!found?.link}
              onClick={() => open(found?.link ?? null)}
              className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              More options
              <ExternalLink className="h-3 w-3" />
            </button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground" data-invite-note="">
            {match === 'loading'
              ? 'Looking for this event on your calendar…'
              : found?.link
                ? 'Answering opens the event in your calendar. Replying from here is not connected yet.'
                : found
                  ? 'This event is on your calendar. Answer it there: replying from here is not connected yet.'
                  : 'This event is not on a connected calendar, so it can’t be answered from here yet.'}
          </p>
        </div>
      )}
    </section>
  )
}
