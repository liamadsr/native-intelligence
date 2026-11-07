/**
 * One trial, one capture (spec §3.4).
 *
 * WHY A CLONE PER TRIAL AND NOT A SHARED ROW: the live-agent route re-reads
 * pending `proposed_change` rows on EVERY call and feeds them to the model as
 * prior context. A second trial running against the same capture would open
 * with trial 1's proposals already on the board — so the second attempt of a
 * multi-attempt case would measure the first attempt, not the prompt. A fresh
 * row per trial is the only way attempts are independent samples.
 *
 * It buys nudge isolation for free too: `broadcastNudge` publishes on
 * `agent-nudge:<captureId>`, so a fresh UUID means nothing else can land on
 * this trial's channel.
 *
 * THE FIELD CONTRACT, and why each field is here rather than inherited:
 *
 *   `user_id`      the RUN STARTER, not the case's author. Batch mode 403s
 *                  unless the requester owns the capture, and grading is only
 *                  honest if `currentMemberId`, `isMineExplicit` and
 *                  self-binding behave as they would for that person.
 *   `ended_at`     NULL, and `is_transcript_locked` false. The append RPC
 *                  returns 'locked' and refuses every write otherwise, which
 *                  would silently freeze a live replay at chunk 1.
 *   `transcript`   the full text for batch; for live, ONLY the self speaker's
 *                  label line. A live trial must accumulate, or the agent sees
 *                  the whole meeting on flush 1 and every later flush measures
 *                  nothing — but a genuinely empty column makes
 *                  `positionEvidenceHolds` false, which revokes the self row's
 *                  position binding on the very first turn.
 *   `live_mode`    by mode — what the real client would have set.
 *   participants   copied WITHOUT contact/member links (the self row excepted),
 *                  the same rule the template follows.
 *   conversation   inserted directly, with the RUN's `recipe_id`. Without it
 *                  every `say_to_user` and `ask_user` no-ops.
 *   goal           when the case sets `expected.goal`, a `meeting_goal` row
 *                  for the RUN STARTER linked to this capture, so the live
 *                  agent reads it under "Before the call" as on a real call
 *                  (findMeetingGoalForCapture finds it by capture). Keyed with
 *                  the synthetic event id `capture:<id>` (trialGoalEventId):
 *                  a clone has no calendar event. deleteEvalCaptures removes
 *                  it with the clone.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { seedEvalSelfParticipant } from './seed-self-participant'
import { participantRoleColumn, scriptToTranscript } from './create-case'
import { upsertMeetingGoal } from '@/lib/meetings/meeting-goal'
import type { EvalCaseRow, EvalMode } from './types'

/** The synthetic calendar event id a trial's goal is keyed by: a clone stands
 *  for no calendar event, and the key must be unique per trial. */
export function trialGoalEventId(captureId: string): string {
  return `capture:${captureId}`
}

/** Participant columns copied onto the clone. Deliberately NOT `contact_id` or
 *  `member_id`: those are stripped by omission, so a column added later cannot
 *  leak a link into a clone by accident. */
const PARTICIPANT_COPY_FIELDS =
  'external_name, external_email, company, job_title, speaker_label, role, is_self, self_binding' as const

type TemplateParticipant = {
  external_name: string | null
  external_email: string | null
  company: string | null
  job_title: string | null
  speaker_label: string | null
  role: string | null
  is_self: boolean | null
  self_binding: string | null
}

/**
 * Clone a case's template capture into a fresh capture for one trial.
 *
 * @returns the new capture's id. Throws when the capture itself could not be
 *          written, or when the SELF participant could not be seeded — neither
 *          trial can produce a gradeable result (see the seed call below). A
 *          missing ordinary participant row only degrades the realism of one
 *          trial, so it is logged rather than fatal.
 */
