/**
 * The trial drivers: batch, and live at `instant` (spec §4.3, §4.4).
 *
 * ===========================================================================
 * NOTHING ABOUT THE ENGINE IS FORKED
 * ===========================================================================
 * Both drivers call `POST /api/ai/live-agent` OVER HTTP, exactly as the desktop
 * client and the Reprocess button do. That is the whole premise of the feature:
 * an eval that calls a refactored copy of the extraction loop measures the copy.
 * The only route changes are the isolation branches (spec §5.1), which the route
 * derives itself from `captures.is_eval` — the driver passes no eval flag and
 * gets no special treatment.
 *
 * ===========================================================================
 * AUTHENTICATION — WHY A DEVICE TOKEN
 * ===========================================================================
 * The route authenticates through `authenticateUser` and resolves the workspace
 * through `getCurrentWorkspaceId`. A server-to-server call therefore needs a
 * bearer credential that (a) resolves to the RUN STARTER — batch mode 403s
 * unless the requester owns the capture, and `currentMemberId`, `isMineExplicit`
 * and self-binding must behave as they would for that person or the grading is
 * dishonest — and (b) is mintable server-side without a browser session.
 *
 * There are exactly two bearer paths in `src/lib/ai/auth.ts`: a Supabase access
 * JWT, and an opaque Native Intelligence DEVICE TOKEN (`nid_…`). We cannot mint a Supabase
 * JWT for another user without their password or a refresh token, so the device
 * token is the supported path — the same one the hardware capture device uses.
 * `resolveDeviceToken` hands `authenticateUser` the user and a service-role
 * client, which is precisely the shape the route's own comment says these
 * endpoints want.
 *
 * The workspace still has to be resolved. `getCurrentWorkspaceId` prefers the
 * `x-workspace-id` header over the cookie and then VERIFIES membership through
 * a `member` lookup — but note `resolveUser` in `src/lib/workspace.ts` returns
 * null for a device token (it is opaque, so no client can be bound to it), and
 * the cookie client has no session on a server-to-server call. That means the
 * header alone is not enough today. See "CHANGE NEEDED" at the bottom of this
 * file; until it lands the driver sends both the header and a Supabase session
 * when one is available, and a run whose workspace cannot be resolved fails
 * fast with `no_workspace` rather than silently grading an empty trial.
 *
 * The token is minted at RUN start with a short TTL and DELETED at run end
 * ({@link mintRunToken} / {@link revokeRunToken}), so a leaked trial log cannot
 * be replayed a day later.
 *
 * ===========================================================================
 * NUDGES: THE SUBSCRIPTION IS THE GROUND TRUTH
 * ===========================================================================
 * `say_to_user` writes its chat row AND broadcasts, under one id (the row's
 * ui_message_id is the broadcast's `id`). The broadcast is what the desktop
 * HUD shows, so it stays the ground truth (the chat write used to be
 * throttled to one per 20 s, which made the rows undercount; it no longer
 * is). The live driver subscribes to `agent-nudge:<captureId>` with the
 * service client for the whole trial and attributes each received nudge to the
 * flush that was in flight when it arrived.
 */
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/supabase/service'
import { generateDeviceToken } from '@/lib/device-tokens'
import { WORKSPACE_HEADER } from '@/lib/workspace'
import { NUDGE_EVENT, nudgeChannelName, type AgentNudge } from '@/lib/live-agent/nudge-channel'
import { decideAutoApply } from '@/lib/proposed-changes/auto-apply-gate'
import { resolveTrustPolicyFromSettings } from '@/lib/proposed-changes/trust-policy'
import { fetchWorkspaceSettings } from '@/lib/workspace-settings'
import { insertDirective } from '@/lib/live-agent/directives'
import { cloneTrialCapture } from './clone-trial-capture'
import { scriptToTranscript } from './create-case'
import type {
  EvalCaseRow,
  EvalMode,
  EvalSpeed,
  EvalTrace,
  ExpectedDirective,
  FlushRecord,
  TraceCommitment,
  TraceDirective,
  TraceNudge,
  TraceProposal,
  TraceToolCall,
  TraceUsage,
} from './types'
import { appUrl } from '@/lib/app-url'

/** Chunks of context the real client sends per live flush
 *  (`RECENT_CHUNKS_MAX` in `use-recording.ts`). Matching it is not cosmetic:
 *  the window size is part of the prompt under test. */
const RECENT_CHUNKS_MAX = 3

/** Step ceilings the route sets (src/lib/live-agent/turn-budget.ts
 *  LIVE_TURN_BUDGETS: a window's tick 8, the batch 50; pinned by
 *  eve-turn.test.ts). A flush that stopped at the ceiling with a tool-call
 *  finish measured the BUDGET, not the prompt, and the deterministic grader
 *  marks it. */
export const LIVE_STEP_CEILING = 8
export const BATCH_STEP_CEILING = 50

/** How long the live driver waits, after its last flush, for a nudge broadcast
 *  still in flight. A broadcast that lands after its flush returned is drained
 *  into the NEXT flush, and the last flush has no next: without this tail the
 *  final nudge was lost and graded as never sent. Waited only when the route
 *  reported more `say_to_user` calls than nudges received. */
export const NUDGE_TAIL_GRACE_MS = 500

/** How long a run token lives. Long enough for the slowest sweep, short enough
 *  that a leaked log is worthless tomorrow. */
const RUN_TOKEN_TTL_MS = 2 * 60 * 60 * 1000

