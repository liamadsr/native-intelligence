/**
 * The entity-type registry — ONE declaration of every kind of thing in the
 * app (task, doc, contact, deal, calendar event, team-chat message, …) and
 * everything the rest of the codebase needs to know about it.
 *
 * Every other kind vocabulary is derived from this list or typed as a subset
 * of `EntityType`, so a kind that is not registered here does not compile:
 *   - `EntityKind` (src/lib/entity-events.ts) is `EntityType` plus the one
 *     non-entity cache kind, `entity_link`;
 *   - the realtime table map (src/hooks/use-realtime-entities.ts) is every
 *     entry with `realtime: true`;
 *   - the activity log's kinds (`ACTIVITY_ENTITY_TYPES`, migration 488's
 *     triggers, the feed) are every entry with `activity: true`;
 *   - detail-page siblings, proposed-change targets and the composer's
 *     search kinds are `EntityType` subsets;
 *   - how each kind is opened and acted on (the one entity actions menu) is
 *     `ENTITY_ACTIONS` in src/lib/entities/entity-actions-registry.ts, a
 *     `Record<EntityType, …>`: registering a kind here without deciding there
 *     does not compile.
 * Knowledge-graph membership is the `linkable` flag: a kind registered for the
 * other vocabularies but not linkable never becomes a graph endpoint.
 *
 * Before this module the same vocabulary was re-declared five times, each copy
 * drifting from the others:
 *   - `LINKABLE_ENTITY_TYPES` + `WORKSPACE_SCOPED_TABLE` + `LABEL_TABLE` in
 *     src/lib/ai/tools/claims.ts,
 *   - `CITABLE_SOURCE_TYPES` in src/lib/ai/claim-provenance.ts,
 *   - `ENTITY_TYPES` / `RELATIONS` in src/lib/ai/tools/entity-links.ts (which
 *     had drifted to a 7-member subset-plus-`milestone`, so `unlink_entities`
 *     could not remove a link `link_entities` had just created),
 *   - `WORK_RESOURCE_TYPES` in src/lib/agent-run/types.ts, hand-copied because
 *     claims.ts is server code and that module is client-bundled.
 *
 * CLIENT-BUNDLE SAFE — this is a hard constraint, not a preference. This module
 * must contain ONLY plain data and pure functions over plain objects: no
 * Supabase client, no `embed()`, no Inngest, no `server-only`, no I/O. That is
 * what lets src/lib/agent-run/types.ts (client-bundled) derive
 * `WORK_RESOURCE_TYPES` from here by import instead of by hand-copy.
 *
 * ADDING A TYPE IS A ONE-ENTRY CHANGE: append one descriptor to
 * `ENTITY_REGISTRY`. Every derived vocabulary below (and the `EntityType`
 * union) follows. The two things it does NOT follow are in Postgres and must
 * be widened by hand in the same PR:
 *   1. the `claim_source.source_type` CHECK constraint (latest widen: migration
 *      264) — must list every `citable` type;
 *   2. the `claim_neighborhood` label CASE + LEFT JOIN (latest full definition:
 *      migration 267, previously 264/223) — one `WHEN`/`LEFT JOIN` pair per
 *      type that should render a label.
 */

/** How a claim/edge endpoint of this type is proven to live in a workspace. */
export type WorkspaceScope =
  /** The table carries its own `workspace_id` column — cheap direct check. */
  | { kind: 'column'; table: string }
  /**
   * No `workspace_id` column; the row is fenced through a parent (a cycle via
   * its team, a milestone via its project). `entityInWorkspace` can't verify
   * these and falls back to can't-verify→allow; callers that need a stricter
   * fence implement it themselves (see attention-items' resourceIdInWorkspace).
   */
  | { kind: 'indirect'; via: string }

export interface AnchorDescriptor {
  /**
   * Columns to select when building this anchor's embedding text. Kept
   * alongside `embedText` so a caller can issue the query without knowing the
   * shape the composer wants.
   */
  embedTextColumns: readonly string[]
  /**
   * Compose the anchor's descriptive text from a plain row. Pure — never
   * touches the network (this module is client-bundled).
   */
  embedText: (row: Record<string, unknown>) => string
  /** At or above this similarity, a claim anchors to the entity automatically. */
  autoThreshold: number
  /** Below this, the candidate is not even worth a judge call. */
  floorThreshold: number
}

