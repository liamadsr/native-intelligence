/**
 * Fetch the rebuilt ChatSpec from the Next app's internal route, for the
 * chat-agent eve agent's dynamic resolvers (Phase 4 — main chat → eve).
 *
 * The eve runtime is a SEPARATE service from the Next app. The EveChatTransport
 * mints an HMAC-signed chat-run token carrying the DURABLE routing facts
 * (conversationId, workspaceId, userId, agentId?, skillId?) and presents it on
 * the `x-chat-run-token` request header; the chat-agent's channel AuthFn
 * (../channels/eve.ts) — AFTER it authenticates the Supabase session and runs
 * the session-ownership ACL — stamps that token + the per-turn context onto the
 * session principal's attributes. The resolvers read them here and call
 * GET /api/internal/chat/spec (plus the shared internal secret) to get back the
 * layered system prompt, plan-clamped model, and ceiling tools — REBUILT
 * server-side from live DB state via the SAME buildChatSystemPrompt the cloud
 * route uses. Nothing Next-coupled compiles into the eve runtime; only this
 * tiny fetch does.
 *
 * The tool proxies use a mirror POST helper against /api/internal/chat/tool.
 *
 * ── The durable-vs-per-turn split (mirrors chat-run-token.ts) ────────────────
 * DURABLE facts live inside the signed token (re-verified on the internal route,
 * the authoritative tenancy source). The VOLATILE per-turn context (editor
 * selection, chat files, live-capture id, attached projects, email thread,
 * requested model) is NOT in the token — it rides as an already
 * base64url-encoded JSON string the transport built, forwarded verbatim as the
 * `?ctx=` query param. A bad/absent ctx degrades to an empty turn context on the
 * route (never a 500), so this never has to validate it.
 */
import type { SessionAuth } from 'eve/context'
import {
  selectionWithPolicy,
  validModelPolicy,
  type JsonObject,
  type JsonValue,
  type ModelPolicy,
  type ModelSelection as PolicyModelSelection,
} from './model-policy.js'
import { withChatCompactionWindowFor } from './compaction-window.js'
import { personMessageSeq, quoteVerified, recentPersonMessages, recentPersonMessageTurns } from './person-messages.js'
import { currentTurnModel } from './turn-model-selection.js'
import { isMacHost } from './host.js'
import { MAC_PROBE_TIMEOUT_MS, macRouteState, macRouteTarget } from './mac-host.js'

/** Header names — kept in sync with src/lib/chat/chat-run-token.ts. */
const CHAT_RUN_SECRET_HEADER = 'x-chat-run-secret'
const CHAT_RUN_TOKEN_HEADER = 'x-chat-run-token'

/**
 * Per-user Gateway attribution (Phase A) as it rides the spec wire. Mirrors the
 * Next-side `GatewayTelemetryValues` (src/lib/ai/gateway-telemetry.ts) — a plain
 * JSON-serializable object (eve requires each providerOptions entry be one). The
 * eve runtime never imports the Next helper, so the shape is redeclared here.
 *
 * A `type` alias (not an `interface`) on purpose: eve types a model selection's
 * `providerOptions` as `Record<string, JsonObject>`, and only an object-literal
 * type alias structurally satisfies that index signature — an interface does not
 * (interfaces lack an implicit index signature), so returning this under
 * `modelOptions.providerOptions.gateway` would fail typecheck as an interface. */
export type GatewayTelemetry = {
  user?: string
  tags: string[]
}

/**
 * Shape-guard a spec's `gatewayTelemetry` before it rides a model selection. A
 * malformed telemetry object must NEVER crash the model resolver (that would kill
 * the session) — eve's selection keys are strict, and every providerOptions entry
 * must be a JSON-serializable plain object. `user` must be a string or absent;
 * `tags` an array of strings; anything else → return null and the resolver uses
 * the plain model string exactly as before. Lives here (not agent.ts) so it's
 * unit-testable alongside the spec-parse tests.
 */
export function validGatewayTelemetry(t: unknown): GatewayTelemetry | null {
  if (!t || typeof t !== 'object') return null
  const obj = t as Record<string, unknown>
  if (obj.user !== undefined && typeof obj.user !== 'string') return null
  if (!Array.isArray(obj.tags) || !obj.tags.every((x) => typeof x === 'string')) return null
  const guarded: GatewayTelemetry = { tags: obj.tags as string[] }
  if (typeof obj.user === 'string') guarded.user = obj.user
  return guarded
}

/**
 * How chat calls the spec's model (its context window, its thinking, and which
 * Gateway hosts may serve it), and the shape-guard it passes before it rides a
 * model selection: lib/model-policy.ts, shared by copy with the other agents.
 */
export type ChatModelPolicy = ModelPolicy
export { validModelPolicy, type ReasoningEffort, type GatewayRouting } from './model-policy.js'

/**
 * The value the chat-agent's dynamic model resolver returns to eve: a bare
 * model-id STRING, or the OBJECT selection form. The object carries the model
 * policy (`reasoning`, `modelContextWindowTokens`) and, under
 * `modelOptions.providerOptions`, the provider options plus a `gateway` entry
 * holding the attribution and the host routing. Exactly the keys eve's
 * resolveRuntimeModelSelection accepts ({ model, reasoning?,
 * modelContextWindowTokens?, modelOptions? }; any other key throws); eve merges
 * providerOptions into every step call. `null` means "no usable model in this
 * spec".
 */
export type ModelSelection = PolicyModelSelection

/**
 * Map a fetched ChatSpec to the model selection the resolver returns. Extracted
 * from agent.ts so the branches are unit-testable in isolation (the resolver
 * itself only wires auth → fetch → this, plus the fallback on failure).
 *
 * Three behaviours; the first two are preserved verbatim from the original
 * inline resolver:
 *
 *   1. PROVIDER QUALIFICATION. `spec.model` is the plan-clamped id, already a
 *      Gateway slug from the Next side (e.g. 'moonshotai/kimi-k2.6'). When it is
 *      already provider-qualified (`includes('/')`) it is passed through as-is;
 *      a bare id (defense-in-depth if an older Next ever sends one) is prefixed
 *      'anthropic/' — the historical default. A Kimi/DeepSeek id that arrives
 *      qualified therefore reaches its real provider instead of being re-routed
 *      to anthropic.
 *
 *   2. GATEWAY ATTRIBUTION. When the spec carries a valid telemetry object
 *      (`validGatewayTelemetry`), return the OBJECT selection form so
 *      `providerOptions.gateway` reaches EVERY generation this turn (eve merges
 *      modelReference.providerOptions into each step call, preserving user/tags).
 *      This attribution must work on every turn, so it is recomputed here per
 *      turn.
 *
 *   3. MODEL POLICY. The spec's `modelPolicy` (`validModelPolicy`) adds
 *      `reasoning` and `modelContextWindowTokens` to the object form, its
 *      provider options beside `gateway`, and its host routing inside
 *      `gateway` next to user/tags. eve's `mergeGatewayAutoCaching`
 *      (harness/prompt-cache.js) shallow-merges `caching: 'auto'` into that same
 *      entry, so the routing survives. Routing never travels in the telemetry:
 *      validGatewayTelemetry keeps only user + tags. Its window is capped at
 *      CHAT_COMPACTION_WINDOW_TOKENS (lib/compaction-window.ts
 *      withChatCompactionWindowFor), and a known model with no policy window
 *      gets its real window, capped the same way: eve uses it only to decide
 *      when to compact, so a 1M model compacts inside a turn at 225K tokens
 *      whatever the policy says.
 *
 * With neither a valid telemetry object nor a valid policy it returns the plain
 * string, exactly as before either existed. Returns `null` when the spec has no
 * model (the resolver then returns its fallback — see agent.ts for why it
 * never throws).
 */
