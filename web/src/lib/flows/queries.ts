/**
 * Server-side helpers for the Flows feature. The runtime (Inngest function,
 * test-fire endpoint) and the REST API both go through these — single
 * place to enforce the row shape and the match-rules.
 */
import { validateDeliverConnector } from './output-connectors'
import type { SupabaseClient } from '@supabase/supabase-js'
import { findBadStepReference } from './step-data'
import { isKnownTemplatePath, templateReferences } from './template'
import type {
  ArchiveCaptureActionConfig,
  CallToolActionConfig,
  CalendarEventTriggerConfig,
  CanvasLayout,
  CaptureProcessedTriggerConfig,
  ChatMessageTriggerConfig,
  DocumentCreatedTriggerConfig,
  EmailReceivedTriggerConfig,
  ConditionGroup,
  ConditionField,
  ConditionOp,
  ConditionRule,
  EntityStatusChangeTriggerConfig,
  Flow,
  FlowBot,
  FlowAction,
  FlowActionConfig,
  FlowActionPublic,
  FlowTriggerConfig,
  FlowWithSecrets,
  HttpPostActionConfig,
  PrStatusChangedTriggerConfig,
  PrTriggerState,
  QuoteReceivedTriggerConfig,
  RunAgentActionConfig,
  RunLocalAgentActionConfig,
  RunSkillActionConfig,
  ScheduleTriggerConfig,
} from './types'
import { PR_TRIGGER_STATES } from './types'
import type {
  RunnerActionData,
  RunnerEntityData,
  RunnerInitiativeData,
  RunnerMilestoneData,
  RunnerProjectData,
} from './runner'
import { isPublicHttpUrl } from './url-guard'
import { validateCronExpression } from './cron'
import { runAtInstant, toWallTime } from './schedule'

const FLOW_FIELDS = `
  id,
  workspace_id,
  team_id,
  name,
  description,
  enabled,
  trigger_type,
  trigger_config,
  actions,
  canvas_layout,
  created_by,
  created_at,
  updated_at,
  seed_key,
  ai_team_member_id
` as const

/** Coordinate validator shared by canvas_layout sanitizing. */
function finiteXY(node: unknown): { x: number; y: number } | null {
  if (!node || typeof node !== 'object') return null
  const x = (node as Record<string, unknown>).x
  const y = (node as Record<string, unknown>).y
  if (typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)) {
    return { x, y }
  }
  return null
}

/**
 * Map a stored DB action (with the encrypted token) to its public shape —
 * the ciphertext becomes a `bearer_token_present` boolean.
 */
function toPublicAction(raw: unknown): FlowActionPublic | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  if (typeof a.id !== 'string') return null
  return {
    id: a.id,
    // Every known type passes through; only an unknown one (legacy rows) falls
    // back to http_post. archive_capture fell back too, so the editor showed an
    // archive step as an unfinished webhook and the dispatcher (which reads
    // flows through this, via toFlowWithSecrets) skipped it as incomplete.
    type:
      a.type === 'run_skill'
        ? 'run_skill'
        : a.type === 'run_agent'
          ? 'run_agent'
          : a.type === 'archive_capture'
            ? 'archive_capture'
            : a.type === 'call_tool'
              ? 'call_tool'
              : a.type === 'run_local_agent'
                ? 'run_local_agent'
                : 'http_post',
    config: (a.config ?? {}) as FlowActionConfig,
    condition: (a.condition ?? null) as ConditionGroup | null,
    // Legacy rows predate the tree fields: default parent_id null (root) and
    // enabled true (on) so existing flows keep behaving exactly as before.
    parent_id: typeof a.parent_id === 'string' && a.parent_id ? a.parent_id : null,
    enabled: a.enabled !== false,
    bearer_token_present: typeof a.bearer_token_encrypted === 'string' && !!a.bearer_token_encrypted,
  }
}

/**
 * Public-shape Flow (per-action bearer tokens redacted to booleans). Use this
 * when returning to clients.
 */
export function toPublicFlow(row: Record<string, unknown>): Flow {
  const rawActions = Array.isArray(row.actions) ? row.actions : []
  const actions = rawActions
    .map(toPublicAction)
    .filter((a): a is FlowActionPublic => a !== null)
  return {
    id: row.id as string,
    workspace_id: row.workspace_id as string,
    team_id: (row.team_id as string | null) ?? null,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    enabled: row.enabled as boolean,
    trigger_type: row.trigger_type as Flow['trigger_type'],
    trigger_config: row.trigger_config as FlowTriggerConfig,
    actions,
    canvas_layout: validateCanvasLayout(row.canvas_layout),
    created_by: row.created_by as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    // Set only for loops seeded on workspace creation (GEN-148). NULL for
    // user-created flows. Drives the "Seeded" badge + onboarding loop list.
    seed_key: (row.seed_key as string | null) ?? null,
    ai_team_member_id: (row.ai_team_member_id as string | null) ?? null,
    ...(Object.prototype.hasOwnProperty.call(row, 'bot') ? { bot: toFlowBot(row.bot) } : {}),
  }
}

/**
 * The embed every flow read that shows a loop's bot selects beside its
 * columns (FLOW_BOT_EMBED). RLS decides: a bot on a private team the reader is
 * not on embeds as null, and the editor shows its face as unknown.
 */
export const FLOW_BOT_EMBED = 'bot:ai_team_member_id(id, name, bot_character, fronts_only, is_system, system_key)'

/** An embedded teammate row → its FlowBot, or null. */
export function toFlowBot(raw: unknown): FlowBot | null {
  const r = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | null | undefined
  if (!r || typeof r.id !== 'string') return null
  return {
    id: r.id,
    name: typeof r.name === 'string' ? r.name : '',
    bot_character: typeof r.bot_character === 'string' ? r.bot_character : null,
    fronts_only: r.fronts_only === true,
    is_system: r.is_system === true,
    system_key: typeof r.system_key === 'string' ? r.system_key : null,
  }
}

/**
 * Internal-shape Flow carrying the per-action encrypted tokens. Used by the
 * dispatcher/runner only — never serialized to a client.
 */
function toFlowWithSecrets(row: Record<string, unknown>): FlowWithSecrets {
  const pub = toPublicFlow(row)
  const rawActions = Array.isArray(row.actions) ? row.actions : []
  const actions: FlowAction[] = pub.actions.map((a, i) => {
    const raw = rawActions[i] as Record<string, unknown> | undefined
    return {
      ...a,
      bearer_token_encrypted:
        raw && typeof raw.bearer_token_encrypted === 'string'
          ? raw.bearer_token_encrypted
          : null,
    }
  })
  const { actions: _omit, ...rest } = pub
  return { ...rest, actions }
}

/**
 * Sanitize a stored canvas_layout into a safe { trigger?, actions? } shape
 * with finite numeric coordinates. Pure UI data — anything malformed degrades
 * to an empty layout (the editor then uses its default positions). A legacy
 * "action" key (pre-132 single-action flows) is mapped under actions when
 * present so the editor can re-key it to the first action.
 */
export function validateCanvasLayout(raw: unknown): CanvasLayout {
  if (!raw || typeof raw !== 'object') return {}
  const src = raw as Record<string, unknown>
  const out: CanvasLayout = {}

  const trigger = finiteXY(src.trigger)
  if (trigger) out.trigger = trigger

  const actionsOut: Record<string, { x: number; y: number }> = {}
  const actionsMap = src.actions
  if (actionsMap && typeof actionsMap === 'object' && !Array.isArray(actionsMap)) {
    for (const [key, node] of Object.entries(actionsMap as Record<string, unknown>)) {
      const xy = finiteXY(node)
      if (xy) actionsOut[key] = xy
    }
  }
  // Legacy single-action key — preserve under a reserved "__legacy__" slot the
  // client maps onto actions[0]; harmless if the client ignores it.
  const legacy = finiteXY(src.action)
  if (legacy) actionsOut.__legacy__ = legacy

  if (Object.keys(actionsOut).length > 0) out.actions = actionsOut
  return out
}

/**
 * Load matching flows for an entity status-change event. Used by the
 * dispatcher. Pulls the encrypted token because the runner needs it —
 * keep this function on the server only.
 *
 * `teamId` is required for action entities (which are team-scoped); pass
 * null for workspace-scoped entities (project/initiative). When teamId is
 * null we don't filter by it. The trigger_config.entity_type discriminates.
 */
export async function findMatchingFlowsForStatusChange(
  supabase: SupabaseClient,
  args: {
    entityType: 'action' | 'project' | 'initiative' | 'milestone'
    workspaceId: string
    teamId: string | null
    fromStatusId: string | null
    toStatusId: string
  },
): Promise<FlowWithSecrets[]> {
  let q = supabase
    .from('flow')
    .select(FLOW_FIELDS)
    .eq('workspace_id', args.workspaceId)
    .eq('enabled', true)
    .eq('trigger_type', 'entity_status_change')

  if (args.teamId) q = q.eq('team_id', args.teamId)

  const { data, error } = await q

  if (error || !data) return []

  // Flow-level match in app code: entity_type must match, to_status_id must be
  // exact, and from_status_id matches if config is null OR equals the actual
  // from. Per-ACTION conditions are NOT consulted here — they're evaluated by
  // the runner against the loaded entity at fire time.
  const matches: FlowWithSecrets[] = []
  for (const row of data as Array<Record<string, unknown>>) {
    const cfg = row.trigger_config as EntityStatusChangeTriggerConfig | null
    if (!cfg) continue
    if (cfg.entity_type !== args.entityType) continue
    if (cfg.to_status_id !== args.toStatusId) continue
    if (cfg.from_status_id !== null && cfg.from_status_id !== args.fromStatusId) continue
    matches.push(toFlowWithSecrets(row))
  }
  return matches
}

