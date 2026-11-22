/**
 * ENTITY IDENTITY: one glyph and one colour per kind of record, so a doc, a
 * meeting, a project or a table is told at a glance wherever it is listed
 * (Liam, 11-22: "for each document type or entity type they have a visual
 * identity ... let's also adopt that"). The search palette's rows and tabs,
 * the `@` pickers, mention chips, the home recents, card headers, the Create
 * dialog and notifications all draw a kind through this one map, by way of
 * <EntityIcon> (src/components/entities/entity-icon.tsx).
 *
 * A sibling of the findable registry (src/lib/search/findable-registry.ts),
 * the entity registry (src/lib/knowledge/entity-registry.ts) and the entity
 * actions registry (./entity-actions-registry.ts): `ENTITY_IDENTITIES` covers
 * every `EntityType` and every `FindableKind` (a kind with no identity does
 * not compile), plus the few things shown as a kind that are neither (a skill,
 * a direct message, a booking link).
 *
 * The glyph carries the kind and the colour reinforces it: no two kinds share
 * a glyph, so a kind is never told apart by colour alone. Colours are theme
 * tokens (`--entity-<hue>` in src/styles/tailwind.css), a darker ink on the
 * light theme and a lighter one on the dark.
 *
 * People keep their faces: a contact or a member with an avatar or initials is
 * drawn as that; this map's `contact` is what stands in where there is neither.
 *
 * CLIENT-BUNDLE SAFE: plain data and lucide's icon components only.
 */
