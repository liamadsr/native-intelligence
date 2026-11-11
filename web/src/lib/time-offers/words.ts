/**
 * Every word a time offer says, in the host's zone with its abbreviation
 * (the same day and clock formats as Copy availability,
 * src/lib/availability/copy-text.ts): the ready-to-paste text for a link, the
 * email and the text message that carry the link, the approval card that
 * shows exactly those words, and the calendar event's description.
 *
 * The card shows the link as its address with the token left out (the token
 * is minted only when it is sent, and is never stored): every other word on
 * the card is what goes out, and the card's hash pins them.
 *
 * Pure.
 */
import { createHash } from 'node:crypto'
import { zoneAbbreviation } from '@/lib/availability/zone'

const tidy = (s: string) => s.replace(/[  ]/g, ' ')

/** "Tue, Nov 17, 10:00 AM" in `timeZone`. */
export function slotLabel(startIso: string | number, timeZone: string): string {
  const at = typeof startIso === 'number' ? startIso : Date.parse(startIso)
  try {
    const day = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(at))
    const clock = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(at))
    return tidy(`${day}, ${clock}`)
  } catch {
    return new Date(at).toISOString()
  }
}

/** The zone's short name at the first time ("EST"), else the zone itself. */
export function zoneLabel(timeZone: string, at: number): string {
  return zoneAbbreviation(timeZone, at) ?? timeZone
}

/** What every set of words is made from. */
export interface OfferWords {
  hostName: string
  recipientFirstName: string | null
  title: string
  durationMinutes: number
  video: boolean
  location: string | null
  message: string | null
  timeZone: string
  /** The offered starts, soonest first. */
  starts: readonly string[]
}

function what(w: OfferWords): string {
  const where = w.video ? ', on a video call' : w.location ? `, at ${w.location}` : ''
  return `${w.title} (${w.durationMinutes} min${where})`
}

/** Whether the times fall under more than one of the zone's short names: a range across a daylight-saving change (EDT, then EST). Pure. */
function zoneShifts(starts: readonly string[], timeZone: string): boolean {
  return new Set(starts.map((s) => zoneLabel(timeZone, Date.parse(s)))).size > 1
}

/** A start as its line says it: with its own zone's short name when the times cross a change. */
function startLabel(start: string, timeZone: string, shifts: boolean): string {
  return shifts ? `${slotLabel(start, timeZone)} ${zoneLabel(timeZone, Date.parse(start))}` : slotLabel(start, timeZone)
}

/** The times as lines: "- Tue, Nov 17, 10:00 AM". */
function timeLines(w: OfferWords): string[] {
  const shifts = zoneShifts(w.starts, w.timeZone)
  return w.starts.map((s) => `- ${startLabel(s, w.timeZone, shifts)}`)
}

/** The times in one run: "Tue, Nov 17, 10:00 AM; Wed, Nov 18, 2:00 PM; or Thu, Nov 19, 9:30 AM" (each with its zone across a change). */
export function timesInline(starts: readonly string[], timeZone: string): string {
  const shifts = zoneShifts(starts, timeZone)
  const labels = starts.map((s) => startLabel(s, timeZone, shifts))
  if (labels.length <= 1) return labels.join('')
  return `${labels.slice(0, -1).join('; ')}; or ${labels[labels.length - 1]}`
}

/** The zone the words name once: its short name, or across a change the place ("New York time"), each time then carrying its own. */
const zoneOf = (w: OfferWords) =>
  zoneShifts(w.starts, w.timeZone) ? `${(w.timeZone.split('/').pop() ?? w.timeZone).replace(/_/g, ' ')} time` : zoneLabel(w.timeZone, Date.parse(w.starts[0] ?? new Date(0).toISOString()))
/** The zone after a run of times: none across a change, where each time has its own. */
const trailingZone = (w: OfferWords) => (zoneShifts(w.starts, w.timeZone) ? '' : ` ${zoneOf(w)}`)

/** The text the person pastes themselves (send_by 'link'). */
export function pasteText(w: OfferWords, link: string): string {
  return [
    ...(w.message ? [w.message, ''] : []),
    `Could we meet for ${what(w)}? These times work for me (${zoneOf(w)}):`,
    ...timeLines(w),
    '',
    `Pick the one that suits you here: ${link}`,
  ].join('\n')
}