/** The read tools whose calls land in `trace.reads` — "what real workspace data
 *  did the agent look at" (spec §5.3). Anything that is not a WRITE tool of the
 *  live agent is a read; enumerating the writes is the shorter and more stable
 *  list, since a read tool added to the allowlist next quarter should appear in
 *  the trace automatically. */
const LIVE_AGENT_WRITE_TOOLS = new Set([
  'propose_change',
  'edit_proposal',
  'dismiss_proposal',
  'write_summary',
  'update_summary',
  'say_to_user',
  'ask_user',
  'record_commitment',
  'propose_mcp_call',
  'search_tools',
])

/** The tool names that count as "the model wrote a summary". */
export const SUMMARY_TOOL_NAMES = ['write_summary', 'update_summary'] as const

/** Base URL for the internal HTTP call, the same resolution the task-push and
 *  hubspot lanes use. */
function appBaseUrl(): string {
  return appUrl()
}

/** A minted run token and the row id that has to be deleted afterwards. */
export interface RunToken {
  token: string
  tokenId: string
}

/**
 * Mint a short-lived device token acting as the run starter.
 *
 * `active_workspace_id` is pinned to the run's workspace so
 * `resolveDeviceToken` resolves it without falling back to the owner's oldest
 * workspace — a run starter who belongs to three workspaces must not have their
 * eval trials execute against the wrong one.
 */
export async function mintRunToken(
  service: SupabaseClient,
  args: { userId: string; workspaceId: string; runId: string },
): Promise<RunToken> {
  const { token, hash, displayPrefix } = generateDeviceToken()
  const { data, error } = await service
    .from('device_token')
    .insert({
      user_id: args.userId,
      active_workspace_id: args.workspaceId,
      name: `Eval run ${args.runId.slice(0, 8)}`,
      token_hash: hash,
      token_prefix: displayPrefix,
      expires_at: new Date(Date.now() + RUN_TOKEN_TTL_MS).toISOString(),
    })
    .select('id')
    .single<{ id: string }>()

  if (error || !data) {
    throw new Error(`Failed to mint eval run token: ${error?.message ?? 'no row'}`)
  }
  return { token, tokenId: data.id }
}

/** Delete the run token. Best-effort: the TTL is the backstop, so a failed
 *  delete degrades to "expires in two hours" rather than to a live credential. */
export async function revokeRunToken(
  service: SupabaseClient,
  tokenId: string,
): Promise<void> {
  const { error } = await service.from('device_token').delete().eq('id', tokenId)
  if (error) console.warn('[evals] run token revoke failed:', error.message)
}

/** What one POST to the route returned, narrowed to what a trace records. */
interface RouteResponse {
  ok?: boolean
  skipped?: string
  text?: string
  tool_calls?: number
  tool_call_details?: Array<{ tool: string; args?: unknown }>
  auto_applied?: number
  steps_used?: number
  finish_reason?: string | null
  /** Set when a turn budget (steps, output, deadline) stopped the turn early. */
  budget_hit?: string
  duration_ms?: number
  error?: string
  /** True when the recipe pairs a note-taker (its live agent is assist-only):
   *  the note-taker's turn writes the record. */
  pair_notes?: boolean
  /** say_to_user calls the route's time guard dropped as stale. */
  stale_nudge_drops?: number
  /** say_to_user calls a nudge.worth gate held (0 while it runs in shadow). */
  held_nudge_drops?: number
}

/** A non-2xx from the route, carrying the status so the lane can tell a usage
 *  wall (429/503 — a RUN-level failure, never a scored zero) from a bad
 *  request. */
export class LiveAgentHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'LiveAgentHttpError'
  }
}

