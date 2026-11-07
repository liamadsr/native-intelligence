/**
 * Dynamic workspace-tool resolver for the skill-runner agent (Phase 2, "Option B").
 *
 * The 19 workspace-tool factories (createTools) are deeply Next-coupled (Inngest,
 * OAuth, email/calendar services) and cannot compile into this separate eve Nitro
 * runtime. So instead of importing them, this resolver builds one thin PROXY per
 * ceiling tool. The proxy carries the real tool's NAME + DESCRIPTION (which is
 * what steers the model); when the model calls it, the proxy's execute dispatches
 * to the Next app's internal tool route, which runs the REAL tool (real Zod
 * schema, real execute) under the run's tenancy and re-checks the ceiling.
 *
 * ── The ceiling is STRUCTURAL ───────────────────────────────────────────────
 * The resolver returns ONLY the run's ceiling tools (from the rebuilt spec). A
 * tool outside the ceiling is never advertised — it does not exist for this
 * session. This mirrors pickPermittedTools (the F1 fix): exclusion is structural,
 * never a prompt hint. The internal tool route ALSO re-derives + enforces the
 * ceiling server-side, so it's enforced twice. When the run is inherit-all (act
 * mode, no restriction — spec.ceiling === null), the rebuild enumerates the FULL
 * workspace registry into ceilingTools, so the resolver advertises every tool the
 * gateway path's pickPermittedTools(null) would grant — never zero tools.
 *
 * ── Replay safety (durability contract) ─────────────────────────────────────
 * Each proxy's `execute` is an INLINE arrow whose closure captures ONLY two
 * serializable strings — the tool name and the run token. The bundler transform
 * stamps these so the execute is reconstructable on replay after a crash/resume
 * (see eve docs guides/dynamic-capabilities "execute must be an inline function"
 * and concepts/execution-model-and-durability). `dispatchWorkspaceTool` is a
 * MODULE-LEVEL helper that rebuilds its fetch fresh per call — no non-serializable
 * closure state crosses a step boundary.
 *
 * Each proxy advertises the tool's REAL input JSON Schema when the spec carries
 * one (spec `inputSchema`, extracted server-side from the same Zod schemas the
 * gateway path hands streamText) so the model produces valid input on the first
 * try; a permissive pass-through record is only the fallback for entries whose
 * schema didn't convert. The AUTHORITATIVE Zod validation stays server-side in
 * the internal route either way.
 *
 * ── The web kill switch ─────────────────────────────────────────────────────
 * Web access honors the app's USE_GATEWAY kill switch, decided server-side in
 * the spec rebuild (spec.webAccess). When it is off — or the spec could not be
 * fetched (webAccessEnabled fails closed) — this resolver ALSO returns a refusal
 * stub for every NATIVE_WEB_TOOL_NAMES entry (`web_search`, `web_fetch`). A
 * dynamic tool OVERRIDES the
 * same-named authored one (eve docs, guides/dynamic-capabilities "Conflicts"),
 * so the native Exa search and the guarded fetcher are replaced for this session
 * and nothing from the open web reaches the run. The stubs are NOT proxies: they
 * never dispatch anywhere.
 */
import { defineDynamic, defineTool } from 'eve/tools'
import { z } from 'zod'
import {
  fetchEveSpec,
  isChatRunToken,
  runTokenFromAuth,
  dispatchWorkspaceTool,
  webAccessEnabled,
  NATIVE_WEB_TOOL_NAMES,
} from '../lib/spec-client.js'
import { SCREENSHOT_TOOL_NAMES, modelReadsToolImages, screenshotModelOutput } from '../lib/screenshot-output.js'

/**
 * Permissive FALLBACK input schema — used only when the spec carries no real
 * schema for a tool. Real validation is server-side against the tool's own
 * schema either way; advertising the real shape (spec `inputSchema`, a plain
 * JSON-Schema object eve's defineTool accepts directly) is what lets the model
 * produce valid input on the first try.
 */
const passThroughInput = z.record(z.string(), z.unknown())

/**
 * Native FRAMEWORK tools (NATIVE_WEB_TOOL_NAMES, lib/spec-client.ts) — eve's own
 * provider-executed `web_search` (Exa) and our SSRF-guarded `web_fetch`
 * override. Never proxied.
 *
 * These names are kept out of every spec at the source: web access is an
 * on-by-default capability with no registry entry, so it never reaches
 * CORE_TOOL_NAMES or computeToolCeiling, and web-search-spec-collision.test.ts
 * pins that. This is the same guard at the MINT SITE — the last point before a
 * proxy actually exists. A `web_search` proxy would shadow eve's native tool,
 * and the model's searches would round-trip to our tool route (where no such
 * workspace tool is registered) instead of reaching Exa.
 */
