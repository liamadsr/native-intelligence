import { NEVER_AUTOMATE_SEED, readSiteMemory } from '@/lib/cloud-browser/site-memory'
import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { getServiceClient } from '@/lib/supabase/service'
import { isFeatureEnabled, resolveWorkspaceEdition } from '@/lib/editions'
import { browserTaskSchema, observationSchema, type BrowserAction } from '@/lib/browser-agent/task-contract'
import { runDecision } from '@/lib/ai/decisions/run-decision'
import type { DecisionResult } from '@/lib/ai/decisions/contracts'
import { browserCompletion } from '@/lib/ai/decisions/tasks/browser-completion'
import type { DecisionMetrics } from '@/lib/ai/decisions/contracts'
import { resolveBrowserFieldText, type BrowserFieldTextMetrics } from '@/lib/browser-agent/resolve-field-text'
import { currentMilestone, milestoneObservationDigest } from '@/lib/browser-agent/milestone-progress'
import { appendBrowserEvidence } from '@/lib/browser-agent/browser-evidence'
import { writeBrowserDebugTrace } from '@/lib/browser-agent/local-debug-trace'
import { browserTypeStateKey, unavailableBrowserTypeRefs, rememberBrowserTypeRefusal } from '@/lib/browser-agent/type-recovery'
import { blockedSiteForUrl } from '@/lib/browser-agent/blocked-sites'
import { loadAgentBlockedSites } from '@/lib/browser-agent/blocked-sites-server'
import { trackServerEvent } from '@/lib/posthog'
import { browserTaskFinishedProperties } from '@/lib/browser-agent/task-telemetry'
import { readDriver } from '@/lib/cloud-browser/store'

/**
 * The browser command queue's device side (claim, decide, settle) for the
 * cloud browser's relay (src/app/api/browser-relay/*, docs/plans/cloud-browser.md
 * C2). The actor is who is asking, all of it from the relay's token: one user,
 * one workspace, and the device that is its sandbox.
 */
export interface BrowserCommandActor {
  userId: string
  /** The claiming device: the relay's `cloud:<sandbox>`. */
  deviceId: string
  /** The one workspace the relay may act in. */
  workspaceId: string
}

// The relay runs this build's page runtime and sends its CONTROLLER_VERSION (relay/runner.ts):
// frames, real input and dropdown choices (v8) are always there.
const bodySchema = z.object({ tabId: z.string().min(1).max(200), controllerVersion: z.number().int().min(8),
  step: z.number().int().min(0).max(23), observation: observationSchema, history: z.array(z.string().max(160)).max(24) })

export interface BrowserDecisionRouteTiming {
  authentication: number
  parse: number
  queueLookup: number
  authorization: number
  reservation: number
  decision: number
  textResolution: number
  completionReview: number
  settlement: number
  total: number
}

/**
 * One step of a browser task: the next action, decided server-side. Only the
 * device holding this queued task's lease may spend a bounded inference.
 * `authenticationMs` is how long the caller's route took to identify the actor.
 */