export async function cloneTrialCapture(
  service: SupabaseClient,
  args: {
    caseRow: EvalCaseRow
    runStarterUserId: string
    workspaceId: string
    mode: EvalMode
    recipeId: string | null
  },
): Promise<{ captureId: string; transcriptLength: number }> {
  const isLive = args.mode === 'live'
  const now = new Date().toISOString()

  const [{ data: template }, { data: participants }] = await Promise.all([
    service
      .from('captures')
      .select('title, participants, team_id, project_id')
      .eq('id', args.caseRow.capture_id)
      .maybeSingle(),
    service
      .from('capture_participant')
      .select(PARTICIPANT_COPY_FIELDS)
      .eq('capture_id', args.caseRow.capture_id),
  ])

  // The template's own self row: its LABEL is what the clone carries forward
  // (see the seed call below), and in live mode it is also what the seed line
  // immediately under this needs.
  const templateSelf = ((participants ?? []) as TemplateParticipant[]).find((p) => p.is_self)
  const selfLabel =
    templateSelf && templateSelf.self_binding && templateSelf.self_binding !== 'none'
      ? templateSelf.speaker_label
      : null

  // A LIVE clone does not start blank. `resolveSelfBinding` re-derives position
  // evidence from this column on every turn, and an empty transcript makes
  // `positionEvidenceHolds` false — so the freshly seeded self row's
  // `self_binding: 'position'` is REVOKED on flush 1 and its speaker label
  // nulled, exactly the state a real meeting never reaches (a real client has
  // been appending since the first word). One label-bearing line restores the
  // evidence without putting any of the meeting's own content in front of the
  // chunk that carries it: the driver appends chunks after their POST as before.
  // Only `local_1` earns the seed: `positionEvidenceHolds` requires exactly one
  // distinct local label and it must be local_1, so seeding any other label
  // would add a line to the transcript and still leave the binding revoked.
  const liveSeed = isLive && selfLabel === 'local_1' ? `[${selfLabel}]\n` : ''
  const transcript = isLive ? liveSeed : scriptToTranscript(args.caseRow.script)

  const { data, error } = await service
    .from('captures')
    .insert({
      user_id: args.runStarterUserId,
      workspace_id: args.workspaceId,
      title: (template?.title as string | null) ?? args.caseRow.name,
      status: 'active',
      visibility: 'private',
      is_eval: true,
      // `capture_mode` is what makes the self row's `self_binding: 'position'`
      // SURVIVE. `resolveSelfBinding` does not trust a stored 'position' — it
      // re-derives it from the transcript on every turn, and
      // `positionEvidenceHolds` returns false for any mode but 'desktop_dual',
      // which would REVOKE the binding and null the label out from under the
      // speaker map. A script whose owner speaks on the mic stream is a
      // solo-desk dual-channel capture, so this is the honest mode, not a
      // convenient one.
      metadata: { demo: true, eval: true, capture_mode: 'desktop_dual' },
      // Batch reads the whole meeting at once; live starts with the self-label
      // seed above and the driver appends each frozen chunk through the append
      // RPC as it posts it.
      transcript,
      participants: (template?.participants as unknown) ?? [],
      team_id: (template?.team_id as string | null) ?? null,
      project_id: (template?.project_id as string | null) ?? null,
      live_mode: isLive,
      // Explicit, not defaulted: the append RPC's first check is `ended_at is
      // not null or is_transcript_locked`, and either one refuses every write.
      ended_at: null,
      is_transcript_locked: false,
      recorded_at: now,
      started_at: now,
    })
    .select('id')
    .single()

  if (error || !data) {
    throw new Error(error?.message ?? 'Failed to clone trial capture')
  }
  const captureId = data.id as string

  const rows = ((participants ?? []) as TemplateParticipant[])
    // The self row is not copied — `seedEvalSelfParticipant` re-derives it for the
    // RUN STARTER below, whose member link is the one that matters. Copying the
    // template's would bind the trial to whoever authored the case.
    .filter((p) => !p.is_self)
    .map((p) => ({
      capture_id: captureId,
      member_id: null,
      contact_id: null,
      external_name: p.external_name,
      external_email: p.external_email,
      company: p.company,
      job_title: p.job_title,
      speaker_label: p.speaker_label,
      // The same CHECK-constraint mapping the template's own rows go through.
      // A template written before that mapping existed can still hold free text
      // here, so the clone re-maps rather than trusting what it copied.
      role: participantRoleColumn({ role: p.role ?? undefined, is_self: false }),
    }))

  if (rows.length > 0) {
    const { error: participantError } = await service
      .from('capture_participant')
      .insert(rows)
    if (participantError) {
      console.warn('[evals] trial participant copy failed:', participantError.message)
    }
  }

  // NOT swallowed, unlike the participant copy above. `seedEvalSelfParticipant`
  // throws deliberately (see its header) because a missing self row is not a
  // cosmetic gap: it can leave `currentMemberId` null, which skips the route's
  // whole auto-apply block and destroys the counterfactual, and it makes
  // `isMineExplicit` and self-binding behave like a call with no owner, so every
  // assignee-to-me proposal scores unlike a real meeting. A trial in that state
  // cannot produce a gradeable result, so it must fail as a HARNESS error — the
  // caller stores it `errored` with a code — rather than score a false failure.
  //
  // The LABEL (`selfLabel`, resolved above) is read off the TEMPLATE's own self
  // row rather than recomputed from the script. The template is what the case
  // author (or a later repair) actually committed to, so re-deriving here could
  // silently disagree with it — and a trial whose self voice differs from its
  // template's grades a different meeting. Only a row the template genuinely
  // bound is copied: a template self row left unlabeled (`self_binding` still
  // 'none') seeds the clone unlabeled too, exactly as it does today.
  const seeded = await seedEvalSelfParticipant(service, {
    workspaceId: args.workspaceId,
    captureId,
    userId: args.runStarterUserId,
    speakerLabel: selfLabel,
  })
  // The one non-throwing exit `seedEvalSelfParticipant` has is "no member row
  // for the run starter" — it returns false rather than raising. That is the
  // same unseeded state the paragraph above says must be fatal, so it is raised
  // here: without a self row every assignee-to-me expectation and every gate
  // check scores as a prompt regression that is really a harness gap.
  if (!seeded) {
    throw new Error(
      'eval self participant could not be seeded: the run starter has no member row in this workspace',
    )
  }

  const { error: conversationError } = await service
    .from('chat_conversations')
    .insert({
      user_id: args.runStarterUserId,
      workspace_id: args.workspaceId,
      capture_id: captureId,
      recipe_id: args.recipeId,
      title: `Eval: ${args.caseRow.name}`,
    })
  if (conversationError) {
    console.warn('[evals] trial conversation insert failed:', conversationError.message)
  }

  // The case's goal, as the person would have set it before the call. NOT
  // swallowed: a trial whose agent never saw the goal grades a different call
  // (judge_nudges reads timeliness against it), so a failed write is a HARNESS
  // error, the same posture as the self row above.
  const goal = args.caseRow.expected?.goal?.trim()
  if (goal) {
    const written = await upsertMeetingGoal(service, {
      workspaceId: args.workspaceId,
      userId: args.runStarterUserId,
      calendarEventId: trialGoalEventId(captureId),
      startsAt: now,
      goal,
      source: 'chat',
      captureId,
    })
    if (!written.ok) {
      throw new Error(`eval trial goal could not be written: ${written.message}`)
    }
  }

  // The length the live driver's first append must compare-and-swap against.
  // The append RPC refuses any base length that is not the server's own, so a
  // driver that assumed zero would fail every append on a seeded clone.
  return { captureId, transcriptLength: transcript.length }
}
