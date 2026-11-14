/**
 * Deterministic turn rebuild for the eve `live-agent` mount's internal routes
 * (LIVE-AGENT-DESIGN §5.2/§5.3).
 *
 * Given a VERIFIED run token's claims, reconstruct from live DB state the turn
 * `POST /api/ai/live-agent` dispatched to eve — the system prompt, the tool
 * ceiling, the initially advertised tools, the model (the signed `model`
 * claim — the one value the route bills under), and (for the parity tests
 * against the route's own message assembly) the Block-2 context.
 * No cross-instance store: the claims are the only input besides the database.
 *
 * ── Owner derivation over caller trust ──────────────────────────────────────
 * Everything runs over a SERVICE-ROLE client (the eve runtime has no user
 * session), so RLS is not a backstop. Tenancy comes only from the verified
 * token (captureId + workspaceId + userId), and every other fact is RE-DERIVED
 * from the rows those ids name: the capture is read by (id, workspace_id), the
 * member the agent assists by (user_id, workspace_id), the capture's
 * team/project from the capture row, package visibility per id against the
 * caller (mig 238), and an explicit recipe through the recipe table's own
 * SELECT predicate. A batch token for a capture the caller does not own is
 * refused here too (the cloud route refuses it before minting — this is the
 * second layer).
 *
 * `isEvalCapture` is the claim OR the row's own flag: eval isolation can only
 * ever be tightened by what the database says, never loosened.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { jsonSchema, type Tool } from 'ai'
import { getServiceClient } from '@/lib/admin'
import { canonRegistrySection } from '@/lib/documents/canon-registry'
import { deepseekSurfacePolicy, gatewayModelSlug, type ChatModelPolicy } from '@/lib/ai/models'
import { backgroundPlanSpec, planModelFromSlug, type ChatGptPlanSpec } from '@/lib/chatgpt/plan-models'
import { gatewayTelemetryValues, type GatewayTelemetryValues } from '@/lib/ai/gateway-telemetry'
import { getLiveAgentResolverDefinition, getToolDefinition } from '@/lib/ai/tool-registry'
import { toolInputJsonSchema, type ToolInputJsonSchema } from '@/lib/ai/tool-schemas'
import { fetchWorkspaceSettings } from '@/lib/workspace-settings'
import type { ConnectedMcpServerRow } from '@/lib/mcp-client/types'
import { createLiveAgentTools } from '@/lib/live-agent/tools'
import { buildLiveAgentReadTools } from '@/lib/live-agent/read-tools'
import { personaToolSelection } from '@/lib/live-agent/read-tool-names'
import {
  serializeCaptureForPrompt,
  type Correction,
  type PendingProposal,
  type AppliedProposal,
} from '@/lib/live-agent/serialize-capture'
import {
  computeLiveAgentCeiling,
  computeLiveAgentCoreToolNames,
  liveTurnFlags,
} from '@/lib/live-agent/ceiling'
import {
  buildLiveLookupCatalog,
  liveLookupsAllowed,
  loadLiveMcpServers,
  type LiveLookupTool,
  type LiveMcpServerRow,
} from '@/lib/live-agent/mcp-lookups'
import {
  buildDynamicContext,
  buildExternalMcpContext,
  buildLiveAgentPackageBlock,
  composeLiveAgentContextBlock,
  composeLiveAgentSystemPrompt,
  liveAgentWebAccess,
  resolveLiveAgentPersona,
  type LiveAgentRecipe,
} from '@/lib/live-agent/turn-composition'
import type { LiveAgentTokenClaims } from '@/lib/live-agent/live-agent-run-token'
import { buildLiveAgentProductFactsBlock } from '@/lib/live-agent/product-facts'
import { fenceCallCapture } from '@/lib/live-agent/call-capture-fence'

/** One advertised tool, as it rides the spec wire. */
export interface LiveAgentCeilingTool {
  name: string
  description: string
  /** The tool's REAL input JSON Schema (only on `schemas: true` fetches). */
  inputSchema?: ToolInputJsonSchema
}

/**
 * The eve-facing turn spec. Prompt text + tool names/schemas + model only — NO
 * secrets and NO tenancy (that stays inside the token).
 */
