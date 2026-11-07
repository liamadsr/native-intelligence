/**
 * Authoring an eval case: the template capture, its participants and
 * conversation, the frozen chunks, and the `eval_case` row (spec §3.4).
 *
 * WHY A REAL `captures` ROW: the live-agent route reads everything from that
 * row and its derived tables — pending proposals in `sort_order`, applied
 * proposals, participants, the summary, the chat tail, `live_mode`,
 * `user_notes`. Faking it would mean forking the engine, and an eval that runs
 * a fork measures the fork. Using the real row means the eval measures the real
 * engine (spec §3.3).
 *
 * The row this file writes is a TEMPLATE. Nothing ever runs against it —
 * `cloneTrialCapture` copies it per trial, because the route re-reads pending
 * proposals on every call and a second trial on the same capture would see the
 * first trial's proposals as prior context.
 *
 * THE ISOLATION CONTRACT, in one place because every field is load-bearing:
 *
 *   - `is_eval = true` is the first-class column every read predicate keys on.
 *   - `metadata.demo = true` alongside it is belt-and-braces: the demo flag
 *     already buys nine existing gates (capture-ingest, claim extraction,
 *     decision claims, proposal age-out, archive, the route's auto-archive and
 *     `emitCaptureProcessed` skips, the index reconciler), so a reader that
 *     forgets `is_eval` degrades to "already gated by demo" rather than
 *     "leaked into the knowledge graph".
 *   - `visibility = 'private'` hides the row from other members through the
 *     RLS that already exists, with no policy change.
 *   - participant rows carry NO `contact_id` and NO `member_id` — that, not a
 *     filter somewhere downstream, is what keeps a mock sales call off a real
 *     contact's CRM timeline. The one exception is the self row's MEMBER link,
 *     seeded by `seedEvalSelfParticipant`, which is what self-binding and
 *     `isMineExplicit` need to behave as they would for a real call. Even
 *     there `contact_id` stays NULL — migration 252's trigger refuses it, and
 *     the self contact is a real CRM row with a real timeline.
 *
 * Everything runs on the SERVICE client: the participant and conversation
 * writes span tables the caller's own role cannot always reach, and the caller
 * (a route or a chat tool) has already established workspace membership.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { seedEvalSelfParticipant } from './seed-self-participant'
import { freezeChunks } from './freeze-chunks'
import { CASE_FIELDS } from './queries'
import type {
  EvalCaseRow,
  EvalMode,
  EvalParticipant,
  EvalPolarity,
  ExpectedOutcomes,
  ScriptSegment,
} from './types'

/**
 * The stored transcript for a script: the same `[speaker]: text` lines the
 * gate's flushes carry, joined the way the driver appends them.
 *
 * A batch trial gets this text up front; a live trial starts EMPTY and
 * accumulates it chunk by chunk through the append RPC, so the agent never
 * sees the whole meeting on flush 1.
 */
export function scriptToTranscript(script: ScriptSegment[]): string {
  return script.map((s) => `[${s.speaker || 'unknown'}]: ${s.text}`).join('\n')
}

/**
 * The `capture_participant.role` CHECK constraint's allowed set.
 *
 * `EvalParticipant.role` is FREE TEXT — a case author (or a chat tool
 * synthesizing a case) writes 'prospect', 'champion', 'AE'. The COLUMN does not
 * accept those: `capture_participant_role_check` allows exactly these three, and
 * anything else fails the insert with a check violation. That failure was
 * swallowed by a `console.warn`, so a case would author with only its self row
 * and every trial cloned from it graded a one-person meeting.
 *
 * So the free text lives in the `captures.participants` JSONB — which the route
 * reads as display context and which has no constraint — and the TABLE row gets
 * this mapping instead. Nothing is lost: the jsonb is where the agent sees
 * 'prospect', and the column only ever fed the seat, not the semantics.
 */
const PARTICIPANT_ROLE_VALUES = ['organizer', 'attendee', 'observer'] as const

/** The column-safe role for one participant. `is_self` is the organizer; a role
 *  the constraint already accepts passes through; everything else is an
 *  attendee. */
