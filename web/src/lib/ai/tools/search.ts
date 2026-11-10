import { tool } from 'ai'
import { webText } from './web-derived'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { embed } from '@/lib/ai/embeddings'
import { embedQuery } from '@/lib/ai/gemini-embeddings'
import { searchEmails as dualSearchEmails } from '@/lib/email/email-search-service'
import { searchEmailsWithContext } from '@/lib/email/email-context-service'
import { resolveSince, resolveUntil, getUserWorkspaces, captureRequester } from './_shared'
import { fuseWorkspaces, fuseByRank, resolveRecencyWeight, type FusableRow } from './search-fusion'
import { resolveSearchWindow, type SearchDefaultWindow, type SearchScope } from './search-scope'
import { entityDescriptor } from '@/lib/knowledge/entity-registry'
import { hiddenGraphRefs } from '@/lib/knowledge/entity-fences'
import { isMailSourceType, mailSourcedClaimIds } from '@/lib/knowledge/claim-visibility'
import { filterVisibleContacts } from '@/lib/crm/contact-visibility'
import { toIlikeSearchTerm } from '@/lib/crm/ilike-search-term'
import { filterRetrievalPassages, type RetrievalPassage } from '@/lib/ai/decisions/retrieval-filter'
import { wrapUntrusted, type UntrustedKind } from '@/lib/email/untrusted'
import { dropNowDocuments } from '@/lib/now/now-file'

/** deep_search passages as a model reads them: each `chunk_text` inside the untrusted marker (A5). */
export function fenceChunks<T>(rows: T[], kind: UntrustedKind): T[] {
  return rows.map((row) => {
    const text = (row as { chunk_text?: unknown }).chunk_text
    return typeof text === 'string' && text !== '' ? { ...row, chunk_text: wrapUntrusted(text, kind) } : row
  })
}

/**
 * Sanitize an error coming from an external provider so internal billing
 * URLs, API keys, or stack hints don't leak into the MCP response.
 */
function sanitizeProviderError(err: unknown, fallback: string): string {
  // Always log the real error server-side so we can debug.
  if (err) console.error('[search] provider error:', err)
  return fallback
}

/**
 * Which of `captureIds` are `visibility = 'workspace'` in this workspace.
 *
 * rag_search / attachment_rag_search are keyed on the CHUNK's user_id — the
 * capture's OWNER at index time — so an unattended run "as" the creator still
 * gets that creator's own private chunks back. Post-filter on the parent capture
 * so the omit-private contract holds. Batched; fails closed (a capture that
 * doesn't come back is treated as hidden).
 */
async function workspaceVisibleCaptureIds(
  supabase: SupabaseClient,
  workspaceId: string,
  captureIds: string[],
): Promise<Set<string>> {
  if (captureIds.length === 0) return new Set()
  const { data } = await supabase
    .from('captures')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('visibility', 'workspace')
    .in('id', captureIds)
  return new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id))
}

interface UnifiedResultRow {
  result_type: string
  result_id: string
  title: string
  subtitle?: string
  icon?: string
  rank: number
  metadata?: Record<string, unknown>
}

/**
 * Drop claims learned from mail, and any row whose provenance is mail, from a
 * search result list (migration 341: shown to no one). The search RPCs do the
 * same once 341 is applied; this holds before it. `null` when the claim read
 * failed: the caller drops the whole list (fails closed).
 */
export async function dropMailFromResults<T extends { result_type: string; result_id: string; source_type?: string | null }>(
  supabase: SupabaseClient,
  rows: T[],
): Promise<T[] | null> {
  const claimIds = rows.filter((r) => r.result_type === 'claim').map((r) => r.result_id)
  const hidden = claimIds.length > 0 ? await mailSourcedClaimIds(supabase, claimIds) : new Set<string>()
  if (!hidden) return null
  return rows.filter(
    (r) =>
      !isMailSourceType(r.source_type ?? null) &&
      !(r.result_type === 'claim' && hidden.has(r.result_id)),
  )
}

/** Run unified_search against a single workspace and tag results with the workspace. */
async function runUnifiedSearch(
  supabase: SupabaseClient,
  workspace: { id: string; name: string },
  query: string,
  rpcTypes: string[],
  limit: number,
  requestingUserId: string | null,
): Promise<{ results: Array<UnifiedResultRow & { workspace_id: string; workspace_name: string }>; error?: string }> {
  const { data, error } = await supabase.rpc('unified_search', {
    p_workspace_id: workspace.id,
    p_query: query,
    p_types: rpcTypes,
    p_limit: limit,
    p_requesting_user_id: requestingUserId,
  })
  if (error) return { results: [], error: error.message }
  const shown = await dropMailFromResults(supabase, (data as UnifiedResultRow[]) || [])
  if (!shown) return { results: [], error: 'Could not read claims' }
  const tagged = shown.map((r) => ({
    ...r,
    workspace_id: workspace.id,
    workspace_name: workspace.name,
  }))
  return { results: tagged }
}

/** Apply a started_at "since"/"until" filter to capture results post-fetch. */
function filterCapturesByTime(
  results: Array<UnifiedResultRow & { workspace_id: string; workspace_name: string }>,
  sinceISO: string | null,
  untilISO: string | null,
) {
  if (!sinceISO && !untilISO) return results
  return results.filter((r) => {
    if (r.result_type !== 'capture') return true
    const startedAt = (r.metadata as { started_at?: string } | undefined)?.started_at
    // Captures with no started_at (e.g. manual notes) are kept — the user
    // didn't ask to exclude them, and silently dropping them is surprising.
    if (!startedAt) return true
    const t = new Date(startedAt).getTime()
    if (sinceISO && t < new Date(sinceISO).getTime()) return false
    if (untilISO && t > new Date(untilISO).getTime()) return false
    return true
  })
}

/**
 * The most contact hits `find` / `search` return per workspace in one call. Each
 * fetched row costs one contact_visible_to RPC (it takes a single contact id and
 * no batch form exists), so the fetch is bounded at
 * MAX_CONTACT_SEARCH_LIMIT * CONTACT_OVERFETCH rows. A larger `limit` is
 * CLAMPED to this, and the tool response says so (`contact_limit_clamped_to`)
 * rather than silently returning fewer rows than asked for.
 */
export const MAX_CONTACT_SEARCH_LIMIT = 50
/** Over-fetch factor so hidden rows do not crowd visible matches out of the limit. */
const CONTACT_OVERFETCH = 2

/** A requested contact limit, clamped to [1, MAX_CONTACT_SEARCH_LIMIT]. */
export function clampContactLimit(limit: number): number {
  const n = Math.floor(limit)
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(n, MAX_CONTACT_SEARCH_LIMIT)
}

/** The response field recording a clamp, present only when `requested` exceeded the max. */
function contactClampNote(requested: number): { contact_limit_clamped_to?: number } {
  return requested > MAX_CONTACT_SEARCH_LIMIT ? { contact_limit_clamped_to: MAX_CONTACT_SEARCH_LIMIT } : {}
}

/**
 * Workspace-scoped CRM contact keyword search (replaces the broken `contacts` table branch).
 *
 * `find` / `search` run on a SERVICE-ROLE client on the internal tool routes
 * (chat, live-agent, utility, work-run), where the contact table's RLS
 * (mig 058 contact_select_visibility) does not apply. Every row is fenced
 * through contact_visible_to(contact, userId) — the verified caller — and fails
 * closed (contact-visibility.ts). `limit` is clamped (clampContactLimit) and the
 * query over-fetches CONTACT_OVERFETCH x that, so the per-row visibility RPCs
 * stay bounded while hidden rows do not crowd visible matches out.
 */
