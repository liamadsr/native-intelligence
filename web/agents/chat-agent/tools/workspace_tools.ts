/**
 * Dynamic workspace-tool resolver for the chat-agent (Phase 4, "Option B") —
 * now with PROGRESSIVE TOOL DISCLOSURE (parity with the cloud route).
 *
 * The workspace-tool factories (createTools) + external-MCP adapter are deeply
 * Next-coupled (Inngest, OAuth, email/calendar services, the MCP client) and
 * cannot compile into this separate eve Nitro runtime. So instead of importing
 * them, this resolver builds one thin PROXY per advertised tool. The proxy
 * carries the real tool's NAME + DESCRIPTION (what steers the model); when the
 * model calls it, the proxy's execute dispatches to the Next app's internal tool
 * route, which runs the REAL tool (real Zod schema, real execute) under the
 * conversation's tenancy and RE-DERIVES + re-checks the ceiling server-side.
 *
 * ── Progressive disclosure (the token win) ──────────────────────────────────
 * The eve tool loop advertises whatever the resolvers return to the model on
 * every model call. Advertising ALL ~86 ceiling tools every turn burns
 * ~22-45K input tokens/turn on tool schemas the model rarely needs. Instead —
 * exactly like the cloud route's activeTools + prepareStep + search_tools — this
 * resolver advertises only a small CORE subset upfront plus a `search_tools`
 * meta-tool, and EXPANDS the advertised set as the model discovers more:
 *
 *   • `session.started` (durable baseline): core proxies + `search_tools`.
 *   • `step.started` (per model call): (core ∪ discovered-from-state) proxies +
 *     `search_tools`, all clamped to the ceiling. eve merges step tools with the
 *     durable session set, and the step resolver re-derives the expanded set from
 *     STATE each step (step tool metadata is NOT durably persisted by eve — only
 *     session/turn are — so re-deriving from durable state is mandatory + cheap).
 *   • `search_tools.execute`: token-matches the query against the spec's FULL
 *     `ceilingTools` (the discoverable surface, already ⊆ ceiling), writes the
 *     matched names into durable `defineState`, and RETURNS the matches so the
 *     model learns what's now available. The NEXT `step.started` reads that state
 *     and includes them as callable proxies → the model can call them on step N+1.
 *
 * eve REJECTS a tool call whose name isn't in the resolved set for that step
 * (AI SDK NoSuchToolError). So discovery MUST land in the resolved set BEFORE the
 * model can call it — hence the expand-then-call flow across the step boundary,
 * and hence `search_tools` writes to state (which the next step reads) rather
 * than relying on the discovered tool "falling through".
 *
 * Connected external-MCP tools are discovered the same way (chat-ttft P4): the
 * spec no longer puts them in core, and the prompt names each connected server
 * so the model knows to search for it. `mcp_confirm_call`, the approval flow's
 * second half, stays in core. The ranking lives in ../lib/tool-search.ts.
 *
 * ── The ceiling is STRUCTURAL (the F1 invariant) ────────────────────────────
 * `search_tools` can only ever surface tools from `spec.ceilingTools`, which the
 * rebuild already clamped to the ceiling (inherit-all null → the FULL registry
 * ∪ external-MCP tools). Discovery therefore can never widen the ceiling. The
 * step resolver additionally intersects (core ∪ discovered) with the ceiling set
 * — defense in depth. And the internal tool route RE-DERIVES + enforces the
 * ceiling server-side (the authoritative gate), so an out-of-ceiling call is
 * rejected regardless of what the model believes.
 *
 * ── ask_user is EXCLUDED here (kept as a native HITL tool) ───────────────────
 * `ask_user` rides in ceilingTools (it's in CORE_TOOL_NAMES) but is the
 * clarifying-question picker with NO server-side execute; proxying it would 400
 * (TOOL_NO_EXECUTE). This resolver SKIPS `ask_user`; tools/ask_user.ts provides
 * it as a native HITL tool. `search_tools` is likewise native (minted here),
 * never proxied.
 *
 * ── Expertise packs (one-agent plan, Part 3) ────────────────────────────────
 * The first time the agent touches an area, its pack rides that tool result:
 * a `search_tools` result revealing the area's tools, the first call of one of
 * them (each area proxy captures its area), or `load_skill` of the area's
 * playbook. Only the model sees it (toModelOutput); see ../lib/expertise.ts.
 *
 * ── Replay safety (durability contract) ─────────────────────────────────────
 * Each proxy's `execute` is an INLINE arrow capturing serializable strings:
 * the tool name, the run token and the turn's search settings (JSON), plus
 * original human text for browser proxies. The bundler transform stamps these
 * so the execute is reconstructable on replay after a crash/resume.
 * `search_tools.execute` captures only the run token + the pre-encoded turn ctx
 * (both serializable strings) and re-fetches the spec on demand; the durable
 * `defineState` slot survives step boundaries and crashes.
 */