export function modelSelectionFromSpec(spec: ChatSpec | null): ModelSelection | null {
  if (!spec?.model) return null
  const modelId = spec.model.includes('/') ? spec.model : `anthropic/${spec.model}`
  return selectionWithPolicy(
    modelId,
    validGatewayTelemetry(spec.gatewayTelemetry),
    withChatCompactionWindowFor(modelId, validModelPolicy(spec.modelPolicy)),
  )
}

/**
 * JSON-serializable value/object — a structural mirror of eve's `JsonValue` /
 * `JsonObject` (shared/json.d.ts), which eve does not export from its public
 * `eve/tools` entrypoint. `defineTool` accepts a plain JsonObject as
 * `inputSchema`, so typing the wire schema this way lets the proxies pass it
 * straight through without casts.
 */
export type { JsonValue, JsonObject }
export type ToolInputSchemaJson = JsonObject

/**
 * ── ChatSpec ────────────────────────────────────────────────────────────────
 * The eve-facing view returned by GET /api/internal/chat/spec. Mirrors the
 * Next-side `ChatSpec` (src/lib/chat/chat-run-rebuild.ts) exactly — prompt text
 * + plan-clamped model + tool names only; NO secrets, NO tenancy (that stays in
 * the token). The resolvers consume this shape verbatim.
 */
export interface ChatSpec {
  /** The system prompt, rebuilt server-side. On the `?turnContext=1` variant
   *  the per-turn fetch asks for, only what stays the same from turn to turn
   *  (the per-turn layers ride `turnContext`); from an app that predates the
   *  split, the full layered prompt (the ~11 prepends). */
  systemPrompt: string
  /** The plan-CLAMPED model id (e.g. 'claude-haiku-4-5-20251001'). */
  model: string
  /** Bare ceiling tool names, or `null` for inherit-all. The resolver never
   *  reads this directly — it iterates `ceilingTools`, which already enumerates
   *  the full surface when inherit-all — but it stays on the wire shape so the
   *  eve-facing view mirrors the Next-side ChatSpec exactly. */
  ceiling: string[] | null
  /** One {name, description, inputSchema?} per tool in the DISCOVERABLE surface
   *  — the FULL registry ∪ external-MCP tools ∪ search_tools when inherit-all,
   *  else the ceiling set. This is what `search_tools` can reveal; it is NOT
   *  what the resolver advertises upfront. The resolver builds one proxy per
   *  entry only as tools become discovered (see tools/workspace_tools.ts).
   *  `inputSchema` is the tool's REAL input schema as plain JSON Schema (the
   *  same zod-derived shape the cloud path's streamText advertises) — eve's
   *  defineTool accepts a raw JSON-Schema object, so proxies advertise the true
   *  parameter shape instead of a blank pass-through. Absent → the proxy falls
   *  back to permissive (server-side validation stays authoritative).
   *  `guide`: a registry tool's usage notes, which the proxy appends to the
   *  description it advertises (advertisedDescription); `search_tools` lists
   *  the description alone. */
  ceilingTools: Array<{ name: string; description: string; inputSchema?: ToolInputSchemaJson; guide?: string }>
  /** The SMALL core subset advertised UPFRONT (before any discovery):
   *  CORE_TOOL_NAMES ∩ ceiling, plus `mcp_confirm_call` when the surface has
   *  it. Connected external-MCP tools are NOT in it (chat-ttft P4): they ride
   *  `ceilingTools` and load through `search_tools` like every other non-core
   *  tool. Always ⊆ ceiling. `search_tools`/`ask_user` are native and excluded.
   *  The resolver proxies exactly these on session start; `search_tools` grows
   *  the set per-step from durable discovery state. */
  coreToolNames: string[]
  /** The caller's loadable skills — present ONLY on the `?skills=1` variant,
   *  which the per-turn memo always fetches (absent from an app that answered
   *  without it). */
  skills?: ChatSkill[]
  /** The expertise packs this conversation may load, on the same `?skills=1`
   *  variant (the Next-side ChatPack, src/lib/packs/chat-packs.ts). Read only
   *  through validPacks (./expertise.ts), which shape-guards each entry; absent
   *  from an app that predates packs, and then nothing loads. */
  packs?: unknown
  /** The packs' code-defined text's version: a new one forgets the loaded packs (lib/expertise.ts resetPacksOnNewVersion). */
  packsVersion?: unknown
  /** Per-user Gateway attribution (Phase A). Present only when the Next side has
   *  GATEWAY_USER_TAGGING on. The session model resolver rebuilds
   *  `providerOptions.gateway` from this (shape-guarded — see agent.ts). */
  gatewayTelemetry?: GatewayTelemetry
  /** How `model` is called: context window, thinking, Gateway host routing.
   *  Absent from an older app's spec. The model resolver keeps only the fields
   *  that validate (validModelPolicy) and folds them into the selection
   *  (modelSelectionFromSpec). */
  modelPolicy?: ChatModelPolicy
  /** How this turn's model was chosen (auto model selection: tier, decider,
   *  rule names). Opaque here: the resolver keeps it for the usage report
   *  (lib/turn-model-route.ts), which shape-guards it. */
  modelRoute?: unknown
  /** Each helper roster model's call, by key (HELPER_MODELS in
   *  src/lib/ai/models.ts): `{ model, modelPolicy, identityNote, tier }`. A
   *  quick helper's session reads its own entry (./helper-models.ts), which
   *  shape-guards it. Absent on a ChatGPT-plan turn and from an older app. */
  helperModels?: unknown
  /** Present when this turn runs on the person's own ChatGPT plan (the free
   *  tier): the plan models and reasoning. Read only through validChatGptPlan
   *  (./chatgpt-plan-model.ts); absent for everyone else and from an older
   *  app. */
  chatgptPlan?: unknown
  /** The per-turn context (chat-ttft P3): one keyed section per layer this
   *  turn's ctx fills (the clock, the view, attachments, mentions, the mail
   *  thread…). Present only on the `?turnContext=1` variant, and absent from an
   *  app that predates it. The turn-context instructions resolver
   *  (../instructions/turn-context.ts) shape-guards it (validTurnContext) and
   *  sends what changed as a user-role message. */
  turnContext?: ChatTurnContextSection[]
  /** The turn-context keys whose layer this turn's ctx asked for and that
   *  failed to load (a transient read error, not an absent layer). The
   *  resolver neither sends nor clears them, so the version the model already
   *  has stands. Absent when none failed, and from an app that predates it. */
  turnContextHeld?: string[]
  /** The cards on the person's screen this turn, as the app checked them.
   *  Opaque here: only the read_card proxy forwards them (as JSON), so the
   *  route can re-run a card's current spec. Never shown to the model from
   *  here; it sees cards only through the diffed `cards` section. Absent when
   *  the turn carried none, and from an app that predates them. */
  cards?: unknown[]
  /** The browser's IANA zone this turn, as the app checked it: forwarded with
   *  show and read_card (a calendar card's local days) and with create_flow
   *  and update_flow (a schedule loop's default zone). */
  timeZone?: string
  /**
   * Quick helpers (A4 slice 3): whether this conversation may start them,
   * computed by the spec route from the VERIFIED token (no device ask, bot
   * conversation, relayed turn or server-minted token; a kill switch). Read
   * by the `helpers` tool's first step (../tools/helpers.ts). Absent from an
   * app that predates it, which reads as not allowed.
   */
  helpersAllowed?: boolean
  /** Why helpers are refused here, handed to the model verbatim. */
  helpersRefusal?: string
  /**
   * The discoverable tools a helper may call: reads and drafts, no cards,
   * browser, memory, external writes or MCP (src/lib/chat/helpers-gate.ts).
   * The helper's tool resolver advertises only these; absent → none.
   */
  helperToolNames?: string[]
}

