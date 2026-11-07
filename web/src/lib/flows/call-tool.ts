/**
 * The call_tool step (F4, docs/plans/flows-connectors.md §2.2 and §2.3): one
 * tool on one of the flow OWNER's connected apps, with an input rendered from
 * the trigger and the earlier steps' outputs.
 *
 * When it runs (createCallToolExecutor), in order:
 *   1. the kill switch: autonomy off, nothing runs;
 *   2. the connection is the owner's, switched on, and the tool is one they
 *      let the agent see (P5's allow-list and switches: isMcpToolHidden);
 *   3. the input renders STRICTLY (a missing reference fails the step and
 *      the run says why: template.ts renderStrict);
 *   4. the rendered input matches the tool's own schema (tool-input-schema.ts);
 *   5. the input-aware rule (mcp-client/input-policy.ts) decides:
 *        read   it runs;
 *        inert  it runs, and the run's summary (and so the digest) says so;
 *        ask    the run PARKS: the exact call is held as the owner's
 *               approval (approvals.ts, door 'flow_step': the tool_approval
 *               row, its input hash, its attention_item card), to run once,
 *               as them, on their Accept; the steps after it wait. Posts and
 *               other public content are always this, whatever trust the
 *               loop has. The trust authority says so: an unattended caller's
 *               outward call on a FLOW STEP resolves to ask (a card), never
 *               to a silent run (caller.ts decideAction, `flowStep`).
 *   The brakes stay: the approval caps (20 per person, and 5 per run, the
 *   run standing in for the conversation), the 24-hour expiry, the kill
 *   switch at accept time and FLOW_TRIGGER_MAX_DEPTH on what the run fires.
 *
 * A step's output is the app's own text (another service wrote it), kept
 * redacted and capped (step-data.ts), and the run is marked as having read
 * outside text, the same flag P6's provenance reads (run-outside-reads.ts).
 *
 * Saving a flow (findCallToolProblems) checks the same things the run checks,
 * minus what only a fire knows: the connection, the tool, and the templated
 * input against the tool's schema. A skill step's `connections` are checked
 * to be the owner's too.
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import { callToolByServerId, McpTokenExpiredError } from '@/lib/mcp-client'
import { mcpToolRequiresApproval } from '@/lib/mcp-client/approval-policy'
import { connectorCallPolicy, type ConnectorCallDecision } from '@/lib/mcp-client/input-policy'
import { mcpServerSlug, namespacedToolName } from '@/lib/mcp-client/adapter'
import { connectionProblem, loadOwnerConnection, mcpContentText, toolOf } from '@/lib/mcp-client/owner-connection'
import { GITHUB_INTEGRATION_SERVER_ID, isGitHubSignInRefused, loadGitHubIntegrationServer, shadowsGitHubIntegration } from '@/lib/mcp-client/github-integration'
import type { ConnectedMcpServerRow } from '@/lib/mcp-client/types'
import type { createToolApproval } from '@/lib/safety/approvals'
import type { FlowStepApprovalContext } from '@/lib/safety/approved-call'
import { decideAction } from '@/lib/safety/caller'
import { classifyToolRead } from '@/lib/safety/outside-text'
import { AGENT_PAUSED_REASON, isAgentPaused } from '@/lib/work/agent-paused'
import { connectorCardCopy, connectorRunLine } from './connector-card'
import { buildTemplateContext, renderInputStrict } from './template'
import { checkToolInputAtRun, checkToolInputAtSave } from './tool-input-schema'
import type { CallToolExecutor, CallToolExecutionResult } from './runner'
import type { CallToolActionConfig, FlowAction, RunSkillActionConfig } from './types'

export type { FlowStepApprovalContext }
export { connectionProblem, loadOwnerConnection, mcpContentText, toolOf }

/**
 * The owner's connection a reference names: its id, its display name (any
 * case) or its slug (the `<slug>` in mcp__<slug>__<tool>). Null when none,
 * or when a name matches more than one (the caller asks for the id).
 *
 * Their GitHub integration counts as one (github-integration.ts), by its id,
 * "GitHub", or the integration account's own id (the one list_connections
 * shows): one GitHub connection, not a second row. An app of theirs named
 * GitHub keeps the name, as it does in chat.
 */