import { defineDynamic, defineTool, toolOutput } from 'eve/tools'
import { addDiscoveredTools, discoveredToolNames } from '../lib/discovered-tools.js'
import { z } from 'zod'
import {
  fetchChatSpec,
  fetchChatSkills,
  isCheckInRunToken,
  runTokenFromAuth,
  turnCtxFromAuth,
  dispatchChatTool,
  reportSkillLoaded,
  type ChatSpec,
} from '../lib/spec-client.js'
import { modelReadsToolImages, screenshotModelOutput } from '../lib/screenshot-output.js'
import { capToolModelOutput } from '../lib/model-output-cap.js'
import { CHAT_IMAGE_TOOL_NAMES, chatImageModelOutput } from '../lib/chat-image-output.js'
import { BROWSER_TOOL_NAMES, browserModelResult } from '../lib/browser-output.js'
import { browserTaskLimitRefusal, captureBrowserPermissionHandoff } from '../lib/browser-permission-handoff.js'
import { browserSourceRequest } from '../lib/browser-source-request.js'
import { MCP_APPROVAL_REQUIRED_SUFFIX, rankTools } from '../lib/tool-search.js'
import {
  attachAreaExpertise,
  attachCardExpertise,
  attachExpertise,
  cardRefOf,
  claimPacks,
  expertiseModelOutput,
  loadedPackAreas,
  packForPlaybook,
  packsForTools,
  resetPacksOnNewVersion,
  validPacks,
} from '../lib/expertise.js'
import { highestCardNumber, stampCardNumber } from '../lib/card-numbers.js'
import { listedSkillNames, matchSkill } from '../lib/skill-match.js'
import { ceilingToolsForRole, type ToolRole } from '../lib/helper-role.js'
import { isMacHost } from '../lib/host.js'
import { recordToolsSize, toolDefinitionTokens } from '../lib/context-parts.js'

/** Kept in sync with the native HITL tool (tools/ask_user.ts) — excluded here. */
const ASK_USER_TOOL_NAME = 'ask_user'
/** The discovery meta-tool is minted natively here — never proxied. */
const SEARCH_TOOLS_NAME = 'search_tools'
/**
 * The skill-loading meta-tool — minted natively here, never proxied.
 *
 * DELIBERATELY OUR OWN, not eve's skills (`defineSkill`, loaded with
 * `eve__skill`; eve 0.76 renamed its `load_skill` to that, so `load_skill` is an
 * ordinary tool name again). The old reason, that eve's dynamic skills start a
 * sandbox, is gone: since eve 0.66.0 "Dynamic skills no longer start a sandbox
 * to announce or load instructions". The reasons that still hold
 * (docs/plans/eve-alignment.md decision 20):
 *   - the source is the DB (`skills` rows, served by the spec route), not files;
 *   - what a person can load is per person (the caller's loadable skills,
 *     rebuildChatSkills in src/lib/chat/chat-run-rebuild.ts);
 *   - a playbook is part of an expertise pack (lib/expertise.ts: loading one
 *     claims its pack's tools), and `load_skill` feeds the skill analytics;
 *   - matching is fuzzy (lib/skill-match.ts), so a near-miss name still loads.
 * No eve skills are registered for this agent, so this native tool owns the
 * name. The advertised half (the "Available skills" section) rides the system
 * prompt via the spec route (buildSkillsPromptSection); this execute fetches
 * the matching playbook body on demand — the same progressive-disclosure shape
 * as search_tools, with the same replay-safe serializable captures.
 */
