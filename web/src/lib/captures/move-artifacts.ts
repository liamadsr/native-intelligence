/**
 * Pure logic for the capture move-with-artifacts flow.
 *
 * The move preflight (GET /api/account/captures/[id]/move/preflight) fetches
 * raw rows and delegates the judgement calls here so they're unit-testable:
 *
 *   - Which confirmed extracted actions look hand-edited? Those are
 *     ambiguous to move, so the UI surfaces them unchecked and the user
 *     decides. "Edited" means the title/description drifted from the applied
 *     AI proposal that created the action, the action accreted work of its
 *     own (comments, labels, PR links), or it is synced to an external
 *     tracker whose link the move severs (migration 221).
 *   - Which claims are solely evidenced by this capture (safe to move) vs
 *     shared with other sources (ambiguous, stays behind)?
 *   - Which participant contacts were auto-created (copyable to the
 *     destination) vs deliberately curated (stay behind)?
 */

/** contact.source values that mean "the system created this contact from
 * capture/calendar participants" — safe to copy along with the capture. */
const AUTO_CREATED_CONTACT_SOURCES = [
  'capture_participant',
  'calendar_sync',
] as const

export interface ConfirmedActionRow {
  id: string
  identifier: string
  title: string
  description: string | null
}

/** An applied `proposed_change` that created an action — the extraction-time
 * snapshot we diff the live action against. */
export interface AppliedActionProposal {
  result_entity_id: string | null
  title: string | null
  description: string | null
}

export interface ConfirmedActionSignal {
  id: string
  identifier: string
  title: string
  edited: boolean
  edit_reasons: string[]
}

const normalize = (s: string | null | undefined) => (s ?? '').trim()

/**
 * Flag confirmed actions that were customized after extraction.
 *
 * Actions created through the proposed_change staging layer have an applied
 * proposal whose title/description snapshot the extraction output; drift
 * from that snapshot means someone edited the action. Actions created
 * through the older suggest-then-confirm flow have no snapshot, so for
 * those only the accretion signals (comments/labels/PRs/external tracker)
 * can fire.
 *
 * `externalLinkedActionIds` is optional so existing callers keep working;
 * omitting it simply never fires the external-tracker reason.
 */
export function computeConfirmedActionSignals(input: {
  actions: ConfirmedActionRow[]
  proposals: AppliedActionProposal[]
  commentedActionIds: Iterable<string>
  labeledActionIds: Iterable<string>
  prLinkedActionIds: Iterable<string>
  /** Actions with a Jira/Linear/Asana link. The move severs those links
   * (the destination's credentials can't authenticate a source-tenant issue
   * id), so the action is ambiguous to move. */
  externalLinkedActionIds?: Iterable<string>
}): ConfirmedActionSignal[] {
  const proposalByAction = new Map<string, AppliedActionProposal>()
  for (const p of input.proposals) {
    if (p.result_entity_id) proposalByAction.set(p.result_entity_id, p)
  }
  const commented = new Set(input.commentedActionIds)
  const labeled = new Set(input.labeledActionIds)
  const prLinked = new Set(input.prLinkedActionIds)
  const externalLinked = new Set(input.externalLinkedActionIds ?? [])

  return input.actions.map((action) => {
    const reasons: string[] = []
    const proposal = proposalByAction.get(action.id)
    if (proposal) {
      // A null proposal field means the extraction didn't record it — no
      // basis for a diff, so it never counts as an edit.
      if (proposal.title !== null && normalize(proposal.title) !== normalize(action.title)) {
        reasons.push('title edited')
      }
      if (
        proposal.description !== null &&
        normalize(proposal.description) !== normalize(action.description)
      ) {
        reasons.push('description edited')
      }
    }
    if (commented.has(action.id)) reasons.push('has comments')
    if (labeled.has(action.id)) reasons.push('has labels')
    if (prLinked.has(action.id)) reasons.push('linked to a pull request')
    if (externalLinked.has(action.id)) reasons.push('synced to an external tracker')

    return {
      id: action.id,
      identifier: action.identifier,
      title: action.title,
      edited: reasons.length > 0,
      edit_reasons: reasons,
    }
  })
}

export type { ClaimSourceRow } from '@/lib/workspace-move/artifacts'
import { partitionClaimsForSources, type ClaimSourceRow as GenericClaimSourceRow } from '@/lib/workspace-move/artifacts'

/**
 * Split capture-linked claims into sole-sourced (every piece of evidence
 * points at this capture or one of its attachments — moves with the capture)
 * and shared (evidence from elsewhere too — ambiguous, stays behind).
 * The capture-shaped face of the generic partition in
 * `@/lib/workspace-move/artifacts` — same rule the SQL engine applies.
 */
export function partitionClaimsBySource(
  claimIds: string[],
  sourceRows: GenericClaimSourceRow[],
  captureId: string,
  attachmentIds: string[],
): { soleSourced: string[]; shared: string[] } {
  return partitionClaimsForSources(claimIds, sourceRows, [
    { type: 'capture', id: captureId },
    ...attachmentIds.map((id) => ({ type: 'attachment', id })),
  ])
}

export interface ParticipantContactRow {
  id: string
  full_name: string
  email: string | null
  source: string | null
}

/**
 * Split a capture's participant contacts into auto-created ones (copied to
 * the destination workspace on move) and the rest (manually curated or
 * email-less — they stay; the participant link translates by email if a
 * matching contact already exists in the destination).
 * An email is required to copy: the destination dedupe and the participant
 * re-link both key on it.
 */
export function splitParticipantContacts(contacts: ParticipantContactRow[]): {
  autoCreated: ParticipantContactRow[]
  other: ParticipantContactRow[]
} {
  const autoCreated: ParticipantContactRow[] = []
  const other: ParticipantContactRow[] = []
  for (const contact of contacts) {
    const isAuto =
      contact.email !== null &&
      contact.email !== '' &&
      (AUTO_CREATED_CONTACT_SOURCES as readonly string[]).includes(contact.source ?? '')
    if (isAuto) autoCreated.push(contact)
    else other.push(contact)
  }
  return { autoCreated, other }
}