async function searchContactsInWorkspace(
  supabase: SupabaseClient,
  userId: string,
  workspace: { id: string; name: string },
  query: string,
  limit: number,
  relationshipType?: string,
) {
  // Shared with the live agent's search_contacts and resolveContactIdByName:
  // strips what could add `.or()` conditions or turn the ilike into match-all.
  const safe = toIlikeSearchTerm(query)
  if (!safe) return { results: [] as Array<UnifiedResultRow & { workspace_id: string; workspace_name: string }> }

  let q = supabase
    .from('contact')
    .select('id, full_name, email, job_title, relationship_type, last_interaction_at, avatar_url, company:company_id(id, name)')
    .eq('workspace_id', workspace.id)
    .or(`full_name.ilike.%${safe}%,email.ilike.%${safe}%`)
    .limit(clampContactLimit(limit) * CONTACT_OVERFETCH)

  if (relationshipType) q = q.eq('relationship_type', relationshipType)

  const { data, error } = await q
  if (error) return { results: [], error: error.message }

  const visible = (await filterVisibleContacts(supabase, userId, data || [])).slice(0, clampContactLimit(limit))

  const results = visible.map((c) => {
    const company = c.company as unknown as { id: string; name: string } | null
    return {
      result_type: 'contact',
      result_id: c.id,
      title: c.full_name,
      // The job title can come from web enrichment: fenced (web-derived.ts).
      subtitle: webText([c.job_title, company?.name].filter(Boolean).join(' at ')) || c.email || null,
      icon: '',
      rank: 0,
      workspace_id: workspace.id,
      workspace_name: workspace.name,
      metadata: {
        email: c.email,
        relationship_type: c.relationship_type,
        last_interaction_at: c.last_interaction_at,
        avatar_url: c.avatar_url,
      },
    } as UnifiedResultRow & { workspace_id: string; workspace_name: string }
  })

  return { results }
}

/** One row from hybrid_search / hybrid_search_attachments, workspace-tagged. */
interface HybridRow extends FusableRow {
  result_type: string
  result_id: string
  title: string | null
  score: number | null
  event_at: string | null
  fts_rank: number | null
  vec_rank: number | null
  recency_rank: number | null
  excerpt: string | null
  source_label: string | null
  source_type: string | null
  metadata: Record<string, unknown> | null
  workspace_id: string
  workspace_name: string
  /** Attached post-RPC by enrichWithAnchorNames — the resolved ANCHOR name for a
   *  claim (via graph edge) or a capture/document (via metadata.project_id). */
  anchor_name?: string
  /** Which anchor type `anchor_name` came from ('project' | 'company' | …). */
  anchor_type?: string
  /**
   * Back-compat alias of `anchor_name`, set only when the anchor IS a project.
   * Every pre-anchor consumer (and find.test.ts) reads this field; it stays
   * project-only so a company anchor can never masquerade as a project name.
   */
  project_name?: string
}

const HYBRID_TYPES = ['claim', 'capture', 'document'] as const
const FIND_TYPES = [
  'claim',
  'capture',
  'document',
  'attachment',
  'contact',
  'email',
] as const

/**
 * Resolve the active workspace's display name ONCE per find call. Cross-workspace
 * fan-out already carries names (getUserWorkspaces), but the single-workspace path
 * historically tagged results with '' — this fills that gap so in-workspace hits
 * report where they live. Falls back to '' on any lookup failure (the name is a
 * label, never load-bearing for correctness).
 */