/** One keyed section of the per-turn context, as it rides the spec wire.
 *  Mirrors the Next-side `ChatPromptSection` (src/lib/ai/chat-system-prompt.ts).
 *  An append-only section (`log`, A2b: src/lib/log/log-section.ts) also
 *  carries its lines with their ids (`entries`) and the heading each block of
 *  it opens with: the resolver sends only the lines past the cursor it last
 *  sent (../lib/turn-context.ts). `markdown` is then the full rendering. */
export type ChatTurnContextSection = {
  key: string
  markdown: string
  heading?: string
  entries?: ChatTurnContextEntry[]
}

/** One line of an append-only section: its id (a decimal bigint, the cursor) and its text. */
export type ChatTurnContextEntry = {
  id: string
  line: string
}

/**
 * ── ChatSkill ───────────────────────────────────────────────────────────────
 * One workspace skill served for the NATIVE `load_skill` meta-tool
 * (tools/workspace_tools.ts). Mirrors the Next-side `ChatSkill` exactly:
 * `name` is the load_skill argument, `description` the routing hint (already
 * advertised in the spec's system prompt via buildSkillsPromptSection),
 * `markdown` the full playbook returned as the tool result on load. `area`
 * and `packOnly` say a skill is listed only in its area's pack: loading it
 * attaches that pack too.
 */
export interface ChatSkill {
  name: string
  description: string
  markdown: string
  /** The skill's area, when it has one. */
  area?: string
  /** Listed only in its area's pack, not under "Available skills". */
  packOnly?: boolean
}

function env(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`[chat-agent] missing required env var ${name}`)
  return v
}

/**
 * The internal shared secret used to authenticate the eve runtime to the Next
 * internal routes. Prefers CHAT_INTERNAL_SECRET, falls back to
 * RUN_SKILL_INTERNAL_SECRET so a single secret bootstraps dev — identical
 * resolution to `internalSecret()` in src/lib/chat/chat-run-token.ts.
 */
function internalSecret(): string {
  const s = process.env.CHAT_INTERNAL_SECRET
  if (s && s.length > 0) return s
  return env('RUN_SKILL_INTERNAL_SECRET')
}

/**
 * One-shot latch so the dev base-URL mismatch warning below fires at most once
 * per process — a per-turn spec fetch would otherwise spam it on every turn.
 */
let warnedBaseUrlMismatch = false

/**
 * Dev-only guardrail (worktree trap): when running a dev server on a non-default
 * PORT while NEXT_PUBLIC_APP_URL still points at a DIFFERENT localhost port, the
 * spec fetch silently hits the OTHER server — the resolver reads a stale/foreign
 * spec and the failure looks like anything but a misconfigured env. Warn once.
 * Never fires in production (no PORT-vs-URL ambiguity there) and never changes
 * behavior — it only surfaces the mismatch. All parsing is guarded so a
 * malformed URL can never throw out of the base-URL resolver.
 */
function warnOnDevBaseUrlMismatch(appUrl: string): void {
  if (warnedBaseUrlMismatch) return
  if (process.env.NODE_ENV === 'production') return
  const port = process.env.PORT
  if (!port) return
  try {
    const parsed = new URL(appUrl)
    const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
    // The URL's effective port: explicit, else the protocol default (80/443).
    const urlPort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
    if (isLocalhost && urlPort !== port) {
      warnedBaseUrlMismatch = true
      console.warn(
        `[chat-agent] NEXT_PUBLIC_APP_URL (${appUrl}) does not match this dev server's PORT=${port} — spec fetches will hit a DIFFERENT server (worktree trap; override NEXT_PUBLIC_APP_URL in .env.development.local)`,
      )
    }
  } catch {
    // A malformed NEXT_PUBLIC_APP_URL is not this warning's problem — the fetch
    // below will surface the real error. Never throw out of base-URL resolution.
  }
}

/**
 * The Next app's own origin: NEXT_PUBLIC_APP_URL (the internal routes are the
 * app's). In dev the eve sidecar and Next dev share localhost:3000.
 */
function appBaseUrl(): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  warnOnDevBaseUrlMismatch(appUrl)
  return appUrl
}

/**
 * The ChatGPT plan proxy (src/app/api/internal/chatgpt-plan/v1/responses):
 * the base URL a plan model calls, and a fetch that adds the internal secret
 * and the run token to each request as it goes. They
 * ride the fetch, never a provider's `headers`, which the AI SDK's workflow
 * serializer would write out with the model (./chatgpt-plan-model.ts).
 */
export function chatGptPlanProxy(runToken: string): { baseURL: string; fetch: typeof fetch } {
  return {
    baseURL: `${appBaseUrl()}/api/internal/chatgpt-plan/v1`,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers)
      // The SDK's placeholder key: the proxy authenticates the run token.
      headers.delete('authorization')
      headers.set(CHAT_RUN_SECRET_HEADER, internalSecret())
      headers.set(CHAT_RUN_TOKEN_HEADER, runToken)
      return fetch(input, { ...init, headers })
    },
  }
}

/** Read the chat-run token off the verified session principal, or '' when absent. */
export function runTokenFromAuth(auth: SessionAuth): string {
  const raw = auth.current?.attributes?.chatRunToken
  return typeof raw === 'string' ? raw : ''
}

/**
 * Read the id of the reply the turn's current send names off the verified
 * session principal, or '' when absent (../channels/eve.ts validated it).
 */
export function replyIdFromAuth(auth: SessionAuth): string {
  const raw = auth.current?.attributes?.chatReplyId
  return typeof raw === 'string' ? raw : ''
}

/**
 * Read the pre-encoded per-turn context (base64url JSON) off the verified
 * session principal, or '' when absent. The transport built this string and the
 * channel stamped it; it is forwarded verbatim as the spec route's `?ctx=`
 * param (the route decodes + shape-guards it, degrading to empty on any fault).
 */
export function turnCtxFromAuth(auth: SessionAuth): string {
  const raw = auth.current?.attributes?.chatRunCtx
  return typeof raw === 'string' ? raw : ''
}

/**
 * Options shared by both spec fetchers — a named type so the wrapper and the
 * result-returning core stay in lockstep. They say what the CALLER reads; the
 * fetch itself always asks for both (the per-turn memo below serves every
 * caller from one superset fetch).
 */
export interface FetchChatSpecOpts {
  /** The caller reads the loadable skills (`?skills=1`): the systemPrompt
   *  with the "Available skills" section, and `spec.skills`. The instructions
   *  resolver and the load_skill execute. */
  skills?: boolean
  /** The caller reads each ceiling tool's real input JSON Schema
   *  (`?schemas=1`). The tools resolver, which builds the proxies. */
  schemas?: boolean
  /** The caller reads the split prompt (`?turnContext=1`): the stable
   *  systemPrompt and `spec.turnContext`. The persona and the turn-context
   *  instructions resolvers. */
  turnContext?: boolean
}

