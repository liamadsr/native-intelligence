/**
 * Slack's Events API envelope, as Vercel Connect forwards it
 * (docs/plans/slack-connect.md §3, §4 piece 4). Pure: no I/O.
 *
 * Connect verifies Slack's signature at its intake and forwards the raw
 * event body to /api/slack/events with a Vercel OIDC token; the route
 * verifies that token, then this reads the body. Nothing here trusts the body
 * for WHO a sender is beyond what Slack put in it after Connect checked
 * Slack's signature: the team, the user id, the channel.
 */

/** What an inbound Slack payload asks Dial8 to do. */
export type SlackInbound =
  | { kind: 'challenge'; challenge: string }
  | {
      /** A person's message to the bot in a direct message. */
      kind: 'dm'
      eventId: string
      teamId: string
      /** The sender's own team: another team's id means a Slack Connect outsider. */
      userTeamId: string
      slackUserId: string
      channel: string
      ts: string
      text: string
    }
  | {
      /** The bot was @mentioned in a channel (piece c answers these). */
      kind: 'mention'
      eventId: string
      teamId: string
      userTeamId: string
      slackUserId: string
      channel: string
      ts: string
      /** The thread the mention is in; its own ts when it starts one. */
      threadTs: string
      text: string
      /** A Slack Connect channel: people from another company read the reply. */
      sharedExternally: boolean
    }
  | { kind: 'uninstalled'; eventId: string; teamId: string }
  | { kind: 'ignore'; reason: string }

const TEAM_ID = /^T[A-Z0-9]{2,30}$/
const USER_ID = /^[UW][A-Z0-9]{2,30}$/
const CHANNEL_ID = /^[CDG][A-Z0-9]{2,30}$/
const TS = /^[0-9]{1,12}\.[0-9]{1,8}$/
/** The longest message text Dial8 keeps (Slack's own cap is 40,000). */
export const SLACK_TEXT_MAX_CHARS = 8_000

/** Message subtypes that are still a person typing to the bot (a file's caption included). */
const PERSON_SUBTYPES: ReadonlySet<string> = new Set(['file_share', 'thread_broadcast'])

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * Read a forwarded payload. `appId` is our app (config.ts slackAppId): an
 * event for any other app is ignored. Never throws.
 */
export function parseSlackPayload(raw: unknown, appId: string): SlackInbound {
  if (!raw || typeof raw !== 'object') return { kind: 'ignore', reason: 'not_json' }
  const body = raw as Record<string, unknown>
  if (body.type === 'url_verification') {
    const challenge = str(body.challenge)
    return challenge && challenge.length <= 200 ? { kind: 'challenge', challenge } : { kind: 'ignore', reason: 'bad_challenge' }
  }
  if (body.type !== 'event_callback') return { kind: 'ignore', reason: `type:${str(body.type) || 'none'}` }
  if (body.api_app_id !== appId) return { kind: 'ignore', reason: 'other_app' }
  const teamId = str(body.team_id)
  const eventId = str(body.event_id)
  if (!TEAM_ID.test(teamId) || !eventId || eventId.length > 100) return { kind: 'ignore', reason: 'bad_envelope' }
  const event = body.event as Record<string, unknown> | undefined
  if (!event || typeof event !== 'object') return { kind: 'ignore', reason: 'no_event' }

  switch (event.type) {
    case 'app_uninstalled':
    case 'tokens_revoked':
      return event.type === 'tokens_revoked' && !revokesBot(event) ? { kind: 'ignore', reason: 'user_tokens_revoked' } : { kind: 'uninstalled', eventId, teamId }
    case 'message':
      return parseMessage(event, { eventId, teamId })
    case 'app_mention':
      return parseMention(event, { eventId, teamId }, body.is_ext_shared_channel === true)
    default:
      return { kind: 'ignore', reason: `event:${str(event.type) || 'none'}` }
  }
}

/** tokens_revoked names bot tokens under `tokens.bot`; only those end the installation. */
function revokesBot(event: Record<string, unknown>): boolean {
  const tokens = event.tokens as { bot?: unknown } | undefined
  return Array.isArray(tokens?.bot) && tokens.bot.length > 0
}

/** The person's own words, or a reason to skip. */
function personMessage(event: Record<string, unknown>, teamId: string): { slackUserId: string; userTeamId: string; channel: string; ts: string; text: string } | string {
  if (event.bot_id || event.bot_profile) return 'bot'
  const subtype = str(event.subtype)
  if (subtype && !PERSON_SUBTYPES.has(subtype)) return `subtype:${subtype}`
  if (event.hidden === true) return 'hidden'
  const slackUserId = str(event.user)
  const channel = str(event.channel)
  const ts = str(event.ts)
  if (!USER_ID.test(slackUserId) || !CHANNEL_ID.test(channel) || !TS.test(ts)) return 'bad_message'
  const text = str(event.text).slice(0, SLACK_TEXT_MAX_CHARS)
  // The sender's team as Slack stamps it (user_team on Connect channels, team otherwise).
  const userTeamId = str(event.user_team) || str(event.team) || teamId
  return { slackUserId, userTeamId, channel, ts, text }
}

function parseMessage(event: Record<string, unknown>, ids: { eventId: string; teamId: string }): SlackInbound {
  // Channel messages arrive here too (message.channels / .groups); a channel
  // is answered only through app_mention, so only a DM counts.
  if (event.channel_type !== 'im') return { kind: 'ignore', reason: `channel_type:${str(event.channel_type) || 'none'}` }
  const m = personMessage(event, ids.teamId)
  if (typeof m === 'string') return { kind: 'ignore', reason: m }
  if (!m.text.trim()) return { kind: 'ignore', reason: 'empty' }
  return { kind: 'dm', ...ids, ...m }
}

function parseMention(event: Record<string, unknown>, ids: { eventId: string; teamId: string }, sharedExternally: boolean): SlackInbound {
  const m = personMessage(event, ids.teamId)
  if (typeof m === 'string') return { kind: 'ignore', reason: m }
  // A channel or a private channel: a DM is never a mention's thread.
  if (!/^[CG]/.test(m.channel)) return { kind: 'ignore', reason: 'mention_not_in_channel' }
  const threadTs = str(event.thread_ts)
  return { kind: 'mention', ...ids, ...m, threadTs: TS.test(threadTs) ? threadTs : m.ts, sharedExternally }
}

/**
 * A Slack message's text as plain words: user mentions as `@name` (or the
 * bot's own mention dropped), links as their label or URL, entities decoded.
 */
export function slackTextToPlain(text: string, opts: { botUserId?: string | null } = {}): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, label?: string) => (id === opts.botUserId ? '' : `@${label || id}`))
    .replace(/<#[CG][A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<!(here|channel|everyone)>/g, '@$1')
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_m, label?: string) => label || '@group')
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<((?:https?|mailto):[^>]+)>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .trim()
}