export function participantRoleColumn(p: { role?: string; is_self?: boolean }): string {
  if (p.is_self) return 'organizer'
  const role = p.role?.toLowerCase()
  return (PARTICIPANT_ROLE_VALUES as readonly string[]).includes(role ?? '')
    ? (role as string)
    : 'attendee'
}

/** The label a real solo-desk capture's mic stream carries, and the only one
 *  `positionEvidenceHolds` will ever accept as the owner's voice. */
const POSITION_LABEL = 'local_1'

/**
 * The speaker label to bind the SELF participant to, or null to seed unlabeled.
 *
 * A case that names its own self participant is authoritative — that author
 * said which voice is theirs, and the label goes on the self row so the route's
 * speaker map can resolve it to the owner's member (see
 * `seedEvalSelfParticipant`'s header for the full chain).
 *
 * The FALLBACK is deliberately narrow. A script with no `is_self` participant
 * gets 'local_1' only when the script actually puts that voice on the MIC
 * stream — which is what makes it the owner's own microphone on a real
 * `desktop_dual` capture, and therefore the one label position evidence can
 * honestly claim. Anything else (a `local_1` heard on the system stream, a
 * script with no mic segments at all) seeds unlabeled, as before: guessing an
 * owner voice would grade ownership the script never established.
 */
export function selfSpeakerLabel(
  participants: EvalParticipant[],
  script: ScriptSegment[],
): string | null {
  const self = participants.find((p) => p.is_self)
  if (self) return self.speaker_label?.trim() || null
  const micLocal1 = script.some(
    (s) => s.stream === 'mic' && s.speaker?.trim() === POSITION_LABEL,
  )
  return micLocal1 ? POSITION_LABEL : null
}

/** The `captures.participants` jsonb shape the route falls back to when no
 *  `capture_participant` rows resolve (`route.ts` buildDynamicContext). This is
 *  where the AUTHORED role survives verbatim — see {@link participantRoleColumn}. */
function participantsJson(participants: EvalParticipant[]) {
  return participants.map((p) => ({
    name: p.display,
    role: p.role ?? (p.is_self ? 'organizer' : 'attendee'),
    speaker_label: p.speaker_label,
  }))
}

/**
 * Write the `capture_participant` rows for an eval capture.
 *
 * NO `contact_id`, NO `member_id`, NO `external_email` — a synthetic person
 * must not resolve to anybody real, and an email is exactly what
 * `seedCaptureParticipants` would use to find-or-create a CRM contact. The
 * speaker label IS set, unlike a real capture's: the script already knows who
 * said what, so voice identification has nothing to discover and the agent
 * should see the mapping the way it would mid-call after binding.
 *
 * The self participant is deliberately NOT inserted here —
 * `seedEvalSelfParticipant` owns that row (member link, `is_self`, the partial
 * unique index), and a hand-rolled duplicate would race it.
 */
async function insertParticipants(
  service: SupabaseClient,
  captureId: string,
  participants: EvalParticipant[],
): Promise<void> {
  const rows = participants
    .filter((p) => !p.is_self)
    .map((p) => ({
      capture_id: captureId,
      member_id: null,
      contact_id: null,
      external_name: p.display,
      external_email: null,
      speaker_label: p.speaker_label,
      // NOT `p.role`: the column's CHECK constraint would reject the author's
      // free text and the whole batch with it.
      role: participantRoleColumn(p),
    }))
  if (rows.length === 0) return

  const { error } = await service.from('capture_participant').insert(rows)
  if (error) {
    console.warn('[evals] participant insert failed:', error.message)
  }
}

/**
 * Provision the capture's `chat_conversations` row.
 *
 * WITHOUT IT EVERY `say_to_user` AND `ask_user` CALL NO-OPS: the conversation
 * writer resolves the conversation by `capture_id`, and nothing on the server
 * path creates one. A nudge that silently never lands would score as "the agent
 * stayed quiet", which is the exact opposite of what happened.
 *
 * Inserted directly rather than through `POST /api/account/chat-history/live`,
 * which also writes a greeting message into the thread the agent then reads.
 */
