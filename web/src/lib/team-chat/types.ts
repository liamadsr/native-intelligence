/**
 * Team chat (roadmap #7, migration 474): channels and direct messages inside a
 * workspace, with each member's agent as a member of the team. This module is
 * the shared vocabulary, pure and client-safe: the API routes
 * (src/app/api/account/team-chat/*), the page (src/app/account/(dashboard)/
 * views/team-chat-view.tsx) and the agent's turn (./agent-turn.ts) read it.
 *
 * A channel is open to the whole workspace, or to one team's members when it
 * names a team. A DM is between two members (or one: a note to self). A
 * message mentions members by their member ids (`mentions`) and may call on
 * the author's own agent (`mentions_agent`, or `@<their assistant name>` in
 * the words): that runs a chat-agent turn as the author, in their own
 * conversation for the channel, and the reply is posted back as their agent.
 * It may also @-mention records (`record_mentions`, migration 480: a task, a
 * doc, a deal, …), each written to the graph as a `mentions` edge
 * (src/lib/entity-links/mentions.ts).
 *
 * Migrations 555-559 complete it: a message may be a reply in a thread
 * (`thread_root_id`, the thread's root, one level deep), carry files and
 * images (`attachments`, in the team-chat-files bucket: ./files.ts) and a
 * preview of its first link (`link_preview`, fetched once by the server:
 * ./link-preview.ts); people react to it (team_chat_reaction); a send carries
 * the id its page minted (`client_id`), so a retry never posts twice.
 */
import type { LabeledMentionRef } from '@/lib/entity-links/mentionable'


/** The most characters a message holds (migration 474's check). */
export const TEAM_CHAT_MESSAGE_MAX = 8000
/** The most characters a channel's name holds (474's check). */
export const TEAM_CHAT_NAME_MAX = 80
/** The most characters a channel's topic holds (474's check). */
export const TEAM_CHAT_TOPIC_MAX = 250
/** The most members one message mentions (474's check). */
export const TEAM_CHAT_MAX_MENTIONS = 50
/** How many messages a page of a channel's history holds. */
export const TEAM_CHAT_PAGE_SIZE = 50

export type TeamChatChannelKind = 'channel' | 'dm'

/** A channel or DM as the list shows it. */
export interface TeamChatChannel {
  id: string
  kind: TeamChatChannelKind
  /** A channel's name (no leading #). Null for a DM. */
  name: string | null
  topic: string | null
  /** The team a channel is for, or null for the whole workspace. */
  team_id: string | null
  /** A DM's other member (themselves for a note to self). Null for a channel. */
  dm_member_id: string | null
  last_message_at: string | null
  archived_at: string | null
  /** Messages from others since the person last read it (the channel's own: never a thread's replies). */
  unread: number
  /** How many of those mention them. */
  mentions: number
  /** Replies from others, unread, in the threads here the person is in (migration 556). */
  thread_unread: number
  /** How many of those mention them. */
  thread_mentions: number
  /**
   * How loud it is for the person (migration 560): every message notifies,
   * only mentions (a channel's default), or nothing (muted: no unread count
   * either, `unread` and `thread_unread` are 0; a mention still counts).
   */
  notify: 'all' | 'mentions' | 'muted'
}

/** A file or image on a message (migration 555), as stored and drawn. */
export interface TeamChatAttachment {
  /** Its object in the team-chat-files bucket: `<channel id>/<user id>/<uuid>.<ext>`. */
  path: string
  /** The name it was uploaded with. */
  name: string
  /** Bytes, as storage measured it. */
  size: number
  /** Its media type, as storage recorded it. */
  type: string
  /** An image's own size, px (so it takes its room before it loads). */
  width?: number
  height?: number
}

/** A message's first link, as the server read it once (migration 555). */
export interface TeamChatLinkPreview {
  url: string
  /** The site's own name, else its host. */
  site: string
  title: string | null
  description: string | null
  /** An https image the page names for itself (og:image), or null. */
  image: string | null
}

/** A thread's summary, under its root (migration 556). */
export interface TeamChatThreadSummary {
  root_id: string
  channel_id: string
  reply_count: number
  last_reply_at: string | null
  /** The last few members who replied, newest first. */
  participant_ids: string[]
}

/** A thread the person is in with replies they haven't read. */
export interface TeamChatThreadUnread {
  root_id: string
  channel_id: string
  unread: number
  mentions: number
}

/** One member's reaction on a message (migration 557); `active` false: taken back. */
export interface TeamChatReaction {
  message_id: string
  member_id: string
  emoji: string
  active: boolean
}