import {
  AudioLines,
  BotMessageSquare,
  Boxes,
  Building2,
  CalendarClock,
  CalendarDays,
  CircleCheck,
  CircleDot,
  CirclePlay,
  CircleUser,
  Clapperboard,
  FileText,
  Film,
  FlaskConical,
  FolderKanban,
  Gavel,
  Handshake,
  Hash,
  History,
  Lightbulb,
  ListOrdered,
  Mail,
  MailPlus,
  Megaphone,
  MessageCircle,
  MessageSquare,
  MessageSquareText,
  Mic,
  Milestone,
  Package,
  Paperclip,
  RefreshCw,
  Rows3,
  ScrollText,
  Shapes,
  SquareTerminal,
  Table2,
  Tag,
  Target,
  TestTube,
  TestTubes,
  User,
  UserPlus,
  UserRoundSearch,
  UserSearch,
  Users,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import type { EntityType } from '@/lib/knowledge/entity-registry'
import type { FindableGroup, FindableKind } from '@/lib/search/findable-registry'

/** The hues a kind is tinted in: each is a theme token, `--entity-<hue>`. */
export const ENTITY_COLORS = [
  'slate',
  'gray',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'teal',
  'cyan',
  'blue',
  'indigo',
  'purple',
  'pink',
] as const
export type EntityColor = (typeof ENTITY_COLORS)[number]

/** Each hue as the ink of a glyph. Spelled out: Tailwind reads class names from the source. */
export const ENTITY_COLOR_TEXT: Record<EntityColor, string> = {
  slate: 'text-entity-slate',
  gray: 'text-entity-gray',
  red: 'text-entity-red',
  orange: 'text-entity-orange',
  amber: 'text-entity-amber',
  yellow: 'text-entity-yellow',
  lime: 'text-entity-lime',
  green: 'text-entity-green',
  teal: 'text-entity-teal',
  cyan: 'text-entity-cyan',
  blue: 'text-entity-blue',
  indigo: 'text-entity-indigo',
  purple: 'text-entity-purple',
  pink: 'text-entity-pink',
}

/** Each hue as a faint wash behind a glyph or a chip (a tenth of the ink). */
export const ENTITY_COLOR_WASH: Record<EntityColor, string> = {
  slate: 'bg-entity-slate/10',
  gray: 'bg-entity-gray/10',
  red: 'bg-entity-red/10',
  orange: 'bg-entity-orange/10',
  amber: 'bg-entity-amber/10',
  yellow: 'bg-entity-yellow/10',
  lime: 'bg-entity-lime/10',
  green: 'bg-entity-green/10',
  teal: 'bg-entity-teal/10',
  cyan: 'bg-entity-cyan/10',
  blue: 'bg-entity-blue/10',
  indigo: 'bg-entity-indigo/10',
  purple: 'bg-entity-purple/10',
  pink: 'bg-entity-pink/10',
}

export interface EntityIdentity {
  /** The kind's glyph: its own, shared with no other kind. */
  readonly icon: LucideIcon
  /** The hue it is tinted in. */
  readonly color: EntityColor
  /** What one of them is called ("Doc", "Meeting"). */
  readonly label: string
}

/** What is drawn as a kind and is no registered entity or found kind. */
type ExtraIdentityKind = 'skill' | 'dm' | 'booking_link'

/** Every kind with an identity. */
export type EntityIdentityKind = EntityType | FindableKind | ExtraIdentityKind

const AGENT: EntityIdentity = { icon: Boxes, color: 'cyan', label: 'Agent' }
const KNOWLEDGE_PACKAGE: EntityIdentity = { icon: Package, color: 'amber', label: 'Knowledge package' }

/**
 * The registry. An agent is stored as a `recipe` and found as an `agent`, a
 * knowledge package stored as `knowledge_package` and found as a `package`:
 * each pair is one identity under both names.
 */
export const ENTITY_IDENTITIES: Record<EntityIdentityKind, EntityIdentity> = {
  // ── Work ────────────────────────────────────────────────────────────────
  action: { icon: CircleCheck, color: 'blue', label: 'Action' },
  project: { icon: FolderKanban, color: 'indigo', label: 'Project' },
  initiative: { icon: Target, color: 'orange', label: 'Initiative' },
  cycle: { icon: RefreshCw, color: 'teal', label: 'Cycle' },
  milestone: { icon: Milestone, color: 'orange', label: 'Milestone' },
  label: { icon: Tag, color: 'gray', label: 'Label' },
  workflow_state: { icon: CircleDot, color: 'gray', label: 'Status' },
  // ── Docs and knowledge ──────────────────────────────────────────────────
  document: { icon: FileText, color: 'purple', label: 'Doc' },
  knowledge_package: KNOWLEDGE_PACKAGE,
  package: KNOWLEDGE_PACKAGE,
  claim: { icon: Lightbulb, color: 'yellow', label: 'Claim' },
  decision: { icon: Gavel, color: 'amber', label: 'Decision' },
  comment: { icon: MessageSquare, color: 'gray', label: 'Comment' },
  attachment: { icon: Paperclip, color: 'slate', label: 'File' },
  // ── Meetings ────────────────────────────────────────────────────────────
  capture: { icon: AudioLines, color: 'pink', label: 'Meeting' },
  capture_participant: { icon: Mic, color: 'pink', label: 'Participant' },
  calendar_event: { icon: CalendarDays, color: 'red', label: 'Event' },
  booking_link: { icon: CalendarClock, color: 'teal', label: 'Booking link' },
  // ── People ──────────────────────────────────────────────────────────────
  contact: { icon: User, color: 'gray', label: 'Contact' },
  member: { icon: CircleUser, color: 'gray', label: 'Member' },
  contact_interaction: { icon: History, color: 'gray', label: 'Interaction' },
  company: { icon: Building2, color: 'slate', label: 'Company' },
  team: { icon: Users, color: 'teal', label: 'Team' },
  // ── Deals and tables ────────────────────────────────────────────────────
  deal: { icon: Handshake, color: 'green', label: 'Deal' },
  data_table: { icon: Table2, color: 'lime', label: 'Table' },
  canvas: { icon: Shapes, color: 'pink', label: 'Canvas' },
  data_row: { icon: Rows3, color: 'lime', label: 'Row' },
  // ── Chats ───────────────────────────────────────────────────────────────
  team_chat_channel: { icon: Hash, color: 'slate', label: 'Channel' },
  dm: { icon: MessageCircle, color: 'slate', label: 'Direct message' },
  team_chat_message: { icon: MessageSquareText, color: 'slate', label: 'Message' },
  conversation: { icon: BotMessageSquare, color: 'cyan', label: 'Chat' },
  // ── Agents ──────────────────────────────────────────────────────────────
  agent: AGENT,
  recipe: AGENT,
  // A skill is a playbook (Liam, 07-12): document-family, and never the doc's own glyph.
  skill: { icon: ScrollText, color: 'yellow', label: 'Skill' },
  flow: { icon: Workflow, color: 'indigo', label: 'Flow' },
  flow_run: { icon: CirclePlay, color: 'indigo', label: 'Flow run' },
  agent_run: { icon: SquareTerminal, color: 'cyan', label: 'Agent run' },
  eval_suite: { icon: FlaskConical, color: 'green', label: 'Eval suite' },
  eval_case: { icon: TestTube, color: 'green', label: 'Eval case' },
  eval_run: { icon: TestTubes, color: 'green', label: 'Eval run' },
  // ── Mail ────────────────────────────────────────────────────────────────
  email_thread: { icon: Mail, color: 'blue', label: 'Mail' },
  email_draft: { icon: MailPlus, color: 'blue', label: 'Draft' },
  // ── Outreach ────────────────────────────────────────────────────────────
  sequence: { icon: ListOrdered, color: 'orange', label: 'Sequence' },
  sequence_enrollment: { icon: UserPlus, color: 'orange', label: 'Enrollment' },
  prospect_list: { icon: UserSearch, color: 'teal', label: 'Prospect list' },
  prospect_list_entry: { icon: UserRoundSearch, color: 'teal', label: 'Prospect' },
  campaign: { icon: Megaphone, color: 'pink', label: 'Campaign' },
  // ── Studio ──────────────────────────────────────────────────────────────
  studio_video: { icon: Film, color: 'red', label: 'Video' },
  studio_project: { icon: Clapperboard, color: 'red', label: 'Studio project' },
}

/** Every kind with an identity. */
export const ENTITY_IDENTITY_KINDS = Object.keys(ENTITY_IDENTITIES) as EntityIdentityKind[]

/**
 * The other names a kind goes by where it is listed: the Create dialog's
 * types ('table', 'channel', 'email', 'event'), a For you card's icons
 * ('mail'), the words people use ('task', 'doc', 'meeting').
 */
const ALIASES: Record<string, EntityIdentityKind> = {
  task: 'action',
  doc: 'document',
  note: 'document',
  meeting: 'capture',
  person: 'contact',
  table: 'data_table',
  row: 'data_row',
  channel: 'team_chat_channel',
  message: 'team_chat_message',
  chat: 'conversation',
  email: 'email_thread',
  mail: 'email_thread',
  thread: 'email_thread',
  event: 'calendar_event',
  file: 'attachment',
  video: 'studio_video',
  bot: 'agent',
}

export function isEntityIdentityKind(kind: unknown): kind is EntityIdentityKind {
  return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(ENTITY_IDENTITIES, kind)
}

/** A kind by any of its names, or null for what has no identity. */
export function resolveEntityIdentityKind(kind: string | null | undefined): EntityIdentityKind | null {
  if (!kind) return null
  if (isEntityIdentityKind(kind)) return kind
  return Object.prototype.hasOwnProperty.call(ALIASES, kind) ? ALIASES[kind] : null
}

/** A kind's identity, by any of its names; null for what has none (the caller draws its own fallback). */
export function entityIdentity(kind: string | null | undefined): EntityIdentity | null {
  const k = resolveEntityIdentityKind(kind)
  return k ? ENTITY_IDENTITIES[k] : null
}

/** A kind's glyph alone, for a place that takes an icon component. */
export function entityGlyph(kind: string | null | undefined): LucideIcon | null {
  return entityIdentity(kind)?.icon ?? null
}

/** A kind's ink as a class (`text-entity-purple`), or '' for what has no identity. */
export function entityTextClass(kind: string | null | undefined): string {
  const identity = entityIdentity(kind)
  return identity ? ENTITY_COLOR_TEXT[identity.color] : ''
}

/**
 * The kind a group of found kinds wears: the search strip's tabs each list
 * several kinds (src/lib/search/findable-registry.ts FINDABLE_GROUPS), and a
 * tab is drawn with its leading kind's identity.
 */
export const FINDABLE_GROUP_IDENTITY_KIND: Record<FindableGroup, EntityIdentityKind> = {
  people: 'contact',
  work: 'action',
  docs: 'document',
  meetings: 'capture',
  mail: 'email_thread',
  chats: 'team_chat_channel',
  crm: 'company',
  outreach: 'campaign',
  files: 'attachment',
  agents_skills: 'agent',
  studio: 'studio_video',
}