export interface LiveAgentSpec {
  /** The full 7-layer system prompt — byte-identical to the cloud route's. */
  systemPrompt: string
  /**
   * The model the cloud route resolved (recipe override → the workspace's
   * 'live_agent' default) and signed into the token, as a Gateway catalog slug. The mount's model resolver wraps it in the object selection
   * form when `gatewayTelemetry` is present.
   */
  model: string
  /** The structural ceiling (staging ∪ narrowed read). Never null. */
  ceiling: string[]
  /** One entry per ceiling tool — the discoverable/callable surface. */
  ceilingTools: LiveAgentCeilingTool[]
  /** Advertised from the first model call: staging + core reads (+ get_package). */
  coreToolNames: string[]
  /** The resolved persona is assist-only (copilot turns only). */
  assistOnly: boolean
  /** The route's `pair_notes` signal: an assist-only copilot asks for a notes turn. */
  pairNotes: boolean
  /**
   * Whether this turn may use the web. False for eval captures (and under the
   * USE_GATEWAY kill switch) — the mount then shadows its web tools with
   * refusals, mirroring the cloud route leaving web_search out of the map.
   */
  webAccess: boolean
  /** Per-user Gateway attribution; absent when GATEWAY_USER_TAGGING is off. */
  gatewayTelemetry?: GatewayTelemetryValues
  /**
   * How DeepSeek is called (deepseekSurfacePolicy): thinking on for every
   * turn, live or batch (Liam, 2026-10-31: "those should be smart"). Its
   * reasoning has its own per-step allowance (turn-budget.ts), so it never
   * spends a turn's output budget. Private hosts. Absent for every other model.
   */
  modelPolicy?: ChatModelPolicy
  /**
   * Present when the turn runs on the person's own ChatGPT plan (the free
   * tier: the token's model is `chatgpt-plan/<model>`, the cloud route's
   * usageOnPlan): the mount runs every step on the plan model through the plan
   * proxy, never the Gateway, and `model` is OpenAI's slug for it (the
   * session's guard selection). No web: web search is Gateway-billed.
   */
  chatgptPlan?: ChatGptPlanSpec
}

/**
 * The capture columns the live turn reads: the cloud route's own select, plus
 * `visibility`, which the service-role rebuild needs to re-apply the
 * `captures_select` predicate that RLS applies to the route's user session.
 */
const CAPTURE_COLUMNS =
  'id, title, ai_summary, team_id, project_id, participants, user_id, package_ids, is_eval, visibility, notes_channel_id'

export interface LiveAgentCaptureRow {
  id: string
  title: string | null
  ai_summary: string | null
  team_id: string | null
  project_id: string | null
  participants: unknown
  user_id: string | null
  package_ids: string[] | null
  is_eval: boolean | null
  /** 'workspace' | 'private' (mig 223; NOT NULL, default 'workspace'). */
  visibility: string | null
  /** Set on a call's capture only (566; the server's alone): ./call-capture-fence.ts. */
  notes_channel_id?: string | null
}

export interface LiveAgentTurnState {
  supabase: SupabaseClient
  claims: LiveAgentTokenClaims
  capture: LiveAgentCaptureRow
  isEvalCapture: boolean
  currentMemberId: string | null
  currentMemberName: string | null
  isBatch: boolean
  notesRole: boolean
  writesRecord: boolean
  workspaceSettings: unknown
  recipe: LiveAgentRecipe | null
  assistOnly: boolean
  /** The capture's user_notes, trimmed ('' unless loaded for a batch turn). */
  batchUserNotes: string
  /** The attached-package manifest (null when none, batch, or not loaded). */
  packageBlock: string | null
  /** The turn is fenced on a call's capture (./call-capture-fence.ts), read from the row. */
  callCapture: boolean
}

export interface LoadTurnStateOptions {
  /** Load the attached-package manifest (live turns; the spec needs it). */
  packages?: boolean
  /** Load user_notes on a batch turn (the system prompt's last layer needs it). */
  userNotes?: boolean
  /** Override the client (tests). Defaults to the service-role client. */
  supabase?: SupabaseClient
}

/**
 * Load everything a live turn's spec/tools derive from, keyed ONLY by the
 * verified claims. Null when the capture is not in the claimed workspace, the
 * capture is private to another member, the caller is no longer a member of
 * the workspace, or a batch token names a capture the caller doesn't own.
 */
