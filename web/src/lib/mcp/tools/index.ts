import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { createTools } from '@/lib/ai/tools'
import { TEXT_TURN_ONLY_TOOL_NAMES } from '@/lib/ai/tools/text-setup'
import { mcpWithheldAttendedTools } from '@/lib/mcp/attended-tools'
import {
  offFeatureDeniedToolNames,
  isFeatureEnabled,
  resolveWorkspaceEdition,
} from '@/lib/editions'
import { installMcpGuard, type McpGuardOptions } from '../guard'
import { registerWorkspaceTools } from './workspaces'
import { registerGitHubTools } from './github'
import { registerLibraryTools } from './library'
import { registerEvalTools } from './evals'
import { registerDiscoveryTools } from './discovery'
import {
  buildMcpErrorContent,
  categoriseMcpError,
  targetWorkspaceOf,
  withActiveWorkspace,
  withTargetWorkspace,
  withoutMcpImage,
} from './envelope'

/** Re-exported: the error categoriser moved to ./envelope when the dispatcher
 *  started needing it too. Importers (and its test) still reach it here. */
export { categoriseMcpError }

/**
 * Registers all MCP tools on the server.
 *
 * Strategy: wrap existing AI SDK tools from createTools() via an adapter that
 * extracts the Zod schema and execute function from each tool definition.
 * Every tool returned by createTools() is exposed — no allowlist filter.
 * This avoids duplicating business logic — the same tools power the AI chat.
 */
