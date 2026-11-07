import { after } from 'next/server'
import type { MessageStreamEvent } from 'eve/client'
import { usageProviderLabel } from '@/lib/ai/models'
import { authenticateUser, logUsage } from '@/lib/ai/auth'
import { usageOnPlan } from '@/lib/chatgpt/plan-route'
import { PLAN_HELPER_MODEL, planModelSlug } from '@/lib/chatgpt/plan-models'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { loadAttachedPackages, buildPackageManifestBlock } from '@/lib/live-agent/package-context'
import { harvestWebSearchCost } from '@/lib/ai/tools/web-search'
import { applyChange, deleteAppliedEntity } from '@/lib/proposed-changes/apply-engine'
import {
  shouldRefuseAutoAccept,
  fetchRaceCandidates,
  markRaceDamped,
  appendAppliedToPool,
  RACE_DAMP_ENABLED,
} from '@/lib/proposed-changes/auto-accept-race-damp'
import { resolveTrustPolicyFromSettings } from '@/lib/proposed-changes/trust-policy'
import { decideAutoApply, gateModeForCapture } from '@/lib/proposed-changes/auto-apply-gate'
import { resolveWorkspaceEditionFromSettings } from '@/lib/editions'
import { fetchWorkspaceSettings } from '@/lib/workspace-settings'
import { ExtractionLedgerRecorder } from '@/lib/proposed-changes/extraction-ledger'
import { getServiceClient } from '@/lib/admin'
import {
  buildDirectivesBlock,
  consumeDirectives,
  expirePendingDirectives,
  loadPendingDirectives,
  turnWritesRecord,
} from '@/lib/live-agent/directives'
import {
  SELF_BINDING_GATE_ENABLED,
  resolveSelfBinding,
  assigneeResolvedViaSpeakerMap,
  type SelfBindingState,
} from '@/lib/live-agent/self-binding'
import { seedSelfParticipant } from '@/lib/crm/contacts'
import {
  serializeCaptureForPrompt,
  type Correction,
  type PendingProposal,
  type AppliedProposal,
} from '@/lib/live-agent/serialize-capture'
import { reconcileSummaryMarkers, type RealProposal } from '@/lib/live-agent/reconcile-markers'
import { emitCaptureProcessed } from '@/lib/flows/emit-capture-processed'
import { shouldAutoArchiveCapture } from '@/lib/live-agent/capture-groom'
import { needsMineCheck } from '@/lib/live-agent/mine-check'
import { syncProposalsCard } from '@/lib/live-agent/conversation-writer'
import { liveTurnTypeFromRequest } from '@/lib/live-agent/ceiling'
import { liveLookupsAllowed } from '@/lib/live-agent/mcp-lookups'
import { internalSecret, liveRecentTail, mintLiveAgentRunToken } from '@/lib/live-agent/live-agent-run-token'
import { selectRiderOmissions } from '@/lib/live-agent/riders'
import {
  LiveTurnAbandonedError,
  cancelLiveTurnSession,
  createLiveTurnSseTranslator,
  listPriceCostUsd,
  liveAgentEveClient,
  liveTurnCacheMetadata,
  liveTurnFailure,
  maxStepOutputTokens,
  readLiveTurn,
  startLiveTurnSession,
  toGenResult,
  withFailedAttemptUsage,
  type DeferredCreateCancel,
  type LiveTurnBudgetHit,
  type LiveTurnGen,
  type LiveTurnRead,
  type LiveTurnSseEvent,
} from '@/lib/live-agent/eve-turn'
import {
  LIVE_TURN_BUDGETS,
  RECORD_TURN_FAILED_NOTE,
  RETRY_MIN_DEADLINE_MS,
  liveTurnFailureCode,
  liveTurnKind,
  outputCharLimits,
  reducedRetryChunks,
  shouldRetryLiveTurn,
  tickHasNothingNew,
} from '@/lib/live-agent/turn-budget'
import { broadcastNudge } from '@/lib/live-agent/nudge-channel'
import { windowStartFromAge } from '@/lib/live-agent/time-guard'
import { createLiveTurnTiming } from '@/lib/live-agent/turn-timing'
import { buildLiveAgentProductFactsBlock } from '@/lib/live-agent/product-facts'
// The Block-2 context builders + the message composers live in a shared module
// so the eve live-agent spec rebuild composes the SAME context from the same
// code (a route file can't export helpers).
import {
  buildDynamicContext,
  loadLiveMcpContext,
  composeLiveAgentContextBlock,
  composeLiveAgentMessage,
  composeLiveAgentTranscriptBlock,
  resolveLiveAgentModel,
  resolveLiveAgentPersona,
} from '@/lib/live-agent/turn-composition'

// Live runs finish in a few seconds, but a batch run processes a whole meeting
// transcript in one call and needs more headroom. 600s gives long meetings room
// (Pro/Enterprise ceiling is 800s). The limit applies to both modes but doesn't
// slow live runs down — they return as soon as they're done.
export const maxDuration = 600

/**
 * POST /api/ai/live-agent
 *
 * Stateless live meeting agent. No conversation history is loaded or saved.
 * Each call receives recent transcript chunks and a corrections log from the
 * client (or, for a batch run, reads the whole transcript), and runs ONE eve
 * task session on the `live-agent` mount (LIVE-AGENT-DESIGN.md, WS-1):
 *
 *   System prompt — rebuilt by the mount from the run token this route mints
 *                   (GET /api/internal/live-agent/spec)
 *   Message       — Block 2, the serialized capture state + dynamic context
 *                   (changes slowly), then Block 3, the recent transcript
 *                   (always fresh); built here, from the request body
 *
 * The agent sees what it has extracted so far (via capture state) without
 * needing to re-read its own prior messages. DB writes happen only when tools
 * fire (propose_change, write_summary, update_summary — executed by POST
 * /api/internal/live-agent/tool) — not on every voice pause. Everything after
 * the model call (usage, auto-apply, summary reconciliation, the batch tail)
 * runs here, in finalize().
 */