/**
 * Load enabled capture_processed flows for a workspace. Used by the
 * capture-processed dispatcher. No flow-level predicate exists for this
 * trigger — per-action conditions gate at fire time. Pulls the encrypted
 * tokens; server only.
 */
export async function findMatchingFlowsForCaptureProcessed(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<FlowWithSecrets[]> {
  const { data, error } = await supabase
    .from('flow')
    .select(FLOW_FIELDS)
    .eq('workspace_id', workspaceId)
    .eq('enabled', true)
    .eq('trigger_type', 'capture_processed')

  if (error || !data) return []
  return (data as Array<Record<string, unknown>>).map(toFlowWithSecrets)
}

/**
 * Enabled pr_status_changed flows in the workspace that wait for this PR's
 * repo (case-insensitive) and its new state ('any' matches every state). The
 * GitHub webhook emits only for PRs linked to one of the workspace's actions
 * (src/lib/flows/emit-pr-status-change.ts). Server only.
 */
export async function findMatchingFlowsForPrStatusChange(
  supabase: SupabaseClient,
  args: { workspaceId: string; repoFullName: string; prState: string },
): Promise<FlowWithSecrets[]> {
  const { data, error } = await supabase
    .from('flow')
    .select(FLOW_FIELDS)
    .eq('workspace_id', args.workspaceId)
    .eq('enabled', true)
    .eq('trigger_type', 'pr_status_changed')

  if (error || !data) return []
  const repo = args.repoFullName.toLowerCase()
  return (data as Array<Record<string, unknown>>)
    .filter((row) => {
      const cfg = (row.trigger_config ?? {}) as Partial<PrStatusChangedTriggerConfig>
      if (typeof cfg.repo_full_name !== 'string' || cfg.repo_full_name.toLowerCase() !== repo) return false
      return cfg.to_state === 'any' || cfg.to_state === args.prState
    })
    .map(toFlowWithSecrets)
}

/**
 * Enabled quote_received flows in the workspace (roadmap B1): every one fires
 * for each new quote; per-action conditions gate. Server only.
 */
export async function findMatchingFlowsForQuoteReceived(supabase: SupabaseClient, workspaceId: string): Promise<FlowWithSecrets[]> {
  const { data, error } = await supabase
    .from('flow')
    .select(FLOW_FIELDS)
    .eq('workspace_id', workspaceId)
    .eq('enabled', true)
    .eq('trigger_type', 'quote_received')
  if (error || !data) return []
  return (data as Array<Record<string, unknown>>).map(toFlowWithSecrets)
}

/**
 * Enabled email_received flows OWNED by the mailbox's person in the workspace
 * whose sender filter matches (emailFromMatches): mail arriving in someone's
 * inbox fires only that person's loops. Server only.
 */
export async function findMatchingFlowsForEmailReceived(
  supabase: SupabaseClient,
  args: { workspaceId: string; ownerUserId: string; fromEmail: string | null },
): Promise<FlowWithSecrets[]> {
  const { data, error } = await supabase
    .from('flow')
    .select(FLOW_FIELDS)
    .eq('workspace_id', args.workspaceId)
    .eq('enabled', true)
    .eq('trigger_type', 'email_received')
    .eq('created_by', args.ownerUserId)
  if (error || !data) return []
  return (data as Array<Record<string, unknown>>)
    .filter((row) => emailFromMatches(((row.trigger_config ?? {}) as Partial<EmailReceivedTriggerConfig>).from, args.fromEmail))
    .map(toFlowWithSecrets)
}

/**
 * Does a sender match an email_received filter? No filter: every sender. An
 * address filter: that address exactly. A domain filter: that domain or any
 * subdomain of it. Case-insensitive. Pure.
 */
export function emailFromMatches(filter: string | null | undefined, fromEmail: string | null | undefined): boolean {
  const f = (filter ?? '').trim().toLowerCase().replace(/^@/, '')
  if (!f) return true
  const from = (fromEmail ?? '').trim().toLowerCase()
  if (!from) return false
  if (f.includes('@')) return from === f
  const domain = from.slice(from.lastIndexOf('@') + 1)
  return domain === f || domain.endsWith(`.${f}`)
}

/**
 * Enabled chat_message flows in the workspace that watch this channel, or any
 * channel. Whose message it is, the mentions and the owner's read access are
 * the dispatcher's (event-triggers.ts chatFlowFires), since they need the
 * owners' member ids. Server only.
 */
export async function findMatchingFlowsForChatMessage(
  supabase: SupabaseClient,
  args: { workspaceId: string; channelId: string },
): Promise<FlowWithSecrets[]> {
  const { data, error } = await supabase
    .from('flow')
    .select(FLOW_FIELDS)
    .eq('workspace_id', args.workspaceId)
    .eq('enabled', true)
    .eq('trigger_type', 'chat_message')
  if (error || !data) return []
  return (data as Array<Record<string, unknown>>)
    .filter((row) => {
      const cfg = (row.trigger_config ?? {}) as Partial<ChatMessageTriggerConfig>
      return cfg.channel_id === args.channelId || ((cfg.channel_id ?? null) === null && cfg.mentions_only === true)
    })
    .map(toFlowWithSecrets)
}

/**
 * Enabled document_created flows in the workspace. Which owners can see the
 * document is the dispatcher's (event-triggers.ts). Server only.
 */
export async function findMatchingFlowsForDocumentCreated(supabase: SupabaseClient, workspaceId: string): Promise<FlowWithSecrets[]> {
  const { data, error } = await supabase
    .from('flow')
    .select(FLOW_FIELDS)
    .eq('workspace_id', workspaceId)
    .eq('enabled', true)
    .eq('trigger_type', 'document_created')
  if (error || !data) return []
  return (data as Array<Record<string, unknown>>).map(toFlowWithSecrets)
}

/**
 * Load one flow (with its per-action encrypted tokens) for a dispatcher,
 * scoped to its workspace. Returns null when the flow is gone — the caller
 * treats that as "deleted between event and dispatch" and no-ops. The caller
 * must still re-verify enabled + trigger_type at dispatch time. Server only.
 */
export async function loadFlowForDispatch(
  supabase: SupabaseClient,
  flowId: string,
  workspaceId: string,
): Promise<FlowWithSecrets | null> {
  const { data, error } = await supabase
    .from('flow')
    .select(FLOW_FIELDS)
    .eq('id', flowId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  if (error || !data) return null
  return toFlowWithSecrets(data as Record<string, unknown>)
}

/**
 * Load the action data the runner needs to render the body template.
 * Returns null if the action doesn't exist (race with deletion).
 */
async function loadRunnerActionData(
  supabase: SupabaseClient,
  actionId: string,
): Promise<RunnerActionData | null> {
  const { data, error } = await supabase
    .from('actions')
    .select(`
      id,
      identifier,
      title,
      status_id,
      priority,
      project_id,
      team_id,
      workspace_id,
      workflow_state:workflow_state!status_id(name, category),
      action_assignee(member:member(id, display_name)),
      action_label(label:label(id, name))
    `)
    .eq('id', actionId)
    .single()

  if (error || !data) return null

  // Supabase returns nested relations as arrays when nullable. Normalize.
  const ws = Array.isArray(data.workflow_state) ? data.workflow_state[0] : data.workflow_state
  const assignees = (data.action_assignee || []).flatMap((row: { member: unknown }) => {
    const m = Array.isArray(row.member) ? row.member[0] : row.member
    return m ? [m as { id: string; display_name: string | null }] : []
  })
  const labels = (data.action_label || []).flatMap((row: { label: unknown }) => {
    const l = Array.isArray(row.label) ? row.label[0] : row.label
    return l ? [l as { id: string; name: string }] : []
  })

  return {
    kind: 'action',
    id: data.id,
    identifier: data.identifier,
    title: data.title,
    status_id: data.status_id,
    status_name: ws?.name ?? null,
    status_category: ws?.category ?? null,
    priority: data.priority,
    assignees,
    assignee_ids: assignees.map((a) => a.id),
    label_ids: labels.map((l) => l.id),
    labels,
    project_id: data.project_id ?? null,
    team_id: data.team_id ?? null,
    workspace_id: data.workspace_id,
  }
}

/**
 * Load the project data the runner needs to render the body template.
 * Returns null if the project doesn't exist (race with deletion).
 */
async function loadRunnerProjectData(
  supabase: SupabaseClient,
  projectId: string,
): Promise<RunnerProjectData | null> {
  const { data, error } = await supabase
    .from('projects')
    .select('id, name, description, status, workspace_id')
    .eq('id', projectId)
    .single()

  if (error || !data) return null

  return {
    kind: 'project',
    id: data.id,
    name: data.name,
    description: data.description ?? null,
    status_value: data.status,
    workspace_id: data.workspace_id,
  }
}

/**
 * Load the initiative data the runner needs to render the body template.
 * Returns null if the initiative doesn't exist (race with deletion).
 */
async function loadRunnerInitiativeData(
  supabase: SupabaseClient,
  initiativeId: string,
): Promise<RunnerInitiativeData | null> {
  const { data, error } = await supabase
    .from('initiative')
    .select('id, name, description, status, workspace_id')
    .eq('id', initiativeId)
    .single()

  if (error || !data) return null

  return {
    kind: 'initiative',
    id: data.id,
    name: data.name,
    description: data.description ?? null,
    status_value: data.status,
    workspace_id: data.workspace_id,
  }
}

/**
 * Load the milestone data the runner needs to render the body template.
 * Returns null if the milestone doesn't exist (race with deletion).
 *
 * Milestones don't have their own workspace_id column — they're scoped via
 * their parent project. We join through projects to get the workspace.
 */
async function loadRunnerMilestoneData(
  supabase: SupabaseClient,
  milestoneId: string,
): Promise<RunnerMilestoneData | null> {
  const { data, error } = await supabase
    .from('milestone')
    .select(`
      id,
      name,
      description,
      status,
      project_id,
      project:projects!project_id(workspace_id)
    `)
    .eq('id', milestoneId)
    .single()

  if (error || !data) return null

  const project = Array.isArray(data.project) ? data.project[0] : data.project
  if (!project) return null

  return {
    kind: 'milestone',
    id: data.id,
    name: data.name,
    description: data.description ?? null,
    status_value: data.status,
    project_id: data.project_id,
    workspace_id: project.workspace_id,
  }
}

/**
 * Dispatch loader by entity_type. Returns null if the entity doesn't
 * exist or if entity_type is unrecognized.
 */
export async function loadRunnerEntityData(
  supabase: SupabaseClient,
  entityType: 'action' | 'project' | 'initiative' | 'milestone',
  entityId: string,
): Promise<RunnerEntityData | null> {
  switch (entityType) {
    case 'action':
      return loadRunnerActionData(supabase, entityId)
    case 'project':
      return loadRunnerProjectData(supabase, entityId)
    case 'initiative':
      return loadRunnerInitiativeData(supabase, entityId)
    case 'milestone':
      return loadRunnerMilestoneData(supabase, entityId)
  }
}

/**
 * Validate user-supplied action_config for http_post action. Returns the
 * cleaned config on success or an Error on failure. Called from the REST
 * API on create/update.
 */
export function validateHttpPostConfig(
  raw: unknown,
): HttpPostActionConfig | Error {
  if (!raw || typeof raw !== 'object') {
    return new Error('action_config is required')
  }
  const r = raw as Record<string, unknown>
  const method = r.method
  if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') {
    return new Error('method must be POST, PUT, or PATCH')
  }
  const url = r.url
  if (typeof url !== 'string' || !url.trim()) {
    return new Error('url is required')
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return new Error('url is not a valid URL')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return new Error('url must be http(s)')
  }
  // Disallow private network targets: localhost, loopback, link-local. Shared
  // with the runner's isActionRunnable so a saved-but-unvalidated draft can't
  // fire to a private host just because the string parses (see url-guard.ts).
  if (!isPublicHttpUrl(url)) {
    return new Error('url must point to a public host')
  }

  const headers = r.headers
  const cleanHeaders: Record<string, string> = {}
  if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
      if (typeof k !== 'string' || typeof v !== 'string') continue
      // Forbid setting Authorization via headers — that goes through the
      // separate bearer_token field so we can encrypt it at rest.
      if (k.toLowerCase() === 'authorization') continue
      cleanHeaders[k] = v
    }
  }

  const bodyTemplate = typeof r.body_template === 'string' ? r.body_template : ''

  return {
    method,
    url,
    headers: cleanHeaders,
    body_template: bodyTemplate,
  }
}

