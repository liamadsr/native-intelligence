/**
 * THE SAME ACTIONS ON EVERY KIND: how each registered kind is opened and
 * acted on, keyed by `EntityType` (phase 3 of the shared entity layer). The
 * one menu (src/components/entities/entity-actions-menu.tsx) and the one
 * action layer (./actions.ts) read this, so a kind offers Open, Copy link,
 * Rename, Archive, Share and Make a task wherever it shows up, and a kind that
 * can't do one of them never offers it.
 *
 * A sibling of the entity registry (src/lib/knowledge/entity-registry.ts)
 * rather than more fields on it: the registry stays the graph's pure-data
 * vocabulary, and this is the UI's. `ENTITY_ACTIONS` is a
 * `Record<EntityType, …>`, so registering a kind there without deciding here
 * is a type error, the way `realtime` forces a decision there. Every field is
 * required: "none" is a decision too, and an archive that doesn't exist says
 * why.
 *
 * Each field describes the kind's EXISTING mechanism, never a new one:
 *   - `open` is the card src/lib/chat-cards/open-card.ts already draws;
 *   - `link` is the boot deep link `/account?<kind>=<id>` the main chat
 *     already reads (main-chat-context.tsx deepLinkCard);
 *   - `rename` and `archive` name the kind's own `/api/account/<route>/[id]`
 *     route and the field it already takes, so its permission checks and side
 *     effects run as they do from the kind's own screens.
 *
 * CLIENT-BUNDLE SAFE, like the registry: plain data and pure functions only.
 */
import type { EntityType } from '@/lib/knowledge/entity-registry'
import { isMentionableType } from '@/lib/entity-links/mentionable'

/**
 * Where a kind's Open lands (src/lib/chat-cards/open-card.ts OpenTarget):
 *   'record'          its own record card (a CardRecordType);
 *   'calendar-event'  the calendar card, open on the event;
 *   'flow'            the flows card's editor on it;
 *   'sequence' | 'prospect_list' | 'eval_suite'  that page's card on it;
 *   'team-chat'       the team chat page;
 *   null              nothing opens it on its own.
 */
export type EntityOpen = 'record' | 'calendar-event' | 'flow' | 'sequence' | 'prospect_list' | 'eval_suite' | 'team-chat' | null

/**
 * How a kind archives and comes back, as it already does:
 *   status  a status column: `archived` is the archived value, `restore` the
 *           one it comes back to. `via: 'delete'` archives through the route's
 *           DELETE (documents and captures: the DELETE without `permanent`
 *           archives, under the delete rule), `'patch'` through PATCH
 *           `{ status }`. `restorePrevious`: the status means more than
 *           "not archived" (an initiative's planned/active/completed), so an
 *           undo puts the one it had back, and `restore` is only the fallback.
 *   flag    a boolean column (a project's `is_archived`), PATCHed.
 *   none    no archive; `why` says what the kind does instead.
 */
export type EntityArchive =
  | { kind: 'status'; route: string; via: 'delete' | 'patch'; archived: string; restore: string; restorePrevious: boolean }
  | { kind: 'flag'; route: string; column: 'is_archived' }
  | { kind: 'none'; why: string }

export interface EntityActionsDescriptor {
  /** Where Open lands, or null. */
  readonly open: EntityOpen
  /** It has a boot deep link, `/account?<kind>=<id>` (Copy link). Needs an `open`. */
  readonly link: boolean
  /**
   * Rename: PATCH `/api/account/<route>/<id>` with `{ [field]: title }`. The
   * field is the kind's title column (the registry's label column). Null: not
   * renamed from a menu (its title is edited where it lives, or it has none).
   */
  readonly rename: { route: string; field: string } | null
  readonly archive: EntityArchive
  /** Share to a team-chat channel: a message that @-mentions it (writes the `mentions` edge). A mentionable kind with an `open`. */
  readonly share: boolean
  /** Make a task from this: a new action linked `about` it (POST /api/account/actions `about`). A mentionable kind. */
  readonly makeTask: boolean
}

/** A kind none of the menu's actions apply to (Copy ID still does): a part of something else, or not a thing people open. */
const inert = (why: string): EntityActionsDescriptor => ({
  open: null,
  link: false,
  rename: null,
  archive: { kind: 'none', why },
  share: false,
  makeTask: false,
})