/** The text message (send_by 'text'): from the business's number, so it names the host. Replies come back to the business's assistant. */
export function smsText(w: OfferWords, link: string): string {
  const hi = w.recipientFirstName ? `Hi ${w.recipientFirstName}, ` : ''
  return `${hi}${w.hostName} here.${w.message ? ` ${w.message}` : ''} Could we meet for ${what(w)}? ${timesInline(w.starts, w.timeZone)}${trailingZone(w)}. Pick one at ${link} or reply here with the one that works.`
}

/** The email (send_by 'email'), from the person's own mailbox. */
export function emailWords(w: OfferWords, link: string): { subject: string; text: string; html: string } {
  const greeting = w.recipientFirstName ? `Hi ${w.recipientFirstName},` : 'Hi,'
  const lines = [
    greeting,
    '',
    ...(w.message ? [w.message, ''] : []),
    `Could we meet for ${what(w)}? These times work for me (${zoneOf(w)}):`,
    ...timeLines(w),
    '',
    `Pick one here: ${link} or reply with the one that works.`,
    '',
    w.hostName,
  ]
  const text = lines.join('\n')
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const html = lines
    .map((line) => (line.includes(link) ? esc(line).replace(esc(link), `<a href="${esc(link)}">${esc(link)}</a>`) : esc(line)))
    .join('<br>')
  return { subject: `${w.title}: a few times to meet`, text, html: `<p>${html}</p>` }
}

/** One line of words inside a card, quoted. */
const quoted = (text: string) => `“${text.replace(/\s+/g, ' ').trim()}”`

/** A number as a card shows it: "+1 312-555-0142" (a US or Canadian one), else as it is. */
export const shownPhone = (to: string) => (/^\+1\d{10}$/.test(to) ? `+1 ${to.slice(2, 5)}-${to.slice(5, 8)}-${to.slice(8)}` : to)

export type OfferDelivery = { via: 'email'; to: string } | { via: 'text'; to: string; from: string }

/** A card's longest why: the app keeps 500 characters of it (src/lib/safety/approvals.ts), and every word sent must be on it. */
export const OFFER_CARD_WHY_MAX = 480