export async function decideBrowserStep(actor: BrowserCommandActor, id: string, request: Request,
  started = performance.now(), authenticationMs = 0): Promise<Response> {
  const timingMs: BrowserDecisionRouteTiming = { authentication: 0, parse: 0, queueLookup: 0,
    authorization: 0, reservation: 0, decision: 0, textResolution: 0, completionReview: 0, settlement: 0, total: 0 }
  const timed = async <T>(stage: Exclude<keyof BrowserDecisionRouteTiming, 'total'>, work: () => PromiseLike<T>): Promise<T> => {
    const since = performance.now()
    try { return await work() } finally { timingMs[stage] += Math.max(0, Math.round(performance.now() - since)) }
  }
  const respond = (body: Record<string, unknown>, status = 200) => {
    timingMs.total = Math.max(0, Math.round(performance.now() - started))
    return NextResponse.json({ ...body, timingMs }, { status })
  }
  timingMs.authentication = authenticationMs
  const raw = await timed('parse', () => request.text())
  // Native dropdown options add up to 300 short labels to an observation.
  if (raw.length > 120000) return respond({ error: 'Request too large' }, 413)
  let body: z.infer<typeof bodySchema>
  const parsing = performance.now()
  try { body = bodySchema.parse(JSON.parse(raw)) } catch {
    timingMs.parse += Math.max(0, Math.round(performance.now() - parsing))
    return respond({ error: 'Invalid observation' }, 400)
  }
  timingMs.parse += Math.max(0, Math.round(performance.now() - parsing))
  // The device comes from the relay's token; a body never names it.
  const { deviceId, workspaceId } = actor
  const db = getServiceClient()
  const { data: row } = await timed('queueLookup', () => db.from('browser_command_queue').select('*')
    .eq('id', id).eq('user_id', actor.userId).eq('workspace_id', workspaceId).maybeSingle())
  const task = browserTaskSchema.safeParse(row?.request?.task)
  const deadline = Math.min(Date.parse(row?.lease_expires_at ?? ''), Date.parse(row?.claimed_at ?? '') + (task.success ? task.data.timeoutMs : 0))
  if (!row || row.command !== 'run_task' || row.status !== 'claimed' || !task.success ||
      row.claimed_by_device_id !== deviceId || !Number.isFinite(deadline) || deadline <= Date.now() ||
      row.request.decisionPending || body.step !== (row.request.decisionCount ?? 0) || body.step >= task.data.maxSteps ||
      (row.tab_id && row.tab_id !== body.tabId) || (row.request.taskTabId && row.request.taskTabId !== body.tabId)) {
    return respond({ error: 'Task is no longer authorized' }, 409)
  }
  const authorized = await timed('authorization', async () => {
    const { data: member } = await db.from('member').select('id').eq('user_id', actor.userId).eq('workspace_id', row.workspace_id).maybeSingle()
    return Boolean(member) && isFeatureEnabled(await resolveWorkspaceEdition(db, row.workspace_id), 'browser')
  })
  if (!authorized) return respond({ error: 'Browser unavailable' }, 403)
  // The person took their cloud browser over (C3): the agent's task stops here, before another step.
  if (await timed('authorization', () => readDriver({ userId: actor.userId, workspaceId }))
    .then(driver => driver === 'person', () => false)) return respond({ error: 'taken_over' }, 409)
  // A page on a site the user blocked never reaches the model or the debug
  // trace. The device checks first with the list it claimed the task with;
  // this is the current list, so a site blocked mid-task stops at the next step.
  let blockedSites: string[]
  try { blockedSites = await timed('authorization', () => loadAgentBlockedSites(db, actor.userId)) } catch {
    return respond({ error: 'Blocked sites unavailable' }, 503)
  }
  const blockedSite = blockedSiteForUrl(body.observation.url, blockedSites) ??
    (body.observation.frames ?? []).map(frame => blockedSiteForUrl(frame.origin, blockedSites)).find(Boolean) ?? null
  if (blockedSite) return respond({ error: 'site_blocked', blockedSite }, 409)
  let milestoneIndex: number
  try { milestoneIndex = currentMilestone(task.data, row.request, body.observation) } catch {
    return respond({ error: 'Invalid task progress' }, 409)
  }
  // JSONB equality is a compare-and-swap: a duplicate step cannot buy another inference.
  // Reading evidence comes only from observations accepted for this owned
  // command, never from a caller-supplied account of earlier pages.
  const evidenceLedger = task.data.goalDriven
    ? appendBrowserEvidence(row.request.evidenceLedger, body.observation, body.step) : undefined
  const reservation = { ...row.request, decisionCount: body.step + 1, taskTabId: body.tabId, decisionPending: true,
    milestoneIndex, milestoneVerification: null, ...(evidenceLedger ? { evidenceLedger } : {}) }
  const { data: reserved } = await timed('reservation', () => db.from('browser_command_queue')
    .update({ request: reservation })
    .eq('id', id).eq('user_id', actor.userId).eq('status', 'claimed').eq('request', JSON.stringify(row.request))
    .gt('lease_expires_at', new Date().toISOString()).select('id').maybeSingle())
  if (!reserved) return respond({ error: 'Step already consumed' }, 409)
  const traceContext = { userId: actor.userId, workspaceId: row.workspace_id, runId: id }
  await writeBrowserDebugTrace(traceContext, 'native.observation', {
    step: body.step, controllerVersion: body.controllerVersion, task: task.data, observation: body.observation, history: body.history,
    ledgerBefore: row.request.evidenceLedger ?? null, ledgerAfter: evidenceLedger ?? null,
  })
  // Authorization/storage can outlast the task. Check the wall clock before
  // dispatch, rather than waiting for an overdue abort timer to run.
  if (request.signal.aborted || Date.now() >= deadline) return respond({ error: 'Task stopped' }, 409)
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))])
  const unavailableTypeRefs = unavailableBrowserTypeRefs(body.observation, row.request.typeRefusals)
  const decisionInput = { task: task.data, observation: body.observation, history: body.history, milestoneIndex,
    ...(unavailableTypeRefs.length ? { unavailableTypeRefs } : {}),
    ...(evidenceLedger ? { evidenceLedger } : {}) }
  const decisionContext = { userId: actor.userId, workspaceId: row.workspace_id, runId: id, signal }
  let next = await timed('decision', () => runDecision('browser.next_action', decisionInput, decisionContext))
  let completionMetrics: DecisionMetrics | undefined
  let completionBasis: 'completion_inventory_v1' | undefined
  let completionReviewKeys = Array.isArray(row.request.completionReviewKeys)
    ? row.request.completionReviewKeys.filter((key: unknown) => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key)).slice(0, 2) : []
  // A partial reading view is a second, independently metered completion
  // check, never a source of actions. Do not retry the same evidence to fish
  // for confidence; allow at most two distinct views under this owned task.
  // A weak "complete" vote that came with a usable action is reviewed the
  // same way, and the action runs only if the review does not find the goal done.
  const reviewFirst = next.status === 'accepted' && next.value.operation === 'review_completion'
  if (task.data.goalDriven && (reviewFirst || (next.status === 'escalate' && next.reason === 'uncertain'))) {
    const prepared = browserCompletion.prepare(decisionInput)
    const key = prepared && createHash('sha256').update(browserCompletion.version + prepared.state).digest('hex')
    if (key && completionReviewKeys.length < 2 && !completionReviewKeys.includes(key)) {
      const { data: current } = await timed('authorization', () => db.from('browser_command_queue').select('id')
        .eq('id', id).eq('user_id', actor.userId).eq('status', 'claimed').eq('claimed_by_device_id', deviceId)
        .eq('request', JSON.stringify(reservation)).gt('lease_expires_at', new Date().toISOString()).maybeSingle())
      if (!current || signal.aborted || Date.now() >= deadline) return respond({ error: 'Task stopped', metrics: next.metrics }, 409)
      completionReviewKeys = [...completionReviewKeys, key]
      const reviewed = await timed('completionReview', () => runDecision('browser.completion', decisionInput, decisionContext))
      completionMetrics = reviewed.metrics
      if (reviewed.status === 'accepted' && reviewed.value === 'complete') {
        next = { status: 'accepted', value: { operation: 'done' }, version: browserCompletion.version,
          inferenceId: reviewed.inferenceId, metrics: next.metrics }
        completionBasis = 'completion_inventory_v1'
      }
    }
  }
  if (next.status === 'accepted' && next.value.operation === 'review_completion') next = { ...next, value: next.value.next }
  let decision: DecisionResult<BrowserAction>
  let textMetrics: BrowserFieldTextMetrics | undefined
  let typeRefusals = row.request.typeRefusals
  if (next.status === 'accepted' && next.value.operation === 'resolve_type') {
    const ref = next.value.ref
    // Do not spend on field text after a concurrent Stop, ownership change or
    // expired lease. Keep the same reserved step through both inferences.
    const { data: current } = await timed('authorization', () => db.from('browser_command_queue').select('id')
      .eq('id', id).eq('user_id', actor.userId).eq('status', 'claimed').eq('claimed_by_device_id', deviceId)
      .eq('request', JSON.stringify(reservation)).gt('lease_expires_at', new Date().toISOString()).maybeSingle())
    if (!current || signal.aborted || Date.now() >= deadline) return respond({ error: 'Task stopped', metrics: next.metrics }, 409)
    const resolved = await timed('textResolution', () => resolveBrowserFieldText({
      task: task.data, observation: body.observation, ref, history: body.history,
    }, { userId: actor.userId, workspaceId: row.workspace_id, runId: id, signal,
      // Native observations expire after ten seconds. A late helper answer
      // cannot be made actionable by extending the task deadline.
      deadline: Math.min(deadline, body.observation.observedAt + 9000) }))
    textMetrics = resolved.metrics
    decision = resolved.status === 'accepted'
      ? { ...next, value: { operation: 'type', ref, value: resolved.value } }
      : { status: resolved.status, reason: resolved.reason, inferenceId: next.inferenceId, metrics: next.metrics }
    if (resolved.status === 'escalate' && (resolved.reason === 'text_unchanged' || resolved.reason === 'text_not_supplied') &&
      browserTypeStateKey(body.observation, ref)) {
      typeRefusals = rememberBrowserTypeRefusal(body.observation, ref, typeRefusals)
      decision = { ...next, value: { operation: 'reobserve', reason: resolved.reason as 'text_unchanged' | 'text_not_supplied' } }
    }
  } else {
    // Narrow explicitly: unresolved field selections never reach the client.
    decision = next as DecisionResult<BrowserAction>
  }
  const milestoneVerification = decision.status === 'accepted' && decision.value.operation === 'advance'
    ? { digest: milestoneObservationDigest(body.observation), observationId: body.observation.observationId } : null
  const { data: stillActive } = await timed('settlement', () => db.from('browser_command_queue').update({ request: { ...reservation, decisionPending: false, milestoneVerification,
    ...(typeRefusals ? { typeRefusals } : {}), ...(completionReviewKeys.length ? { completionReviewKeys } : {}) } })
    .eq('id', id).eq('user_id', actor.userId).eq('request', JSON.stringify(reservation))
    .eq('status', 'claimed').eq('claimed_by_device_id', deviceId).gt('lease_expires_at', new Date().toISOString()).select('id').maybeSingle())
  // Retain spent-request metrics without returning an actionable decision after cancellation.
  if (!stillActive || signal.aborted || Date.now() >= deadline) return respond({ error: 'Task stopped', metrics: decision.metrics, textMetrics, completionMetrics }, 409)
  await writeBrowserDebugTrace(traceContext, 'decision.result', {
    step: body.step, decision, textMetrics: textMetrics ?? null, completionMetrics: completionMetrics ?? null, completionBasis: completionBasis ?? null, timingMs,
  })
  return respond({ decision, deadline, blockedSites, ...(completionBasis ? { completionBasis } : {}), ...(textMetrics ? { textMetrics } : {}), ...(completionMetrics ? { completionMetrics } : {}),
    ...(evidenceLedger ? { evidenceLedger } : {}) })
}


