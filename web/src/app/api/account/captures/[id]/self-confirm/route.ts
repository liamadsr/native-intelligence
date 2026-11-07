import { type NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, forbidden, notFound, serverError } from '@/lib/api-errors'
import { cosineSimilarity, l2Normalize } from '@/lib/voice-id-matching'
import {
  EMBEDDING_DIM,
  MAX_SELF_TOPUP_EMBEDDINGS,
  MAX_SESSION_CONFIRM_ROWS,
  SELF_TOPUP_FLOOR,
  type PostSelfConfirmResult,
} from '@/lib/voice-profile/types'
import { buildSelfPrototypes, type UserVoiceProfileRow } from '@/lib/voice-profile/server'

/**
 * POST /api/account/captures/[id]/self-confirm
 *
 * The user says which transcript voice is theirs — "This is me" on a speaker,
 * or ✓ / ✕ on "Is this you?" — the way they link an attendee's voice to a
 * contact (followups issue 11). A person's word is the evidence, so unlike
 * /self-binding (an automatic voice match the server re-verifies) this binds
 * without a similarity bar, as an attendee's manual link does.
 *
 * Body: { speaker_label, decision: 'mine' | 'not_mine', embeddings?: number[][] }
 *
 * 'mine':
 *   1. Ownership: captures.user_id === user.id (the microphone is the owner's).
 *   2. The label is released from any other participant row (labels are unique
 *      per capture), then ONE atomic conditional UPDATE binds the self row:
 *      self_binding 'confirmed' (terminal: readers treat it as bound, and the
 *      voice route's CAS cannot replace it), speaker_label.
 *   3. Learning: the posted embeddings (the voice's sampled segments) are
 *      appended to the user's profile as 'session_confirm' rows
 *      (append_user_voice_profile, migration 288) when most of them are at
 *      least SELF_TOPUP_FLOOR close to the profile, and then only those — a
 *      misclick on a stranger binds the capture but does not teach the profile
 *      a stranger's voice. With
 *      no profile yet, the first confirm teaches unconditionally, as an
 *      attendee's first link enrolls them. A confirm made before the voice had
 *      samples posts few or none; the client keeps sampling that voice and
 *      posts 'mine' again at stop with the samples since (binding is
 *      idempotent), so the profile still learns (followups issue 24).
 * 'not_mine': if the self row is bound to this label (any tier), it is unbound
 *   (self_binding 'none', no label). Nothing is learned.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user } = auth

  const { id: captureId } = await params

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }

  const { speaker_label, decision, embeddings } = (body ?? {}) as {
    speaker_label?: unknown
    decision?: unknown
    embeddings?: unknown
  }

  if (typeof speaker_label !== 'string' || speaker_label.length === 0 || speaker_label.length > 64) {
    return badRequest('speaker_label must be a non-empty string')
  }
  if (decision !== 'mine' && decision !== 'not_mine') {
    return badRequest("decision must be 'mine' or 'not_mine'")
  }
  const posted = embeddings === undefined ? [] : embeddings
  if (!Array.isArray(posted)) return badRequest('embeddings must be an array')
  if (posted.length > MAX_SELF_TOPUP_EMBEDDINGS) {
    return badRequest(`embeddings may not exceed ${MAX_SELF_TOPUP_EMBEDDINGS} entries`)
  }
  for (const emb of posted as unknown[]) {
    if (!Array.isArray(emb) || emb.length !== EMBEDDING_DIM) {
      return badRequest(`each embedding must have length ${EMBEDDING_DIM}`)
    }
    if (!emb.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      return badRequest('embedding values must be finite numbers')
    }
  }

  // Ownership: the microphone (and the voiceprint) belong to the capture OWNER.
  // Not-found and not-owner both 403 so a co-tenant can't probe existence.
  const { data: capture, error: captureError } = await supabase
    .from('captures')
    .select('id, user_id')
    .eq('id', captureId)
    .maybeSingle<{ id: string; user_id: string }>()
  if (captureError) return serverError(captureError.message)
  if (!capture || capture.user_id !== user.id) return forbidden('Not the capture owner')

  const { data: selfRow, error: selfError } = await supabase
    .from('capture_participant')
    .select('id, speaker_label, self_binding')
    .eq('capture_id', captureId)
    .eq('is_self', true)
    .maybeSingle<{ id: string; speaker_label: string | null; self_binding: string | null }>()
  if (selfError) return serverError(selfError.message)
  if (!selfRow) return notFound('No self participant row')

  if (decision === 'not_mine') {
    const { data: cleared, error } = await supabase
      .from('capture_participant')
      .update({ self_binding: 'none', speaker_label: null, voice_match_confidence: null })
      .eq('id', selfRow.id)
      .eq('speaker_label', speaker_label)
      .select('id')
    if (error) return serverError(error.message)
    const result: PostSelfConfirmResult = { unbound: (cleared ?? []).length > 0 }
    return NextResponse.json(result)
  }

  // The label belongs on the self row now: release it from any other row.
  const { error: releaseError } = await supabase
    .from('capture_participant')
    .update({ speaker_label: null })
    .eq('capture_id', captureId)
    .eq('is_self', false)
    .eq('speaker_label', speaker_label)
  if (releaseError) return serverError(releaseError.message)

  const { data: updated, error: updateError } = await supabase
    .from('capture_participant')
    .update({ self_binding: 'confirmed', speaker_label })
    .eq('id', selfRow.id)
    .eq('is_self', true)
    .select('id')
  if (updateError) return serverError(updateError.message)
  if (!updated || updated.length === 0) {
    const result: PostSelfConfirmResult = { bound: false, reason: 'Self row not updated' }
    return NextResponse.json(result)
  }

  const learned = await learnFromVoice(supabase, user.id, captureId, posted as number[][])
  const result: PostSelfConfirmResult = { bound: true, learned }
  return NextResponse.json(result)
}

/**
 * Append a confirmed voice's embeddings to the user's profile, fail-soft: the
 * binding already stands, so a failed learn only means the profile did not
 * grow this time. Returns how many rows were added.
 */