/**
 * Best-effort sanitize of an http_post config for a DISABLED (draft) action.
 * Unlike validateHttpPostConfig this never rejects — a disabled action is
 * skipped at fire time, so a half-finished URL is fine. We still strip an
 * Authorization header (that path is reserved for the encrypted bearer token)
 * and coerce types so the stored shape stays consistent.
 */
function sanitizeDraftHttpConfig(raw: unknown): HttpPostActionConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const method = r.method === 'PUT' || r.method === 'PATCH' ? r.method : 'POST'
  const url = typeof r.url === 'string' ? r.url : ''
  const headers: Record<string, string> = {}
  if (r.headers && typeof r.headers === 'object' && !Array.isArray(r.headers)) {
    for (const [k, v] of Object.entries(r.headers as Record<string, unknown>)) {
      if (typeof k !== 'string' || typeof v !== 'string') continue
      if (k.toLowerCase() === 'authorization') continue
      headers[k] = v
    }
  }
  const body_template = typeof r.body_template === 'string' ? r.body_template : ''
  return { method, url, headers, body_template }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Validate user-supplied action_config for a run_skill action. Shape-level
 * only (skill_id must be a uuid, mode must be report/act) — existence of the
 * skill in the workspace is checked by the caller that has a client via
 * findMissingSkillIds, mirroring how the API route checks team_id after
 * validateActions.
 */
export function validateRunSkillConfig(raw: unknown): RunSkillActionConfig | Error {
  if (!raw || typeof raw !== 'object') {
    return new Error('action_config is required')
  }
  const r = raw as Record<string, unknown>

  if (typeof r.skill_id !== 'string' || !UUID_RE.test(r.skill_id)) {
    return new Error('skill_id must be a skill (recipe) uuid')
  }

  if (r.mode !== undefined && r.mode !== 'report' && r.mode !== 'act') {
    return new Error("mode must be 'report' or 'act'")
  }

  // The per-action `runtime` key is REMOVED (loops always run on the server):
  // any incoming `runtime` is silently dropped (never validated, never stored).
  // So is `model`: the server picks the model per run, and an old client or an
  // agent tool call that still sends one keeps working (never an error).

  const out: RunSkillActionConfig = {
    skill_id: r.skill_id,
    // Trust gradient defaults to the safe end.
    mode: r.mode === 'act' ? 'act' : 'report',
  }

  if (r.instructions !== undefined) {
    if (typeof r.instructions !== 'string') return new Error('instructions must be a string')
    if (r.instructions.trim()) out.instructions = r.instructions
  }

  if (r.deliver !== undefined) {
    if (!r.deliver || typeof r.deliver !== 'object' || Array.isArray(r.deliver)) {
      return new Error('deliver must be an object')
    }
    const d = r.deliver as Record<string, unknown>
    const deliver: NonNullable<RunSkillActionConfig['deliver']> = {}
    if (typeof d.document === 'boolean') deliver.document = d.document
    if (typeof d.notification === 'boolean') deliver.notification = d.notification
    if (typeof d.document_title === 'string' && d.document_title.trim()) {
      deliver.document_title = d.document_title
    }
    // Output connectors (F3): where the output goes, and its destination.
    const connector = validateDeliverConnector(d)
    if (connector instanceof Error) return connector
    Object.assign(deliver, connector)
    out.deliver = deliver
  }

  if (r.trust !== undefined) {
    const trust = sanitizeTrustConfig(r.trust)
    if (trust instanceof Error) return trust
    if (trust) out.trust = trust
  }

  // F4: the owner's connected apps this run may use (none by default).
  if (r.connections !== undefined && r.connections !== null) {
    const connections = validateConnectionIds(r.connections)
    if (connections instanceof Error) return connections
    if (connections.length) out.connections = connections
  }

  return out
}

/** The most connected apps one skill step may use. */
export const MAX_SKILL_CONNECTIONS = 5

/** A run_skill step's `connections`: connected_mcp_server ids, de-duplicated, at most MAX_SKILL_CONNECTIONS. */
function validateConnectionIds(raw: unknown): string[] | Error {
  if (!Array.isArray(raw)) return new Error('connections must be a list of connection ids (list_connections)')
  const ids = [...new Set(raw)]
  if (ids.some((id) => typeof id !== 'string' || !UUID_RE.test(id))) {
    return new Error('connections must be connection ids from list_connections')
  }
  if (ids.length > MAX_SKILL_CONNECTIONS) return new Error(`a skill step can use at most ${MAX_SKILL_CONNECTIONS} connected apps`)
  return ids as string[]
}

/** The largest call_tool input, as stored (a parked step's card must show all of it: approvals.ts). */
export const CALL_TOOL_INPUT_MAX_BYTES = 16_000
/** A server's own tool name, as tools/list gives it. */
const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:\/-]{0,199}$/

/**
 * Validate a call_tool action's config (F4): shape only. The connection's
 * existence, the tool being visible to the owner and the input matching the
 * tool's schema are checked by findCallToolProblems (needs a client), and
 * again when the step runs (call-tool.ts). Every template token in the input
 * must be one the context can hold (a typo is refused here, not at 3am).
 */