/** One POST to the live-agent route, as a real client. */
async function postLiveAgent(
  token: string,
  workspaceId: string,
  body: Record<string, unknown>,
): Promise<{ response: RouteResponse; durationMs: number; startedAt: number }> {
  const startedAt = Date.now()
  const res = await fetch(`${appBaseUrl()}/api/ai/live-agent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      // getCurrentWorkspaceId prefers this header over the cookie — it is how
      // the desktop's multi-window client pins a workspace too.
      [WORKSPACE_HEADER]: workspaceId,
    },
    body: JSON.stringify(body),
  })
  const durationMs = Date.now() - startedAt

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new LiveAgentHttpError(res.status, text.slice(0, 500) || `HTTP ${res.status}`)
  }
  return { response: (await res.json()) as RouteResponse, durationMs, startedAt }
}

/** Tool calls from one route response, in trace shape. */
function toolCallsOf(response: RouteResponse): TraceToolCall[] {
  return (response.tool_call_details ?? []).map((c) => ({
    tool: c.tool,
    args: c.args ?? {},
  }))
}

/** A live subscription to one capture's nudge channel, draining into a buffer
 *  the driver reads per flush. */
interface NudgeCollector {
  /** Everything received since the last drain, then cleared. */
  drain(): TraceNudge[]
  close(): Promise<void>
}

/**
 * Subscribe to `agent-nudge:<captureId>` for the life of a trial.
 *
 * PRIVATE channel, service client — the same producer configuration
 * `broadcastNudge` uses, which is what lets it subscribe at all (the
 * `realtime.messages` policy admits workspace members; the service role
 * bypasses it).
 */
export async function collectNudges(
  service: SupabaseClient,
  captureId: string,
): Promise<NudgeCollector> {
  let buffer: TraceNudge[] = []
  const channel: RealtimeChannel = service.channel(nudgeChannelName(captureId), {
    config: { private: true },
  })

  channel.on('broadcast', { event: NUDGE_EVENT }, (payload) => {
    const nudge = payload.payload as AgentNudge | undefined
    if (!nudge) return
    buffer.push({
      id: nudge.id,
      kind: nudge.kind,
      message: nudge.message,
      ts: nudge.ts,
    })
  })

  await new Promise<void>((resolve) => {
    // Resolve on SUBSCRIBED, but never hang the trial on a Realtime hiccup: a
    // missed subscription costs the nudges dimension, while a hang costs the
    // whole run. The nudge checks read `unknown` when nothing arrived.
    const timer = setTimeout(resolve, 4000)
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        clearTimeout(timer)
        resolve()
      }
    })
  })

  return {
    drain() {
      const out = buffer
      buffer = []
      return out
    },
    async close() {
      await service.removeChannel(channel).catch(() => {})
    },
  }
}

/** The trial's own read-back of everything the run produced. */
interface ReadBack {
  proposals: TraceProposal[]
  summary: string | null
  title: string | null
}

/**
 * Read back what a trial's capture ended up holding, and compute the
 * counterfactual on every proposal.
 *
 * TWO HALVES, TWO SOURCES — and the split is what makes `gate_recorded`
 * falsifiable rather than vacuous.
 *
 * `decision` — DID the route's auto-apply block run for this proposal? That
 * answer cannot be re-derived here; only the route knows. It records it: the
 * `ExtractionLedgerRecorder` flushes one `extraction_pass` row per pass whose
 * `ledger.entries[]` carries a `{proposal_id, outcome}` per proposal it saw
 * (`outcome: 'carded'` for everything report mode stages). So a proposal whose
 * id is in the ledger gets a `gate`; a proposal missing from it gets NONE, and
 * `gradeGateRecorded` fails loudly. That is the whole isolation canary: if the
 * block is skipped entirely — a null `currentMemberId`, a disabled trust policy,
 * an exception before the loop — no `extraction_pass` row exists at all, every
 * proposal is missing its gate, and the trial fails instead of quietly reporting
 * a clean result for a run that measured nothing. Stamping `gate` on every row
 * unconditionally would reproduce exactly the vacuous-truth defect this check
 * replaced.
 *
 * `would_have_applied` — the COUNTERFACTUAL, which the ledger genuinely cannot
 * carry: report mode is the gate's FIRST branch (`if (ctx.mode !== 'act') return
 * 'stage'`), so every eval entry is recorded as staged with the same reason. The
 * gradeable signal — "this proposal would have auto-applied at 0.91", the
 * highest-cost failure a prompt edit can introduce — only exists if we re-run the
 * same pure gate in `act` mode over the same proposal and the same workspace
 * trust policy. That is computed locally, below.
 */
async function readBackCapture(
  service: SupabaseClient,
  args: { captureId: string; workspaceId: string },
): Promise<ReadBack> {
  const [captureRes, proposalRes, passRes, settings] = await Promise.all([
    service
      .from('captures')
      .select('ai_summary, title')
      .eq('id', args.captureId)
      .maybeSingle<{ ai_summary: string | null; title: string | null }>(),
    service
      .from('proposed_change')
      .select(
        'id, entity_type, change_type, title, display_text, confidence, status, assignee_name, assignee_member_id, extra',
      )
      .eq('capture_id', args.captureId)
      .eq('workspace_id', args.workspaceId)
      .order('sort_order'),
    // The route's OWN record of which proposals its auto-apply block decided
    // on. Every pass of the loop flushes one row; a skipped block flushes none.
    service
      .from('extraction_pass')
      .select('ledger')
      .eq('capture_id', args.captureId)
      .eq('workspace_id', args.workspaceId),
    fetchWorkspaceSettings(service, args.workspaceId).catch(() => null),
  ])

  const trustPolicy = resolveTrustPolicyFromSettings(settings)

  // The proposal ids the route actually gated, across every pass of this trial
  // (live mode flushes one row per turn). An id absent from this set means the
  // gate never saw it — the canary the `gate_recorded` check exists to fire on.
  type PassRow = { ledger: { entries?: Array<{ proposal_id?: string | null }> } | null }
  const gatedIds = new Set<string>()
  for (const row of (passRes.data ?? []) as PassRow[]) {
    for (const entry of row.ledger?.entries ?? []) {
      if (entry.proposal_id) gatedIds.add(entry.proposal_id)
    }
  }

  type ProposalRow = {
    id: string
    entity_type: string
    change_type: string
    title: string | null
    display_text: string | null
    confidence: number | null
    status: string
    assignee_name: string | null
    extra: Record<string, unknown> | null
  }

  const proposals: TraceProposal[] = ((proposalRes.data ?? []) as ProposalRow[]).map((row) => {
    // The same inputs the route computes, minus the two it derives from async
    // reads (speaker-map resolution and the self-voice binding). Both of those
    // can only make a proposal LESS likely to apply, so the counterfactual is
    // an upper bound — "this could have landed on the board" — which is the
    // direction a safety signal should err in.
    const wouldApply =
      decideAutoApply(
        {
          change_type: row.change_type,
          entity_type: row.entity_type,
          confidence: row.confidence,
        },
        trustPolicy,
        {
          authority: 'extraction',
          mode: 'act',
          isMineExplicit: true,
          isExplicitlyStated: row.extra?.is_explicitly_stated === true,
        },
      ) === 'apply'

    return {
      id: row.id,
      entity_type: row.entity_type,
      change_type: row.change_type,
      title: row.title,
      display_text: row.display_text ?? '',
      confidence: row.confidence,
      status: row.status,
      assignee_name: row.assignee_name,
      // Present ONLY when the route recorded a decision for this proposal. No
      // ledger entry ⇒ no gate ⇒ `gate_recorded` fails, which is the point.
      ...(gatedIds.has(row.id)
        ? { gate: { decision: 'stage', would_have_applied: wouldApply } }
        : {}),
    }
  })

  return {
    proposals,
    summary: captureRes.data?.ai_summary ?? null,
    title: captureRes.data?.title ?? null,
  }
}

/**
 * The trial's usage, from the `ai_usage_logs` rows this capture's calls wrote.
 *
 * Not from the route response: the route does not return token counts. It
 * DOES log them, with `skipBilling` so `cost_usd` on the row is a forced zero
 * and the REAL cost rides in `metadata.realCostUsd` (spec §5.1). That is the
 * number a trial mirrors — a run whose reported spend was always $0 could never
 * enforce a budget.
 */
async function readBackUsage(
  service: SupabaseClient,
  args: { userId: string; since: string; model: string; captureId: string },
): Promise<TraceUsage> {
  const { data } = await service
    .from('ai_usage_logs')
    .select('input_tokens, output_tokens, model, metadata')
    .eq('user_id', args.userId)
    .eq('feature', 'live_agent')
    .gte('created_at', args.since)
    .order('created_at', { ascending: false })
    .limit(50)

  type UsageRow = {
    input_tokens: number | null
    output_tokens: number | null
    model: string | null
    metadata: { eval?: boolean; realCostUsd?: number | null; captureId?: string | null } | null
  }

  let tokensIn = 0
  let tokensOut = 0
  let costUsd = 0
  let model = args.model
  for (const row of (data ?? []) as UsageRow[]) {
    // Only rows this run's own calls wrote. `metadata.eval` is stamped by the
    // route for eval captures and nothing else sets it, so a concurrent REAL
    // meeting by the same user in the same window cannot contaminate the trial's
    // cost.
    if (row.metadata?.eval !== true) continue
    // A concurrent EVAL run can, though: `ai_usage_logs` has no workspace_id,
    // the lane's concurrency key is the workspace, and the run token's identity
    // is a plain user id — so one user with runs in two workspaces has both
    // trials summing each other's rows, and the inflated total is what the
    // `max_cost_usd` ceiling and the monthly cap then read. The capture id is
    // the only discriminator that is unique per trial. The live-agent route now
    // always stamps it alongside `eval: true`; the null-safe fallback stays for
    // rows written before that landed, and drops no spend for them.
    if (row.metadata.captureId != null && row.metadata.captureId !== args.captureId) continue
    tokensIn += row.input_tokens ?? 0
    tokensOut += row.output_tokens ?? 0
    costUsd += Number(row.metadata?.realCostUsd ?? 0)
    if (row.model) model = row.model
  }

  return {
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_usd: Math.round(costUsd * 1_000_000) / 1_000_000,
    model,
  }
}

/**
 * `record_commitment` calls, lifted out of the flush log. No `claim` row exists
 * for an eval capture (the tool short-circuits), so the CALL is the gradeable
 * signal — "did the agent detect the commitment" lives nowhere else.
 *
 * THE KEYS ARE THE TOOL'S INPUT SCHEMA, not its return value. The route records
 * `args` as `('input' in tc ? tc.input : {})`, and `record_commitment`'s input is
 * `{person_name, commitment, trigger_quote, confidence}` (`live-agent/tools.ts`).
 * The eval short-circuit RETURNS a `{text, subject}` shape, but that is the
 * model's view of the result and never reaches the trace — reading those keys
 * here yields `undefined` on every call, and a prompt that stopped detecting
 * commitments would produce a trace identical to one that detected them all.
 */
function commitmentsOf(flushes: FlushRecord[]): TraceCommitment[] {
  const out: TraceCommitment[] = []
  for (const flush of flushes) {
    for (const call of flush.response.tool_call_details) {
      if (call.tool !== 'record_commitment') continue
      const args = (call.args ?? {}) as {
        person_name?: string
        commitment?: string
        trigger_quote?: string | null
        confidence?: number
      }
      out.push({
        text: args.commitment ?? '',
        ...(args.person_name !== undefined ? { subject: args.person_name } : {}),
        ...(args.trigger_quote ? { trigger_quote: args.trigger_quote } : {}),
        ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
      })
    }
  }
  return out
}

/** Every read-tool call across the trial (spec §5.3). */
function readsOf(flushes: FlushRecord[]): TraceToolCall[] {
  const out: TraceToolCall[] = []
  for (const flush of flushes) {
    for (const call of flush.response.tool_call_details) {
      if (LIVE_AGENT_WRITE_TOOLS.has(call.tool)) continue
      out.push(call)
    }
  }
  return out
}

/** True when any flush wrote a summary. `summary_source` distinguishes "the
 *  model summarized badly" from "the model never summarized", which must not
 *  score the same (spec §6.4). */
function summarySourceOf(flushes: FlushRecord[]): 'model' | 'none' {
  const wrote = flushes.some((f) =>
    f.response.tool_call_details.some((c) =>
      (SUMMARY_TOOL_NAMES as readonly string[]).includes(c.tool),
    ),
  )
  return wrote ? 'model' : 'none'
}

/** What a driver hands back. `errorCode` set ⇒ the trial is a HARNESS failure
 *  and must be stored as `errored`, never scored as a zero. */
export interface TrialResult {
  captureId: string
  trace: EvalTrace
  durationMs: number
  errorCode?: string
  errorMessage?: string
}

/** A directive the driver wrote, before its read-back. */
interface InjectedDirective {
  key: string
  id: string
  text: string
  afterChunk: number | null
}

/**
 * Write a case's directives onto the trial's capture (live-agent messaging L5)
 * through the writer the chat's `@notes` uses, as the run starter, so the
 * route reads them exactly as it reads a user's. A directive that cannot be
 * written is a HARNESS failure: the trial would grade a meeting in which the
 * user never asked, so the caller errors it rather than scoring a miss.
 */
async function injectDirectives(
  service: SupabaseClient,
  args: {
    captureId: string
    workspaceId: string
    userId: string
    directives: ExpectedDirective[]
    afterChunk: number | null
  },
): Promise<{ ok: true; injected: InjectedDirective[] } | { ok: false; message: string }> {
  const injected: InjectedDirective[] = []
  for (const directive of args.directives) {
    const result = await insertDirective(service, {
      captureId: args.captureId,
      workspaceId: args.workspaceId,
      userId: args.userId,
      source: 'user',
      text: directive.text,
    })
    if (!result.ok) {
      return { ok: false, message: `Directive "${directive.key}" could not be written: ${result.message}` }
    }
    injected.push({
      key: directive.key,
      id: result.directive.id,
      text: result.directive.text,
      afterChunk: args.afterChunk,
    })
  }
  return { ok: true, injected }
}

/** The injected directives as the trial left them. A failed read leaves each
 *  status null (unknown), never a guessed `pending`. */
async function readBackDirectives(
  service: SupabaseClient,
  args: { captureId: string; injected: InjectedDirective[] },
): Promise<TraceDirective[]> {
  if (args.injected.length === 0) return []
  const { data, error } = await service
    .from('live_directive')
    .select('id, status, consumed_session')
    .eq('capture_id', args.captureId)
    .in(
      'id',
      args.injected.map((d) => d.id),
    )
  if (error) console.warn('[evals] directive read-back failed:', error.message)
  type Row = { id: string; status: TraceDirective['status']; consumed_session: string | null }
  const rows = new Map(((data ?? []) as Row[]).map((row) => [row.id, row]))
  return args.injected.map((d) => {
    const row = rows.get(d.id)
    return {
      key: d.key,
      id: d.id,
      text: d.text,
      after_chunk: d.afterChunk,
      status: row?.status ?? null,
      consumed_session: row?.consumed_session ?? null,
    }
  })
}

/** Arguments both drivers share. */
export interface RunTrialArgs {
  caseRow: EvalCaseRow
  workspaceId: string
  runStarterUserId: string
  recipeId: string | null
  token: string
  /** Denormalized run model, used only as the usage fallback label. */
  targetModel?: string | null
}

/**
 * BATCH: clone with the full transcript, one POST, read back.
 *
 * A `skipped` response (`auto_archived_junk` / `empty_transcript`) is a HARNESS
 * failure, not a zero — the prompt never ran. Grading it as a failed trial would
 * make a mis-authored case look like a prompt regression in the compare view,
 * which is the one distinction the compare view exists to preserve.
 */
export async function runBatchTrial(
  service: SupabaseClient,
  args: RunTrialArgs,
): Promise<TrialResult> {
  const startedAt = Date.now()
  const since = new Date().toISOString()

  const { captureId } = await cloneTrialCapture(service, {
    caseRow: args.caseRow,
    runStarterUserId: args.runStarterUserId,
    workspaceId: args.workspaceId,
    mode: 'batch',
    recipeId: args.recipeId,
  })

  const emptyTrace = (): EvalTrace => ({
    mode: 'batch',
    speed: 'instant',
    driver: 'server',
    flushes: [],
    proposals_final: [],
    summary_final: null,
    summary_source: 'none',
    title_final: null,
    commitments: [],
    reads: [],
    usage: { tokens_in: 0, tokens_out: 0, cost_usd: 0, model: args.targetModel ?? '' },
  })

  // Directives (L5): a batch pass is one turn, so every directive the case
  // injects is pending when it runs, whatever its after_chunk.
  const directives = args.caseRow.expected?.directives ?? []
  let injected: InjectedDirective[] = []
  if (directives.length > 0) {
    const written = await injectDirectives(service, {
      captureId,
      workspaceId: args.workspaceId,
      userId: args.runStarterUserId,
      directives,
      afterChunk: null,
    })
    if (!written.ok) {
      return {
        captureId,
        trace: emptyTrace(),
        durationMs: Date.now() - startedAt,
        errorCode: 'directive_not_injected',
        errorMessage: written.message,
      }
    }
    injected = written.injected
  }

  let response: RouteResponse
  let durationMs: number
  try {
    ;({ response, durationMs } = await postLiveAgent(args.token, args.workspaceId, {
      capture_id: captureId,
      mode: 'batch',
      recipe_id: args.recipeId ?? undefined,
      stream: false,
      // Never true: an eval trial must not archive its own capture mid-run.
      allow_auto_archive: false,
    }))
  } catch (err) {
    // An HTTP failure propagates — the lane distinguishes a 429/503 usage wall
    // (a RUN-level failure) from a per-trial error, and only it has that context.
    if (err instanceof LiveAgentHttpError) throw err
    return {
      captureId,
      trace: emptyTrace(),
      durationMs: Date.now() - startedAt,
      errorCode: 'route_unreachable',
      errorMessage: err instanceof Error ? err.message : String(err),
    }
  }

  if (response.skipped) {
    return {
      captureId,
      trace: emptyTrace(),
      durationMs: Date.now() - startedAt,
      errorCode: response.skipped,
      errorMessage: `The route skipped this capture: ${response.skipped}`,
    }
  }

  // The transcript the route actually processed. Batch does not flush windows —
  // the route reads the clone's `transcript` column server-side — so the ONE
  // flush record has to carry it, or the trace claims the agent saw nothing.
  // The judges reconstruct their transcript from exactly this field, and an
  // empty one made judge_summary and judge_proposal_quality return `unknown`
  // with "no transcript was provided" on every batch trial.
  const transcript = scriptToTranscript(args.caseRow.script)

  const flush: FlushRecord = {
    index: 0,
    t_ms: 0,
    chars: transcript.length,
    chunk_text: transcript,
    response: {
      tool_calls: response.tool_calls ?? 0,
      tool_call_details: toolCallsOf(response),
      duration_ms: response.duration_ms ?? durationMs,
    },
    ...(response.steps_used !== undefined ? { steps_used: response.steps_used } : {}),
    ...(response.finish_reason ? { finish_reason: response.finish_reason } : {}),
    ...(response.budget_hit ? { budget_hit: response.budget_hit } : {}),
    nudges: [],
  }

  const [readBack, usage, directivesFinal] = await Promise.all([
    readBackCapture(service, { captureId, workspaceId: args.workspaceId }),
    readBackUsage(service, {
      userId: args.runStarterUserId,
      since,
      model: args.targetModel ?? '',
      captureId,
    }),
    readBackDirectives(service, { captureId, injected }),
  ])

  return {
    captureId,
    durationMs: Date.now() - startedAt,
    trace: {
      mode: 'batch',
      speed: 'instant',
      driver: 'server',
      flushes: [flush],
      proposals_final: readBack.proposals,
      summary_final: readBack.summary,
      summary_source: summarySourceOf([flush]),
      title_final: readBack.title,
      commitments: commitmentsOf([flush]),
      reads: readsOf([flush]),
      usage,
      ...(directives.length > 0 ? { directives: directivesFinal } : {}),
    },
  }
}

/** Sleep between chunks. `instant` never waits; the other two speeds are the
 *  client driver's (P1) and are honoured here so a server-driven `fast` run is
 *  possible without a second implementation. */
async function waitBetweenChunks(ms: number, speed: EvalSpeed): Promise<void> {
  if (speed === 'instant' || ms <= 0) return
  const factor = speed === 'fast' ? 10 : 1
  await new Promise((resolve) => setTimeout(resolve, ms / factor))
}

/**
 * Answer a pending `ask_user` from the case's `expected.answers`.
 *
 * Writes the SAME mutation the app's answer route performs — flipping only the
 * targeted tool part to `output-available` — through the service client, since
 * the driver has no browser session. An unanswered question is fatal to the
 * trial: the one-pending-question guard refuses every later question, and the
 * pending part changes every later flush's prompt state, so the remaining
 * chunks would grade a different agent than the one the case describes.
 *
 * @returns 'answered' | 'none' | 'unanswered'
 */
async function answerPendingQuestion(
  service: SupabaseClient,
  args: { captureId: string; answers: Record<string, string> },
): Promise<'answered' | 'none' | 'unanswered'> {
  const { data: conversation } = await service
    .from('chat_conversations')
    .select('id')
    .eq('capture_id', args.captureId)
    .maybeSingle<{ id: string }>()
  if (!conversation) return 'none'

  const { data: rows } = await service
    .from('chat_messages')
    .select('id, ui_message')
    .eq('conversation_id', conversation.id)
    .eq('role', 'assistant')
    .filter('ui_message->metadata->>kind', 'eq', 'ask_user')
    .order('created_at', { ascending: false })
    .limit(5)

  type Part = {
    type?: string
    state?: string
    toolCallId?: string
    input?: { questions?: Array<{ question?: string }> }
  }

  for (const row of (rows ?? []) as Array<{ id: string; ui_message: { parts?: Part[] } }>) {
    const parts = row.ui_message?.parts
    if (!Array.isArray(parts)) continue
    const idx = parts.findIndex(
      (p) => p.type === 'tool-ask_user' && p.state === 'input-available',
    )
    if (idx === -1) continue

    const question = parts[idx].input?.questions?.[0]?.question ?? ''
    // Match an answer key case-insensitively as a substring of the question,
    // so a case author writes `{"which_project": "…"}` rather than having to
    // reproduce the model's exact phrasing (which is the thing under test).
    const haystack = question.toLowerCase()
    const key = Object.keys(args.answers).find((k) =>
      haystack.includes(k.toLowerCase().replace(/_/g, ' ')) || haystack.includes(k.toLowerCase()),
    )
    // A single-entry answers map is unambiguous: use it for whatever was asked.
    const answer =
      (key ? args.answers[key] : undefined) ??
      (Object.keys(args.answers).length === 1 ? Object.values(args.answers)[0] : undefined)
    if (answer === undefined) return 'unanswered'

    const nextParts = parts.map((p, i) =>
      i === idx ? { ...p, state: 'output-available', output: { answers: [answer] } } : p,
    )
    const { error } = await service
      .from('chat_messages')
      .update({ ui_message: { ...row.ui_message, parts: nextParts } })
      .eq('id', row.id)
    if (error) return 'unanswered'
    return 'answered'
  }
  return 'none'
}

/**
 * LIVE: clone empty, then walk the frozen chunks posting each one.
 *
 * The order inside the loop is deliberate and is the part that silently breaks
 * if reordered: POST FIRST, then append. The route serializes capture state and
 * reads `recent_chunks` as the fresh block; appending before the call would
 * put the current chunk in BOTH the transcript the tools can read and the
 * window, which is not what a real meeting looks like (the client appends after
 * the gate flushes, not before).
 */
export async function runLiveInstantTrial(
  service: SupabaseClient,
  args: RunTrialArgs & { speed?: EvalSpeed },
): Promise<TrialResult> {
  const startedAt = Date.now()
  const since = new Date().toISOString()
  const speed: EvalSpeed = args.speed ?? 'instant'

  const { captureId, transcriptLength: seededLength } = await cloneTrialCapture(service, {
    caseRow: args.caseRow,
    runStarterUserId: args.runStarterUserId,
    workspaceId: args.workspaceId,
    mode: 'live',
    recipeId: args.recipeId,
  })

  const nudges = await collectNudges(service, captureId)
  const flushes: FlushRecord[] = []
  const chunks = args.caseRow.chunks ?? []
  const answers = args.caseRow.expected?.answers ?? {}
  let errorCode: string | undefined
  let errorMessage: string | undefined
  // The append RPC's compare-and-swap needs the caller's view of the server
  // transcript length. We own this capture exclusively, so tracking it locally
  // is exact — and a mismatch means something else wrote to the trial's
  // capture, which is a real bug worth surfacing rather than papering over.
  //
  // Starts at the clone's SEEDED length, not zero: a live clone carries the self
  // speaker's label line so position evidence holds on flush 1, and a base
  // length of zero would make the RPC refuse every append on such a capture.
  let transcriptLength = seededLength

  // Directives (L5): where each one lands. -1 is before the first chunk (the
  // first window carries it); an after_chunk past the end lands after the last.
  const directives = args.caseRow.expected?.directives ?? []
  const lastChunk = chunks.length - 1
  const landsAt = (d: ExpectedDirective) =>
    d.after_chunk === undefined ? -1 : Math.min(d.after_chunk, lastChunk)
  const injected: InjectedDirective[] = []
  // Learned from the route's `pair_notes`, as the client learns it: the record
  // turn then goes to the note-taker.
  let paired = false

  try {
    const early = directives.filter((d) => landsAt(d) === -1)
    if (early.length > 0) {
      const written = await injectDirectives(service, {
        captureId,
        workspaceId: args.workspaceId,
        userId: args.runStarterUserId,
        directives: early,
        afterChunk: null,
      })
      if (written.ok) injected.push(...written.injected)
      else {
        errorCode = 'directive_not_injected'
        errorMessage = written.message
      }
    }

    for (let i = 0; i < chunks.length && !errorCode; i++) {
      const chunk = chunks[i]
      const previous = i > 0 ? chunks[i - 1] : null
      await waitBetweenChunks(chunk.t_ms_start - (previous?.t_ms_end ?? 0), speed)

      const window = chunks
        .slice(Math.max(0, i - (RECENT_CHUNKS_MAX - 1)), i + 1)
        .map((c) => c.text)

      let response: RouteResponse
      let durationMs: number
      let sentAt: number
      try {
        // The window is "flushed" the moment the driver sends it (age 0), as
        // the client reports its gate's flush. At `instant` the windows go
        // back to back, so a zero age (not the script clock) makes the time
        // guard measure the turn's own duration, exactly as it does live, and
        // never refuse because of replay pacing. The send time is recorded as
        // the flush's started_at_ms for the latency grader.
        sentAt = Date.now()
        ;({ response, durationMs } = await postLiveAgent(args.token, args.workspaceId, {
          capture_id: captureId,
          mode: 'live',
          recent_chunks: window,
          recipe_id: args.recipeId ?? undefined,
          stream: false,
          window_age_ms: 0,
        }))
      } catch (err) {
        if (err instanceof LiveAgentHttpError) throw err
        errorCode = 'route_unreachable'
        errorMessage = err instanceof Error ? err.message : String(err)
        break
      }

      // Append AFTER the call — see the function doc. The seed line the clone
      // wrote already ends in a newline, so the first chunk joins bare.
      const append = transcriptLength === 0 ? chunk.text : `\n${chunk.text}`
      const { data: appendResult } = await service.rpc('append_capture_transcript', {
        p_capture_id: captureId,
        p_workspace_id: args.workspaceId,
        p_append: append,
        p_base_length: transcriptLength,
      })
      const appendRow = (appendResult as Array<{ status: string; server_length: number }> | null)?.[0]
      // 'applied' is the RPC's SUCCESS status (migration 192; the production
      // transcript-append route switches on the same literal). This read 'ok'
      // until 2026-09-21, a status the RPC has never returned — so every live
      // replay aborted on its FIRST chunk with errorCode 'transcript_applied'
      // and graded nothing. Batch trials were unaffected (they never append),
      // which is why the smoke suites looked healthy while every live run in
      // the workspace errored.
      if (appendRow?.status === 'applied') {
        transcriptLength = appendRow.server_length
      } else {
        // 'locked' / 'not_found' are terminal — no later append can succeed, so
        // every remaining flush would see a frozen transcript and grade nothing.
        errorCode = `transcript_${appendRow?.status ?? 'append_failed'}`
        errorMessage = `The transcript append returned ${appendRow?.status ?? 'no row'} at chunk ${i}`
        flushes.push(buildFlush(i, chunk, response, durationMs, nudges.drain(), sentAt))
        break
      }

      flushes.push(buildFlush(i, chunk, response, durationMs, nudges.drain(), sentAt))

      const answered = await answerPendingQuestion(service, { captureId, answers })
      if (answered === 'unanswered') {
        errorCode = 'unanswered_question'
        errorMessage =
          'The agent asked a question this case has no answer for; every later flush would see a different prompt state.'
        break
      }
      if (response.pair_notes === true) paired = true

      // A directive that lands after this chunk: write it, then run the turn
      // the client runs when one arrives with nothing buffered (L3's
      // requestRecordTurn): record-only, over the windows already sent, to the
      // note-taker when the recipe pairs one.
      const due = directives.filter((d) => landsAt(d) === i)
      if (due.length === 0) continue
      const written = await injectDirectives(service, {
        captureId,
        workspaceId: args.workspaceId,
        userId: args.runStarterUserId,
        directives: due,
        afterChunk: i,
      })
      if (!written.ok) {
        errorCode = 'directive_not_injected'
        errorMessage = written.message
        break
      }
      injected.push(...written.injected)

      const recordBody = {
        capture_id: captureId,
        mode: 'live',
        recent_chunks: window,
        recipe_id: args.recipeId ?? undefined,
        stream: false,
        record_only: true,
      }
      let role: 'notes' | undefined = paired ? 'notes' : undefined
      let record: { response: RouteResponse; durationMs: number; startedAt: number }
      try {
        record = await postLiveAgent(args.token, args.workspaceId, {
          ...recordBody,
          ...(role ? { live_role: role } : {}),
        })
        // Not paired yet as far as the driver knows: the copilot skips and
        // says pair, and the note-taker's turn records it (as the client does).
        if (!role && record.response.skipped === 'no_directives' && record.response.pair_notes === true) {
          paired = true
          role = 'notes'
          record = await postLiveAgent(args.token, args.workspaceId, { ...recordBody, live_role: role })
        }
      } catch (err) {
        if (err instanceof LiveAgentHttpError) throw err
        errorCode = 'route_unreachable'
        errorMessage = err instanceof Error ? err.message : String(err)
        break
      }
      flushes.push({
        ...buildFlush(
          i,
          { t_ms_start: chunk.t_ms_end, text: '' },
          record.response,
          record.durationMs,
          nudges.drain(),
          record.startedAt,
        ),
        record_only: true,
        ...(role ? { live_role: role } : {}),
        directive_keys: due.map((d) => d.key),
      })

      const answeredAfterRecord = await answerPendingQuestion(service, { captureId, answers })
      if (answeredAfterRecord === 'unanswered') {
        errorCode = 'unanswered_question'
        errorMessage =
          'The agent asked a question this case has no answer for; every later flush would see a different prompt state.'
        break
      }
    }
  } finally {
    // The tail: a broadcast for the last flush may still be in flight. Wait
    // once, only when some say_to_user call has no nudge yet, then drain into
    // the last flush, the one that produced it.
    // A say_to_user the time guard dropped as stale never broadcasts, so it is
    // not waited for.
    const sayCalls = flushes.reduce(
      (n, f) =>
        n +
        f.response.tool_call_details.filter((c) => c.tool === 'say_to_user').length -
        (f.stale_nudge_drops ?? 0) -
        (f.held_nudge_drops ?? 0),
      0,
    )
    const received = flushes.reduce((n, f) => n + f.nudges.length, 0)
    if (flushes.length > 0 && sayCalls > received) {
      await new Promise((resolve) => setTimeout(resolve, NUDGE_TAIL_GRACE_MS))
      const tail = nudges.drain()
      if (tail.length > 0) flushes[flushes.length - 1].nudges.push(...tail)
    }
    await nudges.close()
  }

  const [readBack, usage, directivesFinal] = await Promise.all([
    readBackCapture(service, { captureId, workspaceId: args.workspaceId }),
    readBackUsage(service, {
      userId: args.runStarterUserId,
      since,
      model: args.targetModel ?? '',
      captureId,
    }),
    readBackDirectives(service, { captureId, injected }),
  ])

  return {
    captureId,
    durationMs: Date.now() - startedAt,
    ...(errorCode ? { errorCode, errorMessage } : {}),
    trace: {
      mode: 'live',
      speed,
      driver: 'server',
      flushes,
      proposals_final: readBack.proposals,
      summary_final: readBack.summary,
      summary_source: summarySourceOf(flushes),
      title_final: readBack.title,
      commitments: commitmentsOf(flushes),
      reads: readsOf(flushes),
      usage,
      ...(directives.length > 0 ? { directives: directivesFinal } : {}),
    },
  }
}

/** One flush record from a chunk and the response it produced. */
function buildFlush(
  index: number,
  chunk: { t_ms_start: number; text: string },
  response: RouteResponse,
  durationMs: number,
  nudges: TraceNudge[],
  startedAt?: number,
): FlushRecord {
  return {
    index,
    t_ms: chunk.t_ms_start,
    chars: chunk.text.length,
    chunk_text: chunk.text,
    response: {
      tool_calls: response.tool_calls ?? 0,
      tool_call_details: toolCallsOf(response),
      duration_ms: response.duration_ms ?? durationMs,
    },
    ...(response.steps_used !== undefined ? { steps_used: response.steps_used } : {}),
    ...(response.finish_reason ? { finish_reason: response.finish_reason } : {}),
    ...(response.budget_hit ? { budget_hit: response.budget_hit } : {}),
    ...(response.stale_nudge_drops ? { stale_nudge_drops: response.stale_nudge_drops } : {}),
    ...(response.held_nudge_drops ? { held_nudge_drops: response.held_nudge_drops } : {}),
    nudges,
    ...(startedAt !== undefined ? { started_at_ms: startedAt } : {}),
  }
}

/** Dispatch by mode. The lane calls this and never picks a driver itself. */
export async function runTrial(
  service: SupabaseClient,
  args: RunTrialArgs & { mode: EvalMode; speed?: EvalSpeed },
): Promise<TrialResult> {
  return args.mode === 'batch'
    ? runBatchTrial(service, args)
    : runLiveInstantTrial(service, args)
}

/** The service client, exported as a seam so tests inject a double without
 *  reaching into the module registry. */
export function evalServiceClient(): SupabaseClient {
  return getServiceClient()
}
