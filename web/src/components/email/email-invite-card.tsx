'use client'

/**
 * A calendar invitation, as a card above the message it came in: what it is,
 * when, where, who is invited (the organizer marked), and the person's answer.
 *
 * What it is wired to:
 *  - the invitation itself (src/lib/email/calendar-invite.ts), read from the
 *    message or from an attached .ics;
 *  - the person's connected calendars, through /api/calendar/rsvp
 *    (src/lib/integrations/calendar-rsvp.ts): GET finds the invitation's
 *    event by its iCalendar UID and gives the answer the calendar holds; POST
 *    answers it as the person (Google and Microsoft, with the scopes the app
 *    already has), and the organizer is told by the calendar itself.
 *
 * Yes / No / Maybe answer the invitation. The card shows the answer the
 * calendar holds, marks the one being sent, and keeps the old answer when a
 * reply fails, saying why (the event gone, the calendar needing a new
 * sign-in, the event on no connected calendar) with the calendar's own page
 * as the way out when there is one. "More options" opens the event there.
 *
 * A repeating event offers "All events" (the default) or "This event", its
 * next occurrence. An invitation declined from here stays "You declined"
 * after a reload even though Outlook has taken the event off the calendar
 * (invite-answer-memory.ts: this browser remembers the answer it sent).
 *
 * Every value from the invitation is rendered as text (React escapes it); the
 * only links are the call link the parser accepted (http/https) and the
 * calendar's own link, both opened as any external link is.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarDays, Check, ExternalLink, HelpCircle, Loader2, MapPin, Users, Video, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isOpenableUrl, openExternalUrl } from '@/lib/open-external'
import type { CalendarInvite, InviteAttendee, InviteResponse } from '@/lib/email/calendar-invite'
import { recallInviteAnswer, rememberInviteAnswer } from './invite-answer-memory'

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

/** "Thu, Dec 3": the day of an occurrence (an instant, or a date for an all-day one). Pure. */
export function inviteDay(value: string, locale = 'en-US'): string | null {
  const day = toDate(value)
  return Number.isNaN(day.getTime()) ? null : day.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' })
}

const RESPONSE_WORD: Record<InviteResponse, string> = { accepted: 'Yes', declined: 'No', tentative: 'Maybe', pending: 'Not answered' }

type Answer = Exclude<InviteResponse, 'pending'>
/** What an answer is for: every event of a repeating one (and any single event), or its next occurrence alone. */
export type AnswerWhich = 'series' | 'occurrence'

/** What the calendar says about the invitation's event (GET /api/calendar/rsvp). */
export interface InviteCalendarStatus {
  found: boolean
  /** found: the answer the calendar holds (null: the person is not a guest there). */
  response?: InviteResponse | null
  link?: string | null
  canAnswer?: boolean
  blocked?: 'organizer' | 'not_invited' | 'cancelled'
  provider?: 'google' | 'microsoft'
  /** The event repeats; `nextOccurrence` (an instant, or a date) when that one can be answered on its own. */
  recurring?: boolean
  nextOccurrence?: string
  accountEmail?: string | null
  /** not found: why. */
  reason?: 'no_calendar' | 'reconnect' | 'unreadable' | 'not_found'
}

/** A reply that wasn't given: the words to show, and the route's code. */
export class InviteReplyError extends Error {
  constructor(message: string, public readonly code: string | null = null) {
    super(message)
  }
}

const NOT_FOUND: InviteCalendarStatus = { found: false, reason: 'not_found' }

function cleanStatus(data: InviteCalendarStatus): InviteCalendarStatus {
  return { ...data, link: data.link && isOpenableUrl(data.link) ? data.link : null }
}

