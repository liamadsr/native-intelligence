/**
 * What the Team chat sub-nav lists, in which order (Liam, 11-11: "make the
 * team-chat one look like this"). Drawn by ./team-chat-panel.tsx, from the
 * card's own conversations (components/chat-cards/team-chat-card-controls.ts).
 *
 *   All     the sections, top to bottom (Channels and DMs always, for their
 *           "+"; Meetings whenever calling is on; the rest only with a row):
 *           Favorites   the conversations the person starred, in the order
 *                       starred; each listed here only, not again in its
 *                       own section
 *           Team channels  channels for one team (`team_id`)
 *           Channels    the whole workspace's (`team_id` null)
 *           DMs         direct messages (a note to self among them)
 *           Meetings    meeting links' conversations (the card lists them
 *                       only where calling is on), latest activity first
 *   Recent  one flat list of every conversation, latest activity first.
 *
 * Team channels, Channels and DMs each sort by recent activity (the server's
 * order, the page's today) or A–Z, as the person picked for that section.
 *
 * Pure and client-safe.
 */
import { channelBadge } from '@/lib/team-chat/compose'
import type { TeamChatPanelConversation } from '@/components/chat-cards/team-chat-card-controls'

export type TeamChatPanelMode = 'all' | 'recent'
export type TeamChatSort = 'recent' | 'az'
/** The sections with a sort of their own. */
export type TeamChatSortedSection = 'team' | 'channels' | 'dms'
export type TeamChatSorts = Readonly<Record<TeamChatSortedSection, TeamChatSort>>

export const DEFAULT_TEAM_CHAT_SORTS: TeamChatSorts = Object.freeze({ team: 'recent', channels: 'recent', dms: 'recent' })

export interface TeamChatPanelRow {
  conversation: TeamChatPanelConversation
  /** Muted after the title: a team channel's team, only where two team channels would otherwise read the same. */
  hint: string | null
}

export interface TeamChatPanelSection {
  key: 'favorites' | 'team' | 'channels' | 'dms' | 'meetings'
  heading: string
  /** Its sort (null: none of its own: Favorites, Meetings). */
  sort: TeamChatSortedSection | null
  rows: TeamChatPanelRow[]
}

const SECTION_HEADINGS: Record<TeamChatPanelSection['key'], string> = {
  favorites: 'Favorites',
  team: 'Team channels',
  channels: 'Channels',
  dms: 'DMs',
  meetings: 'Meetings',
}

const stamp = (c: TeamChatPanelConversation): number => {
  const at = c.channel.last_message_at ? Date.parse(c.channel.last_message_at) : NaN
  return Number.isFinite(at) ? at : -Infinity
}

const byTitle = (a: TeamChatPanelConversation, b: TeamChatPanelConversation): number =>
  a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })

/** Latest activity first (never-used last), then by title. */
export function byRecent(a: TeamChatPanelConversation, b: TeamChatPanelConversation): number {
  return stamp(b) - stamp(a) || byTitle(a, b)
}

export function sortConversations(list: readonly TeamChatPanelConversation[], sort: TeamChatSort): TeamChatPanelConversation[] {
  return [...list].sort(sort === 'az' ? byTitle : byRecent)
}

/** Which kind of section a conversation belongs to. */
export function sectionOf(c: TeamChatPanelConversation): Exclude<TeamChatPanelSection['key'], 'favorites'> {
  if (c.channel.kind === 'dm') return 'dms'
  if (c.channel.kind === 'meeting') return 'meetings'
  return c.channel.team_id ? 'team' : 'channels'
}