async function resolveActiveWorkspaceName(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<string> {
  try {
    const { data } = await supabase.from('workspace').select('name').eq('id', workspaceId).maybeSingle()
    return (data as { name?: string | null } | null)?.name ?? ''
  } catch {
    return ''
  }
}

/**
 * The anchor types a claim may hang off. Kept as a literal list rather than
 * derived from the workspace's configured anchor set: `find` fuses results
 * across MULTIPLE workspaces, each with its own set, and an over-wide `IN` on
 * one indexed query is far cheaper than resolving per-workspace configuration
 * before the query can even be issued. A type nobody uses simply matches no
 * edges. `contact` is excluded on purpose — a claim's contact edges are
 * commitments, not the topic the reader needs disambiguated.
 */
const ANCHOR_TARGET_TYPES = ['project', 'company', 'campaign'] as const

/** Title-case label prefix for a rewritten bare-anchor source_label. */
const ANCHOR_LABEL_PREFIX: Record<string, string> = {
  project: 'Project',
  company: 'Company',
  campaign: 'Campaign',
}

/**
 * Batch-attach ANCHOR names to a fused find result list.
 *
 * Token-cheap provenance disambiguation (the concrete incident: a "Rios" claim
 * filed under project "KokoLink" was mistaken for a "ORCA" answer whose claims
 * live under "Atlas (Lookup / ORCA / TIDE)" — visible anchor names would have
 * exposed the mismatch). Names only; no descriptions.
 *
 * Was project-only; now anchor-typed, keeping the same batched shape:
 *   1. ONE entity_link query, `target_type IN (ANCHOR_TARGET_TYPES)` — claims →
 *      anchors via the graph's cites/about/related_to/mentions edges. Surfaces a
 *      claim's anchor even when the RPC's single inline top-provenance was
 *      something else (e.g. a capture that carried the excerpt), AND covers the
 *      bare-anchor top-provenance case in one shot.
 *   2. ONE label query PER ANCHOR TYPE actually present in (1) — table and
 *      columns come from the entity registry. Bounded by the number of anchor
 *      types (≤3 today), never by row count: still not N+1.
 *
 * Mutations applied in place:
 *   - `anchor_name` + `anchor_type` set on any row whose anchor resolved.
 *   - `project_name` set too when that anchor is a PROJECT — the back-compat
 *     alias every pre-anchor consumer reads.
 *   - For claims whose top provenance is a bare anchor (source_type ===
 *     'project'/'company'/…, source_label the literal type string),
 *     `source_label` is rewritten to "Project: <name>" / "Company: <name>"
 *     (field shape unchanged — still a string).
 */
async function enrichWithAnchorNames(supabase: SupabaseClient, rows: HybridRow[], requester: string | null): Promise<void> {
  if (rows.length === 0) return

  // Claim ids get the entity_link anchor-edge lookup; capture/document ids read
  // project_id straight off the metadata the RPC already returned.
  const claimRows = rows.filter((r) => r.result_type === 'claim')
  const claimIds = [...new Set(claimRows.map((r) => r.result_id))]

  // (1) One batched entity_link query: claim → anchor edges across every
  //     workspace present in the result set (UUIDs are globally unique; RLS
  //     still fences reads to the caller's workspaces).
  const claimToAnchor = new Map<string, { type: string; id: string }>()
  if (claimIds.length > 0) {
    try {
      const { data } = await supabase
        .from('entity_link')
        .select('source_id, target_id, target_type, relation')
        .eq('source_type', 'claim')
        .in('target_type', [...ANCHOR_TARGET_TYPES])
        .in('source_id', claimIds)
      // Prefer the strongest semantic relation when a claim has several anchor
      // edges: about > related_to > cites > mentions. First-seen wins per rank.
      const RELATION_RANK: Record<string, number> = { about: 0, related_to: 1, cites: 2, mentions: 3 }
      const bestRank = new Map<string, number>()
      for (const link of (data ?? []) as Array<{
        source_id: string
        target_id: string
        target_type: string
        relation: string
      }>) {
        const rank = RELATION_RANK[link.relation] ?? 9
        if (!bestRank.has(link.source_id) || rank < (bestRank.get(link.source_id) as number)) {
          bestRank.set(link.source_id, rank)
          claimToAnchor.set(link.source_id, { type: link.target_type, id: link.target_id })
        }
      }
    } catch {
      // Non-fatal — claims just won't carry an anchor name.
    }
    // An edge is readable only when both ends are (migration 500), and this
    // runs service-role: an anchor the requester can't read (a company hidden
    // from them) is no anchor, so its name never rides along.
    const hidden = await hiddenGraphRefs(supabase, [...claimToAnchor.values()], requester)
    for (const [claimId, anchor] of claimToAnchor) if (hidden.has(`${anchor.type}:${anchor.id}`)) claimToAnchor.delete(claimId)
  }

  // Gather every anchor id we need a name for, bucketed by type: claim-edge
  // targets + the project_id the RPC put on capture/document metadata.
  const idsByType = new Map<string, Set<string>>()
  const addId = (type: string, id: string) => {
    const bucket = idsByType.get(type) ?? new Set<string>()
    bucket.add(id)
    idsByType.set(type, bucket)
  }
  for (const anchor of claimToAnchor.values()) addId(anchor.type, anchor.id)
  for (const r of rows) {
    const pid = (r.metadata as { project_id?: string | null } | null)?.project_id
    if (pid) addId('project', pid)
  }
  if (idsByType.size === 0) return

  // (2) One batched label query per anchor type present. Table/columns/render
  //     come from the entity registry, so a new anchor type needs no edit here.
  const nameByTypeId = new Map<string, string>()
  const key = (type: string, id: string) => `${type}:${id}`
  await Promise.all(
    [...idsByType.entries()].map(async ([type, ids]) => {
      const descriptor = entityDescriptor(type)
      if (!descriptor) return
      const { table, columns, render } = descriptor.label
      try {
        // The select list is composed at runtime from the registry, so
        // PostgREST's literal-string column typing can't follow it.
        const { data } = await supabase.from(table).select(`id, ${columns}`).in('id', [...ids])
        for (const row of (data ?? []) as unknown as Array<Record<string, unknown>>) {
          const name = render(row)
          if (name) nameByTypeId.set(key(type, String(row.id)), name)
        }
      } catch {
        // Non-fatal — rows anchored to this type just won't carry a name.
      }
    }),
  )
  if (nameByTypeId.size === 0) return

  for (const r of rows) {
    // Capture / document: project_id lives on metadata.
    const metaPid = (r.metadata as { project_id?: string | null } | null)?.project_id
    const claimAnchor = r.result_type === 'claim' ? claimToAnchor.get(r.result_id) : undefined
    const anchor =
      claimAnchor ?? (metaPid ? { type: 'project', id: metaPid } : null)
    if (!anchor) continue
    const name = nameByTypeId.get(key(anchor.type, anchor.id))
    if (!name) continue

    r.anchor_name = name
    r.anchor_type = anchor.type
    // Back-compat: the pre-anchor field is project-only by design.
    if (anchor.type === 'project') r.project_name = name

    // Bare anchor top-provenance on a claim → label it by name. The RPC's ELSE
    // branch returns the literal source_type string ("project") as source_label;
    // replace it with a human-readable, name-bearing label.
    if (r.result_type === 'claim' && r.source_type === anchor.type) {
      r.source_label = `${ANCHOR_LABEL_PREFIX[anchor.type] ?? anchor.type}: ${name}`
    }
  }
}

export function createSearchTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  omitPrivateCaptures = false,
  /** What a search with no window covers (search-scope.ts): all time, unless the main chat passes the past 4 weeks. */
  searchDefaultWindow: SearchDefaultWindow = 'all_time',
  /** A run fenced to one workspace: `cross_workspace` is ignored, never fanned out. */
  strictWorkspace = false,
  /**
   * The person's Now file (docs/plans/now-file.md) may come back as a hit:
   * only in their own main chat (the chat tool route's nowContext.readable).
   * Everywhere else `find` and `search` drop it.
   */
  nowReadable = false,
) {
  // The toolset's default, spoken in the descriptions so the model knows what
  // a search with no window covers here.
  const defaultsToRecent = searchDefaultWindow === 'past_4_weeks'
  // Requester threaded into every visibility-aware SECURITY DEFINER RPC. null =
  // fail closed (private captures, and claims sourced only from them, excluded).
  const requestingUserId = captureRequester(userId, omitPrivateCaptures)
  return {
    find: tool({
      description:
        'Unified ranked search across claims, captures, documents, and (optionally) attachments, contacts, and emails. ' +
        'Fuses keyword (FTS) and semantic (vector) matching with recency into ONE ranked list — no separate ' +
        'semantic-vs-keyword tool needed. Each result carries inline provenance (excerpt + source_label + source_type) ' +
        'so you usually do NOT need a follow-up get_claim/get_capture call. ' +
        (defaultsToRecent
          ? 'Scope: with no `since`/`until`/`all_time` it searches captures, attachments and emails from the PAST 4 WEEKS; claims (durable facts) and documents are always searched in full. Set `all_time: true` for all history. '
          : 'Scope: with no `since`/`until` it searches all history. ') +
        'Use `since`/`until` for a range ("last week", "a month ago"; combine with a topic in `query` for ' +
        '"what came up last week about X"; the window filters by the item\'s real-world event time, claims included). ' +
        'Capture hits are matched on title, notes, summary AND transcript, but the excerpt is the summary: for the words ' +
        'someone said, use deep_search with include_transcripts or get_capture_transcript. ' +
        'The result\'s `scope` says what was searched: if it is thin, widen rather than conclude nothing exists. ' +
        'This is the front door; use get_claim / get_context_bundle for the deep dive on a specific hit.',
      inputSchema: z.object({
        query: z.string().describe('Topic or keywords — semantic + keyword match combined'),
        types: z
          .array(z.enum(FIND_TYPES))
          .optional()
          .describe(
            'Defaults to claim + capture + document. attachment / contact / email are opt-in (they route through separate indexes): add attachment when the question is about what a file or image contains.',
          ),
        since: z
          .string()
          .optional()
          .describe(
            'Lower-bound time filter — preset (today, yesterday, this_week, last_week, this_month, last_month, past_7_days, past_30_days, past_90_days, this_year, ...) or ISO date. Replaces any default window, and filters claims too. Filters by the item\'s real-world event time (claim: source event; capture: started_at; document: when its text last changed; attachment: created_at; email: message date). Does NOT apply to contacts (they are not temporal).',
          ),
        until: z
          .string()
          .optional()
          .describe('Upper-bound time filter — same presets or ISO date. Given alone, there is no lower bound (everything before it).'),
        all_time: z
          .boolean()
          .optional()
          .default(false)
          .describe('Search all history (captures, attachments, emails; claims and documents always are) instead of a default recent window. Use when the first pass is thin or the question reaches further back.'),
        limit: z
          .number()
          .optional()
          .default(15)
          .describe(
            `Max results in the fused list (default 15). Contact hits are capped at ${MAX_CONTACT_SEARCH_LIMIT} per workspace; a larger limit is clamped for contacts.`,
          ),
        recency_weight: z
          .number()
          .optional()
          .describe(
            'How strongly to boost fresher results (default 0.5). Raise toward 1-2 for "recent"/"latest" phrasing; auto-raised to 1.0 when your since narrows the window to <= 45 days (a default window does not raise it).',
          ),
        cross_workspace: z
          .boolean()
          .optional()
          .default(false)
          .describe('Search every workspace the user belongs to. Each result includes workspace_id and workspace_name.'),
        claim_status: z
          .enum(['active', 'superseded', 'disputed', 'archived'])
          .optional()
          .default('active')
          .describe('Which claim lifecycle status to include (default active — hides superseded/corrected facts).'),
      }),
      execute: async ({ query, types, since, until, all_time, limit, recency_weight, cross_workspace: crossArg, claim_status }) => {
        const cross_workspace = crossArg && !strictWorkspace
        const requestedTypes = types ?? ['claim', 'capture', 'document']
        const hybridTypes = requestedTypes.filter((t): t is (typeof HYBRID_TYPES)[number] =>
          (HYBRID_TYPES as readonly string[]).includes(t),
        )
        const wantsAttachments = requestedTypes.includes('attachment')
        const wantsContacts = requestedTypes.includes('contact')
        const wantsEmail = requestedTypes.includes('email')

        const cap = limit ?? 15
        // The agent's window, or the past 4 weeks when it named none.
        const searchWindow = resolveSearchWindow({
          sinceISO: resolveSince(since),
          untilISO: resolveUntil(until),
          allTime: all_time,
          defaultWindow: searchDefaultWindow,
        })
        const sinceISO = searchWindow.since
        const untilISO = searchWindow.until
        // Only a window the agent CHOSE auto-raises recency: the default 4-week
        // window already keeps results fresh, so boosting on top of it would
        // count recency twice.
        const wRecent = resolveRecencyWeight(recency_weight, searchWindow.window === 'range' ? sinceISO : null)

        // Resolve the active workspace's name ONCE per call (not per row) so
        // in-workspace results carry a real workspace_name — previously they
        // came back with '' (only cross_workspace populated it), leaving agents
        // doing multi-workspace reasoning unable to tell where a hit lives. The
        // attachment/email/contact runners (active-workspace-scoped) reuse this
        // same resolved value instead of hardcoding ''.
        const activeWorkspaceName = await resolveActiveWorkspaceName(supabase, workspaceId)
        const targetWorkspaces = cross_workspace
          ? await getUserWorkspaces(supabase, userId)
          : [{ id: workspaceId, name: activeWorkspaceName }]

        // Embed the query ONCE for the OpenAI-space hybrid RPC (only when a
        // hybrid type is requested). Gemini embedding is computed separately and
        // only when attachments are requested — a second billable call we avoid
        // unless needed.
        let openaiEmbeddingPromise: Promise<number[]> | null = null
        const openAiEmbedding = () => {
          if (!openaiEmbeddingPromise) openaiEmbeddingPromise = embed(query, userId)
          return openaiEmbeddingPromise
        }

        // Claims (the workspace's durable facts) and documents (found wherever
        // they match, documents phase 1) are never reached by a DEFAULT window:
        // only the agent's own since/until filters them (documents by when
        // their text last changed). Under the default window they go in their
        // own unbounded hybrid_search call; captures keep the window.
        const UNWINDOWED = ['claim', 'document']
        const wantsClaims = hybridTypes.includes('claim')
        const durable = hybridTypes.filter((t) => UNWINDOWED.includes(t))
        const rest = hybridTypes.filter((t) => !UNWINDOWED.includes(t))
        const durableApart = searchWindow.window === 'past_4_weeks' && durable.length > 0
        const hybridCalls: Array<{ types: string[]; since: string | null; until: string | null }> = durableApart
          ? [
              { types: durable, since: null, until: null },
              ...(rest.length > 0 ? [{ types: rest, since: sinceISO, until: untilISO }] : []),
            ]
          : [{ types: [...hybridTypes], since: sinceISO, until: untilISO }]
        const claimsWindowed = wantsClaims && !durableApart && Boolean(sinceISO || untilISO)
        const documentsWindowed = hybridTypes.includes('document') && !durableApart && Boolean(sinceISO || untilISO)

        // ── Hybrid search (claim/capture/document), fanned + re-fused by score ──
        const hybridRunner = (async () => {
          if (hybridTypes.length === 0) return { results: [] as HybridRow[], error: undefined as string | undefined }
          try {
            const embedding = await openAiEmbedding()
            const embeddingStr = `[${embedding.join(',')}]`
            const perWorkspace = await Promise.all(
              targetWorkspaces.flatMap((w) => hybridCalls.map(async (call) => {
                const { data, error } = await supabase.rpc('hybrid_search', {
                  p_workspace_id: w.id,
                  p_query: query,
                  p_embedding: embeddingStr,
                  p_types: call.types,
                  p_since: call.since,
                  p_until: call.until,
                  p_limit: cap,
                  p_w_recent: wRecent,
                  p_claim_status: claim_status ?? 'active',
                  p_requesting_user_id: requestingUserId,
                })
                if (error) return { rows: [] as HybridRow[], error: error.message }
                const shown = await dropMailFromResults(supabase, (data as HybridRow[]) || [])
                if (!shown) return { rows: [] as HybridRow[], error: 'Could not read claims' }
                const rows = shown.map((r) => ({
                  ...r,
                  workspace_id: w.id,
                  workspace_name: w.name,
                }))
                return { rows, error: undefined as string | undefined }
              })),
            )
            const errors = perWorkspace.map((p) => p.error).filter((e): e is string => Boolean(e))
            // Per-workspace (and, under a default window, per claims/rest call)
            // results are each already RRF-fused with comparable
            // scores — merge by score and trim.
            const fused = fuseWorkspaces<HybridRow>(perWorkspace.map((p) => p.rows), cap)
            return { results: fused, error: errors[0] }
          } catch (err) {
            return { results: [] as HybridRow[], error: sanitizeProviderError(err, 'Search temporarily unavailable') }
          }
        })()

        // ── Attachments: separate Gemini-space RPC, fused with the hybrid stream
        //    at the APP layer by RANK (scores across embedding spaces aren't
        //    comparable). Workspace-scoped only (mirrors deep_search). ──
        const attachmentRunner = (async () => {
          if (!wantsAttachments) return { results: [] as HybridRow[], error: undefined as string | undefined }
          try {
            const geminiEmbedding = await embedQuery(query, userId)
            const { data, error } = await supabase.rpc('hybrid_search_attachments', {
              p_workspace_id: workspaceId,
              p_embedding: `[${geminiEmbedding.join(',')}]`,
              p_since: sinceISO,
              p_until: untilISO,
              p_limit: cap,
              p_w_recent: wRecent,
              p_requesting_user_id: requestingUserId,
            })
            if (error) return { results: [] as HybridRow[], error: error.message }
            const rows = ((data as HybridRow[]) || []).map((r) => ({
              ...r,
              // A file's text is whoever wrote the file's (A5): marked as data.
              excerpt: wrapUntrusted(r.excerpt, 'FILE'),
              workspace_id: workspaceId,
              workspace_name: activeWorkspaceName,
            }))
            // Mint signed URLs for the storage paths (same posture as deep_search).
            const paths = [
              ...new Set(
                rows
                  .map((r) => (r.metadata as { storage_path?: string } | null)?.storage_path)
                  .filter((p): p is string => Boolean(p)),
              ),
            ]
            const urlEntries = await Promise.all(
              paths.map(async (path) => {
                const { data: urlData } = await supabase.storage.from('attachments').createSignedUrl(path, 3600)
                return [path, urlData?.signedUrl ?? null] as const
              }),
            )
            const urlMap = Object.fromEntries(urlEntries)
            for (const r of rows) {
              const sp = (r.metadata as { storage_path?: string } | null)?.storage_path
              if (sp && r.metadata) (r.metadata as Record<string, unknown>).signed_url = urlMap[sp] ?? null
            }
            return { results: rows, error: undefined as string | undefined }
          } catch (err) {
            return { results: [] as HybridRow[], error: sanitizeProviderError(err, 'Attachment search temporarily unavailable') }
          }
        })()

        // ── Contacts: keyword-only, no embeddings — appended as extra rows. ──
        const contactRunner = (async () => {
          if (!wantsContacts) return { results: [] as HybridRow[], error: undefined as string | undefined }
          const perWorkspace = await Promise.all(
            targetWorkspaces.map((w) => searchContactsInWorkspace(supabase, userId, w, query, cap)),
          )
          const errors = perWorkspace.map((p) => p.error).filter((e): e is string => Boolean(e))
          const rows: HybridRow[] = perWorkspace
            .flatMap((p) => p.results)
            .map((c) => ({
              result_type: 'contact',
              result_id: c.result_id,
              title: c.title,
              score: null,
              event_at: (c.metadata as { last_interaction_at?: string } | undefined)?.last_interaction_at ?? null,
              fts_rank: null,
              vec_rank: null,
              recency_rank: null,
              excerpt: c.subtitle ?? null,
              source_label: 'Contact',
              source_type: 'contact',
              metadata: c.metadata ?? null,
              workspace_id: c.workspace_id,
              workspace_name: c.workspace_name,
            }))
          return { results: rows.slice(0, clampContactLimit(cap)), error: errors[0] }
        })()

        // ── Emails: FTS-only via the existing email search service. Thread the
        //    resolved window through as after/before (message_date) so `find`'s
        //    since/until actually constrains emails — mirrors the sibling
        //    `search` tool, where they were previously silently ignored here. ──
        const emailRunner = (async () => {
          if (!wantsEmail) return { results: [] as HybridRow[], error: undefined as string | undefined }
          try {
            const { results } = await dualSearchEmails(userId, workspaceId, {
              query: query || '',
              after: sinceISO ?? undefined,
              before: untilISO ?? undefined,
              limit: cap,
            })
            const rows: HybridRow[] = results.map((r) => ({
              result_type: 'email',
              result_id: r.threadId,
              // A sender wrote the subject and snippet (A5): marked as data.
              title: wrapUntrusted(r.subject) ?? '',
              score: null,
              event_at: r.date ?? null,
              fts_rank: null,
              vec_rank: null,
              recency_rank: null,
              excerpt: wrapUntrusted(r.snippet),
              source_label: r.from.name ? `Email from ${r.from.name}` : `Email from ${r.from.email}`,
              source_type: 'email',
              metadata: { date: r.date, from: r.from, is_unread: r.isUnread },
              workspace_id: workspaceId,
              workspace_name: activeWorkspaceName,
            }))
            return { results: rows, error: undefined as string | undefined }
          } catch (err) {
            return { results: [] as HybridRow[], error: sanitizeProviderError(err, 'Email search temporarily unavailable') }
          }
        })()

        const [hybridResult, attachmentResult, contactResult, emailResult] = await Promise.all([
          hybridRunner,
          attachmentRunner,
          contactRunner,
          emailRunner,
        ])

        // Fuse the hybrid stream (comparable scores) with the attachment stream
        // (Gemini space) by RANK, then append the keyword-only contact/email rows
        // (no ranking basis — they trail as supplementary hits).
        let results: HybridRow[]
        if (attachmentResult.results.length > 0) {
          results = fuseByRank<HybridRow>([hybridResult.results, attachmentResult.results], cap)
        } else {
          results = hybridResult.results
        }
        // The person's Now file reaches only their own main chat (migration 440).
        const all: HybridRow[] = [...results, ...contactResult.results, ...emailResult.results]
        const combined: HybridRow[] = nowReadable ? all : await dropNowDocuments(supabase, all)

        // Batch-resolve ANCHOR names onto the fused list. One entity_link query
        // plus one label query per anchor type present — bounded by anchor types,
        // never by result count, so still no N+1. Fixes the "Rios under
        // KokoLink vs ORCA under Atlas" conflation: a claim whose top
        // provenance is a bare anchor now labels it by name, and every
        // capture/document/claim gets `anchor_name` (+ `project_name` when that
        // anchor is a project) so multi-anchor reasoning can tell hits apart.
        await enrichWithAnchorNames(supabase, combined, requestingUserId)

        // What this search covered. Capture hits are MATCHED on their transcript
        // too, but no transcript passage comes back (the excerpt is the summary),
        // so `transcripts` is false here: deep_search returns passages.
        const scope: SearchScope = {
          window: searchWindow.window,
          since: sinceISO,
          until: untilISO,
          claims_windowed: claimsWindowed,
          documents_windowed: documentsWindowed,
          transcripts: false,
          attachments: wantsAttachments,
        }

        return {
          success: true,
          results: combined,
          count: combined.length,
          query,
          scope,
          searched: {
            types: requestedTypes,
            since: sinceISO,
            until: untilISO,
            recency_weight: wRecent,
            cross_workspace: !!cross_workspace,
            workspace_count: targetWorkspaces.length,
          },
          ...(hybridResult.error ? { hybrid_error: hybridResult.error } : {}),
          ...(attachmentResult.error ? { attachments_error: attachmentResult.error } : {}),
          ...(contactResult.error ? { contacts_error: contactResult.error } : {}),
          ...(wantsContacts ? contactClampNote(cap) : {}),
          ...(emailResult.error ? { email_error: emailResult.error } : {}),
        }
      },
    }),

    search: tool({
      description:
        'Deprecated: prefer `find` for ranked retrieval across claims/captures/documents. ' +
        'Search across the workspace (or all workspaces with cross_workspace=true) by keyword — actions, captures, documents, projects, decisions, claims, contacts, and emails — in one call. ' +
        'Use `types` to narrow scope. Use `since` (today/yesterday/this_week/this_month/this_year or ISO date) and `until` to filter captures by time. ' +
        'Set `cross_workspace=true` to search every workspace the user belongs to (results are tagged with workspace_id and workspace_name). ' +
        'Email-specific filters (from, to, after, before, folder, has_attachment) are available when types includes "email". ' +
        'For deeper semantic recall over the knowledge graph, also consider search_claims (vector similarity).',
      inputSchema: z.object({
        query: z.string().describe('Search query — keywords, names, topics'),
        types: z
          .array(z.string())
          .optional()
          .describe(
            'Entity types to search: action, capture, document, project, decision, claim, contact, email. Defaults to all except email.',
          ),
        limit: z
          .number()
          .optional()
          .default(20)
          .describe(
            `Max results per workspace (default 20). Contact hits are capped at ${MAX_CONTACT_SEARCH_LIMIT}; a larger limit is clamped for contacts.`,
          ),
        cross_workspace: z
          .boolean()
          .optional()
          .default(false)
          .describe('Search every workspace the user belongs to. Each result includes workspace_id and workspace_name.'),
        since: z
          .string()
          .optional()
          .describe(
            'Time filter for captures. Preset (today, yesterday, this_week, this_month, this_year) or ISO date.',
          ),
        until: z
          .string()
          .optional()
          .describe('Upper-bound time filter for captures (ISO date). Optional.'),
        // Email-specific filters (only used when types includes "email")
        enrich_emails: z
          .boolean()
          .optional()
          .default(false)
          .describe('When true, email results include CRM contact info, recent meetings, and open actions'),
        from: z.string().optional().describe('Email filter: sender email address'),
        to: z.string().optional().describe('Email filter: recipient email address'),
        after: z.string().optional().describe('Email filter: only emails after this date (ISO format, e.g. "2025-01-01")'),
        before: z.string().optional().describe('Email filter: only emails before this date'),
        has_attachment: z.boolean().optional().describe('Email filter: only emails with attachments'),
        folder: z.string().optional().describe('Email filter: inbox, sent, drafts, starred, archive'),
        // Contact-specific filters
        relationship_type: z.string().optional().describe('CRM contact filter: contact, lead, customer, partner, vendor'),
      }),
      execute: async ({
        query,
        types,
        limit,
        cross_workspace: crossArg,
        since,
        until,
        enrich_emails,
        from,
        to,
        after,
        before,
        has_attachment,
        folder,
        relationship_type,
      }) => {
        const cross_workspace = crossArg && !strictWorkspace
        const requestedTypes = types || ['action', 'capture', 'document', 'project', 'decision', 'claim', 'contact']

        const wantsEmail = requestedTypes.includes('email')
        const unifiedTypes = requestedTypes.filter((t) => t !== 'email' && t !== 'contact')
        const wantsContacts = requestedTypes.includes('contact')

        const sinceISO = resolveSince(since)
        const untilISO = resolveUntil(until)

        // Resolve workspace scope
        const targetWorkspaces = cross_workspace
          ? await getUserWorkspaces(supabase, userId)
          : [{ id: workspaceId, name: '' }]

        // 1. Unified search across workspaces
        const unifiedRunner = (async () => {
          if (unifiedTypes.length === 0) {
            return { results: [] as Array<UnifiedResultRow & { workspace_id: string; workspace_name: string }>, errors: [] as string[] }
          }
          const rpcTypes = unifiedTypes // unified_search supports: action, capture, document, project, decision
          const perWorkspace = await Promise.all(
            targetWorkspaces.map((w) =>
              runUnifiedSearch(supabase, w, query, rpcTypes, limit ?? 20, requestingUserId),
            ),
          )
          let merged = perWorkspace.flatMap((r) => r.results)
          merged = filterCapturesByTime(merged, sinceISO, untilISO)
          // Sort by rank desc, then trim to overall limit when cross-workspace
          merged.sort((a, b) => (b.rank || 0) - (a.rank || 0))
          if (cross_workspace) merged = merged.slice(0, limit ?? 20)
          const errors = perWorkspace.map((r) => r.error).filter((e): e is string => Boolean(e))
          return { results: merged, errors }
        })()

        // 2. Contact search (separate code path because unified_search doesn't currently include contacts)
        const contactRunner = (async () => {
          if (!wantsContacts) {
            return { results: [] as Array<UnifiedResultRow & { workspace_id: string; workspace_name: string }>, errors: [] as string[] }
          }
          const perWorkspace = await Promise.all(
            targetWorkspaces.map((w) =>
              searchContactsInWorkspace(supabase, userId, w, query, limit ?? 20, relationship_type),
            ),
          )
          const merged = perWorkspace.flatMap((r) => r.results)
          const errors = perWorkspace.map((r) => r.error).filter((e): e is string => Boolean(e))
          return { results: cross_workspace ? merged.slice(0, clampContactLimit(limit ?? 20)) : merged, errors }
        })()

        // 3. Email search (workspace-scoped only — no cross-workspace until email service supports it)
        const emailRunner = (async () => {
          if (!wantsEmail) {
            return { results: [] as Array<{ result_type: string; result_id: string; title: string; subtitle?: string | null; metadata?: Record<string, unknown> }>, error: undefined as string | undefined }
          }
          try {
            if (enrich_emails) {
              const results = await searchEmailsWithContext(userId, workspaceId, query, limit ?? 20)
              return {
                results: results.map((r) => ({
                  result_type: 'email',
                  result_id: r.threadId,
                  // A sender wrote the subject and snippet (A5): marked as data.
                  title: wrapUntrusted(r.subject) ?? '',
                  subtitle: r.from.name ? `${r.from.name} (${r.from.email})` : r.from.email,
                  metadata: {
                    date: r.date,
                    snippet: wrapUntrusted(r.snippet),
                    contact: r.contact
                      ? { name: r.contact.fullName, company: r.contact.companyName, relationship: r.contact.relationshipType }
                      : null,
                    recent_meetings: r.relatedCaptures?.map((c) => ({ title: c.title, date: c.date })) || [],
                    open_actions: r.relatedActions?.map((a) => ({ title: a.title, status: a.status, due: a.dueDate })) || [],
                  },
                })),
                error: undefined,
              }
            }
            const { results, source } = await dualSearchEmails(userId, workspaceId, {
              query: query || '',
              folder,
              from,
              to,
              after,
              before,
              hasAttachment: has_attachment,
              limit: limit ?? 20,
            })
            return {
              search_source: source,
              results: results.map((r) => ({
                result_type: 'email',
                result_id: r.threadId,
                title: wrapUntrusted(r.subject) ?? '',
                subtitle: r.from.name ? `${r.from.name} (${r.from.email})` : r.from.email,
                metadata: { date: r.date, snippet: wrapUntrusted(r.snippet), is_unread: r.isUnread },
              })),
              error: undefined,
            }
          } catch (err) {
            return {
              results: [],
              error: sanitizeProviderError(err, 'Email search temporarily unavailable'),
            }
          }
        })()

        const [unifiedResult, contactResult, emailResult] = await Promise.all([unifiedRunner, contactRunner, emailRunner])

        // The person's Now file reaches only their own main chat (migration 440).
        const found = [...unifiedResult.results, ...contactResult.results, ...emailResult.results]
        const allResults = nowReadable ? found : await dropNowDocuments(supabase, found)

        return {
          success: true,
          results: allResults,
          count: allResults.length,
          query,
          searched: {
            cross_workspace: !!cross_workspace,
            workspace_count: targetWorkspaces.length,
            since: sinceISO,
            until: untilISO,
          },
          sources: {
            unified: unifiedResult.results.length,
            contacts: contactResult.results.length,
            email: emailResult.results.length,
          },
          ...(unifiedResult.errors.length ? { unified_error: unifiedResult.errors[0] } : {}),
          ...(contactResult.errors.length ? { contacts_error: contactResult.errors[0] } : {}),
          ...(wantsContacts ? contactClampNote(limit ?? 20) : {}),
          ...(emailResult.error ? { email_error: emailResult.error } : {}),
        }
      },
    }),

    deep_search: tool({
      description:
        'Deprecated: prefer `find`, which fuses keyword + semantic + recency in ONE ranked list with inline provenance. ' +
        'AI-powered semantic search across captures, file attachments, AND the knowledge graph (claims) using vector similarity. ' +
        'Finds information by meaning — use when you don\'t know the exact words (e.g. "discussions about pricing strategy", "what do we know about Acme?"). ' +
        'Claims are the distilled, durable facts/decisions of the workspace — include them (default) for "what does the workspace know about X" questions. ' +
        'Set cross_workspace=true to search every workspace the user belongs to. ' +
        (defaultsToRecent
          ? 'Scope: with no `since`/`all_time` it searches captures from the PAST 4 WEEKS (summaries only), plus attachments; set `all_time: true` for all history. ' +
            'Set `include_transcripts: true` for what was SAID in a meeting (transcript passages). '
          : 'Scope: with no `since` it searches captures from all history, transcript passages included, plus attachments. ') +
        'Narrow `types` to leave attachments out. Claims are filtered only by an explicit since/until; ' +
        'attachments have no time filter. The result\'s `scope` says what was searched. ' +
        'For keyword lookups, use the `search` tool instead.',
      inputSchema: z.object({
        query: z.string().describe('Natural language search query'),
        types: z
          .array(z.enum(['captures', 'attachments', 'claims']))
          .optional()
          .describe('What to search: captures, attachments, claims, or any combination. Defaults to all three.'),
        project_ids: z.array(z.string()).optional().describe('Limit search to specific project UUIDs'),
        capture_ids: z.array(z.string()).optional().describe('Limit search to specific capture UUIDs (captures only)'),
        limit: z.number().optional().default(10).describe('Max results (default 10)'),
        threshold: z.number().optional().default(0.3).describe('Minimum similarity threshold (0-1)'),
        all_time: z
          .boolean()
          .optional()
          .default(false)
          .describe('Search captures from all history instead of a default recent window. Use when the first pass is thin or the question reaches further back.'),
        include_transcripts: z
          .boolean()
          .optional()
          .describe(
            defaultsToRecent
              ? 'Also search raw transcript passages (default: capture summaries only). Turn on when the question is about what someone said in a meeting.'
              : 'Search raw transcript passages as well as capture summaries (default: on). Set false for summaries only.',
          ),
        cross_workspace: z
          .boolean()
          .optional()
          .default(false)
          .describe('Search every workspace the user belongs to. Each result includes workspace_id and workspace_name.'),
        since: z
          .string()
          .optional()
          .describe(
            'Lower-bound created-after filter. Preset (today, yesterday, this_week, last_week, this_month, last_month, past_90_days, this_year, ...) or ISO date. Replaces any default window, and filters claims too.',
          ),
        until: z
          .string()
          .optional()
          .describe(
            'Upper-bound filter. Preset or ISO date. Applies to claims only (event time) — captures have no upper-bound filter here (rag_search only takes a lower bound).',
          ),
      }),
      execute: async ({ query, types, project_ids, capture_ids, limit, threshold, all_time, include_transcripts, cross_workspace: crossArg, since, until }, { abortSignal }) => {
        const cross_workspace = crossArg && !strictWorkspace
        // Default includes claims so the agent's primary semantic path covers
        // the knowledge graph, and attachments, as the picker's default did.
        const requestedTypes = types || ['captures', 'attachments', 'claims']

        const wantsCaptures = requestedTypes.includes('captures')
        const wantsAttachments = requestedTypes.includes('attachments')
        const wantsClaims = requestedTypes.includes('claims')
        // Transcript passages: the main chat's first pass is summaries only (the
        // picker's default there); every other surface reads them, as it always
        // did, since its prompt doesn't steer it to opt in.
        const includeTranscripts = include_transcripts ?? !defaultsToRecent

        // The captures window: the agent's `since`, all history, or the past 4
        // weeks. rag_search takes a lower bound only, so `until` reaches claims
        // alone.
        const searchWindow = resolveSearchWindow({
          sinceISO: resolveSince(since),
          untilISO: resolveUntil(until),
          allTime: all_time,
          defaultWindow: searchDefaultWindow,
        })
        const createdAfter = searchWindow.since
        // Claims (durable facts) take only the agent's explicit since/until,
        // never a default window.
        const claimEventAfter = resolveSince(since)
        const claimEventBefore = resolveUntil(until)

        const targetWorkspaces = cross_workspace
          ? await getUserWorkspaces(supabase, userId)
          : [{ id: workspaceId, name: '' }]

        // Captures and claims both search the same OpenAI embedding space, so
        // embed the query ONCE and share it (was embedded twice — one billable
        // call per runner). Computed lazily, only when one of them is wanted.
        let openaiEmbeddingPromise: Promise<number[]> | null = null
        const sharedOpenAiEmbedding = () => {
          if (!openaiEmbeddingPromise) openaiEmbeddingPromise = embed(query, userId)
          return openaiEmbeddingPromise
        }

        // 1. Semantic search captures via OpenAI embeddings + rag_search RPC, fanned across workspaces
        const captureRunner = (async () => {
          if (!wantsCaptures) return { source: 'captures', results: [] as Array<Record<string, unknown>>, errors: [] as string[] }
          try {
            const queryEmbedding = await sharedOpenAiEmbedding()

            const perWorkspace = await Promise.all(
              targetWorkspaces.map(async (w) => {
                const { data, error } = await supabase.rpc('rag_search', {
                  p_user_id: userId,
                  p_project_ids: project_ids || [],
                  p_note_ids: capture_ids || [],
                  p_embedding: JSON.stringify(queryEmbedding),
                  p_limit: limit ?? 10,
                  p_threshold: threshold,
                  p_workspace_id: w.id,
                  p_created_after: createdAfter,
                  p_include_transcripts: includeTranscripts,
                })
                if (error) return { workspace: w, results: [], error: error.message }
                let rows = (data as Array<{
                  capture_id: string
                  chunk_text: string
                  similarity: number
                  capture_title?: string
                  project_id?: string
                }>) || []
                if (omitPrivateCaptures) {
                  // rag_search is keyed on the chunk's user_id (= the capture
                  // owner), so an unattended run as the creator would otherwise
                  // get their own private transcript chunks back.
                  const visible = await workspaceVisibleCaptureIds(
                    supabase,
                    w.id,
                    [...new Set(rows.map((r) => r.capture_id))],
                  )
                  rows = rows.filter((r) => visible.has(r.capture_id))
                }
                const results = rows.map((chunk) => ({
                  capture_id: chunk.capture_id,
                  chunk_text: chunk.chunk_text,
                  similarity: Math.round(chunk.similarity * 100) / 100,
                  capture_title: chunk.capture_title,
                  project_id: chunk.project_id,
                  workspace_id: w.id,
                  workspace_name: w.name,
                }))
                return { workspace: w, results, error: undefined as string | undefined }
              }),
            )
            const merged = perWorkspace.flatMap((p) => p.results)
            merged.sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
            const errors = perWorkspace.map((p) => p.error).filter((e): e is string => Boolean(e))
            return {
              source: 'captures',
              results: cross_workspace ? merged.slice(0, limit ?? 10) : merged,
              errors,
              meta: { createdAfter },
            }
          } catch (err) {
            return {
              source: 'captures',
              results: [] as Array<Record<string, unknown>>,
              errors: [sanitizeProviderError(err, 'Semantic capture search temporarily unavailable')],
            }
          }
        })()

        // 2. Semantic search attachments via Gemini embeddings + attachment_rag_search RPC
        const attachmentRunner = (async () => {
          if (!wantsAttachments) return { source: 'attachments', results: [] as Array<Record<string, unknown>>, errors: [] as string[] }
          try {
            const queryEmbedding = await embedQuery(query, userId)
            const perWorkspace = await Promise.all(
              targetWorkspaces.map(async (w) => {
                const { data, error } = await supabase.rpc('attachment_rag_search', {
                  p_user_id: userId,
                  p_embedding: JSON.stringify(queryEmbedding),
                  p_workspace_id: w.id,
                  p_project_ids: project_ids || [],
                  p_limit: limit ?? 10,
                  p_threshold: threshold,
                })
                if (error) return { workspace: w, rows: [], error: error.message }
                let rows = (data as Array<Record<string, unknown>>) || []
                if (omitPrivateCaptures) {
                  // Same caller-keyed gap as rag_search: an attachment inherits
                  // its parent capture's visibility, so drop chunks whose parent
                  // capture is private. Parentless attachments are unaffected.
                  const parentIds = [
                    ...new Set(
                      rows
                        .map((r) => r.parent_capture_id as string | null)
                        .filter((id): id is string => Boolean(id)),
                    ),
                  ]
                  const visible = await workspaceVisibleCaptureIds(supabase, w.id, parentIds)
                  rows = rows.filter((r) => {
                    const parent = r.parent_capture_id as string | null
                    return !parent || visible.has(parent)
                  })
                }
                return { workspace: w, rows, error: undefined as string | undefined }
              }),
            )

            type AttachmentRow = {
              attachment_id: string
              file_name: string
              file_category: string
              mime_type: string
              chunk_text: string | null
              chunk_type: string
              page_number: number | null
              similarity: number
              storage_path: string
              parent_capture_id: string | null
              parent_action_id: string | null
              project_id: string | null
            }

            const allRows: Array<AttachmentRow & { _ws: { id: string; name: string } }> =
              perWorkspace.flatMap((p) =>
                (p.rows as unknown as AttachmentRow[]).map((r) => ({ ...r, _ws: p.workspace })),
              )

            if (allRows.length === 0) {
              return { source: 'attachments', results: [], errors: perWorkspace.map((p) => p.error).filter((e): e is string => Boolean(e)) }
            }

            const uniquePaths = [...new Set(allRows.map((r) => r.storage_path))]
            const urlEntries = await Promise.all(
              uniquePaths.map(async (path) => {
                const { data: urlData } = await supabase.storage
                  .from('attachments')
                  .createSignedUrl(path, 3600)
                return [path, urlData?.signedUrl ?? null] as const
              }),
            )
            const urlMap = Object.fromEntries(urlEntries)

            const results = allRows.map((row) => {
              const ws = row._ws as { id: string; name: string }
              return {
                attachment_id: row.attachment_id,
                file_name: row.file_name,
                file_category: row.file_category,
                mime_type: row.mime_type,
                chunk_text: row.chunk_text,
                chunk_type: row.chunk_type,
                page_number: row.page_number,
                similarity: row.similarity,
                signed_url: urlMap[row.storage_path] || null,
                capture_id: row.parent_capture_id,
                action_id: row.parent_action_id,
                project_id: row.project_id,
                workspace_id: ws.id,
                workspace_name: ws.name,
              }
            })

            return {
              source: 'attachments',
              results: cross_workspace ? results.slice(0, limit ?? 10) : results,
              errors: perWorkspace.map((p) => p.error).filter((e): e is string => Boolean(e)),
            }
          } catch (err) {
            return {
              source: 'attachments',
              results: [] as Array<Record<string, unknown>>,
              errors: [sanitizeProviderError(err, 'Semantic attachment search temporarily unavailable')],
            }
          }
        })()

        // 3. Semantic search the knowledge graph (claims) via match_claims.
        const claimRunner = (async () => {
          if (!wantsClaims) return { source: 'claims', results: [] as Array<Record<string, unknown>>, errors: [] as string[] }
          try {
            const queryEmbedding = await sharedOpenAiEmbedding()
            const embeddingStr = `[${queryEmbedding.join(',')}]`
            // Resolve the temporal window against claim.event_at (source event
            // time). Previously `since` was accepted but silently ignored for
            // claims — the 10-arg overload (migration 181) wires it through so
            // "billing last week" no longer surfaces 8-month-old claims.
            const eventAfter = claimEventAfter
            const eventBefore = claimEventBefore
            const perWorkspace = await Promise.all(
              targetWorkspaces.map(async (w) => {
                // 10-arg overload (migration 181): 8-arg body + event_at range.
                // Active claims only; no confidence floor here (the agent can use
                // search_claims with min_confidence for high-confidence facts).
                const { data, error } = await supabase.rpc('match_claims', {
                  p_workspace_id: w.id,
                  p_embedding: embeddingStr,
                  p_limit: limit ?? 10,
                  p_threshold: threshold,
                  p_type: null,
                  p_confirmation: null,
                  p_status: 'active',
                  p_min_confidence: null,
                  p_event_after: eventAfter,
                  p_event_before: eventBefore,
                  p_requesting_user_id: requestingUserId,
                })
                if (error) return { workspace: w, results: [], error: error.message }
                const matched = (data as Array<{ claim_id: string }>) || []
                const hidden = matched.length > 0 ? await mailSourcedClaimIds(supabase, matched.map((m) => m.claim_id)) : new Set<string>()
                if (!hidden) return { workspace: w, results: [], error: 'Could not read claims' }
                const results = ((matched.filter((m) => !hidden.has(m.claim_id)) as Array<{
                  claim_id: string
                  claim_text: string
                  claim_type: string
                  confirmation: string
                  confidence: number | null
                  similarity: number
                }>) || []).map((m) => ({
                  claim_id: m.claim_id,
                  text: m.claim_text,
                  type: m.claim_type,
                  confirmation: m.confirmation,
                  confidence: m.confidence,
                  similarity: Math.round(m.similarity * 100) / 100,
                  workspace_id: w.id,
                  workspace_name: w.name,
                }))
                return { workspace: w, results, error: undefined as string | undefined }
              }),
            )
            const merged = perWorkspace.flatMap((p) => p.results)
            merged.sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
            const errors = perWorkspace.map((p) => p.error).filter((e): e is string => Boolean(e))
            return {
              source: 'claims',
              results: cross_workspace ? merged.slice(0, limit ?? 10) : merged,
              errors,
            }
          } catch (err) {
            return {
              source: 'claims',
              results: [] as Array<Record<string, unknown>>,
              errors: [sanitizeProviderError(err, 'Semantic claim search temporarily unavailable')],
            }
          }
        })()

        const [captureResult, attachmentResult, claimResult] = await Promise.all([
          captureRunner,
          attachmentRunner,
          claimRunner,
        ])

        // Filter complete semantic passages only, after permissions, deterministic
        // ranking and limits. Keyword search and hybrid entity previews stay intact.
        const groups = [captureResult.results, attachmentResult.results, claimResult.results]
        const passages: RetrievalPassage[] = []
        // Interleave the existing source rankings so captures do not consume the
        // entire bounded decision budget before claims/attachments are considered.
        for (let index = 0; index < Math.max(...groups.map(group => group.length)); index++) {
          groups.forEach((group, source) => {
            const row = group[index] as Record<string, unknown> | undefined
            if (!row) return
            const text = source === 2 ? row.text : row.chunk_text
            passages.push({
              id: `${source}:${index}`, workspaceId: String(row.workspace_id ?? ''),
              title: String(row.capture_title ?? row.file_name ?? ''),
              text: typeof text === 'string' ? text : '',
              complete: typeof text === 'string' && row.truncated !== true && row.complete !== false &&
                (source !== 1 || row.chunk_type === 'text'),
            })
          })
        }
        const relevance = await filterRetrievalPassages({
          userId, workspaceIds: targetWorkspaces.map(workspace => workspace.id), query, passages, signal: abortSignal,
        })
        const [keptCaptures, keptAttachments, claims] = groups.map((group, source) =>
          group.filter((_, index) => !relevance.irrelevantIds.has(`${source}:${index}`)))
        // The passages reach the model marked as data (A5): a meeting chunk is
        // what was said in it, an attachment chunk is the file's text. Wrapped
        // after the relevance filter, which reads the raw text.
        const captures = fenceChunks(keptCaptures, 'TRANSCRIPT')
        const attachments = fenceChunks(keptAttachments, 'FILE')

        // What this search covered: the captures window (claims take only an
        // explicit since/until), transcript passages, attachments.
        const scope: SearchScope = {
          window: searchWindow.window,
          since: createdAfter,
          until: searchWindow.until,
          claims_windowed: wantsClaims && Boolean(claimEventAfter || claimEventBefore),
          transcripts: wantsCaptures && includeTranscripts,
          attachments: wantsAttachments,
        }

        return {
          success: true,
          captures,
          attachments,
          claims,
          count: captures.length + attachments.length + claims.length,
          scope,
          searchMeta: {
            cross_workspace: !!cross_workspace,
            workspace_count: targetWorkspaces.length,
            createdAfter: (captureResult as { meta?: { createdAfter?: string | null } }).meta?.createdAfter ?? null,
            expandedSearch: searchWindow.window === 'all_time',
            typesSearched: requestedTypes,
            ...(relevance.irrelevantIds.size ? { irrelevantPassagesRemoved: relevance.irrelevantIds.size } : {}),
          },
          ...(captureResult.errors.length ? { captures_error: captureResult.errors[0] } : {}),
          ...(attachmentResult.errors.length ? { attachments_error: attachmentResult.errors[0] } : {}),
          ...(claimResult.errors.length ? { claims_error: claimResult.errors[0] } : {}),
        }
      },
    }),
  }
}
