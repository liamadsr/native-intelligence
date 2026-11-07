/**
 * Dynamic workspace-tool resolver for the work-agent (Loops v3 work proposals).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ SIBLING of agents/skill-runner/tools/workspace_tools.ts. Same "Option B"  │
 * │ proxy shape; the only delta is that dispatchWorkspaceTool posts to the     │
 * │ WORK-RUN tool route and the advertised ceiling is the registry tools       │
 * │ classified read / internal-write (from the work-run spec).                 │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * The workspace-tool factories (createTools) are deeply Next-coupled (Inngest,
 * OAuth, email/calendar services) and cannot compile into this separate eve Nitro
 * runtime. So instead of importing them, this resolver builds one thin PROXY per
 * ceiling tool. The proxy carries the real tool's NAME + DESCRIPTION (which is
 * what steers the model); when the model calls it, the proxy's execute dispatches
 * to the Next app's internal work-run tool route, which runs the REAL tool (real
 * Zod schema, real execute) under the run's tenancy and re-checks the ceiling.
 *
 * ── The ceiling is STRUCTURAL ───────────────────────────────────────────────
 * The resolver returns ONLY the turn's ceiling tools (from the rebuilt spec —
 * the registry tools whose required `sideEffect` classification is 'read' or
 * 'internal-write'; every external-write, automation-write and delete tool is
 * out, and a new tool is out until it is classified as admitted). A follow-up
 * chat turn may add its bot's follow-through grants (attended-only tools) and
 * a picked skill's tools, but a skill's are capped to the run's own classes
 * (drafting for an attempted run, read + internal-write for a person-started
 * one) and to the bot's attended chat ceiling (skillChatTurnTools). A tool
 * outside the ceiling (`publish_draft`, `delete_action`, …) is never advertised
 * — it does not exist for this session. The internal tool route ALSO
 * re-derives + enforces the ceiling server-side from the same
 * ceilingForWorkRunTurn, so it's enforced twice.
 *
 * ── Replay safety (durability contract) ─────────────────────────────────────
 * Each proxy's `execute` is an INLINE arrow whose closure captures ONLY two
 * serializable strings — the tool name and the run token — so the execute is
 * reconstructable on replay after a crash/resume. `dispatchWorkspaceTool` is a
 * MODULE-LEVEL helper that rebuilds its fetch fresh per call — no non-serializable
 * closure state crosses a step boundary.
 */
import { defineDynamic, defineTool } from 'eve/tools'
import { z } from 'zod'
import { fetchEveSpec, isChatTurnRunToken, isLaterTurnRunToken, runTokenFromAuth, dispatchWorkspaceTool } from '../lib/spec-client.js'
import { SCREENSHOT_TOOL_NAMES, modelReadsToolImages, screenshotModelOutput } from '../lib/screenshot-output.js'

/**
 * Permissive FALLBACK input schema — used only when the spec carries no real
 * schema for a tool. Real validation is server-side against the tool's own
 * schema either way; advertising the real shape (spec `inputSchema`) is what lets
 * the model produce valid input on the first try.
 */
const passThroughInput = z.record(z.string(), z.unknown())

/**
 * Native FRAMEWORK tools — eve's own provider-executed `web_search` (Exa) and
 * our SSRF-guarded `web_fetch` override. Never proxied.
 *
 * These names are kept out of every spec at the source: web access is an
 * always-on capability with no registry entry, so it never reaches
 * CORE_TOOL_NAMES or computeToolCeiling, and web-search-spec-collision.test.ts
 * pins that. This is the same guard at the MINT SITE — the last point before a
 * proxy actually exists. A `web_search` proxy would shadow eve's native tool,
 * and the model's searches would round-trip to our tool route (where no such
 * workspace tool is registered) instead of reaching Exa.
 */
const NATIVE_WEB_TOOL_NAMES = new Set(['web_search', 'web_fetch'])

/**
 * The tools for the run token on the CURRENT delivery
 * (`ctx.session.auth.current`): the session's, or a later turn's.
 */
async function resolveWorkspaceTools(auth: Parameters<typeof runTokenFromAuth>[0]) {
  const runToken = runTokenFromAuth(auth)
  const spec = await fetchEveSpec(runToken)
  // No spec (unknown token, route down) → no workspace tools.
  if (!spec) return null

  const entries: Record<string, ReturnType<typeof defineTool>> = {}
  const toolImages = modelReadsToolImages(spec.model)
  for (const { name, description, inputSchema } of spec.ceilingTools) {
    // Never mint a proxy over a native framework tool (see above).
    if (NATIVE_WEB_TOOL_NAMES.has(name)) continue
    // Inline arrow capturing ONLY serializable strings (name, runToken) so the
    // execute survives replay. dispatchWorkspaceTool is module-level; the
    // inputSchema is a plain JSON object off the fetched spec.
    // A browser tool that can return a screenshot also gets a toModelOutput
    // (lib/screenshot-output.ts): the base64 leaves the JSON, and rides as an
    // image part only for a model that reads one. It captures one boolean.
    entries[name] = SCREENSHOT_TOOL_NAMES.has(name)
      ? (defineTool({
          description,
          inputSchema: inputSchema ?? passThroughInput,
          execute: (input) => dispatchWorkspaceTool(name, runToken, input),
          toModelOutput: (output) => screenshotModelOutput(output, toolImages),
        }) as ReturnType<typeof defineTool>)
      : (defineTool({
          description,
          inputSchema: inputSchema ?? passThroughInput,
          execute: (input) => dispatchWorkspaceTool(name, runToken, input),
        }) as ReturnType<typeof defineTool>)
  }
  // A map return names each tool by its BARE key (no slug prefix) so the model
  // sees `create_action`, `create_email_draft`, `create_document`, etc.,
  // exactly as the gateway path names them.
  return Object.keys(entries).length > 0 ? entries : null
}

export default defineDynamic({
  events: {
    // The run's own session starts on its dispatch token: its tools are the
    // run's ceiling. A session that starts on a follow-up CHAT turn is a run
    // chat that reopened after its session expired (the app's
    // run-chat-reopen.ts): it holds no session tools, and each of its turns
    // gets its own at turn.started, from its own token. Session tools would
    // keep the first turn's token, its caller and its picked skill, for every
    // later turn, a relayed one (unattended) included.
    'session.started': async (_event, ctx) =>
      isChatTurnRunToken(runTokenFromAuth(ctx.session.auth)) ? null : resolveWorkspaceTools(ctx.session.auth),
    // A LATER turn on the run's session (bots v3 Phase 5): a follow-up chat turn
    // (/api/account/agent-runs/[id]/chat) or the resume of a parked run (an
    // answer, returned handoffs), each under a FRESH token the caller minted.
    // The session.started proxies carry the token the run was dispatched with,
    // which expires 60 minutes after it was minted, so a follow-up an hour later
    // had tools that all failed. This turn's proxies carry this turn's token
    // (eve keeps the session's tools under a turn's, by name; a chat turn's
    // ceiling is a superset of the run's, ceilingForWorkRunTurn, so nothing is
    // left on the old token).
    //
    // The run's own first turn re-resolves nothing (null): no second spec fetch
    // per run, and no second fetch that could fail and strip its tools.
    'turn.started': async (_event, ctx) =>
      isLaterTurnRunToken(runTokenFromAuth(ctx.session.auth)) ? resolveWorkspaceTools(ctx.session.auth) : null,
  },
})