async function insertConversation(
  service: SupabaseClient,
  args: {
    captureId: string
    workspaceId: string
    userId: string
    recipeId: string | null
    title: string
  },
): Promise<void> {
  const { error } = await service.from('chat_conversations').insert({
    user_id: args.userId,
    workspace_id: args.workspaceId,
    capture_id: args.captureId,
    recipe_id: args.recipeId,
    title: args.title,
  })
  if (error) {
    console.warn('[evals] conversation insert failed:', error.message)
  }
}

/**
 * Insert the template eval capture for a case.
 *
 * Shared with {@link import('./clone-trial-capture').cloneTrialCapture} in
 * spirit but not in code: the template always carries the full transcript and
 * is never `live_mode`, because nothing runs against it.
 */
async function insertTemplateCapture(
  service: SupabaseClient,
  args: {
    workspaceId: string
    userId: string
    name: string
    script: ScriptSegment[]
    participants: EvalParticipant[]
  },
): Promise<{ id: string } | { error: string }> {
  const now = new Date().toISOString()
  const { data, error } = await service
    .from('captures')
    .insert({
      user_id: args.userId,
      workspace_id: args.workspaceId,
      title: args.name,
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
      transcript: scriptToTranscript(args.script),
      participants: participantsJson(args.participants),
      live_mode: false,
      recorded_at: now,
      started_at: now,
    })
    .select('id')
    .single()

  if (error || !data) {
    return { error: error?.message ?? 'Failed to create eval capture' }
  }
  return { id: data.id as string }
}

/**
 * Seed the self participant on the TEMPLATE capture.
 *
 * NOT best-effort, unlike the other participants: `seedEvalSelfParticipant`
 * throws on anything but a 23505 race precisely because a missing self row
 * changes what every trial grades. The template is the shape every trial is
 * cloned from, so a case that authored without one is a case whose every future
 * run mis-measures ownership — better to refuse the case than to ship a silently
 * broken one. A script with no self participant seeds nothing and is fine.
 */
async function seedSelf(
  service: SupabaseClient,
  workspaceId: string,
  captureId: string,
  participants: EvalParticipant[],
  userId: string,
  script: ScriptSegment[],
): Promise<void> {
  const self = participants.find((p) => p.is_self)
  if (!self) return
  await seedEvalSelfParticipant(service, {
    workspaceId,
    captureId,
    userId,
    speakerLabel: selfSpeakerLabel(participants, script),
  })
}

/**
 * Create a case: its template capture, participants, conversation, frozen
 * chunks and row.
 *
 * @throws when the capture itself could not be written (a case with no capture
 *         is not a case) or when the SELF participant could not be seeded (a
 *         template with no self row mis-grades ownership in every trial cloned
 *         from it — see {@link seedSelf}). Other participant and conversation
 *         failures are logged and survived: both are recoverable by re-authoring,
 *         and neither is worth losing an otherwise-good script over.
 */
export async function createEvalCase(
  service: SupabaseClient,
  args: {
    workspaceId: string
    userId: string
    suiteId: string
    name: string
    script: ScriptSegment[]
    participants: EvalParticipant[]
    expected: ExpectedOutcomes
    polarity?: EvalPolarity
    modes?: EvalMode[]
    /** The recorded capture this case replays (createEvalCaseFromCapture). */
    seededFromCaptureId?: string | null
  },
): Promise<EvalCaseRow> {
  const capture = await insertTemplateCapture(service, {
    workspaceId: args.workspaceId,
    userId: args.userId,
    name: args.name,
    script: args.script,
    participants: args.participants,
  })
  if ('error' in capture) throw new Error(capture.error)

  await insertParticipants(service, capture.id, args.participants)
  await seedSelf(
    service,
    args.workspaceId,
    capture.id,
    args.participants,
    args.userId,
    args.script,
  )
  await insertConversation(service, {
    captureId: capture.id,
    workspaceId: args.workspaceId,
    userId: args.userId,
    // The template's conversation carries no recipe: which agent is under test
    // is a property of the RUN, and every trial's own clone gets the run's
    // `recipe_id` on its own conversation row.
    recipeId: null,
    title: args.name,
  })

  const { data, error } = await service
    .from('eval_case')
    .insert({
      suite_id: args.suiteId,
      workspace_id: args.workspaceId,
      name: args.name,
      capture_id: capture.id,
      capture_is_eval: true,
      script: args.script,
      chunks: freezeChunks(args.script),
      expected: args.expected,
      modes: args.modes ?? ['batch', 'live'],
      polarity: args.polarity ?? 'positive',
      visibility: 'workspace',
      seeded_from_capture_id: args.seededFromCaptureId ?? null,
      created_by: args.userId,
    })
    .select(CASE_FIELDS)
    .single()

  if (error || !data) {
    throw new Error(error?.message ?? 'Failed to create eval case')
  }
  return data as unknown as EvalCaseRow
}

