/**
 * What the side panel's Plan and Agents sections read (chat-widgets.tsx;
 * docs/plans/always-on-agent.md decision 10, A4 slice 6). Pure, so the rules
 * are tested once here:
 *
 *   Plan     the newest `update_plan` call that went through, in the loaded
 *            messages of this conversation (the part persists with its
 *            message: no fetch). Flat cost while streaming: a message's last
 *            plan is cached by its `parts` array (a settled message keeps its
 *            reference; only the streaming one gets a new one), so a render is
 *            one map lookup per message. The same cache answers the reply
 *            renderer's "newest plan" (chat-plan-thread.ts). A plan the agent
 *            no longer recites (stale: PLAN_STALE_TURNS / PLAN_STALE_MS) or
 *            that is finished shows no count.
 *   Agents   ONLY what agents are working on now, like Claude Code's task
 *            list (Liam, 10-15: "only ones that are actively working"): the
 *            shell's shared rows (AgentWorkProvider, one `tracked_job` channel
 *            for the app: no fetch, no channel) that are queued, running or
 *            parked on a handoff. A row leaves the list the moment it settles
 *            (done, failed, stopped): no recent history, so no timer. Rows
 *            waiting on the person (needs_input, needs_review) are For you's,
 *            never listed here. Handoff children grouped under their root (a
 *            child is this conversation's when its root is), the newest first.
 *            Plus this chat's quick helpers: the newest reply's `helpers` call
 *            (quickHelperBatch, cached by its parts array), each helper listed
 *            while it works.
 */
import type { DynamicToolUIPart, ToolUIPart, UIMessage } from 'ai'
import { PLAN_STALE_MS, PLAN_STALE_TURNS, planHasOpenSteps, planStepsFrom, type PlanStep } from '@/lib/work/plan'
import { WORK_LANE_LABELS } from '@/lib/work/agent-work-lanes'
import { isOwnerFallback } from '@/lib/work/bot-owner'
import { localAgentSessionIdOf } from '@/lib/local-agent/transcript-view'
import { helpersRowModel, type HelperRowStatus } from './helpers-row'

// ── Plan ─────────────────────────────────────────────────────────────────────

/** The update_plan tool's name (the chat agent's native tool, agents/chat-agent/tools/update_plan.ts). */
export const UPDATE_PLAN_TOOL_NAME = 'update_plan'

type ToolPart = ToolUIPart | DynamicToolUIPart

/**
 * The plan an update_plan part drew: the steps of a call that went through
 * (`{ ok: true, plan }`), or null (in flight, refused, failed or unreadable).
 */
export function planStepsOfPart(part: ToolPart): PlanStep[] | null {
  const out = part.state === 'output-available' ? part.output : undefined
  if (!out || typeof out !== 'object' || (out as { ok?: unknown }).ok === false) return null
  return planStepsFrom((out as { plan?: unknown }).plan)
}

function toolNameOf(part: { type: string; toolName?: unknown }): string | null {
  if (part.type === 'dynamic-tool') return typeof part.toolName === 'string' ? part.toolName : null
  return part.type.startsWith('tool-') ? part.type.slice(5) : null
}

/** A message's last update_plan call that drew a plan. */
export interface MessagePlan {
  callId: string
  steps: PlanStep[]
}

const lastPlanByParts = new WeakMap<object, MessagePlan | null>()

/** A message's last update_plan call that drew a plan, or null. Cached by its parts array. */
export function lastPlanOf(message: Pick<UIMessage, 'role' | 'parts'>): MessagePlan | null {
  if (message.role !== 'assistant' || !Array.isArray(message.parts)) return null
  const cached = lastPlanByParts.get(message.parts)
  if (cached !== undefined) return cached
  let found: MessagePlan | null = null
  for (let i = message.parts.length - 1; i >= 0 && !found; i--) {
    const part = message.parts[i] as { type: string; toolName?: unknown; toolCallId?: unknown }
    if (toolNameOf(part) !== UPDATE_PLAN_TOOL_NAME || typeof part.toolCallId !== 'string') continue
    const steps = planStepsOfPart(part as unknown as ToolPart)
    if (steps) found = { callId: part.toolCallId, steps }
  }
  lastPlanByParts.set(message.parts, found)
  return found
}