export interface EntityTypeDescriptor {
  /** The wire value used in `entity_link.source_type`/`target_type`, `claim_source.source_type`, tool enums. */
  readonly id: string
  /** Underlying Postgres table. */
  readonly table: string
  readonly workspaceScoped: WorkspaceScope
  readonly label: {
    /** Table to read the label from (normally === `table`). */
    table: string
    /** Comma-separated select list for the label query. */
    columns: string
    render: (row: Record<string, unknown>) => string
  }
  /**
   * The kind's own table streams through the shared Supabase Realtime channel
   * (src/hooks/use-realtime-entities.ts) onto the `ni:entity-*` bus. True
   * requires the table to be in the `supabase_realtime` publication with
   * REPLICA IDENTITY FULL (migration 187). The binding is filtered by
   * workspace_id when `workspaceScoped` is a column, unfiltered (RLS-gated)
   * otherwise. False for tables that are too churny for the shared channel
   * (email) or that run their own channel (team chat).
   */
  readonly realtime: boolean
  /** Valid as an `entity_link` endpoint / `link_entities` argument. */
  readonly linkable: boolean
  /**
   * The activity log records this kind: its rows are `entity_activity`
   * entities, written by Postgres triggers on its table (migration 488), so
   * every writer (the app, agents, MCP, cron, service role) is covered. Read
   * through the one cross-kind feed (GET /api/account/feed: the Inbox, Recent,
   * a record's History). True requires a trigger pair on `table` in the
   * migration, and the kind in its `kinds` list. False for kinds too churny
   * to log (mail, calendar syncs, claims), for kinds outside the product's
   * lists, and for kinds whose activity is another kind's (a comment is
   * 'commented' on what it's on). team_chat_message logs its member
   * @-mentions only: a chat is its own log.
   */
  readonly activity: boolean
  /**
   * A workspace may define its own fields on this kind (text, number, date,
   * select: src/lib/crm/custom-fields.ts). The definitions live in
   * `custom_field_definition` (migration 473), whose `entity_type` CHECK lists
   * exactly these kinds (latest widen: migration 496); the values live in a
   * `custom_fields` jsonb object on `table`, keyed by each definition's `key`.
   * True requires that column (default '{}', an object CHECK) and the kind in
   * the CHECK; the record's detail panel shows the fields (CustomFieldsGroup)
   * and the agent's define_custom_field / set_custom_fields take the kind.
   */
  readonly customFields: boolean
  /**
   * A claim may cite this type: provenance mirrors into `claim_source` AND
   * `entity_link`. Superset of `sourceable` — `project`/`contact`/`action` are
   * citable via the links[] cross-populate path only.
   */
  readonly citable: boolean
  /**
   * Accepted directly in `create_claim`'s `sources[].source_type` zod enum.
   * Deliberately NARROWER than `citable` (widening it is a behavior change to
   * the tool surface, out of scope here).
   */
  readonly sourceable: boolean
  /** Anchoring configuration; absent for types that are not anchor candidates. */
  readonly anchor?: AnchorDescriptor
}

const str = (v: unknown): string => String(v ?? '').trim()

/** Join the non-empty pieces of an anchor's embedding text. */
const compose = (...parts: unknown[]): string =>
  parts
    .map(str)
    .filter(Boolean)
    .join('\n')

/** A `text[]` column as one comma-joined line; anything else renders empty. */
const arrayText = (v: unknown): string =>
  Array.isArray(v) ? v.map(str).filter(Boolean).join(', ') : ''

/**
 * Enrichment blobs live in `metadata.enrichment` (mig 239). Flatten the
 * string-ish leaves so the anchor text carries what the Exa research found
 * without this module knowing the blob's schema.
 */