/**
 * Normalize a participant list before it is written.
 *
 * `participants`, when provided, is the FULL list — a replace, which is what
 * both tool schemas document and the only shape that can REMOVE a speaker. A
 * merge-by-label would make a Replace paste that drops a speaker impossible to
 * express: the dropped attendee would survive in the capture jsonb and the live
 * agent would still be shown someone the script never names. Keeping the client
 * whole is the client's job — the case editor's Append merges the pasted
 * speakers onto the list it loaded and sends the result.
 *
 * The one thing this does enforce: ONE self participant, never two. A later
 * `is_self` entry wins and every earlier one is demoted, rather than left to
 * race the partial unique index on the capture's self row.
 */
export function normalizeParticipants(incoming: EvalParticipant[]): EvalParticipant[] {
  const lastSelf = incoming.map((p) => !!p.is_self).lastIndexOf(true)
  return incoming.map((p, i) =>
    p.is_self && i !== lastSelf ? { ...p, is_self: false } : p,
  )
}

/**
 * The `captures.participants` jsonb read back as the authoring shape.
 *
 * The jsonb is written by {@link participantsJson}, so this is its inverse with
 * one gap: the jsonb carries no `is_self`, only the 'organizer' role the self
 * entry happens to get. Guessing from that would be wrong for a case whose
 * author labelled a non-self participant the organizer, so `selfLabel` is
 * passed in from the capture's actual self `capture_participant` row — the one
 * place that fact is authoritative. A jsonb row written before this shape
 * existed simply contributes nothing.
 *
 * The case editor reads its participants draft back through this, because
 * `participants` on a PATCH REPLACES the list wholesale: an editor that could
 * not see the current list could only ever send a partial one.
 */
export function participantsFromJson(raw: unknown, selfLabel: string | null): EvalParticipant[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map((p) => {
      const speaker_label = typeof p.speaker_label === 'string' ? p.speaker_label : ''
      return {
        speaker_label,
        display: typeof p.name === 'string' ? p.name : '',
        role: typeof p.role === 'string' ? p.role : undefined,
        ...(selfLabel && speaker_label.trim() === selfLabel ? { is_self: true } : {}),
      }
    })
    .filter((p) => p.speaker_label.length > 0)
}

/**
 * Refine a case in place.
 *
 * A script edit is not a field edit: it re-freezes the chunks (the boundaries
 * are derived, never authored) AND rewrites the template capture's transcript,
 * so a batch trial cloned tomorrow carries the words the case actually holds.
 * Forgetting either half is how a case silently grades a transcript nobody can
 * see any more.
 *
 * A participant edit is not a field edit either. `participants` REPLACES the
 * list wholesale (see {@link normalizeParticipants}) — that is the documented
 * contract on both tool schemas and the only way to remove a speaker — and the
 * SELF row is re-seeded from the result. Without the re-seed the self row keeps
 * whatever label it was authored with, so a case that gains or renames its self
 * speaker binds every later trial to a voice the script no longer contains, and
 * ownership grades wrong for the life of the case with nothing surfaced.
 */