/** Find the invitation's event on the person's connected calendars (by its iCalendar UID). */
async function findOnCalendar(invite: CalendarInvite, signal: AbortSignal): Promise<InviteCalendarStatus> {
  if (!invite.uid) return NOT_FOUND
  const res = await fetch(`/api/calendar/rsvp?uid=${encodeURIComponent(invite.uid)}`, { signal })
  if (!res.ok) return { found: false, reason: 'unreadable' }
  return cleanStatus((await res.json()) as InviteCalendarStatus)
}

/** Answer the invitation as the person. Throws InviteReplyError with the route's words when it wasn't given. */
async function answerOnCalendar(invite: CalendarInvite, response: Answer, which: AnswerWhich = 'series'): Promise<InviteCalendarStatus> {
  let res: Response
  try {
    res = await fetch('/api/calendar/rsvp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: invite.uid, response, ...(which === 'occurrence' ? { which } : {}) }),
    })
  } catch {
    throw new InviteReplyError('Your answer didn’t reach us. Check your connection and try again.')
  }
  const data = (await res.json().catch(() => null)) as (InviteCalendarStatus & { error?: string; code?: string }) | null
  if (!res.ok || !data) throw new InviteReplyError(data?.error || 'Your answer wasn’t sent. Try again in a moment.', data?.code ?? null)
  return cleanStatus(data)
}

const ANSWER_WORD: Record<Answer, string> = { accepted: 'Yes', declined: 'No', tentative: 'Maybe' }

/** The line under the buttons: what the calendar says, or what just happened. Pure. */
export function inviteNote(args: {
  status: InviteCalendarStatus | 'loading'
  sending: Answer | null
  sent: Answer | null
  error: string | null
  organizer: string | null
  /** The answer this browser last sent for the invitation, when the calendar no longer holds the event. */
  remembered?: Answer | null
  /** A reply just given was for one occurrence: its day, as the card says it. */
  sentFor?: string | null
}): string {
  const { status, sending, sent, error, organizer, remembered, sentFor } = args
  if (error) return error
  if (status === 'loading') return 'Looking for this event on your calendar…'
  if (sending) return `Sending “${ANSWER_WORD[sending]}”…`
  if (!status.found) {
    // Declined, and the calendar took the event away (Outlook does): it was answered, not lost.
    if (remembered === 'declined' && (status.reason === 'not_found' || status.reason === undefined)) {
      return 'You declined this invitation, so it is no longer on your calendar. To come after all, ask the organizer to invite you again.'
    }
    switch (status.reason) {
      case 'no_calendar':
        return 'No calendar is connected to this workspace, so this can’t be answered from here. Connect one in Settings › Connectors.'
      case 'reconnect':
        return `Your calendar${status.accountEmail ? ` (${status.accountEmail})` : ''} needs signing in again before this can be answered. Reconnect it in Settings › Connectors.`
      case 'unreadable':
        return 'Your calendar couldn’t be read just now, so this can’t be answered yet. Open the message again in a moment.'
      default:
        return 'This event is not on a connected calendar, so it can’t be answered from here.'
    }
  }
  if (status.blocked === 'cancelled') return 'This event was cancelled on your calendar.'
  if (status.blocked === 'organizer') return 'You organize this event, so there is no invitation to answer.'
  if (status.blocked === 'not_invited') return 'This event is on your calendar, but you are not on its guest list, so it can’t be answered from here.'
  if (sent && sentFor) {
    return `You answered ${ANSWER_WORD[sent]} for ${sentFor} only. ${organizer ? `${organizer} has been told` : 'The organizer has been told'}; the other events keep your earlier answer.`
  }
  if (sent) {
    const told = organizer ? `${organizer} has been told` : 'The organizer has been told'
    return sent === 'declined' && status.provider === 'microsoft'
      ? `You answered No. ${told}, and Outlook has taken the event off your calendar.`
      : `You answered ${ANSWER_WORD[sent]}. ${told}.`
  }
  const where = status.accountEmail ? ` (${status.accountEmail})` : ''
  return status.response && status.response !== 'pending'
    ? `Your calendar${where} has your answer: ${ANSWER_WORD[status.response]}. Choose another to change it.`
    : `Your answer goes to the organizer from your calendar${where}.`
}