function enrichmentText(metadata: unknown, maxChars = 1200): string {
  if (!metadata || typeof metadata !== 'object') return ''
  const blob = (metadata as Record<string, unknown>).enrichment
  if (!blob || typeof blob !== 'object') return ''
  const out: string[] = []
  const walk = (v: unknown, depth: number) => {
    if (out.join(' ').length > maxChars || depth > 3) return
    if (typeof v === 'string') {
      const s = v.trim()
      if (s) out.push(s)
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1)
    } else if (v && typeof v === 'object') {
      for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1)
    }
  }
  walk(blob, 0)
  return out.join('\n').slice(0, maxChars)
}

/**
 * THE registry. One entry per entity type; order is load-bearing only in that
 * it fixes the order of every derived tuple (and therefore the order asserted
 * by the agent-run parity test).
 */
export const ENTITY_REGISTRY = [
  {
    id: 'document',
    table: 'document',
    workspaceScoped: { kind: 'column', table: 'document' },
    label: { table: 'document', columns: 'title', render: (r) => str(r.title) },
    realtime: true,
    linkable: true,
    activity: true,
    customFields: true,
    citable: true,
    sourceable: true,
  },
  {
    id: 'claim',
    table: 'claim',
    workspaceScoped: { kind: 'column', table: 'claim' },
    label: { table: 'claim', columns: 'text', render: (r) => str(r.text).slice(0, 140) },
    realtime: true,
    linkable: true,
    activity: false,
    customFields: false,
    citable: false,
    sourceable: false,
  },
  {
    id: 'capture',
    table: 'captures',
    workspaceScoped: { kind: 'column', table: 'captures' },
    label: { table: 'captures', columns: 'title', render: (r) => str(r.title) },
    realtime: true,
    linkable: true,
    activity: true,
    customFields: false,
    citable: true,
    sourceable: true,
  },
  {
    id: 'contact',
    table: 'contact',
    workspaceScoped: { kind: 'column', table: 'contact' },
    label: { table: 'contact', columns: 'full_name', render: (r) => str(r.full_name) },
    realtime: true,
    linkable: true,
    activity: true,
    customFields: true,
    citable: true,
    sourceable: false,
    // Contact anchoring already works through the `committed_to` relation; the
    // descriptor exists so the pooled judge can score contact candidates in the
    // same pass as the other anchor types.
    anchor: {
      embedTextColumns: ['full_name', 'title', 'email', 'notes'],
      embedText: (r) => compose(r.full_name, r.title, r.email, r.notes),
      autoThreshold: 0.85,
      floorThreshold: 0.5,
    },
  },
  {
    id: 'project',
    table: 'projects',
    workspaceScoped: { kind: 'column', table: 'projects' },
    label: { table: 'projects', columns: 'name', render: (r) => str(r.name) },
    realtime: true,
    linkable: true,
    activity: true,
    customFields: true,
    citable: true,
    sourceable: false,
    anchor: {
      embedTextColumns: ['name', 'description'],
      embedText: (r) => compose(r.name, r.description),
      autoThreshold: 0.85,
      floorThreshold: 0.5,
    },
  },
  {
    id: 'action',
    table: 'actions',
    workspaceScoped: { kind: 'column', table: 'actions' },
    label: { table: 'actions', columns: 'title', render: (r) => str(r.title) },
    realtime: true,
    linkable: true,
    activity: true,
    customFields: true,
    citable: true,
    sourceable: false,
  },
  {
    id: 'initiative',
    table: 'initiative',
    workspaceScoped: { kind: 'column', table: 'initiative' },
    label: { table: 'initiative', columns: 'name', render: (r) => str(r.name) },
    realtime: true,
    linkable: true,
    activity: true,
    customFields: true,
    citable: false,
    sourceable: false,
  },
  {
    id: 'cycle',
    table: 'cycle',
    // No workspace_id column — fenced through its team.
    workspaceScoped: { kind: 'indirect', via: 'team' },
    label: { table: 'cycle', columns: 'name', render: (r) => str(r.name) },
    realtime: true,
    linkable: true,
    activity: false,
    customFields: false,
    citable: false,
    sourceable: false,
  },
  {
    id: 'email',
    // No stored mail (2026-10-15): an email is its thread's index row, and its
    // label names the sender, never the subject (email_message is dropped by 344).
    table: 'email_thread_index',
    workspaceScoped: { kind: 'column', table: 'email_thread_index' },
    label: { table: 'email_thread_index', columns: 'from_email', render: (r) => str(r.from_email) },
    realtime: false,
    linkable: true,
    activity: false,
    customFields: false,
    // Native Intelligence doesn't learn from mail (2026-10-15, migration 341): a claim may
    // never cite an email, so no claim_source row, no mirrored cites edge, no
    // `create_claim` source. Kept linkable so a work item's declared resources
    // still round-trip; claim reads drop email neighbours and never resolve
    // their labels (a subject is one person's mail).
    citable: false,
    sourceable: false,
  },
  {
    id: 'attachment',
    table: 'attachments',
    workspaceScoped: { kind: 'column', table: 'attachments' },
    label: { table: 'attachments', columns: 'file_name', render: (r) => str(r.file_name) },
    realtime: false,
    linkable: true,
    activity: false,
    customFields: false,
    citable: true,
    sourceable: true,
  },
  {
    id: 'member',
    table: 'member',
    workspaceScoped: { kind: 'column', table: 'member' },
    label: { table: 'member', columns: 'display_name', render: (r) => str(r.display_name) },
    realtime: true,
    linkable: true,
    activity: false,
    customFields: false,
    citable: false,
    sourceable: false,
  },
  {
    id: 'conversation',
    table: 'chat_conversations',
    workspaceScoped: { kind: 'column', table: 'chat_conversations' },
    label: { table: 'chat_conversations', columns: 'title', render: (r) => str(r.title) },
    realtime: false,
    linkable: true,
    activity: false,
    customFields: false,
    citable: true,
    sourceable: true,
  },
  {
    id: 'company',
    table: 'company',
    workspaceScoped: { kind: 'column', table: 'company' },
    label: { table: 'company', columns: 'name', render: (r) => str(r.name) },
    realtime: true,
    linkable: true,
    activity: true,
    customFields: true,
    citable: true,
    sourceable: false,
    anchor: {
      embedTextColumns: ['name', 'domain', 'industry', 'description', 'metadata'],
      embedText: (r) =>
        compose(r.name, r.domain, r.industry, r.description, enrichmentText(r.metadata)),
      // Provisional, pending a tuning pass against real claim/company pairs.
      autoThreshold: 0.85,
      floorThreshold: 0.5,
    },
  },
  {
    id: 'campaign',
    table: 'campaign',
    workspaceScoped: { kind: 'column', table: 'campaign' },
    label: { table: 'campaign', columns: 'name', render: (r) => str(r.name) },
    realtime: false,
    linkable: true,
    activity: false,
    customFields: false,
    citable: true,
    sourceable: false,
    anchor: {
      embedTextColumns: ['name', 'objective', 'description', 'channels'],
      embedText: (r) =>
        compose(r.name, r.objective, r.description, arrayText(r.channels)),
      // Provisional, mirroring company's numbers — nothing here is tuned yet.
      autoThreshold: 0.85,
      floorThreshold: 0.5,
    },
  },
  {
    id: 'milestone',
    table: 'milestone',
    // No workspace_id column — fenced through its project.
    workspaceScoped: { kind: 'indirect', via: 'projects' },
    label: { table: 'milestone', columns: 'name', render: (r) => str(r.name) },
    realtime: true,
    linkable: true,
    activity: false,
    customFields: false,
    citable: false,
    sourceable: false,
  },

  // ── Graph kinds added with the shared entity layer (2026-11-09). Linkable so
  // they can be linked and @mentioned; not citable, so the claim_source CHECK
  // (migration 264) and claim_neighborhood need no widening. Both are readable
  // by every workspace member (is_workspace_member RLS), so the graph's
  // workspace_id fence and service-role label reads (claims.ts resolveLabels)
  // show nothing a member couldn't already see.
  {
    id: 'deal',
    table: 'deal',
    workspaceScoped: { kind: 'column', table: 'deal' },
    label: { table: 'deal', columns: 'name', render: (r) => str(r.name) },
    realtime: true,
    linkable: true,
    activity: true,
    customFields: true,
    citable: false,
    sourceable: false,
  },
  {
    id: 'flow',
    table: 'flow',
    workspaceScoped: { kind: 'column', table: 'flow' },
    label: { table: 'flow', columns: 'name', render: (r) => str(r.name) },
    realtime: true,
    linkable: true,
    activity: true,
    customFields: false,
    citable: false,
    sourceable: false,
  },

  // ── The PRIVATE graph kinds (phase 2 of the shared entity layer, 2026-11-09).
  // Only some members may read each, so the graph's workspace_id fence is not
  // enough; each has its own fence in src/lib/knowledge/entity-fences.ts, wired
  // into FENCED_LABEL_TYPES / resolveLabels and entityInWorkspace (claims.ts)
  // and resourceIdInWorkspace (work/start-work-item.ts):
  //   calendar_event — private to its owner (RLS auth.uid() = user_id);
  //   team_chat_*    — DMs and team channels are readable only through
  //                    team_chat_can_read (migration 474);
  //   decision       — no workspace_id; fenced through its capture's workspace
  //                    and visibility (the decision table's RLS).
  // A kind joins the graph (linkable) only once its fence is in all three.
  // None is citable: the claim_source CHECK (264) does not list them.
  {
    id: 'calendar_event',
    table: 'local_calendar_event',
    workspaceScoped: { kind: 'column', table: 'local_calendar_event' },
    label: { table: 'local_calendar_event', columns: 'title', render: (r) => str(r.title) },
    realtime: true,
    linkable: true,
    activity: false,
    customFields: false,
    citable: false,
    sourceable: false,
  },
  {
    id: 'decision',
    table: 'decision',
    // No workspace_id column — fenced through its capture.
    workspaceScoped: { kind: 'indirect', via: 'captures' },
    label: { table: 'decision', columns: 'content', render: (r) => str(r.content).slice(0, 140) },
    realtime: true,
    linkable: true,
    activity: false,
    customFields: false,
    citable: false,
    sourceable: false,
  },
  {
    id: 'team_chat_channel',
    table: 'team_chat_channel',
    workspaceScoped: { kind: 'column', table: 'team_chat_channel' },
    label: { table: 'team_chat_channel', columns: 'name', render: (r) => str(r.name) },
    // Team chat runs its own channel (src/lib/team-chat), not the shared one.
    realtime: false,
    linkable: true,
    activity: false,
    customFields: false,
    citable: false,
    sourceable: false,
  },
  {
    id: 'team_chat_message',
    table: 'team_chat_message',
    workspaceScoped: { kind: 'column', table: 'team_chat_message' },
    label: { table: 'team_chat_message', columns: 'body', render: (r) => str(r.body).slice(0, 140) },
    realtime: false,
    linkable: true,
    activity: true,
    customFields: false,
    citable: false,
    sourceable: false,
  },

  // ── Tables (2026-11-10, migrations 520 and 521): a workspace's own databases
  // and their rows. Private-capable (a private table is its owner's and its
  // grantees'), so both are fenced in src/lib/knowledge/entity-fences.ts; a
  // row follows its table. Not customFields: a row's values ARE the table's
  // columns (custom_field_definition rows with a table_id, entity_type
  // 'data_row'), written only through apply_data_ops so every change is in
  // the table's undo log, never through set_custom_fields. Only the table is
  // realtime: every write batch bumps its version, one event per batch.
  {
    id: 'data_table',
    table: 'data_table',
    workspaceScoped: { kind: 'column', table: 'data_table' },
    label: { table: 'data_table', columns: 'name', render: (r) => str(r.name) },
    realtime: true,
    linkable: true,
    activity: true,
    customFields: false,
    citable: false,
    sourceable: false,
  },
  {
    id: 'data_row',
    table: 'data_row',
    workspaceScoped: { kind: 'column', table: 'data_row' },
    label: { table: 'data_row', columns: 'title', render: (r) => str(r.title).slice(0, 140) || 'Untitled' },
    realtime: false,
    linkable: true,
    activity: true,
    customFields: false,
    citable: false,
    sourceable: false,
  },

  // ── Kinds outside the knowledge graph: registered so every other vocabulary
  // (the entity event bus, realtime, menus) derives from this one list.
  {
    id: 'comment',
    table: 'comment',
    // No workspace_id column — fenced through the commented-on entity.
    workspaceScoped: { kind: 'indirect', via: 'commentable' },
    label: { table: 'comment', columns: 'body', render: (r) => str(r.body).slice(0, 140) },
    realtime: true,
    linkable: false,
    activity: false,
    customFields: false,
    citable: false,
    sourceable: false,
  },
  {
    id: 'label',
    table: 'label',
    workspaceScoped: { kind: 'column', table: 'label' },
    label: { table: 'label', columns: 'name', render: (r) => str(r.name) },
    realtime: true,
    linkable: false,
    activity: false,
    customFields: false,
    citable: false,
    sourceable: false,
  },
  {
    id: 'workflow_state',
    table: 'workflow_state',
    // No workspace_id column — fenced through its team.
    workspaceScoped: { kind: 'indirect', via: 'team' },
    label: { table: 'workflow_state', columns: 'name', render: (r) => str(r.name) },
    realtime: true,
    linkable: false,
    activity: false,
    customFields: false,
    citable: false,
    sourceable: false,
  },
  {
    id: 'team',
    table: 'team',
    workspaceScoped: { kind: 'column', table: 'team' },
    label: { table: 'team', columns: 'name', render: (r) => str(r.name) },
    realtime: true,
    linkable: false,
    activity: false,
    customFields: false,
    citable: false,
    sourceable: false,
  },
  {
    id: 'recipe',
    table: 'recipe',
    workspaceScoped: { kind: 'column', table: 'recipe' },
    label: { table: 'recipe', columns: 'name', render: (r) => str(r.name) },
    realtime: true,
    linkable: false,
    activity: false,
    customFields: false,
    citable: false,
    sourceable: false,
  },
  {
    id: 'flow_run',
    table: 'flow_run',
    // No workspace_id column — fenced through its flow.
    workspaceScoped: { kind: 'indirect', via: 'flow' },
    label: { table: 'flow_run', columns: 'status', render: (r) => str(r.status) },
    realtime: true,
    linkable: false,
    activity: false,
    customFields: false,
    citable: false,
    sourceable: false,
  },
  {
    id: 'email_draft',
    table: 'email_draft',
    workspaceScoped: { kind: 'column', table: 'email_draft' },
    label: { table: 'email_draft', columns: 'subject', render: (r) => str(r.subject) },
    realtime: true,
    linkable: false,
    activity: false,
    customFields: false,
    citable: false,
    sourceable: false,
  },
  {
    id: 'contact_interaction',
    table: 'contact_interaction',
    workspaceScoped: { kind: 'column', table: 'contact_interaction' },
    label: { table: 'contact_interaction', columns: 'title', render: (r) => str(r.title) },
    realtime: true,
    linkable: false,
    activity: false,
    customFields: false,
    citable: false,
    sourceable: false,
  },
  {
    id: 'agent_run',
    table: 'agent_run',
    workspaceScoped: { kind: 'column', table: 'agent_run' },
    label: { table: 'agent_run', columns: 'task_prompt', render: (r) => str(r.task_prompt).slice(0, 140) },
    realtime: true,
    linkable: false,
    activity: false,
    customFields: false,
    citable: false,
    sourceable: false,
  },
  {
    id: 'capture_participant',
    table: 'capture_participant',
    // No workspace_id column — fenced through its capture.
    workspaceScoped: { kind: 'indirect', via: 'captures' },
    label: { table: 'capture_participant', columns: 'external_name', render: (r) => str(r.external_name) },
    realtime: true,
    linkable: false,
    activity: false,
    customFields: false,
    citable: false,
    sourceable: false,
  },
  {
    id: 'sequence',
    table: 'sequence',
    workspaceScoped: { kind: 'column', table: 'sequence' },
    label: { table: 'sequence', columns: 'name', render: (r) => str(r.name) },
    realtime: true,
    linkable: false,
    activity: false,
    customFields: false,
    citable: false,
    sourceable: false,
  },
  {
    id: 'sequence_enrollment',
    table: 'sequence_enrollment',
    workspaceScoped: { kind: 'column', table: 'sequence_enrollment' },
    label: { table: 'sequence_enrollment', columns: 'contact_email', render: (r) => str(r.contact_email) },
    realtime: true,
    linkable: false,
    activity: false,
    customFields: false,
    citable: false,
    sourceable: false,
  },
  {
    id: 'prospect_list',
    table: 'prospect_list',
    workspaceScoped: { kind: 'column', table: 'prospect_list' },
    label: { table: 'prospect_list', columns: 'name', render: (r) => str(r.name) },
    // Not in the supabase_realtime publication.
    realtime: false,
    linkable: false,
    activity: false,
    customFields: false,
    citable: false,
    sourceable: false,
  },
  {
    id: 'prospect_list_entry',
    table: 'prospect_list_entry',
    workspaceScoped: { kind: 'column', table: 'prospect_list_entry' },
    label: { table: 'prospect_list_entry', columns: 'candidate_key', render: (r) => str(r.candidate_key) },
    realtime: false,
    linkable: false,
    activity: false,
    customFields: false,
    citable: false,
    sourceable: false,
  },
  {
    id: 'eval_suite',
    table: 'eval_suite',
    workspaceScoped: { kind: 'column', table: 'eval_suite' },
    label: { table: 'eval_suite', columns: 'name', render: (r) => str(r.name) },
    realtime: true,
    linkable: false,
    activity: false,
    customFields: false,
    citable: false,
    sourceable: false,
  },
  {
    id: 'eval_case',
    table: 'eval_case',
    workspaceScoped: { kind: 'column', table: 'eval_case' },
    label: { table: 'eval_case', columns: 'name', render: (r) => str(r.name) },
    realtime: true,
    linkable: false,
    activity: false,
    customFields: false,
    citable: false,
    sourceable: false,
  },
  {
    id: 'eval_run',
    table: 'eval_run',
    workspaceScoped: { kind: 'column', table: 'eval_run' },
    label: { table: 'eval_run', columns: 'status', render: (r) => str(r.status) },
    realtime: true,
    linkable: false,
    activity: false,
    customFields: false,
    citable: false,
    sourceable: false,
  },
] as const satisfies readonly EntityTypeDescriptor[]