export async function updateEvalCase(
  service: SupabaseClient,
  args: {
    caseId: string
    workspaceId: string
    name?: string
    script?: ScriptSegment[]
    expected?: ExpectedOutcomes
    participants?: EvalParticipant[]
    polarity?: EvalPolarity
    modes?: EvalMode[]
  },
): Promise<EvalCaseRow> {
  const { data: existing, error: readError } = await service
    .from('eval_case')
    .select('id, capture_id, script')
    .eq('id', args.caseId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()

  if (readError) throw new Error(readError.message)
  if (!existing) throw new Error('Eval case not found')

  const captureId = existing.capture_id as string
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (args.name !== undefined) patch.name = args.name
  if (args.expected !== undefined) patch.expected = args.expected
  if (args.polarity !== undefined) patch.polarity = args.polarity
  if (args.modes !== undefined) patch.modes = args.modes
  if (args.script !== undefined) {
    patch.script = args.script
    patch.chunks = freezeChunks(args.script)
  }

  // The template capture's `user_id` is who the self row's member link must
  // point at — the trigger permits a member link only when it matches the
  // capture's own owner. Read only when there is a participant list to write.
  let templateOwnerId: string | null = null
  if (args.participants !== undefined) {
    const { data: capture } = await service
      .from('captures')
      .select('user_id')
      .eq('id', captureId)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle<{ user_id: string | null }>()
    templateOwnerId = capture?.user_id ?? null
  }
  const nextParticipants =
    args.participants === undefined ? undefined : normalizeParticipants(args.participants)

  // Capture-side effects first: a case row that still describes the old script
  // is recoverable, a capture whose transcript no longer matches its case is
  // not obviously wrong from any screen.
  const capturePatch: Record<string, unknown> = {}
  if (args.name !== undefined) capturePatch.title = args.name
  if (args.script !== undefined) capturePatch.transcript = scriptToTranscript(args.script)
  if (nextParticipants !== undefined) {
    capturePatch.participants = participantsJson(nextParticipants)
  }
  if (Object.keys(capturePatch).length > 0) {
    const { error } = await service
      .from('captures')
      .update(capturePatch)
      .eq('id', captureId)
      .eq('workspace_id', args.workspaceId)
    if (error) console.warn('[evals] template capture update failed:', error.message)
  }

  if (nextParticipants !== undefined) {
    // Replace the non-self rows rather than diffing: the list is short, and a
    // diff would have to reason about speaker labels the script may have
    // renamed. The self row is not in this delete's scope —
    // `insertParticipants` never wrote it and `seedEvalSelfParticipant` owns it.
    const { error } = await service
      .from('capture_participant')
      .delete()
      .eq('capture_id', captureId)
      .eq('is_self', false)
    if (error) console.warn('[evals] participant replace failed:', error.message)
    await insertParticipants(service, captureId, nextParticipants)

    // The self row, re-derived from the new list. `createEvalCase` does this
    // at authoring time and an edit has to do it again, or the row keeps the
    // label it was born with: `cloneTrialCapture` reads the label off the
    // TEMPLATE, so a case that gains or renames its self speaker afterwards
    // binds every later trial to a voice the script no longer contains, and
    // ownership grades wrong with nothing surfaced.
    const effectiveScript = (args.script ?? (existing.script as ScriptSegment[] | null) ?? [])
    const label = selfSpeakerLabel(nextParticipants, effectiveScript)
    const wantsSelf = nextParticipants.some((p) => p.is_self)
    if (templateOwnerId && (wantsSelf || label)) {
      await seedEvalSelfParticipant(service, {
        workspaceId: args.workspaceId,
        captureId,
        userId: templateOwnerId,
        speakerLabel: label,
      })
    } else if (!wantsSelf && !label) {
      // The new list names no self voice at all. A stale self row would keep
      // claiming one, so it goes — the same state a case authored without a
      // self participant is in.
      const { error: selfDeleteError } = await service
        .from('capture_participant')
        .delete()
        .eq('capture_id', captureId)
        .eq('is_self', true)
      if (selfDeleteError) {
        console.warn('[evals] self participant clear failed:', selfDeleteError.message)
      }
    }
  }

  const { data, error } = await service
    .from('eval_case')
    .update(patch)
    .eq('id', args.caseId)
    .eq('workspace_id', args.workspaceId)
    .select(CASE_FIELDS)
    .single()

  if (error || !data) {
    throw new Error(error?.message ?? 'Failed to update eval case')
  }
  return data as unknown as EvalCaseRow
}