/** At most `max` characters, an ellipsis marking a cut; '' for no room. */
function clip(text: string, max: number): string {
  if (max <= 0) return ''
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** The approval card for an emailed or texted offer: who gets it (the title), from where, and the exact words. */
export function offerCard(
  w: OfferWords,
  delivery: OfferDelivery,
  recipientName: string,
  expiresAt: string,
  shownLink: string,
  /** A text as the SMS formatter sends it (ASCII punctuation), so the card shows it to the letter. */
  smsPlain: (text: string) => string = (t) => t,
): { title: string; why: string } {
  const name = recipientName.slice(0, 60)
  const held = `The times stay held until they pick one or ${slotLabel(expiresAt, w.timeZone)}. It runs once, exactly as shown, when you accept.`
  if (delivery.via === 'email') {
    const e = emailWords(w, shownLink)
    return { title: `Email ${name} (${delivery.to}) times to meet?`, why: `From your mailbox, subject ${quoted(e.subject)}: ${quoted(e.text)} ${held}` }
  }
  return { title: `Text ${name} (${shownPhone(delivery.to)}) times to meet?`, why: `From the business number ${shownPhone(delivery.from)}: ${quoted(smsPlain(smsText(w, shownLink)))} ${held}` }
}

/**
 * The words cut until the card shows them whole: the person's line first
 * (dropped once it would be a stub), then the title, then the host's name.
 * What the card shows is what goes out, so both use the words this returns.
 */
export function fitOfferWords(w: OfferWords, render: (words: OfferWords) => string, max: number = OFFER_CARD_WHY_MAX): OfferWords {
  let out = { ...w }
  const over = () => render(out).length - max
  if (over() <= 0) return out
  if (out.message) {
    const target = out.message.length - over()
    out = { ...out, message: target >= 24 ? clip(out.message, target) : null }
  }
  if (over() > 0) out = { ...out, title: clip(out.title, Math.max(30, out.title.length - over())) }
  if (over() > 0) out = { ...out, hostName: clip(out.hostName, Math.max(30, out.hostName.length - over())) }
  return out
}

/** The words a card shows, as one hash: the replay sends only when its own card hashes the same. */
export function offerCardHash(card: { title: string; why: string }): string {
  return createHash('sha256').update(`${card.title}\n${card.why}`).digest('hex').slice(0, 32)
}

/** The booked meeting's calendar event: its title, and a description with the manage link and where it came from. */
export function bookingEventWords(
  b: { title: string; guestName: string; guestNote: string | null; location: string | null },
  manageLink: string,
  /** The booking meets on a call here (migration 585): its meeting link, first. */
  callUrl?: string | null,
): { title: string; description: string } {
  return {
    title: `${b.title} (${b.guestName})`.slice(0, 200),
    description: [
      ...(callUrl ? [`Join the meeting: ${callUrl}`, ''] : []),
      ...(b.guestNote ? [`Note from ${b.guestName}: ${b.guestNote}`, ''] : []),
      `Need to change it? Reschedule or cancel: ${manageLink}`,
      '',
      'Booked through Native Intelligence',
    ].join('\n'),
  }
}

/** The host's line when a guest picked a time. */
export function bookedReport(b: { guestName: string; title: string; startsAt: string }, timeZone: string, invited: boolean, texted = false): string {
  const told = invited ? ' and they got the invitation' : texted ? ' and they got a confirmation text' : ', but they have no email on file, so no invitation went: tell them yourself'
  return `${b.guestName} picked ${slotLabel(b.startsAt, timeZone)} ${zoneLabel(timeZone, Date.parse(b.startsAt))} for ${b.title}. It's on your calendar${told}.`
}

/** The confirmation texted to a guest who gave only a mobile number: who, what, when, and their manage link. */
export function bookedText(b: { hostName: string; title: string; startsAt: string }, timeZone: string, manageLink: string, callUrl?: string | null): string {
  const join = callUrl ? ` Join the call: ${callUrl}.` : ''
  return `You're booked with ${b.hostName}: ${b.title}, ${slotLabel(b.startsAt, timeZone)} ${zoneLabel(timeZone, Date.parse(b.startsAt))}.${join} To move or cancel it: ${manageLink}`
}

/** The host's line when a booking could not be put on their calendar. */
export function failedReport(
  b: { guestName: string; title: string; startsAt: string },
  timeZone: string,
  reason: string,
  /** What became of an event the provider may have made anyway (finishBooking's clean-up): none, taken off again, or not known. */
  event: 'none' | 'deleted' | 'unknown' = 'none',
): string {
  const head = `${b.guestName} picked ${slotLabel(b.startsAt, timeZone)} ${zoneLabel(timeZone, Date.parse(b.startsAt))} for ${b.title}, but it couldn't be put on your calendar (${reason.slice(0, 120)})`
  if (event === 'deleted') return `${head}. The calendar had made the event after all, so it was taken off again: they may get its invitation and then a cancellation. The time is free again: reach them yourself.`
  if (event === 'unknown') return `${head}. The time is free again: reach them yourself. If the event shows on your calendar anyway, delete it there: they may have been invited.`
  return `${head}, so they got no invitation. The time is free again: reach them yourself.`
}

/** The host's line when a guest cancelled or moved. */
export function guestChangeReport(b: { guestName: string; title: string; startsAt: string }, timeZone: string, change: { kind: 'cancelled' } | { kind: 'moved'; fromIso: string }): string {
  const at = (iso: string) => `${slotLabel(iso, timeZone)} ${zoneLabel(timeZone, Date.parse(iso))}`
  return change.kind === 'cancelled'
    ? `${b.guestName} cancelled ${b.title} at ${at(b.startsAt)}. It's off your calendar.`
    : `${b.guestName} moved ${b.title} from ${at(change.fromIso)} to ${at(b.startsAt)}. Your calendar has the new time.`
}

/**
 * The host's line after they cancelled: who the calendar told, and who it
 * didn't. With no event written yet (a request still waiting, a booking still
 * being made) nobody was told; with one, each guest with an email got the
 * calendar's cancellation and each without one wasn't. Pure.
 */
export function hostCancelledWords(b: { title: string; calendarEventId: string | null }, guests: ReadonlyArray<{ name: string; email: string | null }>): string {
  const names = (list: ReadonlyArray<{ name: string }>) => namesList(list.map((g) => g.name), 4)
  const head = `Cancelled ${b.title} with ${names(guests) || 'the guest'}.`
  if (!b.calendarEventId) return `${head} It wasn't on the calendar yet, so nobody was told: reach ${guests.length > 1 ? 'them' : (guests[0]?.name ?? 'them')} yourself if they should know.`
  const told = guests.filter((g) => g.email)
  const untold = guests.filter((g) => !g.email)
  const sent = told.length ? ` The calendar sent ${names(told)} the cancellation.` : ''
  const rest = untold.length ? ` ${names(untold)} ${untold.length > 1 ? 'have' : 'has'} no email on file, so the calendar couldn't tell them: tell them yourself.` : ''
  return `${head}${sent}${rest}`
}

// ── Polls (availability phase 5) ────────────────────────────────────────────
//
// A poll's words are the same for every guest but their own link, so one
// card shows them once for everyone: no first-name greeting.

/** A poll's times by day, a line each: "- Wed, Nov 18: 6:00 AM, 10:00 AM" (a poll has more times than a pick). */
function byDay(w: OfferWords): Array<{ day: string; clocks: string[] }> {
  const days: Array<{ day: string; clocks: string[] }> = []
  const shifts = zoneShifts(w.starts, w.timeZone)
  for (const start of w.starts) {
    const [day, ...rest] = slotLabel(start, w.timeZone).split(', ')
    const date = rest.length > 1 ? `${day}, ${rest[0]}` : day
    const clock = `${rest[rest.length - 1] ?? ''}${shifts ? ` ${zoneLabel(w.timeZone, Date.parse(start))}` : ''}`
    const last = days[days.length - 1]
    if (last && last.day === date) last.clocks.push(clock)
    else days.push({ day: date, clocks: [clock] })
  }
  return days
}

function dayLines(w: OfferWords): string[] {
  return byDay(w).map((d) => `- ${d.day}: ${d.clocks.join(', ')}`)
}

/** "Wed, Nov 18: 6:00 AM, 10:00 AM; Thu, Nov 19: 6:00 AM". */
function daysInline(w: OfferWords): string {
  return byDay(w).map((d) => `${d.day}: ${d.clocks.join(', ')}`).join('; ')
}

/** "Dana Reyes", "Dana Reyes and Sam Ortiz", "Dana Reyes, Sam Ortiz and Lee Park", "Dana Reyes, Sam Ortiz and 3 others". */
export function namesList(names: readonly string[], max = 3): string {
  if (names.length <= 1) return names.join('')
  if (names.length <= max) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `${names.slice(0, max - 1).join(', ')} and ${names.length - (max - 1)} others`
}

/** The text the person pastes to one guest of a poll (send_by 'link'): their own link. */
export function pollPasteText(w: OfferWords, link: string): string {
  return [
    ...(w.message ? [w.message, ''] : []),
    `Could we meet for ${what(w)}? Which of these times work for you (${zoneOf(w)})?`,
    ...dayLines(w),
    '',
    `Mark every one that works here: ${link}`,
  ].join('\n')
}

/** A poll's text message (send_by 'text'), from the business's number. */
export function pollSmsText(w: OfferWords, link: string): string {
  return `Hi, ${w.hostName} here.${w.message ? ` ${w.message}` : ''} Could we meet for ${what(w)}? Which work for you: ${daysInline(w)}${trailingZone(w)}? Mark them at ${link} or reply here.`
}

/** A poll's email (send_by 'email'), from the person's own mailbox. */
export function pollEmailWords(w: OfferWords, link: string): { subject: string; text: string; html: string } {
  return mailOf(
    `${w.title}: which times work?`,
    ['Hi,', '', ...(w.message ? [w.message, ''] : []), `Could we meet for ${what(w)}? Which work for you (${zoneOf(w)})?`, ...dayLines(w), '', `Mark yours: ${link} or reply.`, '', w.hostName],
    link,
  )
}

/** A reminder to a guest who hasn't answered, by text. */
export function nudgeSmsText(w: OfferWords, link: string): string {
  return `Hi, ${w.hostName} here again. Which work for you for ${w.title}: ${daysInline(w)}${trailingZone(w)}? Mark them at ${link} or reply here.`
}

/** A reminder to a guest who hasn't answered, by email. */
export function nudgeEmailWords(w: OfferWords, link: string): { subject: string; text: string; html: string } {
  return mailOf(
    `Reminder: ${w.title}: which times work?`,
    ['Hi,', '', `A quick reminder: which work for you for ${what(w)} (${zoneOf(w)})?`, ...dayLines(w), '', `Mark yours: ${link} or reply.`, '', w.hostName],
    link,
  )
}

/** A reminder the person pastes to one guest themselves (send_by 'link'). */
export function nudgePasteText(w: OfferWords, link: string): string {
  return [`A quick reminder: which of these times work for you for ${what(w)} (${zoneOf(w)})?`, ...dayLines(w), '', `Mark every one that works here: ${link}`].join('\n')
}

function mailOf(subject: string, lines: string[], link: string): { subject: string; text: string; html: string } {
  const text = lines.join('\n')
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const html = lines.map((line) => (line.includes(link) ? esc(line).replace(esc(link), `<a href="${esc(link)}">${esc(link)}</a>`) : esc(line))).join('<br>')
  return { subject, text, html: `<p>${html}</p>` }
}

/** Who a poll card's words go to: each guest and their address. */
export type PollDelivery = { via: 'email'; to: ReadonlyArray<{ name: string; address: string }> } | { via: 'text'; to: ReadonlyArray<{ name: string; address: string }>; from: string }

const whoList = (to: PollDelivery['to'], via: PollDelivery['via']) => to.map((r) => `${r.name.slice(0, 40)} (${via === 'text' ? shownPhone(r.address) : r.address})`).join(', ')

/** A card's longest title: the app keeps 200 characters of it (src/lib/safety/approvals.ts). */
export const POLL_CARD_TITLE_MAX = 200

/**
 * The approval card for a poll (or a reminder to its guests) by email or
 * text: who gets it (the title: every guest, with their address), from
 * where, and the exact words, the same for each but their own link.
 */
export function pollCard(
  w: OfferWords,
  delivery: PollDelivery,
  kind: 'poll' | 'nudge',
  expiresAt: string,
  shownLink: string,
  smsPlain: (text: string) => string = (t) => t,
): { title: string; why: string } {
  const ask = kind === 'poll' ? 'times to meet' : 'a reminder about the times'
  const tail =
    kind === 'poll'
      ? `Held until all answer or ${slotLabel(expiresAt, w.timeZone)}, then the earliest time all can make is booked. It runs once, as shown, when you accept.`
      : 'It runs once, as shown, when you accept.'
  const own = delivery.to.length > 1 ? ', each with their own link' : ''
  if (delivery.via === 'email') {
    const e = kind === 'poll' ? pollEmailWords(w, shownLink) : nudgeEmailWords(w, shownLink)
    return { title: `Email ${whoList(delivery.to, 'email')} ${ask}?`, why: `From your mailbox${own}, subject ${quoted(e.subject)}: ${quoted(e.text)} ${tail}` }
  }
  const body = kind === 'poll' ? pollSmsText(w, shownLink) : nudgeSmsText(w, shownLink)
  return { title: `Text ${whoList(delivery.to, 'text')} ${ask}?`, why: `From the business number ${shownPhone(delivery.from)}${own}: ${quoted(smsPlain(body))} ${tail}` }
}

const atLabel = (iso: string, timeZone: string) => `${slotLabel(iso, timeZone)} ${zoneLabel(timeZone, Date.parse(iso))}`

/** A group meeting's calendar event: everyone's invitation, so no one guest's link. */
export function pollEventWords(b: { title: string; guestName: string }): { title: string; description: string } {
  return {
    title: `${b.title} (${b.guestName})`.slice(0, 200),
    description: ["Can't make it? Decline this invitation, or open the link you were sent to answer the times.", '', 'Booked through Native Intelligence'].join('\n'),
  }
}

/** The host's line when a poll was booked: when, with whom, and how each guest heard. */
export function pollBookedReport(
  b: { title: string; startsAt: string },
  timeZone: string,
  told: { invited: readonly string[]; texted: readonly string[]; untold: readonly string[]; left: readonly string[]; anyway: boolean },
): string {
  const everyone = [...told.invited, ...told.texted, ...told.untold]
  const head = told.anyway
    ? `Booked ${b.title} for ${atLabel(b.startsAt, timeZone)} with ${namesList(everyone, 4)}`
    : `Everyone answered: ${b.title} is booked for ${atLabel(b.startsAt, timeZone)} with ${namesList(everyone, 4)}`
  const parts = [`${head}. It's on your calendar.`]
  if (told.invited.length) parts.push(`${namesList(told.invited, 4)} got the invitation.`)
  if (told.texted.length) parts.push(`${namesList(told.texted, 4)} got a confirmation text.`)
  if (told.untold.length) parts.push(`${namesList(told.untold, 4)} ${told.untold.length === 1 ? 'has' : 'have'} no email or textable number on file, so tell them yourself.`)
  if (told.left.length) parts.push(`${namesList(told.left, 4)} ${told.left.length === 1 ? "isn't" : "aren't"} on it.`)
  return parts.join(' ')
}

/** The best option's words: "Tue, Nov 17, 10:00 AM EST (Dana Reyes and Sam Ortiz can; Lee Park can't; Mo Diaz hasn't answered)". */
export function bestOptionWords(
  best: { slot: { startsAt: string }; can: ReadonlyArray<{ name: string }>; cannot: ReadonlyArray<{ name: string }>; waiting: ReadonlyArray<{ name: string }> },
  timeZone: string,
): string {
  const parts = [
    best.can.length ? `${namesList(best.can.map((r) => r.name), 4)} can` : 'nobody has said they can',
    ...(best.cannot.length ? [`${namesList(best.cannot.map((r) => r.name), 4)} can't`] : []),
    ...(best.waiting.length ? [`${namesList(best.waiting.map((r) => r.name), 4)} ${best.waiting.length === 1 ? "hasn't" : "haven't"} answered`] : []),
  ]
  return `${atLabel(best.slot.startsAt, timeZone)} (${parts.join('; ')})`
}

/** The host's line when every guest answered and no time works for all of them. */
export function pollNoCommonReport(p: { title: string; expiresAt: string; timeZone: string }, best: Parameters<typeof bestOptionWords>[0] | null): string {
  const option = best ? ` The time most can make: ${bestOptionWords(best, p.timeZone)}.` : ''
  return `Everyone answered your times for ${p.title}, but none works for all of them, so nothing is booked.${option} The times stay held until ${atLabel(p.expiresAt, p.timeZone)} in case someone changes their answer. Say if I should book one anyway, without who can't make it, or offer new times.`
}

/** The host's line when a poll expired without a booking. */
export function pollExpiredReport(p: { title: string; timeZone: string }, waiting: readonly string[], best: Parameters<typeof bestOptionWords>[0] | null): string {
  const missing = waiting.length ? `${namesList(waiting, 4)} never answered` : 'no time worked for everyone'
  const option = best ? ` The time most could make was ${bestOptionWords(best, p.timeZone)}.` : ''
  return `Your times for ${p.title} expired: ${missing}, so nothing was booked, and the held times are free again.${option} Offer new times if you still want to meet.`
}

/** The host's line when a guest of a group meeting said they can't make it. */
export function pollDeclinedReport(b: { title: string; startsAt: string }, timeZone: string, who: string, left: readonly string[]): string {
  const rest = left.length ? `It stays on with ${namesList(left, 4)}.` : 'No outside guest is left on it: cancel it if it should go.'
  return `${who} can't make ${b.title} at ${atLabel(b.startsAt, timeZone)} after all, so they're off the invitation. ${rest}`
}

/** The confirmation texted to a poll guest who gave only a mobile number: what, when, and their own link to say they can't make it. */
export function pollBookedText(b: { hostName: string; title: string; startsAt: string }, timeZone: string, manageLink: string): string {
  return `You're booked with ${b.hostName}: ${b.title}, ${atLabel(b.startsAt, timeZone)}. If you can't make it: ${manageLink}`
}