/** The union of every registered type id — derived, never hand-written. */
export type EntityType = (typeof ENTITY_REGISTRY)[number]['id']

/**
 * A feature's subset of kinds, checked against the registry: an unregistered
 * or misspelled name is a type error (unlike `Extract`, which drops it).
 */
export type EntityTypeSubset<T extends EntityType> = T

export const ENTITY_REGISTRY_BY_ID: Readonly<Record<EntityType, EntityTypeDescriptor>> =
  Object.fromEntries(ENTITY_REGISTRY.map((e) => [e.id, e])) as Record<
    EntityType,
    EntityTypeDescriptor
  >

export function entityDescriptor(type: string): EntityTypeDescriptor | undefined {
  return ENTITY_REGISTRY_BY_ID[type as EntityType]
}

/**
 * `z.enum()` needs a non-empty tuple, and TS cannot narrow a `.filter().map()`
 * back to one. The VALUE is derived from the registry (so it can never drift);
 * only its tuple-ness is asserted. The element type stays the precise
 * `EntityType` union, so every `z.enum()` call site keeps full literal typing.
 */
function tuple<T extends string>(values: readonly T[]): readonly [T, ...T[]] {
  return values as unknown as readonly [T, ...T[]]
}

const idsWhere = (pred: (e: EntityTypeDescriptor) => boolean) =>
  tuple(ENTITY_REGISTRY.filter(pred).map((e) => e.id as EntityType))