async function learnFromVoice(
  supabase: SupabaseClient,
  userId: string,
  captureId: string,
  embeddings: number[][],
): Promise<number> {
  // One line per confirm, so a confirm that teaches nothing says why (issue 24).
  const log = (kept: number, learned: number, reason: string) =>
    console.info(`[self-confirm] capture ${captureId}: posted ${embeddings.length}, kept ${kept}, learned ${learned} (${reason})`)
  if (embeddings.length === 0) {
    log(0, 0, 'no embeddings posted')
    return 0
  }
  const normalized = embeddings.map((e) => l2Normalize(e))

  const { data: rows, error } = await supabase
    .from('user_voice_profile')
    .select('embedding, quality, session_id, created_at, source')
    .eq('user_id', userId)
  if (error) {
    console.warn('[self-confirm] profile read failed:', error.message)
    return 0
  }
  const prototypes = buildSelfPrototypes((rows as unknown as UserVoiceProfileRow[]) ?? [])

  // Each embedding's closeness to the profile as it stands.
  const sims = normalized.map((e) =>
    prototypes.length === 0 ? null : Math.max(...prototypes.map((p) => cosineSimilarity(e, p))),
  )
  // With a profile: learn only when most of the voice is close to it, and then
  // only its close segments (a stray far one is likely someone else's cross-talk).
  let keep = normalized.map((_, i) => i)
  if (prototypes.length > 0) {
    keep = keep.filter((i) => (sims[i] ?? 0) >= SELF_TOPUP_FLOOR)
    if (keep.length * 2 < normalized.length) {
      log(keep.length, 0, `fewer than half at least ${SELF_TOPUP_FLOOR} to the profile`)
      return 0
    }
  }

  const rpcRows = keep.map((i) => ({
    embedding: JSON.stringify(normalized[i]),
    quality: sims[i] ?? null,
    session_id: captureId,
  }))
  const { data: inserted, error: rpcError } = await supabase.rpc('append_user_voice_profile', {
    p_rows: rpcRows,
    p_max_session_rows: MAX_SESSION_CONFIRM_ROWS,
    p_user_id: userId,
  })
  if (rpcError) {
    console.warn('[self-confirm] profile append failed:', rpcError.message)
    return 0
  }
  const learned = typeof inserted === 'number' ? inserted : rpcRows.length
  log(keep.length, learned, prototypes.length === 0 ? 'first profile rows' : 'appended')
  return learned
}