export async function resolveOwnerConnection(
  supabase: SupabaseClient,
  ownerUserId: string,
  ref: string,
): Promise<{ id: string; name: string } | null> {
  const key = ref.trim()
  if (!key) return null
  const { data, error } = await supabase.from('connected_mcp_server').select('id, display_name').eq('user_id', ownerUserId)
  if (error || !data) return null
  const rows = [...(data as Array<{ id: string; display_name: string }>)]
  const github = await loadGitHubIntegrationServer(supabase, ownerUserId)
  if (github) {
    if (key === GITHUB_INTEGRATION_SERVER_ID || key === github.github_account_id) return { id: github.id, name: github.display_name }
    if (!shadowsGitHubIntegration(rows, mcpServerSlug)) rows.push({ id: github.id, display_name: github.display_name })
  }
  const byId = rows.find((r) => r.id === key)
  if (byId) return { id: byId.id, name: byId.display_name }
  const lower = key.toLowerCase()
  const named = rows.filter((r) => r.display_name.toLowerCase() === lower || mcpServerSlug(r.display_name) === mcpServerSlug(key))
  return named.length === 1 ? { id: named[0].id, name: named[0].display_name } : null
}

/**
 * The save-time check for the steps that reach a connected app: each
 * call_tool's connection, tool and templated input; each skill step's
 * `connections`. The owner is who the loop runs as. Returns the first problem
 * with the action's index, or null. Fails closed on a read error. A disabled
 * or half-built (draft) call_tool is checked only for what it names.
 */
export async function findCallToolProblems(
  supabase: SupabaseClient,
  ownerUserId: string | null,
  actions: ReadonlyArray<Pick<FlowAction, 'type' | 'config' | 'enabled'>>,
): Promise<{ index: number; field: string; message: string } | null> {
  const wanted = new Set<string>()
  actions.forEach((a) => {
    if (a.type === 'call_tool') {
      const c = a.config as CallToolActionConfig
      if (c.connection) wanted.add(c.connection)
    } else if (a.type === 'run_skill') {
      for (const id of (a.config as RunSkillActionConfig).connections ?? []) wanted.add(id)
    }
  })
  if (wanted.size === 0) return null
  if (!ownerUserId) return { index: 0, field: 'connection', message: 'This loop has no owner whose connections it could use' }
  // The GitHub integration's server is built, never stored (github-integration.ts).
  const stored = [...wanted].filter((id) => id !== GITHUB_INTEGRATION_SERVER_ID)
  const [{ data, error }, github] = await Promise.all([
    stored.length
      ? supabase.from('connected_mcp_server').select('*').eq('user_id', ownerUserId).in('id', stored)
      : Promise.resolve({ data: [] as unknown[], error: null }),
    wanted.has(GITHUB_INTEGRATION_SERVER_ID) ? loadGitHubIntegrationServer(supabase, ownerUserId) : Promise.resolve(null),
  ])
  if (error) return { index: 0, field: 'connection', message: 'Could not check the connections, so nothing was saved' }
  const byId = new Map(((data ?? []) as ConnectedMcpServerRow[]).map((s) => [s.id, s]))
  if (github) byId.set(github.id, github)
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i]
    if (a.type === 'run_skill') {
      for (const id of (a.config as RunSkillActionConfig).connections ?? []) {
        const server = byId.get(id)
        if (!server) return { index: i, field: 'connections', message: `connection ${id} is gone, or isn't the loop owner's` }
      }
      continue
    }
    if (a.type !== 'call_tool') continue
    const c = a.config as CallToolActionConfig
    if (!c.connection || !c.tool) continue
    // A switched-off step is a draft: checked again when it is switched on.
    if (a.enabled === false) continue
    const server = byId.get(c.connection) ?? null
    const problem = connectionProblem(server, c.tool)
    if (problem) return { index: i, field: server ? 'tool' : 'connection', message: problem }
    const check = checkToolInputAtSave(c.input, toolOf(server!, c.tool)?.inputSchema)
    if (!check.ok) return { index: i, field: 'input', message: `input doesn't match ${c.tool}: ${check.error}` }
  }
  return null
}

const NOTHING = { header_names: [] as string[], body_byte_length: 0 }