/** Every type valid as an `entity_link` endpoint. */
export const LINKABLE_ENTITY_TYPES = idsWhere((e) => e.linkable)
export type LinkableEntityType = (typeof LINKABLE_ENTITY_TYPES)[number]

/** Every kind the activity log records (entity_activity.entity_type), in registry order. */
export const ACTIVITY_ENTITY_TYPES = idsWhere((e) => e.activity)
export type ActivityEntityType = (typeof ACTIVITY_ENTITY_TYPES)[number]

export function isActivityEntityType(type: unknown): type is ActivityEntityType {
  return typeof type === 'string' && (ACTIVITY_ENTITY_TYPES as readonly string[]).includes(type)
}

/** Every kind a workspace may define custom fields on (custom_field_definition.entity_type), in registry order. */
export type CustomFieldEntityType = Extract<(typeof ENTITY_REGISTRY)[number], { readonly customFields: true }>['id']
export const CUSTOM_FIELD_ENTITY_TYPES = idsWhere((e) => e.customFields) as readonly [CustomFieldEntityType, ...CustomFieldEntityType[]]

export function isCustomFieldEntityType(type: unknown): type is CustomFieldEntityType {
  return typeof type === 'string' && (CUSTOM_FIELD_ENTITY_TYPES as readonly string[]).includes(type)
}

