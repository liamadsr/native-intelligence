import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * Supersede: create a new (confirmed) claim with the user's edited text,
 * mark the old one superseded, copy sources and links forward, and embed
 * the replacement. Same behavior as the `supersede_claim` AI tool.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId, member } = auth

  const { id } = await params
  const body = await request.json()
  const newText = typeof body.new_text === 'string' ? body.new_text.trim() : ''
  if (!newText) return badRequest('new_text required')

  const { data: oldClaim, error: readErr } = await supabase
    .from('claim')
    .select('id, type, confidence')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .single()
  // PGRST116 = no row (wrong id / other workspace / RLS) → 404, not 500.
  if (readErr) {
    if (readErr.code === 'PGRST116') return notFound('Claim not found')
    return serverError(readErr.message)
  }

  const { data: newClaim, error: insertErr } = await supabase
    .from('claim')
    .insert({
      workspace_id: workspaceId,
      text: newText,
      type: oldClaim.type,
      confidence: oldClaim.confidence,
      confirmation: 'confirmed',
      status: 'active',
      created_by: member.id,
    })
    .select('id')
    .single()
  if (insertErr) return serverError(insertErr.message)

  await supabase
    .from('claim')
    .update({ status: 'superseded', superseded_by: newClaim.id })
    .eq('id', id)
    .eq('workspace_id', workspaceId)

  // Carry forward the evidence (sources) so the replacement isn't unsupported.
  // Upsert (not plain insert) so a re-supersede can't trip the dedupe unique
  // key, matching the supersede_claim tool. Carry workspace_id forward too.
  const { data: sources } = await supabase
    .from('claim_source')
    .select('source_type, source_id, source_uri, excerpt')
    .eq('claim_id', id)
  if (sources && sources.length > 0) {
    await supabase.from('claim_source').upsert(
      sources.map((s) => ({
        ...s,
        claim_id: newClaim.id,
        workspace_id: workspaceId,
      })),
      {
        onConflict: 'claim_id,source_type,source_id,source_uri',
        ignoreDuplicates: true,
      },
    )
  }

  // supersedes edge.
  await supabase.from('entity_link').insert({
    workspace_id: workspaceId,
    source_type: 'claim',
    source_id: newClaim.id,
    target_type: 'claim',
    target_id: id,
    relation: 'supersedes',
    created_by: member.id,
  })

  // Embed the replacement text. Best-effort.
  try {
    const { embed } = await import('@/lib/ai/embeddings')
    const embedding = await embed(newText, user.id)
    await supabase.from('claim_chunks').insert({
      claim_id: newClaim.id,
      workspace_id: workspaceId,
      chunk_index: 0,
      chunk_text: newText,
      embedding: `[${embedding.join(',')}]`,
    })
  } catch {
    /* swallow */
  }

  return NextResponse.json({ new_claim_id: newClaim.id, superseded: id })
}