/**
 * ── ChatSpecFetchResult ─────────────────────────────────────────────────────
 * The DISCRIMINATED outcome of a spec fetch. `fetchChatSpec` (below) collapses
 * this to `spec | null`, which is right for the soft-degrade callers (model,
 * instructions, tools). But the usage-limit gate hook needs to DISTINGUISH a
 * real billing block (429 / 503 BILLING_UNAVAILABLE — hard-fail the turn) from a
 * transient outage (401/500/network — leave the soft paths to degrade). So the
 * core fetch returns this shape and the hook branches on `status` + `body`.
 *
 *   - `{ ok: true, spec }`                     — 200, parsed spec.
 *   - `{ ok: false, status: number, body }`    — non-OK HTTP; `body` is the
 *                                                parsed JSON error, or null when
 *                                                the body wasn't JSON.
 *   - `{ ok: false, status: 'no-token' }`      — no run token (never fetched).
 *   - `{ ok: false, status: 'misconfigured' }` — the Mac body has a session
 *                                                token but no usable route to the
 *                                                app (never fetched; never the cloud).
 *   - `{ ok: false, status: 'network' }`       — fetch threw (offline / DNS /
 *                                                misconfigured secret env).
 */
export type ChatSpecFetchResult =
  | { ok: true; spec: ChatSpec }
  | { ok: false; status: number; body: unknown }
  | { ok: false; status: 'network' | 'no-token' | 'misconfigured' }

/**
 * ── One spec fetch per turn ─────────────────────────────────────────────────
 * The usage gate, the model resolver, the persona, both tool resolvers and
 * search_tools all read the same spec within a turn, and each
 * fetch is a full rebuild on the app side. eve runs a turn's session, turn and
 * first-step events in one turnStep, in this process, so they share ONE
 * in-flight fetch, keyed by (run token, turn ctx). It always asks for the
 * superset variant (skills + schemas + the split prompt), which carries what
 * every one of them reads.
 *
 * The browser mints a new run token on every send, so the key is effectively
 * the turn. Later steps reuse the fetch while the same warm instance runs them
 * and refetch on a cold one, as every step did before. A HITL answer resumes
 * on a new eve turn with the SAME token and ctx, so within the TTL it reuses
 * the parked turn's spec, usage check included. If sends ever stop minting a
 * token each, add the turn id to the key, or two quick turns with identical
 * ctx would share one spec. A failure that may pass is tried once more first
 * (fetchChatSpecWithRetry); a failed fetch is never kept: the next caller
 * fetches again.
 *
 * load_skill is the one reader that skips the memo (fetchChatSkills): the
 * chat's own create_skill / update_skill change `spec.skills` mid-turn, and it
 * runs only on demand, off the per-step path. Everyone else may read the
 * turn-start snapshot. The step resolvers and search_tools read the ceiling,
 * core tools and schemas, which no chat tool writes; and the persona's
 * "Available skills" list is built once at turn start either way.
 */
const SPEC_MEMO_TTL_MS = 60_000
const SPEC_MEMO_MAX = 64
const specMemo = new Map<string, { at: number; result: Promise<ChatSpecFetchResult> }>()

/** Test-only: forget every memoized spec. */
export function resetSpecMemoForTests(): void {
  specMemo.clear()
}

/**
 * The rebuilt ChatSpec for `runToken` (+ the pre-encoded per-turn ctx), as the
 * FULL discriminated outcome: the turn's one memoized superset fetch (see
 * above), so `opts` only records what the caller reads. This is the shared
 * core; `fetchChatSpec` is a thin wrapper that discards everything but the
 * spec. The ?live=1 probe (probeChatRunLive) is never memoized.
 */
export async function fetchChatSpecResult(
  runToken: string,
  turnCtx: string,
  _opts: FetchChatSpecOpts = {},
): Promise<ChatSpecFetchResult> {
  if (!runToken) return { ok: false, status: 'no-token' }
  const key = `${runToken}\n${turnCtx}`
  const now = Date.now()
  const hit = specMemo.get(key)
  if (hit && now - hit.at < SPEC_MEMO_TTL_MS) return hit.result

  const result = fetchChatSpecWithRetry(runToken, turnCtx, { skills: true, schemas: true, turnContext: true })
  // Delete first so a refetched key moves to the back: eviction drops the oldest fetch.
  specMemo.delete(key)
  specMemo.set(key, { at: now, result })
  // Never keep a failure. The fetch (and its retry) never rejects, so this can't either.
  void result.then((r) => {
    if (!r.ok && specMemo.get(key)?.result === result) specMemo.delete(key)
  })
  while (specMemo.size > SPEC_MEMO_MAX) {
    const oldest = specMemo.keys().next().value
    if (oldest === undefined) break
    specMemo.delete(oldest)
  }
  return result
}

/** The wait before the turn's one retry of a failed spec fetch. */
export const SPEC_RETRY_DELAY_MS = 400

/**
 * A failure worth one more try: the fetch threw, the route wasn't there (a
 * dev server still compiling it answers 404), or the app failed (5xx). Never
 * an answer: a bad or expired token (401/403), the usage limit (429) or the
 * billing check's fail-closed 503 BILLING_UNAVAILABLE, which the usage-limit
 * gate reads as they are.
 */
export function isRetryableSpecFailure(result: ChatSpecFetchResult): boolean {
  if (result.ok) return false
  if (result.status === 'network') return true
  if (result.status === 'no-token' || result.status === 'misconfigured') return false
  if (result.status === 503 && (result.body as { code?: unknown } | null)?.code === 'BILLING_UNAVAILABLE') return false
  return result.status === 404 || result.status >= 500
}

/**
 * The turn's spec fetch, tried once more after a short wait when it failed in
 * a way that may pass (isRetryableSpecFailure). A turn without its spec runs
 * blind: no system prompt, no tools, no turn context (the card the person
 * replied to, the page they're on), on the fixed fallback model. 2026-10-16
 * DEV: one such turn answered "what's this?" about a card it never heard of.
 */
async function fetchChatSpecWithRetry(
  runToken: string,
  turnCtx: string,
  opts: FetchChatSpecOpts,
): Promise<ChatSpecFetchResult> {
  const first = await fetchChatSpecResultUncached(runToken, turnCtx, opts)
  if (!isRetryableSpecFailure(first)) return first
  console.warn(`[chat-agent] spec fetch failed (${first.ok ? '' : first.status}); retrying once`)
  await new Promise((resolve) => setTimeout(resolve, SPEC_RETRY_DELAY_MS))
  return fetchChatSpecResultUncached(runToken, turnCtx, opts)
}

/**
 * One GET of the spec route, never memoized. Logging here is kept exactly as
 * informative as the pre-refactor `fetchChatSpec`: a non-OK response logs
 * `spec fetch failed: <status> <url>`, a thrown fetch logs `spec fetch
 * errored: <url> — <message>`. Only the RETURN shape is richer — no
 * observability was traded away.
 */