function guestName(guest: { name: string | null; email: string }): string {
  return guest.name || guest.email
}

export function EmailInviteCard({
  invite,
  ownAddresses,
  lookup = findOnCalendar,
  reply = answerOnCalendar,
}: {
  invite: CalendarInvite
  /** The person's own addresses (lowercase): which guest they are. */
  ownAddresses?: ReadonlySet<string>
  /** How the event is looked up on the person's calendars (tests pass their own). */
  lookup?: (invite: CalendarInvite, signal: AbortSignal) => Promise<InviteCalendarStatus | null>
  /** How an answer is given (tests pass their own). Rejects with the words to show. */
  reply?: (invite: CalendarInvite, response: Answer, which: AnswerWhich) => Promise<InviteCalendarStatus>
}) {
  const [allGuests, setAllGuests] = useState(false)
  const [status, setStatus] = useState<InviteCalendarStatus | 'loading'>('loading')
  const [sending, setSending] = useState<Answer | null>(null)
  const [sent, setSent] = useState<Answer | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A repeating event: every event (the default), or the next one alone.
  const [which, setWhich] = useState<AnswerWhich>('series')
  const [sentWhich, setSentWhich] = useState<AnswerWhich>('series')
  const [remembered, setRemembered] = useState<Answer | null>(null)
  // One reply at a time, and a reply for another invitation never lands on this one.
  const inviteRef = useRef(invite)
  inviteRef.current = invite

  useEffect(() => {
    const controller = new AbortController()
    setStatus('loading')
    setSending(null)
    setSent(null)
    setError(null)
    setWhich('series')
    setSentWhich('series')
    setRemembered(recallInviteAnswer(invite.uid))
    lookup(invite, controller.signal)
      .then((found) => {
        if (!controller.signal.aborted) setStatus(found ?? NOT_FOUND)
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus({ found: false, reason: 'unreadable' })
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
  const found = status !== 'loading' && status.found ? status : null
  // Gone from the calendar after a "No" (Outlook removes a declined event): what was sent from here, or what the invitation itself says.
  const declinedAway = status !== 'loading' && !status.found && (status.reason === 'not_found' || !status.reason) && (remembered === 'declined' || me?.status === 'declined')
  const myAnswer: InviteResponse | null = found?.response ?? (declinedAway ? 'declined' : null) ?? me?.status ?? null
  const occurrenceDay = found?.recurring && found.nextOccurrence ? inviteDay(found.nextOccurrence) : null
  const forOccurrence = which === 'occurrence' && !!occurrenceDay
  const cancelled = invite.method === 'CANCEL'
  const eyebrow = cancelled ? 'Cancelled' : invite.method === 'REPLY' ? 'Reply to your invitation' : invite.updated ? 'Updated invitation' : 'Invitation'
  const canAnswer = !cancelled && invite.method !== 'REPLY' && !me?.organizer
  const answerable = !!found?.canAnswer && !!invite.uid
  const open = (url: string | null | undefined) => {
    if (url) void openExternalUrl(url)
  }

  const answer = (value: Answer) => {
    // The same answer again does nothing, unless it is for one occurrence (the marked answer is the series').
    if (!answerable || sending || (!forOccurrence && myAnswer === value)) return
    const asked = invite
    const askedWhich: AnswerWhich = forOccurrence ? 'occurrence' : 'series'
    setSending(value)
    setError(null)
    reply(asked, value, askedWhich)
      .then((next) => {
        if (askedWhich === 'series') rememberInviteAnswer(asked.uid, value)
        if (inviteRef.current !== asked) return
        setStatus(next)
        setSent(value)
        setSentWhich(askedWhich)
        if (askedWhich === 'series') setRemembered(value)
      })
      .catch((err: unknown) => {
        if (inviteRef.current !== asked) return
        // The answer the calendar held stays marked: nothing changed.
        setError(err instanceof InviteReplyError || err instanceof Error ? err.message || 'Your answer wasn’t sent.' : 'Your answer wasn’t sent.')
      })
      .finally(() => {
        if (inviteRef.current === asked) setSending(null)
      })
  }

  const answers: Array<{ value: Answer; label: string; icon: typeof Check }> = [
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
                  {guests.map((g) => {
                    // The person's own row follows the calendar (and a reply just given), not the invitation's snapshot.
                    const shown = g === me && myAnswer ? myAnswer : g.status
                    return (
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
                          shown === 'accepted' ? 'text-emerald-600 dark:text-emerald-400' : shown === 'declined' ? 'text-red-500' : 'text-muted-foreground',
                        )}
                      >
                        {g.organizer ? 'Organizer' : RESPONSE_WORD[shown]}
                      </span>
                    </li>
                    )
                  })}
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
          {answerable && occurrenceDay && (
            <div className="mb-2 flex flex-wrap items-center gap-2" data-invite-which="">
              <span className="mr-1 text-xs text-muted-foreground">This repeats. Answer for</span>
              <div className="inline-flex overflow-hidden rounded-lg border border-border/70" role="group" aria-label="Which events your answer is for">
                {(
                  [
                    { value: 'series', label: 'All events' },
                    { value: 'occurrence', label: `This event · ${occurrenceDay}` },
                  ] as const
                ).map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    data-invite-which-option={value}
                    aria-pressed={which === value}
                    disabled={sending !== null}
                    onClick={() => setWhich(value)}
                    className={cn(
                      'border-l border-border/70 px-2.5 py-1 text-xs transition-colors first:border-l-0 disabled:cursor-not-allowed disabled:opacity-50',
                      which === value ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-1 text-xs text-muted-foreground">Reply{me ? <> for <span className="select-text text-foreground">{me.email}</span></> : null}</span>
            <div className="inline-flex overflow-hidden rounded-lg border border-border/70" role="group" aria-label="Your answer">
              {answers.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  data-invite-answer={value}
                  aria-pressed={!forOccurrence && myAnswer === value}
                  aria-busy={sending === value}
                  disabled={!answerable || (sending !== null && sending !== value)}
                  onClick={() => answer(value)}
                  title={answerable ? (forOccurrence ? `Answer “${label}” for ${occurrenceDay} only` : myAnswer === value ? `Your answer is “${label}”` : `Answer “${label}”`) : undefined}
                  className={cn(
                    'flex items-center gap-1 border-l border-border/70 px-3 py-1.5 text-xs font-medium transition-colors first:border-l-0',
                    !forOccurrence && myAnswer === value && sending === null ? 'bg-foreground text-background' : sending === value ? 'bg-muted' : 'hover:bg-muted',
                    'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
                  )}
                >
                  {sending === value ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
                  {label}
                </button>
              ))}
            </div>
            <button
              type="button"
              data-invite-more=""
              disabled={!found?.link}
              onClick={() => open(found?.link)}
              title={found?.link ? 'Open this event in your calendar' : undefined}
              className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              More options
              <ExternalLink className="h-3 w-3" />
            </button>
          </div>
          <p
            className={cn('mt-2 text-xs', error ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground')}
            data-invite-note=""
            data-invite-error={error ? '' : undefined}
            role={error ? 'alert' : 'status'}
          >
            {inviteNote({
              status,
              sending,
              sent,
              error,
              organizer: invite.organizer ? guestName(invite.organizer) : null,
              remembered: declinedAway ? 'declined' : remembered,
              sentFor: sent && sentWhich === 'occurrence' ? occurrenceDay : null,
            })}
            {error && found?.link && (
              <>
                {' '}
                <button type="button" data-invite-open="" onClick={() => open(found.link)} className="underline hover:no-underline">
                  Open it in your calendar
                </button>
              </>
            )}
          </p>
        </div>
      )}
    </section>
  )
}