export async function registerTools(
  server: McpServer,
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  workspaceName: string | null,
  onWorkspaceChanged?: (newWorkspaceId: string) => void | Promise<void>,
  guard?: McpGuardOptions,
) {
  // Install the scope/audit guard FIRST — it wraps server.tool, so it must be
  // in place before any registrar runs. Covers every registration path below.
  if (guard) installMcpGuard(server, guard)

  // Record every tool name the hand-written registrars claim. The AI-SDK
  // adapter loop at the bottom must skip these: the chat toolset can legally
  // contain a tool whose prefixed name collides with a hand-registered one
  // (e.g. chat's `list_skills` → `dial8_list_skills`), and McpServer.tool
  // throws on a duplicate name — which would fail the ENTIRE connection, not
  // just the one tool. The hand-written MCP variants win the name: they carry
  // MCP-specific behavior (visibility='personal' creation default, lightweight
  // list fields) that the chat variants don't.
  const claimedNames = new Set<string>()
  {
    const inner = server.tool.bind(server) as (...args: unknown[]) => unknown
    ;(server as unknown as { tool: (...args: unknown[]) => unknown }).tool = (
      ...args: unknown[]
    ) => {
      if (typeof args[0] === 'string') claimedNames.add(args[0])
      return inner(...args)
    }
  }

  // The active workspace, as the hand-written registrars below and the bridging
  // loop further down both need it. Declared here (rather than beside the loop)
  // so the FOUR hand-registered tool sets can stamp `active_workspace` on their
  // own JSON results — they build their own `content`, so the adapter's stamp
  // never reaches them and they were the only results in the catalog that
  // didn't name their workspace.
  const active = { id: workspaceId, name: workspaceName }

  // Register workspace-specific tools (not in the AI SDK tool set)
  registerWorkspaceTools(server, userId, supabase, workspaceId, onWorkspaceChanged, workspaceName)

  // Register GitHub-specific tools (PR linking, status)
  registerGitHubTools(server, userId, supabase, workspaceId, workspaceName)

  // Register Library tools (Skills, Agents, Meeting Types CRUD).
  // Lets external Claude/OpenAI clients author Dial8 library items.
  // Creates default to visibility='personal' for safety.
  registerLibraryTools(server, userId, supabase, workspaceId, workspaceName)

  // FEATURE GATE. MCP is not edition-ceilinged; it enforces one rule instead: a
  // feature the workspace has switched off loses its tools here, as it does in
  // the chat's ceiling. Fails open to `full` with no overrides, which is every
  // feature on (manifest invariant 5).
  const resolved = await resolveWorkspaceEdition(supabase, workspaceId)
  const featureOffDenied = offFeatureDeniedToolNames(resolved)

  // Register Evals tools (suites, synthetic-meeting cases, runs). Hand-written
  // rather than left to the adapter below so they keep this directory's ok/fail
  // envelopes and so the six dial8_*_eval* names classify by verb shape for the
  // read-only token guard. See ./evals.ts.
  if (isFeatureEnabled(resolved, 'evals')) {
    registerEvalTools(server, userId, supabase, workspaceId, workspaceName)
  }

  // `active` (declared above, alongside the hand-written registrars that also
  // stamp it) is merged into every bridged tool response below as a constant
  // in-band reminder of which workspace tool calls are running in.
  //
  // Get all AI SDK tools scoped to this user + workspace.
  //
  // `createWorkspacePolicy: 'explicit'` is the one place the MCP toolset differs
  // from chat's. A connector's active workspace is an OAuth artifact chosen weeks ago
  // and invisible in the turn, so letting a create silently default to it is
  // exactly the "you filed it in the wrong workspace" bug. Under 'explicit' a
  // create with no `workspace_id` still succeeds for a single-workspace user
  // (the default cannot be wrong) and otherwise returns `needs_workspace` with
  // the candidates. See CreateToolsOptions in @/lib/ai/tools.
  const aiTools = createTools(userId, supabase, workspaceId, undefined, {
    createWorkspacePolicy: 'explicit',
    // A client acting for the person: their agent's own face is "Your agent" (one face).
    botWorkVoice: 'person',
  })
  // The attended-only tools (bots v3 Phase 5, bots-v4 A1/A2, the A1b loop
  // builders, the skill writers): a person's own connector gets
  // MCP_ATTENDED_TOOL_NAMES (src/lib/mcp/attended-tools.ts). Removed before
  // discovery and the bridge loop, so dial8_call_tool cannot reach them either.
  for (const name of mcpWithheldAttendedTools()) {
    delete (aiTools as Record<string, unknown>)[name]
  }
  // A texted connect link goes only to the person's verified phone, from their
  // own text turn (src/lib/ai/tools/text-setup.ts): never an MCP client's.
  for (const name of TEXT_TURN_ONLY_TOOL_NAMES) {
    delete (aiTools as Record<string, unknown>)[name]
  }
  // A feature that is off loses its chat tools here too, before discovery, so
  // dial8_search_tools / dial8_call_tool cannot reach them either.
  for (const name of featureOffDenied) {
    delete (aiTools as Record<string, unknown>)[name]
  }

  /*
   * Discovery + dispatch, registered BEFORE the bridging loop so their names
   * are claimed (nothing in createTools is called search_tools/call_tool
   * today, but the loop skips claimed names and that is the invariant to keep).
   *
   * `exposedNames` is the whole catalog this connection will offer: what the
   * hand-written registrars above already claimed, plus every bridged tool
   * that has an execute, plus these two. It exists only to be fingerprinted —
   * that stamp is how a client with a stale tool list finds out it has one.
   */
  const bridgedNames = Object.entries(aiTools)
    .filter(([, t]) => typeof (t as { execute?: unknown }).execute === 'function')
    .map(([name]) => `dial8_${name}`)
  registerDiscoveryTools(server, {
    aiTools,
    exposedNames: [...claimedNames, ...bridgedNames, 'dial8_search_tools', 'dial8_call_tool'],
    readOnly: guard?.readOnly ?? false,
    active,
    audit: guard?.audit,
  })

  /**
   * The bridged happy path, shared by the with-args and no-args registrations.
   *
   * Order matters: the target workspace is read off the RESULT OBJECT (where
   * `workspace: { id }` / `workspace_id` still exist as fields) before the
   * object becomes a JSON string, and is then attached to the content block for
   * the guard — which, wrapping `server.tool`, only ever sees the block. See
   * ./envelope.ts.
   */
  const bridgedContent = (result: unknown) => {
    const target = targetWorkspaceOf(result)
    // An image a tool returns never goes out as base64 text (withoutMcpImage).
    const stamped = withActiveWorkspace(withoutMcpImage(result), active)
    return withTargetWorkspace(
      { content: [{ type: 'text' as const, text: JSON.stringify(stamped, null, 2) }] },
      target,
    )
  }

  for (const [name, aiTool] of Object.entries(aiTools)) {
    // The AI SDK tool() function returns an object with:
    //   - description: string
    //   - inputSchema: ZodObject (the parameter schema)
    //   - execute: (args) => Promise<result>
    // We need to extract the .shape from the ZodObject for MCP's tool() API.
    const toolDef = aiTool as {
      description?: string
      inputSchema?: z.ZodObject<z.ZodRawShape>
      execute?: (args: Record<string, unknown>, context: unknown) => Promise<unknown>
    }

    if (!toolDef.execute) continue

    const description = toolDef.description || `Dial8 tool: ${name}`
    const zodShape = toolDef.inputSchema?.shape

    const execute = toolDef.execute
    const mcpToolName = `dial8_${name}`

    // Silent skip (no per-connection log spam — this runs on every POST): the
    // hand-registered MCP variant of this tool already owns the name.
    if (claimedNames.has(mcpToolName)) continue

    // A feature that is off takes its CHAT tools out too. Without this, not
    // registering the hand-written `dial8_*_eval*` variants above would let the
    // adapter re-expose the chat versions under the very same names — the
    // `claimedNames` skip only suppresses them while the hand-written ones ARE
    // registered.
    if (featureOffDenied.has(name)) continue

    if (zodShape) {
      // Tool with parameters
      server.tool(
        mcpToolName,
        description,
        zodShape,
        async (args) => {
          try {
            return bridgedContent(await execute(args, {}))
          } catch (err) {
            return buildMcpErrorContent(err, mcpToolName, active)
          }
        },
      )
    } else {
      // Tool without parameters
      server.tool(
        mcpToolName,
        description,
        async () => {
          try {
            return bridgedContent(await execute({}, {}))
          } catch (err) {
            return buildMcpErrorContent(err, mcpToolName, active)
          }
        },
      )
    }
  }
}
