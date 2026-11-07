import { browserCompletionReadingKey } from './completion-reading'
import { browserTaskSchema, observationSchema, taskCompleted, browserObservationState as stateKey, type BrowserAction, type BrowserObservation } from './task-contract'
import { evaluateGuardrail, looksSensitive } from './guardrails'
import { blockedSiteForUrl, BrowserSiteBlockedError, siteBlockedMessage } from './blocked-sites'
import type { DecisionMetrics, DecisionResult } from '@/lib/ai/decisions/contracts'
import type { BrowserTaskDiagnostics, SnapshotPhase } from './task-diagnostics'
import type { BrowserFieldTextMetrics } from './resolve-field-text'
import { browserLinkEvidence, type BrowserLinkEvidence } from './link-evidence'
import { appendBrowserEvidence, browserEvidenceLedgerSchema, type BrowserEvidenceLedger } from './browser-evidence'
import { restrictedFrame } from './frame-observation'

export interface TaskExecutorPorts {
  /** Resolves after the requested navigation settles, never while the old page is still loading. */
  navigate(url: string): Promise<void>
  snapshot(): Promise<unknown>
  decide(observation: BrowserObservation, step: number, history: string[], signal: AbortSignal): Promise<{ decision: DecisionResult<BrowserAction>; deadline: number; timingMs?: Record<string, number>; textMetrics?: BrowserFieldTextMetrics; completionMetrics?: DecisionMetrics; completionBasis?: 'completion_inventory_v1'; evidenceLedger?: BrowserEvidenceLedger }>
  act(request: Record<string, unknown>): Promise<{ ok: boolean; code?: string }>
  /** The sites the user blocked the agent from, as of now. */
  blockedSites(): readonly string[]
  /** The blocked site the navigation guard kept this tab from opening, if it
   *  did (while the task drives the tab). */
  blockedNavigation?(): string | null
  approve(summary: string): Promise<boolean>
  alive(): boolean
  signal: AbortSignal
  deadline: number
}
export type BrowserTaskResult = { status: 'verified' | 'escalate' | 'cancelled'; reason: string; steps: number;
  elapsedMs: number; url?: string; evidence?: string; message?: string; blockedSite?: string;
  timings: { snapshotMs: number; settlingMs: number; navigationMs: number };
  diagnostics?: BrowserTaskDiagnostics;
  linkEvidence?: BrowserLinkEvidence;
  evidenceLedger?: BrowserEvidenceLedger;
  freshReadings?: { source: 'final_native_observation'; url: string; documentId: string; observedAt: number; evidence: BrowserObservation['evidence'] };
  trace: { step: number; operation: string; decisionMs: number; actionMs?: number;
    actionStatus?: 'succeeded' | 'rejected' | 'unknown'; actionCode?: 'stale_observation' | 'invalid_target' | 'forbidden_target' | 'approval_required' | 'deadline_exceeded' | 'not_editable' | 'write_outcome_unknown' | 'unknown';
    recovery?: 'page_changed'; metrics?: DecisionMetrics; routeTimingMs?: Record<string, number>; textMetrics?: BrowserFieldTextMetrics; completionMetrics?: DecisionMetrics
    target?: BrowserTraceTarget }[] }
/** The observed control behind Jev's action choice, accepted or not. */
export type BrowserTraceTarget = { ref: string; role: string; name: string; option?: string; key?: string; frame?: string }

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const stop = () => { clearTimeout(timer); reject(new Error('cancelled')) }
  const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, ms)
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
})

const NATIVE_READ_MS = 2000
const SETTLE_WINDOW_MS = 700
// Measured failures kept scrolling a results page (10+ times) because Jev's
// strict completion head never accepted. After this many consecutive scrolls
// the parent reviews the collected findings instead of the budget running out.
const READING_SCROLL_LIMIT = 3
const RUNTIME_READY_MS = 2000
const RUNTIME_RETRY_MS = 100
const RUNTIME_NOT_PRESENT = 'agent runtime not present'
const ACTION_CODES = new Set(['stale_observation', 'invalid_target', 'forbidden_target', 'approval_required',
  'deadline_exceeded', 'not_editable', 'write_outcome_unknown'])
function actionCode(value: unknown): NonNullable<BrowserTaskResult['trace'][number]['actionCode']> {
  return typeof value === 'string' && ACTION_CODES.has(value)
    ? value as NonNullable<BrowserTaskResult['trace'][number]['actionCode']> : 'unknown'
}

