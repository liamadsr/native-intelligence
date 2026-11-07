import type { SupabaseClient } from '@supabase/supabase-js'
import { attachClaimProvenance, type ProvenanceLink } from '@/lib/ai/claim-provenance'

/**
 * Mirror a decision into the knowledge graph as a `decision_summary` claim.
 *
 * Decisions live in their own table for capture-specific UX (timestamps,
 * confirmation flow, capture-scoped queries). We also mirror confirmed
 * decisions into the claim layer so they show up in semantic search and
 * graph traversal across the whole workspace.
 *
 * Best-effort: never throw — the decision row is the source of truth, the
 * claim is an additive index. Callers can `void` the promise.
 */
export async function emitDecisionClaim(args: {
  supabase: SupabaseClient
  workspaceId: string
  memberId: string | null
  userId: string | undefined
  text: string
  captureId: string
  projectId?: string | null
  confirmation?: 'suggested' | 'confirmed'
}): Promise<void> {
  const {
    supabase,
    workspaceId,
    memberId,
    userId,
    text,
    captureId,
    projectId,
    confirmation = 'suggested',
  } = args

  try {
    // Resolve the capture once, up front: metadata gates demo captures, and
    // started_at/created_at supply the claim's real-world event time (mig 180;
    // record_commitment's loadCaptureDate is the same started_at→created_at
    // fallback). Best-effort: an unresolvable capture leaves event_at NULL
    // (honestly unknown-time) rather than stamping mirror time.
    const { data: captureRow } = await supabase
      .from('captures')
      .select('started_at, created_at, metadata')
      .eq('id', captureId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()

    // Demo gate: the onboarding tutorial's scripted decision must never enter
    // the real workspace graph. Every onboarding run creates a FRESH demo
    // capture, so the per-capture text dedupe below can't catch the repeat —
    // this was leaking one confirmed claim per tutorial completion. Same gate
    // as index-content and capture-ingest.
    if ((captureRow?.metadata as { demo?: unknown } | null)?.demo === true) return

    const eventAt: string | null = captureRow?.started_at ?? captureRow?.created_at ?? null

    // Dedupe guard: if this decision was already mirrored (e.g. create_decision
    // called twice, or an agent retry), don't create a second identical claim.
    // Match on workspace + type + text AND a cites edge to the same capture —
    // the capture scope avoids collapsing two genuinely different captures that
    // happen to share decision wording.
    const { data: existingClaims } = await supabase
      .from('claim')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('type', 'decision_summary')
      .eq('text', text)
    if (existingClaims && existingClaims.length > 0) {
      const { data: existingCite } = await supabase
        .from('entity_link')
        .select('source_id')
        .eq('workspace_id', workspaceId)
        .eq('source_type', 'claim')
        .eq('target_type', 'capture')
        .eq('target_id', captureId)
        .eq('relation', 'cites')
        .in(
          'source_id',
          existingClaims.map((c) => c.id),
        )
        .limit(1)
      if (existingCite && existingCite.length > 0) return // already mirrored
    }

    const { data: claim, error } = await supabase
      .from('claim')
      .insert({
        workspace_id: workspaceId,
        text,
        type: 'decision_summary',
        confirmation,
        created_by: memberId,
        event_at: eventAt,
      })
      .select('id')
      .single()
    if (error || !claim) return

    // Provenance via the shared helper: a `cites` capture source (claim_source)
    // + the mirrored `cites` capture edge, plus an `about` project edge when we
    // have one. claim_source and entity_link stay reconciled (GEN-108). eventAt
    // rides along so corroboration keeps LEAST semantics on event_at.
    const provenanceLinks: ProvenanceLink[] = projectId
      ? [{ entity_type: 'project', entity_id: projectId, relation: 'about' }]
      : []
    await attachClaimProvenance(supabase, {
      claimId: claim.id,
      workspaceId,
      memberId,
      sources: [{ source_type: 'capture', source_id: captureId, relation: 'cites', eventAt }],
      links: provenanceLinks,
    })

    // Lazy import: avoids loading the AI SDK + provider on hot paths that
    // never need it (e.g. a tenant without embeddings enabled).
    const { embed } = await import('@/lib/ai/embeddings')
    const embedding = await embed(text, userId)
    await supabase.from('claim_chunks').insert({
      claim_id: claim.id,
      workspace_id: workspaceId,
      chunk_index: 0,
      chunk_text: text,
      embedding: `[${embedding.join(',')}]`,
    })
  } catch {
    /* swallow — claim layer is additive */
  }
}
