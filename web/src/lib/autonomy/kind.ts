/**
 * The kind of a held call, for earned autonomy (docs/plans/earned-autonomy.md
 * §1): tool × channel × audience, computed by THIS code from the tool and its
 * stored input, never from anything a model wrote. A model's own label ("just
 * a booking confirmation") could be steered by an injected email into a kind
 * the person trusts; the stored call can't be relabelled.
 *
 * Whether the recipients are KNOWN is not part of the kind: it is checked on
 * every call (hard-limits.ts callHitsHardLimit). An approval of a send to a
 * new person still says the draft was right; no autonomous call ever reaches
 * a new person.
 *
 * Pure: no I/O.
 */
import { bareToolName } from '@/lib/mcp/tool-names'

export const AUTONOMY_CHANNELS = ['email', 'text', 'calendar', 'customer', 'link', 'native', 'app', 'unknown'] as const
export type AutonomyChannel = (typeof AUTONOMY_CHANNELS)[number]

export const AUTONOMY_AUDIENCES = ['none', 'one', 'few', 'many'] as const
export type AutonomyAudience = (typeof AUTONOMY_AUDIENCES)[number]

/** More recipients than this is `many`, a mass send (a hard limit). */
export const MASS_SEND_CAP = 3

export interface AutonomyKind {
  /** The bare registry name, or the namespaced `mcp__<server>__<tool>` of a connected app's tool. */
  tool: string
  channel: AutonomyChannel
  /** For channel 'app': the connected app's server name (part of the key). */
  app?: string
  audience: AutonomyAudience
  /** `tool|channel|audience` (`tool|app:<server>|audience` for a connected app): the record's key. */
  key: string
  /** The recipients the call names (lower-cased addresses or numbers), for the per-call checks. */
  recipients: string[]
}

/** The held call, as tool_approval stores it. */
export interface HeldCallShape {
  tool: string
  input: unknown
  context?: unknown
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : ''
}

/** Every attendee address in a calendar call's input (outward-gate.ts attendeeEmailsOf's keys), lower-cased, de-duplicated. */
export function calendarAttendeesOf(input: unknown): string[] {
  const args = obj(input)
  const out = new Set<string>()
  for (const key of ['attendees', 'add_attendees', 'required_attendees', 'optional_attendees']) {
    const list = args[key]
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      const email = typeof entry === 'string' ? str(entry) : str(obj(entry).email)
      if (email) out.add(email)
    }
  }
  return [...out]
}

/** Bucket a recipient count. */
export function audienceOf(count: number): AutonomyAudience {
  if (!Number.isFinite(count) || count <= 0) return 'none'
  if (count === 1) return 'one'
  if (count <= MASS_SEND_CAP) return 'few'
  return 'many'
}

/** Every address- or number-like value under the usual recipient keys of a connected app's input. */
function genericRecipients(input: Record<string, unknown>): string[] {
  const out = new Set<string>()
  for (const key of ['to', 'cc', 'bcc', 'recipients', 'recipient', 'email', 'emails', 'phone', 'attendees', 'guests', 'invitees']) {
    const v = input[key]
    const list = Array.isArray(v) ? v : v === undefined ? [] : [v]
    for (const entry of list) {
      const raw = typeof entry === 'string' ? entry : str(obj(entry).email) || str(obj(entry).address) || str(obj(entry).phone)
      for (const part of String(raw).split(/[,;]/)) {
        const s = part.trim().toLowerCase()
        if (s) out.add(s)
      }
    }
  }
  return [...out]
}

/**
 * The kind of a held call. Unknown shapes fall to channel 'unknown' (which
 * never graduates) rather than guessing.
 */
