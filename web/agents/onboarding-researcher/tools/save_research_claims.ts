/**
 * save_research_claims — seed the workspace knowledge graph with 1-5 durable
 * claims (with provenance) so a brand-new workspace's world model starts
 * non-empty.
 *
 * Owner-derivation: workspace_id + created_by (member) come ONLY from the
 * verified session principal. The model supplies the claim TEXT and the source
 * URL/excerpt that backs it, never the tenant.
 *
 * Claims are marked `confirmation: 'suggested'` — the workspace convention for
 * "the system proposed this; the user hasn't confirmed it" (see create_claim in
 * src/lib/ai/tools/claims.ts, which defaults to 'suggested'). The research
 * agent's claims are inferences from public web sources, so they must land as
 * suggestions the user can confirm, never as confirmed fact.
 *
 * Provenance mirrors the app's model: each claim gets a `claim_source` row of
 * type `external_url` carrying the source URL + a verbatim excerpt, so the
 * claim is traceable to where it came from. We do NOT reimplement the full
 * bidirectional claim_source<->entity_link reconciliation (attachClaimProvenance
 * in the app): external_url sources have no internal entity to mirror a graph
 * edge to, so a plain claim_source row IS the complete provenance for them.
 *
 * KNOWN GAP (documented, intentional): we do NOT write a `claim_chunks`
 * embedding row here. Embeddings require the Next-coupled OpenAI/Gemini embed
 * path, which the eve runtime shouldn't pull in; claims still surface via the
 * `claim.fts` full-text column and graph traversal, and the Inngest weaver can
 * backfill embeddings. Semantic (vector) recall of these seed claims is
 * therefore deferred until an embedding backfill runs.
 */
import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { requireOwner, serviceClient, NoOwnerError } from '../lib/tool-context.js'
import { deriveClaimId } from '../lib/claim-id.js'

const CLAIM_TYPES = ['fact', 'open_question', 'inference', 'decision_summary'] as const

const claimSchema = z.object({
  text: z
    .string()
    .min(1)
    .describe('A single, atomic, source-supported statement.'),
  type: z
    .enum(CLAIM_TYPES)
    .default('inference')
    .describe(
      "Claim type. Web-research findings are usually 'inference' (derived from " +
      "a source) or 'fact' (directly stated by the source)."
    ),
  source_url: z
    .string()
    .describe('The URL of the source that supports this claim.'),
  excerpt: z
    .string()
    .optional()
    .describe('A short verbatim excerpt from the source that backs the claim.'),
})

export default defineTool({
  description:
    'Save 1-5 durable claims into the workspace knowledge graph, each backed by ' +
    'a source URL. Use this to record what you learned about the company or the ' +
    'person (what they do, industry, role, notable facts). Every claim MUST be ' +
    'supported by a source you actually fetched — never fabricate. Claims are ' +
    'saved as suggestions the user can confirm.',
  inputSchema: z.object({
    claims: z.array(claimSchema).min(1).max(5),
  }),
  async execute(input, ctx) {
    let owner
    try {
      owner = requireOwner(ctx)
    } catch (err) {
      if (err instanceof NoOwnerError) {
        return { success: false, error: err.message }
      }
      throw err
    }
    const { userId, workspaceId } = owner
    const supabase = serviceClient()

    // created_by references member.id — resolve the caller's member row.
    const { data: member } = await supabase
      .from('member')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .maybeSingle<{ id: string }>()
    const createdBy = member?.id ?? null

    // Stable replay anchors from the session — NOT ctx.callId, which the model
    // provider may re-mint when an interrupted step re-runs. session+turn+content
    // is byte-identical across a replay of the same tool call. See claim-id.ts.
    const sessionId = ctx.session.id
    const turnId = ctx.session.turn?.id ?? ''

    const saved: Array<{ id: string; text: string }> = []
    const errors: string[] = []

    // Deterministic id per claim → upsert on the primary key with
    // ignoreDuplicates, so a step replay after a crash resolves to the SAME
    // claim row instead of inserting a duplicate under a fresh random UUID. The
    // `claim` table has no other unique key to dedupe on (migration 109).
    //
    // Two claims in the SAME call with identical (type, text, source_url) hash
    // to the same id: the second upsert would silently no-op while the count
    // still claimed it saved. Collapse them up front (first occurrence wins) so
    // savedCount matches the rows that actually exist.
    const byId = new Map<string, z.infer<typeof claimSchema>>()
    for (const c of input.claims) {
      const claimId = deriveClaimId({
        sessionId,
        turnId,
        workspaceId,
        type: c.type,
        text: c.text,
        sourceUrl: c.source_url,
      })
      if (!byId.has(claimId)) byId.set(claimId, c)
    }
    const collapsedCount = input.claims.length - byId.size

    for (const [claimId, c] of byId) {
      const { error: claimErr } = await supabase.from('claim').upsert(
        {
          id: claimId,
          workspace_id: workspaceId,
          text: c.text,
          type: c.type,
          confirmation: 'suggested',
          created_by: createdBy,
        },
        { onConflict: 'id', ignoreDuplicates: true }
      )

      if (claimErr) {
        errors.push(`claim insert failed: ${claimErr.message}`)
        continue
      }

      // Provenance: an external_url source with the URL + excerpt. The CHECK on
      // claim_source requires source_id OR source_uri; external_url gives us
      // source_uri. ignoreDuplicates so a re-run doesn't error on the unique.
      // On replay this re-attaches to the SAME claimId, so no orphan provenance.
      const { error: srcErr } = await supabase.from('claim_source').upsert(
        {
          claim_id: claimId,
          source_type: 'external_url',
          source_uri: c.source_url,
          excerpt: c.excerpt ?? null,
        },
        {
          onConflict: 'claim_id,source_type,source_id,source_uri',
          ignoreDuplicates: true,
        }
      )
      if (srcErr) errors.push(`provenance for "${c.text.slice(0, 40)}…": ${srcErr.message}`)

      saved.push({ id: claimId, text: c.text })
    }

    if (saved.length === 0) {
      return { success: false, error: `no claims saved: ${errors.join('; ')}` }
    }
    return {
      success: true,
      savedCount: saved.length,
      claims: saved,
      ...(collapsedCount > 0 ? { duplicatesCollapsed: collapsedCount } : {}),
      ...(errors.length > 0 ? { warnings: errors } : {}),
      message:
        `Saved ${saved.length} claim${saved.length === 1 ? '' : 's'} to the knowledge graph.` +
        (collapsedCount > 0
          ? ` ${collapsedCount} duplicate claim${collapsedCount === 1 ? '' : 's'} with identical content collapsed into the saved one${saved.length === 1 ? '' : 's'}.`
          : ''),
    }
  },
})
