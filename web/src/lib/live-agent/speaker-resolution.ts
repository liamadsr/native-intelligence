import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveMemberIdByName, resolveContactIdByName } from '@/lib/people/name-match'
import { filterVisibleContacts } from '@/lib/crm/contact-visibility'

// ---------------------------------------------------------------------------
// Speaker-label → person resolution
// ---------------------------------------------------------------------------
// Transcripts attribute speech to diarization labels ("remote_2", "local_1").
// Voice identification maps those labels to real people in
// capture_participant, and the live-agent prompt tells the model to use the
// mapped names — but prompts are advisory. When the model slips and passes a
// raw label as a person's name, that label used to flow straight into the
// knowledge graph ("remote_2 committed to …") or onto a proposal's
// assignee_name. This module is the server-side guarantee: every person name
// the staging tools receive is resolved through the capture's speaker map
// BEFORE it is written anywhere.
// ---------------------------------------------------------------------------

/** Diarization label shapes emitted by Deepgram / the desktop capture path. */
const DIARIZATION_LABEL_RE = /^(?:system|remote|local|speaker|spk|voice)[\s_-]?\d+$/i

/**
 * Generic stand-ins the model sometimes invents for unidentified voices.
 * These are not people — a claim attributed to "Colleague" is noise.
 */
const GENERIC_SPEAKER_PLACEHOLDERS = new Set([
  'attendee',
  'caller',
  'client',
  'colleague',
  'co-worker',
  'coworker',
  'friend',
  'guest',
  'interviewee',
  'interviewer',
  'local',
  'other',
  'others',
  'participant',
  'remote',
  'someone',
  'speaker',
  'them',
  'unidentified',
  'unidentified speaker',
  'unknown',
  'unknown speaker',
])

/** True when a "name" is a diarization label or generic placeholder, not a person. */
export function isSpeakerLabelLike(name: string): boolean {
  const n = name.trim().toLowerCase()
  return DIARIZATION_LABEL_RE.test(n) || GENERIC_SPEAKER_PLACEHOLDERS.has(n)
}

/**
 * First-person stand-ins the model uses for the signed-in user ("assign it to
 * me"). These resolve to the capture's SELF participant row — the identity
 * anchor seeded at capture create — never through fuzzy name matching (where
 * "me" would just fail, and "you" could collide with a real name).
 */
const SELF_REFERENCE_TERMS = new Set(['you', 'me', 'myself', 'i', 'the user'])

export function isSelfReference(name: string): boolean {
  return SELF_REFERENCE_TERMS.has(name.trim().toLowerCase())
}

/** Compare labels ignoring case and space/underscore/hyphen differences
 *  ("Remote 2" ≡ "remote_2" ≡ "remote-2"). */
function normalizeLabel(s: string): string {
  return s.trim().toLowerCase().replace(/[\s_-]+/g, '_')
}

export interface PersonResolution {
  /** Best display name: the real person's name when resolved, else the input. */
  name: string
  memberId: string | null
  /** Only set when no member matched — mirrors the tools' member-first policy. */
  contactId: string | null
  /** The name resolved through the capture's voice-ID speaker assignments. */
  viaSpeakerMap: boolean
  /** Input was a label/placeholder that could NOT be mapped to a person —
   *  callers must not attribute anything to it. */
  unresolvedLabel: boolean
  /** Input was "you"/"me"-style and resolved to the capture's self row.
   *  Identity is certain (the capture owner); WHO SPOKE is not — so this is
   *  deliberately NOT viaSpeakerMap and never satisfies the self auto-apply
   *  gate on its own. */
  selfReference?: boolean
}

interface ParticipantRow {
  speaker_label: string | null
  member_id: string | null
  contact_id: string | null
  external_name: string | null
  external_email?: string | null
  is_self: boolean | null
  /** 'call_roster': the server wrote the row from a call's roster (migration 587). */
  source?: string | null
  member: { id: string; display_name: string | null } | null
  contact: { id: string; full_name: string | null; member_id: string | null } | null
}

/**
 * Drop every embedded contact `requesterUserId` cannot see (fails closed), as
 * RLS would on a user client — the eve live-agent tool route runs these reads
 * service-role (src/lib/crm/contact-visibility.ts). A hidden contact then
 * contributes neither its name, its id nor its member link, so nothing can be
 * attributed or assigned to it; the participant row's own external name (or,
 * failing that, its external email) still stands.
 *
 * A row whose `contact_id` is set but whose embedded contact came back null is
 * hidden too: that is exactly what RLS does on a user client (the join drops
 * the contact it will not show, the FK column survives), so the bare id must
 * not leak out as an assignee / claim subject either.
 */
async function fenceParticipantContacts(
  supabase: SupabaseClient,
  requesterUserId: string,
  rows: ParticipantRow[],
): Promise<ParticipantRow[]> {
  const embedded = rows.map((r) => r.contact).filter((c): c is NonNullable<ParticipantRow['contact']> => !!c)
  const visible = embedded.length
    ? new Set((await filterVisibleContacts(supabase, requesterUserId, embedded)).map((c) => c.id))
    : new Set<string>()
  const hidden = (r: ParticipantRow) => (r.contact ? !visible.has(r.contact.id) : !!r.contact_id)
  return rows.map((r) =>
    hidden(r)
      ? { ...r, contact: null, contact_id: null, external_name: r.external_name || r.external_email || null }
      : r,
  )
}