export function validateCallToolConfig(raw: unknown): CallToolActionConfig | Error {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return new Error('action_config is required')
  const r = raw as Record<string, unknown>
  if (typeof r.connection !== 'string' || !UUID_RE.test(r.connection)) {
    return new Error('connection must be a connection id from list_connections')
  }
  if (typeof r.tool !== 'string' || !TOOL_NAME_RE.test(r.tool)) {
    return new Error("tool must be the app's own tool name (list_connections shows each app's tools)")
  }
  const input = r.input === undefined ? {} : r.input
  if (!input || typeof input !== 'object' || Array.isArray(input)) return new Error('input must be an object')
  const bytes = new TextEncoder().encode(JSON.stringify(input)).length
  if (bytes > CALL_TOOL_INPUT_MAX_BYTES) return new Error(`input must be at most ${CALL_TOOL_INPUT_MAX_BYTES / 1000} KB`)
  for (const path of templateReferences(input)) {
    if (!isKnownTemplatePath(path)) {
      return new Error(`input: {{${path.join('.')}}} is not a value a flow has (use {{steps.<step id>.output}}, {{trigger.capture.title}}, {{entity.name}}, …)`)
    }
  }
  return { connection: r.connection, tool: r.tool, input: input as Record<string, unknown> }
}

/** A draft call_tool config: whatever is usable is kept, so a half-built step saves (and is skipped at fire time). */
function sanitizeDraftCallToolConfig(raw: unknown): CallToolActionConfig {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const input = r.input && typeof r.input === 'object' && !Array.isArray(r.input) ? (r.input as Record<string, unknown>) : {}
  const fits = new TextEncoder().encode(JSON.stringify(input)).length <= CALL_TOOL_INPUT_MAX_BYTES
  return {
    connection: typeof r.connection === 'string' ? r.connection : '',
    tool: typeof r.tool === 'string' ? r.tool.slice(0, 200) : '',
    input: fits ? input : {},
  }
}

/**
 * Whitelist + clamp a run_skill trust config (Phase 2, Workstream B). Returns
 * null when the input isn't a usable object (treated as absent → engine
 * defaults). Never trusts client-supplied values: allow_external is FORCED
 * false, min_confidence is clamped to [0,1], max_cards_per_run to [0,20].
 */
function sanitizeTrustConfig(
  raw: unknown,
): NonNullable<RunSkillActionConfig['trust']> | null | Error {
  if (raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return new Error('trust must be an object')
  }
  const t = raw as Record<string, unknown>
  const minConf =
    typeof t.min_confidence === 'number' && Number.isFinite(t.min_confidence)
      ? Math.min(1, Math.max(0, t.min_confidence))
      : 0.85
  const maxCards =
    typeof t.max_cards_per_run === 'number' && Number.isFinite(t.max_cards_per_run)
      ? Math.min(20, Math.max(0, Math.floor(t.max_cards_per_run)))
      : 3
  return {
    auto_apply: t.auto_apply === true,
    min_confidence: minConf,
    // External side effects never auto-apply in v1 — force it regardless of input.
    allow_external: false,
    max_cards_per_run: maxCards,
    // WS-2b per-loop tunable: preserve an explicit boolean so a loop can turn the
    // outreach draft card OFF and have it PERSIST. Dropping it here would let
    // resolveTrust default absent→true, making the off-switch un-settable.
    ...(typeof t.outreach_draft_cards === 'boolean'
      ? { outreach_draft_cards: t.outreach_draft_cards }
      : {}),
  }
}

/**
 * Best-effort sanitize of a run_skill config for a DISABLED/draft action —
 * same philosophy as sanitizeDraftHttpConfig: saving never blocks on an
 * incomplete action; a run_skill without a resolvable skill_id is simply not
 * runnable at fire time.
 */
function sanitizeDraftRunSkillConfig(raw: unknown): RunSkillActionConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: RunSkillActionConfig = {
    skill_id: typeof r.skill_id === 'string' ? r.skill_id : '',
    mode: r.mode === 'act' ? 'act' : 'report',
    // W-C: `runtime` removed — a draft config never carries it either (nor `model`).
  }
  if (typeof r.instructions === 'string' && r.instructions) out.instructions = r.instructions
  if (r.deliver && typeof r.deliver === 'object' && !Array.isArray(r.deliver)) {
    const d = r.deliver as Record<string, unknown>
    const deliver: NonNullable<RunSkillActionConfig['deliver']> = {}
    if (typeof d.document === 'boolean') deliver.document = d.document
    if (typeof d.notification === 'boolean') deliver.notification = d.notification
    if (typeof d.document_title === 'string' && d.document_title) {
      deliver.document_title = d.document_title
    }
    // A draft keeps a connector only when it is a valid one.
    const connector = validateDeliverConnector(d)
    if (!(connector instanceof Error)) Object.assign(deliver, connector)
    out.deliver = deliver
  }
  const trust = sanitizeTrustConfig(r.trust)
  if (trust && !(trust instanceof Error)) out.trust = trust
  const connections = r.connections === undefined ? null : validateConnectionIds(r.connections)
  if (Array.isArray(connections) && connections.length) out.connections = connections
  return out
}

/** "owner/repo" — a single slash, non-empty owner + repo segments. */
const REPO_FULL_NAME_RE = /^[^/\s]+\/[^/\s]+$/

/**
 * Validate user-supplied action_config for a run_agent action. Shape-level
 * only — the agent recipe's existence in-workspace is checked by the caller
 * that has a client (findMissingAgentIds), mirroring run_skill/findMissingSkillIds.
 *
 * agent_id + repo are REQUIRED unless use_triggering_action_context is true —
 * in that override case both are inherited from the triggering action, so an
 * empty agent_id / repo is allowed (they're resolved at fire time). instructions
 * is always optional (template-rendered task text; the agent's persona is the
 * playbook). This validator can't see the trigger type, so it accepts the
 * override shape uniformly; a schedule/capture_processed flow that leans on the
 * override with no action to inherit from is a draft the runner skips.
 */
export function validateRunAgentConfig(raw: unknown): RunAgentActionConfig | Error {
  if (!raw || typeof raw !== 'object') {
    return new Error('action_config is required')
  }
  const r = raw as Record<string, unknown>

  const useAction = r.use_triggering_action_context === true
  if (r.use_triggering_action_context !== undefined && typeof r.use_triggering_action_context !== 'boolean') {
    return new Error('use_triggering_action_context must be a boolean')
  }
  // The proactive draft-PR recipe's marker (P10 F4): its repo and agent are
  // resolved per bug, so like the action-context override it needs neither.
  if (r.attempt_small_bugs !== undefined && r.attempt_small_bugs !== true) {
    return new Error('attempt_small_bugs can only be true')
  }
  const attemptBugs = r.attempt_small_bugs === true
  // The CI fix loop's marker (P10 F7): no agent or repo of its own either.
  if (r.fix_ci !== undefined && r.fix_ci !== true) {
    return new Error('fix_ci can only be true')
  }
  const fixCi = r.fix_ci === true
  if (r.project_id !== undefined && r.project_id !== '' && (typeof r.project_id !== 'string' || !UUID_RE.test(r.project_id))) {
    return new Error('project_id must be a project uuid')
  }

  // agent_id: required uuid unless the action-context override supplies it.
  const agentId = r.agent_id
  if (agentId !== undefined && agentId !== '' && (typeof agentId !== 'string' || !UUID_RE.test(agentId))) {
    return new Error('agent_id must be an agent (recipe) uuid')
  }
  if (!useAction && !attemptBugs && !fixCi && (typeof agentId !== 'string' || !UUID_RE.test(agentId))) {
    return new Error('agent_id is required (or enable use_triggering_action_context)')
  }

  // repo: required "owner/repo" unless the override supplies it.
  const repo = r.repo
  if (repo !== undefined && repo !== '' && (typeof repo !== 'string' || !REPO_FULL_NAME_RE.test(repo))) {
    return new Error('repo must be "owner/repo"')
  }
  if (!useAction && !attemptBugs && !fixCi && (typeof repo !== 'string' || !REPO_FULL_NAME_RE.test(repo))) {
    return new Error('repo is required as "owner/repo" (or enable use_triggering_action_context)')
  }

  if (r.instructions !== undefined && typeof r.instructions !== 'string') {
    return new Error('instructions must be a string')
  }

  const out: RunAgentActionConfig = {
    agent_id: typeof agentId === 'string' ? agentId : '',
    repo: typeof repo === 'string' ? repo : '',
    instructions: typeof r.instructions === 'string' ? r.instructions : '',
  }
  if (useAction) out.use_triggering_action_context = true
  if (attemptBugs) out.attempt_small_bugs = true
  if (attemptBugs && typeof r.project_id === 'string' && r.project_id) out.project_id = r.project_id
  if (fixCi) out.fix_ci = true
  return out
}

/**
 * Best-effort sanitize of a run_agent config for a DISABLED/draft action —
 * same philosophy as sanitizeDraftRunSkillConfig: saving never blocks on an
 * incomplete action; a run_agent without a resolvable agent/repo is simply not
 * runnable at fire time.
 */