async function fetchChatSpecResultUncached(
  runToken: string,
  turnCtx: string,
  opts: FetchChatSpecOpts,
): Promise<ChatSpecFetchResult> {
  const params = new URLSearchParams()
  if (opts.skills) params.set('skills', '1')
  if (opts.schemas) params.set('schemas', '1')
  if (opts.turnContext) params.set('turnContext', '1')
  if (turnCtx) params.set('ctx', turnCtx)
  const qs = params.size > 0 ? `?${params.toString()}` : ''
  // The Mac body (lib/host.ts) asks C1's spec route with its session token
  // (lib/mac-host.ts); a launch without one has no token to present.
  const mac = isMacHost()
  const route = mac ? macRouteState() : 'ok'
  if (route !== 'ok') return { ok: false, status: route }
  let url = mac ? '' : `${appBaseUrl()}/api/internal/chat/spec${qs}`
  try {
    // Inside the try so a misconfigured runtime (secret unset) degrades like
    // every other failure path here instead of crashing the session resolver.
    let headers: Record<string, string>
    if (mac) {
      const target = macRouteTarget('spec')
      url = `${target.url}${qs}`
      headers = target.headers
    } else {
      headers = {
        [CHAT_RUN_SECRET_HEADER]: internalSecret(),
        [CHAT_RUN_TOKEN_HEADER]: runToken,
      }
    }
    const res = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'error',
    })
    if (!res.ok) {
      // Degrading to a spec-less (toolless) session is deliberate — but it must
      // never be silent, or a misrouted/blocked fetch looks like model failure.
      console.error(`[chat-agent] spec fetch failed: ${res.status} ${url}`)
      // Parse the error body so callers (the usage-limit gate) can read the
      // route's structured 429/503 payload; null when the body isn't JSON.
      const body = await res.json().catch(() => null)
      return { ok: false, status: res.status, body }
    }
    return { ok: true, spec: (await res.json()) as ChatSpec }
  } catch (err) {
    console.error(
      `[chat-agent] spec fetch errored: ${url} — ${err instanceof Error ? err.message : String(err)}`,
    )
    return { ok: false, status: 'network' }
  }
}

/**
 * The `surface` claim of a chat-run token, read WITHOUT verifying the HMAC — a
 * routing hint only (this runtime does not hold the claims' authority; every
 * internal route re-verifies the token). Used by the usage gate to decide
 * whether a run is a server-minted SURFACE run (today: 'device_ask') that must
 * be probed for liveness before each model step. A forged claim can only make
 * the gate probe (and so fail) MORE, never less: the probe itself is verified.
 * Returns undefined for a browser token (no surface) or anything malformed.
 *
 * NOT for billing: a claim read here must never decide that a turn goes
 * unbilled. The usage meter (hooks/usage-meter.ts) and the usage route
 * (src/lib/chat/chat-usage-meter.ts) honor a surface only on a token whose HMAC
 * verifies (lib/auth.ts verifyChatRunClaims / verifyChatRunToken, expiry
 * ignored), which keeps this helper's "only ever MORE" contract true.
 */
export function surfaceFromRunToken(runToken: string): string | undefined {
  const dot = runToken.indexOf('.')
  if (dot <= 0) return undefined
  try {
    const claims = JSON.parse(Buffer.from(runToken.slice(0, dot), 'base64url').toString('utf8')) as {
      surface?: unknown
    }
    return typeof claims?.surface === 'string' ? claims.surface : undefined
  } catch {
    return undefined
  }
}

/**
 * The `teammateId` claim of a chat-run token (a bots v2 teammate chat), read
 * WITHOUT verifying the HMAC — a routing hint only, with the same "only ever
 * LESS" contract as {@link surfaceFromRunToken}: the one thing it decides is
 * that `ask_user` answers instead of parking (tools/ask_user.ts), so forging
 * it can only take the picker away from the forger's own chat. The tool
 * ceiling a teammate chat gets is decided by the internal routes from the
 * verified token, never from this. Undefined for an ordinary chat token or
 * anything malformed.
 */
export function teammateFromRunToken(runToken: string): string | undefined {
  const dot = runToken.indexOf('.')
  if (dot <= 0) return undefined
  try {
    const claims = JSON.parse(Buffer.from(runToken.slice(0, dot), 'base64url').toString('utf8')) as {
      teammateId?: unknown
    }
    return typeof claims?.teammateId === 'string' && claims.teammateId ? claims.teammateId : undefined
  } catch {
    return undefined
  }
}

/**
 * The `guestId` claim of a chat-run token (a guest's text turn, migration
 * 428), read WITHOUT verifying the HMAC: a routing hint with the "only ever
 * LESS" contract of {@link teammateFromRunToken}. The one thing it decides is
 * that the profile memory slot resolves no scope (./profile-memory.ts), so
 * forging it can only take the owner's own memory away from the forger's
 * chat; the memory route refuses a verified guest token besides.
 */
export function guestFromRunToken(runToken: string): string | undefined {
  const dot = runToken.indexOf('.')
  if (dot <= 0) return undefined
  try {
    const claims = JSON.parse(Buffer.from(runToken.slice(0, dot), 'base64url').toString('utf8')) as {
      guestId?: unknown
    }
    return typeof claims?.guestId === 'string' && claims.guestId ? claims.guestId : undefined
  } catch {
    return undefined
  }
}

/**
 * The `server` claim of a chat-run token (a token the server minted for
 * itself: 'home_turn' for a background update in a home thread), read
 * WITHOUT verifying the HMAC — a routing hint only, with the same "only ever
 * LESS" contract as {@link surfaceFromRunToken}: the one thing it decides is
 * that `ask_user` answers instead of parking (tools/ask_user.ts), so forging
 * it can only take the picker away from the forger's own chat. What a server
 * turn may call is decided by the internal tool route from the verified
 * token, never from this. Undefined for any other token or anything malformed.
 */
export function serverFromRunToken(runToken: string): string | undefined {
  const dot = runToken.indexOf('.')
  if (dot <= 0) return undefined
  try {
    const claims = JSON.parse(Buffer.from(runToken.slice(0, dot), 'base64url').toString('utf8')) as {
      server?: unknown
    }
    return typeof claims?.server === 'string' && claims.server ? claims.server : undefined
  } catch {
    return undefined
  }
}

/**
 * True for the Now file's check-in token (`server: 'home_turn'` with
 * `homeTurnReason: 'check_in'`, docs/plans/now-file.md), read without
 * verifying the HMAC: a routing hint with the "only ever LESS" contract (it
 * only takes tools away: the web, ../tools/workspace_tools.ts). The channel's
 * server entry verified the token before the session could run a turn.
 */
export function isCheckInRunToken(runToken: string): boolean {
  const dot = runToken.indexOf('.')
  if (dot <= 0) return false
  try {
    const claims = JSON.parse(Buffer.from(runToken.slice(0, dot), 'base64url').toString('utf8')) as { server?: unknown; homeTurnReason?: unknown }
    return claims?.server === 'home_turn' && claims.homeTurnReason === 'check_in'
  } catch {
    return false
  }
}

/**
 * The `relay` claim of a chat-run token (bots v4 A4: a turn the main agent
 * relayed into a bot's thread), read without verifying the HMAC: a routing
 * hint with the "only ever LESS" contract. Its message is the main agent's,
 * never the person's words. Undefined for any other token or anything malformed.
 */
export function relayFromRunToken(runToken: string): string | undefined {
  const dot = runToken.indexOf('.')
  if (dot <= 0) return undefined
  try {
    const claims = JSON.parse(Buffer.from(runToken.slice(0, dot), 'base64url').toString('utf8')) as { relay?: unknown }
    return typeof claims?.relay === 'string' && claims.relay ? claims.relay : undefined
  } catch {
    return undefined
  }
}

/** The code the spec + tool routes answer (403) once a surface run has ended. */
export const SURFACE_RUN_ENDED = 'SURFACE_RUN_ENDED'

