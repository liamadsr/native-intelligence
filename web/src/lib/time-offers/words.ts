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

/** The times as lines: "- Tue, Nov 17, 10:00 AM". */
function timeLines(w: OfferWords): string[] {
  return w.starts.map((s) => `- ${slotLabel(s, w.timeZone)}`)
}

/** The times in one run: "Tue, Nov 17, 10:00 AM; Wed, Nov 18, 2:00 PM; or Thu, Nov 19, 9:30 AM". */
export function timesInline(starts: readonly string[], timeZone: string): string {
  const labels = starts.map((s) => slotLabel(s, timeZone))
  if (labels.length <= 1) return labels.join('')
  return `${labels.slice(0, -1).join('; ')}; or ${labels[labels.length - 1]}`
}

const zoneOf = (w: OfferWords) => zoneLabel(w.timeZone, Date.parse(w.starts[0] ?? new Date(0).toISOString()))

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
  return `${hi}${w.hostName} here.${w.message ? ` ${w.message}` : ''} Could we meet for ${what(w)}? ${timesInline(w.starts, w.timeZone)} ${zoneOf(w)}. Pick one at ${link} or reply here with the one that works.`
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
export function bookingEventWords(b: { title: string; guestName: string; guestNote: string | null; location: string | null }, manageLink: string): { title: string; description: string } {
  return {
    title: `${b.title} (${b.guestName})`.slice(0, 200),
    description: [
      ...(b.guestNote ? [`Note from ${b.guestName}: ${b.guestNote}`, ''] : []),
      `Need to change it? Reschedule or cancel: ${manageLink}`,
      '',
      'Booked through Native Intelligence',
    ].join('\n'),
  }
}

/** The host's line when a guest picked a time. */
export function bookedReport(b: { guestName: string; title: string; startsAt: string }, timeZone: string, invited: boolean): string {
  return `${b.guestName} picked ${slotLabel(b.startsAt, timeZone)} ${zoneLabel(timeZone, Date.parse(b.startsAt))} for ${b.title}. It's on your calendar${invited ? ' and they got the invitation' : ', but they have no email on file, so no invitation went: tell them yourself'}.`
}

/** The host's line when a booking could not be put on their calendar. */
export function failedReport(b: { guestName: string; title: string; startsAt: string }, timeZone: string, reason: string): string {
  return `${b.guestName} picked ${slotLabel(b.startsAt, timeZone)} ${zoneLabel(timeZone, Date.parse(b.startsAt))} for ${b.title}, but it couldn't be put on your calendar (${reason.slice(0, 120)}), so they got no invitation. The time is free again: reach them yourself.`
}

/** The host's line when a guest cancelled or moved. */
export function guestChangeReport(b: { guestName: string; title: string; startsAt: string }, timeZone: string, change: { kind: 'cancelled' } | { kind: 'moved'; fromIso: string }): string {
  const at = (iso: string) => `${slotLabel(iso, timeZone)} ${zoneLabel(timeZone, Date.parse(iso))}`
  return change.kind === 'cancelled'
    ? `${b.guestName} cancelled ${b.title} at ${at(b.startsAt)}. It's off your calendar.`
    : `${b.guestName} moved ${b.title} from ${at(change.fromIso)} to ${at(b.startsAt)}. Your calendar has the new time.`
}