function sanitizeDraftRunAgentConfig(raw: unknown): RunAgentActionConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: RunAgentActionConfig = {
    agent_id: typeof r.agent_id === 'string' ? r.agent_id : '',
    repo: typeof r.repo === 'string' ? r.repo : '',
    instructions: typeof r.instructions === 'string' ? r.instructions : '',
  }
  if (r.use_triggering_action_context === true) out.use_triggering_action_context = true
  if (r.attempt_small_bugs === true) out.attempt_small_bugs = true
  if (r.attempt_small_bugs === true && typeof r.project_id === 'string' && UUID_RE.test(r.project_id)) out.project_id = r.project_id
  if (r.fix_ci === true) out.fix_ci = true
  return out
}

/** A run_local_agent request template's longest saved form (characters; the rendered text is clipped to the Mac's byte cap). */
export const RUN_LOCAL_AGENT_REQUEST_MAX_CHARS = 8_000

/**
 * Validate a run_local_agent config (L5): a folder the owner shared (its
 * device_folder uuid; that it is theirs and still shared is the executor's
 * check, at fire time, against their own grants), a request in words, and a
 * mode ('read' default, or 'edit').
 */
export function validateRunLocalAgentConfig(raw: unknown): RunLocalAgentActionConfig | Error {
  if (!raw || typeof raw !== 'object') return new Error('action_config is required')
  const r = raw as Record<string, unknown>
  if (typeof r.folder_id !== 'string' || !UUID_RE.test(r.folder_id)) {
    return new Error('folder_id is required: one of the folders shared on the Mac (local_agents)')
  }
  if (typeof r.request !== 'string' || !r.request.trim()) return new Error('request is required: what the job on the Mac should do, in words')
  if (r.request.length > RUN_LOCAL_AGENT_REQUEST_MAX_CHARS) {
    return new Error(`request must be at most ${RUN_LOCAL_AGENT_REQUEST_MAX_CHARS} characters`)
  }
  if (r.mode !== undefined && r.mode !== 'read' && r.mode !== 'edit') return new Error('mode must be "read" or "edit"')
  return { folder_id: r.folder_id, request: r.request.trim(), ...(r.mode === 'edit' ? { mode: 'edit' as const } : {}) }
}

/**
 * Best-effort sanitize of a run_local_agent config for a draft (the
 * canvas IS the draft): keeps what is well-formed; a step with no folder or
 * no request is simply not runnable at fire time.
 */
function sanitizeDraftRunLocalAgentConfig(raw: unknown): RunLocalAgentActionConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    folder_id: typeof r.folder_id === 'string' && UUID_RE.test(r.folder_id) ? r.folder_id : '',
    request: typeof r.request === 'string' ? r.request.slice(0, RUN_LOCAL_AGENT_REQUEST_MAX_CHARS) : '',
    ...(r.mode === 'edit' ? { mode: 'edit' as const } : {}),
  }
}

/**
 * Validate an archive_capture config (GEN-134). v1 carries no required fields —
 * the action always archives the TRIGGERING capture — so any object / null /
 * undefined normalizes to the bare shape; an optional `reason` string is kept.
 * Never rejects (nothing to be incomplete about), matching the draft-sanitizers.
 */
function validateArchiveCaptureConfig(raw: unknown): ArchiveCaptureActionConfig {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  return typeof r.reason === 'string' ? { reason: r.reason } : {}
}

/**
 * Return the run_agent agent_ids in `actions` that do NOT resolve to an agent
 * visible to this workspace (workspace-owned or is_system, category 'agent').
 * Mirrors findMissingSkillIds one-for-one, swapping category 'skill' → 'agent'.
 * Non-uuid agent_ids (drafts, or the use_triggering_action_context override
 * with an empty agent_id) are ignored — they aren't runnable and shouldn't
 * block a save. Fails CLOSED: a query error reports every id as missing.
 */
export async function findMissingAgentIds(
  supabase: SupabaseClient,
  workspaceId: string,
  actions: Array<Pick<FlowAction, 'type' | 'config'>>,
): Promise<string[]> {
  const ids = [
    ...new Set(
      actions
        .filter((a) => a.type === 'run_agent')
        .map((a) => (a.config as RunAgentActionConfig).agent_id)
        .filter((id) => typeof id === 'string' && UUID_RE.test(id)),
    ),
  ]
  if (ids.length === 0) return []

  const { data, error } = await supabase
    .from('recipe')
    .select('id')
    .in('id', ids)
    .eq('category', 'agent')
    .or(`workspace_id.eq.${workspaceId},is_system.eq.true`)

  if (error) return ids
  const found = new Set((data ?? []).map((r) => r.id as string))
  return ids.filter((id) => !found.has(id))
}

/**
 * Return the run_skill skill_ids in `actions` that do NOT resolve to a skill
 * visible to this workspace (workspace-owned or is_system, category 'skill').
 * Called by the REST API after validateActions — same pattern as the route's
 * team_id existence check. Non-uuid skill_ids (drafts) are ignored; they are
 * not runnable and shouldn't block a save. Fails CLOSED: a query error
 * reports every id as missing rather than letting an unverified flow save.
 */
export async function findMissingSkillIds(
  supabase: SupabaseClient,
  workspaceId: string,
  actions: Array<Pick<FlowAction, 'type' | 'config'>>,
): Promise<string[]> {
  const ids = [
    ...new Set(
      actions
        .filter((a) => a.type === 'run_skill')
        .map((a) => (a.config as RunSkillActionConfig).skill_id)
        .filter((id) => typeof id === 'string' && UUID_RE.test(id)),
    ),
  ]
  if (ids.length === 0) return []

  const { data, error } = await supabase
    .from('recipe')
    .select('id')
    .in('id', ids)
    .eq('category', 'skill')
    .or(`workspace_id.eq.${workspaceId},is_system.eq.true`)

  if (error) return ids
  const found = new Set((data ?? []).map((r) => r.id as string))
  return ids.filter((id) => !found.has(id))
}

/**
 * DB enum values for project_status / initiative_status / milestone_status
 * from migration 023. Single source of truth: validator membership checks
 * here, the UI's status picker, and any future tooling all import from this
 * module. **If you add a value to the Postgres enum, add it here too** —
 * there's no auto-sync; the schema-shape test (queries.schema.test.ts)
 * doesn't yet parse `CREATE TYPE ... AS ENUM` statements.
 *
 * Exported as arrays (not Sets) so the UI can iterate them directly. The
 * validator wraps them in Set for O(1) membership.
 */
export const PROJECT_STATUS_VALUES = [
  'planned',
  'active',
  'paused',
  'completed',
  'canceled',
] as const
export const INITIATIVE_STATUS_VALUES = [
  'planned',
  'active',
  'completed',
  'archived',
] as const
export const MILESTONE_STATUS_VALUES = [
  'pending',
  'in_progress',
  'completed',
] as const

const PROJECT_STATUSES = new Set<string>(PROJECT_STATUS_VALUES)
const INITIATIVE_STATUSES = new Set<string>(INITIATIVE_STATUS_VALUES)
const MILESTONE_STATUSES = new Set<string>(MILESTONE_STATUS_VALUES)

const SUPPORTED_ENTITY_TYPES = new Set([
  'action',
  'project',
  'initiative',
  'milestone',
])

function getEnumSet(entityType: string): Set<string> | null {
  switch (entityType) {
    case 'project':
      return PROJECT_STATUSES
    case 'initiative':
      return INITIATIVE_STATUSES
    case 'milestone':
      return MILESTONE_STATUSES
    default:
      return null
  }
}

/**
 * Validate user-supplied trigger_config for entity_status_change.
 *
 * The status identifier shape is entity-type-specific:
 *   - action     → workflow_state UUID (validated as non-empty string;
 *                  existence is left to the DB FK)
 *   - project    → project_status enum value
 *   - initiative → initiative_status enum value
 *   - milestone  → milestone_status enum value
 *
 * For the three enum types we validate membership here so a typo in the
 * UI or AI tool doesn't silently create a flow that can never match.
 */
export function validateStatusChangeConfig(
  raw: unknown,
): EntityStatusChangeTriggerConfig | Error {
  if (!raw || typeof raw !== 'object') {
    return new Error('trigger_config is required')
  }
  const r = raw as Record<string, unknown>

  // Default entity_type to 'action' for backward-compat with any clients
  // that haven't been updated to send it explicitly.
  const entityType =
    typeof r.entity_type === 'string' && r.entity_type ? r.entity_type : 'action'
  if (!SUPPORTED_ENTITY_TYPES.has(entityType)) {
    return new Error(
      `trigger_config.entity_type "${entityType}" not supported. Supported: ${[...SUPPORTED_ENTITY_TYPES].join(', ')}`,
    )
  }

  const from = r.from_status_id
  const to = r.to_status_id
  if (typeof to !== 'string' || !to) {
    return new Error('trigger_config.to_status_id is required')
  }
  if (from !== null && from !== undefined && typeof from !== 'string') {
    return new Error('trigger_config.from_status_id must be a string or null')
  }

  const enumSet = getEnumSet(entityType)
  if (enumSet) {
    if (!enumSet.has(to)) {
      return new Error(
        `trigger_config.to_status_id "${to}" is not a valid ${entityType}_status. Valid: ${[...enumSet].join(', ')}`,
      )
    }
    if (typeof from === 'string' && !enumSet.has(from)) {
      return new Error(
        `trigger_config.from_status_id "${from}" is not a valid ${entityType}_status. Valid: ${[...enumSet].join(', ')}`,
      )
    }
  }

  return {
    entity_type: entityType as EntityStatusChangeTriggerConfig['entity_type'],
    from_status_id: typeof from === 'string' ? from : null,
    to_status_id: to,
    // Loop-guard opt-in (flow-functions.ts statusChangeSkipReason). Only an
    // explicit `true` is kept; anything else is the default (off).
    ...(r.fire_on_agent_changes === true ? { fire_on_agent_changes: true } : {}),
  }
}