const LOAD_SKILL_NAME = 'load_skill'

/** The card reader (src/lib/ai/tools/show.ts): the one proxy that forwards the turn's cards. */
const READ_CARD_TOOL_NAME = 'read_card'
/** The page tool: its proxy stamps each card's number for the conversation. */
const SHOW_TOOL_NAME = 'show'
/**
 * The proxies besides `show` that forward the browser's zone: read_card (a
 * calendar card's local days) and the loop builders (a schedule that names
 * no timezone takes the person's; src/lib/ai/tools/flows.ts), and the table
 * tools that read a day word ("today", "tomorrow") as the person's date
 * (src/lib/ai/tools/tables.ts; without a zone they read the saved one).
 */
const ZONE_TOOL_NAMES: ReadonlySet<string> = new Set([READ_CARD_TOOL_NAME, 'create_flow', 'update_flow', 'create_table', 'write_rows', 'query_rows'])
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
 * The Mac body (contract C2, ../lib/host.ts) is the exception: its native web
 * tools are removed (tools/web_search.ts, tools/web_fetch.ts) and C1's spec
 * advertises server-side tools of the same names, so there they ARE proxied.
 * And C1's `message_teammate` (C4: a question for the cloud body, answered as
 * the next message) ends the turn, as the local agent's ask_manager did.
 */
const MAC_TURN_ENDING_TOOL_NAMES: ReadonlySet<string> = new Set(['message_teammate'])
/**
 * The Mac body's own tools: the fence's harness and the Mac host's slots. A
 * proxy of the same name would replace them, so none is ever minted there.
 */
const MAC_HOST_TOOL_NAMES: ReadonlySet<string> = new Set(['bash', 'read_file', 'write_file', 'finish', 'request_folder_access', 'studio_product'])

/** `endsTurn` for a proxy that ends the Mac body's turn; nothing otherwise (and nothing in the cloud). */
function turnEnding(name: string): { endsTurn?: true } {
  return MAC_TURN_ENDING_TOOL_NAMES.has(name) && isMacHost() ? { endsTurn: true } : {}
}
/**
 * The main chat's static workflow tool (tools/helpers.ts, A4 quick helpers).
 * No registry entry carries the name; guarded here like the web tools, since a
 * dynamic proxy of the same name would collide with it.
 */
const STATIC_TOOL_NAMES = new Set(['helpers'])

/**
 * Permissive FALLBACK input schema — used only when the spec carries no real
 * schema for a tool. Real validation is server-side against the tool's own
 * schema either way; advertising the real shape (below) is what lets the model
 * produce valid input on the first try.
 */
const passThroughInput = z.record(z.string(), z.unknown())

// The names `search_tools` discovered this session live in ../lib/discovered-tools.ts
// (durable state, dropped once the session summarizes: ../lib/context-reset.ts).
// Re-exported for the helper's resolver, which reads its own session's.
export { discoveredToolNames }

/** A ceiling-tool entry as carried on the spec. `inputSchema` is the tool's
 *  REAL input schema as plain JSON Schema (eve's defineTool accepts a raw
 *  JsonObject inputSchema) — absent entries fall back to `passThroughInput`. */
type CeilingTool = ChatSpec['ceilingTools'][number]

/**
 * The map entry type a tools resolver returns. Widened to `unknown` I/O so the
 * pass-through proxies (Record<string,unknown> input) and the typed
 * `search_tools` ({ query } input) can coexist in one map — eve names each entry
 * by its bare key regardless of the entry's input/output shape.
 */
type ToolEntry = ReturnType<typeof defineTool>
type ToolMap = Record<string, ToolEntry>