/**
 * Liveness-only probe: GET /api/internal/chat/spec?live=1. The route runs its
 * secret + token + surface-liveness gates and answers `{ live: true }` without
 * rebuilding the spec, so the usage gate can ask it before EVERY model step of
 * a surface run for the price of one indexed row lookup. Same discriminated
 * result as {@link fetchChatSpecResult} (the 200 body is not a spec, so only
 * `ok` is meaningful on success).
 *
 * The Mac body (lib/host.ts) asks C1's spec route the same way, with its
 * session token, before every model step (hooks/usage-limit-gate.ts): a Stop
 * or an expired token ends the turn at its next model call.
 */
export async function probeChatRunLive(
  runToken: string,
): Promise<{ ok: true } | { ok: false; status: number; body: unknown } | { ok: false; status: 'network' | 'no-token' | 'misconfigured' }> {
  if (!runToken) return { ok: false, status: 'no-token' }
  const mac = isMacHost()
  const route = mac ? macRouteState() : 'ok'
  if (route !== 'ok') return { ok: false, status: route }
  let url = mac ? '' : `${appBaseUrl()}/api/internal/chat/spec?live=1`
  try {
    let headers: Record<string, string>
    if (mac) {
      const target = macRouteTarget('spec')
      url = `${target.url}?live=1`
      headers = target.headers
    } else {
      headers = {
        [CHAT_RUN_SECRET_HEADER]: internalSecret(),
        [CHAT_RUN_TOKEN_HEADER]: runToken,
      }
    }
    const res = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'error',
      // The Mac judges a hung probe as a miss (lib/mac-host.ts judgeMacLiveness).
      ...(mac ? { signal: AbortSignal.timeout(MAC_PROBE_TIMEOUT_MS) } : {}),
    })
    if (!res.ok) {
      console.error(`[chat-agent] run liveness probe failed: ${res.status} ${url}`)
      const body = await res.json().catch(() => null)
      return { ok: false, status: res.status, body }
    }
    return { ok: true }
  } catch (err) {
    console.error(
      `[chat-agent] run liveness probe errored: ${url} — ${err instanceof Error ? err.message : String(err)}`,
    )
    return { ok: false, status: 'network' }
  }
}

/**
 * Fetch the rebuilt ChatSpec for `runToken` (+ the pre-encoded per-turn ctx).
 * Returns null on any failure (unknown token, route error) so a resolver can
 * degrade — no dynamic instructions / fallback model / no tools — rather than
 * crash the session.
 *
 * Thin wrapper over {@link fetchChatSpecResult}: the model / instructions / tools
 * resolvers all SOFT-degrade, so they only ever need `spec | null`. The richer
 * discriminated result exists for the usage-limit gate, which must HARD-fail on a
 * billing block; keeping this signature and behavior byte-for-byte identical
 * means those existing callers are untouched.
 */
export async function fetchChatSpec(
  runToken: string,
  turnCtx: string,
  opts: FetchChatSpecOpts = {},
): Promise<ChatSpec | null> {
  const result = await fetchChatSpecResult(runToken, turnCtx, opts)
  return result.ok ? result.spec : null
}

/**
 * Fetch the caller's LOADABLE workspace skills for `runToken` (+ per-turn ctx)
 * — the spec route's `?skills=1` variant, which appends the caller-visible
 * skills (same visibility rules as the chips / All-skills surfaces, pinned
 * skill excluded server-side). Called by the native `load_skill` tool's
 * execute. It fetches fresh, never through the turn's memo, so a skill the
 * model created or edited earlier in the same turn loads as it now is. No
 * schemas: it reads only `skills`. Returns [] on any failure (a skills miss
 * must degrade gracefully, never crash the session).
 */
export async function fetchChatSkills(runToken: string, turnCtx: string): Promise<ChatSkill[]> {
  if (!runToken) return []
  const result = await fetchChatSpecResultUncached(runToken, turnCtx, { skills: true })
  const spec = result.ok ? result.spec : null
  if (!spec || !Array.isArray(spec.skills)) return []
  // Shape-guard each entry — a malformed row is dropped, not fatal.
  return spec.skills.filter(
    (s): s is ChatSkill =>
      !!s &&
      typeof (s as ChatSkill).name === 'string' &&
      typeof (s as ChatSkill).description === 'string' &&
      typeof (s as ChatSkill).markdown === 'string',
  )
}

/**
 * Fire-and-forget: tell the Next app that `load_skill` just injected a skill's
 * playbook, so it can emit the `skill_auto_loaded` product event. Tenancy is
 * re-derived server-side from the run token — this only carries the skill name.
 *
 * The load_skill tool calls this with `void` (never awaits it) so analytics can
 * never delay the tool result. To make that safe, this swallows EVERY error
 * internally (logging like the other degrade paths here) — the returned promise
 * never rejects, so a `void` call can't leak an unhandled rejection. Best-effort
 * by construction: a missing token is a silent no-op.
 */