export function kindOfCall(call: HeldCallShape): AutonomyKind {
  const raw = typeof call.tool === 'string' ? call.tool : ''
  // The registry's name (`ni_offer_times` and `offer_times` are one kind).
  const tool = raw.startsWith('mcp__') ? raw : bareToolName(raw)
  const input = obj(call.input)
  const context = obj(call.context)
  let channel: AutonomyChannel = 'unknown'
  let app: string | undefined
  let recipients: string[] = []

  if (tool.startsWith('mcp__')) {
    // mcp__<server>__<tool>: the server is part of the kind (Gmail's label tool is not Linear's).
    const parts = tool.split('__')
    app = parts.length >= 3 ? parts[1].toLowerCase() : undefined
    channel = app ? 'app' : 'unknown'
    recipients = genericRecipients(input)
  } else {
    const name = tool
    switch (name) {
      case 'create_calendar_event':
      case 'update_calendar_event':
        channel = 'calendar'
        recipients = calendarAttendeesOf(input)
        break
      case 'offer_times':
      case 'nudge_time_offer': {
        const by = input.send_by
        channel = by === 'email' ? 'email' : by === 'text' ? 'text' : 'link'
        recipients = [str(input.email), str(input.phone)].filter(Boolean)
        // A nudge names its poll, not its guests: count it as one reach until
        // the replay's card says more (the per-call check reads the offer).
        if (name === 'nudge_time_offer' && channel !== 'link') recipients = recipients.length ? recipients : ['poll:' + str(input.offer_id)]
        break
      }
      case 'book_quote':
      case 'send_quote': {
        // The quote's customer, reached the way their quote came in.
        channel = 'customer'
        const quote = obj(context.quoteReply)
        recipients = ['quote:' + (str(quote.quote_id) || str(input.quote_id))]
        break
      }
      case 'push_action_to_linear':
      case 'push_action_to_jira':
      case 'push_action_to_asana':
        channel = 'native'
        recipients = []
        break
      default:
        channel = 'unknown'
        recipients = genericRecipients(input)
    }
  }
  const audience = audienceOf(recipients.length)
  const channelKey = channel === 'app' && app ? `app:${app}` : channel
  return { tool, channel, app, audience, key: `${tool}|${channelKey}|${audience}`, recipients }
}

/** Parse a stored key back (for the Settings list). Null when it isn't one of ours. */
export function parseKindKey(key: string): Pick<AutonomyKind, 'tool' | 'channel' | 'app' | 'audience'> | null {
  const parts = typeof key === 'string' ? key.split('|') : []
  if (parts.length !== 3) return null
  const [tool, ch, audience] = parts
  const app = ch.startsWith('app:') ? ch.slice(4) : undefined
  const channel = (app ? 'app' : ch) as AutonomyChannel
  if (!tool || !(AUTONOMY_CHANNELS as readonly string[]).includes(channel)) return null
  if (!(AUTONOMY_AUDIENCES as readonly string[]).includes(audience)) return null
  return { tool, channel, app, audience: audience as AutonomyAudience }
}

const TOOL_LABELS: Record<string, string> = {
  book_quote: 'Booking confirmations to customers',
  send_quote: 'Quotes to customers',
  create_calendar_event: 'Calendar invites',
  update_calendar_event: 'Calendar changes',
  offer_times: 'Offers of meeting times',
  nudge_time_offer: 'Reminders to answer a time poll',
  push_action_to_linear: 'Actions pushed to Linear',
  push_action_to_jira: 'Actions pushed to Jira',
  push_action_to_asana: 'Actions pushed to Asana',
}

const CHANNEL_WORDS: Record<AutonomyChannel, string> = {
  email: 'by email',
  text: 'by text',
  calendar: '',
  customer: '',
  link: 'as a link',
  native: '',
  app: '',
  unknown: '',
}

const AUDIENCE_WORDS: Record<AutonomyAudience, string> = {
  none: '',
  one: 'to one person',
  few: 'to a few people',
  many: 'to many people',
}

/** The label people see, templated from the three parts ("Offers of meeting times by text, to one person"). */
export function kindLabel(kind: Pick<AutonomyKind, 'tool' | 'channel' | 'app' | 'audience'>): string {
  let base = TOOL_LABELS[bareToolName(kind.tool)]
  if (!base) {
    const parts = kind.tool.split('__')
    const name = (parts.length >= 3 ? parts.slice(2).join('__') : kind.tool).replace(/[_-]+/g, ' ').trim()
    base = kind.app ? `${name.charAt(0).toUpperCase()}${name.slice(1)} in ${kind.app}` : name.charAt(0).toUpperCase() + name.slice(1)
  }
  const tail = [CHANNEL_WORDS[kind.channel], AUDIENCE_WORDS[kind.audience]].filter(Boolean)
  if (!tail.length) return base
  if (tail.length === 1) return `${base} ${tail[0]}`
  return `${base} ${tail[0]}, ${tail[1]}`
}
