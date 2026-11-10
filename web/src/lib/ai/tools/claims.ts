import { attachClaimProvenance } from '@/lib/ai/claim-provenance'
import { embed } from '@/lib/ai/embeddings'
import { inngest } from '@/lib/inngest/client'
import { NOW_KEY } from '@/lib/now/now-stamp'
import {
  LABEL_TABLE,
  LINKABLE_ENTITY_TYPES,
  RELATIONS,
  SOURCE_TYPES,
  WORKSPACE_SCOPED_TABLE,
  type LinkableEntityType,
} from '@/lib/knowledge/entity-registry'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows, inChunks } from '@/lib/supabase/paging'
import { tool } from 'ai'
import { z } from 'zod'
import { filterVisibleCompanies, filterVisibleContacts } from '@/lib/crm/contact-visibility'
import {
  PRIVATE_GRAPH_KINDS,
  PRIVATE_KIND_LABEL,
  isPrivateGraphKind,
  visiblePrivateKindIds,
  type PrivateGraphKind,
} from '@/lib/knowledge/entity-fences'
import {
  CONVERSATION_SOURCE_TYPE,
  claimIdsHiddenFrom,
  conversationIdsHiddenFrom,
  documentIdsHiddenFrom,
  excludeClaimsHiddenFrom,
  isMailSourceType,
  mailSourcedClaimIds,
} from '@/lib/knowledge/claim-visibility'
import {
  getUserWorkspaces,
  resolveEntityWorkspace,
  resolveCreateWorkspace,
  workspaceEcho,
  resolveSince,
  resolveUntil,
  timeWindowParams,
  applyCaptureVisibility,
  applyDocumentVisibility,
  captureRequester,
  documentRequesterMember,
  type CaptureRequester,
  type CreateWorkspacePolicy,
} from './_shared'

const CLAIM_TYPES = [
  'fact',
  'open_question',
  'inference',
  'decision_summary',
] as const
const CLAIM_CONFIRMATIONS = ['suggested', 'confirmed', 'dismissed'] as const
const CLAIM_STATUSES = ['active', 'superseded', 'disputed', 'archived'] as const
const CLAIM_TIME_FIELDS = [
  'updated_at',
  'created_at',
  'last_verified_at',
] as const

// The claim/graph vocabulary has ONE declaration — src/lib/knowledge/entity-registry.ts.
// Re-exported from here because the existing call sites import it from claims.ts
// by convention; the registry is what they actually get.
export {
  LINKABLE_ENTITY_TYPES,
  WORKSPACE_SCOPED_TABLE,
} from '@/lib/knowledge/entity-registry'

/**
 * True if `id` names a row of `type` inside `workspaceId`. Returns true
 * (can't-verify → allow) for types without a direct workspace_id column
 * (`cycle` via its team, `milestone` via its project).
 *
 * The private graph kinds (calendar events, team-chat channels and messages,
 * decisions: src/lib/knowledge/entity-fences.ts) also need `requesterUserId`,
 * who must be able to read the row; with none they FAIL CLOSED. A caller that
 * writes into something the whole workspace reads (a knowledge package) passes
 * none, so a private row never lands there.
 */
export async function entityInWorkspace(
  supabase: SupabaseClient,
  workspaceId: string,
  type: LinkableEntityType,
  id: string,
  requesterUserId?: string | null,
): Promise<boolean> {
  if (isPrivateGraphKind(type)) {
    if (!requesterUserId) return false
    const visible = await visiblePrivateKindIds(supabase, type, requesterUserId, [id], workspaceId)
    return visible.has(id)
  }
  const table = WORKSPACE_SCOPED_TABLE[type]
  if (!table) return true
  const { data } = await supabase
    .from(table)
    .select('id')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  return !!data
}

/**
 * Which of `captureIds` the requester may see. Fails closed: a capture that
 * doesn't come back (hidden, deleted, or in another workspace) is not visible.
 */
async function visibleCaptureIds(
  supabase: SupabaseClient,
  workspaceId: string,
  captureIds: string[],
  requester: CaptureRequester,
): Promise<Set<string>> {
  const { data } = await applyCaptureVisibility(
    supabase.from('captures').select('id').eq('workspace_id', workspaceId).in('id', captureIds),
    requester,
  )
  return new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id))
}

/** One reconciled provenance entry: a source entity that supports a claim,
 *  carrying the evidence excerpt AND/OR the cites/about graph relation. */
export interface ReconciledProvenance {
  entity_type: string
  entity_id: string | null
  source_uri: string | null
  excerpt: string | null
  relations: string[]
  in_sources: boolean
  in_graph: boolean
}

/** Pre-fetched provenance rows a caller can hand to reconcileProvenance to
 *  avoid re-querying claim_source / entity_link it already read (get_claim). */
export interface PrefetchedProvenance {
  sources: Array<{
    claim_id: string
    source_type: string
    source_id: string | null
    source_uri: string | null
    excerpt: string | null
  }>
  links: Array<{
    source_id: string
    target_type: string
    target_id: string | null
    relation: string
  }>
}

/**
 * Reconcile the two provenance stores (claim_source evidence + cites/about
 * entity_link edges) into one flat view per claim, batched over N claim ids in
 * exactly TWO queries (not N). A source entity that is both a claim_source row
 * (excerpt) and an outbound cites/about edge appears ONCE, carrying both. Keyed
 * by (source_type, source_id, source_uri) so internal and external sources
 * dedupe correctly.
 *
 * Returns a Map keyed by claim_id → reconciled provenance array. Callers that
 * want a single claim pass a 1-element array (get_claim); list_claims
 * `include_provenance` passes up to `limit` ids.
 *
 * `prefetched` lets a caller that has ALREADY loaded the claim_source rows and
 * the claim's outbound entity_link edges (get_claim does) pass them in, so this
 * function reconciles WITHOUT re-querying those two indexed tables. When
 * omitted (the list_claims path), the two queries run as before — that path is
 * unchanged.
 *
 * Only `cites`/`about` edges are treated as provenance — supersedes/depends_on/
 * etc. are semantic graph edges and are intentionally left out (the caller can
 * still fetch them via traverse / the raw outbound_links list).
 *
 * `requester` (when passed) redacts capture-sourced provenance the requester may
 * not see. A claim can be visible through a NON-capture source while ALSO citing
 * a private capture, so the claim-level gate is not enough — the hidden capture's
 * excerpt and id must be dropped here. Omit it only on RLS-scoped clients, where
 * the policies already filter the underlying rows.
 */
export async function reconcileProvenance(
  supabase: SupabaseClient,
  workspaceId: string,
  claimIds: string[],
  prefetched?: PrefetchedProvenance,
  requester?: CaptureRequester,
): Promise<Map<string, ReconciledProvenance[]>> {
  const out = new Map<string, ReconciledProvenance[]>()
  if (claimIds.length === 0) return out

  const [rawSources, rawLinks] = prefetched
    ? [prefetched.sources, prefetched.links]
    : await Promise.all([
        supabase
          .from('claim_source')
          .select('claim_id, source_type, source_id, source_uri, excerpt')
          .in('claim_id', claimIds)
          .then((r) => r.data ?? []),
        supabase
          .from('entity_link')
          .select('source_id, target_type, target_id, relation')
          .eq('workspace_id', workspaceId)
          .eq('source_type', 'claim')
          .in('source_id', claimIds)
          .then((r) => r.data ?? []),
      ])

  // Batch-resolve which referenced captures the requester may see, then drop
  // every capture-typed source/edge that isn't one of them (a dangling capture
  // reference counts as hidden — fail closed). One extra query, never N+1.
  let sources = (rawSources ?? []) as PrefetchedProvenance['sources']
  let links = (rawLinks ?? []) as PrefetchedProvenance['links']
  if (requester !== undefined) {
    const captureIds = [
      ...new Set([
        ...sources.filter((s) => s.source_type === 'capture' && s.source_id).map((s) => s.source_id as string),
        ...links.filter((l) => l.target_type === 'capture' && l.target_id).map((l) => l.target_id as string),
      ]),
    ]
    if (captureIds.length > 0) {
      const visible = await visibleCaptureIds(supabase, workspaceId, captureIds, requester)
      sources = sources.filter((s) => s.source_type !== 'capture' || (s.source_id !== null && visible.has(s.source_id)))
      links = links.filter((l) => l.target_type !== 'capture' || (l.target_id !== null && visible.has(l.target_id)))
    }
    // A chat is its owner's alone (353): someone else's conversation, its
    // excerpt and its edge never show, even on a claim that is shared.
    const conversationIds = [
      ...sources.filter((s) => s.source_type === CONVERSATION_SOURCE_TYPE && s.source_id).map((s) => s.source_id as string),
      ...links.filter((l) => l.target_type === CONVERSATION_SOURCE_TYPE && l.target_id).map((l) => l.target_id as string),
    ]
    if (conversationIds.length > 0) {
      // A failed read hides every chat (fail closed).
      const hiddenChats = (await conversationIdsHiddenFrom(supabase, conversationIds, requester)) ?? new Set(conversationIds)
      sources = sources.filter((s) => s.source_type !== CONVERSATION_SOURCE_TYPE || (s.source_id !== null && !hiddenChats.has(s.source_id)))
      links = links.filter((l) => l.target_type !== CONVERSATION_SOURCE_TYPE || (l.target_id !== null && !hiddenChats.has(l.target_id)))
    }
  }

  const provKey = (type: string, id: string | null, uri: string | null) =>
    `${type}::${id ?? ''}::${uri ?? ''}`

  // Per-claim reconciliation map so entries dedupe within one claim.
  const perClaim = new Map<string, Map<string, ReconciledProvenance>>()
  const mapFor = (claimId: string) => {
    let m = perClaim.get(claimId)
    if (!m) {
      m = new Map()
      perClaim.set(claimId, m)
    }
    return m
  }

  for (const s of sources || []) {
    const m = mapFor(s.claim_id as string)
    m.set(provKey(s.source_type as string, s.source_id as string | null, s.source_uri as string | null), {
      entity_type: s.source_type as string,
      entity_id: s.source_id as string | null,
      source_uri: s.source_uri as string | null,
      excerpt: s.excerpt as string | null,
      relations: [],
      in_sources: true,
      in_graph: false,
    })
  }
  for (const l of links || []) {
    if (l.relation !== 'cites' && l.relation !== 'about') continue
    const m = mapFor(l.source_id as string)
    const key = provKey(l.target_type as string, l.target_id as string | null, null)
    const existing = m.get(key)
    if (existing) {
      existing.in_graph = true
      if (!existing.relations.includes(l.relation as string)) existing.relations.push(l.relation as string)
    } else {
      m.set(key, {
        entity_type: l.target_type as string,
        entity_id: l.target_id as string | null,
        source_uri: null,
        excerpt: null,
        relations: [l.relation as string],
        in_sources: false,
        in_graph: true,
      })
    }
  }

  for (const [claimId, m] of perClaim.entries()) {
    out.set(claimId, [...m.values()])
  }
  return out
}

