/**
 * A meeting's dial-in: the phone number to call and the digits to play once
 * it answers (roadmap #12, docs/plans/agent-joins-meetings.md §1a). Pure.
 *
 * Where it comes from, best first:
 *   - Google: `conferenceData.entryPoints`, the `phone` entry (`tel:` uri and
 *     its `pin`). That's Meet's own dial-in.
 *   - Microsoft: `onlineMeeting.tollNumber` and `onlineMeeting.conferenceId`
 *     (Teams).
 *   - The invite's text, for everything else (Zoom puts its dial-in in the
 *     description, and so do Teams and Meet invites forwarded as text): a
 *     one-tap string (`+16465550100,,81234567890#,,,,*123456#`), or a
 *     number with a labelled meeting ID / conference ID / PIN and passcode.
 *
 * Only US and Canadian numbers for now: the Twilio account dials those
 * (its geo permissions), and texts and calls elsewhere in the product are
 * NANP-only too.
 *
 * The digits are DTMF with Twilio's `w` (half a second's wait) between the
 * prompts: a phone bridge answers, speaks its prompt, then listens.
 *
 *   Meet    PIN #
 *   Teams   conference ID #
 *   Zoom    meeting ID #, then * passcode # (or # alone: no participant ID)
 */
import { isNanpNumber, normalizeE164 } from '@/lib/twilio/phone'

export type DialInPlatform = 'meet' | 'teams' | 'zoom' | 'unknown'

export interface DialIn {
  /** E.164, a US or Canadian number. */
  number: string
  /** What to play once it answers: digits, `#`, `*` and `w`. */
  digits: string
  platform: DialInPlatform
}

/** How long to wait before the first prompt is listened for (3 s). */
const ANSWER_WAIT = 'wwwwww'
/** How long between two prompts (4 s). */
const PROMPT_WAIT = 'wwwwwwww'

/** The longest digit string kept (the table's check). */
export const DIAL_IN_DIGITS_MAX = 64

function digitsOnly(text: string): string {
  return text.replace(/\D/g, '')
}

/** A US/CA E.164 number, or null. */
function nanp(raw: string | null | undefined): string | null {
  if (!raw) return null
  const e164 = normalizeE164(raw.replace(/^tel:/i, '').replace(/[\s().-]/g, ''))
  return e164 && isNanpNumber(e164) ? e164 : null
}

/** The DTMF a platform's bridge wants for these ids, or null when there is no id. */
export function dialDigits(platform: DialInPlatform, id: string, passcode?: string | null): string | null {
  const meetingId = digitsOnly(id)
  if (meetingId.length < 4 || meetingId.length > 20) return null
  const pass = passcode ? digitsOnly(passcode) : ''
  const digits =
    platform === 'zoom'
      ? `${ANSWER_WAIT}${meetingId}#${PROMPT_WAIT}${pass ? `*${pass}#` : '#'}`
      : `${ANSWER_WAIT}${meetingId}#`
  return digits.length <= DIAL_IN_DIGITS_MAX ? digits : null
}