/** The rows of a list, a team channel's team named only where its title alone is shared with another team channel's. */
function rowsOf(list: readonly TeamChatPanelConversation[]): TeamChatPanelRow[] {
  const seen = new Map<string, number>()
  for (const c of list) {
    if (sectionOf(c) !== 'team') continue
    const key = c.title.toLowerCase()
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  return list.map((c) => ({
    conversation: c,
    hint: sectionOf(c) === 'team' && (seen.get(c.title.toLowerCase()) ?? 0) > 1 ? c.teamName : null,
  }))
}

/**
 * The All view's sections, top to bottom. Favorites and Team channels show
 * only with rows. Channels and DMs always show, and Meetings whenever calling
 * is on (`meetings`): their heading's "+" is how the first channel, message or
 * meeting link starts (Liam, 11-11: "when you have no direct messages the +
 * section for direct messages doesn't show up", "also the meeting + isn't
 * showing either").
 */
export function teamChatPanelSections(
  conversations: readonly TeamChatPanelConversation[],
  favorites: readonly string[],
  sorts: TeamChatSorts = DEFAULT_TEAM_CHAT_SORTS,
  { meetings = false }: { meetings?: boolean } = {},
): TeamChatPanelSection[] {
  const byId = new Map(conversations.map((c) => [c.channel.id, c]))
  const starred = favorites.map((id) => byId.get(id)).filter((c): c is TeamChatPanelConversation => !!c)
  const starredIds = new Set(starred.map((c) => c.channel.id))
  const rest = conversations.filter((c) => !starredIds.has(c.channel.id))
  const of = (key: ReturnType<typeof sectionOf>) => rest.filter((c) => sectionOf(c) === key)
  // Team-channel hints compare every team channel, starred or not, so the same two read apart wherever they are.
  const hints = new Map(rowsOf(conversations).map((r) => [r.conversation.channel.id, r.hint]))
  const rows = (list: readonly TeamChatPanelConversation[]): TeamChatPanelRow[] =>
    list.map((c) => ({ conversation: c, hint: hints.get(c.channel.id) ?? null }))
  const sections: TeamChatPanelSection[] = [
    { key: 'favorites', heading: SECTION_HEADINGS.favorites, sort: null, rows: rows(starred) },
    { key: 'team', heading: SECTION_HEADINGS.team, sort: 'team', rows: rows(sortConversations(of('team'), sorts.team)) },
    { key: 'channels', heading: SECTION_HEADINGS.channels, sort: 'channels', rows: rows(sortConversations(of('channels'), sorts.channels)) },
    { key: 'dms', heading: SECTION_HEADINGS.dms, sort: 'dms', rows: rows(sortConversations(of('dms'), sorts.dms)) },
    { key: 'meetings', heading: SECTION_HEADINGS.meetings, sort: null, rows: rows(sortConversations(of('meetings'), 'recent')) },
  ]
  return sections.filter((s) => s.rows.length > 0 || s.key === 'channels' || s.key === 'dms' || (s.key === 'meetings' && meetings))
}

/** The Recent view: every conversation, latest activity first. */
export function teamChatRecentRows(conversations: readonly TeamChatPanelConversation[]): TeamChatPanelRow[] {
  const hints = new Map(rowsOf(conversations).map((r) => [r.conversation.channel.id, r.hint]))
  return sortConversations(conversations, 'recent').map((c) => ({ conversation: c, hint: hints.get(c.channel.id) ?? null }))
}

/**
 * A row's badge, by the page's own list's rules (views/team-chat-view.tsx
 * ChannelRow): bold while unread; its mentions as `@n` (a muted one's too);
 * else its unread count; else a muted one's bell. Nothing on the open one.
 */
export function teamChatRowBadge(
  c: TeamChatPanelConversation,
  open: boolean,
): { unread: boolean; mentions: number | null; count: number | null; muted: boolean } {
  const { count, mentions } = channelBadge(c.channel)
  const unread = count > 0 && !open
  const muted = c.channel.notify === 'muted'
  if (mentions > 0 && !open && (unread || muted)) return { unread, mentions, count: null, muted }
  if (unread) return { unread, mentions: null, count, muted }
  return { unread, mentions: null, count: null, muted }
}

/** The order's words, for its toggle's label. */
export const SORT_WORDS: Record<TeamChatSort, string> = { recent: 'recent activity', az: 'name, A–Z' }
