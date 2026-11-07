/**
 * Verified cards for the loop changes the agent can't make on its own
 * (F1, docs/plans/flows-connectors.md §2.5, "full control with safe edges"):
 *
 *   - switching on a loop with a step that sends data out of Dial8 with no
 *     card per run (needsSwitchOnCard: a webhook, a coding run), or changing
 *     what such a loop runs while it is on;
 *   - switching on someone ELSE's loop that reaches outside Dial8 or acts on
 *     its own (isRiskyFlow): it runs as its owner, so the card is theirs;
 *   - deleting a loop (the card says how many runs of history go with it);
 *   - changing a loop's owner (the card is the NEW owner's to accept).
 *
 * Each is the existing approval machinery (src/lib/safety/approvals.ts,
 * migration 335): a tool_approval row and an attention_item card in the
 * person's own queue, the stored call run once, as them, on their own Accept,
 * after every re-check there. The model can never accept one. The stored
 * call is the flow tool itself (update_flow / delete_flow /
 * transfer_flow_owner), replayed with `approvedCall`
 * (src/lib/safety/approved-call.ts), and the card records the loop's
 * definition hash: the replay refuses when the loop changed after the card
 * was made, so a card can't be accepted for a loop that was re-aimed since.
 *
 * Every other loop a person asks for is simply on (Liam, 2026-10-20): its
 * outward actions still wait on the person's card each run, and its internal
 * writes can be undone.
 */
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { FlowApprovalContext } from '@/lib/safety/approved-call'
import type { ResolvedTrustPolicy } from '@/lib/proposed-changes/trust-policy'
import { validateCondition, validateHttpPostConfig, validateRunAgentConfig, validateRunSkillConfig } from './queries'
import { resolveTrust } from './verdict-apply'
import type { FlowAction, RunSkillActionConfig } from './types'

/**
 * A step that reaches outside Dial8 or changes records on its own: an
 * http_post, a run_agent, a call_tool on a connected app (F4: even a read
 * sends its input to that app), a job on the owner's Mac (run_local_agent),
 * an act-mode skill, or a skill given the owner's connected apps. Switching
 * on someone ELSE's loop with one is the owner's card (a permission
 * boundary: it runs as them).
 */
export function isRiskyAction(action: Pick<FlowAction, 'type' | 'config'>): boolean {
  if (action.type === 'http_post' || action.type === 'run_agent' || action.type === 'call_tool' || action.type === 'run_local_agent') return true
  if (action.type !== 'run_skill') return false
  const c = action.config as RunSkillActionConfig
  return c?.mode === 'act' || (Array.isArray(c?.connections) && c.connections.length > 0)
}

/**
 * A loop is RISKY when any of its steps is (disabled ones too: enabling a
 * step is an edit, but the card should never under-describe a loop).
 */
export function isRiskyFlow(actions: ReadonlyArray<Pick<FlowAction, 'type' | 'config'>>): boolean {
  return actions.some(isRiskyAction)
}

/**
 * THE switch-on rule for a person's own loop (Liam, 2026-10-20: "If I asked
 * to create a flow and the agent created it, there's no reason for it to be
 * off"). A loop they asked for is saved ON: every outward action it takes
 * still waits on their card each run (P7: a call_tool write, a skill run's
 * connected-app write, a flow step's outward call), and its internal writes
 * are undoable. The one exception, Liam's decision: a step that sends data
 * out of Dial8 with NO card per run. A loop with one switches on only
 * through the verified switch-on card, whatever was said:
 *   - http_post: a webhook; its body leaves the moment the loop fires;
 *   - run_agent: a coding run on a GitHub repo (still behind
 *     RUN_AGENT_DISPATCH_ENABLED; kept here until coding runs ask per run);
 *   - run_local_agent (L5): a job on the owner's Mac that starts with nobody
 *     watching. Its tool calls each meet the blocking reviewer, but whether a
 *     loop may start work on their Mac at all is the person's own yes.
 * Dropping the exception is emptying this set.
 */
export const SWITCH_ON_CARD_STEP_TYPES: ReadonlySet<string> = new Set(['http_post', 'run_agent', 'run_local_agent'])

/** Whether switching this loop on takes the verified card (SWITCH_ON_CARD_STEP_TYPES; disabled steps too). */
export function needsSwitchOnCard(actions: ReadonlyArray<Pick<FlowAction, 'type'>>): boolean {
  return actions.some((a) => SWITCH_ON_CARD_STEP_TYPES.has(a.type))
}