/** True when `digits` is something Twilio may play (and the table keeps). */
export function isDialDigits(digits: unknown): digits is string {
  return typeof digits === 'string' && digits.length >= 1 && digits.length <= DIAL_IN_DIGITS_MAX && /^[0-9#*w]+$/.test(digits)
}

/** Google's `conferenceData.entryPoints`: the phone entry, with its PIN. */
export function dialInOfGoogleEntryPoints(entryPoints: unknown): DialIn | null {
  if (!Array.isArray(entryPoints)) return null
  for (const ep of entryPoints as Array<Record<string, unknown>>) {
    if (ep?.entryPointType !== 'phone') continue
    const number = nanp(typeof ep.uri === 'string' ? ep.uri : null)
    const pin = typeof ep.pin === 'string' ? ep.pin : typeof ep.accessCode === 'string' ? ep.accessCode : null
    if (!number || !pin) continue
    const digits = dialDigits('meet', pin)
    if (digits) return { number, digits, platform: 'meet' }
  }
  return null
}

/** Microsoft Graph's `onlineMeeting` (Teams): its toll number and conference ID. */
export function dialInOfMicrosoftOnlineMeeting(onlineMeeting: unknown): DialIn | null {
  if (!onlineMeeting || typeof onlineMeeting !== 'object') return null
  const om = onlineMeeting as Record<string, unknown>
  const number = nanp(typeof om.tollNumber === 'string' ? om.tollNumber : null)
  const id = typeof om.conferenceId === 'string' ? om.conferenceId : null
  if (!number || !id) return null
  const digits = dialDigits('teams', id)
  return digits ? { number, digits, platform: 'teams' } : null
}

function platformOfText(text: string): DialInPlatform {
  if (/zoom\.us|zoom meeting|zoom/i.test(text)) return 'zoom'
  if (/teams\.microsoft|microsoft teams|phone conference id/i.test(text)) return 'teams'
  if (/meet\.google|google meet/i.test(text)) return 'meet'
  return 'unknown'
}

/** The first US/CA number in a stretch of text ("+1 646 555 0100", "+1 (323) 555-0100"). */
function firstNumber(text: string): string | null {
  for (const m of text.matchAll(/\+\s?1[\s().-]*\d{3}[\s().-]*\d{3}[\s.-]*\d{4}/g)) {
    const number = nanp(m[0])
    if (number) return number
  }
  return null
}

/**
 * The dial-in written in an invite's text (a description, a location), or
 * null. A one-tap string first, since it carries the number and ids
 * together; else a number with a labelled id.
 */
export function dialInOfText(text: string | null | undefined): DialIn | null {
  if (!text) return null
  const body = text.slice(0, 20_000)
  const platform = platformOfText(body)

  // One tap: +16465550100,,81234567890#  (Zoom adds ,,,,*123456# for its passcode).
  const tap = /(\+1\d{10}),,(\d{4,20})#(?:,+\*?(\d{1,15})#)?/.exec(body)
  if (tap) {
    const number = nanp(tap[1])
    const tapPlatform = platform === 'unknown' ? (tap[3] ? 'zoom' : 'teams') : platform
    const digits = number ? dialDigits(tapPlatform, tap[2], tap[3]) : null
    if (number && digits) return { number, digits, platform: tapPlatform }
  }

  const number = firstNumber(body)
  if (!number) return null
  const labelled = (label: RegExp): string | null => {
    const m = label.exec(body)
    return m ? m[1] : null
  }
  const idPattern = '([0-9][0-9 ]{3,24}[0-9])'
  if (platform === 'zoom' || /meeting id/i.test(body)) {
    const id = labelled(new RegExp(`meeting id[:\\s]*${idPattern}`, 'i'))
    const pass = labelled(/(?:passcode|password)[:\s]*([0-9]{1,15})/i)
    const digits = id ? dialDigits('zoom', id, pass) : null
    if (digits) return { number, digits, platform: 'zoom' }
  }
  const conference = labelled(new RegExp(`(?:phone )?conference id[:\\s]*${idPattern}`, 'i'))
  if (conference) {
    const digits = dialDigits('teams', conference)
    if (digits) return { number, digits, platform: 'teams' }
  }
  const pin = labelled(new RegExp(`pin[:\\s]*${idPattern}`, 'i'))
  if (pin) {
    const digits = dialDigits(platform === 'unknown' ? 'meet' : platform, pin)
    if (digits) return { number, digits, platform: platform === 'unknown' ? 'meet' : platform }
  }
  return null
}

/** The meeting's dial-in from whatever the calendar gave: the provider's own fields first, then the invite's text. */
export function dialInOfEvent(event: {
  dialIn?: DialIn | null
  description?: string | null
  location?: string | null
}): DialIn | null {
  return event.dialIn ?? dialInOfText(event.description) ?? dialInOfText(event.location)
}
