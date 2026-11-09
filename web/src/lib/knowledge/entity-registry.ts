/**
 * The entity-type registry — ONE declaration of every knowledge-graph entity
 * type and everything the rest of the codebase needs to know about it.
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
  /** Valid as an `entity_link` endpoint / `link_entities` argument. */
  readonly linkable: boolean
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
    linkable: true,
    citable: true,
    sourceable: true,
  },
  {
    id: 'claim',
    table: 'claim',
    workspaceScoped: { kind: 'column', table: 'claim' },
    label: { table: 'claim', columns: 'text', render: (r) => str(r.text).slice(0, 140) },
    linkable: true,
    citable: false,
    sourceable: false,
  },
  {
    id: 'capture',
    table: 'captures',
    workspaceScoped: { kind: 'column', table: 'captures' },
    label: { table: 'captures', columns: 'title', render: (r) => str(r.title) },
    linkable: true,
    citable: true,
    sourceable: true,
  },
  {
    id: 'contact',
    table: 'contact',
    workspaceScoped: { kind: 'column', table: 'contact' },
    label: { table: 'contact', columns: 'full_name', render: (r) => str(r.full_name) },
    linkable: true,
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
    linkable: true,
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
    linkable: true,
    citable: true,
    sourceable: false,
  },
  {
    id: 'initiative',
    table: 'initiative',
    workspaceScoped: { kind: 'column', table: 'initiative' },
    label: { table: 'initiative', columns: 'name', render: (r) => str(r.name) },
    linkable: true,
    citable: false,
    sourceable: false,
  },
  {
    id: 'cycle',
    table: 'cycle',
    // No workspace_id column — fenced through its team.
    workspaceScoped: { kind: 'indirect', via: 'team' },
    label: { table: 'cycle', columns: 'name', render: (r) => str(r.name) },
    linkable: true,
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
    linkable: true,
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
    linkable: true,
    citable: true,
    sourceable: true,
  },
  {
    id: 'member',
    table: 'member',
    workspaceScoped: { kind: 'column', table: 'member' },
    label: { table: 'member', columns: 'display_name', render: (r) => str(r.display_name) },
    linkable: true,
    citable: false,
    sourceable: false,
  },
  {
    id: 'conversation',
    table: 'chat_conversations',
    workspaceScoped: { kind: 'column', table: 'chat_conversations' },
    label: { table: 'chat_conversations', columns: 'title', render: (r) => str(r.title) },
    linkable: true,
    citable: true,
    sourceable: true,
  },
  {
    id: 'company',
    table: 'company',
    workspaceScoped: { kind: 'column', table: 'company' },
    label: { table: 'company', columns: 'name', render: (r) => str(r.name) },
    linkable: true,
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
    linkable: true,
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
    linkable: true,
    citable: false,
    sourceable: false,
  },
] as const satisfies readonly EntityTypeDescriptor[]

/** The union of every registered type id — derived, never hand-written. */
export type EntityType = (typeof ENTITY_REGISTRY)[number]['id']

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
    ENTITY_REGISTRY.filter((e) => e.workspaceScoped.kind === 'column').map((e) => [
      e.id,
      e.table,
    ]),
  )

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
