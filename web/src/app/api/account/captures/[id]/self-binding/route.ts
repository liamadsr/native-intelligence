import { type NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, forbidden, notFound, serverError } from '@/lib/api-errors'
import { cosineSimilarity } from '@/lib/voice-id-matching'
import {
  EMBEDDING_DIM,
  SELF_BINDING_MIN_SERVER_MATCHES,
  SELF_VERIFY_THRESHOLD,
  type PostSelfBindingResult,
} from '@/lib/voice-profile/types'
import { buildSelfPrototypes, type UserVoiceProfileRow } from '@/lib/voice-profile/server'

/** Vote window the client posts — 2–5 qualifying segment embeddings. */
const MIN_EMBEDDINGS = 2
const MAX_EMBEDDINGS = 5

/**
 * POST /api/account/captures/[id]/self-binding
 *
 * The client asserts a speaker label matched the signed-in user's voiceprint
 * (2-of-3 vote window). The server NEVER trusts a client-asserted confidence
 * for a terminal evidence tier — it re-verifies the posted embeddings against
 * the caller's OWN stored prototypes and only then grants self_binding='voice'.
 *
 * Body: { speaker_label: string, embeddings: number[][] }.
 *
 * Flow:
 *   1. Validate the body (2–5 embeddings, each length EMBEDDING_DIM, finite).
 *   2. Ownership: captures.user_id === user.id, else 403 (workspace membership
 *      is not enough — the biometric belongs to the capture OWNER).
 *   3. Re-verify: build prototypes from the caller's user_voice_profile rows
 *      (RLS-scoped), compute per-posted-embedding max-cosine; require ≥
 *      SELF_BINDING_MIN_SERVER_MATCHES embeddings ≥ SELF_VERIFY_THRESHOLD,
 *      else 422.
 *   4. Grant: ONE atomic conditional UPDATE, byte-for-byte the self-binding.ts
 *      idiom — .update({ self_binding:'voice', speaker_label,
 *      voice_match_confidence:<server max sim> }).eq('capture_id', id)
 *      .eq('is_self', true).in('self_binding', ['none','position']). Never
 *      read-then-write: resolveSelfBinding runs every live-agent turn on the
 *      same row and its position grant/revoke must not race a voice grant.
 *      404 if no self row; 200 {granted:false} if the CAS matched 0 rows.
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

  const { speaker_label, embeddings } = (body ?? {}) as {
    speaker_label?: unknown
    embeddings?: unknown
  }

  if (typeof speaker_label !== 'string' || speaker_label.length === 0) {
    return badRequest('speaker_label must be a non-empty string')
  }
  if (!Array.isArray(embeddings) || embeddings.length < MIN_EMBEDDINGS) {
    return badRequest(`embeddings must have at least ${MIN_EMBEDDINGS} entries`)
  }
  if (embeddings.length > MAX_EMBEDDINGS) {
    return badRequest(`embeddings may not exceed ${MAX_EMBEDDINGS} entries`)
  }
  for (const emb of embeddings as unknown[]) {
    if (!Array.isArray(emb) || emb.length !== EMBEDDING_DIM) {
      return badRequest(`each embedding must have length ${EMBEDDING_DIM}`)
    }
    if (!emb.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      return badRequest('embedding values must be finite numbers')
    }
  }

  // Ownership: the biometric belongs to the capture OWNER, not just any
  // workspace member. NOT-found and NOT-owner both surface as 403 so a
  // co-tenant can't probe capture existence.
  const { data: capture, error: captureError } = await supabase
    .from('captures')
    .select('id, user_id')
    .eq('id', captureId)
    .maybeSingle<{ id: string; user_id: string }>()

  if (captureError) return serverError(captureError.message)
  if (!capture || capture.user_id !== user.id) {
    return forbidden('Not the capture owner')
  }

  // Re-verify against the caller's OWN stored prototypes (RLS scopes SELECT to
  // auth.uid() = user_id).
  const { data: profileRows, error: profileError } = await supabase
    .from('user_voice_profile')
    .select('embedding, quality, session_id, created_at, source')
    .eq('user_id', user.id)

  if (profileError) return serverError(profileError.message)

  const prototypes = buildSelfPrototypes(
    (profileRows as unknown as UserVoiceProfileRow[]) || [],
  )

  if (prototypes.length === 0) {
    const result: PostSelfBindingResult = {
      granted: false,
      reason: 'No voice profile enrolled',
    }
    return NextResponse.json(result, { status: 422 })
  }

  // Per-posted-embedding max cosine over the caller's prototypes.
  let matchCount = 0
  let maxSim = 0
  for (const emb of embeddings as number[][]) {
    let best = 0
    for (const proto of prototypes) {
      const sim = cosineSimilarity(emb, proto)
      if (sim > best) best = sim
    }
    if (best > maxSim) maxSim = best
    if (best >= SELF_VERIFY_THRESHOLD) matchCount++
  }

  if (matchCount < SELF_BINDING_MIN_SERVER_MATCHES) {
    const result: PostSelfBindingResult = {
      granted: false,
      reason: 'Voice did not match the trained profile',
    }
    return NextResponse.json(result, { status: 422 })
  }

  // The self row must already exist (seeded at capture create). Probe it so a
  // missing row is a clean 404 rather than an ambiguous CAS miss.
  const { data: selfRow, error: selfError } = await supabase
    .from('capture_participant')
    .select('id')
    .eq('capture_id', captureId)
    .eq('is_self', true)
    .maybeSingle<{ id: string }>()

  if (selfError) return serverError(selfError.message)
  if (!selfRow) return notFound('No self participant row')

  // Label-uniqueness invariant (self-binding.ts:124-127): two participant rows
  // must never share a speaker_label — label→person resolution and the
  // speaker-assignments upsert both assume uniqueness. Before writing this
  // label onto the self row, release it from any NON-self row that already
  // holds it for this capture. In the dual-join / phone-echo case that other
  // row is the user's OWN echo arriving on a remote_* stream (Voice ID assigned
  // it the same label); it belongs on the self row now, so clearing the echo
  // row's label is correct. Owner-scoped: the caller owns this capture (checked
  // above), and RLS restricts the write to that capture's rows.
  const { error: releaseError } = await supabase
    .from('capture_participant')
    .update({ speaker_label: null })
    .eq('capture_id', captureId)
    .eq('is_self', false)
    .eq('speaker_label', speaker_label)

  if (releaseError) return serverError(releaseError.message)

  // Grant = ONE atomic conditional UPDATE. The .in(...) guard cannot downgrade
  // a 'confirmed' or existing 'voice' binding, and it structurally cannot race
  // resolveSelfBinding's position grant/revoke (which only touches
  // self_binding='none'/'position' rows too).
  const { data: updated, error: updateError } = await supabase
    .from('capture_participant')
    .update({
      self_binding: 'voice',
      speaker_label,
      voice_match_confidence: maxSim,
    })
    .eq('capture_id', captureId)
    .eq('is_self', true)
    .in('self_binding', ['none', 'position'])
    .select('id')

  if (updateError) return serverError(updateError.message)

  if (!updated || updated.length === 0) {
    // CAS matched 0 rows — the binding was already 'confirmed'/'voice', or a
    // concurrent turn upgraded it. Not an error; nothing to change.
    const result: PostSelfBindingResult = {
      granted: false,
      reason: 'Self binding already resolved',
    }
    return NextResponse.json(result)
  }

  const result: PostSelfBindingResult = { granted: true }
  return NextResponse.json(result)
}
