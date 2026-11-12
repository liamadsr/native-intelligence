/**
 * PER-ITEM ACCESS, the client-safe half (the shared entity layer, phase 5):
 * the kinds a grant can open, who it can name, and the words the app uses
 * for a share. The grant store is `entity_access` (migration 492); its SQL
 * read rule is has_entity_grant, mirrored for an explicit user in
 * ./grants.ts.
 *
 * A grant only ever ADDS access: a member, a team's members, or a team-chat
 * channel's readers may read a record its own rule hides from them (another
 * member's private document or capture, a private or team contact, a company
 * none of whose contacts they can see).
 *
 * A grant is VIEW or EDIT (migration 512). Edit lets the grantee change what
 * the record says through the same paths its owner uses (its text and
 * fields, comments, labels, suggestions); never delete it, change who owns
 * or sees it, archive it, or share it on.
 */

/** The kinds a grant can open: those with a per-record read rule that can be shared (a private table, migration 520). */
export const GRANTABLE_TYPES = ['document', 'capture', 'contact', 'company', 'data_table'] as const
export type GrantableType = (typeof GRANTABLE_TYPES)[number]

export function isGrantableType(type: unknown): type is GrantableType {
  return typeof type === 'string' && (GRANTABLE_TYPES as readonly string[]).includes(type)
}

/** Who a grant names. A channel's grantees are whoever can read it. */
export const GRANTEE_KINDS = ['member', 'team', 'channel'] as const
export type GranteeKind = (typeof GRANTEE_KINDS)[number]

export function isGranteeKind(kind: unknown): kind is GranteeKind {
  return typeof kind === 'string' && (GRANTEE_KINDS as readonly string[]).includes(kind)
}

/** Why it exists: the share dialog, an @-mention in team chat, or Share to a channel. */
export const GRANT_SOURCES = ['manual', 'mention', 'channel_share'] as const
export type GrantSource = (typeof GRANT_SOURCES)[number]

/** What a grant lets its grantee do. */
export const GRANT_LEVELS = ['view', 'edit'] as const
export type GrantLevel = (typeof GRANT_LEVELS)[number]

export function isGrantLevel(level: unknown): level is GrantLevel {
  return typeof level === 'string' && (GRANT_LEVELS as readonly string[]).includes(level)
}

/** The words a grant's level reads as in the share dialog. */
export const GRANT_LEVEL_LABEL: Record<GrantLevel, string> = { view: 'Can view', edit: 'Can edit' }

/** A grant as the share dialog lists it. */
export interface EntityGrant {
  id: string
  grantee_kind: GranteeKind
  grantee_id: string
  /** The grantee's name: a member's, a team's, "#channel", or a DM's other person. */
  grantee_name: string
  level: GrantLevel
  source: GrantSource
  created_at: string
}

/** What GET /api/account/entity-access answers for one record. */
export interface EntityAccessResponse {
  /** The viewer may add and remove grants on it (its kind's own rule: a private doc's creator, …). */
  can_share: boolean
  /** Its own rule hides it from some members (private, team-only, …): a grant then means something. */
  restricted: boolean
  grants: EntityGrant[]
}

/** A record a team-chat post just opened to the channel's readers. */
export interface SharedRecord {
  grant_id: string
  type: GrantableType
  id: string
  label: string
}

/** How a record's name reads in a toast: quoted, short. */
function quoted(label: string): string {
  const words = label.replace(/\s+/g, ' ').trim()
  return words ? `“${words.length > 60 ? `${words.slice(0, 59)}…` : words}”` : 'it'
}

/**
 * The toast a share-by-mention shows: "Shared “Q3 plan” with #launch".
 * `audience` is who the channel reaches ("#launch", or a DM's other person).
 */
export function sharedToastText(shared: readonly Pick<SharedRecord, 'label'>[], audience: string | null): string {
  const what = shared.length === 1 ? quoted(shared[0].label) : `${shared.length} records`
  return `Shared ${what} with ${audience || 'this conversation'}`
}

/** Who a channel's grant reaches, in words: "#launch", a DM's other person, or null. */
export function channelAudience(channel: { kind: string; name: string | null }, dmOtherName?: string | null): string | null {
  if (channel.kind === 'dm') return dmOtherName?.trim() || null
  if (channel.kind === 'meeting') return channel.name ? `the meeting ${channel.name}` : null
  return channel.name ? `#${channel.name}` : null
}