export async function loadLiveAgentTurnState(
  claims: LiveAgentTokenClaims,
  opts: LoadTurnStateOptions = {},
): Promise<LiveAgentTurnState | null> {
  const supabase = opts.supabase ?? getServiceClient()
  const { isBatch, notesRole, writesRecord } = liveTurnFlags(claims.turnType)

  const [memberRes, captureRes] = await Promise.all([
    supabase
      .from('member')
      .select('id, display_name')
      .eq('user_id', claims.userId)
      .eq('workspace_id', claims.workspaceId)
      .maybeSingle(),
    supabase
      .from('captures')
      .select(CAPTURE_COLUMNS)
      .eq('id', claims.captureId)
      .eq('workspace_id', claims.workspaceId)
      .single(),
  ])
  const capture = (captureRes.data as LiveAgentCaptureRow | null) ?? null
  if (!capture) return null

  // `captures_select` (mig 223) is `is_workspace_member(workspace_id) AND
  // (visibility = 'workspace' OR user_id = auth.uid())`. RLS is no backstop on
  // the service-role client, so re-apply the visibility half here (the member
  // check below is the other half). Re-read on every call, so a capture made
  // private mid-token stops serving another member at once. Fails closed on
  // anything but an explicit 'workspace'. Eval clones are 'private' but owned by
  // the run starter, who is the token's user, so they still pass.
  if (capture.visibility !== 'workspace' && capture.user_id !== claims.userId) return null

  // A batch run deletes the capture's pending proposals — owner-only, exactly as
  // the cloud route enforces before it ever mints the token.
  if (isBatch && capture.user_id !== claims.userId) return null

  // The member row is RE-DERIVED from (user, workspace); the claim is only the
  // mint-time snapshot, and the database wins. A MISSING row refuses the turn:
  // no service-role reads for a non-member for the rest of the token's lifetime.
  // This is a deliberate TIGHTENING over route.ts, not a mirror of it. On a
  // device token, getCurrentWorkspaceId returns the token's pinned workspace
  // with no member check, and route.ts treats a missing member row as
  // best-effort (currentMemberId null) and still runs the turn. Here the same
  // input 404s. A different id (row re-created) is only drift — logged.
  const memberRow = memberRes.data as { id?: string; display_name?: string | null } | null
  if (!memberRow?.id) {
    console.warn('[live-agent] caller is no longer a member of the token’s workspace — refusing the turn')
    return null
  }
  const currentMemberId = memberRow.id
  const currentMemberName = memberRow.display_name ?? null
  if (currentMemberId !== claims.currentMemberId) {
    console.warn('[live-agent] member drift between token and database — using the database row')
  }

  const isEvalCapture = claims.isEvalCapture || capture.is_eval === true

  let batchUserNotes = ''
  if (isBatch && opts.userNotes) {
    const { data: tx } = await supabase
      .from('captures')
      .select('user_notes')
      .eq('id', claims.captureId)
      .eq('workspace_id', claims.workspaceId)
      .single()
    batchUserNotes = ((tx as { user_notes?: string | null } | null)?.user_notes || '').trim()
  }

  const callCapture = fenceCallCapture(capture, claims.turnType)
  const packageBlock = opts.packages && !callCapture
    ? await buildLiveAgentPackageBlock(supabase, claims.userId, capture.package_ids ?? [], isBatch)
    : null

  const workspaceSettings = await fetchWorkspaceSettings(supabase, claims.workspaceId)
  const { recipe, assistOnly } = await resolveLiveAgentPersona({
    supabase,
    workspaceId: claims.workspaceId,
    recipeId: claims.recipeId,
    isEvalCapture,
    writesRecord,
    workspaceSettings,
    explicitRecipeVisibleTo: { userId: claims.userId },
  })

  return {
    supabase,
    claims,
    capture,
    isEvalCapture,
    currentMemberId,
    currentMemberName,
    isBatch,
    notesRole,
    writesRecord,
    workspaceSettings,
    recipe,
    assistOnly,
    batchUserNotes,
    packageBlock,
    callCapture,
  }
}