/** This exact native sentinel is returned before the document-start script
 * exists. A malformed observation (including a different protocol) is not it. */
function isRuntimeStarting(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === 1 && (value as Record<string, unknown>).error === RUNTIME_NOT_PRESENT
}

/** What Jev's action choice pointed at on this observation. Refs are renumbered
 * per page, so the choice alone ("click_e80") cannot later say which control
 * it was. Names only: never a typed value or field content. */
function choiceTarget(decision: DecisionResult<BrowserAction>, observation: BrowserObservation): BrowserTraceTarget | undefined {
  const value = decision.status === 'accepted' ? decision.value : undefined
  const answers = decision.metrics?.answers
  const choice = answers?.action?.choice ?? answers?.click?.choice ?? answers?.type?.choice
  const ref = value && 'ref' in value && typeof value.ref === 'string' ? value.ref
    : choice?.match(/^(?:click_|type_|select_|key_enter_)?((?:f\d+)?e\d+)(?:_b?\d+)?$/)?.[1]
  const element = ref ? observation.elements.find(e => e.ref === ref) : undefined
  if (!element) return undefined
  const optionIndex = value?.operation === 'select' ? value.option : Number(choice?.match(/^select_(?:f\d+)?e\d+_(\d+)$/)?.[1] ?? NaN)
  const option = element.options?.find(entry => entry.index === optionIndex)?.label
  const key = value?.operation === 'press_key' ? value.key : choice?.startsWith('key_enter_') ? 'Enter' : undefined
  return { ref: element.ref, role: element.role, name: element.name.slice(0, 120), ...(option ? { option: option.slice(0, 100) } : {}),
    ...(key ? { key } : {}), ...(element.frame ? { frame: element.frame } : {}) }
}

/** A useful account of the previous action, rather than an opaque progress hash. */
function actionSummary(action: BrowserAction, observation: BrowserObservation, after?: BrowserObservation): string {
  if (action.operation === 'scroll_down' || action.operation === 'scroll_up') {
    const beforeSurface = observation.scrollSurface ?? observation.viewport
    const afterSurface = after?.scrollSurface ?? after?.viewport
    if (beforeSurface && afterSurface) return `Scrolled ${action.operation === 'scroll_down' ? 'down' : 'up'} (${observation.scrollSurface?.scope ?? 'page'}): y=${Math.round(beforeSurface.scrollY)} -> ${Math.round(afterSurface.scrollY)}; surface height=${Math.round(afterSurface.height)}.`
  }
  const target = 'ref' in action ? observation.elements.find(e => e.ref === action.ref) : undefined
  if (action.operation === 'select') {
    const option = target?.options?.find(entry => entry.index === action.option)
    return `Chose "${option?.label}" in ${target?.role} "${target?.name}".`.slice(0, 160)
  }
  if (action.operation === 'press_key') return (target ? `Pressed ${action.key} in ${target.role} "${target.name}".` : `Pressed ${action.key}.`).slice(0, 160)
  return (action.operation === 'type' ? `Filled ${target?.role} "${target?.name}"${'binding' in action ? ` with binding ${action.binding}` : ''}.` :
    target ? `Clicked ${target.role} "${target.name}".` : `Performed ${action.operation}.`).slice(0, 160)
}

/** A task that ended before its first step because its start page, or the
 *  page it would continue from, is on a site the user blocked. */
export function siteBlockedTaskResult(site: string): BrowserTaskResult {
  return { status: 'escalate', reason: 'site_blocked', message: siteBlockedMessage(site), blockedSite: site, steps: 0,
    elapsedMs: 0, timings: { snapshotMs: 0, settlingMs: 0, navigationMs: 0 }, trace: [] }
}

