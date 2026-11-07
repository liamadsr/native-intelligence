import { type NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { requireWorkspace, type WorkspaceAuthContext } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { l2Normalize } from '@/lib/voice-id-matching'
import { EMBEDDING_DIM, MAX_ENROLLMENT_CHUNKS, type VoiceProfileStatus } from '@/lib/voice-profile/types'
import { buildSelfPrototypes, meanChunkQuality, type UserVoiceProfileRow } from '@/lib/voice-profile/server'

/** Body caps for POST — one enrollment is a short 3-passage read. Chunk cap is
 *  the shared MAX_ENROLLMENT_CHUNKS so the flow and route never disagree. */
const MAX_CHUNKS = MAX_ENROLLMENT_CHUNKS
const MAX_SESSIONS = 6

type ProfileDbRow = {
  embedding: string | number[]
  quality: number | null
  session_id: string
  created_at: string | null
  source?: string | null
}

/**
 * GET /api/account/voice-profile
 *
 * Status shape { enrolled, quality, chunkCount, createdAt }. With
 * ?include=prototypes, also returns:
 *   - `prototypes: number[][]` — per-session unit-norm mean vectors built
 *     server-side with the same grouping as buildContactProfile (including the
 *     ≥3-session outlier filter).
 *   - `selfContactIds: string[]` — the caller's OWN CRM contact ids (a contact
 *     in the current workspace with member_id = the caller's member). Live
 *     self-verification excludes these from `bestContactSim`: a user who
 *     voice-enrolled themselves as a contact would otherwise match their own
 *     contact at high similarity, permanently failing the self-margin gate.
 */
export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const includePrototypes =
    new URL(request.url).searchParams.get('include') === 'prototypes'

  const columns = includePrototypes
    ? 'embedding, quality, session_id, created_at, source'
    : 'quality, session_id, created_at, source'

  const { data, error } = await supabase
    .from('user_voice_profile')
    .select(columns)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  if (error) return serverError(error.message)

  const rows = (data as unknown as ProfileDbRow[]) || []
  // The status describes the Settings enrollment. Rows learned from a voice the
  // user confirmed in a meeting (source 'session_confirm', followups issue 11)
  // store a similarity, not a chunk quality, and feed the prototypes only.
  const enrolledRows = rows.filter((r) => r.source !== 'session_confirm')

  const status: VoiceProfileStatus = {
    enrolled: enrolledRows.length > 0,
    quality: meanChunkQuality(enrolledRows),
    chunkCount: enrolledRows.length,
    // Rows are ordered newest-first; the profile is created all-at-once, so the
    // last row's created_at is the enrollment time.
    createdAt: enrolledRows.length > 0 ? (enrolledRows[enrolledRows.length - 1].created_at ?? null) : null,
  }

  if (!includePrototypes) return NextResponse.json(status)

  const prototypes = buildSelfPrototypes(rows as UserVoiceProfileRow[])

  // The caller's own CRM contact ids in this workspace (contacts linked to
  // their member row). Excluded from bestContactSim by the self-vote machine.
  const selfContactIds = await getSelfContactIds(supabase, user.id, workspaceId)

  return NextResponse.json({ ...status, prototypes, selfContactIds })
}

/**
 * The caller's OWN contact ids in a workspace — contacts whose member_id points
 * at the caller's member row. Best-effort: a query error yields an empty list
 * (self-verification degrades to including own-contact similarity, never throws).
 */
async function getSelfContactIds(
  supabase: WorkspaceAuthContext['supabase'],
  userId: string,
  workspaceId: string,
): Promise<string[]> {
  const { data: member } = await supabase
    .from('member')
    .select('id')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .maybeSingle<{ id: string }>()
  if (!member) return []

  const { data: contacts } = await supabase
    .from('contact')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('member_id', member.id)
  return (contacts as { id: string }[] | null)?.map((c) => c.id) ?? []
}

