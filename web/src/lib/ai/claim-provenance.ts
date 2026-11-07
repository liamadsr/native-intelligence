import type { SupabaseClient } from '@supabase/supabase-js'
import { CITABLE_SOURCE_TYPES } from '@/lib/knowledge/entity-registry'

/**
 * Claim provenance — the single place every claim writer records WHERE a claim
 * came from. Resolves GEN-105 / GEN-106 / GEN-108.
 *
 * Before this helper, provenance was written ad-hoc and inconsistently:
 *   - `claim_source` rows (evidence, carries an excerpt) and `entity_link`
 *     edges (the graph edge) were written by different code paths,
 *   - the extraction job only wrote the `cites` edge `if (data.sourceId)` and
 *     never the reconciling source row beyond that branch,
 *   - so `get_claim` surfaced two disjoint lists with nothing tying them.
 *
 * The model:
 *   - `claim_source` is the evidence store (excerpt-bearing). It is keyed by
 *     (claim_id, source_type, source_id, source_uri).
 *   - `entity_link` is the graph edge store. A `cites`/`about` edge from a
 *     claim to an internal entity is the *graph view* of the same provenance.
 *   - For any provenance that points at an INTERNAL entity (has a source_id /
 *     entity_id), we write BOTH: a `claim_source` row AND a matching
 *     `entity_link` edge. They cross-populate so verification logic has a
 *     single place to look and `get_claim` can reconcile them.
 *   - External (`source_uri`, no id) and `manual` provenance lives only in
 *     `claim_source` — there's no entity to point an edge at.
 *
 * Idempotent: safe to re-run (Inngest retries, re-ingestion, backfill). Uses
 * upsert with the existing unique constraints and ignoreDuplicates.
 */

// `CITABLE_SOURCE_TYPES` (the source types that correspond to a real, linkable
// graph entity) comes from the entity registry — see entity-registry.ts. Every
// member must also appear in `claim_source_source_type_check` (mig 264), or the
// upsert below fails the CHECK and provenance is silently dropped.

// `entity_link` target_type values are entity types, not source-type labels.
// They mostly coincide; external_url maps to a document anchor when used as a source.
function sourceTypeToEntityType(sourceType: string): string {
  if (sourceType === 'external_url') return 'document'
  return sourceType
}

export interface ProvenanceSource {
  source_type: string
  source_id?: string | null
  source_uri?: string | null
  excerpt?: string | null
  /** Edge relation for the graph view. Defaults to 'cites' (evidence). */
  relation?: string
  /**
   * The source's real-world event time (ISO). When set and EARLIER than the
   * claim's current event_at, the claim's event_at is pulled back to it
   * (LEAST semantics) — a corroborating source that predates the claim's known
   * event time makes the claim "came up" earlier. See mig 180.
   */
  eventAt?: string | null
}

export interface ProvenanceLink {
  entity_type: string
  entity_id: string
  relation?: string
}

/**
 * Attach provenance to a claim: write claim_source rows AND mirror them as
 * entity_link edges (and vice-versa for links). Best-effort per row; returns
 * counts. Never throws — provenance is additive.
 */