/** The thread's newest plan: its steps and whether the agent still keeps it. */
export interface ThreadPlan {
  callId: string
  steps: PlanStep[]
  /** Abandoned: written more than PLAN_STALE_TURNS turns or PLAN_STALE_MS ago (the recitation rule). */
  stale: boolean
}

/** When a message was written (epoch ms), from its metadata, when it says. */
function messageTime(message: { metadata?: unknown }): number | null {
  const meta = message.metadata as { createdAt?: unknown } | null | undefined
  const at = meta?.createdAt
  if (typeof at === 'number' && Number.isFinite(at)) return at
  if (typeof at === 'string') {
    const t = Date.parse(at)
    return Number.isFinite(t) ? t : null
  }
  return null
}

/** The newest plan in the thread (the last update_plan that went through), or null. One cached lookup per message. */
export function newestThreadPlan(messages: readonly Pick<UIMessage, 'role' | 'parts' | 'metadata'>[], now: number = Date.now()): ThreadPlan | null {
  let turnsSince = 0
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m]
    if (message.role === 'user') {
      turnsSince++
      continue
    }
    const plan = lastPlanOf(message)
    if (!plan) continue
    const at = messageTime(message)
    const stale = turnsSince > PLAN_STALE_TURNS || (at !== null && now - at > PLAN_STALE_MS)
    return { callId: plan.callId, steps: plan.steps, stale }
  }
  return null
}

/** The steps of the newest plan in the thread, or null. */
export function newestPlanSteps(messages: readonly Pick<UIMessage, 'role' | 'parts'>[]): PlanStep[] | null {
  return newestThreadPlan(messages)?.steps ?? null
}

/** Whether the plan's toggle shows its count: a plan the agent still keeps, with a step left to do. */
export function planShowsCount(plan: Pick<ThreadPlan, 'steps' | 'stale'> | null): boolean {
  return !!plan && !plan.stale && planHasOpenSteps(plan.steps)
}

/** A plan's identity, so an unchanged plan keeps its reference across streamed renders. */
export function planKey(plan: Pick<ThreadPlan, 'steps' | 'stale'> | null): string {
  return plan ? `${plan.stale ? 's' : 'l'}|${plan.steps.map((s) => `${s.status}:${s.text}`).join('\n')}` : ''
}

// ── Agents ───────────────────────────────────────────────────────────────────

/** A shared row as the Agents widget reads it (a light row, a full one or a pushed one). */
export interface AgentWidgetRow {
  id: string
  workspace_id: string
  kind: string
  status: string
  created_at?: string | null
  /** A pushed (full) row has these; a light row may not. */
  started_at?: string | null
  source?: Record<string, unknown> | null
  agent_run_id?: string | null
  ai_team_member_id?: string | null
  parent_id?: string | null
  root_id?: string | null
  plan?: unknown
  title?: string | null
  current_step?: string | null
  teammate?: { name?: string | null } | null
}

/** Working now: nobody's turn but the agents' (never a row waiting on the person: For you shows those). */
const RUNNING: ReadonlySet<string> = new Set(['queued', 'running', 'waiting_on_child'])

/** AI work: not a sequence send or an import, which have lanes of their own. */
function isAgentKind(kind: string): boolean {
  return !(kind in WORK_LANE_LABELS)
}

/** Whether a row is agent work that is running now. */
export function isRunningAgentRow(row: Pick<AgentWidgetRow, 'kind' | 'status'>): boolean {
  return RUNNING.has(row.status) && isAgentKind(row.kind)
}

/** Whether a row is this conversation's (a helper it started). */
export function isThisConversations(row: Pick<AgentWidgetRow, 'source'>, conversationId: string | null): boolean {
  return !!conversationId && row.source?.chat_conversation_id === conversationId
}

/** A root and the handoff children working under it. */
export interface AgentWidgetGroup<T extends AgentWidgetRow = AgentWidgetRow> {
  root: T
  children: T[]
  /** This conversation's: its root is. */
  mine: boolean
}

const newestFirst = (a: AgentWidgetRow, b: AgentWidgetRow) => (b.created_at ?? '').localeCompare(a.created_at ?? '')

/**
 * The Agents widget's groups: agent work that is running now, and nothing
 * else (a row that settled is gone), each handoff child under its root (its
 * `root_id`, else its `parent_id`, when that row is listed here too; otherwise
 * it stands alone), children oldest first. The newest group first: there is
 * one chat (one-chat plan), so no conversation's work goes ahead of another's
 * here. Rows waiting on the person (needs_input, needs_review) are never
 * listed: For you shows them.
 */