const SCHEDULE_CADENCES = new Set<ScheduleTriggerConfig['cadence']>([
  'hourly',
  'daily',
  'weekdays',
  'weekly',
  'monthly',
  'cron',
  'once',
])

/** 24h 'HH:mm' — the only time shape the schedule trigger stores. */
const SCHEDULE_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * What a write's validation knows beyond the config. `now` (a create, or an
 * edit of the trigger) turns on the checks that depend on the clock: a once
 * time in the past is refused, unless it is the stored one unchanged
 * (`storedConfig`: re-saving a finished one-time loop from the editor, which
 * always sends its trigger). A custom schedule's "runs in the next year" check
 * uses `now`, or the current time.
 */
export interface TriggerValidateOptions {
  now?: Date
  storedConfig?: unknown
}

/**
 * Validate user-supplied trigger_config for a schedule trigger. Time is
 * required for daily/weekdays/weekly/monthly; weekday only for weekly;
 * day_of_month (1-28) only for monthly; a cron expression only for cron
 * (cron.ts: at most every 15 minutes, at least once a year); run_at only for
 * once. The timezone must be a real IANA name — a typo here would silently
 * schedule in the wrong zone (Intl throws on unknown zones, so we probe it).
 */
export function validateScheduleConfig(raw: unknown, opts: TriggerValidateOptions = {}): ScheduleTriggerConfig | Error {
  if (!raw || typeof raw !== 'object') {
    return new Error('trigger_config is required')
  }
  const r = raw as Record<string, unknown>

  const cadence = r.cadence
  if (
    typeof cadence !== 'string' ||
    !SCHEDULE_CADENCES.has(cadence as ScheduleTriggerConfig['cadence'])
  ) {
    return new Error(
      `trigger_config.cadence must be one of: ${[...SCHEDULE_CADENCES].join(', ')}`,
    )
  }

  const timezone = r.timezone
  if (typeof timezone !== 'string' || !timezone) {
    return new Error('trigger_config.timezone is required (IANA name, e.g. "America/Los_Angeles")')
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
  } catch {
    return new Error(`trigger_config.timezone "${timezone}" is not a valid IANA timezone`)
  }

  const out: ScheduleTriggerConfig = {
    kind: 'schedule',
    cadence: cadence as ScheduleTriggerConfig['cadence'],
    timezone,
  }

  if (cadence === 'cron') {
    const checked = validateCronExpression(r.cron, timezone, opts.now ?? new Date())
    if (checked instanceof Error) return new Error(`trigger_config.cron: ${checked.message}`)
    out.cron = checked.cron
    return out
  }

  if (cadence === 'once') {
    const at = typeof r.run_at === 'string' ? runAtInstant(r.run_at, timezone) : null
    if (!at) {
      return new Error('trigger_config.run_at is required for a once schedule, as a date and time ("2026-12-01T15:00", in timezone)')
    }
    out.run_at = toWallTime(at, timezone)
    if (opts.now && at.getTime() <= opts.now.getTime()) {
      const stored = (opts.storedConfig ?? null) as Partial<ScheduleTriggerConfig> | null
      const unchanged =
        !!stored && stored.cadence === 'once' && stored.timezone === timezone && stored.run_at === out.run_at
      if (!unchanged) return new Error('trigger_config.run_at is in the past: pick a time from now on')
    }
    return out
  }

  if (cadence !== 'hourly') {
    if (typeof r.time !== 'string' || !SCHEDULE_TIME_RE.test(r.time)) {
      return new Error('trigger_config.time is required as 24h "HH:mm" for daily/weekdays/weekly/monthly cadences')
    }
    out.time = r.time
  }

  if (cadence === 'weekly') {
    const weekday = r.weekday
    if (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      return new Error('trigger_config.weekday must be an integer 0 (Sunday) - 6 (Saturday) for weekly cadence')
    }
    out.weekday = weekday
  }

  if (cadence === 'monthly') {
    const day = r.day_of_month
    if (typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 28) {
      return new Error('trigger_config.day_of_month must be an integer 1 - 28 for monthly cadence (every month has it)')
    }
    out.day_of_month = day
  }

  return out
}

/**
 * Validate user-supplied trigger_config for a capture_processed trigger.
 * The trigger carries no predicate (per-action conditions gate instead), so
 * any object / null / undefined normalizes to the bare `{ kind }` shape.
 */
export function validateCaptureProcessedConfig(
  raw: unknown,
): CaptureProcessedTriggerConfig | Error {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    return new Error('trigger_config must be an object or null')
  }
  return { kind: 'capture_processed' }
}

/**
 * Validate a quote_received trigger_config: like capture_processed it has no
 * predicate, so any object / null / undefined is the bare `{ kind }` shape.
 */
export function validateQuoteReceivedConfig(raw: unknown): QuoteReceivedTriggerConfig | Error {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    return new Error('trigger_config must be an object or null')
  }
  return { kind: 'quote_received' }
}

/** An address: something@domain.tld, no spaces. */
const EMAIL_ADDRESS_RE = /^[^\s@]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i
/** A domain: labels of letters, digits and hyphens with a dot-separated top level. */
const EMAIL_DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i

/**
 * Normalize an email_received sender filter: an exact address, or a domain
 * written "acme.example" or "@acme.example" (stored without the "@"),
 * lowercased. '' when empty; an Error when it is neither.
 */
export function normalizeEmailFrom(raw: unknown): string | Error {
  if (raw === undefined || raw === null) return ''
  if (typeof raw !== 'string') return new Error('trigger_config.from must be a string: an address or a domain')
  const value = raw.trim().toLowerCase()
  if (!value) return ''
  if (value.length > 254) return new Error('trigger_config.from is too long')
  if (value.startsWith('@')) {
    const domain = value.slice(1)
    return EMAIL_DOMAIN_RE.test(domain) ? domain : new Error('trigger_config.from must be an address ("ana@acme.example") or a domain ("acme.example" or "@acme.example")')
  }
  if (value.includes('@')) {
    return EMAIL_ADDRESS_RE.test(value) ? value : new Error('trigger_config.from must be an address ("ana@acme.example") or a domain ("acme.example" or "@acme.example")')
  }
  return EMAIL_DOMAIN_RE.test(value) ? value : new Error('trigger_config.from must be an address ("ana@acme.example") or a domain ("acme.example" or "@acme.example")')
}

/** True when `address` is a well-formed email address (what may ride `{{trigger.email_from}}`). */
export function isEmailAddress(address: unknown): address is string {
  return typeof address === 'string' && address.length <= 254 && EMAIL_ADDRESS_RE.test(address)
}

/**
 * Validate an email_received trigger_config: an optional sender filter
 * (normalizeEmailFrom). Nothing else: it fires for the loop owner's own
 * mailboxes only.
 */
export function validateEmailReceivedConfig(raw: unknown): EmailReceivedTriggerConfig | Error {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    return new Error('trigger_config must be an object or null')
  }
  const from = normalizeEmailFrom((raw as Record<string, unknown> | null | undefined)?.from)
  if (from instanceof Error) return from
  return from ? { kind: 'email_received', from } : { kind: 'email_received' }
}

/**
 * Validate a chat_message trigger_config: the channel it watches (a channel
 * id) or null for any channel the owner can read, and mentions_only. Any
 * channel is allowed ONLY with mentions_only: without it, the loop would run
 * on every message in the workspace. Whether the owner can read the channel
 * is checked at save (chatTriggerChannelProblem) and again at every fire.
 */
export function validateChatMessageConfig(raw: unknown): ChatMessageTriggerConfig | Error {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return new Error('trigger_config must be an object')
  const r = raw as Record<string, unknown>
  const channel = r.channel_id === undefined || r.channel_id === '' ? null : r.channel_id
  if (channel !== null && (typeof channel !== 'string' || !UUID_RE.test(channel))) {
    return new Error('trigger_config.channel_id must be a team chat channel id, or null for any channel')
  }
  const mentionsOnly = r.mentions_only === undefined ? false : r.mentions_only
  if (typeof mentionsOnly !== 'boolean') return new Error('trigger_config.mentions_only must be true or false')
  if (channel === null && !mentionsOnly) {
    return new Error('trigger_config.channel_id is required unless mentions_only is true: pick a channel, or fire only when the owner is @mentioned')
  }
  return { kind: 'chat_message', channel_id: channel as string | null, mentions_only: mentionsOnly }
}