/** Types accepted directly in `create_claim`'s `sources[].source_type`. */
export const SOURCE_ENTITY_TYPES = idsWhere((e) => e.sourceable)

/**
 * `claim_source.source_type` values that are NOT entity types: no row to point
 * an `entity_link` at, so they live only in the evidence store.
 */
export const NON_ENTITY_SOURCE_TYPES = ['external_url', 'manual'] as const

/** The full `create_claim` sources[] vocabulary (entities + external/manual). */
export const SOURCE_TYPES = tuple<EntityType | (typeof NON_ENTITY_SOURCE_TYPES)[number]>([
  ...SOURCE_ENTITY_TYPES,
  ...NON_ENTITY_SOURCE_TYPES,
])

/**
 * Provenance that mirrors into `entity_link` as a graph edge.
 * MUST stay a subset of migration 264's `claim_source_source_type_check` list.
 */
export const CITABLE_SOURCE_TYPES: ReadonlySet<string> = new Set(
  ENTITY_REGISTRY.filter((e) => e.citable).map((e) => e.id),
)

/**
 * Type → table for the types that can be cheaply workspace-verified. Types
 * fenced indirectly (cycle via team, milestone via project) are deliberately
 * absent: `entityInWorkspace` treats a missing entry as can't-verify→allow.
 */