/** True when a name should be proxied (not native, in the advertised surface). */
function isProxyable(name: string): boolean {
  return (
    name !== ASK_USER_TOOL_NAME &&
    name !== SEARCH_TOOLS_NAME &&
    name !== LOAD_SKILL_NAME &&
    (!NATIVE_WEB_TOOL_NAMES.has(name) || isMacHost()) &&
    !STATIC_TOOL_NAMES.has(name) &&
    !(MAC_HOST_TOOL_NAMES.has(name) && isMacHost())
  )
}

/**
 * Build one inline-execute proxy per name (skipping natives). `available` maps
 * name → ceiling entry (from spec.ceilingTools). Only names present in
 * `available` are built — an unknown/out-of-ceiling name is silently dropped.
 * The inline arrow captures ONLY serializable values (name, runToken, the
 * search settings, and a browser proxy's human text and image boolean) for
 * replay; eve's call, turn and session ids come from the execute's own ctx
 * (the durable identity start_helper's admission keys on). The inputSchema is a
 * plain JSON object off the fresh spec (the
 * resolver re-runs per event, so nothing non-serializable crosses a step
 * boundary). Entries without a spec schema fall back to the permissive
 * pass-through — server-side validation is authoritative either way.
 *
 * Browser tools get a `toModelOutput`: correlation IDs stay in action.result
 * for hooks but leave the model context; screenshot base64 rides as an image
 * only when `toolImages` (this turn's model reads one). It captures that one
 * boolean. Step tools take precedence over session tools, so after a model
 * switch the next step's proxy carries the new model's answer.
 *
 * read_chat_file gets one too, on the same boolean: a photo the person
 * uploaded rides back as an image only for a model that reads one
 * (lib/chat-image-output.ts). It is the only way the chat's photos reach the
 * model: never as a file part on the message, which makes eve provision a sandbox.
 *
 * `helper` (a captured boolean): the proxies serve a quick helper's child
 * session, so each call is marked and the tool route admits read-plus-drafts
 * tools only (src/lib/chat/helpers-gate.ts). The names were already narrowed
 * to the helper's set (lib/helper-role.ts) before they reached here.
 */