export const ENTITY_ACTIONS: Readonly<Record<EntityType, EntityActionsDescriptor>> = {
  action: {
    open: 'record',
    link: true,
    rename: { route: 'actions', field: 'title' },
    // A task is closed by moving it to a done or canceled state on its board;
    // deleting it (owner or admin) stays in its panel.
    archive: { kind: 'none', why: 'A task is closed by moving it to a done or canceled state.' },
    share: true,
    // A task about a task is a sub-task, which its own panel makes.
    makeTask: false,
  },
  document: {
    open: 'record',
    link: true,
    rename: { route: 'documents', field: 'title' },
    // DELETE without ?permanent archives (status 'archived') under the delete
    // rule; PATCH { status: 'active' } puts it back (src/lib/documents/archive.ts).
    archive: { kind: 'status', route: 'documents', via: 'delete', archived: 'archived', restore: 'active', restorePrevious: false },
    share: true,
    makeTask: true,
  },
  capture: {
    open: 'record',
    link: true,
    rename: { route: 'captures', field: 'title' },
    // DELETE without ?permanent archives its owner's capture (archive_capture's status).
    archive: { kind: 'status', route: 'captures', via: 'delete', archived: 'archived', restore: 'active', restorePrevious: false },
    share: true,
    makeTask: true,
  },
  project: {
    open: 'record',
    link: true,
    rename: { route: 'projects', field: 'name' },
    archive: { kind: 'flag', route: 'projects', column: 'is_archived' },
    share: true,
    makeTask: true,
  },
  initiative: {
    open: 'record',
    link: true,
    rename: { route: 'initiatives', field: 'name' },
    // The initiative_status enum's 'archived' (migration 023), as its status picker sets it.
    archive: { kind: 'status', route: 'initiatives', via: 'patch', archived: 'archived', restore: 'active', restorePrevious: true },
    share: true,
    makeTask: true,
  },
  contact: {
    open: 'record',
    link: true,
    rename: { route: 'contacts', field: 'full_name' },
    archive: { kind: 'none', why: 'A contact is merged or deleted, never archived: every CRM read would have to learn to hide one.' },
    share: true,
    makeTask: true,
  },
  company: {
    open: 'record',
    link: true,
    rename: { route: 'companies', field: 'name' },
    archive: { kind: 'none', why: 'A company is deleted by an owner or admin, never archived.' },
    share: true,
    makeTask: true,
  },
  deal: {
    open: 'record',
    link: true,
    rename: { route: 'deals', field: 'name' },
    archive: { kind: 'none', why: 'A deal ends in a won or lost stage.' },
    share: true,
    makeTask: true,
  },
  flow: {
    open: 'flow',
    link: true,
    rename: { route: 'flows', field: 'name' },
    archive: { kind: 'none', why: 'A loop is switched off (enabled) in its editor.' },
    share: true,
    makeTask: true,
  },
  campaign: {
    // No card draws a campaign on its own (its page lists them).
    open: null,
    link: false,
    rename: { route: 'campaigns', field: 'name' },
    // Retiring a campaign is status 'archived' (its route has no DELETE).
    archive: { kind: 'status', route: 'campaigns', via: 'patch', archived: 'archived', restore: 'paused', restorePrevious: true },
    share: false,
    makeTask: true,
  },
  calendar_event: {
    open: 'calendar-event',
    link: false,
    // Its title is the calendar provider's, written through the event's own panel.
    rename: null,
    archive: { kind: 'none', why: "A calendar event is the provider's: it is deleted there." },
    // Private to its owner: a channel could not open it.
    share: false,
    makeTask: true,
  },
  decision: {
    open: null,
    link: false,
    rename: null,
    archive: { kind: 'none', why: 'A decision is confirmed or dismissed on its capture.' },
    share: false,
    makeTask: true,
  },
  team_chat_channel: {
    open: 'team-chat',
    link: false,
    rename: null,
    archive: { kind: 'none', why: 'A channel has no archive route yet.' },
    share: false,
    makeTask: false,
  },
  team_chat_message: {
    open: 'team-chat',
    link: false,
    // A message is edited by its author in the channel.
    rename: null,
    archive: { kind: 'none', why: 'A message is deleted by its author in the channel.' },
    share: false,
    makeTask: true,
  },
  sequence: {
    open: 'sequence',
    link: true,
    rename: { route: 'sequences', field: 'name' },
    // Archiving ends every active enrollment, which no undo brings back: it stays on the sequence's own page.
    archive: { kind: 'none', why: "Archiving a sequence ends its enrollments for good, so it stays on the sequence's page." },
    share: false,
    makeTask: false,
  },
  prospect_list: {
    open: 'prospect_list',
    link: true,
    rename: { route: 'prospecting/lists', field: 'name' },
    archive: { kind: 'status', route: 'prospecting/lists', via: 'patch', archived: 'archived', restore: 'active', restorePrevious: false },
    share: false,
    makeTask: false,
  },
  eval_suite: {
    open: 'eval_suite',
    link: false,
    rename: null,
    archive: { kind: 'none', why: 'A suite is deleted from its own page.' },
    share: false,
    makeTask: false,
  },

  // ── Parts of something else, or nothing a person opens on its own.
  claim: inert('A fact is confirmed, disputed or superseded in Knowledge.'),
  cycle: inert("A cycle is its team's, run from the board."),
  email_thread: inert('Mail is shown to no one but its owner.'),
  attachment: inert('An attachment lives on its record.'),
  member: inert('A member is a person in the workspace.'),
  conversation: inert("A chat with the agent is its person's own."),
  milestone: inert('A milestone lives on its project.'),
  comment: inert('A comment lives on its record.'),
  label: inert('Labels are kept in settings.'),
  workflow_state: inert("A board column is its team's."),
  team: inert('Teams are kept in their own page.'),
  recipe: inert('Skills are kept in the library.'),
  flow_run: inert("A run is its loop's history."),
  email_draft: inert('A draft lives with its mail.'),
  contact_interaction: inert("An interaction is its contact's history."),
  agent_run: inert("An agent's run is its task's history."),
  capture_participant: inert('A participant lives on its capture.'),
  sequence_enrollment: inert('An enrollment lives on its sequence.'),
  prospect_list_entry: inert('A candidate lives on its list.'),
  eval_case: inert('A case lives on its suite.'),
  eval_run: inert('A run lives on its suite.'),
}