export interface CallToolExecutorDeps {
  workspaceId: string
  /** The loop's owner (who it runs as); null falls back to nothing (the step fails). */
  runAsUserId: string | null
  flowId: string | null
  flowName?: string | null
  /** The pre-generated flow_run id: the held call's run (its per-run cap and its resume). */
  flowRunId: string | null
  /** F1 test_flow: a dry run calls nothing and holds nothing. */
  dryRun?: boolean
  /**
   * F4 review R1: a person's Test (the fire route), often of a loop still off.
   * Its card is answered whether or not the loop is on.
   */
  manual?: { firedBy: string }
  /** Test seams. */
  supabase?: SupabaseClient
  callTool?: typeof callToolByServerId
  holdForPerson?: typeof createToolApproval
  paused?: (supabase: SupabaseClient, workspaceId: string) => Promise<boolean>
}

/** The call_tool executor the dispatchers inject into runFlow. */
export function createCallToolExecutor(deps: CallToolExecutorDeps): CallToolExecutor {
  return async (action, ctx): Promise<CallToolExecutionResult> => {
    const startedAt = Date.now()
    const config = action.config as CallToolActionConfig
    const url = `tool://${config.connection}/${config.tool}`
    const result = (r: Partial<CallToolExecutionResult> & Pick<CallToolExecutionResult, 'status'>): CallToolExecutionResult => ({
      request_summary: { method: 'TOOL', url, ...NOTHING },
      response_status_code: null,
      response_body_preview: null,
      error_message: null,
      duration_ms: Date.now() - startedAt,
      ...r,
    })
    const failed = (message: string, extra: Partial<CallToolExecutionResult> = {}) => result({ status: 'failed', error_message: message, ...extra })
    try {
      const supabase = deps.supabase ?? getServiceClient()
      if (!deps.runAsUserId) return failed('This loop has no owner whose connections it could use')
      if (await (deps.paused ?? ((db, ws) => isAgentPaused(db, ws, 'flow_step')))(supabase, deps.workspaceId)) return failed(AGENT_PAUSED_REASON)

      const server = await loadOwnerConnection(supabase, deps.runAsUserId, config.connection)
      const problem = connectionProblem(server, config.tool)
      if (problem || !server) return failed(problem ?? 'That connection is gone')
      const descriptor = toolOf(server, config.tool)!
      const called = (policy: ConnectorCallDecision['policy']) => ({
        connection: server.id,
        server: server.display_name,
        tool: config.tool,
        policy,
      })

      // The input, rendered strictly from the trigger and the earlier steps.
      const templateCtx = buildTemplateContext(ctx.entity, ctx.trigger, ctx.appBaseUrl, {
        capture: ctx.capture ?? null,
        workspaceId: deps.workspaceId,
        steps: ctx.steps ?? {},
      })
      const rendered = renderInputStrict(config.input ?? {}, templateCtx)
      if (!rendered.ok) return failed(rendered.error)
      const input = (rendered.value ?? {}) as Record<string, unknown>
      const schemaCheck = checkToolInputAtRun(input, descriptor.inputSchema)
      if (!schemaCheck.ok) {
        // flow_run is readable by every member: the field, never the rendered value (which can carry app data).
        const field = /^([A-Za-z0-9_.\[\]-]+)(?=:| must| is )/.exec(schemaCheck.error)?.[1]
        return failed(`The input doesn't match ${config.tool}'s inputs${field ? ` (at ${field})` : ''}`)
      }

      const decision = connectorCallPolicy({
        serverUrl: server.server_url,
        tool: descriptor,
        input,
        requiresApproval: mcpToolRequiresApproval(descriptor, server),
        // The person's own "ask first" wins over every connector rule.
        explicitlyRequired: (server.require_approval_tools ?? []).includes(config.tool),
        // Once the run read outside text (the earlier steps, outside-text.ts), a call that could carry it out asks.
        readOutsideText: ctx.readOutsideText === true,
      })

      if (deps.dryRun) {
        const what = decision.policy === 'ask' ? 'would wait for your approval card' : decision.policy === 'inert' ? 'would run (inert)' : 'would run (a read)'
        return result({
          status: 'success',
          response_body_preview: `Test: nothing called. ${config.tool} on ${server.display_name} ${what}.`,
          step_output: `[test: the output of ${config.tool}]`,
          called: called(decision.policy),
        })
      }

      if (decision.policy === 'ask') {
        // The trust authority, for an unattended flow step's outward call: a card.
        const namespaced = namespacedToolName(server.display_name, config.tool)
        if (decideAction('agent_unattended', 'outward', namespaced, { flowStep: true }) !== 'ask') {
          return failed(`Nothing ran: ${config.tool} needs the person's approval`, { called: called('ask') })
        }
        if (!deps.flowRunId || !deps.flowId) return failed('Nothing ran: this step needs your approval, and this run cannot wait for it', { called: called('ask') })
        const copy = connectorCardCopy({ serverName: server.display_name, tool: config.tool, input, flowName: deps.flowName ?? null, publicContent: decision.publicContent })
        const flowStep: FlowStepApprovalContext = {
          flow_id: deps.flowId,
          action_id: action.id,
          flow_run_id: deps.flowRunId,
          connection: server.id,
          tool: config.tool,
          rule: decision.rule,
          public_content: decision.publicContent,
          ...(deps.manual ? { manual: true as const, fired_by: deps.manual.firedBy } : {}),
        }
        // Loaded here, not at module load: the dispatchers that inject this
        // executor never pull the tool registry in for a loop with no card.
        const hold = deps.holdForPerson ?? (await import('@/lib/safety/approvals')).createToolApproval
        const held = await hold(supabase, {
          door: 'flow_step',
          userId: deps.runAsUserId,
          workspaceId: deps.workspaceId,
          toolName: namespaced,
          sideEffect: 'external-write',
          input,
          flowRunId: deps.flowRunId,
          context: { flowStep },
          reason: decision.rule,
          card: copy,
        })
        if (!held.ok) return failed(`Nothing ran, and no approval card was made: ${held.error}`, { called: called('ask') })
        // flow_run is readable by the whole workspace: only a generic line there,
        // never the call's input (the card, the owner's alone, shows it all).
        const line = connectorRunLine({ serverName: server.display_name, tool: config.tool, publicContent: decision.publicContent })
        return result({
          status: 'pending',
          response_body_preview: `Waiting for your approval: ${line}`,
          parked: { approval_id: held.approvalId, card_id: held.cardId, title: line },
          called: called('ask'),
        })
      }

      // A read, or an inert write: it runs, as the owner.
      let text = ''
      let isError = false
      let outside = true
      try {
        const out = await (deps.callTool ?? callToolByServerId)(supabase, server.id, config.tool, input, deps.runAsUserId)
        isError = out.isError === true
        text = mcpContentText(out.content)
        // The one notion of outside text (outside-text.ts): a connected app's result always is.
        outside = classifyToolRead(namespacedToolName(server.display_name, config.tool), { success: !isError, content: out.content }).outside
      } catch (err) {
        if (err instanceof McpTokenExpiredError) return failed(`${server.display_name} needs reconnecting (its sign-in expired)`, { called: called(decision.policy) })
        if (server.id === GITHUB_INTEGRATION_SERVER_ID && isGitHubSignInRefused(err)) return failed('GitHub refused the sign-in: reconnect GitHub in Settings > Connectors', { called: called(decision.policy) })
        // The app's own error text can carry its data: only a generic line on the run.
        console.warn('[call-tool] call failed:', { tool: config.tool, server: server.display_name, message: err instanceof Error ? err.message : String(err) })
        return failed(`The call to ${config.tool} on ${server.display_name} failed`, { called: called(decision.policy) })
      }
      return result({
        status: isError ? 'failed' : 'success',
        // flow_run is readable by the whole workspace: how much came back, never
        // what (the text stays in the server-only flow_run_state).
        response_body_preview: connectorRunLine({ serverName: server.display_name, tool: config.tool, chars: text.length, inert: decision.policy === 'inert' }),
        error_message: isError ? `${config.tool} on ${server.display_name} returned an error` : null,
        step_output: text,
        // Another service's text: the run has now read outside text.
        ...(outside ? { read_outside_text: true } : {}),
        called: called(decision.policy),
        ...(decision.policy === 'inert' && !isError
          ? { delivered: { to: `connector:${server.display_name}`, delivered: 1, refused: [], summary: `${decision.reason} (${config.tool} on ${server.display_name})` } }
          : {}),
      })
    } catch (err) {
      console.warn('[call-tool] step failed:', err instanceof Error ? err.message : String(err))
      return failed('The step could not run')
    }
  }
}