function buildProxies(
  names: Iterable<string>,
  available: Map<string, CeilingTool>,
  runToken: string,
  toolImages: boolean,
  sourceRequest: string,
  turnCtx: string,
  toolAreas: ReadonlyMap<string, string>,
  cards = '',
  cardFloor = 0,
  timeZone = '',
  helper = false,
): ToolMap {
  // The browser's zone rides with show and ZONE_TOOL_NAMES alone: a calendar
  // card's local days, a schedule loop's default zone.
  const zone = timeZone ? { timeZone } : {}
  const entries: ToolMap = {}
  for (const name of names) {
    if (!isProxyable(name)) continue
    const entry = available.get(name)
    if (entry === undefined) continue // not in the discoverable/ceiling surface
    // The area whose pack this tool's first call loads ('' for none). A
    // captured string, like the rest, so the execute replays.
    const area = toolAreas.get(name) ?? ''
    const description = advertisedDescription(entry)
    entries[name] = BROWSER_TOOL_NAMES.has(name)
      ? (defineTool({
          description,
          inputSchema: entry.inputSchema ?? passThroughInput,
          execute: async (input, ctx) => {
            const turnId = ctx.session?.turn?.id
            const refusal = browserTaskLimitRefusal(turnId, name)
            if (refusal) return refusal
            const output = await dispatchChatTool(name, runToken, input, ctx.callId, turnId, ctx.session?.id, {
              browserSourceRequest: sourceRequest,
              ...(helper ? { helper: true } : {}),
            })
            if (turnId) captureBrowserPermissionHandoff({ turnId, toolName: name, input, output })
            return area ? attachAreaExpertise(output, area, runToken, turnCtx) : output
          },
          toModelOutput: (output) =>
            expertiseModelOutput(output, (rest) => screenshotModelOutput(browserModelResult(rest), toolImages)),
        }) as ToolEntry)
      : CHAT_IMAGE_TOOL_NAMES.has(name)
        ? (defineTool({
            description,
            inputSchema: entry.inputSchema ?? passThroughInput,
            execute: async (input, ctx) => {
              const output = await dispatchChatTool(name, runToken, input, ctx.callId, ctx.session?.turn?.id, ctx.session?.id, helper ? { helper: true } : {})
              return area ? attachAreaExpertise(output, area, runToken, turnCtx) : output
            },
            // A photo the person uploaded: an image for a model that reads one, a note otherwise.
            toModelOutput: (output) => expertiseModelOutput(output, (rest) => chatImageModelOutput(rest, toolImages)),
          }) as ToolEntry)
        : name === SHOW_TOOL_NAME
          ? (defineTool({
              description,
              inputSchema: entry.inputSchema ?? passThroughInput,
              // The card's number for the conversation, stamped on its result
              // (lib/card-numbers.ts): what the cards note and read_card name it by.
              // Then the pack of the card's area, the first time this
              // conversation shows one of its cards (lib/expertise.ts).
              execute: async (input, ctx) => {
                const output = stampCardNumber(
                  await dispatchChatTool(name, runToken, input, ctx.callId, ctx.session?.turn?.id, ctx.session?.id, { ...zone, ...(helper ? { helper: true } : {}) }),
                  ctx.callId,
                  cardFloor,
                )
                const card = cardRefOf(output)
                return card ? attachCardExpertise(output, card, runToken, turnCtx) : output
              },
              toModelOutput: (output) => expertiseModelOutput(output),
            }) as ToolEntry)
        : area
          ? (defineTool({
              description,
              inputSchema: entry.inputSchema ?? passThroughInput,
              ...turnEnding(name),
              execute: async (input, ctx) => {
                const output = await dispatchChatTool(name, runToken, input, ctx.callId, ctx.session?.turn?.id, ctx.session?.id, {
                  ...(name === READ_CARD_TOOL_NAME && cards ? { cards } : {}),
                  ...(ZONE_TOOL_NAMES.has(name) ? zone : {}),
                  ...(helper ? { helper: true } : {}),
                })
                return attachAreaExpertise(output, area, runToken, turnCtx)
              },
              // The pack, when this call loaded one, goes to the model as text after the result.
              toModelOutput: (output) => expertiseModelOutput(output),
            }) as ToolEntry)
          : (defineTool({
              description,
              inputSchema: entry.inputSchema ?? passThroughInput,
              ...turnEnding(name),
              execute: (input, ctx) =>
                dispatchChatTool(name, runToken, input, ctx.callId, ctx.session?.turn?.id, ctx.session?.id, {
                  // read_card re-runs a card's current spec: the turn's cards ride
                  // with its call alone, outside the model input.
                  ...(name === READ_CARD_TOOL_NAME && cards ? { cards } : {}),
                  ...(ZONE_TOOL_NAMES.has(name) ? zone : {}),
                  ...(helper ? { helper: true } : {}),
                }),
              // The model's copy, capped (lib/model-output-cap.ts); the default projection otherwise.
              toModelOutput: (output) =>
                capToolModelOutput(typeof output === 'string' ? toolOutput.text(output) : toolOutput.json(output ?? null)),
            }) as ToolEntry)
  }
  return entries
}

/**
 * The description a loaded tool advertises: its own, then its usage notes
 * (`guide`, src/lib/ai/tool-guides.ts). Notes ride only a loaded tool;
 * `search_tools` lists the description alone, so a search stays short.
 */
export function advertisedDescription(entry: Pick<CeilingTool, 'description' | 'guide'>): string {
  return entry.guide ? `${entry.description}\n\n${entry.guide}` : entry.description
}

/** Each pack tool's area, from the spec's packs (the area gate already applied). */
function toolAreasOf(spec: ChatSpec): Map<string, string> {
  const areas = new Map<string, string>()
  for (const pack of validPacks(spec.packs)) for (const name of pack.toolNames) if (!areas.has(name)) areas.set(name, pack.area)
  return areas
}

/**
 * Mint the native `search_tools` meta-tool. Its execute token-matches the query
 * against the spec's FULL `ceilingTools` (already ⊆ ceiling), records the matched
 * names into durable state, and returns them so the model knows what's available.
 * The inline execute captures ONLY serializable strings (runToken, turnCtx).
 */