/** Validate a document_created trigger_config: no options, the bare `{ kind }` shape. */
export function validateDocumentCreatedConfig(raw: unknown): DocumentCreatedTriggerConfig | Error {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    return new Error('trigger_config must be an object or null')
  }
  return { kind: 'document_created' }
}

/**
 * Validate a pr_status_changed trigger_config: the repo it watches
 * ("owner/repo", required) and the PR state it waits for (open, closed,
 * merged or any; default any).
 */
export function validatePrStatusChangedConfig(raw: unknown): PrStatusChangedTriggerConfig | Error {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return new Error('trigger_config must be an object')
  const r = raw as Record<string, unknown>
  const repo = typeof r.repo_full_name === 'string' ? r.repo_full_name.trim() : ''
  if (!repo || !REPO_FULL_NAME_RE.test(repo)) {
    return new Error('trigger_config.repo_full_name must be a GitHub repo as "owner/repo"')
  }
  const state = r.to_state === undefined || r.to_state === null ? 'any' : r.to_state
  if (typeof state !== 'string' || !(PR_TRIGGER_STATES as readonly string[]).includes(state)) {
    return new Error(`trigger_config.to_state must be one of ${PR_TRIGGER_STATES.join(', ')}`)
  }
  return { kind: 'pr_status_changed', repo_full_name: repo, to_state: state as PrTriggerState }
}

/**
 * Bound on offset_minutes: at most a day either side of the occurrence. A
 * larger offset would risk firing "before X" landing before the PREVIOUS
 * occurrence (for a daily/near-daily event), which the tick's skip-if-past
 * logic can't disambiguate. One day is generous for "prep me before" / "follow
 * up after" and keeps the anchor unambiguous.
 */
const CALENDAR_OFFSET_MAX_MINUTES = 24 * 60

/**
 * Validate user-supplied trigger_config for a calendar_event trigger (GEN-136).
 * The title is the anchor — a non-empty string, stored verbatim (matched
 * exact-normalized at tick time). The offset is minutes relative to the
 * occurrence start, bounded to ±1 day.
 */
export function validateCalendarEventConfig(
  raw: unknown,
): CalendarEventTriggerConfig | Error {
  if (!raw || typeof raw !== 'object') {
    return new Error('trigger_config is required')
  }
  const r = raw as Record<string, unknown>

  const title = r.event_title
  if (typeof title !== 'string' || !title.trim()) {
    return new Error('trigger_config.event_title is required (the recurring event title to anchor to)')
  }

  const offset = r.offset_minutes
  if (typeof offset !== 'number' || !Number.isFinite(offset) || !Number.isInteger(offset)) {
    return new Error('trigger_config.offset_minutes must be an integer (minutes before/after; negative = before)')
  }
  if (Math.abs(offset) > CALENDAR_OFFSET_MAX_MINUTES) {
    return new Error(`trigger_config.offset_minutes must be within ±${CALENDAR_OFFSET_MAX_MINUTES} (one day)`)
  }

  return {
    kind: 'calendar_event',
    // Store trimmed — the tick lowercases + trims both sides, but trimming on
    // write keeps the stored value clean (and matches what the UI shows).
    event_title: title.trim(),
    offset_minutes: offset,
  }
}

/**
 * Per-trigger-type config validation dispatch — the single entry point the
 * REST API uses so a new trigger type can't be created with an unvalidated
 * config. pr_status_changed fires from the GitHub webhook
 * (flowDispatchOnPrStatusChange) and quote_received from the website quote
 * intake (flowDispatchOnQuoteReceived); the canvas editor can't build
 * quote_received yet, so the REST routes still refuse it while chat's
 * create_flow / update_flow take it. email_received, chat_message and
 * document_created (the owner's own mail, chat and documents:
 * event-triggers.ts) are built in both. `opts` carries the clock-dependent
 * checks of a write (TriggerValidateOptions).
 */
export function validateTriggerConfig(
  triggerType: string,
  raw: unknown,
  opts: TriggerValidateOptions = {},
): FlowTriggerConfig | Error {
  switch (triggerType) {
    case 'entity_status_change':
      return validateStatusChangeConfig(raw)
    case 'schedule':
      return validateScheduleConfig(raw, opts)
    case 'capture_processed':
      return validateCaptureProcessedConfig(raw)
    case 'calendar_event':
      return validateCalendarEventConfig(raw)
    case 'pr_status_changed':
      return validatePrStatusChangedConfig(raw)
    case 'quote_received':
      return validateQuoteReceivedConfig(raw)
    case 'email_received':
      return validateEmailReceivedConfig(raw)
    case 'chat_message':
      return validateChatMessageConfig(raw)
    case 'document_created':
      return validateDocumentCreatedConfig(raw)
    default:
      return new Error(`trigger_type "${triggerType}" is not supported`)
  }
}

// ──────────────────────────────────────────────────────────────────
// Condition + actions validation
// ──────────────────────────────────────────────────────────────────

const CONDITION_FIELDS = new Set<ConditionField>([
  'label',
  'priority',
  'assignee',
  'project',
  'team',
  'from_status',
])

const CONDITION_OPS = new Set<ConditionOp>([
  'is',
  'is_not',
  'in',
  'not_in',
  'is_set',
  'is_not_set',
])

/** Ops that require a single scalar string value. */
const SCALAR_OPS = new Set<ConditionOp>(['is', 'is_not'])
/** Ops that require a non-empty string[] value. */
const ARRAY_OPS = new Set<ConditionOp>(['in', 'not_in'])
/** Ops that take no value. */
const NULLARY_OPS = new Set<ConditionOp>(['is_set', 'is_not_set'])

/** Valid numeric priority values (action priority enum, 0..4). */
const PRIORITY_VALUES = new Set(['0', '1', '2', '3', '4'])

/**
 * Validate a single condition rule. Returns the cleaned rule or an Error.
 * Rejects unknown fields/ops and value shapes that don't fit the op, so a
 * typo can never create a silently-true (or silently-false) gate.
 */
function validateConditionRule(raw: unknown): ConditionRule | Error {
  if (!raw || typeof raw !== 'object') return new Error('condition rule must be an object')
  const r = raw as Record<string, unknown>
  const field = r.field
  if (typeof field !== 'string' || !CONDITION_FIELDS.has(field as ConditionField)) {
    return new Error(`condition rule field "${String(field)}" is not supported`)
  }
  const op = r.op
  if (typeof op !== 'string' || !CONDITION_OPS.has(op as ConditionOp)) {
    return new Error(`condition rule op "${String(op)}" is not supported`)
  }

  let value: string | string[] | null = null
  if (NULLARY_OPS.has(op as ConditionOp)) {
    value = null
  } else if (SCALAR_OPS.has(op as ConditionOp)) {
    if (typeof r.value !== 'string' || !r.value) {
      return new Error(`condition rule with op "${op}" requires a value`)
    }
    value = r.value
  } else if (ARRAY_OPS.has(op as ConditionOp)) {
    if (!Array.isArray(r.value) || r.value.length === 0) {
      return new Error(`condition rule with op "${op}" requires a non-empty list value`)
    }
    const vals = r.value.filter((v): v is string => typeof v === 'string' && !!v)
    if (vals.length === 0) {
      return new Error(`condition rule with op "${op}" requires string values`)
    }
    value = vals
  }

  // Priority values must be the numeric enum (0..4) as strings.
  if (field === 'priority' && value !== null) {
    const vals = Array.isArray(value) ? value : [value]
    for (const v of vals) {
      if (!PRIORITY_VALUES.has(v)) {
        return new Error(`condition priority value "${v}" must be 0-4`)
      }
    }
  }

  return { field: field as ConditionField, op: op as ConditionOp, value }
}

/**
 * Validate a user-supplied condition group. undefined/null => null (the
 * action always runs). A group with no rules also normalizes to null.
 */
export function validateCondition(raw: unknown): ConditionGroup | null | Error {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object') return new Error('condition must be an object or null')
  const g = raw as Record<string, unknown>
  const match = g.match === 'any' ? 'any' : g.match === 'all' ? 'all' : null
  if (!match) return new Error("condition.match must be 'all' or 'any'")
  if (!Array.isArray(g.rules)) return new Error('condition.rules must be an array')
  if (g.rules.length === 0) return null
  const rules: ConditionRule[] = []
  for (const raw of g.rules) {
    const rule = validateConditionRule(raw)
    if (rule instanceof Error) return rule
    rules.push(rule)
  }
  return { match, rules }
}

/**
 * Ceiling on ENABLED run_skill actions per flow. Each one holds an LLM call
 * for up to 240s (run-skill.ts EXECUTION_TIMEOUT_MS; a verdict run up to 480s),
 * and a fire executes the WHOLE flow inside one invocation (/api/inngest sets
 * maxDuration = 600, the test-fire route 300). Two prose skills (≤480s of LLM
 * wall time) plus http_post actions (5s timeout each) fit; a third could
 * exhaust the budget mid-run — and an Inngest step that dies mid-flow is not
 * memoized, so the retry would re-bill every LLM call and re-deliver
 * documents/notifications from the first partial pass. A run that no longer
 * fits its minimum wall fails before it starts (run-skill.ts wallWithinDeadline).
 * Disabled run_skill actions don't count: they never execute, so drafts stay
 * saveable.
 */