export const WORKSPACE_SCOPED_TABLE: Partial<Record<LinkableEntityType, string>> =
  Object.fromEntries(
    ENTITY_REGISTRY.filter((e) => e.linkable && e.workspaceScoped.kind === 'column').map((e) => [
      e.id,
      e.table,
    ]),
  )

/**
 * The shared realtime channel's bindings: every `realtime` kind's own table,
 * filtered by workspace_id when the table carries one.
 */
export const REALTIME_ENTITY_TABLES: ReadonlyArray<{
  table: string
  entityType: EntityType
  filtered: boolean
}> = ENTITY_REGISTRY.filter((e) => e.realtime).map((e) => ({
  table: e.table,
  entityType: e.id as EntityType,
  filtered: e.workspaceScoped.kind === 'column',
}))

/** Per-type label resolution for graph neighbors (traverse's `resolveLabels`). */
export const LABEL_TABLE: Record<
  string,
  { table: string; columns: string; label: (r: Record<string, unknown>) => string }
> = Object.fromEntries(
  ENTITY_REGISTRY.map((e) => [
    e.id,
    { table: e.label.table, columns: e.label.columns, label: e.label.render },
  ]),
)

/** Graph edge relations. One declaration — entity-links.ts used to have its own, shorter copy. */
export const RELATIONS = [
  'mentions',
  'depends_on',
  'supersedes',
  'authored_by',
  'cites',
  'about',
  'related_to',
  'contradicts',
  'owns',
  'committed_to',
] as const
export type Relation = (typeof RELATIONS)[number]

/** Types that carry anchoring configuration, in registry order. */
export const ANCHOR_ENTITY_TYPES = idsWhere((e) => !!e.anchor)

export function anchorDescriptor(type: string): AnchorDescriptor | undefined {
  return entityDescriptor(type)?.anchor
}