function buildSearchTools(runToken: string, turnCtx: string, role: ToolRole = 'root') {
  return defineTool({
    description:
      'Discover additional tools by searching with a natural language query: workspace tools, ' +
      'and the tools of the external servers the user connected (start the query with the ' +
      'server name). Use this when you need a tool not currently available to you (e.g. ' +
      '"email drafts", "milestones", "CRM contacts", "linear create issue"). Matching tools ' +
      'become callable on your next step.',
    inputSchema: z.object({
      query: z
        .string()
        .describe('Natural language description of the capability you need.'),
    }),
    execute: async ({ query }) => {
      // Read the spec to search its full ceiling surface: the turn's memoized
      // fetch, so normally no new request.
      const spec = await fetchChatSpec(runToken, turnCtx)
      if (!spec) {
        return { tools: [], hint: 'Tool discovery is unavailable right now. Work with the tools you already have.' }
      }
      // A helper searches its own read-plus-drafts surface only (lib/helper-role.ts).
      const matches = searchCeiling(query, ceilingToolsForRole(spec, role))
      if (matches.length === 0) {
        return { tools: [], hint: 'No matching tools found. Try a different query.' }
      }
      // Record into durable state so the NEXT step.started advertises them.
      const names = matches.map((m) => m.name)
      addDiscoveredTools(names)
      // The packs of the areas this search just opened, the first time each
      // is opened: the agent reads how the area is done before it acts there.
      const loaded = new Set(loadedPackAreas())
      const packs = claimPacks(packsForTools(names, validPacks(spec.packs).filter((p) => !loaded.has(p.area))))
      return attachExpertise({
        // Name + description only — the next step's proxies advertise the full
        // input schema; duplicating it here would just burn result tokens. The
        // description is returned whole, approval note included: with the
        // connected-MCP tools no longer listed in the prompt (chat-ttft P4), it
        // and `requiresApproval` are where the model learns a tool is gated.
        // `requiresApproval` is Native Intelligence's own field, set from the note the MCP
        // adapter appends after the fenced third-party text, so the gate does
        // not rest on text the prompt calls untrusted.
        tools: matches.map((m) => ({
          name: m.name,
          description: m.description,
          ...(m.description.endsWith(MCP_APPROVAL_REQUIRED_SUFFIX) ? { requiresApproval: true } : {}),
        })),
        hint:
          'These tools are now available. Call them directly (they appear on your next step), ' +
          'unless a tool is marked requiresApproval (its description says Approval required).',
      }, packs)
    },
    toModelOutput: (output) => expertiseModelOutput(output),
  })
}

/**
 * Mint the native `load_skill` meta-tool. Its execute reads the caller's
 * ADVERTISED skill set (the spec route's `?skills=1` — same visibility rules as
 * the chips / All-skills surfaces, fetched fresh so a skill made or edited
 * earlier in this turn loads) and returns the
 * matching playbook body as the tool result. Loading adds INSTRUCTIONS only —
 * it can never widen the tool ceiling. The inline execute captures ONLY
 * serializable strings (runToken, turnCtx) — replay-safe like every native
 * tool here.
 */
