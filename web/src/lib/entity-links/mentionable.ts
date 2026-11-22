/**
 * What can be @-mentioned, and a mention list tidied: pure and client-safe
 * (team chat's types and composer read it). The server half, which fences
 * each record and writes the `mentions` edges, is ./mentions.ts.
 */
import type { EntityTypeSubset, LinkableEntityType } from '@/lib/knowledge/entity-registry'

/**
 * The kinds a person can @-mention: records people work on, and uploaded
 * files (fenced as the attachments table is: its uploader's, or on a record
 * the author can see). Not claims (facts are cited, not mentioned), not a
 * member (team chat's `mentions` column holds people), and not cycles or
 * milestones (no picker offers them). A Studio video or Studio project is
 * mentionable by a member who may use the Studio (never a guest).
 *
 * Mail (`email_thread`) and a chat with the agent (`conversation`) reverse
 * migration 341's "shown to no one" for the one case of an explicit mention
 * by their OWNER (docs/plans/mentions-everywhere.md, decision 1): each is
 * mentionable only by the person whose mail/chat it is (visibleMentionTargets
 * fences on `user_id`), and a mention where teammates read it is what shares
 * it with them. Search still finds only your own.
 *
 * Sequences and prospect lists became graph endpoints with "mentions
 * everywhere" (every member's, so unfenced). Teams are not mentionable: a
 * private team's edges would need a database fence of their own.
 */
export const MENTIONABLE_TYPES = [
  'action',
  'document',
  'project',
  'initiative',
  'capture',
  'contact',
  'company',
  'campaign',
  'flow',
  'attachment',
  'calendar_event',
  'decision',
  'team_chat_channel',
  'team_chat_message',
  'data_table',
  'data_row',
  // The Studio's (624): fenced for the writer as a member who is not a guest.
  'studio_video',
  'studio_project',
  // Outreach (mentions everywhere): sequences and prospect lists are every member's.
  'sequence',
  'prospect_list',
  // Teams and knowledge packages (673): a private team to its members, a package by its own rule (visibility, shares).
  'team',
  'knowledge_package',
  // A spreadsheet (675): a workspace one is every member's, a private one its maker's (spreadsheetFence).
  'spreadsheet',
  // Owner-only (decision 1): mail and agent chats, fenced on user_id.
  'email_thread',
  'conversation',
] as const satisfies readonly EntityTypeSubset<LinkableEntityType>[]
export type MentionableType = (typeof MENTIONABLE_TYPES)[number]

export function isMentionableType(type: unknown): type is MentionableType {
  return typeof type === 'string' && (MENTIONABLE_TYPES as readonly string[]).includes(type)
}

/** The most records one message or document mentions (more are dropped). */
export const MAX_MENTIONED_RECORDS = 50

/** The longest label a mention keeps (the words it shows as). */
export const MENTION_LABEL_MAX = 120

export interface MentionRef {
  type: MentionableType
  id: string
}

/** A mention as a message carries it: the record, and the words it shows as. */
export interface LabeledMentionRef extends MentionRef {
  label: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const mentionKey = (r: { type: string; id: string }) => `${r.type}:${r.id}`

/** Distinct, well-formed, mentionable refs (at most MAX_MENTIONED_RECORDS), the source itself left out. */
export function tidyMentionRefs(raw: unknown, self?: { type: string; id: string }): MentionRef[] {
  return tidy(raw, self).map(({ type, id }) => ({ type, id }))
}

/** The same, keeping each one's label (trimmed, at most MENTION_LABEL_MAX); a ref with no label is dropped. */
export function tidyLabeledMentionRefs(raw: unknown, self?: { type: string; id: string }): LabeledMentionRef[] {
  return tidy(raw, self, true)
}

function tidy(raw: unknown, self: { type: string; id: string } | undefined, labeled = false): LabeledMentionRef[] {
  if (!Array.isArray(raw)) return []
  const out = new Map<string, LabeledMentionRef>()
  for (const r of raw) {
    if (out.size >= MAX_MENTIONED_RECORDS) break
    if (!r || typeof r !== 'object') continue
    const { type, id, label } = r as { type?: unknown; id?: unknown; label?: unknown }
    if (!isMentionableType(type) || typeof id !== 'string' || !UUID.test(id)) continue
    const words = typeof label === 'string' ? label.replace(/\s+/g, ' ').trim().slice(0, MENTION_LABEL_MAX) : ''
    if (labeled && !words) continue
    const ref = { type, id: id.toLowerCase(), label: words }
    if (self && self.type === ref.type && self.id.toLowerCase() === ref.id) continue
    if (!out.has(mentionKey(ref))) out.set(mentionKey(ref), ref)
  }
  return [...out.values()]
}