export const MAX_ENABLED_RUN_SKILL_ACTIONS = 2

/**
 * Ceiling on ENABLED run_agent actions per flow. Unlike MAX_ENABLED_RUN_SKILL_ACTIONS
 * this is NOT a step-budget guard: a run_agent dispatch is instantaneous (a row
 * insert + an event emit, no LLM hold), and the real budget protection lives
 * downstream in agentRunExecute's per-workspace sandbox concurrency cap (2). This
 * cap exists for BLAST-RADIUS: dispatching a sandboxed coding agent that checks
 * out a repo and opens a PR is high-consequence, so one enabled run_agent per
 * flow in v1 keeps a single mis-configured loop from opening a swarm of PRs.
 * Disabled run_agent actions don't count: they never execute, so drafts stay
 * saveable.
 */
export const MAX_ENABLED_RUN_AGENT_ACTIONS = 1

/**
 * Ceiling on ENABLED run_local_agent actions per flow (L5), for blast radius
 * like run_agent's: one fire starts at most one job on the owner's Mac.
 */
export const MAX_ENABLED_RUN_LOCAL_AGENT_ACTIONS = 1

/**
 * The trigger/action cross-check every writer runs (the REST create and
 * update routes, and chat's create_flow / update_flow): an archive_capture
 * archives the capture that fired the flow, so it needs a capture_processed
 * trigger. On any other trigger there is no capture to archive. Returns the
 * first offending action's index and the reason, or null. Pure.
 */
export function findTriggerActionMismatch(
  triggerType: string,
  actions: ReadonlyArray<{ type?: unknown }>,
): { index: number; message: string } | null {
  if (triggerType === 'capture_processed') return null
  const index = actions.findIndex((a) => a?.type === 'archive_capture')
  if (index < 0) return null
  return {
    index,
    message: 'archive_capture archives the capture that fired the flow, so it needs a capture_processed trigger',
  }
}

/**
 * Validate a user-supplied actions[] array. Each action is validated per its
 * type (http_post | run_skill) with its (optional) condition. Actions form a
 * TREE: each carries a `parent_id` (the id of the action it chains off, or
 * null = chains off the trigger) and an `enabled` flag (default true).
 * Returns the cleaned actions with stable ids assigned (preserving provided
 * ids) — WITHOUT the bearer token, which the route handles separately (it
 * must be encrypted, never stored plaintext, and merged on PATCH).
 *
 * parent_id sanitizing: a parent_id that doesn't reference another action in
 * the same array is coerced to null (treated as a root). Cycles are detected
 * and rejected so the tree is always well-formed and the runner can't loop.
 */
export function validateActions(
  raw: unknown,
): Array<Omit<FlowAction, 'bearer_token_encrypted'>> | Error {
  if (!Array.isArray(raw)) return new Error('actions must be an array')
  if (raw.length === 0) return new Error('a flow must have at least one action')

  // First pass: validate each action's own fields and assign a stable id.
  type Clean = Omit<FlowAction, 'bearer_token_encrypted'>
  const out: Clean[] = []
  const rawParents: Array<string | null> = []
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i]
    if (!a || typeof a !== 'object') return new Error(`action ${i + 1} must be an object`)
    const r = a as Record<string, unknown>
    if (
      r.type !== undefined &&
      r.type !== 'http_post' &&
      r.type !== 'run_skill' &&
      r.type !== 'run_agent' &&
      r.type !== 'archive_capture' &&
      r.type !== 'call_tool' &&
      r.type !== 'run_local_agent'
    ) {
      return new Error(
        `action ${i + 1}: type must be "http_post", "run_skill", "run_agent", "archive_capture", "call_tool", or "run_local_agent"`,
      )
    }
    const type =
      r.type === 'run_skill'
        ? ('run_skill' as const)
        : r.type === 'run_agent'
          ? ('run_agent' as const)
          : r.type === 'archive_capture'
            ? ('archive_capture' as const)
            : r.type === 'call_tool'
              ? ('call_tool' as const)
              : r.type === 'run_local_agent'
                ? ('run_local_agent' as const)
                : ('http_post' as const)
    const enabled = r.enabled !== false
    // Saving never blocks on an incomplete action — the canvas IS the draft.
    // We try the strict per-type validator; if it passes we keep the cleaned
    // config, otherwise we keep a sanitized draft. An incomplete action (no
    // usable URL / no resolvable skill) is simply skipped at fire time by the
    // runner, so a half-built action can't error a live flow. This applies
    // whether or not the action is enabled — `enabled` only controls subtree
    // pruning, not save-ability.
    let config: FlowActionConfig
    if (type === 'run_agent') {
      const validated = validateRunAgentConfig(r.config)
      config = validated instanceof Error ? sanitizeDraftRunAgentConfig(r.config) : validated
    } else if (type === 'run_skill') {
      const validated = validateRunSkillConfig(r.config)
      config = validated instanceof Error ? sanitizeDraftRunSkillConfig(r.config) : validated
    } else if (type === 'archive_capture') {
      // Always-valid, no required fields — normalizes to the bare shape.
      config = validateArchiveCaptureConfig(r.config)
    } else if (type === 'call_tool') {
      const validated = validateCallToolConfig(r.config)
      config = validated instanceof Error ? sanitizeDraftCallToolConfig(r.config) : validated
    } else if (type === 'run_local_agent') {
      const validated = validateRunLocalAgentConfig(r.config)
      config = validated instanceof Error ? sanitizeDraftRunLocalAgentConfig(r.config) : validated
    } else {
      const validated = validateHttpPostConfig(r.config)
      config = validated instanceof Error ? sanitizeDraftHttpConfig(r.config) : validated
    }
    const condition = validateCondition(r.condition)
    if (condition instanceof Error) return new Error(`action ${i + 1}: ${condition.message}`)
    const id = typeof r.id === 'string' && r.id ? r.id : crypto.randomUUID()
    rawParents.push(typeof r.parent_id === 'string' && r.parent_id ? r.parent_id : null)
    out.push({ id, type, config, condition, parent_id: null, enabled })
  }

  // Runaway-cost guard: see MAX_ENABLED_RUN_SKILL_ACTIONS. The cap exists because
  // a SERVER run holds an LLM call inside the 600s Inngest step budget (two ≤240s
  // runs fit; a third risks exhaustion + re-bill on retry). Every enabled
  // run_skill action counts.
  const enabledSkillRuns = out.filter(
    (a) => a.type === 'run_skill' && a.enabled,
  ).length
  if (enabledSkillRuns > MAX_ENABLED_RUN_SKILL_ACTIONS) {
    return new Error(
      `a flow can have at most ${MAX_ENABLED_RUN_SKILL_ACTIONS} enabled gateway run_skill actions — disable or remove the extras`,
    )
  }

  // Blast-radius guard: see MAX_ENABLED_RUN_AGENT_ACTIONS (independent counter).
  const enabledAgentRuns = out.filter((a) => a.type === 'run_agent' && a.enabled).length
  if (enabledAgentRuns > MAX_ENABLED_RUN_AGENT_ACTIONS) {
    return new Error(
      `a flow can have at most ${MAX_ENABLED_RUN_AGENT_ACTIONS} enabled run_agent action${MAX_ENABLED_RUN_AGENT_ACTIONS === 1 ? '' : 's'} — disable or remove the extras`,
    )
  }

  // Blast-radius guard: see MAX_ENABLED_RUN_LOCAL_AGENT_ACTIONS (independent counter).
  const enabledMacJobs = out.filter((a) => a.type === 'run_local_agent' && a.enabled).length
  if (enabledMacJobs > MAX_ENABLED_RUN_LOCAL_AGENT_ACTIONS) {
    return new Error(
      `a flow can have at most ${MAX_ENABLED_RUN_LOCAL_AGENT_ACTIONS} enabled run_local_agent action — disable or remove the extras`,
    )
  }

  // Second pass: resolve parent_id against the assigned id set; unknown parents
  // become roots (null). Reject duplicate ids — the tree keys on them.
  const ids = new Set<string>()
  for (const a of out) {
    if (ids.has(a.id)) return new Error(`duplicate action id "${a.id}"`)
    ids.add(a.id)
  }
  for (let i = 0; i < out.length; i++) {
    const p = rawParents[i]
    out[i].parent_id = p && ids.has(p) && p !== out[i].id ? p : null
  }

  // Reject cycles: every node must reach a root (null) by following parent_id.
  const byId = new Map(out.map((a) => [a.id, a]))
  for (const start of out) {
    const seen = new Set<string>()
    let cur: Clean | undefined = start
    while (cur && cur.parent_id) {
      if (seen.has(cur.id)) return new Error('actions form a cycle via parent_id')
      seen.add(cur.id)
      cur = byId.get(cur.parent_id)
    }
  }

  // F4 data passing: a step may use only the output of a step it chains off,
  // which always runs before it (step-data.ts). Refused here, not at fire time.
  const badRef = findBadStepReference(out)
  if (badRef) return new Error(`action ${badRef.index + 1}: ${badRef.message}`)

  return out
}