export async function attachClaimProvenance(
  supabase: SupabaseClient,
  args: {
    claimId: string
    workspaceId: string
    memberId: string | null
    sources?: ProvenanceSource[]
    links?: ProvenanceLink[]
  },
): Promise<{ sources: number; links: number; errors: string[] }> {
  const { claimId, workspaceId, memberId, sources = [], links = [] } = args
  const errors: string[] = []
  let sourceCount = 0
  let linkCount = 0

  // Collect edges to write, de-duped by (target_type, target_id, relation) so
  // a source and a link pointing at the same entity don't double-insert.
  const edgeKey = (t: string, id: string, r: string) => `${t}::${id}::${r}`
  const edges = new Map<string, { target_type: string; target_id: string; relation: string }>()

  // 1. Sources → claim_source (always) + mirrored entity_link (when internal).
  for (const s of sources) {
    // Skip only a source that anchors to NOTHING: no internal id, no external
    // uri, AND no excerpt. A `manual`/anchor-less source that still carries a
    // verbatim excerpt IS evidence (e.g. a pasted markdown file or uploaded
    // resource) and must persist — it just has no entity to mirror a graph edge
    // to. Without this, the skill's "attach a verbatim excerpt to every claim"
    // promise silently fails for pasted/uploaded resources.
    if (!s.source_id && !s.source_uri && !s.excerpt) continue
    const relation = s.relation ?? 'cites'

    const { error: srcErr } = await supabase.from('claim_source').upsert(
      {
        claim_id: claimId,
        workspace_id: workspaceId,
        source_type: s.source_type,
        source_id: s.source_id ?? null,
        source_uri: s.source_uri ?? null,
        excerpt: s.excerpt ?? null,
      },
      { onConflict: 'claim_id,source_type,source_id,source_uri', ignoreDuplicates: true },
    )
    if (srcErr) errors.push(`claim_source(${s.source_type}): ${srcErr.message}`)
    else sourceCount += 1

    // Mirror as a graph edge when this source is a real internal entity.
    if (s.source_id && CITABLE_SOURCE_TYPES.has(s.source_type)) {
      const target_type = sourceTypeToEntityType(s.source_type)
      edges.set(edgeKey(target_type, s.source_id, relation), {
        target_type,
        target_id: s.source_id,
        relation,
      })
    }
  }

  // 2. Links → entity_link (always) + mirrored claim_source (when cites/about
  //    on a citable entity, so the evidence list reflects the edge — GEN-108).
  for (const l of links) {
    if (l.entity_type === 'claim' && l.entity_id === claimId) continue // no self-link
    const relation = l.relation ?? 'about'
    edges.set(edgeKey(l.entity_type, l.entity_id, relation), {
      target_type: l.entity_type,
      target_id: l.entity_id,
      relation,
    })

    // Cross-populate: a cites/about edge to a citable entity is also evidence.
    if ((relation === 'cites' || relation === 'about') && CITABLE_SOURCE_TYPES.has(l.entity_type)) {
      const { error: srcErr } = await supabase.from('claim_source').upsert(
        {
          claim_id: claimId,
          workspace_id: workspaceId,
          source_type: l.entity_type,
          source_id: l.entity_id,
          source_uri: null,
          excerpt: null,
        },
        { onConflict: 'claim_id,source_type,source_id,source_uri', ignoreDuplicates: true },
      )
      if (srcErr) errors.push(`claim_source(link ${l.entity_type}): ${srcErr.message}`)
      else sourceCount += 1
    }
  }

  // 3. Write the de-duped edges. Upsert against the entity_link unique
  //    constraint (workspace, source, target, relation) so retries are safe.
  if (edges.size > 0) {
    const rows = [...edges.values()].map((e) => ({
      workspace_id: workspaceId,
      source_type: 'claim',
      source_id: claimId,
      target_type: e.target_type,
      target_id: e.target_id,
      relation: e.relation,
      created_by: memberId,
    }))
    const { error: linkErr } = await supabase
      .from('entity_link')
      .upsert(rows, {
        onConflict: 'workspace_id,source_type,source_id,target_type,target_id,relation',
        ignoreDuplicates: true,
      })
    if (linkErr) errors.push(`entity_link: ${linkErr.message}`)
    else linkCount += rows.length
  }

  // 4. Pull the claim's event_at back to the earliest source event time we just
  //    attached (LEAST semantics, mig 180). A source that predates the claim's
  //    known event time — e.g. an older email corroborating a fact first raised
  //    in a recent meeting — means the fact actually "came up" earlier. Only the
  //    MIN of the incoming sources' eventAt matters.
  //
  //    Done as ONE atomic conditional UPDATE (no prior SELECT). claim-extraction
  //    runs concurrent attaches, and a read-then-write races: two attaches can
  //    both read a null/late value and each overwrite the other, regressing
  //    event_at to a LATER time. The predicate `event_at IS NULL OR
  //    event_at > minIncoming` is re-evaluated by Postgres AFTER the row lock,
  //    so the earliest value always survives regardless of commit order (a
  //    concurrent write of an even-earlier value simply wins its own turn).
  //    Best-effort — errors accumulate, never throw; provenance is additive.
  const incomingEventAts = sources
    .map((s) => s.eventAt)
    .filter((e): e is string => !!e && !Number.isNaN(Date.parse(e)))
  if (incomingEventAts.length > 0) {
    // Compare by epoch millis, not raw string — event times come from
    // different columns (started_at / message_date / created_at) that may
    // serialize with different UTC offsets.
    const minIncoming = incomingEventAts.reduce((a, b) =>
      Date.parse(a) <= Date.parse(b) ? a : b,
    )
    const { error: updErr } = await supabase
      .from('claim')
      .update({ event_at: minIncoming })
      .eq('id', claimId)
      .or(`event_at.is.null,event_at.gt.${minIncoming}`)
    if (updErr) errors.push(`claim.event_at update: ${updErr.message}`)
  }

  return { sources: sourceCount, links: linkCount, errors }
}