const NATIVE_WEB_TOOLS: ReadonlySet<string> = new Set(NATIVE_WEB_TOOL_NAMES)

/** Model-facing description of a web tool while web access is off for the run. */
const WEB_OFF_DESCRIPTION =
  'Web access is turned off for this run. Do not call this tool; work from the workspace tools only.'

/** Model-facing description of a run tool a follow-up chat may not use. */
const NOT_IN_CHAT_DESCRIPTION = 'Not available in this chat. Do not call this tool; use only the other tools you have.'

/**
 * The tools for the run token on the CURRENT delivery
 * (`ctx.session.auth.current`): the session's, or a chat turn's.
 */
async function resolveWorkspaceTools(auth: Parameters<typeof runTokenFromAuth>[0]) {
  const runToken = runTokenFromAuth(auth)
  const spec = await fetchEveSpec(runToken)

  const entries: Record<string, ReturnType<typeof defineTool>> = {}

  // A chat turn (bots v3 Phase 4): eve keeps the session.started tools (the
  // run's own ceiling, its own token) UNDER the turn's, by name. Shadow every
  // one of them this chat may not use with a refusal stub; the chat's own
  // proxies below replace the rest. Inline executes with no captures.
  for (const name of spec?.chatTurn?.shadowTools ?? []) {
    if (NATIVE_WEB_TOOLS.has(name)) continue
    entries[name] = defineTool({
      description: NOT_IN_CHAT_DESCRIPTION,
      inputSchema: passThroughInput,
      execute: () => ({ error: 'This tool is not available in this chat.' }),
    }) as ReturnType<typeof defineTool>
  }

  // Web kill switch (see the header): override EVERY native web tool with a
  // refusal stub unless the server-rebuilt spec explicitly enabled the web.
  // Inline executes with no captures (replay-safe); they touch nothing.
  if (!webAccessEnabled(spec)) {
    for (const webTool of NATIVE_WEB_TOOL_NAMES) {
      entries[webTool] = defineTool({
        description: WEB_OFF_DESCRIPTION,
        inputSchema: passThroughInput,
        execute: () => ({ error: 'Web access is turned off for this run.' }),
      }) as ReturnType<typeof defineTool>
    }
  }

  // No spec (unknown token, route down) → no workspace tools this session.
  const toolImages = modelReadsToolImages(spec?.model)
  for (const { name, description, inputSchema } of spec?.ceilingTools ?? []) {
    // Never mint a proxy over a native framework tool (see above).
    if (NATIVE_WEB_TOOLS.has(name)) continue
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
  // A map return names each tool by its BARE key (no slug prefix) — verified
  // against eve's qualifyDynamicToolNames — so the model sees `create_action`,
  // `list_actions`, etc., exactly as the gateway path names them.
  return Object.keys(entries).length > 0 ? entries : null
}

export default defineDynamic({
  events: {
    // The run's own session starts on its run token: its tools are the run's
    // ceiling. A session that starts on a follow-up CHAT turn is a loop run's
    // chat that reopened after its session expired (the app's
    // loop-run-chat-reopen.ts): it holds no session tools, and each of its
    // turns gets its own at turn.started, from its own token. Session tools
    // would keep the first turn's token, its caller class and its bot's
    // ceiling, for every later turn: a relayed turn (unattended) after the
    // person's, or the person's after a relayed one.
    'session.started': async (_event, ctx) =>
      isChatRunToken(runTokenFromAuth(ctx.session.auth)) ? null : resolveWorkspaceTools(ctx.session.auth),
    // A follow-up CHAT turn (bots v3 Phase 4): a run's session can be PARKED and
    // continued in a chat, each turn under a FRESH run token minted by the chat
    // route (the run's own expires shortly after its wall). That turn's proxies
    // must carry its token, and its spec is the bot's attended chat ceiling, not
    // the run's (skill-run-chat-ceiling.ts), with the run's other tools shadowed.
    //
    // A run's OWN turn re-resolves nothing (null: no turn-scoped tools, so the
    // session.started set stands, exactly as before parking existed): no second
    // spec fetch per run, and no second fetch that could fail and leave the run
    // with fewer tools than its session resolved.
    'turn.started': async (_event, ctx) =>
      isChatRunToken(runTokenFromAuth(ctx.session.auth)) ? resolveWorkspaceTools(ctx.session.auth) : null,
  },
})