function buildLoadSkill(runToken: string, turnCtx: string) {
  return defineTool({
    description:
      'Load a workspace skill (a playbook of instructions) by name. Use when the ' +
      'user’s request matches a skill listed under "Available skills" in your ' +
      'instructions or in an area’s expertise; then follow the returned playbook.',
    inputSchema: z.object({
      skill: z.string().describe('The skill name exactly as listed.'),
    }),
    execute: async ({ skill }) => {
      const skills = await fetchChatSkills(runToken, turnCtx)
      if (skills.length === 0) {
        return { error: 'No skills are available in this workspace right now.' }
      }
      // Exact name, then the name with punctuation ignored, then `<x>-playbook`, then a unique substring (lib/skill-match.ts).
      const found = matchSkill(skills, skill)
      if (found.kind === 'ambiguous') {
        return { error: `"${skill}" matches more than one skill. Call load_skill with one of these names.`, matches: found.names }
      }
      if (found.kind === 'none') {
        // The first 40 names, and how many more: a hundred skills would flood the result.
        return {
          error: `Unknown skill "${skill}".`,
          ...listedSkillNames(skills),
        }
      }
      const match = found.skill
      // Fire-and-forget analytics: record that a skill was auto-loaded. NOT
      // awaited — this must never delay the tool result. reportSkillLoaded
      // swallows every error internally, so `void` can't leak an unhandled
      // rejection; and the eve session keeps streaming after the tool returns,
      // so the POST has time to land.
      void reportSkillLoaded(runToken, match.name)
      // An area's playbook loads its whole pack (playbook, the area's skills,
      // what was learned there), and counts as that pack loaded. Asked for by
      // name, so it comes back even when the pack loaded earlier.
      const pack = packForPlaybook(match.name, validPacks((await fetchChatSpec(runToken, turnCtx))?.packs))
      if (pack) {
        return attachExpertise(
          { skill: match.name, note: `The ${pack.name} expertise follows. Follow it for work in ${pack.name}.` },
          claimPacks([pack], true),
        )
      }
      const result = {
        skill: match.name,
        instructions: match.markdown,
        note: 'Follow this playbook for the current task.',
      }
      // An area's skill is written on top of its area's core, listed in the
      // pack or globally: the pack comes with it, once per conversation (an
      // area already loaded isn't sent again).
      if (typeof match.area === 'string') {
        return attachAreaExpertise(result, match.area, runToken, turnCtx)
      }
      return result
    },
    toModelOutput: (output) => expertiseModelOutput(output),
  })
}

/**
 * Search over the spec's ceiling tools (the ranking: ../lib/tool-search.ts).
 * Only ceiling tools are searched, so a match can never widen the ceiling.
 * Native tools (search_tools/ask_user) are never returned as matches.
 */
function searchCeiling(query: string, ceilingTools: CeilingTool[]): CeilingTool[] {
  return rankTools(
    query,
    ceilingTools.filter((tool) => isProxyable(tool.name)),
  )
}

/**
 * Resolve the advertised proxy set for a moment in the session.
 *
 * `names` is the base set to advertise (core on session.started; core ∪
 * discovered on step.started). It's intersected with the spec's ceiling surface
 * (`available` is built FROM ceilingTools, so a name absent there is dropped) —
 * belt-and-suspenders on top of the internal route's authoritative check.
 * `search_tools` is always added. Returns null when there is nothing to advertise
 * (should not happen — search_tools is always present — but keeps the contract
 * that a resolver may return null).
 *
 * `role` 'helper' serves a quick helper's child session
 * (subagents/helper/tools/workspace_tools.ts): the surface narrows to the
 * spec's `helperToolNames` (lib/helper-role.ts), so core, discovery and the
 * search all stay inside it, and every proxy marks its call as a helper's.
 */