/** JSON with every object's keys sorted, so equal values hash equal (approvals.ts canonicalJson). */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]))
    }
    return v
  }
  return JSON.stringify(sort(value ?? null)) ?? 'null'
}

/** The columns flowDefinitionHash reads. */
export interface FlowDefinition {
  trigger_type: string | null
  trigger_config: unknown
  actions: unknown
  created_by: string | null
}

/** A skill a loop runs, as the cards and the hash read it. */
export interface FlowSkill {
  name: string | null
  agent_config: unknown
  /** What the skill tells the model to do: a rewrite changes what the loop does. */
  system_prompt: string | null
}

/** The skill rows a loop's run_skill steps name: their prompts and tool configs are part of what it does. */
export async function loadFlowSkills(supabase: SupabaseClient, actions: unknown): Promise<Map<string, FlowSkill>> {
  const ids = [
    ...new Set(
      (Array.isArray(actions) ? (actions as Array<Record<string, unknown>>) : [])
        .filter((a) => a?.type === 'run_skill')
        .map((a) => ((a.config ?? {}) as { skill_id?: unknown }).skill_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ]
  const out = new Map<string, FlowSkill>()
  if (ids.length === 0) return out
  const { data } = await supabase.from('recipe').select('id, name, agent_config, system_prompt').in('id', ids)
  for (const r of (data ?? []) as Array<{ id: string; name: string | null; agent_config: unknown; system_prompt?: string | null }>) {
    out.set(r.id, { name: r.name, agent_config: r.agent_config ?? null, system_prompt: r.system_prompt ?? null })
  }
  return out
}

/**
 * What the loop IS, as one hash: its trigger, its steps (tokens included, so
 * a rotated credential counts), its owner, and each skill it runs: its prompt
 * and its agent_config (tool ceiling and context_rules). A card records it;
 * the replay recomputes it and refuses on a difference.
 */
export function flowDefinitionHash(
  flow: FlowDefinition,
  skills: ReadonlyMap<string, { agent_config: unknown; system_prompt?: string | null }>,
): string {
  const skillConfigs = [...skills.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, s]) => [id, s.agent_config ?? null, s.system_prompt ?? null])
  return createHash('sha256')
    .update(
      canonicalJson({
        trigger_type: flow.trigger_type ?? null,
        trigger_config: flow.trigger_config ?? null,
        actions: Array.isArray(flow.actions) ? flow.actions : [],
        created_by: flow.created_by ?? null,
        skills: skillConfigs,
      }),
    )
    .digest('hex')
}

/** A loop row as the cards read it. */
export interface FlowRowForCard extends FlowDefinition {
  id: string
  workspace_id: string
  name: string | null
  enabled?: boolean | null
}