/** One queue command, multiple local actions, no parent-model turn between steps. */
export async function executeBrowserTask(raw: unknown, ports: TaskExecutorPorts): Promise<BrowserTaskResult> {
  const task = browserTaskSchema.parse(raw)
  const started = Date.now()
  let deadline = Math.min(ports.deadline, started + task.timeoutMs)
  let steps = 0, stale = 0, waits = 0, recoveries = 0, typeReplans = 0, scrolls = 0
  let writeUncertain = false
  let observation: BrowserObservation | undefined
  let pending: BrowserObservation | undefined
  let evidenceLedger: BrowserEvidenceLedger | undefined
  const history: string[] = []
  const progress: string[] = []
  const timings = { snapshotMs: 0, settlingMs: 0, navigationMs: 0 }
  const diagnostics: BrowserTaskDiagnostics = { snapshotAttempts: 0, startupRetries: 0 }
  const trace: BrowserTaskResult['trace'] = []
  // Set once the task reached a site the user blocked. Nothing read there is
  // kept (the observation it would have been is never stored), and however the
  // task then ends, it reports site_blocked.
  let blockedSite: string | null = null
  // Every outcome keeps what was read. An unverified result is not success,
  // but discarding its findings forced the parent to start over from nothing.
  const finish = (status: BrowserTaskResult['status'], reason: string, message?: string): BrowserTaskResult => blockedSite
    ? { ...finishWith('escalate', 'site_blocked', siteBlockedMessage(blockedSite)), blockedSite }
    : finishWith(status, reason, message)
  const finishWith = (status: BrowserTaskResult['status'], reason: string, message?: string): BrowserTaskResult => ({ status, reason, steps,
    elapsedMs: Date.now() - started, url: observation?.url, trace, timings, diagnostics,
    ...(observation?.evidence ? { freshReadings: { source: 'final_native_observation' as const,
      url: observation.url, documentId: observation.documentId, observedAt: observation.observedAt, evidence: observation.evidence } } : {}),
    ...(observation && evidenceLedger
      ? { evidenceLedger: appendBrowserEvidence(evidenceLedger, observation, trace.at(-1)?.step ?? 0) }
      : { evidence: observation?.text.slice(0, 1000),
        ...(status === 'verified' && observation ? { linkEvidence: browserLinkEvidence(observation) } : {}) }),
    ...(message ? { message } : {}) })
  // The relay aborts the task at its deadline as well as on Stop. Running out
  // of time is an unfinished task with findings, not a user cancellation.
  const stopped = (): BrowserTaskResult => Date.now() >= deadline
    ? finish('escalate', 'deadline')
    : finish('cancelled', ports.signal.aborted ? 'user_stopped' : 'stopped_or_deadline')
  const blocked = (site: string): BrowserTaskResult => {
    blockedSite = site
    return finish('escalate', 'site_blocked')
  }
  const live = () => !ports.signal.aborted && ports.alive() && Date.now() < deadline
  // Native snapshot RPCs cannot be cancelled, but the task must stop awaiting
  // them at its deadline/Stop. A late read cannot update our observation or
  // cause another inference/action after this bounded wrapper has settled.
  const readSnapshot = (until: number) => new Promise<unknown>((resolve, reject) => {
    let done = false
    const finish = (error: unknown, value?: unknown) => {
      if (done) return
      done = true
      clearTimeout(timeout); clearInterval(ownership)
      ports.signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(value)
    }
    const onAbort = () => finish(new Error('stopped_or_deadline'))
    const timeout = setTimeout(() => finish(new Error(live() ? 'snapshot_read_timeout' : 'stopped_or_deadline')),
      Math.max(0, Math.min(until, deadline) - Date.now()))
    const ownership = setInterval(() => { if (!live()) onAbort() }, 50)
    ports.signal.addEventListener('abort', onAbort, { once: true })
    if (!live()) { onAbort(); return }
    Promise.resolve().then(() => {
      if (!live()) throw new Error('stopped_or_deadline')
      return ports.snapshot()
    }).then(value => {
      // A busy event loop can deliver the native promise before an overdue
      // timer callback. The clock boundary still wins over that late evidence.
      if (Date.now() >= Math.min(until, deadline)) {
        finish(new Error(live() ? 'snapshot_read_timeout' : 'stopped_or_deadline'))
      } else finish(null, value)
    }, error => finish(error))
  })
  const snapshot = async (until = Math.min(deadline, Date.now() + NATIVE_READ_MS), phase: SnapshotPhase = 'step') => {
    const start = Date.now(), budgetMs = Math.max(0, Math.min(until, deadline) - start)
    let outcome: NonNullable<BrowserTaskDiagnostics['snapshotReads']>[number]['outcome'] = 'read'
    let native: BrowserObservation['readMetrics']
    diagnostics.snapshotAttempts++
    let code: NonNullable<BrowserTaskDiagnostics['lastSnapshotFailure']>['code'] = 'native_read_failed'
    try {
      const rawSnapshot = await readSnapshot(until)
      if (!live()) throw new Error('stopped_or_deadline')
      if (isRuntimeStarting(rawSnapshot)) { code = 'runtime_starting'; throw new Error(RUNTIME_NOT_PRESENT) }
      const fresh = observationSchema.safeParse(rawSnapshot)
      if (!fresh.success) { code = 'invalid_snapshot'; throw new Error('browser_observation_unavailable') }
      // The page reports its own address, so this is the page the read came
      // from, even when a redirect landed after the task's last look.
      const sites = ports.blockedSites()
      const site = blockedSiteForUrl(fresh.data.url, sites) ??
        (fresh.data.frames ?? []).map(frame => blockedSiteForUrl(frame.origin, sites)).find(Boolean)
      if (site) {
        blockedSite = site
        throw new BrowserSiteBlockedError(site)
      }
      observation = fresh.data
      native = fresh.data.readMetrics
      return fresh.data
    } catch (error) {
      if (error instanceof BrowserSiteBlockedError) throw error
      if (live()) {
        if (error instanceof Error && error.message === RUNTIME_NOT_PRESENT) code = 'runtime_starting'
        if (error instanceof Error && error.message === 'snapshot_read_timeout') code = 'read_timeout'
        diagnostics.lastSnapshotFailure = { phase, code }
        outcome = code
      } else outcome = 'cancelled'
      if (error instanceof Error && error.message === 'snapshot_read_timeout') throw new Error('browser_observation_unavailable')
      throw error
    } finally {
      const elapsedMs = Math.max(0, Math.min(60000, Date.now() - start))
      timings.snapshotMs += elapsedMs
      diagnostics.snapshotReads = [...(diagnostics.snapshotReads ?? []),
        { phase, elapsedMs, budgetMs: Math.min(60000, budgetMs), outcome, ...(native ? { native } : {}) }].slice(-96)
    }
  }
  // A cold or woken tab can acknowledge navigation before its isolated
  // document-start runtime exists. Retry only that exact read-only startup
  // condition; never navigate again or turn arbitrary protocol errors into
  // readiness.
  const initialSnapshot = async () => {
    const until = Math.min(deadline, Date.now() + RUNTIME_READY_MS)
    for (;;) {
      if (!live()) throw new Error('stopped_or_deadline')
      if (Date.now() >= until) throw new Error('browser_observation_unavailable')
      try { return await snapshot(until, 'startup') } catch (error) {
        if (!(error instanceof Error) || error.message !== RUNTIME_NOT_PRESENT) throw error
        if (!live()) throw new Error('stopped_or_deadline')
        if (Date.now() >= until) throw new Error('browser_observation_unavailable')
      }
      diagnostics.startupRetries++
      const waiting = Date.now()
      try { await pause(Math.min(RUNTIME_RETRY_MS, until - waiting), ports.signal) }
      finally { timings.settlingMs += Date.now() - waiting }
    }
  }
  // Wait for a useful page change and a short quiet interval. These reads are
  // local; they buy no inference and retain the latest native observation token.
  const settle = async (previous: BrowserObservation, requireChange: boolean, minimumMs = 0) => {
    const start = Date.now(), before = stateKey(previous)
    let latest: BrowserObservation | undefined
    let key = before, quietSince = start
    try {
      while (live()) {
        if (Date.now() - start >= SETTLE_WINDOW_MS) break
        try {
          // The quiet-window budget controls polling, not an in-flight native RPC.
          // A busy WebKit bridge may consume most of that window on one read;
          // the next fresh read still needs a full bounded opportunity.
          latest = await snapshot(Math.min(deadline, Date.now() + NATIVE_READ_MS), 'settle')
          const next = stateKey(latest)
          if (next !== key) { key = next; quietSince = Date.now() }
        } catch (error) {
          if (error instanceof BrowserSiteBlockedError) throw error
          // An acknowledged navigation can replace its document while a read
          // is in flight. Retry only the read, within this same settle budget.
          // Never continue with an observation from before the failed read.
          latest = undefined
          quietSince = Date.now()
        }
        const elapsed = Date.now() - start
        if (latest && latest.readyState !== 'loading' && !latest.loading && (!requireChange || key !== before) &&
            elapsed >= minimumMs && Date.now() - quietSince >= 100) break
        if (elapsed >= SETTLE_WINDOW_MS) break
        await pause(Math.min(50, SETTLE_WINDOW_MS - elapsed, Math.max(1, deadline - Date.now())), ports.signal)
      }
      if (!live()) throw new Error('stopped_or_deadline')
      if (!latest) throw new Error('observation_unavailable_after_settle')
      return latest
    } finally { timings.settlingMs += Date.now() - start }
  }
  const inspectCompletion = async (decided?: BrowserObservation, basis?: 'completion_inventory_v1') => {
    if (!live()) return false
    try {
      const fresh = await snapshot(deadline, 'completion')
      // A semantic DONE belongs to its classified evidence. Compare that exact
      // inventory when certified by the route; legacy checks retain full state.
      const before = decided && (basis === 'completion_inventory_v1'
        ? browserCompletionReadingKey({ task, observation: decided, evidenceLedger }) : stateKey(decided))
      const after = basis === 'completion_inventory_v1'
        ? browserCompletionReadingKey({ task, observation: fresh, evidenceLedger }) : stateKey(fresh)
      return live() && (!decided || !!before && before === after) && taskCompleted(task, fresh)
    } catch { return false }
  }
  const recover = async (previous: BrowserObservation, step: number) => {
    if (recoveries >= 2 || step + 1 >= task.maxSteps || !live()) {
      await inspectCompletion()
      return false
    }
    const fresh = await settle(previous, true)
    if (!live() || stateKey(fresh) === stateKey(previous)) return false
    recoveries++
    pending = fresh
    trace[trace.length - 1].recovery = 'page_changed'
    return true
  }
  try {
    if (!live()) return stopped()
    if (task.startUrl) {
      const site = blockedSiteForUrl(task.startUrl, ports.blockedSites())
      if (site) return blocked(site)
      // The page it leaves is never read: the first observation is the start page's.
      const navigationStarted = Date.now()
      try { await ports.navigate(task.startUrl) }
      finally { timings.navigationMs = Date.now() - navigationStarted }
    }
    pending = await initialSnapshot()
    for (let step = 0; step <= task.maxSteps; step++) {
      if (!live()) return stopped()
      const kept = ports.blockedNavigation?.()
      if (kept) return blocked(kept)
      observation = pending ?? await snapshot()
      pending = undefined
      if (observation.readyState === 'loading' || observation.loading) observation = await settle(observation, false)
      if (!live()) return stopped()
      if (step === task.maxSteps) break
      const before = Date.now()
      const attempt: BrowserTaskResult['trace'][number] = { step, operation: 'unavailable', decisionMs: 0 }
      trace.push(attempt)
      // Keep an unknown-usage attempt even if the decision response is lost.
      // The server may already have incurred and accounted for that inference.
      const response = await ports.decide(observation, step, history, ports.signal)
        .finally(() => { attempt.decisionMs = Date.now() - before })
      deadline = Math.min(deadline, response.deadline)
      Object.assign(attempt, { operation: response.decision.status === 'accepted' ? response.decision.value.operation : response.decision.status,
        metrics: response.decision.metrics, routeTimingMs: response.timingMs, textMetrics: response.textMetrics, completionMetrics: response.completionMetrics })
      const chosen = choiceTarget(response.decision, observation)
      if (chosen) attempt.target = chosen
      if (!live()) return stopped()
      if (response.evidenceLedger !== undefined) {
        const parsed = browserEvidenceLedgerSchema.safeParse(response.evidenceLedger)
        if (!parsed.success) {
          const issue = parsed.error.issues[0]
          const codes = ['invalid_type', 'invalid_value', 'invalid_format', 'too_small', 'too_big', 'unrecognized_keys', 'custom'] as const
          // Retain only fixed categories, never issue messages, keys or values.
          diagnostics.lastEvidenceFailure = {
            issueCode: codes.find(code => code === issue?.code) ?? 'other',
            section: issue?.path[0] !== 'pages' ? 'ledger' : issue.path[2] === 'snippets' ? 'snippet' : issue.path[2] === 'links' ? 'link' : 'page',
          }
          return finish('escalate', 'invalid_evidence')
        }
        evidenceLedger = parsed.data
      }
      if (response.decision.status !== 'accepted') {
        if (response.decision.status === 'escalate' && response.decision.reason === 'uncertain') {
          if (await recover(observation, step)) continue
          if (!live()) return stopped()
        } else if (response.decision.status !== 'cancelled') await inspectCompletion()
        return finish(response.decision.status, response.decision.reason)
      }
      const action = response.decision.value
      if (action.operation === 'reobserve') {
        if (!['text_unchanged', 'text_not_supplied'].includes(action.reason) || !task.goalDriven) return finish('escalate', 'invalid_target')
        if (++typeReplans > 3) return finish('escalate', 'text_replan_budget')
        // No native write occurred. Re-read before selecting another action;
        // the server suppresses only typing into the identical refused state.
        history.push('Text resolver supplied no different authorized value; inspect another supported way to progress.')
        pending = await snapshot()
        continue
      }
      if (action.operation === 'advance') {
        // Advancement is not a native interaction or proof of the full task.
        // The next fresh observation lets the server commit the milestone only
        // if the page still matches its accepted verification.
        pending = await snapshot()
        continue
      }
      if (action.operation === 'done') {
        // Server acceptance independently checks goal completion with Jev.
        // Re-read locally too, so a changed page cannot reuse that decision.
        const decided = observation
        if (await inspectCompletion(decided, response.completionBasis)) return finish('verified', 'goal_and_predicates_satisfied')
        // Navigation/hydration can finish after DONE was inferred. A changed
        // page gets a fresh decision within the same shared recovery budget;
        // its matching predicates alone never upgrade the old DONE to success.
        if (live() && await recover(decided, step)) continue
        return !live() ? stopped() : finish('escalate', 'completion_changed')
      }
      if (action.operation === 'escalate') {
        if (await recover(observation, step)) continue
        if (!live()) return stopped()
        return finish('escalate', 'planner_review_required')
      }
      if (!['click', 'type', 'select', 'press_key', 'scroll_down', 'scroll_up', 'wait'].includes(action.operation)) return finish('escalate', 'invalid_target')
      // Page scrolling is reading; a dialog, picker or list scroll is form work.
      const scrolling = (action.operation === 'scroll_down' || action.operation === 'scroll_up') &&
        (observation.scrollSurface?.scope ?? 'page') === 'page'
      // Each scrolled view was already offered to the completion check and
      // added to the ledger. More scrolling is reading the parent can judge.
      if (scrolling && task.goalDriven && scrolls >= READING_SCROLL_LIMIT) return finish('escalate', 'reading_limit')
      steps++
      if (action.operation === 'wait') {
        if (++waits > 3) return finish('escalate', 'wait_budget')
        pending = await settle(observation, true, 100)
        continue
      }
      const target = 'ref' in action ? observation.elements.find(e => e.ref === action.ref) : undefined
      if ('ref' in action && (!target || target.disabled || target.forbidden)) return finish('escalate', 'invalid_target')
      // Only an option observed on this exact dropdown can be chosen.
      if (action.operation === 'select' && !target?.options?.some(option => option.index === action.option)) return finish('escalate', 'invalid_target')
      // Enter goes to the focused field: only that observed field, with real input.
      if (action.operation === 'press_key' && (observation.trustedInput !== true ||
          ('ref' in action ? !target?.focused || !target.canType : action.key !== 'Escape'))) return finish('escalate', 'invalid_target')
      const text = action.operation === 'type' ? ('value' in action ? action.value : task.bindings[action.binding]?.value) : undefined
      if (action.operation === 'type' && (!target?.canType || typeof text !== 'string' || text.length > 2000 ||
          ('value' in action && !task.goalDriven))) return finish('escalate', 'invalid_target')
      // A control inside an embedded frame acts through that frame's own
      // observation, gated in every enclosing document by the native app.
      const frame = target?.frame ? observation.frames?.find(entry => entry.key === target.frame) : undefined
      if (target?.frame && (!frame || !target.point || !target.ref.startsWith(frame.key))) return finish('escalate', 'invalid_target')
      if (frame && restrictedFrame(frame.origin, frame.url)) return finish('escalate', 'restricted_frame')
      const observed = observation
      const ancestors = frame?.path.map((_, level) => level === 0 ? observed : observed.frames?.find(entry =>
        entry.path.length === level && entry.path.every((index, position) => index === frame.path[position])))
      if (ancestors?.some(entry => !entry)) return finish('escalate', 'invalid_target')
      const identity = frame && target?.point ? {
        ref: target.ref.slice(frame.key.length), documentId: frame.documentId, observationId: frame.observationId,
        interactionEpoch: frame.interactionEpoch,
        frame: { path: frame.path, point: target.point, ancestors: ancestors!.map(entry => ({ documentId: entry!.documentId,
          observationId: entry!.observationId, interactionEpoch: entry!.interactionEpoch })) },
      } : { documentId: observation.documentId, observationId: observation.observationId, interactionEpoch: observation.interactionEpoch }
      // Choosing a dropdown option or submitting with Enter is a form write, like typing.
      const command = action.operation === 'type' || action.operation === 'select' || (action.operation === 'press_key' && action.key === 'Enter') ? 'type' : 'click'
      // The page acted on, and where a link leads: a link into a blocked site
      // is never followed.
      const urls = [observation.url]
      if (target?.destination) {
        const url = new URL(target.destination, observation.url)
        if (!['http:', 'https:'].includes(url.protocol)) return finish('escalate', 'unsupported_destination')
        urls.push(url.href)
      }
      // A sensitive option ("Delete", "Confirm order") needs approval, and the
      // prompt names the exact option that will be chosen.
      const option = action.operation === 'select' ? target?.options?.find(entry => entry.index === action.option) : undefined
      let approved = false
      for (const url of new Set(urls)) {
        const guard = evaluateGuardrail({ command, blockedSites: ports.blockedSites(), targetUrl: url,
          requiresApproval: (target?.sensitive ?? false) || looksSensitive(option?.label) ||
            (action.operation === 'press_key' && target?.enterSensitive === true) })
        if (!guard.allow) return guard.blockedSite ? blocked(guard.blockedSite) : finish('escalate', 'invalid_target')
        if (guard.needsApproval && !approved) {
          approved = await ports.approve(`${action.operation === 'press_key' ? `Press ${action.key} in ` : ''}${target?.name || action.operation}${option ? ` → ${option.label}` : ''}\n${target?.context || ''}\n${new URL(url).origin}`)
          if (!approved) return finish('cancelled', 'approval_declined')
        }
      }
      if (!live()) return stopped()
      const key = JSON.stringify(action) + ':' + stateKey(observation)
      if (progress.filter(h => h === key).length >= 2) return finish('escalate', 'no_progress')
      const actionStarted = Date.now()
      writeUncertain = true
      attempt.actionStatus = 'unknown'
      // Any thrown/unknown action result exits the loop. Never retry a possibly executed write.
      const result = await ports.act({ ...action, ...identity, deadline, approved,
        ...(action.operation === 'type' ? { text } : {}) })
        .finally(() => { attempt.actionMs = Date.now() - actionStarted })
      attempt.actionStatus = result.ok ? 'succeeded' : 'rejected'
      if (!result.ok) {
        attempt.actionCode = actionCode(result.code)
        if (result.code === 'stale_observation' && ++stale <= 2) { writeUncertain = false; continue }
        await inspectCompletion()
        return finish('escalate', result.code || 'write_outcome_unknown')
      }
      writeUncertain = false
      // Only consecutive known pre-execution rejections consume this budget.
      // Overall steps/deadline still bound a task with intermittent page changes.
      stale = 0
      scrolls = scrolling ? scrolls + 1 : 0
      progress.push(key)
      // Let navigation/autocomplete settle before spending the next inference.
      const actedObservation = observation
      pending = await settle(actedObservation, false, action.operation === 'type' ? 200 : 100)
      history.push(actionSummary(action, actedObservation, pending))
    }
    return finish('escalate', 'step_budget')
  } catch (error) {
    if (error instanceof BrowserSiteBlockedError) return blocked(error.site)
    // A deadline during a native write must still say the write may have run.
    if (!live()) return writeUncertain && Date.now() >= deadline ? finish('escalate', 'transport_or_write_outcome_unknown') : stopped()
    if (error instanceof Error && error.message === 'browser_observation_unavailable') return finish('escalate', error.message)
    if (error instanceof Error && error.message === 'observation_unavailable_after_settle') return finish('escalate', error.message)
    if (writeUncertain) await inspectCompletion()
    return finish(ports.signal.aborted ? 'cancelled' : 'escalate', ports.signal.aborted ? 'user_stopped' : 'transport_or_write_outcome_unknown')
  }
}
