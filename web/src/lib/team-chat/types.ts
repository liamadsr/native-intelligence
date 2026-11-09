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
 */

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
  /** Messages from others since the person last read it. */
  unread: number
  /** How many of those mention them. */
  mentions: number
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
  /** The words ('' once deleted). */
  body: string
  mentions: string[]
  mentions_agent: boolean
  created_at: string
  edited_at: string | null
  deleted_at: string | null
}

/** The columns a message is read with. */
export const TEAM_CHAT_MESSAGE_COLUMNS =
  'id, channel_id, author_kind, author_member_id, agent_for_member_id, agent_name, in_reply_to, body, mentions, mentions_agent, created_at, edited_at, deleted_at'

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
 * as a whole word: "@Josephine" is not "@Joseph".
 */
export function mentionsAssistantName(body: string, assistantName: string | null | undefined): boolean {
  const name = assistantName?.trim()
  if (!name) return false
  const re = new RegExp(`(^|[^\\p{L}\\p{N}_])@${escapeForRegExp(name)}(?![\\p{L}\\p{N}_])`, 'iu')
  return re.test(body)
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