export function agentWidgetGroups<T extends AgentWidgetRow>(
  rows: readonly T[] | null | undefined,
  conversationId: string | null,
): AgentWidgetGroup<T>[] {
  if (!rows) return []
  const listed = rows.filter(isRunningAgentRow)
  const byId = new Map(listed.map((r) => [r.id, r]))
  const rootIdOf = (r: T): string => {
    for (const id of [r.root_id, r.parent_id]) if (id && id !== r.id && byId.has(id)) return id
    return r.id
  }
  const groups = new Map<string, AgentWidgetGroup<T>>()
  const open = (r: T): AgentWidgetGroup<T> => ({ root: r, children: [], mine: isThisConversations(r, conversationId) })
  for (const r of listed) {
    if (rootIdOf(r) === r.id) groups.set(r.id, open(r))
  }
  for (const r of listed) {
    const rootId = rootIdOf(r)
    if (rootId === r.id) continue
    // A child whose root is itself someone's child: under the topmost group found.
    const group = groups.get(rootId) ?? groups.get(rootIdOf(byId.get(rootId)!))
    if (group) group.children.push(r)
    else groups.set(r.id, open(r))
  }
  const list = [...groups.values()]
  for (const g of list) g.children.sort((a, b) => -newestFirst(a, b))
  return list.sort((a, b) => newestFirst(a.root, b.root))
}

/** The Agents widget's rows in display order (each group's root, then its children). */
export function agentWidgetRows<T extends AgentWidgetRow>(rows: readonly T[] | null | undefined, conversationId: string | null): T[] {
  return agentWidgetGroups(rows, conversationId).flatMap((g) => [g.root, ...g.children])
}

/** How many of the rows are running now (queued, running or waiting on teammates; never one waiting on you, nor a settled one). */
export function runningCount(rows: readonly Pick<AgentWidgetRow, 'status'>[]): number {
  return rows.filter((r) => RUNNING.has(r.status)).length
}

/**
 * The Agents toggle's quiet count: "3 running", or nothing with none running.
 * What waits on the person is For you's to count, not this.
 */
export function agentsBadge(rows: readonly Pick<AgentWidgetRow, 'status'>[]): string | null {
  const running = runningCount(rows)
  return running > 0 ? `${running} running` : null
}

/** A run this young may not have its eve session yet: the steer route would refuse it (STILL_RUNNING). */
export const STEER_SESSION_GRACE_MS = 5_000

/** A local agent's turn takes a message while its session is live or idle (local-agents contract G). */
const LOCAL_AGENT_STEERABLE: ReadonlySet<string> = new Set(['queued', 'running', 'needs_input', 'needs_review'])

/**
 * Whether the person can type into the row to steer it: a running workspace
 * work run the steer route would take. Not an action's delegate run, a row the
 * Assistant shows for a bot the viewer can't reach (its chat is never
 * offered), or a run younger than STEER_SESSION_GRACE_MS (no session yet).
 * A local agent's turn (`kind: 'local_agent'`, naming its session) while its
 * session is live or idle: the steer route hands the message to the session
 * (queued on the server until the Mac takes it), so it needs no grace.
 */
export function isSteerable(
  row: Pick<AgentWidgetRow, 'kind' | 'status' | 'agent_run_id' | 'source' | 'created_at'>,
  now: number = Date.now(),
): boolean {
  if (row.kind === 'local_agent') return LOCAL_AGENT_STEERABLE.has(row.status) && localAgentSessionIdOf(row) !== null
  if (row.kind !== 'work_run' || row.status !== 'running' || !row.agent_run_id) return false
  if (isOwnerFallback(row)) return false
  if (typeof row.source?.action_id === 'string' && row.source.action_id) return false
  const at = row.created_at ? Date.parse(row.created_at) : NaN
  return !Number.isFinite(at) || now - at >= STEER_SESSION_GRACE_MS
}

const STATUS_TEXT: Record<string, string> = {
  queued: 'Queued',
  running: 'Working',
  waiting_on_child: 'Waiting on teammates',
}

export function agentStatusText(status: string): string {
  return STATUS_TEXT[status] ?? status
}

/** When a running row started (epoch ms): `started_at` when the row has it, else `created_at`. */
export function startedAtOf(row: Pick<AgentWidgetRow, 'started_at' | 'created_at'>): number | null {
  for (const at of [row.started_at, row.created_at]) {
    const t = at ? Date.parse(at) : NaN
    if (Number.isFinite(t)) return t
  }
  return null
}