const sourceSchema = z.object({
  source_type: z.enum(SOURCE_TYPES),
  source_id: z
    .string()
    .optional()
    .describe('UUID of the source entity (for internal types)'),
  source_uri: z
    .string()
    .optional()
    .describe('External URL (for external_url type)'),
  excerpt: z
    .string()
    .optional()
    .describe('Snippet from the source that supports the claim'),
})

/**
 * The label a graph node for a contact the caller cannot see resolves to. The
 * node keeps its id and relation (the edge exists and is workspace-visible),
 * but never the contact's name: these tools may run on a SERVICE-ROLE client,
 * where the contact table's RLS (mig 058) does not hide it
 * (src/lib/crm/contact-visibility.ts).
 */
export const PRIVATE_CONTACT_LABEL = 'Contact (private)'

/**
 * The company twin of PRIVATE_CONTACT_LABEL. The `company` table's RLS (mig
 * 059) keys off auth.uid(), NULL on a service-role client, so a company node
 * is fenced through company_visible_to (mig 235) and a hidden one keeps its id
 * and relation but not its name.
 */
export const PRIVATE_COMPANY_LABEL = 'Company (private)'

interface LabelFence {
  /** The rows `userId` may see (inside `workspaceId` when given), failing closed. */
  filterVisible: (
    supabase: SupabaseClient,
    userId: string,
    rows: Array<{ id: string }>,
    workspaceId?: string,
  ) => Promise<Array<{ id: string }>>
  placeholder: string
}

/** A private graph kind's fence (src/lib/knowledge/entity-fences.ts), as a label fence. */
function privateKindLabelFence(type: PrivateGraphKind): LabelFence {
  return {
    filterVisible: async (supabase, userId, rows, workspaceId) => {
      const visible = await visiblePrivateKindIds(supabase, type, userId, rows.map((r) => r.id), workspaceId)
      return rows.filter((r) => visible.has(r.id))
    },
    placeholder: PRIVATE_KIND_LABEL[type],
  }
}

/**
 * The graph node types whose labels are fenced, with their check and
 * placeholder. Every private graph kind is here: a kind joins the graph
 * (`linkable` in the registry) only once its fence is.
 */
export const FENCED_LABEL_TYPES: Readonly<Record<string, LabelFence>> = {
  contact: { filterVisible: filterVisibleContacts, placeholder: PRIVATE_CONTACT_LABEL },
  company: { filterVisible: filterVisibleCompanies, placeholder: PRIVATE_COMPANY_LABEL },
  ...Object.fromEntries(PRIVATE_GRAPH_KINDS.map((type) => [type, privateKindLabelFence(type)])),
}

/**
 * claim_neighborhood (mig 275) joins `contact.full_name` and `company.name`
 * into its node labels with no visibility check on either (it fences claims and
 * captures only). Replace the label of every contact / company node `userId`
 * cannot see with its placeholder, failing closed. Other nodes pass through
 * untouched.
 */
async function fenceBundleLabels(
  supabase: SupabaseClient,
  userId: string,
  nodes: readonly unknown[],
): Promise<unknown[]> {
  type Node = { node_type?: unknown; node_id?: unknown; label?: unknown }
  const fencedType = (n: unknown): string | null => {
    const node = n as Node | null
    return typeof node?.node_type === 'string' &&
      FENCED_LABEL_TYPES[node.node_type] &&
      typeof node.node_id === 'string' &&
      node.label != null
      ? node.node_type
      : null
  }
  const idsByType = new Map<string, Set<string>>()
  for (const n of nodes) {
    const type = fencedType(n)
    if (!type) continue
    ;(idsByType.get(type) ?? idsByType.set(type, new Set()).get(type)!).add((n as Node).node_id as string)
  }
  if (idsByType.size === 0) return [...nodes]
  const visible = new Set<string>()
  await Promise.all(
    [...idsByType.entries()].map(async ([type, ids]) => {
      const rows = await FENCED_LABEL_TYPES[type].filterVisible(supabase, userId, [...ids].map((id) => ({ id })))
      for (const r of rows) visible.add(`${type}:${r.id}`)
    }),
  )
  return nodes.map((n) => {
    const type = fencedType(n)
    if (!type || visible.has(`${type}:${(n as Node).node_id as string}`)) return n
    return { ...(n as Node), label: FENCED_LABEL_TYPES[type].placeholder }
  })
}

/**
 * A claim is readable only when one of its sources is, and mail is shown to
 * no one (migration 341): drop every email node, every claim hidden from
 * `requester`, every conversation that isn't the requester's own chat (353),
 * and every edge touching any of them from a neighborhood bundle. A centre
 * that is one of them leaves an empty bundle. claim_neighborhood does the same
 * once 341 and 353 are applied; this holds before them and on any older
 * definition. `null` when a read failed (the caller fails closed).
 */
export async function dropHiddenFromBundle(
  supabase: SupabaseClient,
  bundle: { center: { type: string; id: string }; nodes: unknown[]; edges: unknown[] },
  requester: string | null,
): Promise<{ nodes: unknown[]; edges: unknown[] } | null> {
  type Node = { node_type?: unknown; node_id?: unknown }
  type Edge = { source_type?: unknown; source_id?: unknown; target_type?: unknown; target_id?: unknown }
  const claimIds = new Set<string>()
  if (bundle.center.type === 'claim') claimIds.add(bundle.center.id)
  for (const n of bundle.nodes as Node[]) {
    if (n?.node_type === 'claim' && typeof n.node_id === 'string') claimIds.add(n.node_id)
  }
  const conversationIds = new Set<string>()
  if (bundle.center.type === CONVERSATION_SOURCE_TYPE) conversationIds.add(bundle.center.id)
  for (const n of bundle.nodes as Node[]) {
    if (n?.node_type === CONVERSATION_SOURCE_TYPE && typeof n.node_id === 'string') conversationIds.add(n.node_id)
  }
  // 369: a private document is its creator's alone.
  const documentIds = new Set<string>()
  if (bundle.center.type === 'document') documentIds.add(bundle.center.id)
  for (const n of bundle.nodes as Node[]) {
    if (n?.node_type === 'document' && typeof n.node_id === 'string') documentIds.add(n.node_id)
  }
  const [hiddenClaims, hiddenChats, hiddenDocs] = await Promise.all([
    claimIds.size > 0 ? claimIdsHiddenFrom(supabase, [...claimIds], requester) : new Set<string>(),
    conversationIds.size > 0 ? conversationIdsHiddenFrom(supabase, [...conversationIds], requester) : new Set<string>(),
    documentIds.size > 0 ? documentIdsHiddenFrom(supabase, [...documentIds], requester) : new Set<string>(),
  ])
  if (!hiddenClaims || !hiddenChats || !hiddenDocs) return null
  const hidden = (type: unknown, id: unknown) =>
    isMailSourceType(typeof type === 'string' ? type : null) ||
    (type === 'claim' && typeof id === 'string' && hiddenClaims.has(id)) ||
    (type === CONVERSATION_SOURCE_TYPE && typeof id === 'string' && hiddenChats.has(id)) ||
    (type === 'document' && typeof id === 'string' && hiddenDocs.has(id))
  if (hidden(bundle.center.type, bundle.center.id)) return { nodes: [], edges: [] }
  return {
    nodes: (bundle.nodes as Node[]).filter((n) => !hidden(n?.node_type, n?.node_id)),
    edges: (bundle.edges as Edge[]).filter(
      (e) => !hidden(e?.source_type, e?.source_id) && !hidden(e?.target_type, e?.target_id),
    ),
  }
}

const linkSchema = z.object({
  entity_type: z.enum(LINKABLE_ENTITY_TYPES),
  entity_id: z.string(),
  relation: z.enum(RELATIONS).optional().default('about'),
})