/**
 * POST /api/account/voice-profile
 *
 * Re-enroll (atomic replace) from the enrollment flow. Body:
 *   { chunks: [{ embedding: number[], quality: number, sessionId: string }],
 *     source: 'settings_training' }
 *
 * Validation: 1–MAX_ENROLLMENT_CHUNKS chunks; every embedding length
 * EMBEDDING_DIM with finite numbers; quality 0..1; ≤ 6 distinct sessionIds.
 * Every embedding is re-normalized server-side before storage (client
 * normalization is never trusted). Calls replace_user_voice_profile — one
 * atomic delete-then-insert.
 */
export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user } = auth

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }

  const { chunks, source } = (body ?? {}) as {
    chunks?: unknown
    source?: unknown
  }

  if (!Array.isArray(chunks) || chunks.length === 0) {
    return badRequest('chunks must be a non-empty array')
  }
  if (chunks.length > MAX_CHUNKS) {
    return badRequest(`chunks may not exceed ${MAX_CHUNKS}`)
  }
  if (source !== 'settings_training' && source !== 'session_confirm') {
    return badRequest('source must be settings_training or session_confirm')
  }

  const sessionIds = new Set<string>()
  const normalized: { embedding: number[]; quality: number; sessionId: string }[] = []

  for (const chunk of chunks as unknown[]) {
    const c = (chunk ?? {}) as {
      embedding?: unknown
      quality?: unknown
      sessionId?: unknown
    }
    if (!Array.isArray(c.embedding) || c.embedding.length !== EMBEDDING_DIM) {
      return badRequest(`each embedding must have length ${EMBEDDING_DIM}`)
    }
    if (!c.embedding.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      return badRequest('embedding values must be finite numbers')
    }
    if (
      typeof c.quality !== 'number' ||
      !Number.isFinite(c.quality) ||
      c.quality < 0 ||
      c.quality > 1
    ) {
      return badRequest('quality must be a number in [0, 1]')
    }
    if (typeof c.sessionId !== 'string' || c.sessionId.length === 0) {
      return badRequest('sessionId must be a non-empty string')
    }
    sessionIds.add(c.sessionId)
    normalized.push({
      embedding: l2Normalize(c.embedding as number[]),
      quality: c.quality,
      sessionId: c.sessionId,
    })
  }

  if (sessionIds.size > MAX_SESSIONS) {
    return badRequest(`too many distinct sessions (max ${MAX_SESSIONS})`)
  }

  // Embedding is passed as the pgvector text form (JSON.stringify) — the same
  // proven format the voice-enrollments POST uses for pgvector inserts.
  const rpcRows = normalized.map((n) => ({
    embedding: JSON.stringify(n.embedding),
    quality: n.quality,
    session_id: n.sessionId,
    source,
  }))

  // p_user_id: on device-token auth requireWorkspace() hands back a sessionless
  // cookie client, so the RPC cannot read auth.uid(); pass the verified user.
  const { error } = await supabase.rpc('replace_user_voice_profile', {
    p_rows: rpcRows,
    p_user_id: user.id,
  })
  if (error) return serverError(error.message)

  const meanQuality =
    normalized.reduce((sum, n) => sum + n.quality, 0) / normalized.length

  const status: VoiceProfileStatus = {
    enrolled: true,
    quality: meanQuality,
    chunkCount: normalized.length,
    createdAt: new Date().toISOString(),
  }
  return NextResponse.json(status)
}

/**
 * DELETE /api/account/voice-profile
 *
 * Remove all of the caller's voice-profile rows (un-enroll). RLS scopes the
 * delete to auth.uid() = user_id.
 */
export async function DELETE() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user } = auth

  const { error } = await supabase
    .from('user_voice_profile')
    .delete()
    .eq('user_id', user.id)

  if (error) return serverError(error.message)

  const status: VoiceProfileStatus = {
    enrolled: false,
    quality: null,
    chunkCount: 0,
    createdAt: null,
  }
  return NextResponse.json(status)
}