export async function resolveAdvertised(
  auth: unknown,
  extraNames: Iterable<string>,
  messages?: readonly unknown[],
  role: ToolRole = 'root',
): Promise<ToolMap | null> {
  const runToken = runTokenFromAuth(auth as never)
  const turnCtx = turnCtxFromAuth(auth as never)
  // The check-in's session (docs/plans/now-file.md "Who may write the note"):
  // no web at all, read from its token so it holds even when the spec can't
  // be fetched. Its context may hold nothing from outside, and web_search is
  // provider-executed (nothing refuses it at call time), so both native web
  // tools are replaced, by name, at session start and before every model call.
  const webStubs = !isMacHost() && isCheckInRunToken(runToken) ? checkInWebStubs() : null
  // { schemas: true } — this is the ONE consumer that builds proxies, so it is
  // the one that reads the real input schemas on ceilingTools (the turn's
  // memoized fetch always carries them).
  const spec = await fetchChatSpec(runToken, turnCtx, { schemas: true })
  // No spec (unknown token, route down) → no workspace tools this moment.
  if (!spec) return webStubs
  // A deploy changed the packs' text: forget the loaded ones before this step
  // claims any, so the next touch of an area brings its new text (lib/expertise.ts).
  resetPacksOnNewVersion(spec.packsVersion)

  const available = new Map(ceilingToolsForRole(spec, role).map((t) => [t.name, t]))

  // Base = the spec's core subset. Extra = whatever the caller layers on
  // (discovered names on step.started). Both are clamped to `available` inside
  // buildProxies, so nothing outside the ceiling surface is ever built.
  const names = new Set<string>([...spec.coreToolNames, ...extraNames])
  const cards = Array.isArray(spec.cards) && spec.cards.length ? JSON.stringify(spec.cards) : ''
  const entries = buildProxies(
    names,
    available,
    runToken,
    // Never on the Mac body: it has a sandbox, and eve stages a tool result's
    // image into it (/workspace/.eve/attachments: the person's folder, or the
    // worktree a finish commits), or fails the turn in a read-only job.
    !isMacHost() && modelReadsToolImages(spec.model),
    browserSourceRequest(messages),
    turnCtx,
    toolAreasOf(spec),
    cards,
    highestCardNumber(spec.cards),
    typeof spec.timeZone === 'string' ? spec.timeZone : '',
    role === 'helper',
  )

  // search_tools is the native discovery meta-tool — always reachable. Its typed
  // { query } input differs from the pass-through proxies, so cast into ToolMap.
  entries[SEARCH_TOOLS_NAME] = buildSearchTools(runToken, turnCtx, role) as ToolEntry
  // load_skill is the native skill-loading meta-tool — always reachable; the
  // "Available skills" prompt section tells the model when to reach for it.
  entries[LOAD_SKILL_NAME] = buildLoadSkill(runToken, turnCtx) as ToolEntry
  return webStubs ? { ...entries, ...webStubs } : entries
}

/** What a stubbed web tool tells the model in a check-in's session. */
const CHECK_IN_WEB_OFF_DESCRIPTION = 'Not available in your check-in: it reads only Native Intelligence’s own records. Do not call this tool.'

/**
 * Refusal stubs for the native web tools (web_search, web_fetch), for the
 * check-in's session: a dynamic tool overrides the same-named authored one
 * (eve docs, guides/dynamic-capabilities "Conflicts"), as the skill-runner's
 * web kill switch does (agents/skill-runner/tools/workspace_tools.ts). Inline
 * executes with no captures (replay-safe); they touch nothing.
 */
export function checkInWebStubs(): ToolMap {
  const entries: ToolMap = {}
  for (const name of NATIVE_WEB_TOOL_NAMES) {
    entries[name] = defineTool({
      description: CHECK_IN_WEB_OFF_DESCRIPTION,
      inputSchema: passThroughInput,
      execute: () => ({ error: 'The web is not available in a check-in.' }),
    }) as ToolEntry
  }
  return entries
}

export default defineDynamic({
  events: {
    // Durable baseline: core proxies + search_tools. eve persists this as the
    // session tool metadata (survives replay). Discovery has not run yet, so no
    // extra names.
    'session.started': async (_event, ctx) => resolveAdvertised(ctx.session.auth, [], ctx.messages),

    // Per model call: re-derive core ∪ discovered-from-state (+ search_tools).
    // step tools are EPHEMERAL (LiveStepToolsKey) and merge with the durable
    // session set, so this is where progressive expansion happens: as the model
    // discovers tools (search_tools → state), the next step advertises them.
    // What they cost this call is kept for the side panel's Context card
    // (lib/context-parts.ts): the turn's last call's set is what the meter reports.
    'step.started': async (event, ctx) => {
      const entries = await resolveAdvertised(ctx.session.auth, discoveredToolNames(), ctx.messages)
      if (entries) recordToolsSize(turnIdOf(event), toolDefinitionTokens(entries))
      return entries
    },
  },
})

/** The turn id a step.started event carries (`data.turnId`), or null. */
function turnIdOf(event: unknown): string | null {
  const id = (event as { data?: { turnId?: unknown } } | null)?.data?.turnId
  return typeof id === 'string' && id ? id : null
}