// ── The tool catalog ───────────────────────────────────────────────────────────

interface CatalogEntry {
  description: string
  inputSchema: ToolInputJsonSchema | null
}

let catalog: Map<string, CatalogEntry> | null = null

/**
 * name → the REAL description + input JSON Schema of every tool the live agent
 * can be granted, read off probe constructions of the two real factories
 * (createLiveAgentTools, buildLiveAgentReadTools). Both are pure constructors —
 * they only close over their arguments — so placeholder args yield the canonical
 * definitions (the same probe tool-schemas.ts runs for the registry). No name
 * is built by both factories (list_workspace_members / list_labels are the
 * registry's alone). Memoized per process; a probe THROW is logged and not
 * cached (the next call retries).
 */
export function liveAgentToolCatalog(): ReadonlyMap<string, CatalogEntry> {
  if (catalog) return catalog
  const map = new Map<string, CatalogEntry>()
  try {
    const zero = '00000000-0000-0000-0000-000000000000'
    const stub = {} as SupabaseClient
    const staging = createLiveAgentTools(zero, stub, zero, zero, null, null) as Record<string, Tool>
    const read = buildLiveAgentReadTools(zero, stub, zero) as Record<string, Tool>
    for (const [name, tool] of Object.entries({ ...staging, ...read })) {
      // Every live-agent tool carries a static string description; a (v7)
      // function-valued one would need a call-time context, so it degrades to
      // the registry fallback in describe().
      const description = typeof tool.description === 'string' ? tool.description : ''
      map.set(name, { description, inputSchema: toolInputJsonSchema(tool) })
    }
  } catch (err) {
    console.error('[live-agent] tool catalog probe failed — descriptions/schemas degraded this call:', err)
    return map
  }
  catalog = map
  return map
}

function describe(name: string, entry: CatalogEntry | undefined): string {
  return (
    entry?.description ||
    getLiveAgentResolverDefinition(name)?.description ||
    getToolDefinition(name)?.description ||
    `Live-agent tool: ${name}`
  )
}

// ── Connected-app lookups ──────────────────────────────────────────────────────

/**
 * The turn's read-only lookups in the person's connected apps (mcp-lookups.ts),
 * re-derived from the LIVE rows: none unless the token says the cloud route
 * found some AND the turn may run them (a copilot turn, not an eval capture).
 * `credentials` reads the whole row (the tool route dials the server); the
 * rows come back beside the catalog.
 */
export async function loadLiveLookupsForTurn(
  state: Pick<LiveAgentTurnState, 'supabase' | 'claims' | 'isEvalCapture'> & { callCapture?: boolean },
  opts: { credentials?: boolean } = {},
): Promise<{ lookups: LiveLookupTool[]; servers: ConnectedMcpServerRow[] }> {
  const { claims } = state
  if (claims.mcpLookups !== true || state.callCapture) return { lookups: [], servers: [] }
  if (!liveLookupsAllowed({ turnType: claims.turnType, isEvalCapture: state.isEvalCapture })) {
    return { lookups: [], servers: [] }
  }
  const servers = await loadLiveMcpServers(state.supabase, claims.userId, { ...opts, github: true })
  return { lookups: buildLiveLookupCatalog(servers as unknown as LiveMcpServerRow[]), servers }
}

/**
 * A lookup's input schema as the spec carries it: the server's raw JSON Schema
 * through the same normalizer chat's MCP tools go through (toolInputJsonSchema),
 * and only when it describes an object. Anything else rides as no schema, so
 * the eve proxy falls back to its permissive input and an odd schema can never
 * fail the model call.
 */
function lookupInputSchema(lookup: LiveLookupTool): ToolInputJsonSchema | null {
  if (!lookup.inputSchema || lookup.inputSchema.type !== 'object') return null
  try {
    return toolInputJsonSchema({ inputSchema: jsonSchema(lookup.inputSchema as Parameters<typeof jsonSchema>[0]) } as Tool)
  } catch {
    return null
  }
}

// ── The spec ─────────────────────────────────────────────────────────────────────

/**
 * Rebuild the eve-facing spec for one verified turn. Null when the turn can't
 * be rebuilt (capture gone, wrong workspace, membership revoked, non-owner
 * batch) — the route 404s.
 */
