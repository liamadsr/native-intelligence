import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Self-binding — is a transcript voice verifiably the signed-in user?
// ---------------------------------------------------------------------------
// A capture carries one is_self participant row (the capture owner's identity
// anchor, seeded at capture create). That row's speaker_label is only
// trustworthy at the evidence tier recorded in self_binding:
//
//   none      — identity known, voice not. Self-assigned items stay pending.
//   position  — desktop dual-channel capture whose mic stream diarized exactly
//               ONE voice for the whole session (the solo-desk case). Granted
//               and revoked here, from the persisted transcript.
//   confirmed — the user clicked "this was me" on a label; or the server
//               wrote it from a call's roster (source 'call_roster': one
//               track is one known person), for every member in the call.
//               On such a call the gate does not trust labels at all: an
//               action is someone's own only when the line it was quoted
//               from was said by their own roster row (quoteIsTheirs).
//   voice     — the label matched the user's trained voiceprint.
//
// The auto-apply gates (live-agent route + stage route) refuse to auto-apply
// an action to the current user unless this module says their binding holds.
// Without that, "assigned to me" is just the model's inference from
// first-person phrasing — the exact mechanism that misassigned other people's
// commitments to the capture owner.
// ---------------------------------------------------------------------------

/** Kill switch, mirroring RACE_DAMP_ENABLED / EXTRACTION_GUARDRAIL_ENABLED.
 *  Flip to false to restore the legacy member-id-only auto-apply gate. */
export const SELF_BINDING_GATE_ENABLED = true

export type SelfBindingEvidence = 'none' | 'position' | 'confirmed' | 'voice'

export interface SelfBindingState {
  /** True when the CURRENT USER's self row has an evidence-backed voice binding. */
  bound: boolean
  evidence: SelfBindingEvidence
  memberId: string | null
  speakerLabel: string | null
}

const UNBOUND: SelfBindingState = {
  bound: false,
  evidence: 'none',
  memberId: null,
  speakerLabel: null,
}

/** Persisted transcript lines look like "[local_1] text" (recording-context
 *  saveTranscript) or "[local_1]: text" (live chunk format). Same labels. */
const LOCAL_LABEL_RE = /\[(local_\d+)\]/g

/** Distinct local_* speaker labels appearing in a persisted transcript. */
export function distinctLocalLabels(transcript: string): string[] {
  const seen = new Set<string>()
  for (const m of transcript.matchAll(LOCAL_LABEL_RE)) seen.add(m[1])
  return [...seen].sort()
}

/**
 * Position evidence: on a desktop dual-channel capture, the mic stream is the
 * owner's own microphone. When exactly ONE voice was ever diarized on it, that
 * voice is near-certainly the owner. The moment a second local voice exists
 * (in-person meeting, speakerphone bleed) position tells us nothing — and web
 * mic-only captures put EVERY participant on the mic stream, so they never
 * qualify regardless of label count.
 */
export function positionEvidenceHolds(
  transcript: string,
  captureMode: string | null | undefined,
): boolean {
  if (captureMode !== 'desktop_dual') return false
  const labels = distinctLocalLabels(transcript)
  return labels.length === 1 && labels[0] === 'local_1'
}

/**
 * Resolve the current user's self-binding for a capture, refreshing position
 * evidence from the persisted transcript.
 *
 * - No self row, or the self row belongs to a different member (a teammate
 *   running a turn on someone else's capture) → unbound.
 * - confirmed / voice → bound, no transcript read (explicit evidence never
 *   downgrades here).
 * - none / position → recompute from transcript + capture_mode: grant
 *   position (bind local_1) when it holds, revoke a stale position binding
 *   when it no longer does. The transcript is fetched only on this path —
 *   live turns with an already-explicit binding never pull the large column.
 */