export async function reportSkillLoaded(runToken: string, skillName: string): Promise<void> {
  if (!runToken) return
  // No analytics route on the Mac (C1 serves the spec and tools only).
  if (isMacHost()) return
  try {
    const secret = internalSecret()
    const url = `${appBaseUrl()}/api/internal/analytics/skill-loaded`
    await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [CHAT_RUN_SECRET_HEADER]: secret,
        [CHAT_RUN_TOKEN_HEADER]: runToken,
      },
      body: JSON.stringify({ skillName }),
      redirect: 'error',
    })
  } catch (err) {
    console.error(
      `[chat-agent] skill-loaded report errored: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Per-request ceiling on a memory POST. A recall runs before the turn's first
 * model call, so a hung app connection must not hold the turn: past this the
 * provider falls back (memory/profile.ts).
 */
export const MEMORY_REQUEST_TIMEOUT_MS = 4_000

/**
 * POST one memory operation to /api/internal/chat/memory (the eve memory slot,
 * agents/chat-agent/memory/profile.ts) and return the route's `result`.
 * THROWS on any failure (no token, misconfigured secret, network, non-OK,
 * malformed body): the provider's fallback decides what the turn gets, so the
 * failure must reach it.
 */
export async function postChatMemory(runToken: string, body: Record<string, unknown>): Promise<unknown> {
  if (!runToken) throw new Error('no run token on this session')
  // No memory route for the Mac body. Never reached there (the memory slot has no
  // scope without a workspace on the principal: lib/profile-memory.ts), kept as a backstop.
  if (isMacHost()) throw new Error('memory is not served to the Mac body')
  const secret = internalSecret()
  const url = `${appBaseUrl()}/api/internal/chat/memory`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [CHAT_RUN_SECRET_HEADER]: secret,
      [CHAT_RUN_TOKEN_HEADER]: runToken,
    },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(MEMORY_REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`memory route answered ${res.status}`)
  const json = (await res.json().catch(() => null)) as { result?: unknown } | null
  if (!json || json.result === undefined) throw new Error('memory route answered no result')
  return json.result
}

/** Per-request ceiling on the helper-tier POST: past it every task runs on the plain helper. */
export const HELPER_TIERS_TIMEOUT_MS = 5_000

/**
 * Ask /api/internal/chat/helper-tiers which tier each quick helper task runs
 * on (auto model selection: the rules, then the plan and the daily Strong
 * cap). `turnCtx` is forwarded so the person's own "use the best model"
 * counts. One route per task, in order, each `{ tier, by, signals, reasoning? }`;
 * null on any failure (the caller then starts plain helpers). Never throws.
 */
export async function fetchHelperTiers(
  runToken: string,
  turnCtx: string,
  tasks: string[],
  models?: ReadonlyArray<string | null>,
): Promise<unknown[] | null> {
  if (!runToken || tasks.length === 0) return null
  // No helpers on the Mac (the Mac build leaves them out).
  if (isMacHost()) return null
  const url = `${appBaseUrl()}/api/internal/chat/helper-tiers`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [CHAT_RUN_SECRET_HEADER]: internalSecret(),
        [CHAT_RUN_TOKEN_HEADER]: runToken,
      },
      // `models`: the main agent's choice per task (a roster key, or null).
      body: JSON.stringify({ tasks, ...(models && models.some((m) => m) ? { models } : {}), ...(turnCtx ? { ctx: turnCtx } : {}) }),
      redirect: 'error',
      signal: AbortSignal.timeout(HELPER_TIERS_TIMEOUT_MS),
    })
    if (!res.ok) {
      console.error(`[chat-agent] helper tiers failed: ${res.status} ${url}`)
      return null
    }
    const json = (await res.json().catch(() => null)) as { tiers?: unknown } | null
    return Array.isArray(json?.tiers) && json.tiers.length === tasks.length ? json.tiers : null
  } catch (err) {
    console.error(`[chat-agent] helper tiers errored: ${url} — ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/** Outcome of one usage-report POST (never throws — see {@link reportTurnUsage}). */
export type TurnUsageReportResult =
  | { ok: true; body: unknown }
  | { ok: false; status: number | 'network'; retryable: boolean }

/** Per-request ceiling on a usage-report POST (the hook runs at the turn's end). */
export const USAGE_REPORT_TIMEOUT_MS = 5_000

/**
 * Whether a failed usage-report POST should be kept and re-sent. Only a 400
 * (malformed report — re-sending the same body cannot succeed) and other
 * client errors the route never answers are final. Kept:
 *   - 5xx — the route failed to resolve the payer or the bill was lost (the
 *     keyed RPC rolled its claim back, so a re-send can bill);
 *   - 401 — the route's ONLY 401 is a rejected internal secret (misconfiguration
 *     or a rotation between the two services): dropping would silently stop all
 *     chat billing, while the durable key makes a later re-send safe;
 *   - 409 — no verifiable token and no conversation registers the session yet;
 *   - 408 / 429 — transient.
 */
export function isRetryableUsageStatus(status: number): boolean {
  return status >= 500 || status === 401 || status === 408 || status === 409 || status === 429
}

/**
 * POST one finished turn's summed usage to /api/internal/chat/usage. Called by
 * the usage-meter hook at the turn's end. The internal secret is the route's
 * gate; the run token is sent when the session has one, but billing does NOT
 * depend on it — the route bills the verified token's user, or, with no valid
 * token (none, or expired by a long turn's end), the session's owner
 * (owner-derivation), idempotent on (session, turn).
 *
 * Result-typed and never throws, so the meter's handler always settles its
 * report (a hook throw is only logged since eve 0.68, but it would skip the
 * rest of the handler). Each POST is bounded by USAGE_REPORT_TIMEOUT_MS
 * (an abort is a retryable 'network' failure), so a hung app connection cannot
 * hold the turn's end. `retryable` follows {@link isRetryableUsageStatus}.
 */
export async function reportTurnUsage(runToken: string, report: unknown): Promise<TurnUsageReportResult> {
  // The relay meters the Mac body's model calls one by one (the Mac build
  // leaves the usage meter out): a turn report would bill them twice.
  if (isMacHost()) return { ok: true, body: null }
  const url = `${appBaseUrl()}/api/internal/chat/usage`
  try {
    const secret = internalSecret()
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [CHAT_RUN_SECRET_HEADER]: secret,
        ...(runToken ? { [CHAT_RUN_TOKEN_HEADER]: runToken } : {}),
      },
      body: JSON.stringify(report),
      redirect: 'error',
      signal: AbortSignal.timeout(USAGE_REPORT_TIMEOUT_MS),
    })
    if (!res.ok) {
      console.error(`[chat-agent] usage report failed: ${res.status} ${url}`)
      return { ok: false, status: res.status, retryable: isRetryableUsageStatus(res.status) }
    }
    return { ok: true, body: await res.json().catch(() => null) }
  } catch (err) {
    console.error(
      `[chat-agent] usage report errored: ${url} — ${err instanceof Error ? err.message : String(err)}`,
    )
    return { ok: false, status: 'network', retryable: true }
  }
}

/** Each reply-backup POST gives up after this long (an abort counts as a retryable failure). */
export const REPLY_BACKUP_TIMEOUT_MS = 8_000

export type ReplyBackupPostResult = { ok: true } | { ok: false; status: number | 'network'; retryable: boolean }

/**
 * POST the server's copy of a reply to /api/internal/chat/reply (the
 * reply-backup hook, at a turn's end). The internal secret is the route's
 * gate; the run token scopes the write to its conversation. Result-typed and
 * never throws (a hook throw on a failure event would escalate to
 * session.failed); bounded by REPLY_BACKUP_TIMEOUT_MS. Retryable: a network
 * failure, a timeout, or a 5xx.
 */
export async function postReplyBackup(runToken: string, body: unknown): Promise<ReplyBackupPostResult> {
  // The desktop uploads the Mac body's transcript; there is no reply route for it.
  if (isMacHost()) return { ok: true }
  const url = `${appBaseUrl()}/api/internal/chat/reply`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [CHAT_RUN_SECRET_HEADER]: internalSecret(),
        [CHAT_RUN_TOKEN_HEADER]: runToken,
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(REPLY_BACKUP_TIMEOUT_MS),
    })
    if (!res.ok) {
      console.error(`[chat-agent] reply backup failed: ${res.status} ${url}`)
      return { ok: false, status: res.status, retryable: res.status >= 500 }
    }
    return { ok: true }
  } catch (err) {
    console.error(`[chat-agent] reply backup errored: ${url} — ${err instanceof Error ? err.message : String(err)}`)
    return { ok: false, status: 'network', retryable: true }
  }
}

/**
 * Dispatch ONE workspace tool call to the Next app's internal tool route. Called
 * by the eve tool proxies' inline execute. Returns the tool's output on success;
 * THROWS on any failure. The run token scopes tenancy + re-derives the ceiling
 * server-side; the model can only supply `input`.
 *
 * ── Why throw (not return an error object) ──────────────────────────────────
 * eve converts a thrown execute into a `tool-result` action with `isError: true`
 * and the error MESSAGE as the model-visible output (action-result-helpers:
 * createRuntimeToolResultFromToolError) — no retry storm, no session crash, the
 * model reads the error and adapts within the same turn. That matches the cloud
 * path, where an invalid input / thrown tool surfaces as the AI SDK's native
 * error tool-result. Returning `{error, code}` instead (the old behavior) made
 * every failure look like a SUCCESSFUL call — the UI showed a green "Done" chip
 * and eve's isError never fired. The message must carry the route's `details`
 * (the stringified Zod error) — dropping it left the model with a bare
 * INPUT_INVALID and no way to self-correct (verified prod failure, 2026-07-14).
 *
 * `callId`, `turnId` and `sessionId` are eve's (ctx.callId, ctx.session.turn.id,
 * ctx.session.id), sent outside the model input: start_helper's idempotency key
 * is the triple, since a provider may reuse a tool call id across turns and eve
 * numbers turns per session (turn_<sequence>), restarting when a conversation
 * moves to a new session. Other tools ignore them.
 *
 * `extras` rides outside the model input too: a browser task's original human
 * text (browser tools only), the turn's cards (read_card) and the browser's
 * zone (show, read_card).
 */