export function createClaimTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  strictWorkspace = false,
  omitPrivateCaptures = false,
  // CREATE-TIME WORKSPACE ROUTING (_shared.ts). Trailing, after the existing
  // strictWorkspace/omitPrivateCaptures params, exactly like every other
  // create-bearing factory — an unused default keeps today's callers
  // (index.ts) byte-identical until the bridge passes 'explicit'.
  createWorkspacePolicy: CreateWorkspacePolicy = 'session',
) {
  // Threaded into the visibility-aware SECURITY DEFINER RPCs; null = fail closed
  // (claims sourced only from private captures are excluded).
  const requestingUserId = captureRequester(userId, omitPrivateCaptures)
  // Resolve a member row — reused by every tool that needs created_by. Defaults
  // to the active workspace; a caller routed to a foreign-but-member workspace
  // (create_claim's targetWs, link_entities' resolved anchor workspace) passes
  // that ws explicitly so created_by names a member row that actually exists
  // THERE, not a coincidentally-same-user row in the active workspace.
  const resolveMemberId = async (ws: string = workspaceId): Promise<string | null> => {
    const { data } = await supabase
      .from('member')
      .select('id')
      .eq('user_id', userId)
      .eq('workspace_id', ws)
      .maybeSingle()
    return data?.id ?? null
  }

  // Whether the caller may read a claim, by id: claim_visible_to (the SQL rule,
  // with the requester) and the app's copy of it, which also hides mail before
  // migration 341 is applied. Every by-id tool (get_claim, confirm_claim,
  // dismiss_claim, supersede_claim) asks this first and answers a hidden claim
  // with the same not-found as a missing one, so a claim's text can't be read
  // through its id. This may run service-role, so RLS is no fence here.
  const claimReadable = async (claimId: string): Promise<{ ok: true } | { ok: false; error: string }> => {
    const { data: visible, error } = await supabase.rpc('claim_visible_to', {
      p_claim_id: claimId,
      p_user_id: requestingUserId,
    })
    if (error) return { ok: false, error: error.message }
    if (visible === false) return { ok: false, error: 'Claim not found' }
    const hidden = await claimIdsHiddenFrom(supabase, [claimId], requestingUserId)
    if (!hidden) return { ok: false, error: 'Could not read the claim. Try again.' }
    if (hidden.has(claimId)) return { ok: false, error: 'Claim not found' }
    return { ok: true }
  }

  // Resolve display labels for a set of (type, id) graph neighbors so traverse
  // can return human-readable names inline instead of forcing N follow-up
  // get_* calls. One query per type, workspace-scoped. Unknown types resolve to
  // null label (the caller still gets the id + relation).
  //
  // Only types whose table carries its own `workspace_id` are resolvable here —
  // the query below is workspace-scoped, so an indirectly-fenced type (cycle via
  // team, milestone via project) would error on a missing column rather than
  // return a label. Those stay label-less, exactly as before the registry.
  // Never a mail label: a subject is one person's mail, and this may run
  // service-role with only a workspace fence (migration 341).
  //
  // The one indirect type that IS labelable is a private graph kind (a
  // decision): its fence (FENCED_LABEL_TYPES, given `ws`) proves the workspace
  // through the decision's capture, so its query skips the workspace_id filter
  // its table can't take. Every private kind's label goes through its fence.
  const hasWorkspaceColumn = (type: string) => WORKSPACE_SCOPED_TABLE[type as LinkableEntityType] !== undefined
  const labelable = (type: string) =>
    !isMailSourceType(type) &&
    !!LABEL_TABLE[type] &&
    (hasWorkspaceColumn(type) ||
      (isPrivateGraphKind(type) && (LINKABLE_ENTITY_TYPES as readonly string[]).includes(type)))
  const resolveLabels = async (
    refs: Array<{ type: string; id: string }>,
    ws: string = workspaceId,
  ): Promise<Record<string, string>> => {
    const out: Record<string, string> = {}
    const byType = new Map<string, Set<string>>()
    for (const r of refs) {
      if (!labelable(r.type)) continue
      ;(byType.get(r.type) ?? byType.set(r.type, new Set()).get(r.type)!).add(r.id)
    }
    await Promise.all(
      [...byType.entries()].map(async ([type, ids]) => {
        const cfg = LABEL_TABLE[type]
        // Scope to the workspace where the table can take it (a decision's
        // fence below proves it instead).
        const base = supabase
          .from(cfg.table)
          .select(`id, ${cfg.columns}`)
          .in('id', [...ids])
        let query = hasWorkspaceColumn(type) ? base.eq('workspace_id', ws) : base
        // A capture hidden from the requester must not have its title resolved —
        // traverse reads entity_link directly, so this predicate (not the hardened
        // claim_neighborhood RPC) is what keeps a private capture's title out.
        if (type === 'capture') query = applyCaptureVisibility(query, requestingUserId)
        // The same for someone else's private document (migration 369).
        if (type === 'document') query = applyDocumentVisibility(query, await documentRequesterMember(supabase, userId, ws, omitPrivateCaptures))
        const { data } = await query.overrideTypes<Array<Record<string, unknown>>>()
        const rows = (data ?? []) as Array<Record<string, unknown>>
        // Another member's private/team contact, or a company none of whose
        // contacts the caller can see: RLS hides the row on a user client, but
        // this may run service-role. The node keeps its id; its label is a
        // neutral placeholder, never the name. A private graph kind (someone's
        // calendar event, a DM) is fenced to the requester, and to no one on an
        // unattended run (omitPrivateCaptures), as a private capture is.
        const fence = FENCED_LABEL_TYPES[type]
        const fenceUser = isPrivateGraphKind(type) ? requestingUserId : userId
        const visible = fence
          ? new Set(
              fenceUser
                ? (
                    await fence.filterVisible(
                      supabase,
                      fenceUser,
                      rows.filter((r): r is Record<string, unknown> & { id: string } => typeof r.id === 'string'),
                      ws,
                    )
                  ).map((r) => r.id)
                : [],
            )
          : null
        for (const r of rows) {
          out[`${type}:${r.id as string}`] =
            fence && visible && !visible.has(r.id as string)
              ? fence.placeholder
              : cfg.label(r) || '(untitled)'
        }
      }),
    )
    return out
  }

  return {
    list_claims: tool({
      description:
        'List claims in the workspace. Use `entity_type`+`entity_id` to find claims linked to a specific entity (contact, project, capture, etc.). Use `search` for full-text. Use `since`/`until` for time-windowed queries. ' +
        'Time semantics: `time_field` defaults to `created_at` (graph WRITE time — when we LEARNED the fact, the right anchor for "new findings" queries; a month-old PDF ingested today IS a new finding). Pass `time_field: "updated_at"` only when you specifically want claims the weaver TOUCHED recently (this conflates re-verification with new facts). ' +
        'For "what changed / what\'s new on project X recently" pass `group_by_change: true` with `entity_type: "project"` + `entity_id` + a window (`since`/`until`) — the response splits into new / newly_confirmed / superseded buckets. Add `include_provenance: true` to attach evidence + linked entities per claim so you can cite without N follow-up get_claim calls (costs more tokens). ' +
        'Set `cross_workspace: true` to list claims across every workspace the user belongs to (each row is tagged with `workspace_id` + `workspace_name`); not supported together with `group_by_change`. ' +
        'Note: `status` defaults to `active`, which hides superseded/corrected facts — `group_by_change` unions superseded rows in for you.',
      inputSchema: z.object({
        entity_type: z
          .enum(LINKABLE_ENTITY_TYPES)
          .optional()
          .describe('Filter to claims linked to this entity type'),
        entity_id: z
          .string()
          .optional()
          .describe('UUID of the entity to filter by (requires entity_type)'),
        type: z.enum(CLAIM_TYPES).optional(),
        confirmation: z
          .enum(CLAIM_CONFIRMATIONS)
          .optional()
          .describe('Defaults to all'),
        status: z.enum(CLAIM_STATUSES).optional().default('active'),
        subject_member_id: z
          .string()
          .optional()
          .describe('Filter to claims ABOUT a specific member (e.g. commitments by that person). Pass the member id.'),
        scope: z
          .enum(['workspace', 'personal'])
          .optional()
          .describe('"personal" = claims about a specific member (commitments); "workspace" = general knowledge.'),
        search: z.string().optional().describe('Full-text search query'),
        limit: z.number().optional().default(20),
        ...timeWindowParams,
        time_field: z.enum(CLAIM_TIME_FIELDS).optional().default('created_at'),
        group_by_change: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'Group results into new / newly_confirmed / superseded buckets (by change type within the window) instead of a flat list. Use for "what changed recently" queries. Internally unions superseded rows in even though the default status filter is "active".',
          ),
        include_provenance: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'Attach evidence sources + linked entities per claim (like get_claim), batched, avoiding N follow-up calls. Costs more tokens — use for digest / "cite each finding" queries, not broad listing.',
          ),
        cross_workspace: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'List claims across every workspace the user belongs to (each row tagged with workspace_id + workspace_name), merged and re-sorted by the active time_field. Not supported together with group_by_change — scope to one workspace for change-grouping.',
          ),
      }),
      execute: async ({
        entity_type,
        entity_id,
        type,
        confirmation,
        status,
        subject_member_id,
        scope,
        search,
        limit,
        since,
        until,
        time_field,
        group_by_change,
        include_provenance,
        cross_workspace: crossWorkspaceArg,
      }) => {
        // A run fenced to one workspace (strictWorkspace) never fans out: the
        // flag is ignored there, so the list stays inside the active workspace.
        const cross_workspace = crossWorkspaceArg && !strictWorkspace
        const sinceISO = resolveSince(since)
        const untilISO = resolveUntil(until)
        const timeField = time_field ?? 'created_at'

        // group_by_change buckets by change type WITHIN one workspace's history;
        // fanning it across workspaces would compose two orthogonal axes and
        // complicate the (already involved) two-status-query union
        // disproportionately. Reject the combination with a clear tool error so
        // the model scopes to a single workspace for change-grouping.
        if (cross_workspace && group_by_change) {
          return {
            success: false,
            error:
              'cross_workspace and group_by_change are not supported together — scope to one workspace (drop cross_workspace) for change-grouping, or drop group_by_change for a cross-workspace flat list.',
          }
        }

        // Resolve the claim ids linked to an entity, scoped to ONE workspace.
        // Edges are bidirectional (link_entities can create claim→entity OR
        // entity→claim), so collect claims from BOTH directions: claims that are
        // the source of an edge to the entity, AND claims that are the target of
        // an edge from the entity. Union the two id sets.
        // Paged: a busy entity can hold more than one response (1000) of edges.
        const resolveEntityClaimIds = async (ws: string): Promise<string[]> => {
          const [outbound, inbound] = await Promise.all([
            // claim --(edge)--> entity
            fetchAllRows(() =>
              supabase
                .from('entity_link')
                .select('source_id')
                .eq('workspace_id', ws)
                .eq('source_type', 'claim')
                .eq('target_type', entity_type)
                .eq('target_id', entity_id),
            ),
            // entity --(edge)--> claim
            fetchAllRows(() =>
              supabase
                .from('entity_link')
                .select('target_id')
                .eq('workspace_id', ws)
                .eq('source_type', entity_type)
                .eq('source_id', entity_id)
                .eq('target_type', 'claim'),
            ),
          ])
          const ids = new Set<string>([
            ...((outbound.data || []).map((l) => l.source_id as string)),
            ...((inbound.data || []).map((l) => l.target_id as string)),
          ])
          return [...ids]
        }

        // Single-workspace paths (group_by_change is always single-workspace;
        // the flat path only fans out when cross_workspace is set) resolve the
        // entity filter once, up front, against the active workspace. The
        // cross-workspace flat path resolves per-workspace inside its fan-out
        // instead (a foreign workspace may hold matching claims even when the
        // active one holds none), so it must NOT early-return here.
        let claimIds: string[] | null = null
        if (entity_type && entity_id && !cross_workspace) {
          claimIds = await resolveEntityClaimIds(workspaceId)
          if (claimIds.length === 0) {
            return group_by_change
              ? {
                  success: true,
                  grouped: true,
                  buckets: { new: [], newly_confirmed: [], superseded: [] },
                  count: 0,
                }
              : { success: true, claims: [], count: 0 }
          }
        }

        const SELECT_COLS =
          'id, text, type, confidence, confirmation, status, scope, subject_member_id, superseded_by, created_at, updated_at, last_verified_at'

        type ClaimRow = {
          id: string
          confirmation: string | null
          status: string | null
          created_at: string
          updated_at: string
          [k: string]: unknown
        }

        // An entity's claim ids go into `id=in.(…)`: a few hundred overflowed
        // the request URL and the read failed. So the read runs per 100-id
        // chunk, each with the same order and `limit`, and the merge re-sorts
        // by `field` and keeps `limit` (each chunk's head is exact, so the
        // merged head is too). No ids: one plain read.
        type ClaimRead = { data: ClaimRow[] | null; error: { message: string } | null }
        const readByIdChunks = async (
          ids: string[] | null,
          field: string,
          run: (chunkIds: string[] | null) => PromiseLike<ClaimRead>,
        ): Promise<ClaimRead> => {
          if (!ids) return run(null)
          const { data, error } = await inChunks(ids, 100, (chunkIds) => run(chunkIds))
          if (error) return { data: null, error }
          const at = (r: ClaimRow) => Date.parse((r[field] as string) ?? '') || 0
          return { data: data.sort((a, b) => at(b) - at(a)).slice(0, limit), error: null }
        }

        const inWindow = (ts: string | null | undefined): boolean => {
          if (!ts) return false
          const t = Date.parse(ts)
          if (Number.isNaN(t)) return false
          if (sinceISO && t < Date.parse(sinceISO)) return false
          if (untilISO && t > Date.parse(untilISO)) return false
          return true
        }
        // Attach batched provenance to a set of rows (reuses get_claim's exact
        // reconciler — 2 queries for N claims, never N+1). Workspace-scoped so
        // the cross-workspace fan-out reconciles each row against ITS OWN
        // workspace's claim_source / entity_link rows; defaults to the active
        // workspace for the single-workspace path (unchanged behaviour).
        const withProvenance = async (
          rows: ClaimRow[],
          ws: string = workspaceId,
        ): Promise<ClaimRow[]> => {
          if (!include_provenance || rows.length === 0) return rows
          const provMap = await reconcileProvenance(
            supabase,
            ws,
            rows.map((r) => r.id),
            undefined,
            requestingUserId,
          )
          return rows.map((r) => ({ ...r, provenance: provMap.get(r.id) ?? [] }))
        }

        // ── Change-grouped path ──────────────────────────────────────────────
        // Buckets span DIFFERENT time fields (new→created_at, newly_confirmed &
        // superseded→updated_at), so a single WHERE on one field can't pre-filter
        // them. Fetch a superset touched-or-created in the window (created_at OR
        // updated_at ∈ [since,until]) for the requested status AND, unioned in,
        // status='superseded'; then bucket in JS. Both fetches share the same
        // column filters.
        if (group_by_change) {
          // group_by_change REQUIRES a lower bound. Without a `since`, the
          // "new vs newly_confirmed" split is undefined (the newly_confirmed
          // guard "existed before the window" degenerates to always-true, so a
          // claim can land in BOTH buckets), and buildSet applies no time
          // filter at all — an unbounded workspace scan. This is an LLM-facing
          // tool, so return a structured error telling the model to pass one.
          if (!sinceISO) {
            return {
              success: false,
              error:
                'group_by_change requires a time window: pass `since` (and optionally `until`) — e.g. since: "last_week". Without a lower bound the new / newly_confirmed split is undefined and the query would scan the whole workspace.',
            }
          }
          const orClause = (() => {
            const parts: string[] = []
            if (sinceISO && untilISO) {
              parts.push(`and(created_at.gte.${sinceISO},created_at.lte.${untilISO})`)
              parts.push(`and(updated_at.gte.${sinceISO},updated_at.lte.${untilISO})`)
            } else if (sinceISO) {
              parts.push(`created_at.gte.${sinceISO}`)
              parts.push(`updated_at.gte.${sinceISO}`)
            } else if (untilISO) {
              parts.push(`created_at.lte.${untilISO}`)
              parts.push(`updated_at.lte.${untilISO}`)
            }
            return parts.length ? parts.join(',') : null
          })()

          const activeStatus = status ?? 'active'
          const buildSet = (statusVal: string) => readByIdChunks(claimIds, 'updated_at', async (ids) => {
            let q = supabase
              .from('claim')
              .select(SELECT_COLS)
              .eq('workspace_id', workspaceId)
              .eq('status', statusVal)
            if (ids) q = q.in('id', ids)
            if (type) q = q.eq('type', type)
            if (confirmation) q = q.eq('confirmation', confirmation)
            if (subject_member_id) q = q.eq('subject_member_id', subject_member_id)
            if (scope) q = q.eq('scope', scope)
            if (search) {
              const tsQuery = search.trim().split(/\s+/).join(' & ')
              q = q.textSearch('fts', tsQuery)
            }
            if (orClause) q = q.or(orClause)
            // Cap every buildSet fetch (both the active/requested-status set and
            // the unioned superseded set). Even with the required window above,
            // a busy workspace can exceed `limit` rows in-window; without a cap
            // this is an unbounded scan.
            q = q.order('updated_at', { ascending: false }).limit(limit)
            return (await q) as {
              data: ClaimRow[] | null
              error: { message: string } | null
            }
          })

          // Only fetch the superseded set separately when the requested status
          // isn't already 'superseded' (avoid a redundant identical query).
          const fetches = [buildSet(activeStatus)]
          if (activeStatus !== 'superseded') fetches.push(buildSet('superseded'))
          const results = await Promise.all(fetches)
          for (const r of results) {
            if (r.error) return { success: false, error: r.error.message }
          }

          // Union by id (a claim can only match one status filter, so no dupes
          // across the two sets in practice, but dedupe defensively).
          const byId = new Map<string, ClaimRow>()
          for (const r of results) for (const row of r.data ?? []) byId.set(row.id, row)
          // A claim is readable only when one of its sources is; mail never is (341).
          const rows = await excludeClaimsHiddenFrom(supabase, [...byId.values()], requestingUserId)

          const newB = rows.filter(
            (r) => inWindow(r.created_at) && r.confirmation !== 'dismissed',
          )
          // Mutually exclusive by construction: a claim already bucketed `new`
          // must never also appear in `newly_confirmed`. (sinceISO is
          // guaranteed non-null here — group_by_change requires a window — so
          // the "existed before the window" guard below is meaningful rather
          // than the old always-true degenerate.)
          const newIds = new Set(newB.map((r) => r.id))
          const newlyConfirmedB = rows.filter(
            (r) =>
              !newIds.has(r.id) &&
              r.confirmation === 'confirmed' &&
              inWindow(r.updated_at) &&
              // existed BEFORE the window — crossed INTO confirmed within it,
              // rather than being born confirmed in-window (that's `new`).
              Date.parse(r.created_at) < Date.parse(sinceISO),
          )
          const supersededB = rows.filter(
            (r) => r.status === 'superseded' && inWindow(r.updated_at),
          )

          // Same per-row tag as the flat path. group_by_change is single-workspace
          // by construction, so the id is always the active one.
          const tagWorkspace = (rows: ClaimRow[]): ClaimRow[] =>
            rows.map((r) => ({ ...r, workspace_id: workspaceId }))
          const [newP, confP, supP] = await Promise.all([
            withProvenance(newB).then(tagWorkspace),
            withProvenance(newlyConfirmedB).then(tagWorkspace),
            withProvenance(supersededB).then(tagWorkspace),
          ])

          return {
            success: true,
            grouped: true,
            buckets: { new: newP, newly_confirmed: confP, superseded: supP },
            count: newP.length + confP.length + supP.length,
            ...(sinceISO || untilISO ? { since: sinceISO, until: untilISO } : {}),
          }
        }

        // ── Flat path ────────────────────────────────────────────────────────
        // Run the flat claim query against ONE workspace and tag every row with
        // its workspace so the cross-workspace merge can attribute results. For
        // the single-workspace path `ws` is the active workspace and the tags
        // are inert (behaviour unchanged).
        const runFlatForWorkspace = async (ws: {
          id: string
          name: string
        }): Promise<{ rows: ClaimRow[]; error?: string }> => {
          // Per-workspace entity resolution. For the single-workspace path the
          // ids were already resolved up front (`claimIds`); reuse them to keep
          // the query count identical. For the cross-workspace path resolve
          // against each workspace here.
          let ids = claimIds
          if (entity_type && entity_id && cross_workspace) {
            ids = await resolveEntityClaimIds(ws.id)
            // No edges to the entity in this workspace → no claims from it.
            if (ids.length === 0) return { rows: [] }
          }

          const { data, error } = await readByIdChunks(ids, timeField, async (chunkIds) => {
            let query = supabase
              .from('claim')
              .select(SELECT_COLS)
              .eq('workspace_id', ws.id)
              .order(timeField, { ascending: false })
              .limit(limit)

            if (chunkIds) query = query.in('id', chunkIds)
            if (type) query = query.eq('type', type)
            if (confirmation) query = query.eq('confirmation', confirmation)
            if (status) query = query.eq('status', status)
            if (subject_member_id) query = query.eq('subject_member_id', subject_member_id)
            if (scope) query = query.eq('scope', scope)
            if (search) {
              const tsQuery = search.trim().split(/\s+/).join(' & ')
              query = query.textSearch('fts', tsQuery)
            }
            if (sinceISO) query = query.gte(timeField, sinceISO)
            if (untilISO) query = query.lte(timeField, untilISO)

            return (await query) as ClaimRead
          })
          if (error) return { rows: [], error: error.message }
          // A claim is readable only when one of its sources is; mail never is (341).
          const visible = await excludeClaimsHiddenFrom(supabase, data || [], requestingUserId)

          // `workspace_id` on EVERY row, both paths: a claim id is only meaningful
          // next to its tenant, and the single-workspace path is exactly where an
          // agent is most likely to assume the wrong one. `workspace_name` stays
          // cross-workspace-only — the single-workspace fan-out synthesises
          // `{ id: workspaceId, name: '' }`, so a name here would be a lie, and the
          // MCP envelope already carries the active workspace's name.
          const withProv = await withProvenance(visible, ws.id)
          const tagged = withProv.map((r) => ({
            ...r,
            workspace_id: ws.id,
            ...(cross_workspace ? { workspace_name: ws.name } : {}),
          }))
          return { rows: tagged }
        }

        // Single-workspace: the active workspace only (unchanged). Cross:
        // fan out across every workspace the user belongs to.
        const targetWorkspaces = cross_workspace
          ? await getUserWorkspaces(supabase, userId)
          : [{ id: workspaceId, name: '' }]

        const perWorkspace = await Promise.all(
          targetWorkspaces.map((ws) => runFlatForWorkspace(ws)),
        )
        const firstError = perWorkspace.find((p) => p.error)?.error
        if (firstError) return { success: false, error: firstError }

        // Merge every workspace's rows, then re-sort by the active time_field
        // desc and trim to the overall limit (each per-workspace fetch was
        // already capped at `limit`, so the merged set is bounded).
        let claims = perWorkspace.flatMap((p) => p.rows)
        if (cross_workspace) {
          claims.sort((a, b) => {
            const at = Date.parse((a[timeField] as string) ?? '') || 0
            const bt = Date.parse((b[timeField] as string) ?? '') || 0
            return bt - at
          })
          claims = claims.slice(0, limit)
        }

        return {
          success: true,
          claims,
          count: claims.length,
          ...(cross_workspace
            ? { cross_workspace: true, workspace_count: targetWorkspaces.length }
            : {}),
          ...(sinceISO || untilISO
            ? { time_field: timeField, since: sinceISO, until: untilISO }
            : {}),
        }
      },
    }),

    get_claim: tool({
      description:
        'Get a claim with its sources (evidence) and linked entities (graph neighbors). Use after list_claims or search_claims to inspect a specific claim.',
      inputSchema: z.object({
        claim_id: z.string().describe('UUID of the claim'),
      }),
      execute: async ({ claim_id }) => {
        const resolved = await resolveEntityWorkspace(
          supabase,
          userId,
          'claim',
          claim_id,
          workspaceId,
          strictWorkspace,
        )
        if (!resolved) return { success: false, error: 'Claim not found' }

        // A claim whose sources are all hidden from this requester (captures
        // they can't see, or any mail) is itself hidden — same not-found
        // shape, never leaks existence. Fails closed for a null requester.
        const readable = await claimReadable(claim_id)
        if (!readable.ok) return { success: false, error: readable.error }

        const { data: claim, error } = await supabase
          .from('claim')
          .select(
            'id, workspace_id, text, type, confidence, confirmation, status, superseded_by, created_at, updated_at, last_verified_at',
          )
          .eq('id', claim_id)
          .eq('workspace_id', resolved.workspaceId)
          .single()
        if (error) return { success: false, error: error.message }

        const { data: sources, error: sourcesError } = await supabase
          .from('claim_source')
          .select('id, source_type, source_id, source_uri, excerpt, created_at')
          .eq('claim_id', claim_id)
        if (sourcesError) return { success: false, error: sourcesError.message }
        // A claim learned from mail is shown to no one, same not-found shape
        // (migration 341; claim_visible_to says the same once it's applied).
        if ((sources ?? []).some((s) => isMailSourceType(s.source_type as string | null))) {
          return { success: false, error: 'Claim not found' }
        }

        const { data: outboundLinks } = await supabase
          .from('entity_link')
          .select('id, target_type, target_id, relation, weight')
          .eq('workspace_id', resolved.workspaceId)
          .eq('source_type', 'claim')
          .eq('source_id', claim_id)

        const { data: inboundLinks } = await supabase
          .from('entity_link')
          .select('id, source_type, source_id, relation, weight')
          .eq('workspace_id', resolved.workspaceId)
          .eq('target_type', 'claim')
          .eq('target_id', claim_id)

        // An attachment source follows its parent capture (claim_visible_to's
        // rule): resolve each cited attachment's parent so a private capture's
        // attachment excerpt is dropped like the capture's own. A dangling
        // attachment id resolves to nothing and is dropped too.
        const attachmentSourceIds = [
          ...new Set(
            (sources ?? [])
              .filter((s) => s.source_type === 'attachment' && s.source_id)
              .map((s) => s.source_id as string),
          ),
        ]
        const attachmentParent = new Map<string, string | null>()
        if (attachmentSourceIds.length > 0) {
          const { data: atts, error: attError } = await supabase
            .from('attachments')
            .select('id, note_id')
            .eq('workspace_id', resolved.workspaceId)
            .in('id', attachmentSourceIds)
          if (attError) return { success: false, error: attError.message }
          for (const a of (atts ?? []) as Array<{ id: string; note_id: string | null }>) {
            attachmentParent.set(a.id, a.note_id ?? null)
          }
        }

        // claim_visible_to above passes whenever the claim has ANY readable
        // source, so a visible claim can still cite a capture this requester may
        // not see. Drop those references (excerpt AND id) from every list below;
        // one batched query, resolved once and reused.
        const referencedCaptureIds = [
          ...new Set(
            [
              ...[...attachmentParent.values()].filter((id): id is string => !!id),
              ...(sources ?? [])
                .filter((s) => s.source_type === 'capture' && s.source_id)
                .map((s) => s.source_id as string),
              ...(outboundLinks ?? [])
                .filter((l) => l.target_type === 'capture' && l.target_id)
                .map((l) => l.target_id as string),
              ...(inboundLinks ?? [])
                .filter((l) => l.source_type === 'capture' && l.source_id)
                .map((l) => l.source_id as string),
            ],
          ),
        ]
        const visibleCaptures =
          referencedCaptureIds.length > 0
            ? await visibleCaptureIds(
                supabase,
                resolved.workspaceId,
                referencedCaptureIds,
                requestingUserId,
              )
            : new Set<string>()
        const captureAllowed = (id: string | null | undefined): boolean =>
          typeof id === 'string' && visibleCaptures.has(id)

        const attachmentAllowed = (id: string | null | undefined): boolean => {
          if (typeof id !== 'string' || !attachmentParent.has(id)) return false
          const parent = attachmentParent.get(id) ?? null
          return parent === null || captureAllowed(parent)
        }
        // A chat is its owner's alone (353): another person's conversation
        // (its excerpt, its id) is dropped even when the claim is shared.
        const referencedConversationIds = [
          ...(sources ?? []).filter((s) => s.source_type === CONVERSATION_SOURCE_TYPE && s.source_id).map((s) => s.source_id as string),
          ...(outboundLinks ?? []).filter((l) => l.target_type === CONVERSATION_SOURCE_TYPE && l.target_id).map((l) => l.target_id as string),
          ...(inboundLinks ?? []).filter((l) => l.source_type === CONVERSATION_SOURCE_TYPE && l.source_id).map((l) => l.source_id as string),
        ]
        const hiddenChats = referencedConversationIds.length > 0
          ? await conversationIdsHiddenFrom(supabase, referencedConversationIds, requestingUserId)
          : new Set<string>()
        if (!hiddenChats) return { success: false, error: 'Could not read the claim. Try again.' }
        const conversationAllowed = (id: string | null | undefined): boolean => typeof id === 'string' && !hiddenChats.has(id)
        // Someone else's private document (369): its excerpt and id are dropped, as a private capture's are.
        const referencedDocumentIds = [
          ...(sources ?? []).filter((s) => s.source_type === 'document' && s.source_id).map((s) => s.source_id as string),
          ...(outboundLinks ?? []).filter((l) => l.target_type === 'document' && l.target_id).map((l) => l.target_id as string),
          ...(inboundLinks ?? []).filter((l) => l.source_type === 'document' && l.source_id).map((l) => l.source_id as string),
        ]
        const hiddenDocs = referencedDocumentIds.length > 0
          ? await documentIdsHiddenFrom(supabase, referencedDocumentIds, requestingUserId)
          : new Set<string>()
        if (!hiddenDocs) return { success: false, error: 'Could not read the claim. Try again.' }
        const documentAllowed = (id: string | null | undefined): boolean => typeof id === 'string' && !hiddenDocs.has(id)
        const visibleSources = (sources ?? []).filter((s) => {
          if (s.source_type === 'capture') return captureAllowed(s.source_id as string | null)
          if (s.source_type === 'attachment') return attachmentAllowed(s.source_id as string | null)
          if (s.source_type === CONVERSATION_SOURCE_TYPE) return conversationAllowed(s.source_id as string | null)
          if (s.source_type === 'document') return documentAllowed(s.source_id as string | null)
          return true
        })
        // An email neighbour is one person's mail: never listed (migration 341).
        const visibleOutbound = (outboundLinks ?? []).filter(
          (l) =>
            !isMailSourceType(l.target_type as string) &&
            (l.target_type !== 'capture' || captureAllowed(l.target_id as string | null)) &&
            (l.target_type !== CONVERSATION_SOURCE_TYPE || conversationAllowed(l.target_id as string | null)) &&
            (l.target_type !== 'document' || documentAllowed(l.target_id as string | null)),
        )
        const visibleInbound = (inboundLinks ?? []).filter(
          (l) =>
            !isMailSourceType(l.source_type as string) &&
            (l.source_type !== 'capture' || captureAllowed(l.source_id as string | null)) &&
            (l.source_type !== CONVERSATION_SOURCE_TYPE || conversationAllowed(l.source_id as string | null)) &&
            (l.source_type !== 'document' || documentAllowed(l.source_id as string | null)),
        )

        // Reconcile the two provenance stores (claim_source evidence + cites/about
        // graph edges) into one flat view (GEN-108). This shares the exact
        // reconciliation logic with list_claims' include_provenance path. We
        // already loaded this claim's claim_source rows (`sources`) and its
        // outbound entity_link edges (`outboundLinks`) above, so hand them to
        // reconcileProvenance as prefetched rows — it reconciles WITHOUT the two
        // redundant re-queries the previous version issued. (source_id on the
        // links is implicitly this claim — the outbound query was scoped to it.)
        const provMap = await reconcileProvenance(
          supabase,
          resolved.workspaceId,
          [claim_id],
          {
            sources: visibleSources.map((s) => ({
              claim_id,
              source_type: s.source_type as string,
              source_id: (s.source_id as string | null) ?? null,
              source_uri: (s.source_uri as string | null) ?? null,
              excerpt: (s.excerpt as string | null) ?? null,
            })),
            links: visibleOutbound.map((l) => ({
              source_id: claim_id,
              target_type: l.target_type as string,
              target_id: (l.target_id as string | null) ?? null,
              relation: l.relation as string,
            })),
          },
        )
        const provenance = provMap.get(claim_id) ?? []

        return {
          success: true,
          claim,
          provenance,
          sources: visibleSources,
          outbound_links: visibleOutbound,
          inbound_links: visibleInbound,
          ...(resolved.crossWorkspace
            ? {
                workspace_hint: `This claim lives in workspace ${resolved.workspaceId}, not the currently active one.`,
              }
            : {}),
        }
      },
    }),

    search_claims: tool({
      description:
        'Deprecated: prefer `find` for ranked retrieval with inline provenance and temporal recall. ' +
        'Semantic search over claims using vector similarity. Use this for "what does the workspace know about X?" style queries. Combine with list_claims when you want strict filtering by type/status. Pass min_confidence to prefer high-confidence knowledge and keep results lean. Pass since/until to constrain to when the underlying fact actually happened (event time).',
      inputSchema: z.object({
        query: z.string().describe('Natural-language query'),
        limit: z.number().optional().default(10),
        threshold: z
          .number()
          .optional()
          .default(0.3)
          .describe('Minimum cosine similarity (0..1)'),
        type: z.enum(CLAIM_TYPES).optional(),
        confirmation: z.enum(CLAIM_CONFIRMATIONS).optional(),
        status: z.enum(CLAIM_STATUSES).optional().default('active'),
        min_confidence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('Only return claims whose AI confidence is at least this (0..1). Null-confidence claims are excluded when set.'),
        ...timeWindowParams,
      }),
      execute: async ({
        query,
        limit,
        threshold,
        type,
        confirmation,
        status,
        min_confidence,
        since,
        until,
      }) => {
        try {
          const embedding = await embed(query, userId)
          // Resolve the temporal window against claim.event_at (source event
          // time). NULL bounds → unbounded.
          const eventAfter = resolveSince(since)
          const eventBefore = resolveUntil(until)
          // 10-arg overload (migration 181): 8-arg body + event_at range. The
          // 8-arg (117/126) and 7-arg overloads stay for their existing callers.
          const { data, error } = await supabase.rpc('match_claims', {
            p_workspace_id: workspaceId,
            p_embedding: `[${embedding.join(',')}]`,
            p_limit: limit,
            p_threshold: threshold,
            p_type: type ?? null,
            p_confirmation: confirmation ?? null,
            p_status: status ?? 'active',
            p_min_confidence: min_confidence ?? null,
            p_event_after: eventAfter,
            p_event_before: eventBefore,
            p_requesting_user_id: requestingUserId,
          })
          if (error) return { success: false, error: error.message }
          // A claim learned from mail is shown to no one (migration 341).
          const rows = (data || []) as Array<{ claim_id: string }>
          const hidden = rows.length > 0 ? await mailSourcedClaimIds(supabase, rows.map((m) => m.claim_id)) : new Set<string>()
          if (!hidden) return { success: false, error: 'Could not read claims. Try again.' }
          const matches = rows.filter((m) => !hidden.has(m.claim_id))
          return {
            success: true,
            matches,
            count: matches.length,
          }
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : 'Embedding failed',
          }
        }
      },
    }),

    create_claim: tool({
      description:
        'Propose a new claim. Defaults to confirmation="suggested" so the user can review it. Pass `sources` to attach evidence and `links` to wire the claim into the graph. The claim text is embedded automatically for semantic search.',
      inputSchema: z.object({
        text: z
          .string()
          .describe('The claim itself — a single, atomic statement'),
        type: z.enum(CLAIM_TYPES).default('fact'),
        confidence: z.number().min(0).max(1).optional(),
        confirmation: z
          .enum(CLAIM_CONFIRMATIONS)
          .optional()
          .default('suggested'),
        sources: z
          .array(sourceSchema)
          .optional()
          .describe('Evidence supporting the claim'),
        links: z
          .array(linkSchema)
          .optional()
          .describe('Entities this claim is about / linked to'),
        workspace_id: z
          .string()
          .optional()
          .describe(
            'Workspace to create in. Defaults to the active workspace. Copy it from the workspace_id on rows you read, or from active_workspace.',
          ),
      }),
      execute: async ({
        text,
        type,
        confidence,
        confirmation,
        sources,
        links,
        workspace_id,
      }) => {
        // CREATE-TIME WORKSPACE ROUTING (_shared.ts): an explicit workspace_id
        // wins (membership-checked), otherwise createWorkspacePolicy decides
        // whether to default to the session workspace or refuse and ask.
        // targetWs replaces `workspaceId` for EVERY lookup/write below — the
        // provenance verification, the insert, the member lookup, and the
        // embedding chunk.
        const ws = await resolveCreateWorkspace(supabase, userId, workspaceId, workspace_id, {
          strictWorkspace,
          policy: createWorkspacePolicy,
        })
        if (!ws.ok) return ws.error
        const targetWs = ws.workspaceId

        const memberId = await resolveMemberId(targetWs)

        // Verify every caller-supplied provenance id belongs to this workspace
        // BEFORE creating the claim — otherwise the agent (reachable via
        // service-role clients that bypass RLS) could be coaxed into wiring a
        // foreign entity id into this workspace's graph. Mirrors link_entities.
        for (const s of sources ?? []) {
          if (!s.source_id) continue
          if (!(LINKABLE_ENTITY_TYPES as readonly string[]).includes(s.source_type)) continue
          const ok = await entityInWorkspace(
            supabase,
            targetWs,
            s.source_type as (typeof LINKABLE_ENTITY_TYPES)[number],
            s.source_id,
            requestingUserId,
          )
          if (!ok) {
            return {
              success: false,
              error: `${s.source_type} "${s.source_id}" not found in this workspace`,
            }
          }
        }
        for (const l of links ?? []) {
          const ok = await entityInWorkspace(
            supabase,
            targetWs,
            l.entity_type,
            l.entity_id,
            requestingUserId,
          )
          if (!ok) {
            return {
              success: false,
              error: `${l.entity_type} "${l.entity_id}" not found in this workspace`,
            }
          }
        }

        const insert: Record<string, unknown> = {
          workspace_id: targetWs,
          text,
          type,
          confirmation: confirmation ?? 'suggested',
        }
        if (confidence !== undefined) insert.confidence = confidence
        if (memberId) insert.created_by = memberId

        const { data: claim, error } = await supabase
          .from('claim')
          .insert(insert)
          .select('id, text, type, confirmation, status')
          .single()
        if (error) return { success: false, error: error.message }

        // Provenance: claim_source (evidence) + entity_link (graph) written and
        // cross-reconciled in one place (GEN-108). A `cites`/`about` link to a
        // citable entity also registers as a source, and a source with an id
        // mirrors as a graph edge — so verification has a single place to look.
        if ((sources && sources.length > 0) || (links && links.length > 0)) {
          const { errors } = await attachClaimProvenance(supabase, {
            claimId: claim.id,
            workspaceId: targetWs,
            memberId,
            sources: (sources ?? []).map((s) => ({
              source_type: s.source_type,
              source_id: s.source_id ?? null,
              source_uri: s.source_uri ?? null,
              excerpt: s.excerpt ?? null,
            })),
            links: (links ?? []).map((l) => ({
              entity_type: l.entity_type,
              entity_id: l.entity_id,
              relation: l.relation ?? 'about',
            })),
          })
          if (errors.length > 0) {
            return {
              success: true,
              claim,
              warning: `Claim created but provenance partial: ${errors.join('; ')}`,
              ...workspaceEcho(targetWs, ws.workspaceName),
            }
          }
        }

        // Embed for semantic search (best-effort — don't fail the call if embedding fails)
        try {
          const embedding = await embed(text, userId)
          await supabase.from('claim_chunks').insert({
            claim_id: claim.id,
            workspace_id: targetWs,
            chunk_index: 0,
            chunk_text: text,
            embedding: `[${embedding.join(',')}]`,
          })
        } catch (embedErr) {
          return {
            success: true,
            claim,
            warning: `Claim created but embedding failed: ${embedErr instanceof Error ? embedErr.message : 'unknown'}`,
            ...workspaceEcho(targetWs, ws.workspaceName),
          }
        }

        return {
          success: true,
          claim,
          message: `Created ${claim.confirmation} claim`,
          ...workspaceEcho(targetWs, ws.workspaceName),
        }
      },
    }),

    confirm_claim: tool({
      description:
        'Mark a suggested claim as confirmed and stamp last_verified_at to now.',
      inputSchema: z.object({
        claim_id: z.string(),
      }),
      execute: async ({ claim_id }) => {
        const resolved = await resolveEntityWorkspace(
          supabase,
          userId,
          'claim',
          claim_id,
          workspaceId,
          strictWorkspace,
        )
        if (!resolved) return { success: false, error: 'Claim not found' }
        // A hidden claim is not found: its text never comes back through here.
        const readable = await claimReadable(claim_id)
        if (!readable.ok) return { success: false, error: readable.error }

        const { data, error } = await supabase
          .from('claim')
          .update({
            confirmation: 'confirmed',
            last_verified_at: new Date().toISOString(),
          })
          .eq('id', claim_id)
          .eq('workspace_id', resolved.workspaceId)
          .select('id, text, confirmation')
          .single()
        if (error) return { success: false, error: error.message }
        return { success: true, claim: data }
      },
    }),

    dismiss_claim: tool({
      description:
        'Dismiss a suggested or active claim. Sets confirmation=dismissed.',
      inputSchema: z.object({
        claim_id: z.string(),
      }),
      execute: async ({ claim_id }) => {
        const resolved = await resolveEntityWorkspace(
          supabase,
          userId,
          'claim',
          claim_id,
          workspaceId,
          strictWorkspace,
        )
        if (!resolved) return { success: false, error: 'Claim not found' }
        // A hidden claim is not found: its text never comes back through here.
        const readable = await claimReadable(claim_id)
        if (!readable.ok) return { success: false, error: readable.error }

        const { data, error } = await supabase
          .from('claim')
          .update({ confirmation: 'dismissed' })
          .eq('id', claim_id)
          .eq('workspace_id', resolved.workspaceId)
          .select('id, text, confirmation')
          .single()
        if (error) return { success: false, error: error.message }
        return { success: true, claim: data }
      },
    }),

    supersede_claim: tool({
      description:
        'Replace a claim with an updated version. Creates a new claim (confirmed) and marks the old one status=superseded with superseded_by pointing at the new claim. Use when a fact changes.',
      inputSchema: z.object({
        claim_id: z.string().describe('UUID of the claim being replaced'),
        new_text: z.string().describe('Text for the replacement claim'),
        new_type: z.enum(CLAIM_TYPES).optional(),
        confidence: z.number().min(0).max(1).optional(),
      }),
      execute: async ({ claim_id, new_text, new_type, confidence }) => {
        const resolved = await resolveEntityWorkspace(
          supabase,
          userId,
          'claim',
          claim_id,
          workspaceId,
          strictWorkspace,
        )
        if (!resolved) return { success: false, error: 'Claim not found' }
        // A hidden claim is not found: nobody supersedes (or copies the
        // evidence of) a claim they can't read.
        const readable = await claimReadable(claim_id)
        if (!readable.ok) return { success: false, error: readable.error }

        // Read the old claim to inherit type + event_at if not overridden.
        const { data: oldClaim, error: readErr } = await supabase
          .from('claim')
          .select('id, type, event_at')
          .eq('id', claim_id)
          .eq('workspace_id', resolved.workspaceId)
          .single()
        if (readErr) return { success: false, error: readErr.message }

        // The author is the caller's member row in the CLAIM's workspace, which
        // can differ from the session's when the id resolved cross-workspace.
        const memberId = await resolveMemberId(resolved.workspaceId)

        // Insert replacement claim (confirmed straight away — explicit user action).
        const insert: Record<string, unknown> = {
          workspace_id: resolved.workspaceId,
          text: new_text,
          type: new_type ?? oldClaim.type,
          confirmation: 'confirmed',
          status: 'active',
        }
        if (confidence !== undefined) insert.confidence = confidence
        if (memberId) insert.created_by = memberId
        // Inherit the old claim's event_at — the replacement restates the SAME
        // fact, so it pertains to the same real-world time (Wave 1 added the
        // column). Falling back to now() would silently make a corrected fact
        // read as "happened today", breaking temporal recall.
        if (oldClaim.event_at) insert.event_at = oldClaim.event_at

        const { data: newClaim, error: newErr } = await supabase
          .from('claim')
          .insert(insert)
          .select('id, text, type, confirmation')
          .single()
        if (newErr) return { success: false, error: newErr.message }

        // Mark old claim superseded.
        const { error: updateErr } = await supabase
          .from('claim')
          .update({ status: 'superseded', superseded_by: newClaim.id })
          .eq('id', claim_id)
          .eq('workspace_id', resolved.workspaceId)
        if (updateErr) return { success: false, error: updateErr.message }

        // Carry the old claim's evidence forward so the replacement isn't
        // left unsupported. Matches the /claims/[id]/supersede API route.
        const { data: oldSources } = await supabase
          .from('claim_source')
          .select('source_type, source_id, source_uri, excerpt')
          .eq('claim_id', claim_id)
        if (oldSources && oldSources.length > 0) {
          await supabase.from('claim_source').upsert(
            oldSources.map((s) => ({
              ...s,
              claim_id: newClaim.id,
              workspace_id: resolved.workspaceId,
            })),
            {
              onConflict: 'claim_id,source_type,source_id,source_uri',
              ignoreDuplicates: true,
            },
          )
        }

        // Graph edge: new --supersedes--> old.
        await supabase.from('entity_link').insert({
          workspace_id: resolved.workspaceId,
          source_type: 'claim',
          source_id: newClaim.id,
          target_type: 'claim',
          target_id: claim_id,
          relation: 'supersedes',
          created_by: memberId,
        })

        // Embed the replacement.
        try {
          const embedding = await embed(new_text, userId)
          await supabase.from('claim_chunks').insert({
            claim_id: newClaim.id,
            workspace_id: resolved.workspaceId,
            chunk_index: 0,
            chunk_text: new_text,
            embedding: `[${embedding.join(',')}]`,
          })
        } catch (embedErr) {
          // Surface the failure (mirrors create_claim): the replacement claim
          // exists and is confirmed, but without a chunk it won't appear in
          // semantic search until re-embedded — the caller should know.
          return {
            success: true,
            new_claim: newClaim,
            superseded_claim_id: claim_id,
            warning: `Replacement claim created but embedding failed — it will not appear in semantic search until re-embedded: ${embedErr instanceof Error ? embedErr.message : 'unknown'}`,
          }
        }

        return {
          success: true,
          new_claim: newClaim,
          superseded_claim_id: claim_id,
        }
      },
    }),

    link_entities: tool({
      description:
        'Create a graph edge between two entities. Use this to record that a claim is "about" a contact, a project "depends_on" another project, a document "cites" a capture, etc. The link is workspace-scoped.',
      inputSchema: z.object({
        source_type: z.enum(LINKABLE_ENTITY_TYPES),
        source_id: z.string(),
        target_type: z.enum(LINKABLE_ENTITY_TYPES),
        target_id: z.string(),
        relation: z.enum(RELATIONS).optional().default('mentions'),
        weight: z.number().optional(),
      }),
      execute: async ({
        source_type,
        source_id,
        target_type,
        target_id,
        relation,
        weight,
      }) => {
        if (source_type === target_type && source_id === target_id) {
          return { success: false, error: 'Cannot link an entity to itself' }
        }

        // Resolve the ANCHOR (source — the first/primary id) into its real
        // workspace before verifying either endpoint: a source_id copied from
        // the UI may live in another workspace the user belongs to, and the
        // whole edge should land there rather than being scoped blind to the
        // active workspace. Types fenced indirectly (cycle via team, milestone
        // via project — absent from WORKSPACE_SCOPED_TABLE) can't be resolved
        // this way; fall back to the active workspace, exactly as
        // entityInWorkspace's own can't-verify→allow does for them.
        let linkWs = workspaceId
        const anchorTable = WORKSPACE_SCOPED_TABLE[source_type]
        if (anchorTable) {
          const resolved = await resolveEntityWorkspace(
            supabase,
            userId,
            anchorTable,
            source_id,
            workspaceId,
            strictWorkspace,
          )
          if (!resolved) {
            return {
              success: false,
              error: `${source_type} "${source_id}" not found in this workspace`,
            }
          }
          linkWs = resolved.workspaceId
        }

        // Verify both endpoints belong to THAT workspace before creating the
        // edge — otherwise the agent could be coaxed into linking a foreign
        // entity ID into this workspace's graph.
        const srcOk = await entityInWorkspace(
          supabase,
          linkWs,
          source_type,
          source_id,
          requestingUserId,
        )
        if (!srcOk) {
          return {
            success: false,
            error: `${source_type} "${source_id}" not found in this workspace`,
          }
        }
        const tgtOk = await entityInWorkspace(
          supabase,
          linkWs,
          target_type,
          target_id,
          requestingUserId,
        )
        if (!tgtOk) {
          return {
            success: false,
            error: `${target_type} "${target_id}" not found in this workspace`,
          }
        }

        const memberId = await resolveMemberId(linkWs)
        const { data, error } = await supabase
          .from('entity_link')
          .insert({
            workspace_id: linkWs,
            source_type,
            source_id,
            target_type,
            target_id,
            relation: relation ?? 'mentions',
            weight: weight ?? null,
            created_by: memberId,
          })
          .select(
            'id, source_type, source_id, target_type, target_id, relation',
          )
          .single()
        if (error) {
          // Unique violation = link already exists; treat as success idempotently.
          if (error.code === '23505') {
            return { success: true, link: null, message: 'Link already exists' }
          }
          return { success: false, error: error.message }
        }
        return { success: true, link: data }
      },
    }),

    ingest_source: tool({
      description:
        'Kick off background ingestion of a source into the knowledge graph. The job extracts atomic claims from the source, dedupes against existing claims, and proposes new wiki pages. Results land as suggested for the user to review at /account/wiki/review. Use this when the user uploads a document, shares a link, or asks to "remember everything from <source>".',
      inputSchema: z.object({
        // Never 'email': Dial8 doesn't learn from mail (migration 341).
        source_type: z.enum([
          'attachment',
          'capture',
          'document',
          'external_url',
          'conversation',
        ]),
        source_id: z.string().optional().describe('UUID for internal sources'),
        source_uri: z
          .string()
          .optional()
          .describe('URL for external_url sources'),
        source_text: z
          .string()
          .optional()
          .describe(
            'Pre-fetched body text for external sources where you already have the content',
          ),
        source_label: z
          .string()
          .optional()
          .describe('Human-friendly source name shown to the user'),
      }),
      execute: async ({
        source_type,
        source_id,
        source_uri,
        source_text,
        source_label,
      }) => {
        if (source_type === 'external_url' && !source_text) {
          return {
            success: false,
            error:
              'external_url ingestion requires source_text (the page body). Fetch the URL first.',
          }
        }
        if (source_type !== 'external_url' && !source_id) {
          return {
            success: false,
            error: `${source_type} ingestion requires source_id`,
          }
        }

        // Resolve the ANCHOR (source_id — the id this whole job hangs off of)
        // into its real workspace before dispatching: an id copied from the UI
        // may live in another workspace the user belongs to, and the job must
        // scan THAT workspace for it, not silently scan the active one and
        // find nothing. external_url has no anchor id — nothing to resolve.
        let targetWorkspaceId = workspaceId
        if (source_id && source_type !== 'external_url') {
          const anchorTable = WORKSPACE_SCOPED_TABLE[source_type as LinkableEntityType]
          if (anchorTable) {
            const resolved = await resolveEntityWorkspace(
              supabase,
              userId,
              anchorTable,
              source_id,
              workspaceId,
              strictWorkspace,
            )
            if (!resolved) {
              return {
                success: false,
                error: `${source_type} "${source_id}" not found in this workspace`,
              }
            }
            targetWorkspaceId = resolved.workspaceId
          }
        }

        // The person's Now file (migration 440) is the main agent's sketchpad,
        // never a source of claims: what it says lives where it points.
        if (source_type === 'document' && source_id) {
          const { data: doc, error: docError } = await supabase
            .from('document')
            .select('kind')
            .eq('id', source_id)
            .eq('workspace_id', targetWorkspaceId)
            .maybeSingle()
          if (docError) return { success: false, error: docError.message }
          if ((doc as { kind?: unknown } | null)?.kind === NOW_KEY) {
            return { success: false, error: "That is the person's Now file: it isn't ingested into the knowledge graph. Ingest what its lines point at instead." }
          }
        }

        const { data: member } = await supabase
          .from('member')
          .select('id')
          .eq('user_id', userId)
          .eq('workspace_id', targetWorkspaceId)
          .maybeSingle()

        await inngest.send({
          name: 'claim/extract-from-source',
          data: {
            workspaceId: targetWorkspaceId,
            userId,
            memberId: member?.id ?? null,
            sourceType: source_type,
            sourceId: source_id,
            sourceUri: source_uri,
            sourceText: source_text,
            sourceLabel: source_label,
          },
        })

        return {
          success: true,
          message:
            'Ingestion started. Proposed claims and page drafts will appear at /account/wiki/review.',
        }
      },
    }),

    ingest_reference: tool({
      description:
        'Ingest a PDF attachment as STRUCTURED REFERENCE material (API specs, data models, schemas, technical specs). Generates a navigable wiki — an index document plus one spec-type page per endpoint/object with VERBATIM payloads — linked to the project and readable via get_document. Use when the user wants a spec queryable in detail ("ingest this API spec"). For narrative content (notes, articles), use ingest_source instead. Re-ingesting the same attachment refreshes its pages.',
      inputSchema: z.object({
        attachment_id: z.string().describe('UUID of the PDF attachment'),
        project_id: z
          .string()
          .optional()
          .describe('Project to link the generated pages to'),
      }),
      execute: async ({ attachment_id, project_id }) => {
        // Resolve the ANCHOR (attachment_id) into its real workspace first: an
        // id copied from the UI may live in another workspace the user
        // belongs to. The project check (and the job itself) then run against
        // THAT workspace, not the active one.
        const resolved = await resolveEntityWorkspace(
          supabase,
          userId,
          'attachments',
          attachment_id,
          workspaceId,
          strictWorkspace,
        )
        if (!resolved) {
          return { success: false, error: 'Attachment not found in this workspace' }
        }
        const targetWs = resolved.workspaceId

        const { data: attachment } = await supabase
          .from('attachments')
          .select('id, file_name, mime_type')
          .eq('id', attachment_id)
          .eq('workspace_id', targetWs)
          .maybeSingle()
        if (!attachment) {
          return { success: false, error: 'Attachment not found in this workspace' }
        }
        if (attachment.mime_type !== 'application/pdf') {
          return {
            success: false,
            error: `Only PDFs are supported for reference ingestion (got ${attachment.mime_type}). Use ingest_source for text content.`,
          }
        }
        if (project_id) {
          const ok = await entityInWorkspace(supabase, targetWs, 'project', project_id)
          if (!ok) return { success: false, error: 'Project not found in this workspace' }
        }

        await inngest.send({
          name: 'reference/ingest',
          data: {
            workspaceId: targetWs,
            userId,
            attachmentId: attachment_id,
            projectId: project_id ?? null,
          },
        })

        return {
          success: true,
          message: `Reference ingestion started for "${attachment.file_name}". If it is reference material, an index + per-entity spec pages will appear in documents (type "spec") shortly; narrative content is skipped by the classifier.`,
        }
      },
    }),

    traverse: tool({
      description:
        'Walk the entity graph one hop. Returns entities linked to a given entity, each WITH a resolved label so you usually don\'t need a follow-up get_* call. Use direction="outbound" for what the entity links to, "inbound" for what links to it, "both" for everything. Filter by relation. For multi-hop context in one call, prefer get_context_bundle. ' +
        'The entity lives in exactly ONE workspace; set `cross_workspace: true` to resolve which of the user\'s workspaces holds this entity_id (e.g. an id copied from another workspace) and traverse there.',
      inputSchema: z.object({
        entity_type: z.enum(LINKABLE_ENTITY_TYPES),
        entity_id: z.string(),
        direction: z
          .enum(['outbound', 'inbound', 'both'])
          .optional()
          .default('both'),
        relation: z.enum(RELATIONS).optional(),
        limit: z.number().optional().default(50),
        cross_workspace: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'The entity lives in ONE workspace. When true, resolve which of the user\'s workspaces contains this entity_id (not necessarily the active one) and traverse the graph there instead of assuming the active workspace.',
          ),
      }),
      execute: async ({
        entity_type,
        entity_id,
        direction,
        relation,
        limit,
        cross_workspace,
      }) => {
        const dir = direction ?? 'both'
        // An email is one person's mail: the walk shows nothing around it
        // (migration 341). Same shape as an entity with no links.
        const empty = {
          success: true as const,
          ...(dir === 'outbound' || dir === 'both' ? { outbound: [] } : {}),
          ...(dir === 'inbound' || dir === 'both' ? { inbound: [] } : {}),
        }
        if (isMailSourceType(entity_type)) return empty

        // The graph is workspace-scoped. Normally we traverse the active
        // workspace; cross_workspace resolves the entity's OWN workspace (via a
        // membership-gated lookup) so an id from another workspace still works.
        let scopeWorkspaceId = workspaceId
        if (cross_workspace) {
          const table = WORKSPACE_SCOPED_TABLE[entity_type]
          if (table) {
            const resolved = await resolveEntityWorkspace(
              supabase,
              userId,
              table,
              entity_id,
              workspaceId,
              strictWorkspace,
            )
            if (!resolved) {
              return {
                success: false,
                error: `${entity_type} "${entity_id}" not found in any workspace you belong to`,
              }
            }
            scopeWorkspaceId = resolved.workspaceId
          }
          // Types without a direct workspace_id column (e.g. cycle) can't be
          // resolved this way — fall back to the active workspace, same as the
          // non-cross path.
        }
        const results: {
          outbound?: {
            target_type: string
            target_id: string
            relation: string
            label?: string | null
          }[]
          inbound?: {
            source_type: string
            source_id: string
            relation: string
            label?: string | null
          }[]
        } = {}

        if (dir === 'outbound' || dir === 'both') {
          let q = supabase
            .from('entity_link')
            .select('target_type, target_id, relation')
            .eq('workspace_id', scopeWorkspaceId)
            .eq('source_type', entity_type)
            .eq('source_id', entity_id)
            .limit(limit)
          if (relation) q = q.eq('relation', relation)
          const { data, error } = await q
          if (error) return { success: false, error: error.message }
          results.outbound = (data || []) as {
            target_type: string
            target_id: string
            relation: string
          }[]
        }

        if (dir === 'inbound' || dir === 'both') {
          let q = supabase
            .from('entity_link')
            .select('source_type, source_id, relation')
            .eq('workspace_id', scopeWorkspaceId)
            .eq('target_type', entity_type)
            .eq('target_id', entity_id)
            .limit(limit)
          if (relation) q = q.eq('relation', relation)
          const { data, error } = await q
          if (error) return { success: false, error: error.message }
          results.inbound = (data || []) as {
            source_type: string
            source_id: string
            relation: string
          }[]
        }

        // A claim is readable only when one of its sources is, and mail never
        // is (migration 341); a chat is its owner's alone (353): drop email
        // neighbours, hidden claims and other people's chats; a hidden centre
        // has no neighbours. Batched reads; a failure fails closed.
        const idsOf = (type: string) => [
          ...(entity_type === type ? [entity_id] : []),
          ...(results.outbound ?? []).filter((e) => e.target_type === type).map((e) => e.target_id),
          ...(results.inbound ?? []).filter((e) => e.source_type === type).map((e) => e.source_id),
        ]
        const claimIds = idsOf('claim')
        const chatIds = idsOf(CONVERSATION_SOURCE_TYPE)
        const [hiddenClaims, hiddenChats] = await Promise.all([
          claimIds.length > 0 ? claimIdsHiddenFrom(supabase, claimIds, requestingUserId) : new Set<string>(),
          chatIds.length > 0 ? conversationIdsHiddenFrom(supabase, chatIds, requestingUserId) : new Set<string>(),
        ])
        if (!hiddenClaims || !hiddenChats) return { success: false, error: 'Could not read the graph. Try again.' }
        if (entity_type === 'claim' && hiddenClaims.has(entity_id)) return empty
        if (entity_type === CONVERSATION_SOURCE_TYPE && hiddenChats.has(entity_id)) return empty
        const shown = (type: string, id: string) =>
          !isMailSourceType(type) &&
          !(type === 'claim' && hiddenClaims.has(id)) &&
          !(type === CONVERSATION_SOURCE_TYPE && hiddenChats.has(id))
        if (results.outbound) results.outbound = results.outbound.filter((e) => shown(e.target_type, e.target_id))
        if (results.inbound) results.inbound = results.inbound.filter((e) => shown(e.source_type, e.source_id))

        // Resolve labels for every neighbor in one batched pass so the agent
        // gets readable names inline instead of issuing N follow-up gets.
        const refs: Array<{ type: string; id: string }> = [
          ...(results.outbound ?? []).map((e) => ({ type: e.target_type, id: e.target_id })),
          ...(results.inbound ?? []).map((e) => ({ type: e.source_type, id: e.source_id })),
        ]
        const labels = await resolveLabels(refs, scopeWorkspaceId)
        for (const e of results.outbound ?? []) e.label = labels[`${e.target_type}:${e.target_id}`] ?? null
        for (const e of results.inbound ?? []) e.label = labels[`${e.source_type}:${e.source_id}`] ?? null

        return {
          success: true,
          ...results,
          ...(cross_workspace && scopeWorkspaceId !== workspaceId
            ? {
                workspace_hint: `This entity lives in workspace ${scopeWorkspaceId}, not the currently active one.`,
              }
            : {}),
        }
      },
    }),

    get_context_bundle: tool({
      description:
        'Assemble the connected knowledge subgraph around an entity in ONE call — claims about it, the entities they link to, and the edges between them, with labels resolved. Prefer this over chaining get_claim + traverse + get_* when you need context for a contact, project, capture, action, or claim. Returns a compact { center, depth, nodes, edges } graph. Use depth 1 for immediate neighbors, 2 (default) for a richer bundle. ' +
        'The entity lives in exactly ONE workspace; set `cross_workspace: true` to resolve which of the user\'s workspaces holds this entity_id (e.g. an id copied from another workspace) and build the bundle there.',
      inputSchema: z.object({
        entity_type: z.enum(LINKABLE_ENTITY_TYPES),
        entity_id: z.string(),
        depth: z
          .number()
          .int()
          .min(1)
          .max(3)
          .optional()
          .default(2)
          .describe('How many hops to walk (1-3). Default 2.'),
        limit: z
          .number()
          .int()
          .optional()
          .default(60)
          .describe('Max edges to return. Default 60.'),
        cross_workspace: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'The entity lives in ONE workspace. When true, resolve which of the user\'s workspaces contains this entity_id (not necessarily the active one) and build the bundle there instead of assuming the active workspace.',
          ),
      }),
      execute: async ({ entity_type, entity_id, depth, limit, cross_workspace }) => {
        // The neighborhood is workspace-scoped. Normally we build it in the
        // active workspace; cross_workspace resolves the entity's OWN workspace
        // (membership-gated) so an id from another workspace still resolves.
        let scopeWorkspaceId = workspaceId
        if (cross_workspace) {
          const table = WORKSPACE_SCOPED_TABLE[entity_type]
          if (table) {
            const resolved = await resolveEntityWorkspace(
              supabase,
              userId,
              table,
              entity_id,
              workspaceId,
              strictWorkspace,
            )
            if (!resolved) {
              return {
                success: false,
                error: `${entity_type} "${entity_id}" not found in any workspace you belong to`,
              }
            }
            scopeWorkspaceId = resolved.workspaceId
          }
          // Types without a direct workspace_id column (e.g. cycle) can't be
          // resolved this way — fall back to the active workspace.
        }
        const { data, error } = await supabase.rpc('claim_neighborhood', {
          p_workspace_id: scopeWorkspaceId,
          p_entity_type: entity_type,
          p_entity_id: entity_id,
          p_depth: depth ?? 2,
          p_limit: limit ?? 60,
          p_requesting_user_id: requestingUserId,
        })
        if (error) return { success: false, error: error.message }
        // The RPC returns a single jsonb document { center, depth, nodes, edges }.
        // Guard the shape: a null/array/non-object response (e.g. if PostgREST
        // ever wrapped the result) must surface as an error, not be silently
        // spread into a fake "successful" empty bundle.
        if (
          data != null &&
          (typeof data !== 'object' ||
            Array.isArray(data) ||
            !Array.isArray((data as { nodes?: unknown }).nodes) ||
            !Array.isArray((data as { edges?: unknown }).edges))
        ) {
          return {
            success: false,
            error: 'claim_neighborhood returned an unexpected shape',
          }
        }
        const bundle = (data ?? {
          center: { type: entity_type, id: entity_id },
          depth: depth ?? 2,
          nodes: [],
          edges: [],
        }) as {
          center: { type: string; id: string }
          depth: number
          nodes: unknown[]
          edges: unknown[]
        }
        // claim_neighborhood joins contact.full_name and company.name with no
        // visibility check on either (it fences claims/captures only), so a
        // hidden contact or company node's label is replaced here, the same as
        // traverse's.
        const withoutMail = await dropHiddenFromBundle(supabase, {
          center: bundle.center ?? { type: entity_type, id: entity_id },
          nodes: bundle.nodes ?? [],
          edges: bundle.edges ?? [],
        }, requestingUserId)
        if (!withoutMail) return { success: false, error: 'Could not read the graph. Try again.' }
        bundle.edges = withoutMail.edges
        bundle.nodes = await fenceBundleLabels(supabase, userId, withoutMail.nodes)
        return {
          success: true,
          ...bundle,
          node_count: bundle.nodes?.length ?? 0,
          edge_count: bundle.edges?.length ?? 0,
          ...(cross_workspace && scopeWorkspaceId !== workspaceId
            ? {
                workspace_hint: `This entity lives in workspace ${scopeWorkspaceId}, not the currently active one.`,
              }
            : {}),
        }
      },
    }),
  }
}