/** How long something has run, short: "<1m", "4m", "1h 5m". Computed at render, never ticked at idle. */
export function elapsedText(since: number | null, now: number): string | null {
  if (since === null) return null
  const minutes = Math.floor(Math.max(0, now - since) / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

// ── Quick helpers ────────────────────────────────────────────────────────────

/** The chat agent's blocking in-turn helpers tool (agents/chat-agent/tools/helpers.ts). */
export const HELPERS_TOOL_NAME = 'helpers'

/** One quick helper of the chat's newest `helpers` call, as the Agents widget lists it. */
export interface QuickHelperRow {
  /** `<toolCallId>:<index>`. */
  id: string
  label: string
  status: HelperRowStatus
  /** What it was asked (the call's input), when the part carries it. */
  task: string | null
  /** What it returned (the final result), once the call is done. */
  result: string | null
}

/** The newest assistant message's `helpers` call. */
export interface QuickHelperBatch {
  callId: string
  /** Still running (no final result yet). */
  running: boolean
  /** "3 helpers working · 1/3 done" (helpers-row.tsx). */
  headline: string
  rows: QuickHelperRow[]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const batchByParts = new WeakMap<object, QuickHelperBatch | null>()

/** A message's last `helpers` call as a batch, or null. Cached by its parts array (flat cost while streaming). */
function helperBatchOf(message: Pick<UIMessage, 'parts' | 'metadata'>): QuickHelperBatch | null {
  if (!Array.isArray(message.parts)) return null
  const cached = batchByParts.get(message.parts)
  if (cached !== undefined) return cached
  let found: QuickHelperBatch | null = null
  for (let i = message.parts.length - 1; i >= 0; i--) {
    const part = message.parts[i] as { type: string; toolName?: unknown; toolCallId?: unknown; input?: unknown; output?: unknown }
    if (toolNameOf(part) !== HELPERS_TOOL_NAME || typeof part.toolCallId !== 'string') continue
    // The row's own reading of the part (helpers-row.tsx): snapshot, labels or results; null for a refusal or an error.
    const model = helpersRowModel(part as unknown as Parameters<typeof helpersRowModel>[0])
    if (!model) break
    const inputs = isRecord(part.input) && Array.isArray(part.input.tasks) ? part.input.tasks : []
    const results = !model.running && isRecord(part.output) && Array.isArray(part.output.results) ? part.output.results : []
    const callId = part.toolCallId
    found = {
      callId,
      running: model.running,
      headline: model.headline,
      rows: model.tasks.map((t, idx) => {
        const input = inputs[idx]
        const out = results[idx]
        return {
          id: `${callId}:${idx}`,
          label: t.label,
          status: t.status,
          task: isRecord(input) && typeof input.task === 'string' && input.task.trim() ? input.task.trim() : null,
          result: isRecord(out) && typeof out.output === 'string' && out.output.trim() ? out.output.trim() : null,
        }
      }),
    }
    break
  }
  batchByParts.set(message.parts, found)
  return found
}

/**
 * This chat's quick helpers: the NEWEST assistant message's last `helpers`
 * call (its preliminary output while it runs, its results once done), or null.
 * An older reply's call is history, not work: only the newest reply is read.
 */
export function quickHelperBatch(messages: readonly Pick<UIMessage, 'role' | 'parts' | 'metadata'>[]): QuickHelperBatch | null {
  for (let m = messages.length - 1; m >= 0; m--) {
    if (messages[m].role === 'assistant') return helperBatchOf(messages[m])
  }
  return null
}

/**
 * The quick helpers the widget lists: the ones still working while the call
 * runs (a helper that finished leaves the list, the call's headline still
 * counts it); none once the call is done.
 */
export function shownQuickHelpers(batch: QuickHelperBatch | null): QuickHelperRow[] {
  if (!batch?.running) return []
  return batch.rows.filter((r) => r.status === 'working')
}

const QUICK_STATUS_TEXT: Record<HelperRowStatus, string> = {
  working: 'Working',
  done: 'Done',
  failed: 'Failed',
  timed_out: 'Ran out of time',
}

export function quickHelperStatusText(status: HelperRowStatus): string {
  return QUICK_STATUS_TEXT[status]
}