/** Lease on a claimed command: the device settles within this or the reaper reclaims it. Browser commands are quick. */
const LEASE_MS = 60 * 1000

/**
 * Claim one command atomically (a compare-and-set on waiting_for_device), so
 * two devices can't both run it. Returns the command with the user's blocked
 * sites as they are now, read BEFORE claiming: a list that can't be read
 * leaves the command unclaimed rather than claimed with no list.
 */
export async function claimBrowserCommand(actor: BrowserCommandActor, id: string): Promise<Response> {
  const svc = getServiceClient()
  let blockedSites: string[]
  try {
    blockedSites = await loadAgentBlockedSites(svc, actor.userId)
  } catch {
    return NextResponse.json({ error: 'Blocked sites unavailable' }, { status: 503 })
  }
  const now = new Date()
  const { data: claimed, error } = await svc
    .from('browser_command_queue')
    .update({
      status: 'claimed',
      claimed_by_device_id: actor.deviceId,
      claimed_at: now.toISOString(),
      lease_expires_at: new Date(now.getTime() + LEASE_MS).toISOString(),
      attempt_count: 1,
    })
    .eq('id', id)
    .eq('user_id', actor.userId)
    .eq('workspace_id', actor.workspaceId)
    .eq('status', 'waiting_for_device')
    .gt('expires_at', now.toISOString())
    .select('id, command, tab_id, request, target_origin, requires_approval, session_id, workspace_id, claimed_at, lease_expires_at')
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!claimed) return NextResponse.json({ error: 'Command not claimable' }, { status: 409 })
  // A cloud browser the person has taken over (C3) runs nothing for the agent; the relay says so.
  const driver = await readDriver({ userId: actor.userId, workspaceId: actor.workspaceId }).catch(() => 'agent' as const)
  // C4: where the browser may go without the Mac, and where never (the seed alone when the table can't be read).
  const siteMemory = await readSiteMemory(actor.userId).catch(() => ({ needsHome: [], neverAutomate: NEVER_AUTOMATE_SEED }))
  return NextResponse.json({ command: claimed, blockedSites, siteMemory, driver })
}