export async function resolveSelfBinding(
  supabase: SupabaseClient,
  captureId: string,
  currentMemberId: string | null,
): Promise<SelfBindingState> {
  if (!currentMemberId) return UNBOUND

  const { data: selfRow } = await supabase
    .from('capture_participant')
    .select('id, member_id, speaker_label, self_binding')
    .eq('capture_id', captureId)
    .eq('is_self', true)
    .maybeSingle()

  if (!selfRow || selfRow.member_id !== currentMemberId) return UNBOUND

  const evidence = (selfRow.self_binding as SelfBindingEvidence | null) ?? 'none'
  if (evidence === 'confirmed' || evidence === 'voice') {
    return {
      bound: true,
      evidence,
      memberId: selfRow.member_id as string,
      speakerLabel: (selfRow.speaker_label as string | null) ?? null,
    }
  }

  // none | position → (re)derive position evidence from the saved transcript.
  const { data: cap } = await supabase
    .from('captures')
    .select('transcript, metadata')
    .eq('id', captureId)
    .maybeSingle()
  const transcript = (cap?.transcript as string | null) ?? ''
  const captureMode =
    ((cap?.metadata as Record<string, unknown> | null)?.capture_mode as string | undefined) ?? null

  let holds = positionEvidenceHolds(transcript, captureMode)

  // Voice ID may have already assigned local_1 to a participant row of its
  // own. Two rows must never share a label (label→person resolution and the
  // speaker-assignments upsert both assume uniqueness) — and if that row maps
  // to a DIFFERENT person, the mic voice is verifiably NOT the owner, so
  // position evidence is wrong regardless.
  let labelAlreadyHeld = false
  if (holds) {
    const { data: labelRows } = await supabase
      .from('capture_participant')
      .select('id, member_id, is_self, contact:contact!contact_id(id, member_id)')
      .eq('capture_id', captureId)
      .eq('speaker_label', 'local_1')
    for (const row of labelRows ?? []) {
      if ((row as { id: string }).id === selfRow.id) continue
      labelAlreadyHeld = true
      const rowMemberId =
        ((row as { member_id?: string | null }).member_id ??
          ((row as { contact?: { member_id?: string | null } | null }).contact?.member_id ?? null))
      if (rowMemberId !== currentMemberId) {
        // local_1 is voice-identified as someone else — refuse position.
        holds = false
      }
      // Owner-mapped local_1 row → evidence stands; resolution flows through
      // THAT row (contact.member_id FK), so we just avoid writing a duplicate.
    }
  }

  if (holds && !labelAlreadyHeld && evidence !== 'position') {
    await supabase
      .from('capture_participant')
      .update({ speaker_label: 'local_1', self_binding: 'position' })
      .eq('id', selfRow.id)
      .eq('self_binding', 'none') // never clobber a concurrent confirm/voice upgrade
  } else if (!holds && evidence === 'position') {
    // A second local voice appeared — position evidence is revoked for this
    // capture. The label is cleared so nothing downstream treats local_1 as
    // the user; explicit confirmation or a voiceprint match can re-bind.
    await supabase
      .from('capture_participant')
      .update({ speaker_label: null, self_binding: 'none' })
      .eq('id', selfRow.id)
      .eq('self_binding', 'position')
  }

  if (!holds) {
    return {
      bound: false,
      evidence: 'none',
      memberId: selfRow.member_id as string,
      speakerLabel: null,
    }
  }
  return {
    bound: true,
    evidence: 'position',
    memberId: selfRow.member_id as string,
    speakerLabel: 'local_1',
  }
}

/**
 * Does a call's roster say who each voice on this capture is (participant
 * rows the server wrote, source 'call_roster', migration 587)? Only captures
 * the call recorder filled in have such rows; nobody else can make one
 * (587's capture_participant_roster_guard).
 */
export async function callRosterSetsSpeakers(supabase: SupabaseClient, captureId: string): Promise<boolean> {
  const { data } = await supabase.from('capture_participant').select('id').eq('capture_id', captureId).eq('source', 'call_roster').limit(1)
  return (data ?? []).length > 0
}

/** Who said a quote on a call's capture: the participant row of each transcript line that holds it (588's capture_feed_quote_speakers). */
export interface QuoteSpeaker {
  participant_id: string | null
  member_id: string | null
  source: string | null
}

/**
 * On a call the recorder heard, an action is its assignee's own only when
 * the line it came from was said by that member's own roster row: exactly
 * one row said the quote, it is a `call_roster` row, and it is that member.
 * A name that merely equals a label, a guest named like a member, a quote
 * nobody (or more than one person) said: never. Pure.
 */
export function quoteIsTheirs(speakers: readonly QuoteSpeaker[], memberId: string | null | undefined): boolean {
  if (!memberId || speakers.length !== 1) return false
  const [one] = speakers
  return !!one.participant_id && one.source === 'call_roster' && one.member_id === memberId
}

/**
 * Was this quote said by a member of the workspace, each line of it by their
 * own roster row (never a guest, never a name in the text)? A call's decision
 * or milestone is filed without a person's click only then (the live agent's
 * route): one a guest said stays a suggestion.
 */
export function quoteSaidByMembers(speakers: readonly QuoteSpeaker[]): boolean {
  return speakers.length > 0 && speakers.every((s) => !!s.participant_id && s.source === 'call_roster' && !!s.member_id)
}

/** Who said this quote on this capture (the service role: the segments are the server's). Fails closed: an error is nobody. */
export async function quoteSpeakers(svc: SupabaseClient, captureId: string, quote: string | null | undefined): Promise<QuoteSpeaker[]> {
  if (!quote || !quote.trim()) return []
  const { data, error } = await svc.rpc('capture_feed_quote_speakers', { p_capture: captureId, p_quote: quote })
  if (error) {
    console.warn(`[self-binding] capture=${captureId} quote speakers not read:`, error.message.slice(0, 120))
    return []
  }
  return (data ?? []) as QuoteSpeaker[]
}

/**
 * The staging-time resolution mechanism recorded on a proposal
 * (proposed_change.extra.assignee_resolution by propose_change):
 *   'speaker_label' — the owner was resolved through the capture's speaker map
 *                     (deterministic; eligible for self auto-apply).
 *   'name_match'    — resolved by fuzzy name — the model's inference echoed
 *                     back (the old misassignment vector; never auto-applied
 *                     to the current user while the gate is enabled).
 */
export function assigneeResolvedViaSpeakerMap(extra: unknown): boolean {
  return (
    !!extra &&
    typeof extra === 'object' &&
    (extra as Record<string, unknown>).assignee_resolution === 'speaker_label'
  )
}
