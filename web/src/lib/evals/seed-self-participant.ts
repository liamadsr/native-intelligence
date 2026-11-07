/**
 * The self participant on an EVAL capture.
 *
 * WHY THIS EXISTS RATHER THAN A CALL TO `seedSelfParticipant`. That helper
 * (`src/lib/crm/contacts.ts`) writes `contact_id: selfContact?.id ?? null` on
 * both its promote and its insert path, and migration 252's
 * `enforce_eval_capture_participant_links` trigger refuses a non-null
 * `contact_id` on an eval capture UNCONDITIONALLY — including on the self row,
 * deliberately, because the self *contact* is a real CRM row with a real
 * timeline that a mock call must never touch.
 *
 * So on any workspace whose owner has a self-contact (the normal case — it is
 * created at workspace-create and invite-accept), the real helper raises
 * `check_violation`. Both eval call sites swallow that in a `console.warn`, so
 * the failure mode is not a loud error: the self row is SILENTLY absent, and
 * the route's `currentMemberId` / `isMineExplicit` / self-binding resolution —
 * exactly what a trial is grading — behaves like a call with no owner. Every
 * assignee-to-me proposal would score differently from a real meeting, and
 * nothing would say why.
 *
 * The trigger permits precisely one shape, which is what this writes:
 *   contact_id  NULL           — always, no exception
 *   member_id   set            — allowed only when `is_self` is true AND the
 *                                member's user is the capture's OWN `user_id`
 *
 * That second half is why the caller must have already written the capture with
 * `user_id` = the run starter (which §3.4 requires anyway, for batch mode's 403).
 *
 * THE SPEAKER LABEL, and why it is not cosmetic. On a REAL desktop capture the
 * owner's self row acquires `speaker_label = 'local_1'` and
 * `self_binding = 'position'` from `resolveSelfBinding` (see
 * `src/lib/live-agent/self-binding.ts`). Two things downstream depend on it:
 *
 *   1. `resolvePersonForCapture`'s SPEAKER MAP resolves the label the agent
 *      attributes a line to ('local_1') → this row → its `member_id`. Without a
 *      label the self row is invisible to that map, so a proposal for something
 *      the owner said they would do comes back `assignee_member_id: null` and
 *      `assignee_resolution: 'name_match'` at best.
 *   2. The route's auto-apply gate then fails `assigneeResolvedViaSpeakerMap`,
 *      so `isMineExplicit` is false and every assignee-to-self case grades as a
 *      miss — which is exactly the batch trial that surfaced this.
 *
 * So an eval capture whose script HAS a self speaker seeds the label here,
 * rather than waiting for a binding pass that an eval capture can never run:
 * position evidence is derived from `metadata.capture_mode = 'desktop_dual'`,
 * which the eval capture writers set for precisely this reason. 'position' is
 * the honest tier — the eval owner has no voiceprint ('voice') and clicked
 * nothing ('confirmed'), and faking either would grade a stronger binding than
 * a real solo-desk call earns.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/** The evidence tier a position-bound real capture carries. Constrained by
 *  `capture_participant_self_binding_check` (migration 174) to one of
 *  'none' | 'position' | 'confirmed' | 'voice'. */
const SELF_BINDING_NONE = 'none' as const
const SELF_BINDING_POSITION = 'position' as const

/**
 * Insert the eval capture's self participant.
 *
 * Idempotent (an existing row is PROMOTED to carry the label rather than left
 * alone — a case authored before labels existed would otherwise keep grading
 * ownership wrong forever) and best-effort in the same way the real seeder is:
 * a workspace with no `member` row for this user gets no self row, because
 * there is no member to link.
 *
 * @param args.speakerLabel the script's self voice ('local_1'). When given, the
 *        row carries it with `self_binding = 'position'`, which is what the
 *        speaker map and the auto-apply gate need (see the file header). When
 *        omitted the row is seeded unlabeled and unbound, exactly as before.
 * @returns whether a self row exists on the capture when this returns.
 */
export async function seedEvalSelfParticipant(
  service: SupabaseClient,
  args: {
    workspaceId: string
    captureId: string
    userId: string
    speakerLabel?: string | null
  },
): Promise<boolean> {
  const { data: member } = await service
    .from('member')
    .select('id, display_name')
    .eq('workspace_id', args.workspaceId)
    .eq('user_id', args.userId)
    .limit(1)
    .maybeSingle<{ id: string; display_name: string | null }>()
  if (!member) return false

  const label = args.speakerLabel?.trim() || null

  const { data: existing } = await service
    .from('capture_participant')
    .select('id, speaker_label')
    .eq('capture_id', args.captureId)
    .eq('is_self', true)
    .limit(1)
    .maybeSingle<{ id: string; speaker_label: string | null }>()
  if (existing) {
    // PROMOTE rather than return blind: a row seeded before this call knew the
    // label (an older case, or the 23505 race below) is the one that mis-grades
    // ownership. Only ever an upgrade — never clear a label we already have.
    if (label && existing.speaker_label !== label) {
      const { error: promoteError } = await service
        .from('capture_participant')
        .update({ speaker_label: label, self_binding: SELF_BINDING_POSITION })
        .eq('id', existing.id)
      if (promoteError) {
        throw new Error(
          `eval self participant label promote failed: ${promoteError.message}`,
        )
      }
    }
    return true
  }

  const { error } = await service.from('capture_participant').insert({
    capture_id: args.captureId,
    member_id: member.id,
    // NEVER set, on any path. See the file header: the trigger refuses it, and
    // the self contact is a real CRM row.
    contact_id: null,
    external_name: member.display_name,
    role: 'organizer',
    is_self: true,
    // The label and its evidence tier move together: a label with
    // `self_binding: 'none'` is what the route reads as "no transcript voice is
    // verified as the user", so it would buy nothing.
    speaker_label: label,
    self_binding: label ? SELF_BINDING_POSITION : SELF_BINDING_NONE,
  })

  // 23505 = a concurrent seed won the partial-unique-index race, so the row we
  // wanted exists. Anything else is real and must be visible: a missing self
  // row changes what every trial grades, so it cannot stay a silent warning.
  if (error && error.code !== '23505') {
    throw new Error(`eval self participant insert failed: ${error.message}`)
  }
  // The race winner may have written the row WITHOUT a label (an older caller,
  // or a concurrent seed that had none). Promote it, for the same reason the
  // existing-row path above does.
  if (error && label) {
    const { error: promoteError } = await service
      .from('capture_participant')
      .update({ speaker_label: label, self_binding: SELF_BINDING_POSITION })
      .eq('capture_id', args.captureId)
      .eq('is_self', true)
      .is('speaker_label', null)
    if (promoteError) {
      throw new Error(
        `eval self participant label promote failed: ${promoteError.message}`,
      )
    }
  }
  return true
}