const TERMINAL = new Set(['completed', 'failed', 'denied'])

/**
 * A claimed command's outcome. Terminal states: completed (result set),
 * failed (error_message set), denied (a blocked site or a declined approval).
 * Idempotent: gated on the row still being non-terminal for this actor, so a
 * lost-ack retry can't double-write. Body: { status, result?, error? }.
 */
export async function settleBrowserCommand(actor: BrowserCommandActor, id: string, request: Request): Promise<Response> {
  let status = ''
  let result: unknown = null
  let error: string | null = null
  try {
    const body = await request.json()
    status = typeof body?.status === 'string' ? body.status : ''
    result = body?.result ?? null
    error = typeof body?.error === 'string' ? body.error : null
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  }
  if (!TERMINAL.has(status)) {
    return NextResponse.json({ error: `invalid settle status: ${status}` }, { status: 400 })
  }

  const svc = getServiceClient()
  // A relay settles only what its own device claimed.
  const { data: settled, error: dbError } = await svc
    .from('browser_command_queue')
    .update({
      status,
      result: result ?? null,
      error_message: error,
      finished_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('user_id', actor.userId)
    .eq('workspace_id', actor.workspaceId)
    .eq('claimed_by_device_id', actor.deviceId)
    .in('status', ['claimed', 'running'])
    .select('id, command, workspace_id, session_id, status, created_at, claimed_at, finished_at')
    .maybeSingle()

  if (dbError) return NextResponse.json({ error: dbError.message }, { status: 500 })
  if (settled) {
    if (settled.command === 'run_task' && result && typeof result === 'object' && !Array.isArray(result)) {
      const outcome = result as Record<string, unknown>
      await writeBrowserDebugTrace({ userId: actor.userId, workspaceId: settled.workspace_id, runId: id }, 'task.settled', {
        commandStatus: settled.status, status: outcome.status, reason: outcome.reason, steps: outcome.steps,
        elapsedMs: outcome.elapsedMs, timings: outcome.timings, diagnostics: outcome.diagnostics,
        trace: outcome.trace, evidenceLedger: outcome.evidenceLedger,
        createdAt: settled.created_at, claimedAt: settled.claimed_at, finishedAt: settled.finished_at,
      })
    }
    // Only the first successful CAS emits. Client JSON supplies no identity,
    // authoritative timing or free-text analytics properties.
    try {
      const properties = browserTaskFinishedProperties(settled, result, process.env.VERCEL_GIT_COMMIT_SHA)
      if (properties) trackServerEvent('browser_task_finished', {
        userId: actor.userId, workspaceId: settled.workspace_id,
      }, properties)
    } catch {
      // Analytics must not change the acknowledgement of a durable settlement.
    }
  }
  // Already terminal (a retry that lost its ack) → treat as success, idempotent.
  return NextResponse.json({ ok: true, settled: !!settled })
}