export async function rebuildLiveAgentSpec(
  claims: LiveAgentTokenClaims,
  opts: { schemas?: boolean; supabase?: SupabaseClient } = {},
): Promise<LiveAgentSpec | null> {
  const state = await loadLiveAgentTurnState(claims, {
    packages: true,
    userNotes: true,
    supabase: opts.supabase,
  })
  if (!state) return null

  // A turn on the person's own ChatGPT plan (the free tier) searches with
  // OpenAI's own web search on their plan (the live agent's plan steps run on
  // the search model, agents/live-agent/lib/chatgpt-plan-model.ts), so no
  // Gateway switch takes it away; an eval capture still has none.
  const planModel = planModelFromSlug(claims.model)
  // A call's capture reads nothing from the web (./call-capture-fence.ts).
  const webAccess = state.callCapture ? false : planModel !== null ? !state.isEvalCapture : liveAgentWebAccess(state.isEvalCapture)
  const composed = composeLiveAgentSystemPrompt({
    recipe: state.recipe,
    assistOnly: state.assistOnly,
    webAccess,
    notesRole: state.notesRole,
    isBatch: state.isBatch,
    batchUserNotes: state.batchUserNotes,
    // The riders the cloud route chose for this turn (riders.ts), signed into
    // the token: the session reads the same prompt the route composed for.
    omit: claims.omit,
  })
  // The canon registry (canon documents D1) on a live turn, last, so the
  // composed prefix above stays the one the route composed. A batch pass
  // extracts what was said and states nothing, so it reads none. '' when the
  // workspace has no canon (the frozen fixture's workspaces have none).
  const canon = state.isBatch || state.callCapture
    ? ''
    : await canonRegistrySection(state.supabase, {
        workspaceId: claims.workspaceId,
        userId: claims.userId,
        settings: state.workspaceSettings,
      })
  const systemPrompt = `${composed}${canon}`

  // The turn's connected-app lookups, re-derived from the live rows, and only
  // for a token whose route found some (so no read for anyone else).
  const { lookups } = await loadLiveLookupsForTurn(state)
  const ceiling = computeLiveAgentCeiling({
    turnType: claims.turnType,
    assistOnly: state.assistOnly,
    agentConfig: personaToolSelection(state.recipe),
    mcpLookups: lookups.map((l) => l.name),
    callCapture: state.callCapture,
  })
  const coreToolNames = computeLiveAgentCoreToolNames(ceiling, state.packageBlock !== null)

  const tools = liveAgentToolCatalog()
  const lookupByName = new Map(lookups.map((l) => [l.name, l]))
  const ceilingTools: LiveAgentCeilingTool[] = [...ceiling.ceiling].map((name) => {
    const lookup = lookupByName.get(name)
    if (lookup) {
      const inputSchema = opts.schemas ? lookupInputSchema(lookup) : null
      return { name, description: lookup.description, ...(inputSchema ? { inputSchema } : {}) }
    }
    const entry = tools.get(name)
    const inputSchema = opts.schemas ? entry?.inputSchema : null
    return { name, description: describe(name, entry), ...(inputSchema ? { inputSchema } : {}) }
  })

  // The model is the one the cloud route resolved (and bills under), signed
  // into the token — never re-resolved here, so a recipe or workspace default
  // changed mid-turn can't split what eve runs from what the usage row prices.
  const model = gatewayModelSlug(claims.model)
  const modelPolicy = deepseekSurfacePolicy(claims.model, 'on')

  // Per-user Gateway attribution. Feature 'live_agent' matches the cloud
  // route's own attribution + logUsage feature; runtime:eve splits eve-path
  // spend in the report. `?? undefined` keeps the field absent when off.
  const gatewayTelemetry =
    gatewayTelemetryValues(claims.userId, 'live_agent', {
      workspaceId: claims.workspaceId,
      runtime: 'eve',
    }) ?? undefined

  // On the person's own ChatGPT plan: the plan model at its Think reasoning on
  // every turn, as DeepSeek thinks on every turn; no Gateway attribution or
  // host routing.
  if (planModel) {
    return {
      systemPrompt,
      model: `openai/${planModel}`,
      ceiling: [...ceiling.ceiling],
      ceilingTools,
      coreToolNames,
      assistOnly: state.assistOnly,
      pairNotes: !state.isBatch && state.assistOnly,
      webAccess,
      chatgptPlan: { ...backgroundPlanSpec('think'), model: planModel, helperModel: planModel },
    }
  }

  return {
    systemPrompt,
    model,
    ceiling: [...ceiling.ceiling],
    ceilingTools,
    coreToolNames,
    assistOnly: state.assistOnly,
    pairNotes: !state.isBatch && state.assistOnly,
    webAccess,
    ...(gatewayTelemetry ? { gatewayTelemetry } : {}),
    ...(modelPolicy ? { modelPolicy } : {}),
  }
}