/** Read one loop's definition (the hash's columns), scoped to its workspace. */
export async function loadFlowForCard(supabase: SupabaseClient, flowId: string, workspaceId: string): Promise<FlowRowForCard | null> {
  const { data } = await supabase
    .from('flow')
    .select('id, workspace_id, name, enabled, trigger_type, trigger_config, actions, created_by')
    .eq('id', flowId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  return (data as FlowRowForCard | null) ?? null
}

/** The name a person goes by in a workspace (their member display name), or a fallback. */
export async function memberName(supabase: SupabaseClient, workspaceId: string, userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null
  const { data } = await supabase
    .from('member')
    .select('user_id, display_name')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle()
  const row = data as { user_id?: string; display_name?: string | null } | null
  if (!row?.user_id) return null
  return row.display_name?.trim() || 'a member'
}

/** Who owns a loop, as the editor reads it: the owner, whether the viewer is them, and whether the viewer's takeover request waits. */
export interface FlowOwnership {
  owner: { user_id: string | null; name: string | null }
  viewer_is_owner: boolean
  takeover_pending: boolean
}

/** True when the viewer has a takeover request for this loop still waiting on a card. */
export async function takeoverPending(service: SupabaseClient, args: { workspaceId: string; flowId: string; requesterId: string }): Promise<boolean> {
  const { data } = await service
    .from('tool_approval')
    .select('id')
    .eq('workspace_id', args.workspaceId)
    .eq('tool', 'request_flow_takeover')
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .contains('context', { flow: { flow_id: args.flowId, requested_by: args.requesterId } })
    .limit(1)
  return Array.isArray(data) && data.length > 0
}

/** The editor's ownership facts for one loop (service client: the owner's display name, the pending request). */
export async function flowOwnership(
  service: SupabaseClient,
  args: { workspaceId: string; flowId: string; ownerId: string | null; viewerId: string },
): Promise<FlowOwnership> {
  const viewerIsOwner = !!args.ownerId && args.ownerId === args.viewerId
  const name = await memberName(service, args.workspaceId, args.ownerId)
  return {
    owner: { user_id: args.ownerId, name: name ?? (args.ownerId ? 'a former member' : null) },
    viewer_is_owner: viewerIsOwner,
    takeover_pending: viewerIsOwner ? false : await takeoverPending(service, { workspaceId: args.workspaceId, flowId: args.flowId, requesterId: args.viewerId }),
  }
}

/** The card a flow change raises: whose queue, the shown input, the words, the replay's check. */
export interface FlowCardRequest {
  /** The person who answers it (the requester; the new owner for a transfer). */
  userId: string
  workspaceId: string
  /** The flow tool the Accept replays. */
  toolName: 'update_flow' | 'delete_flow' | 'transfer_flow_owner' | 'request_flow_takeover'
  /** The tool's real input plus the card's display fields (the tool's schema strips those). */
  input: Record<string, unknown>
  card: { title: string; why: string }
  context: FlowApprovalContext
  conversationId?: string | null
  sideEffect: 'automation-write' | 'delete'
}

/** What the model reads after a flow card was raised (or could not be). */
export interface FlowCardOutcome {
  ok: boolean
  approval_id: string | null
  card_id: string | null
  error?: string
}

/**
 * Hold the change as the person's verified card. The approvals module is
 * loaded lazily: it imports createTools, which imports these tools.
 */
export async function raiseFlowCard(service: SupabaseClient, request: FlowCardRequest): Promise<FlowCardOutcome> {
  const { createToolApproval } = await import('@/lib/safety/approvals')
  const held = await createToolApproval(service, {
    door: 'chat',
    userId: request.userId,
    workspaceId: request.workspaceId,
    toolName: request.toolName,
    sideEffect: request.sideEffect,
    input: request.input,
    conversationId: request.conversationId ?? null,
    context: { flow: request.context },
    reason: `flow_${request.context.kind}`,
    card: request.card,
  })
  return held.ok
    ? { ok: true, approval_id: held.approvalId, card_id: held.cardId }
    : { ok: false, approval_id: null, card_id: null, error: held.error }
}

/** The replay's check: is this the stored call of an accepted card for this loop and kind? */
export function approvedFlowCard(
  approved: { tool: string; flow?: FlowApprovalContext } | undefined,
  tool: string,
  kind: FlowApprovalContext['kind'],
  flowId: string,
): FlowApprovalContext | null {
  if (!approved || approved.tool !== tool || !approved.flow) return null
  return approved.flow.kind === kind && approved.flow.flow_id === flowId ? approved.flow : null
}

/**
 * Trust, read exactly the way the verdict gate reads it (resolveTrust, with
 * the workspace's trust policy: a flow that leaves min_confidence unset
 * inherits an explicit workspace `actions.min_confidence`, and an explicit
 * workspace kill switch beats a flow's auto_apply). Auto-apply only ever
 * happens in act mode.
 */
function effectiveTrust(config: Partial<RunSkillActionConfig> | undefined, policy?: ResolvedTrustPolicy): { autoApply: boolean; minConfidence: number } {
  const resolved = resolveTrust(config?.trust, policy)
  return { autoApply: config?.mode === 'act' && resolved.auto_apply, minConfidence: resolved.min_confidence }
}

/** True when `next` lets more accepts apply on their own than `prev` (auto-apply on, or a lower bar), under the workspace's policy. */
export function raisesTrust(
  prev: Partial<RunSkillActionConfig> | undefined,
  next: Partial<RunSkillActionConfig> | undefined,
  policy?: ResolvedTrustPolicy,
): boolean {
  const a = effectiveTrust(prev, policy)
  const b = effectiveTrust(next, policy)
  if (!b.autoApply) return false
  if (!a.autoApply) return true
  return b.minConfidence < a.minConfidence
}

/**
 * A stored step's config as the shared validators would write it today, so a
 * legacy key they drop (a run_skill's old `model` pin or `runtime`, empty
 * instructions) never reads as a change. An invalid stored config stays as
 * stored (and so differs: fail toward "widening").
 */
function normalizedStoredConfig(action: FlowAction): unknown {
  const v =
    action.type === 'run_skill'
      ? validateRunSkillConfig(action.config)
      : action.type === 'http_post'
        ? validateHttpPostConfig(action.config)
        : action.type === 'run_agent'
          ? validateRunAgentConfig(action.config)
          : action.config
  return v instanceof Error ? action.config : v
}

function normalizedStoredCondition(action: FlowAction): unknown {
  const v = validateCondition(action.condition ?? null)
  return v instanceof Error ? action.condition : v
}

/**
 * How an edit of an ON loop's steps changes what it does:
 *   - 'none'          nothing that runs changed;
 *   - 'trust_lowered' only a run_skill's trust went down (fewer auto-applies):
 *                     the agent may do that freely (F1);
 *   - 'narrowing'     only report titles, delivery switches, a step switched
 *                     off, steps removed (none another step chains off), or a
 *                     trust lowering: today's chat yes, never a card;
 *   - 'widening'      anything else (a new or re-aimed step, a step switched
 *                     back on, a credential, a trust raise, a reorder).
 * The stored side is normalized through the same validators first.
 */
export type StepEditKind = 'none' | 'trust_lowered' | 'narrowing' | 'widening'

export function classifyStepEdit(
  prev: ReadonlyArray<FlowAction>,
  next: ReadonlyArray<Omit<FlowAction, 'bearer_token_encrypted'> & { bearer_token_encrypted?: string | null }>,
  tokenTouched: boolean,
  policy?: ResolvedTrustPolicy,
): StepEditKind {
  if (tokenTouched || next.length > prev.length) return 'widening'
  // Removing steps narrows only when what's left is the stored steps in their
  // stored order, and nothing left chains off a removed one (it would become a
  // root and start running, maybe out from under a disabled parent).
  const prevIndex = new Map(prev.map((a, i) => [a.id, i]))
  let last = -1
  for (const b of next) {
    const i = prevIndex.get(b.id)
    if (i === undefined || i <= last) return 'widening'
    last = i
  }
  const kept = new Set(next.map((b) => b.id))
  const removed = prev.filter((a) => !kept.has(a.id))
  if (removed.length > 0 && next.some((b) => b.parent_id && removed.some((r) => r.id === b.parent_id))) return 'widening'

  let narrowing = removed.length > 0
  let trustLowered = false
  for (const b of next) {
    const a = prev[prevIndex.get(b.id)!]
    if (a.type !== b.type) return 'widening'
    if (canonicalJson(normalizedStoredCondition(a) ?? null) !== canonicalJson(b.condition ?? null)) return 'widening'
    if ((a.parent_id ?? null) !== (b.parent_id ?? null)) return 'widening'
    const wasOn = a.enabled !== false
    const isOn = b.enabled !== false
    if (!wasOn && isOn) return 'widening'
    if (wasOn && !isOn) narrowing = true
    const ca = normalizedStoredConfig(a)
    if (a.type === 'run_skill') {
      const sa = ca as RunSkillActionConfig
      const sb = b.config as RunSkillActionConfig
      if (raisesTrust(sa, sb, policy)) return 'widening'
      // What runs, minus the cosmetic fields (trust is compared on its own above).
      const strip = (c: RunSkillActionConfig) => {
        const copy: Record<string, unknown> = { ...c }
        const deliver: Record<string, unknown> = { ...(c.deliver ?? {}) }
        delete copy.trust
        delete deliver.document_title
        delete deliver.notification
        delete deliver.document
        copy.deliver = deliver
        return copy
      }
      if (canonicalJson(strip(sa)) !== canonicalJson(strip(sb))) return 'widening'
      if (canonicalJson(sa.trust ?? null) !== canonicalJson(sb.trust ?? null)) trustLowered = true
      // Delivery read with its defaults (document and notification default on), so
      // an editor that always sends both never reads as a change.
      const delivery = (d: RunSkillActionConfig['deliver']) => ({
        document: d?.document !== false,
        notification: d?.notification !== false,
        document_title: d?.document_title ?? null,
      })
      if (canonicalJson(delivery(sa.deliver)) !== canonicalJson(delivery(sb.deliver))) narrowing = true
    } else if (canonicalJson(ca) !== canonicalJson(b.config)) {
      return 'widening'
    }
  }
  if (narrowing) return 'narrowing'
  return trustLowered ? 'trust_lowered' : 'none'
}