/** A message as the page shows it. */
export interface TeamChatMessage {
  id: string
  channel_id: string
  author_kind: 'member' | 'agent'
  /** The member who wrote it (author_kind 'member'). */
  author_member_id: string | null
  /** Whose agent wrote it (author_kind 'agent'). */
  agent_for_member_id: string | null
  /** The agent's name when it wrote it (author_kind 'agent'). */
  agent_name: string | null
  /** The message an agent's reply answers. */
  in_reply_to: string | null
  /** The thread it is a reply in (its root message), or null for a message in the channel itself. */
  thread_root_id: string | null
  /** The id the sender's page minted for the send: its optimistic bubble is this row. */
  client_id: string | null
  /** The words ('' once deleted). */
  body: string
  mentions: string[]
  mentions_agent: boolean
  /**
   * The records the message @-mentions (migration 480), as the words show
   * them; each is also a `mentions` edge in the graph. Absent on a row from
   * before 480 (and on an old realtime payload): none.
   */
  record_mentions?: TeamChatRecordMention[]
  /** Files and images on it (none once deleted). */
  attachments: TeamChatAttachment[]
  /** Its first link's preview, once the server has read it. */
  link_preview: TeamChatLinkPreview | null
  created_at: string
  edited_at: string | null
  deleted_at: string | null
  /**
   * What it is (migration 564): a message, or a call's own row in the
   * conversation (`call_id`; its words say what happened, its card is drawn
   * from the call). Absent on an old realtime payload: a message.
   */
  kind?: 'message' | 'call'
  call_id?: string | null
}

/** A record a message @-mentions: its kind and id, and the label its `@…` shows. */
export type TeamChatRecordMention = LabeledMentionRef

/** The columns a message is read with. */
export const TEAM_CHAT_MESSAGE_COLUMNS =
  'id, channel_id, author_kind, author_member_id, agent_for_member_id, agent_name, in_reply_to, thread_root_id, client_id, body, mentions, mentions_agent, record_mentions, attachments, link_preview, created_at, edited_at, deleted_at, kind, call_id'

/** The most replies a thread's pane loads at once. */
export const TEAM_CHAT_THREAD_MAX = 200
/** The most emoji one member puts on one message (migration 557's cap). */
export const TEAM_CHAT_MAX_REACTIONS = 20

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True for a uuid string. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

/** A channel name as typed, tidied (trimmed, a leading # dropped, single spaces), or null when unusable. */
export function tidyChannelName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.trim().replace(/^#+/, '').replace(/\s+/g, ' ').trim()
  if (!name || [...name].length > TEAM_CHAT_NAME_MAX) return null
  return name
}

/**
 * True for one emoji, as a reaction is: pictographs with their joiners,
 * variation selectors, skin tones and keycaps, never words, markup or spaces
 * (migration 557's check is the looser fence under this one).
 */
export function isReactionEmoji(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16) return false
  if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(value)) return false
  return /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\p{Emoji_Modifier}|\u200d|\ufe0f|\u20e3)+$/u.test(value)
}

/** A message's words as sent, or null when empty or too long. */
export function tidyBody(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const body = raw.replace(/\r\n?/g, '\n').trim()
  if (!body || body.length > TEAM_CHAT_MESSAGE_MAX) return null
  return body
}

/** The distinct uuids of a client's mention list (at most TEAM_CHAT_MAX_MENTIONS); anything else is dropped. */
export function tidyMentionIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.filter(isUuid).map((id) => id.toLowerCase()))].slice(0, TEAM_CHAT_MAX_MENTIONS)
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * True when the words @-mention this assistant name ("@Joseph", any case),
 * as a whole word: "@Josephine" is not "@Joseph". An `@Name` that runs on
 * into a member's name ("@Joseph Lee", a teammate, when the agent goes by
 * the default "Joseph") is that member, never the agent: pass the
 * workspace's member names as `memberNames`.
 */
export function mentionsAssistantName(
  body: string,
  assistantName: string | null | undefined,
  memberNames: readonly (string | null | undefined)[] = [],
): boolean {
  const name = assistantName?.trim()
  if (!name) return false
  const re = new RegExp(`(^|[^\\p{L}\\p{N}_])@${escapeForRegExp(name)}(?![\\p{L}\\p{N}_])`, 'giu')
  const lower = name.toLowerCase()
  // Members whose name starts with the agent's and goes on ("Joseph Lee").
  const longer = memberNames
    .map((n) => n?.trim().toLowerCase() ?? '')
    .filter((n) => n.length > lower.length && n.startsWith(lower))
  for (const m of body.matchAll(re)) {
    const rest = body.slice((m.index ?? 0) + m[1].length + 1).toLowerCase()
    const isMember = longer.some((n) => rest.startsWith(n) && !/[\p{L}\p{N}_]/u.test(rest.charAt(n.length)))
    if (!isMember) return true
  }
  return false
}

/** A DM's other member, from its dm_key (`a:b`, or `a` for a note to self) and the person's own member id. */
export function dmOtherMember(dmKey: string | null | undefined, me: string): string | null {
  if (!dmKey) return null
  const ids = dmKey.split(':')
  if (ids.length === 1) return ids[0] === me ? me : null
  if (ids.length !== 2 || !ids.includes(me)) return null
  return ids[0] === me ? ids[1] : ids[0]
}

/** How a member's agent is shown: "Joseph (Ana's agent)", or just the name when it is the reader's own. */
export function agentDisplayName(agentName: string | null, ownerName: string | null, isMine: boolean): string {
  const name = agentName?.trim() || 'Agent'
  if (isMine) return `${name} (your agent)`
  return ownerName ? `${name} (${ownerName}'s agent)` : name
}