/** The menu's actions, in the order it lists them. */
export const ENTITY_ACTION_IDS = ['open', 'copy_link', 'copy_id', 'rename', 'share', 'make_task', 'archive', 'restore'] as const
export type EntityActionId = (typeof ENTITY_ACTION_IDS)[number]

export function entityActionsDescriptor(type: string): EntityActionsDescriptor | undefined {
  return (ENTITY_ACTIONS as Record<string, EntityActionsDescriptor | undefined>)[type]
}

/** What a caller knows about the record beyond its kind: whether it is archived (null: unknown). */
export interface EntityActionState {
  archived?: boolean | null
  /** The surface can open cards (a chat is there to open them in). Default true. */
  canOpen?: boolean
}

/**
 * The actions a record of `type` offers, in menu order. Copy ID always (any
 * registered kind); the rest as the kind declares. Archive XOR Restore: a
 * record known to be archived offers Restore, any other Archive.
 */
export function supportedEntityActions(type: string, state: EntityActionState = {}): EntityActionId[] {
  const d = entityActionsDescriptor(type)
  if (!d) return []
  const canOpen = state.canOpen !== false
  const out: EntityActionId[] = []
  if (d.open && canOpen) out.push('open')
  if (d.link && d.open) out.push('copy_link')
  out.push('copy_id')
  if (d.rename) out.push('rename')
  if (d.share && d.open && isMentionableType(type)) out.push('share')
  if (d.makeTask && isMentionableType(type)) out.push('make_task')
  if (d.archive.kind !== 'none') out.push(state.archived ? 'restore' : 'archive')
  return out
}

/** The kinds with a boot deep link, `/account?<kind>=<id>`: the main chat reads exactly these. */
export const DEEP_LINK_TYPES: readonly EntityType[] = (Object.keys(ENTITY_ACTIONS) as EntityType[]).filter(
  (t) => ENTITY_ACTIONS[t].link && ENTITY_ACTIONS[t].open !== null,
)

/** A record's link (its boot deep link on `origin`), or null for a kind with none. */
export function entityLink(type: string, id: string, origin: string): string | null {
  if (!(DEEP_LINK_TYPES as readonly string[]).includes(type)) return null
  return `${origin.replace(/\/$/, '')}/account?${encodeURIComponent(type)}=${encodeURIComponent(id)}`
}

/** What Copy ID copies: "<kind> <uuid>", for pasting into a prompt (the agent routes it by kind). */
export const entityIdText = (type: string, id: string) => `${type} ${id}`

/** Is this row archived, read the kind's own way (a row of a kind with no archive never is)? */
export function isArchivedRow(type: string, row: Record<string, unknown> | null | undefined): boolean {
  const a = entityActionsDescriptor(type)?.archive
  if (!a || !row) return false
  if (a.kind === 'status') return row.status === a.archived
  if (a.kind === 'flag') return row[a.column] === true
  return false
}