/**
 * Tools whose call has an effect the app can't take back, and whose outcome is
 * UNKNOWN when the dispatch broke in transit (a dropped connection, or a
 * gateway timeout with no answer from the route): the work may already have
 * started. The model is told not to resubmit, in each tool's words, instead of
 * the "You may retry once" every other tool gets. Each keys its effect on
 * eve's call id, so a retry of the SAME call is safe; a model retry is a NEW
 * call id, so new work: a second browser task, a second helper, a
 * second message to a bot (bots-v4 A3/A4).
 */
const UNKNOWN_DELIVERY_NOTES: Readonly<Record<string, string>> = {
  run_browser_task:
    'Delivery is unknown and the browser task may already be running. Do not automatically resubmit it; report the uncertainty.',
  start_helper:
    'Delivery is unknown and the helper may already have started. Do not call start_helper again for this request: tell the person, who can check list_bot_work for what is working.',
  send_bot_message:
    "Delivery is unknown and the agent may already have the message. Do not send it again: tell the person it may have reached the agent, and offer to check the agent's chat.",
}

/** What a broken dispatch tells the model about retrying `toolName`. */
export function dispatchRetryNote(toolName: string): string {
  return Object.hasOwn(UNKNOWN_DELIVERY_NOTES, toolName) ? UNKNOWN_DELIVERY_NOTES[toolName] : 'You may retry once.'
}

/** A remember call aimed at the person's profile (the only scope the evidence rule gates). */
function isProfileRemember(input: unknown): boolean {
  return !!input && typeof input === 'object' && (input as { scope?: unknown }).scope === 'profile'
}

/** What a proxy sends beside the model's input (see dispatchChatTool). */
export interface DispatchExtras {
  /** The browser task's original human text. Browser tools only. */
  browserSourceRequest?: string
  /** The turn's cards as JSON (JSON.stringify of spec.cards). read_card only. */
  cards?: string
  /** The browser's IANA zone this turn (spec.timeZone). show, read_card, create_flow and update_flow only. */
  timeZone?: string
  /**
   * A quick helper's call (A4 slice 3): the route then admits read-plus-drafts
   * tools only (src/lib/chat/helpers-gate.ts). Set by the helper's proxies.
   */
  helper?: boolean
}

/** This turn's model, for review_post's reviewer pick (see the dispatch). */
function writerModelField(): { writerModel?: string } {
  const model = currentTurnModel()
  return model ? { writerModel: model } : {}
}

/** What a tool call carries for action.review: the person's latest messages and their seq. Never throws. */
export function reviewerEvidence(turnId?: string): { personMessages?: string[]; personMessageSeq?: number; personMessagesStale?: number } {
  const all = recentPersonMessages()
  const turns = recentPersonMessageTurns()
  const personMessages = all.slice(-3).map((text) => (text.length > 2000 ? text.slice(-2000) : text))
  // None recorded (a fresh session, a wake turn): nothing rides along.
  if (!personMessages.length) return {}
  // Stale words (A5 review): how many of the forwarded messages, oldest first,
  // the person sent in an EARLIER turn than this call's. Known only when the
  // call has a turn id; a message whose turn is unknown counts as this turn's.
  const kept = turns.length === all.length ? turns.slice(-personMessages.length) : []
  let stale = 0
  if (turnId && kept.length === personMessages.length) {
    const last = kept.map((t) => t !== null && t !== turnId).lastIndexOf(true)
    stale = last + 1
  }
  return { personMessages, personMessageSeq: personMessageSeq(), ...(turnId ? { personMessagesStale: stale } : {}) }
}

/** The body's `cards`, or nothing when there are none or they do not parse. */
function cardsField(json: string | undefined): { cards?: unknown } {
  if (!json) return {}
  try {
    return { cards: JSON.parse(json) as unknown }
  } catch {
    return {}
  }
}

export async function dispatchChatTool(
  toolName: string,
  runToken: string,
  input: unknown,
  callId?: string,
  turnId?: string,
  sessionId?: string,
  extras: DispatchExtras = {},
): Promise<unknown> {
  if (!runToken) {
    throw new Error(`${toolName}: no run token on this session — tool call refused (NO_RUN_TOKEN)`)
  }
  // Wrap config resolution so a misconfigured runtime (secret env unset) still
  // throws the uniform `${toolName}: …` shape every other failure path uses.
  // The Mac body posts to C1's tool route with its session token instead
  // (lib/mac-host.ts): same body, same answers.
  let url: string
  let auth: Record<string, string>
  try {
    if (isMacHost()) {
      const target = macRouteTarget('tool')
      url = target.url
      auth = target.headers
    } else {
      url = `${appBaseUrl()}/api/internal/chat/tool`
      auth = {
        [CHAT_RUN_SECRET_HEADER]: internalSecret(),
        [CHAT_RUN_TOKEN_HEADER]: runToken,
      }
    }
  } catch (err) {
    throw new Error(
      `${toolName}: tool dispatch unavailable — ${err instanceof Error ? err.message : 'runtime misconfigured'}`,
    )
  }
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...auth,
      },
      body: JSON.stringify({
        toolName,
        input,
        ...(callId ? { callId } : {}),
        ...(turnId ? { turnId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(extras.browserSourceRequest ? { browserSourceRequest: extras.browserSourceRequest } : {}),
        ...cardsField(extras.cards),
        ...(extras.timeZone ? { timeZone: extras.timeZone } : {}),
        ...(extras.helper === true ? { helper: true } : {}),
        // The evidence rule (lib/person-messages.ts): a remember of a profile
        // fact says whether its quote is the person's own words. Only `true`
        // saves it active; anything else is a proposal.
        ...(toolName === 'remember' && isProfileRemember(input) ? { quoteVerified: quoteVerified((input as { quote?: unknown }).quote, (input as { text?: unknown }).text) } : {}),
        // The post reviewer (content C0, review_post) must be another vendor
        // than the writer: the writer is this turn's model, sent with that one
        // call, outside the model's input.
        ...(toolName === 'review_post' ? writerModelField() : {}),
        // The reviewer's evidence (A5, src/lib/safety/action-review.ts): the
        // person's own latest words (the last 3, 2,000-character tails) and
        // their monotonic count. The route reads them only for a risky call.
        ...reviewerEvidence(turnId),
      }),
      redirect: 'error',
    })
  } catch (err) {
    console.error(
      `[chat-agent] tool dispatch errored: ${toolName} — ${err instanceof Error ? err.message : String(err)}`,
    )
    throw new Error(
      `${toolName}: tool dispatch failed to reach the workspace (${err instanceof Error ? err.message : 'network error'}). ${dispatchRetryNote(toolName)}`,
    )
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    // Surface the FULL structured error to the model so it can adapt — `details`
    // carries the real Zod issues on INPUT_INVALID (which fields were wrong).
    console.error(`[chat-agent] tool dispatch failed: ${toolName} ${res.status} ${url}`)
    const error = typeof json.error === 'string' ? json.error : `tool dispatch failed (${res.status})`
    const code = typeof json.code === 'string' ? ` [${json.code}]` : ''
    const details = typeof json.details === 'string' && json.details ? ` — ${json.details}` : ''
    // No answer from the route itself (a gateway timeout, a platform 5xx): for
    // a tool whose effect may already have happened, delivery is unknown too.
    const unknown = typeof json.error !== 'string' && Object.hasOwn(UNKNOWN_DELIVERY_NOTES, toolName) ? ` ${UNKNOWN_DELIVERY_NOTES[toolName]}` : ''
    throw new Error(`${toolName}: ${error}${code}${details}${unknown}`)
  }
  return json.output
}