// ── Block 2 ──────────────────────────────────────────────────────────────────────

/**
 * The turn's cached Block-2 context — dynamic context + connected-MCP block +
 * product facts + package manifest + serialized capture state — rebuilt from
 * the claims with the SAME builders the cloud route calls. `correctionsLog` is per-turn request
 * content (never a claim), so the caller passes it in. Batch turns serialize no
 * pending proposals and no prior summary (the route deletes/nulls both so the
 * pass writes fresh). Not served over HTTP: the eve session's message is
 * assembled by the cloud route; this is that assembly's claims-driven form.
 */
export async function rebuildLiveAgentContextBlock(
  claims: LiveAgentTokenClaims,
  correctionsLog: Correction[],
  opts: { supabase?: SupabaseClient } = {},
): Promise<string | null> {
  const state = await loadLiveAgentTurnState(claims, { packages: true, supabase: opts.supabase })
  if (!state) return null
  const { supabase, capture, isBatch } = state

  const [proposalsRes, appliedRes] = await Promise.all([
    supabase
      .from('proposed_change')
      .select('id, change_type, entity_type, entity_id, display_text, title, description, reasoning, assignee_name, project_id, status_to')
      .eq('capture_id', claims.captureId)
      .eq('workspace_id', claims.workspaceId)
      .eq('status', 'pending')
      .order('sort_order'),
    supabase
      .from('proposed_change')
      .select('id, change_type, entity_type, display_text, assignee_name, status_to')
      .eq('capture_id', claims.captureId)
      .eq('workspace_id', claims.workspaceId)
      .eq('status', 'applied')
      .order('applied_at', { ascending: false })
      .limit(20),
  ])

  let projectName: string | null = null
  if (capture.project_id) {
    const { data: project } = await supabase
      .from('projects')
      .select('name')
      .eq('id', capture.project_id)
      .eq('workspace_id', claims.workspaceId)
      .single()
    projectName = (project as { name?: string } | null)?.name || null
  }

  const dynamicContext = await buildDynamicContext(
    supabase,
    { team_id: capture.team_id, participants: capture.participants },
    claims.workspaceId,
    claims.captureId,
    state.currentMemberName,
    claims.userId,
    { talks: !isBatch && !state.notesRole, callCapture: state.callCapture, endOfCall: isBatch },
  )
  const externalMcpBlock = state.callCapture
    ? ''
    : await buildExternalMcpContext(supabase, claims.userId, {
        assistOnly: state.assistOnly,
        lookups: liveLookupsAllowed({ turnType: claims.turnType, isEvalCapture: state.isEvalCapture }),
      })

  const captureState = serializeCaptureForPrompt(
    {
      title: capture.title,
      ai_summary: isBatch ? null : capture.ai_summary,
      project_id: capture.project_id,
      project_name: projectName,
      participants: capture.participants as Array<{ name?: string; email?: string }> | null,
    },
    isBatch ? [] : ((proposalsRes.data || []) as PendingProposal[]),
    correctionsLog,
    (appliedRes.data || []) as AppliedProposal[],
  )

  // The workspace's product doc (Phase 6), from the settings blob the turn
  // state already read, with the SAME builder the cloud route calls.
  const productFactsBlock = await buildLiveAgentProductFactsBlock(
    supabase,
    claims.workspaceId,
    state.workspaceSettings,
    isBatch,
  )

  return composeLiveAgentContextBlock({
    dynamicContext,
    externalMcpBlock,
    productFactsBlock,
    packageBlock: state.packageBlock,
    captureState,
  })
}