export async function POST(req: Request) {
  const startTime = Date.now()

  try {
    const { user, supabase } = await authenticateUser(req)
    // Opted in to the ChatGPT free tier: a person on their own ChatGPT plan
    // runs the turn on it (the model below).
    const chatgptPlan = await usageOnPlan(user.id)

    const body = await req.json()
    const {
      capture_id,
      recent_chunks,
      corrections_log,
      recipe_id,
      mode = 'live',
      live_role = 'copilot',
      stream = false,
      prior_transcript,
      allow_auto_archive = false,
      record_only = false,
      window_age_ms,
      window_queued_age_ms,
    } = body as {
      capture_id: string
      recent_chunks?: string[]
      corrections_log?: Correction[]
      recipe_id?: string
      mode?: 'live' | 'batch'
      // LIVE mode only. 'copilot' (the default, and every older client) is the
      // turn the capture's live agent runs. 'notes' is the PAIRED NOTE-TAKER:
      // when the live agent is assist-only (it talks and writes nothing), the
      // client fires a second turn per window with this role, and the route
      // runs the BATCH persona on it — the edition's post-call agent, else the
      // built-in Assistant — with the talk tools withheld. Two agents, one
      // window: the copilot owns the user's ear, this one owns the record.
      // Ignored in batch mode.
      live_role?: 'copilot' | 'notes'
      // Set ONLY by the canonical end-of-meeting batch (recording-context
      // runApiBatchExtraction). Gates GEN-135 auto-archive so Reprocess and
      // every other batch caller can never archive a capture during recovery.
      allow_auto_archive?: boolean
      // LIVE mode only: the meeting-so-far, sent ONCE by the client on the first
      // turn after live was toggled ON mid-meeting. Without it the agent would see
      // only the ≤3 chunks captured after the toggle (the client's gate accumulated
      // nothing while live was OFF) and be blind to everything said before. It is
      // BACKGROUND CONTEXT ONLY — the agent must not re-extract from it. Ignored in
      // batch mode (batch already reads the whole captures.transcript server-side).
      prior_transcript?: string
      // When true, respond with an SSE stream (text deltas + tool activity +
      // a final `done` event carrying the same JSON payload as the non-stream
      // path). Opt-in so existing callers that await Response.json are untouched
      // until they migrate. The summary/proposals still land via the tools'
      // DB writes → Supabase Realtime (unchanged); the stream is a live preview
      // of the model working, layered on top.
      stream?: boolean
      // LIVE mode only (live-agent messaging L3): an out-of-cycle turn the
      // client runs the moment a directive lands, over the windows it already
      // sent. It exists only to record directives, so with none pending for
      // this turn it runs no model at all; with some, Block 3 says the
      // transcript is context, not new. Ignored in batch mode.
      record_only?: boolean
      // LIVE window turns only (optional): how long ago (ms, the client's own
      // clock, measured just before the fetch) its transcript gate flushed
      // the window this turn answers for (the NEWEST one when queued windows
      // were coalesced). An AGE, never a timestamp, so client clock skew
      // never meets the server clock: the route turns it into a server-clock
      // flush time (clamped to [0, 10 min], garbage ignored), which starts
      // the clock the tool route's time guard reads (time-guard.ts).
      window_age_ms?: unknown
      // LIVE window turns only (optional): the OLDEST coalesced window's age,
      // when it differs. Telemetry only (queue_wait_ms); never reaches the guard.
      window_queued_age_ms?: unknown
    }

    const isBatch = mode === 'batch'
    const recordOnly = !isBatch && record_only === true
    // The paired note-taker's live turn. It resolves its persona the way a
    // BATCH run does (it is the same writer, running early) and it never talks;
    // `writesRecord` is the predicate for "this turn writes the record", which
    // is what the persona safety net below actually guards.
    const notesRole = !isBatch && live_role === 'notes'
    const writesRecord = isBatch || notesRole

    // Live runs are driven by the silence gate and always carry recent_chunks.
    // Batch runs (end-of-meeting or "Reprocess") process the WHOLE transcript in
    // one call — the client doesn't send chunks; we read captures.transcript
    // server-side below. So only require recent_chunks for live mode.
    if (!capture_id || (!isBatch && !recent_chunks?.length)) {
      return Response.json(
        { error: 'capture_id and recent_chunks are required' },
        { status: 400 },
      )
    }

    const workspaceId = await getCurrentWorkspaceId()
    if (!workspaceId) {
      return Response.json({ error: 'No workspace' }, { status: 400 })
    }

    // ── Resolve "who am I" — the current user's member row in this workspace.
    // This is what lets the agent distinguish MY action items (staged as
    // actions, auto-applied when confident) from OTHER people's commitments
    // (recorded as claims). Best-effort: a null member just means the agent
    // treats nothing as "mine", preserving the old everyone-equal behavior.
    const { data: currentMember } = await supabase
      .from('member')
      .select('id, display_name')
      .eq('user_id', user.id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    const currentMemberId = (currentMember?.id as string | null) ?? null
    const currentMemberName =
      (currentMember?.display_name as string | null) ?? null

    // ── Fetch capture state + pending proposals + recently-applied items ──
    // These are lightweight queries — no large JSONB column involved. Applied
    // items are surfaced so the agent KNOWS what it auto-accepted and can still
    // edit/dismiss them (edit_proposal/dismiss_proposal reach through to the
    // real entity for applied rows).
    const [captureRes, proposalsRes, appliedRes] = await Promise.all([
      supabase
        .from('captures')
        .select('id, title, ai_summary, team_id, project_id, participants, user_id, package_ids, is_eval')
        .eq('id', capture_id)
        .eq('workspace_id', workspaceId)
        .single(),
      supabase
        .from('proposed_change')
        .select('id, change_type, entity_type, entity_id, display_text, title, description, reasoning, assignee_name, project_id, status_to')
        .eq('capture_id', capture_id)
        .eq('workspace_id', workspaceId)
        .eq('status', 'pending')
        .order('sort_order'),
      supabase
        .from('proposed_change')
        .select('id, change_type, entity_type, display_text, assignee_name, status_to')
        .eq('capture_id', capture_id)
        .eq('workspace_id', workspaceId)
        .eq('status', 'applied')
        .order('applied_at', { ascending: false })
        .limit(20),
    ])

    const capture = captureRes.data
    if (!capture) {
      return Response.json({ error: 'Capture not found' }, { status: 404 })
    }

    // ── Eval isolation (spec §5.1) ───────────────────────────────────────────
    // An EVAL capture is a synthetic mock meeting driven by an Evals run. The
    // engine is NOT forked — this route runs exactly as it would for a real
    // capture — but every WRITE that would escape the capture is fenced:
    //   * the auto-apply gate runs in 'report' mode (gateModeForCapture), so the
    //     full ruleset still executes and is still recorded in the extraction
    //     ledger, but nothing lands on the board (the counterfactual is the
    //     thing a trial grades);
    //   * record_commitment short-circuits before the claim dedupe/insert;
    //   * usage is logged with skipBilling (true cost stays in metadata and is
    //     mirrored onto the trial by the runner);
    //   * emitCaptureProcessed, auto-archive, and the batch summary safety net
    //     are all skipped, beside their existing demo guards;
    //   * web search is off (non-deterministic, and Exa spend is invisible under
    //     skipBilling) and the read surface omits private captures.
    const isEvalCapture = (capture as { is_eval?: boolean | null }).is_eval === true

    // Self-heal the capture OWNER's identity anchor (is_self participant row)
    // for captures created before self-identity shipped, and for any create
    // path that missed the seed. Idempotent (one indexed SELECT when already
    // seeded); best-effort — extraction must never fail over it.
    try {
      const ownerUserId = (capture as { user_id?: string | null }).user_id
      if (ownerUserId) {
        await seedSelfParticipant(workspaceId, capture_id, {
          id: ownerUserId,
          ...(ownerUserId === user.id ? { email: user.email ?? undefined } : {}),
        })
      }
    } catch (err) {
      console.warn('[live-agent] seedSelfParticipant failed:', err)
    }

    // ── Batch mode: resolve the full transcript (+ plan the pending reset) ──
    //
    // For a batch run (end-of-meeting or "Reprocess") the transcript IS the
    // input — there are no recent_chunks. We read it from the capture and feed
    // it as one block below. If there's nothing to process, no-op cleanly
    // rather than spending a model call.
    //
    // Reprocess semantics: REPLACE pending, KEEP accepted. Only status='pending'
    // proposals are deleted, so a re-run (possibly with a different agent /
    // meeting type) starts from a clean slate for un-triaged items, while
    // anything already applied/auto-accepted (or manually created) is preserved.
    // The delete itself waits for the eve session's first completed step (see
    // stalePendingIds below).
    let batchTranscript = ''
    let batchUserNotes = ''
    if (isBatch) {
      // Owner-only: a batch run DELETES the capture's pending proposals before
      // re-extracting. That's destructive, so — matching the capture DELETE
      // policy ("DELETE remains owner-only") — only the capture's owner may
      // trigger it, even though any workspace member can edit capture metadata.
      if ((capture as { user_id?: string | null }).user_id !== user.id) {
        return Response.json(
          { error: 'Only the capture owner can reprocess this meeting' },
          { status: 403 },
        )
      }

      // Transcript + the user's own hand-typed notes, fetched separately (not in
      // the main select) so live runs — which are frequent — never pull these
      // potentially-large text columns. user_notes is a READ-ONLY input here: the
      // agent weaves it into the summary and proposals but never writes back to
      // it (write_summary/update_summary only touch ai_summary), so the user's
      // original notes are enhanced, never overwritten.
      const { data: tx } = await supabase
        .from('captures')
        .select('transcript, user_notes, duration_seconds, metadata, ai_summary, title, started_at, ended_at')
        .eq('id', capture_id)
        .eq('workspace_id', workspaceId)
        .single()
      batchTranscript = (tx?.transcript || '').trim()
      batchUserNotes = (tx?.user_notes || '').trim()

      // Capture Groom (GEN-135): a very short capture with no transcript is a
      // mis-fire (a recording started + stopped, a permission glitch, a test).
      // Auto-archive it instead of leaving a blank capture cluttering the list.
      // Reversible — archive is a soft delete; the row and audio stay.
      //
      // Guardrails, all required (this is destructive-ish + captures have no
      // in-product unarchive yet):
      //   - allow_auto_archive: ONLY the canonical end-of-meeting batch opts in.
      //     Reprocess is a RECOVERY action and must never archive.
      //   - tx must exist: never archive on a transient read failure.
      //   - not a demo/seeded (onboarding) capture, and not an eval capture.
      //   - the predicate itself requires short (by duration OR wall-clock span)
      //     AND no transcript AND no summary AND no user notes AND no user title.
      const isDemo = (tx?.metadata as { demo?: boolean } | null)?.demo === true
      if (
        allow_auto_archive &&
        tx &&
        !isDemo &&
        // Eval captures are never groomed: an eval trial's capture is owned by
        // the run, and archiving it mid-trial would silently truncate the trace.
        !isEvalCapture &&
        shouldAutoArchiveCapture({
          durationSeconds: tx.duration_seconds,
          transcript: batchTranscript,
          aiSummary: tx.ai_summary,
          title: tx.title,
          userNotes: batchUserNotes,
          startedAt: tx.started_at as string | null,
          endedAt: tx.ended_at as string | null,
        })
      ) {
        await supabase
          .from('captures')
          .update({ status: 'archived' })
          .eq('id', capture_id)
          .eq('workspace_id', workspaceId)
        return Response.json({
          ok: true,
          skipped: 'auto_archived_junk',
          text: '',
          tool_calls: 0,
          auto_applied: 0,
          duration_ms: Date.now() - startTime,
        })
      }

      if (!batchTranscript) {
        return Response.json({
          ok: true,
          skipped: 'empty_transcript',
          text: '',
          tool_calls: 0,
          auto_applied: 0,
          duration_ms: Date.now() - startTime,
        })
      }

      // A batch run REPLACES the capture's pending proposals, and the eve
      // session refuses a caller with no member row in this workspace (the
      // spec route re-derives it) — so there is no point starting one. Refuse
      // here, before anything is dispatched. (A device-token caller who has
      // left the workspace is the only way to get here: RLS on the capture
      // read already requires membership under a user session.)
      if (!currentMemberId) {
        return Response.json(
          { error: 'You are no longer a member of this workspace' },
          { status: 403 },
        )
      }
    }

    // Reprocess semantics: REPLACE pending, KEEP accepted. The pending rows this
    // batch replaces are the ones read above — deleted BY ID, and only once the
    // eve session has completed its first model step (onTurnEvent below): every
    // way the session can fail closed before that (no internal secret, the spec
    // route's refusals, a spec-fetch timeout, a failed model resolution, a
    // failed create) leaves them untouched. By id, so the rows this run's own
    // propose_change calls create are never caught by the delete, whatever the
    // interleaving. The prompt already shows the model no pending rows.
    // Accepted race, narrower than before: a live-pause call still in flight for
    // this capture may stage a row after the read above; it now SURVIVES the
    // batch (the old status-wide delete wiped it) and sits beside the batch's
    // re-extraction for the user to triage. Reprocess is owner-triggered and
    // the end-of-meeting batch fires after recording stops, so overlap is rare.
    const stalePendingIds = isBatch
      ? ((proposalsRes.data ?? []) as Array<{ id: string }>).map((r) => r.id)
      : []

    // ── Resolve project name if grounded ──
    let projectName: string | null = null
    if (capture.project_id) {
      const { data: project } = await supabase
        .from('projects')
        .select('name')
        .eq('id', capture.project_id)
        .single()
      projectName = project?.name || null
    }

    // ── Build dynamic context (participants, speaker mappings, workflow states) ──
    const dynamicContext = await buildDynamicContext(
      supabase,
      capture,
      workspaceId,
      capture_id,
      currentMemberName,
      user.id,
      // A copilot turn speaks, so it also sees what it already told the user.
      { talks: !isBatch && !notesRole },
    )

    // ── Attached context packages ("+ Packages" chip, mig 239) — LIVE ONLY ──
    // Packages exist to guide the call in real time; the batch pass just
    // extracts what was said. PULL model: only a small MANIFEST rides in the
    // cached block (names/ids + the directive to fetch via get_package) —
    // package CONTENT never enters the prompt; the agent pulls what it needs
    // as tool-result data. Visibility is re-checked per id against the CALLER
    // here (mig 238 predicate) — the capture row's array is a pointer set,
    // never an ACL. get_package is promoted into the initial active tools
    // below whenever the manifest is non-empty, so the pull needs no
    // search_tools discovery round-trip.
    const packageBlock = isBatch
      ? null
      : buildPackageManifestBlock(
          await loadAttachedPackages(supabase, user.id, (capture.package_ids as string[] | null) ?? []),
        )

    // ── Serialize capture state ──
    //
    // In batch mode we process the whole transcript fresh: the pending
    // proposals are being replaced (so pass none), and we null out the prior
    // summary so the agent does a clean write_summary over the full transcript rather than
    // trying to surgically patch a summary built from partial/old context. The
    // already-applied proposals (kept) are still surfaced so the agent doesn't
    // re-create things that are confirmed.
    const captureState = serializeCaptureForPrompt(
      {
        title: capture.title,
        ai_summary: isBatch ? null : capture.ai_summary,
        project_id: capture.project_id,
        project_name: projectName,
        participants: capture.participants as Array<{ name?: string; email?: string }> | null,
      },
      isBatch ? [] : ((proposalsRes.data || []) as PendingProposal[]),
      corrections_log || [],
      (appliedRes.data || []) as AppliedProposal[],
    )

    // ONE read of workspace.settings for this turn, feeding all FOUR policies
    // that live as sibling keys on that jsonb blob. Each has its own fetching
    // resolver, but calling them here would be four serial round-trips for the
    // SAME row on a route that fires every ~3s during an active recording.
    // Hoisted above the persona block because the edition's DEFAULT AGENT is
    // resolved from this same blob — a fourth round-trip for a row already in
    // hand would be the exact cost this read exists to avoid.
    // fetchWorkspaceSettings is fail-open (null on any error) and every
    // normalizer maps null to its own pure default, so the degraded behavior is
    // identical to the individual resolvers' catch blocks.
    const workspaceSettings = await fetchWorkspaceSettings(supabase, workspaceId)

    // ── Resolve the live agent persona ──
    //
    // The route needs the persona for two things only now that the model call
    // runs on eve: `assistOnly` (the response's pair_notes) and the model the
    // usage row names. It resolves it with the SAME function, arguments and
    // fence as the eve spec route (live-agent-spec.ts), so the two can never
    // drift: explicit recipe → edition default (live vs batch mode; never for
    // an eval capture) → the assist-only safety net on every turn that writes
    // the record → the built-in ASSISTANT_PERSONA (see resolveLiveAgentPersona).
    //
    // explicitRecipeVisibleTo is load-bearing HERE too: for a desktop device
    // token authenticateUser hands back a SERVICE-ROLE client, so RLS does not
    // fence the caller-chosen recipe_id — without the predicate the route would
    // bill and pair_notes from a recipe the eve session (fenced) never runs.
    // Under a user session it is a no-op (it mirrors the RLS policy).
    const { recipe, assistOnly } = await resolveLiveAgentPersona({
      supabase,
      workspaceId,
      recipeId: recipe_id,
      isEvalCapture,
      writesRecord,
      workspaceSettings,
      explicitRecipeVisibleTo: { userId: user.id },
    })

    // ── Directives: what the user asked to go into the record (L1, mig 290) ──
    // Read only by a turn that WRITES the record (the batch pass, the paired
    // notes turn, a live turn whose agent is not assist-only), fenced on the
    // requester like the chat tail. finalize() marks exactly these ids
    // consumed when the turn completes. Empty → no block, so the message is
    // unchanged. An eval capture reads them too (L5): a trial's clone starts
    // with none, so the only ones it holds are what its eval driver injected,
    // and the engine under test must read them as it reads a user's.
    const directives =
      turnWritesRecord({ isBatch, notesRole, assistOnly })
        ? await loadPendingDirectives(supabase, { captureId: capture_id, workspaceId, userId: user.id })
        : []
    const directivesBlock = buildDirectivesBlock(directives)

    // A record-only turn with nothing to record (the directive was already
    // consumed by the turn in flight when it landed, or this turn type does not
    // write the record) costs nothing: no session, no usage row. pair_notes is
    // still answered, so a client that has not yet learned the pairing (an
    // assist-only copilot) runs its notes turn next.
    if (recordOnly && directives.length === 0) {
      return Response.json({ ok: true, skipped: 'no_directives', tool_calls: 0, pair_notes: assistOnly })
    }

    // The turn's kind and budget (turn-budget.ts): a window's tick, a person's
    // record turn, or the batch. Each caps its steps, its streamed output (per
    // step and per turn) and, live, its wall clock.
    const turnKind = liveTurnKind({ isBatch, recordOnly })
    const turnBudget = LIVE_TURN_BUDGETS[turnKind]
    // When the window this tick answers for was flushed (a tick only: a record
    // turn has no new window, and the batch has none at all).
    // Server clock only: the route's start minus the client-reported age.
    const windowFlushedAt = turnKind === 'tick' ? windowStartFromAge(window_age_ms, startTime) : undefined
    // The oldest coalesced window's flush (telemetry only: the worst wait).
    const windowQueuedSince = turnKind === 'tick' ? windowStartFromAge(window_queued_age_ms, startTime) : undefined

    // A tick whose newest window holds no real speech (the gate's 60 s timer
    // flushes a lone "yeah, okay" too) runs no model: no session, no usage row.
    // The client keeps the window in its sliding window, so the next turn still
    // reads it. pair_notes is answered, as for the record-only skip above.
    if (
      tickHasNothingNew({
        kind: turnKind,
        recentChunks: recent_chunks,
        directiveCount: directives.length,
        priorTranscript: prior_transcript,
      })
    ) {
      return Response.json({ ok: true, skipped: 'nothing_new', tool_calls: 0, pair_notes: assistOnly })
    }

    // The trust policy + the workspace EDITION's auto-createable entity set,
    // resolved ONCE per turn from the settings blob already in hand, for the
    // auto-apply gate in finalize() (the gate runs per proposal — resolving
    // there would be one DB read per candidate). The edition set fails open to
    // 'all' ⇒ no restriction, so full workspaces are unaffected.
    const trustPolicy = resolveTrustPolicyFromSettings(workspaceSettings)
    const editionAutoCreate =
      resolveWorkspaceEditionFromSettings(workspaceSettings).autoCreateEntities

    // Resolve model: the live agent's fixed model (auto model selection; a
    // recipe's old model is ignored). Resolved ONCE:
    // it is signed into the run token (the spec route serves it verbatim to
    // the session) AND names the usage row, so the model eve runs and the
    // model the turn is billed at are one value by construction.
    // On the person's own ChatGPT plan: the plan's lighter model
    // (`chatgpt-plan/<model>`), which the spec route serves as the plan and
    // the usage row logs at no cost.
    const selectedModel = chatgptPlan ? planModelSlug(PLAN_HELPER_MODEL) : await resolveLiveAgentModel(supabase, workspaceId, recipe)

    // ── The model call runs on eve (LIVE-AGENT-DESIGN §12 Steps 3–5) ──
    //
    // One TASK session per turn on the `live-agent` mount. Its system prompt,
    // tools and model are NOT built here: the mount's resolvers fetch them from
    // GET /api/internal/live-agent/spec, which rebuilds them from the run token
    // below with the same composition this route ran before (the 7-layer
    // prompt with the assist-only base swap + web/notes/batch riders, the
    // structural tool ceiling — assist-only and notes strips on the MAP — and
    // the recipe → workspace model chain; see src/lib/live-agent/
    // live-agent-spec.ts, turn-composition.ts, ceiling.ts). Every tool call is
    // executed by POST /api/internal/live-agent/tool, which re-derives the
    // ceiling from the token before it runs anything. This route owns only
    // what needs the request body — the MESSAGE — and everything after the
    // model call (finalize).
    //
    // The workspace's product doc (Phase 6), LIVE ONLY: from the settings blob
    // already in hand, so no pointer is no read, and a designated doc is one
    // cached read per 15 s (product-facts.ts). Read here, after both skips
    // above, so a skipped turn never reads it. A failed read renders nothing.
    const productFactsBlock = await buildLiveAgentProductFactsBlock(supabase, workspaceId, workspaceSettings, isBatch)

    // ── Connected external MCP servers: propose_mcp_call's catalog, plus a
    // copilot turn's READ-ONLY LOOKUPS (mcp-lookups.ts) from the same one read
    // (no network). Read after the persona, so an assist-only copilot, which
    // holds no propose_mcp_call, is never told to use it, and after both skips
    // above, so a skipped turn never reads it. A non-empty catalog is stamped
    // into the run token below: only then do the spec and tool routes re-read
    // the servers to re-derive it. Read with the service client, as those
    // routes read them, scoped to the session's own user id: a lookup turn
    // builds the person's GitHub server from their GitHub token, and the token
    // columns are the service role's alone (migration 466).
    const { block: externalMcpBlock, lookups: mcpLookups } = await loadLiveMcpContext(getServiceClient(), user.id, {
      assistOnly,
      lookups: liveLookupsAllowed({ turnType: liveTurnTypeFromRequest(mode, live_role), isEvalCapture }),
    })

    // The message: Block 2 (dynamic context + connected MCP servers + product
    // facts + package manifest + capture state with the corrections log) then
    // Block 3 (the fresh transcript window, or notes + the whole transcript for
    // a batch).
    const message = composeLiveAgentMessage(
      composeLiveAgentContextBlock({
        dynamicContext,
        directivesBlock,
        externalMcpBlock,
        productFactsBlock,
        packageBlock,
        captureState,
      }),
      isBatch
        ? composeLiveAgentTranscriptBlock({ isBatch: true, batchUserNotes, batchTranscript })
        : composeLiveAgentTranscriptBlock({
            isBatch: false,
            recentChunks: recent_chunks || [],
            priorTranscript: prior_transcript,
            ...(recordOnly ? { recordOnly: true } : {}),
          }),
    )
    // The message a reduced-context RETRY sends when the provider rejected or
    // failed the first attempt (turn-budget.ts shouldRetryLiveTurn): the
    // optional blocks (connected MCP servers, the package manifest, the
    // meeting-so-far prime) dropped, and a live window cut to the newest chunk's
    // tail. The directives and the capture state stay: they are what the turn
    // is for. So do the product facts: they are the rule that stops the agent
    // guessing a product fact, and a retry is no time to start guessing. A
    // batch keeps its transcript (it IS the input); only its optional blocks go.
    const reducedMessage = () =>
      composeLiveAgentMessage(
        composeLiveAgentContextBlock({
          dynamicContext,
          directivesBlock,
          externalMcpBlock: '',
          productFactsBlock,
          packageBlock: null,
          captureState,
        }),
        isBatch
          ? composeLiveAgentTranscriptBlock({ isBatch: true, batchUserNotes, batchTranscript })
          : composeLiveAgentTranscriptBlock({
              isBatch: false,
              recentChunks: reducedRetryChunks(recent_chunks || []),
              ...(recordOnly ? { recordOnly: true } : {}),
            }),
      )

    // A talking tick's window tail for the token's recentTail (a notes tick, the
    // record turn and the batch never speak, so they carry none).
    const recentTail = turnKind === 'tick' && !notesRole ? liveRecentTail(recent_chunks) : undefined

    // The prompt riders this turn does without (riders.ts), from values already
    // in hand (no read): the package manifest, the connected-MCP block, the turn
    // type and persona. Signed into the token so the spec rebuild composes the
    // same prompt; only ever removes a section, and an empty list is the full
    // prompt.
    const riderOmit = selectRiderOmissions({
      turnType: liveTurnTypeFromRequest(mode, live_role),
      assistOnly,
      hasPackages: packageBlock !== null,
      hasMcpBlock: externalMcpBlock !== '',
      builtInPersona: !recipe?.system_prompt,
    })

    // The per-turn run token: ONLY the durable facts the spec/tool routes
    // rebuild the turn from (§5.1) — never the corrections log or
    // prior_transcript, which ride the message above, and of the transcript
    // only recentTail, the window's newest ~600 characters for the tool
    // route's shadow nudge.worth check (never a prompt or ceiling input).
    // isEvalCapture is stamped here from the row this route read, so the model
    // can never influence it.
    //
    // currentMemberId may be null — this route has always run a turn with no
    // member row as "nothing is mine", and it still mints one rather than
    // refusing here. The internal routes then RE-DERIVE the member from
    // (user, workspace) and refuse a turn whose caller has no member row (a
    // deliberate WS-1 tightening: no service-role reads for a non-member). A
    // user-session caller can't reach this line without a member row (RLS on
    // the capture read above requires membership), so in practice that is a
    // device-token caller no longer in the workspace: the mount's model
    // resolver fails the session before any generation, nothing is billed, and
    // the route answers 500 (JSON) / an `error` event (stream).
    const runToken = mintLiveAgentRunToken({
      captureId: capture_id,
      workspaceId,
      userId: user.id,
      currentMemberId,
      turnType: liveTurnTypeFromRequest(mode, live_role),
      ...(recipe_id ? { recipeId: recipe_id } : {}),
      // The model the session runs IS the model the usage row names: signed
      // here, served verbatim by the spec route, never re-resolved mid-turn.
      model: selectedModel,
      isEvalCapture,
      allowAutoArchive: allow_auto_archive === true,
      // The tool route's time guard (time-guard.ts) reads these two: it runs
      // on ticks only, and measures the window's age from the flush time.
      turnKind,
      ...(windowFlushedAt !== undefined ? { windowFlushedAt } : {}),
      // Lookups exist for this turn: the spec and tool routes re-derive them.
      ...(mcpLookups.length > 0 ? { mcpLookups: true as const } : {}),
      // What was just said, for the tool route's shadow nudge.worth check
      // (nudge-worth-shadow.ts): a talking tick only, ~600 characters.
      ...(recentTail !== undefined ? { recentTail } : {}),
      // The riders the prompt does without (riders.ts); absent → the full prompt.
      ...(riderOmit.length > 0 ? { omit: riderOmit } : {}),
    })
    // mintLiveAgentRunToken throws when no secret is configured, so it is set.
    const client = liveAgentEveClient({
      runToken,
      workspaceId,
      userId: user.id,
      secret: internalSecret() as string,
    })
    const stepCeiling = turnBudget.maxSteps
    // What readLiveTurn enforces beside the step ceiling: the output budget in
    // streamed characters, and the deadline.
    const readBudget = { ...outputCharLimits(turnBudget), deadlineMs: turnBudget.deadlineMs }
    // How the turn went, for the usage row's metadata and the payload. Filled
    // in by the attempt loop below before finalize reads it.
    const turnFacts: {
      budgetHit?: LiveTurnBudgetHit
      retried?: boolean
      firstFailure?: string | null
      failedAttempt?: MessageStreamEvent[]
    } = {}
    // Per-turn timings (turn-timing.ts), fed every event both attempts stream
    // (onTurnEvent below). time_to_first_say_ms is measured from the route's
    // start; nudge_age_ms adds the newest window's wait before it.
    const timing = createLiveTurnTiming(startTime)

    // Resolved generation output (toGenResult over the turn's eve events). The
    // post-generation block below (usage logging, auto-apply, marker
    // reconciliation, response) reads ONLY from its fields, so it runs
    // identically in both response modes.
    type GenResult = LiveTurnGen

    // finalize: everything that must happen AFTER the model + all its tool
    // executions complete. Pure post-processing over a resolved GenResult; it
    // performs the usage log, batch safety-net, auto-apply, and marker
    // reconciliation, then returns the JSON payload both modes send (the stream
    // path wraps it in a final `done` event; the non-stream path returns it
    // directly). Defined as a closure so it captures the route-scoped vars
    // (supabase, capture_id, workspaceId, policy, etc.) without threading them.
    //
    // `aborted` (streaming only): true when the client disconnected mid-stream.
    // Usage is ALWAYS logged (the model already ran and was billed). But the
    // MUTATING side effects — auto-apply (creates entities / marks proposals
    // applied), batch safety-net write, and marker reconciliation — are SKIPPED:
    // applying changes for a request the user walked away from would silently
    // alter their workspace. The tools' own DB writes (proposals/summary staged
    // during generation) remain — those are recoverable/visible and the user can
    // Reprocess; what we must not do is auto-COMMIT on their behalf unprompted.
    const finalize = async (gen: GenResult, aborted = false) => {
      const result = gen

      // Exa spend visibility, same shape as the chat route. web_search is
      // provider-executed, so its cost rides on the tool RESULT
      // (output.costDollars.total) and never reaches providerMetadata — the
      // costUsd below is token spend only.
      const webSearchCost = harvestWebSearchCost(result.steps)

      // An EVAL row is logged with skipBilling (the RPC prices nothing), so its
      // real cost — what the trial's budget reads — is priced here: eve's own
      // cost when it is real (credits), else the list price of the tokens.
      const evalRealCostUsd = isEvalCapture
        ? (result.costUsd ??
          (await listPriceCostUsd(supabase, {
            provider: usageProviderLabel(selectedModel),
            model: selectedModel,
            inputTokens: result.usage.inputTokens ?? 0,
            outputTokens: result.usage.outputTokens ?? 0,
            cacheReadTokens: result.usage.cacheReadTokens,
            cacheWriteTokens: result.usage.cacheWriteTokens,
          })))
        : null

      // Where this turn's time went, read off the events it streamed.
      const timingSummary = timing.summary()
      const queueStart = windowQueuedSince ?? windowFlushedAt

      // What the usage row's metadata carries beside the eval fields: the
      // cached-token counts log_ai_usage prices a 'claude' row cache-aware from
      // (without them it prices every input token — ~90% of them cache reads
      // on a live turn — at full list price), Exa spend, and the Gateway
      // generation ids that join the row to /v1/report.
      const usageMetadata: Record<string, unknown> = {
        ...liveTurnCacheMetadata(result.usage),
        ...(webSearchCost !== null ? { webSearchCostUsd: webSearchCost } : {}),
        ...(result.generationIds.length ? { generationIds: result.generationIds } : {}),
        // What the next audit compares (turn-budget.ts): the turn's kind and
        // role, the steps it used, its largest step's output, the budget that
        // stopped it (if one did), and whether a failed first attempt was
        // retried (with that attempt's failure code).
        turn_kind: turnKind,
        live_role: isBatch ? null : notesRole ? 'notes' : 'copilot',
        steps: result.steps.length,
        max_step_output_tokens: result.maxStepOutputTokens,
        ...(turnFacts.budgetHit ? { budget_hit: turnFacts.budgetHit } : {}),
        ...(turnFacts.retried ? { retried: true, retry_reason: turnFacts.firstFailure ?? null } : {}),
        ...(aborted ? { aborted: true } : {}),
        // The prompt riders this turn did without (riders.ts), when any.
        ...(riderOmit.length > 0 ? { riders_omitted: riderOmit } : {}),
        // Where the time went (turn-timing.ts): how long the oldest window
        // waited before this route started (the client runs one pass at a
        // time, so a slow turn delays the next window), when the first nudge
        // ran, each tool's time from request to result, and what the time
        // guard cut. nudge_age_ms is the first delivered nudge's age against
        // the NEWEST window, the staleness the guard itself measures.
        ...(queueStart !== undefined ? { queue_wait_ms: Math.max(0, startTime - queueStart) } : {}),
        ...timingSummary,
        ...(windowFlushedAt !== undefined && timingSummary.time_to_first_say_ms !== undefined
          ? { nudge_age_ms: Math.max(0, startTime + timingSummary.time_to_first_say_ms - windowFlushedAt) }
          : {}),
      }

      // ── Log usage (ALWAYS — the model ran and was billed) ──
      await logUsage(user.id, {
      provider: usageProviderLabel(selectedModel),
      model: selectedModel,
      feature: 'live_agent',
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      durationMs: Date.now() - startTime,
      costUsd: result.costUsd,
      // Eval runs never bill the user's plan or wallet. skipBilling forces a
      // zero into the RPC while the row is still logged for visibility; the
      // REAL cost rides in metadata (same contract local_claude runs use) and
      // the Evals runner mirrors it onto eval_trial.cost_usd.
      ...(isEvalCapture ? { skipBilling: true } : {}),
      ...(Object.keys(usageMetadata).length || isEvalCapture
        ? {
            metadata: {
              ...usageMetadata,
              // captureId is the only per-trial discriminator: `ai_usage_logs`
              // carries no workspace_id, so without it one user with eval runs
              // in two workspaces has each trial summing the other's rows.
              ...(isEvalCapture
                ? { eval: true, realCostUsd: evalRealCostUsd, captureId: capture_id }
                : {}),
            },
          }
        : {}),
    })

    // ── Extract tool call summaries for the activity feed ──
    const toolCallSummaries = result.steps.flatMap((s) =>
      s.toolCalls.map((tc) => ({
        tool: tc.toolName,
        args: ('input' in tc ? tc.input : {}) as Record<string, unknown>,
      })),
    )

    // ── Batch safety net: never leave a stopped meeting blank ──
    //
    // The BATCH_SUMMARY_REQUIRED directive tells the model to always call
    // write_summary, but model compliance isn't guaranteed — on very short or
    // low-substance transcripts it sometimes still skips it, which leaves the
    // capture with no summary and reads to the user as "processing never ran".
    // For a batch run (the single end-of-meeting / Reprocess pass) we enforce the
    // invariant server-side: if no summary landed, write a minimal honest one
    // from the transcript we already have. Best-effort — a failure here just
    // leaves the capture as the model left it.
    // Skipped when aborted: a write for an abandoned request shouldn't fabricate
    // a summary the user never saw.
    // Eval captures are excluded: the safety net would fabricate a summary the
    // model never wrote, and `model_wrote_summary` is a graded check — a
    // server-authored fallback would score a silent prompt regression as a pass.
    if (!aborted && isBatch && !isEvalCapture) {
      try {
        const { data: postRun } = await supabase
          .from('captures')
          .select('ai_summary')
          .eq('id', capture_id)
          .eq('workspace_id', workspaceId)
          .single()
        const wroteSummary = (postRun?.ai_summary || '').trim().length > 0
        if (!wroteSummary) {
          // The model declined to summarize. Fall back to a truthful minimal
          // summary so the capture is never empty. We don't fabricate content —
          // we state plainly that the conversation was brief, and surface the
          // user's own notes if they took any (those are always worth keeping).
          const fallbackParts = ['## Summary', '']
          if (batchUserNotes) {
            fallbackParts.push(
              "A brief capture. The AI didn't find enough in the transcript to expand on, but here are your own notes:",
              '',
              batchUserNotes,
            )
          } else {
            fallbackParts.push(
              "A brief capture — there wasn't enough in the conversation to summarize. If you expected more, click Reprocess to try again.",
            )
          }
          const fallbackSummary = fallbackParts.join('\n')
          // We already confirmed the summary is empty via the SELECT above, and a
          // batch run has no concurrent summary writer: the end-of-meeting batch
          // fires only after stopRecording() awaits the trailing live call to
          // finish, and Reprocess only runs on an already-stopped capture. So a
          // plain update is safe here — no compare-and-swap needed. (This also
          // sidesteps PostgREST's fragile empty-string filter; the failing rows
          // are null or '' and both must be overwritten.)
          const { error: fallbackErr } = await supabase
            .from('captures')
            .update({ ai_summary: fallbackSummary })
            .eq('id', capture_id)
            .eq('workspace_id', workspaceId)
          if (fallbackErr) {
            console.warn(
              `Batch run: fallback summary write failed for ${capture_id}: ${fallbackErr.message}`,
            )
          }
        }
      } catch (err) {
        console.warn(
          `Batch run: summary safety-net check failed for ${capture_id}:`,
          err instanceof Error ? err.message : err,
        )
      }
    }

    // ── Auto-apply high-confidence suggestions in real time ──
    //
    // The agent has just staged proposals into proposed_change. The shared
    // auto-apply gate (One Accept Authority W-1, auto-apply-gate.ts) decides
    // which ones apply now, against the ONE workspace trust policy (W-2), so
    // accepted items appear live during the meeting. The gate's rules for the
    // extraction authority:
    //   * ACTIONS (create/assign/update) + PROJECT UPDATES ride the actions
    //     rule: per-class threshold; assignable items (action create/assign)
    //     additionally must be verified-MINE (speaker-map + self binding,
    //     computed below) or agent-delegated.
    //   * DECISIONS / MILESTONES: per-class threshold PLUS the D2 explicitness
    //     rule — only items the model marked explicitly stated ("we decided X")
    //     auto-apply; inferred leanings stay pending for review.
    //   * EXTERNALS (send_email, mcp_call): ALWAYS staged as drafts for an
    //     explicit click — never auto-fired (NORTH-STAR invariant 5). This is
    //     an intentional change from the old allow_external auto-fire.
    // Fully reversible (and still editable): applied items carry auto_accepted
    // and the agent can edit_proposal / dismiss_proposal them afterward. Best
    // effort — a failure here never breaks the live turn.
    const autoApplied: Array<{ id: string; entity_id?: string }> = []
    const autoApplyFailures: Array<{ id: string; code?: string; error?: string }> = []
    // Skipped when aborted: never auto-COMMIT proposals (create entities / mark
    // applied) for a request the user disconnected from. The staged pending
    // proposals remain for them to review or Reprocess.
    // W-3: the first-class extraction ledger — records what this pass applied AND
    // staged (verdict-shaped), flushed once after the loop so Activity reads a
    // recorded pass, not a (capture, hour) heuristic reconstruction.
    const ledger = new ExtractionLedgerRecorder()
    if (!aborted && currentMemberId && trustPolicy.enabled) {
      try {
        const { data: candidates } = await supabase
          .from('proposed_change')
          .select('*')
          .eq('capture_id', capture_id)
          .eq('workspace_id', workspaceId)
          .eq('status', 'pending')
          .order('sort_order')

        // E3 race damp: the recent-action pool, fetched ONCE.
        const raceNow = Date.now()
        const raceCandidates = RACE_DAMP_ENABLED
          ? await fetchRaceCandidates(supabase, workspaceId, raceNow)
          : []

        // Self-binding, resolved lazily on the first self-assigned candidate
        // (it may read the full transcript) and cached for the loop.
        let selfBindingPromise: Promise<SelfBindingState> | null = null
        const getSelfBinding = () =>
          (selfBindingPromise ??= resolveSelfBinding(supabase, capture_id, currentMemberId))

        for (const change of candidates || []) {
          const key = `${change.change_type}:${change.entity_type}`

          // Resolve the me-ownership signal the shared gate needs for ACTIONS.
          // Assignable items (create:action / assign:action) are user-scoped:
          // only auto-apply verified-mine items. A null assignee means "unowned".
          // Exception: items delegated to an AGENT auto-create so the agent can
          // be started from the capture (they're not "someone else's"). A
          // non-assignable action (e.g. an action UPDATE) has no ownership to
          // verify — it's me-explicit by default (matching today: only
          // create:action / assign:action were me-gated). This computation stays
          // in the caller (async self-binding read) — the gate is pure.
          let isMineExplicit = true
          // The person stays responsible beside a delegate agent (decision 9):
          // a named member assignee is still checked as "mine", agent or not
          // (mine-check.ts needsMineCheck).
          if (needsMineCheck(change as Parameters<typeof needsMineCheck>[0])) {
            if (change.assignee_member_id !== currentMemberId) {
              isMineExplicit = false
            } else if (SELF_BINDING_GATE_ENABLED) {
              // "Mine" must be a verified fact, not the model's inference:
              //   1. the assignee was resolved through the SPEAKER MAP (not a
              //      fuzzy name match the model echoed), AND
              //   2. this capture has an evidence-backed self voice binding.
              if (!assigneeResolvedViaSpeakerMap(change.extra)) isMineExplicit = false
              else {
                const binding = await getSelfBinding()
                if (!binding.bound) isMineExplicit = false
              }
            }
          }

          // The shared gate (W-1) makes the auto-apply DECISION: confidence floor,
          // per-entity thresholds, external guard, and the D2 explicitness rule
          // for decisions/milestones — one ruleset for extraction + verdict.
          const isExplicitlyStated =
            (change.extra as Record<string, unknown> | null)?.is_explicitly_stated === true
          const gateDecision = decideAutoApply(
            {
              change_type: change.change_type,
              entity_type: change.entity_type,
              confidence: (change.confidence as number | null) ?? null,
            },
            trustPolicy,
            {
              authority: 'extraction',
              // NEVER a literal — an eval capture runs the full gate in report
              // mode so the counterfactual is graded and nothing is applied.
              mode: gateModeForCapture(capture),
              isMineExplicit,
              isExplicitlyStated,
              allowedEntityTypes: editionAutoCreate,
            },
          )
          if (gateDecision === 'stage') {
            // The gate left it pending for the verdict run / the human. Record the
            // deliberate absence (W-3) — the surface the (capture, hour) heuristic
            // could never see.
            ledger.staged(change.id, 'gate staged — pending review')
            continue
          }

          // E3 race damp: near-dup of a just-created action ⇒ withhold the AUTO
          // apply (never drop). Proposal stays pending → a card the human/Triage
          // resolves. Marked for visibility/reversibility.
          if (RACE_DAMP_ENABLED) {
            const damp = shouldRefuseAutoAccept(
              { change_type: change.change_type, entity_type: change.entity_type, title: change.title, display_text: change.display_text },
              raceCandidates,
              raceNow,
            )
            if (damp.refuse) {
              await markRaceDamped(supabase, change, damp.matched_action_id, damp.note)
              ledger.staged(change.id, damp.note || 'near-duplicate — withheld from auto-apply')
              continue
            }
          }

          // applyChange only knows handlers for supported keys; unsupported
          // ones return an error and are skipped (stay pending).
          const applied = await applyChange(
            supabase,
            { ...change, auto_accepted: true },
            workspaceId,
            currentMemberId,
            user.id,
          )
          if (!applied.success) {
            // Surface actionable failure codes (e.g. an expired MCP token when
            // external auto-apply is enabled) so the client can prompt the user
            // to reconnect — instead of the failure vanishing silently.
            if (applied.code) {
              autoApplyFailures.push({ id: change.id, code: applied.code, error: applied.error })
            }
            continue
          }

          // Mark the proposal applied. The `.eq('status','pending')` guard makes
          // this a compare-and-swap: if a concurrent turn already flipped it (or
          // the update errors), `marked` is null. In EITHER case the entity we
          // just created is an orphan/duplicate — so for create:* proposals we
          // roll it back (clean slate; the winning turn already has its copy, or
          // the next turn re-applies cleanly). update/assign can't be undone (no
          // snapshot), so we only log.
          // applyChange may have normalized a targetless assign into a create —
          // the row's change_type must follow so undo/dismiss/rollback all agree
          // it created (rather than mutated) the entity.
          const effectiveChangeType = applied.applied_change_type ?? change.change_type
          const { data: marked, error: markErr } = await supabase
            .from('proposed_change')
            .update({
              status: 'applied',
              applied_at: new Date().toISOString(),
              applied_by: currentMemberId,
              result_entity_id: applied.entity_id || null,
              auto_accepted: true,
              // Clear any stale error_message from a prior failed attempt on this row.
              error_message: null,
              ...(applied.applied_change_type ? { change_type: applied.applied_change_type } : {}),
              ...(applied.applied_entity_type ? { entity_type: applied.applied_entity_type } : {}),
            })
            .eq('id', change.id)
            .eq('status', 'pending')
            .select('id')
            .maybeSingle()
          if (markErr || !marked) {
            if (effectiveChangeType === 'create' && applied.entity_id) {
              await deleteAppliedEntity(
                supabase,
                'create',
                change.entity_type as string,
                applied.entity_id,
                workspaceId,
              ).catch(() => {})
            }
            console.error(
              `Live agent auto-apply: ${key} for proposal ${change.id} not marked applied (${markErr?.message ?? 'already applied by a concurrent turn'}); created entity rolled back.`,
            )
            continue
          }
          // Feed the just-created action into the race pool so a later same-batch
          // identical create:action is caught (the within-batch race).
          if (RACE_DAMP_ENABLED && change.change_type === 'create' && change.entity_type === 'action') {
            appendAppliedToPool(raceCandidates, { entityId: applied.entity_id, title: change.title }, raceNow)
          }
          autoApplied.push({ id: change.id, entity_id: applied.entity_id })
          // W-3: record the applied item (verdict-shaped) after the CAS-mark
          // commits — the point where the apply is durable and won't roll back.
          ledger.applied(change.id, applied.entity_id, `auto-applied ${key}`)
        }
      } catch (e) {
        // Never let auto-apply break the live turn.
        console.error('Live agent auto-apply failed:', e)
      }
      // W-3: flush the extraction pass ledger once, best-effort. Service-role
      // write (extraction_pass is server-authored — RLS has no insert policy; the
      // request client runs as `authenticated` for real captures and would be
      // denied). workspaceId/capture_id are request-context-authenticated above
      // (workspace resolved server-side; capture fetched fenced to it). An empty
      // pass writes nothing. Never fails the live turn.
      await ledger.flush({
        workspaceId,
        captureId: capture_id,
        mode: isBatch ? 'batch' : 'live',
        // The pass's Activity row, owned by the member whose extraction ran
        // (currentMemberId is non-null inside this branch).
        work: { memberId: currentMemberId, captureTitle: (capture.title as string | null) ?? null },
      })
    }

    // ── Reconcile summary proposal markers with reality (batch only) ──────────
    //
    // The model embeds <!-- proposal:ID --> markers in the summary to anchor each
    // proposed change. In a batch run it processes the whole transcript in one
    // turn with many tool steps, and sometimes writes the summary with markers
    // whose IDs DON'T match the real DB-generated proposal ids (a predicted/stale
    // id, or a marker for a proposal it never actually staged). The UI drops a
    // marker that doesn't resolve — and if that marker was on its own bullet, the
    // bullet renders EMPTY. Conversely a real proposal with no marker never gets
    // anchored in the summary.
    //
    // Fix it deterministically: after extraction + auto-apply settle, rewrite the
    // summary so its markers exactly match the capture's real proposals — strip
    // markers that point at nothing, and append a "Next Steps" list of any real
    // proposals that the summary didn't already reference. Best-effort.
    // Skipped when aborted: don't rewrite the summary for an abandoned request.
    if (!aborted && isBatch) {
      try {
        const [{ data: sumRow }, { data: realProposals }] = await Promise.all([
          supabase
            .from('captures')
            .select('ai_summary')
            .eq('id', capture_id)
            .eq('workspace_id', workspaceId)
            .single(),
          supabase
            .from('proposed_change')
            .select('id, display_text')
            .eq('capture_id', capture_id)
            .eq('workspace_id', workspaceId)
            .in('status', ['pending', 'applied'])
            .order('sort_order'),
        ])

        const original = sumRow?.ai_summary || ''
        if (original) {
          const reconciled = reconcileSummaryMarkers(
            original,
            (realProposals || []) as RealProposal[],
          )
          if (reconciled !== original) {
            await supabase
              .from('captures')
              .update({ ai_summary: reconciled })
              .eq('id', capture_id)
              .eq('workspace_id', workspaceId)
          }
        }
      } catch (err) {
        console.warn(
          `Batch run: summary marker reconciliation failed for ${capture_id}:`,
          err instanceof Error ? err.message : err,
        )
      }
    }

    // ── Mark the batch run complete (idempotency marker for crash recovery) ──
    // After a successful batch run, stamp batch_processed_at so we (and any
    // future reconciler) can tell a live-mode-OFF capture has been processed.
    // Best-effort — the extraction already succeeded; a failed stamp shouldn't
    // fail the request. Skipped when aborted: an abandoned run isn't "complete",
    // so leaving it unstamped lets a later Reprocess re-run cleanly.
    if (!aborted && isBatch) {
      // ── Emit the capture_processed flow trigger (loop engine) ──
      // Before the stamp per DESIGN — the emit call is itself fire-and-forget
      // (emit-capture-processed.ts attaches its own catch). Demo captures
      // (onboarding fixture, metadata.demo) must not fire loops; metadata
      // isn't in the main capture select, so one cheap read here (batch runs
      // only — the live hot path never pays it). Best-effort: an emit-path
      // failure must not fail a request whose extraction already succeeded.
      try {
        const { data: metaRow } = await supabase
          .from('captures')
          .select('metadata')
          .eq('id', capture_id)
          .eq('workspace_id', workspaceId)
          .maybeSingle()
        const isDemo =
          (metaRow?.metadata as { demo?: unknown } | null)?.demo === true
        // Eval captures never fire loop flows either — a mock call must not
        // start real work.
        if (!isDemo && !isEvalCapture) {
          emitCaptureProcessed({
            workspaceId,
            captureId: capture_id,
            processedAt: new Date().toISOString(),
          })
        }
      } catch (e) {
        console.warn('Batch run: capture_processed emit failed:', e)
      }

      // Fire-and-forget: the extraction already succeeded, so a slow/failed
      // stamp must not gate (or, on a TCP stall, 504) the response.
      void supabase
        .from('captures')
        .update({ batch_processed_at: new Date().toISOString() })
        .eq('id', capture_id)
        .eq('workspace_id', workspaceId)
        .then(undefined, (e) =>
          console.warn('Batch run: failed to stamp batch_processed_at:', e),
        )
    }

    // Directives (L1): the turn completed, so the ones it read are recorded —
    // mark exactly those consumed (the chat's "Noted"). After the batch pass,
    // whatever is still pending expires: the meeting's record is written.
    // Skipped when aborted: a turn that did not complete leaves them pending
    // for the next one. Service-role (clients hold no write grant); never fails
    // the turn.
    if (!aborted && (directives.length > 0 || isBatch)) {
      try {
        const service = getServiceClient()
        if (directives.length > 0) {
          await consumeDirectives(service, {
            ids: directives.map((d) => d.id),
            captureId: capture_id,
            workspaceId,
            sessionId,
          })
        }
        if (isBatch) await expirePendingDirectives(service, { captureId: capture_id, workspaceId })
      } catch (e) {
        console.warn('Live agent: directive consumption failed:', e)
      }
    }

    // Reflect this capture's proposals into the meeting's chat conversation as a
    // single rolling card (live-agent → chat merge, WS-2a). Best-effort +
    // no-op without a conversation. Skipped when aborted (no committed state).
    if (!aborted) {
      await syncProposalsCard(supabase, capture_id).catch(() => {})
    }

    return {
      ok: true,
      text: result.text,
      tool_calls: toolCallSummaries.length,
      tool_call_details: toolCallSummaries,
      auto_applied: autoApplied.length,
      auto_applied_details: autoApplied,
      // LIVE only: did this turn run an ASSIST-ONLY copilot? Then the record
      // still needs a writer, and the client pairs a `live_role: 'notes'` turn
      // with every window (this one included). The route owns the rule — it is
      // the one place that has both the resolved persona and its config — so
      // the client never has to know which agent is assist-only.
      ...(isBatch ? {} : { pair_notes: assistOnly }),
      ...(autoApplyFailures.length ? { auto_apply_failures: autoApplyFailures } : {}),
      // Additive, every caller and every mode: how many tool steps this turn
      // burned and why the last one stopped. The Evals trace records both per
      // flush — `steps_used` at the ceiling (20 live / 50 batch) with a
      // 'tool-calls' finish is a TRUNCATED turn, which grades as `unknown`
      // rather than as a prompt regression. Harmless everywhere else.
      steps_used: result.steps.length,
      finish_reason: result.steps[result.steps.length - 1]?.finishReason ?? null,
      duration_ms: Date.now() - startTime,
      // Only when they happened, so an ordinary turn's payload is unchanged:
      // the budget that stopped the turn early (turn-budget.ts) — 'steps' is
      // the step ceiling the Evals trace already reads from steps_used — and a
      // retried first attempt.
      ...(turnFacts.budgetHit ? { budget_hit: turnFacts.budgetHit } : {}),
      ...(turnFacts.retried ? { retried: true } : {}),
      // say_to_user calls the time guard dropped as stale: requested (so in
      // tool_call_details) but never broadcast. The Evals nudge log counts
      // them as intentional, not missing.
      ...(timingSummary.stale_nudge_drops ? { stale_nudge_drops: timingSummary.stale_nudge_drops } : {}),
      // say_to_user calls a nudge.worth gate held (never broadcast either).
      // Always 0 while the check runs in shadow, so never present yet.
      ...(timingSummary.held_nudge_drops ? { held_nudge_drops: timingSummary.held_nudge_drops } : {}),
    }
    }

    // Every event of this turn's session, in arrival order — what toGenResult
    // and the failure paths read (a failed or abandoned read keeps what it saw).
    const observed: MessageStreamEvent[] = []
    // A turn in which no model step completed ran no generation we can account
    // for (the session failed or was abandoned before its first step): there is
    // no usage to log and nothing to finalize.
    const stepsRan = () => observed.some((e) => e.type === 'step.completed')
    let sessionId: string | null = null
    // Aborting our read never stops eve's durable server-side work; a turn we
    // abandon (client gone, wall clock) must be cancelled or it keeps calling
    // tools after we stopped listening. Best effort, bounded.
    const cancelSession = async () => {
      if (sessionId) await cancelLiveTurnSession(client, sessionId)
    }
    // The batch's stale pending rows (stalePendingIds) are deleted once the
    // session's FIRST model step has completed — never before: a session that
    // fails closed first (spec refusal / timeout, model resolution, create)
    // leaves them untouched. By id, so this run's own new proposals are never
    // caught. Best-effort, like the eager delete it replaces.
    let staleCleared: Promise<void> | null = null
    const onTurnEvent = (ev: MessageStreamEvent) => {
      observed.push(ev)
      timing.observe(ev)
      if (ev.type === 'step.completed' && !staleCleared && stalePendingIds.length) {
        staleCleared = (async () => {
          const { error: clearErr } = await supabase
            .from('proposed_change')
            .delete()
            .in('id', stalePendingIds)
            .eq('capture_id', capture_id)
            .eq('workspace_id', workspaceId)
            .eq('status', 'pending')
          if (clearErr) {
            console.warn(`Batch run: failed to clear pending proposals for ${capture_id}: ${clearErr.message}`)
          }
        })().catch((err) => {
          console.warn(`Batch run: failed to clear pending proposals for ${capture_id}:`, err)
        })
      }
    }
    // finalize exactly once, guaranteed, in both response modes. An `aborted`
    // finalize logs usage and skips every mutating side effect; a turn that ran
    // no step has nothing to log. Null when finalize threw (logged).
    let finalized = false
    const runFinalizeOnce = async (aborted: boolean) => {
      if (finalized) return null
      finalized = true
      // The batch's stale-pending delete (if it started) lands before
      // finalize's auto-apply / marker reconciliation read the proposals.
      await staleCleared
      const failedAttempt = turnFacts.failedAttempt ?? []
      if (aborted && !stepsRan() && !failedAttempt.some((e) => e.type === 'step.completed')) return null
      try {
        // At most `stepCeiling` steps, as the AI-SDK stopWhen reported them
        // (usage still counts a late step N+1 — see toGenResult), plus the
        // spend of a failed first attempt that was retried.
        return await finalize(
          withFailedAttemptUsage(toGenResult(observed, { maxSteps: stepCeiling }), failedAttempt),
          aborted,
        )
      } catch (e) {
        console.error('Live agent finalize failed:', e)
        return null
      }
    }
    // Wall clock under maxDuration: past it the function is killed, but the eve
    // session would run on with nobody to finalize it — so the route stops
    // reading first, cancels the session, and still logs what ran.
    const wall = new AbortController()
    const wallTimer = setTimeout(() => wall.abort(), (maxDuration - 30) * 1000)
    // A turn abandoned while its create POST is still pending past the grace
    // keeps that POST alive to the function's own deadline, so the session it
    // starts is cancelled whenever its id arrives (a cold mount can take longer
    // than the grace). The PROMISE form of after() goes straight to waitUntil,
    // which holds the invocation even when the response is already over (a
    // client disconnect). Outside a request scope (tests) the work just floats.
    const deferCreateCancel: DeferredCreateCancel = {
      run: (work) => {
        try {
          after(work)
        } catch {
          void work
        }
      },
      until: startTime + (maxDuration - 10) * 1000,
    }

    // ONE attempt: a task session for `msg`, read to its boundary under the
    // turn's budget, cancelled if eve has not reported it over (a boundary-less
    // end, a parked session, an abort, a budget cancel that never landed): a
    // turn left running keeps calling tools after we stopped listening.
    const runAttempt = async (
      msg: string,
      onEvent: (ev: MessageStreamEvent) => void,
      budget: typeof readBudget = readBudget,
    ): Promise<LiveTurnRead> => {
      // TRIPWIRE: never reuse this session across transcript windows or
      // introduce conversation-mode history here without explicitly setting
      // turnPolicy:'queue' — see design-session-per-recording.md §9.4 for the
      // steering-fold hazard this one-task-session-per-turn shape structurally
      // avoids today.
      const response = await startLiveTurnSession(client, { message: msg, signal: wall.signal, defer: deferCreateCancel })
      sessionId = response.sessionId
      const turn = await readLiveTurn(response, {
        stepCeiling,
        budget,
        cancel: () => response.cancel(),
        signal: wall.signal,
        onEvent,
      })
      if (!turn.terminal) await cancelSession()
      return turn
    }
    // The turn: one attempt, and ONE retry with reduced context when the
    // provider rejected or failed the model call before anything was written
    // (turn-budget.ts shouldRetryLiveTurn). The 2026-10-15 16:55 session died
    // on exactly that: a mid-stream invalid_request_error the provider marked
    // non-retryable, so eve failed the session and the window was lost.
    const runTurn = async (onEvent: (ev: MessageStreamEvent) => void): Promise<LiveTurnRead> => {
      const turnStartedAt = Date.now()
      let turn = await runAttempt(message, onEvent)
      if (turn.outcome === 'failed' && shouldRetryLiveTurn(observed)) {
        turnFacts.retried = true
        turnFacts.firstFailure = liveTurnFailureCode(observed)
        turnFacts.failedAttempt = observed.splice(0)
        console.warn(
          `[live-agent] ${turnKind} turn failed (${liveTurnFailure(turnFacts.failedAttempt)}); retrying once with reduced context`,
        )
        // The deadline covers the whole turn, retry included (the next window
        // is queued behind it), with a floor so the retry gets a real chance.
        const deadline = readBudget.deadlineMs
        const retryBudget = deadline
          ? { ...readBudget, deadlineMs: Math.max(RETRY_MIN_DEADLINE_MS, deadline - (Date.now() - turnStartedAt)) }
          : readBudget
        turn = await runAttempt(reducedMessage(), onEvent, retryBudget)
      }
      if (turn.outcome === 'ceiling' && turn.budgetHit) {
        turnFacts.budgetHit = turn.budgetHit
        if (turn.budgetHit !== 'steps') {
          console.warn(
            `[live-agent] ${turnKind} turn stopped at its ${turn.budgetHit} budget after ${turn.stepsCompleted} step(s), ${turn.outputChars} output chars, ${turn.reasoningChars} reasoning chars`,
          )
        }
      }
      return turn
    }
    // A turn that failed for good (after its retry, when it had one). The
    // meeting's agent lives on regardless: the client runs the next window as
    // usual. A person's own record turn tells them in the HUD, and its
    // directives stay pending, so the next record-writing turn picks them up.
    const reportFailure = async (turn: LiveTurnRead) => {
      if (turn.outcome === 'aborted') return
      console.error(`Live agent session ${turn.outcome}:`, liveTurnFailure(observed), {
        kind: turnKind,
        retried: turnFacts.retried === true,
        firstFailure: turnFacts.firstFailure ?? null,
      })
      if (turnKind === 'record' && !isEvalCapture) {
        await broadcastNudge({
          id: crypto.randomUUID(),
          message: RECORD_TURN_FAILED_NOTE,
          kind: 'reminder',
          captureId: capture_id,
          ts: Date.now(),
        }).catch(() => false)
      }
    }

    // ────────────────────────────────────────────────────────────────────────
    // Response mode A — NON-STREAMING (default; batch, Reprocess, evals, and any
    // caller that awaits Response.json). Run the turn to its boundary, then
    // finalize and return the SAME JSON payload as before.
    // ────────────────────────────────────────────────────────────────────────
    if (!stream) {
      try {
        const turn = await runTurn(onTurnEvent)
        if (turn.outcome === 'completed' || turn.outcome === 'ceiling') {
          const payload = await runFinalizeOnce(false)
          if (payload) return Response.json(payload)
        } else {
          await reportFailure(turn)
          // Usage is logged for whatever ran (an aborted finalize skips every
          // mutating side effect); the caller gets the same error as before.
          await runFinalizeOnce(true)
        }
        return Response.json({ error: 'Live agent processing failed' }, { status: 500 })
      } catch (err) {
        // The create POST failed (nothing ran — no usage), the wall clock fired
        // before it returned (startLiveTurnSession already cancelled the
        // session it started), or the stream broke mid-read: stop the session
        // and log what ran.
        await cancelSession()
        await runFinalizeOnce(true)
        throw err
      } finally {
        clearTimeout(wallTimer)
      }
    }

    // ────────────────────────────────────────────────────────────────────────
    // Response mode B — STREAMING (opt-in via `stream: true`). Server-Sent
    // Events: relay write_summary's text + tool activity live so the client can
    // show the AI "doing its thing", then run the SAME finalize() once the turn
    // settles, and emit a final `done` event carrying the identical JSON
    // payload. The summary/proposals still persist via the tools' DB writes →
    // Supabase Realtime (unchanged) — the streamed text is a live preview the
    // client types into the editor. The `done` payload is assembled from the
    // events observed in the loop, never by calling `.result()` on a response
    // that is being iterated.
    // ────────────────────────────────────────────────────────────────────────
    // When the client disconnects, the ReadableStream's cancel() fires: we set
    // `clientGone` and abort the read, cancel the eve session (no wasted
    // tokens), and run finalize() in "aborted" mode (accounting only, no
    // workspace mutations the user never consented to).
    let clientGone = false
    const encoder = new TextEncoder()

    type SSEEvent =
      | LiveTurnSseEvent
      | { type: 'done'; payload: Awaited<ReturnType<typeof finalize>> }
      | { type: 'error'; error: string }

    const sse = (e: SSEEvent) => encoder.encode(`data: ${JSON.stringify(e)}\n\n`)

    const streamBody = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (e: SSEEvent) => {
          try {
            controller.enqueue(sse(e))
          } catch {
            /* stream already closed (client gone) */
          }
        }
        const translate = createLiveTurnSseTranslator()
        try {
          const turn = await runTurn((ev) => {
            onTurnEvent(ev)
            for (const out of translate(ev)) send(out)
          })
          if (turn.outcome === 'completed' || turn.outcome === 'ceiling') {
            // The turn has settled: the model finished and every tool it called
            // has run. Post-process (auto-apply, marker reconciliation, usage
            // log) and emit the final payload.
            const payload = await runFinalizeOnce(clientGone)
            if (payload) send({ type: 'done', payload })
          } else {
            await reportFailure(turn)
            await runFinalizeOnce(true)
            if (!clientGone) send({ type: 'error', error: 'Live agent processing failed' })
          }
        } catch (err) {
          // The create POST failed, the client left before it returned
          // (startLiveTurnSession cancelled the session it started — a
          // disconnect during the mount's cold start is the common case, so it
          // is not logged as an error), or the stream broke mid-read. Still run
          // finalize (aborted) so whatever ran is logged; only surface an error
          // event if the client is still listening.
          if (!(err instanceof LiveTurnAbandonedError)) console.error('Live agent stream error:', err)
          await cancelSession()
          await runFinalizeOnce(true)
          if (!clientGone) send({ type: 'error', error: 'Live agent processing failed' })
        } finally {
          clearTimeout(wallTimer)
          // Belt-and-suspenders: if neither path above ran finalize (shouldn't
          // happen), this guarantees usage accounting still fires.
          await runFinalizeOnce(true)
          try { controller.close() } catch { /* already closed */ }
        }
      },
      // Fires when the client disconnects / aborts the fetch. Stop reading, and
      // mark the run abandoned so the session is cancelled and finalize() skips
      // the mutating side effects (auto-apply etc.) — usage is still logged.
      cancel() {
        clientGone = true
        wall.abort()
      },
    })

    return new Response(streamBody, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Disable proxy/CDN buffering (nginx, some Vercel edge paths) so events
        // reach the client as they're produced instead of being held back.
        'X-Accel-Buffering': 'no',
      },
    })
  } catch (error) {
    if (error instanceof Response) return error
    console.error('Live agent error:', error)
    return Response.json(
      { error: 'Live agent processing failed' },
      { status: 500 },
    )
  }
}