/**
 * Resolve a name the model passed (assignee_name / person_name) to an actual
 * person, in order of fidelity:
 *
 *   1. The capture's speaker map (capture_participant, written by voice ID) —
 *      catches raw labels AND custom labels used verbatim as speaker_label.
 *   2. Fuzzy member match on the (possibly replaced) name — nicknames, first
 *      names, respellings.
 *   3. Fuzzy CRM-contact fallback when no member matched.
 *
 * A label-like input that survives step 1 unmapped comes back with
 * `unresolvedLabel: true`; callers must degrade (unassigned proposal, refuse
 * the claim) rather than store the label as a person.
 */
export async function resolvePersonForCapture(
  supabase: SupabaseClient,
  workspaceId: string,
  captureId: string,
  rawName: string,
  /** The verified user the agent runs for: contacts they cannot see never resolve. */
  requesterUserId: string,
  /**
   * `contacts: false` resolves to members only (a call's capture,
   * src/lib/live-agent/call-capture-fence.ts): the contacts the requester sees
   * include their private ones, and what a call's turn attributes is read by
   * everyone in the conversation, so no contact is looked up or linked.
   */
  opts: { contacts?: boolean } = {},
): Promise<PersonResolution> {
  const input = rawName.trim()
  const withContacts = opts.contacts !== false

  // 1. Speaker map. Fetched fresh per call — assignments can land mid-meeting
  //    as voice ID confirms speakers, and staging tools fire sparsely enough
  //    that caching isn't worth the staleness.
  const { data: participants } = await supabase
    .from('capture_participant')
    .select(
      `speaker_label, member_id, contact_id, external_name, external_email, is_self, source,
       member:member!member_id(id, display_name),
       contact:contact!contact_id(id, full_name, member_id)`,
    )
    .eq('capture_id', captureId)

  const fenced = await fenceParticipantContacts(
    supabase,
    requesterUserId,
    (participants ?? []) as unknown as ParticipantRow[],
  )
  const rows = withContacts
    ? fenced
    : fenced.map((r) => (r.contact || r.contact_id ? { ...r, contact: null, contact_id: null, external_name: r.external_name || r.external_email || null } : r))

  // 0. First-person stand-ins ("you", "me") → the capture's self row. This is
  //    an IDENTITY resolution (the capture owner), not evidence about who
  //    spoke — so viaSpeakerMap stays false and the auto-apply gate keeps
  //    treating it as inference.
  if (isSelfReference(input)) {
    const selfRow = rows.find((p) => p.is_self)
    const selfName =
      selfRow?.member?.display_name || selfRow?.contact?.full_name || selfRow?.external_name || null
    if (selfRow && selfName) {
      return {
        name: selfName,
        memberId: selfRow.member_id,
        contactId: selfRow.member_id ? null : selfRow.contact_id,
        viaSpeakerMap: false,
        unresolvedLabel: false,
        selfReference: true,
      }
    }
    // No self row — "you" is unattributable, same posture as a bare label.
    return { name: input, memberId: null, contactId: null, viaSpeakerMap: false, unresolvedLabel: true }
  }

  const wanted = normalizeLabel(input)
  const mapped = rows.find(
    (p) => p.speaker_label && normalizeLabel(p.speaker_label) === wanted,
  )

  if (mapped) {
    const realName =
      mapped.member?.display_name || mapped.contact?.full_name || mapped.external_name || null
    if (realName) {
      let memberId = mapped.member_id
      // A call's roster row says exactly who it is: a guest's (no member) is no member, however
      // they named themselves, so it never falls through to a name match (migration 587).
      const fromRoster = mapped.source === 'call_roster'
      // A voice mapped only to a contact may still be a member: prefer the
      // contact's member_id FK (exact — set by ensureMemberContact) over the
      // fuzzy roster match, which can hit the wrong same-first-name member.
      if (!memberId && !fromRoster) memberId = mapped.contact?.member_id ?? null
      if (!memberId && !fromRoster) memberId = await resolveMemberIdByName(supabase, workspaceId, realName)
      return {
        name: realName,
        memberId,
        contactId: memberId ? null : mapped.contact_id,
        viaSpeakerMap: true,
        unresolvedLabel: false,
      }
    }
    // The label exists in the map but nobody has been assigned to it yet.
    if (isSpeakerLabelLike(input)) {
      return { name: input, memberId: null, contactId: null, viaSpeakerMap: false, unresolvedLabel: true }
    }
  }

  // 2. Not in the map. A bare label with no assignment is a dead end.
  if (isSpeakerLabelLike(input)) {
    return { name: input, memberId: null, contactId: null, viaSpeakerMap: false, unresolvedLabel: true }
  }

  // 3. A real name — fuzzy member match, then contact fallback.
  const memberId = await resolveMemberIdByName(supabase, workspaceId, input)
  const contactId = memberId || !withContacts
    ? null
    : await resolveContactIdByName(supabase, workspaceId, input, requesterUserId)
  return { name: input, memberId, contactId, viaSpeakerMap: false, unresolvedLabel: false }
}
