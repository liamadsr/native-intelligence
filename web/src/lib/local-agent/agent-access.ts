/**
 * The Mac body's access to the server (docs/plans/teammate-agent.md C1): the
 * checks, the ceiling and the call context behind GET /api/local-agent/agent/spec
 * and POST /api/local-agent/agent/tool.
 *
 * The Mac body is the main Native Intelligence agent running on the person's Mac
 * (agents/chat-agent, packaged into the desktop app). It reaches the server
 * with the job's session token (`la1.…`, ./tokens.ts), never the shared
 * internal secret, which must never ship to a Mac. So every call proves, on
 * its own:
 *   - the token (HMAC, expiry) and the session behind it: live, the token
 *     user's own, not idle, not asked to stop (./relay.ts checkSessionToken,
 *     the model relay's checks);
 *   - the session's workspace is the token's, and the person is still a
 *     member of it (a session outlives a membership change; its token
 *     refreshes from the row);
 *   - the session has a conversation (the job's thread, C4) and a readable
 *     `local_model` (migration 418 is a hard prerequisite: fail closed);
 *   - the person's usage limit (each route checks it).
 *
 * The Mac body works as the MAIN chat of that conversation (no agent persona,
 * no teammate, no surface): the inherit-all ceiling ∪ the person's connected
 * MCP tools, the one resolveChatCeiling the cloud body's routes use, then
 * narrowed for the Mac ({@link macCeiling}):
 *   - never the chat-native tools: the relay to the bots, the helpers and the
 *     local-agent tools that would let it start more Mac jobs;
 *   - never the browser tools (the desktop's in-app browser is the cloud
 *     body's), the chat's screen tools (`show`, `read_card`,
 *     `suggest_changes`), the live-meeting line, or the tools that call back
 *     into the app with the person's JWT (a session token carries none);
 *   - never the attended-only tools its caller class is denied (caller.ts);
 *   - plus `web_fetch` and `web_search`, run here (./web-tools.ts), and the
 *     Mac's own teammate tools (C4, ./agent-seams.ts).
 * The job's `mode` (read or edit) is the Mac's folder fence, not a Native Intelligence
 * permission: it doesn't narrow the Native Intelligence tools (writes in the person's own
 * workspace stay apply-with-undo).
 *
 * Its caller class ({@link macCallerClass}): `person_remote` only on a
 * positive marker, a job the person started (`started_by` 'person') or one
 * the cloud agent started from the person's typed turn (the chat tool's start
 * key). It acts for the person, away from the app's screen: an outward call is
 * the person's card, and the attended-only tools stay out. Everything else (a
 * loop's start, L5, among them) is `agent_unattended`: an outward hold is
 * NEEDS_PERSON, and its tools take a loop run's fence.
 *
 * Every call goes through the reviewer, BLOCKING (`mustEnforce`): the Mac body
 * reads files and command output the server never sees, so it is the most
 * injection-exposed caller. The reviewer's evidence is the person's words as
 * the server stored them at the job's start or join ({@link macPersonWords}),
 * never what the Mac posts. A held call's card asks in the person's home
 * thread (nobody reads the Mac's turns in a chat), names "Native Intelligence on <Mac>" and
 * the job (`context.localAgent`), and at most five cards per job wait at once
 * (createToolApproval's per-job cap, APPROVAL_PENDING_MAX_PER_MAC_JOB).
 *
 * A Mac on a LOCAL model (`local_agent_session.local_model`, set at claim:
 * {@link localModelFromClaimBody}) gets no web tools, and every RISKY call
 * (outward, delete, automation-write, an outside tool) is held as the
 * person's card, whatever the reviewer says ({@link localModelGate}).
 * Internal Native Intelligence writes stay uncarded: apply with undo.
 */
import type { Tool } from 'ai'
import type { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { apiError, conflict, forbidden } from '@/lib/api-errors'
import { checkUsageLimits } from '@/lib/ai/auth'
import { chatModelPolicy, type ChatModelPolicy } from '@/lib/ai/models'
import { SURFACE_MODELS } from '@/lib/ai/model-defaults'
import { LIVE_MEETING_TOOL_NAMES } from '@/lib/ai/tool-discovery'
import { CHAT_NATIVE_TOOL_NAMES, TOOL_CATEGORIES } from '@/lib/ai/tool-registry'
import { toolInputJsonSchema } from '@/lib/ai/tool-schemas'
import type { ChatSpec } from '@/lib/chat/chat-run-rebuild'
import type { ChatRunTokenClaims } from '@/lib/chat/chat-run-token'
import { ENVIRONMENT_SECTION_KEY } from '@/lib/chat/environment-section'
import { NOW_SECTION_KEY } from '@/lib/now/now-section'
import { REGISTRY_TOOLS, type ToolDispatchContext } from '@/lib/chat/chat-tool-dispatch'
import { goAheadTurnKey } from '@/lib/chat/flow-go-ahead-guard'
import { turnOutsideReadTools } from '@/lib/chat/turn-outside-reads'
import { isTimeZone } from '@/lib/chat-cards/calendar'
import type { CreateToolsOptions } from '@/lib/ai/tools'
import { gateRiskyCall, type GateRequest, type HeldCallOutput } from '@/lib/safety/action-review'
import {
  UNATTENDED_TOOL_OPTIONS,
  createToolApproval,
  type ApprovalContext,
  type ApprovalToolOptions,
} from '@/lib/safety/approvals'
import { attendedOnlyToolsDeniedTo, decideAction, type CallerClass } from '@/lib/safety/caller'
import { macNativeToolEntries } from './agent-seams'
import { LOCAL_AGENT_MODEL_SLUG, checkSessionToken, type TokenSessionRow } from './relay'
import type { ModelTokenClaims } from './tokens'
import { MAC_WEB_TOOL_DEFINITIONS, MAC_WEB_TOOL_NAMES } from './web-tools'

/** The host the spec names for the Mac body (C2's `DIAL8_AGENT_HOST=mac`). */
export const MAC_HOST = 'mac' as const

/** The claim body's field that says the Mac runs this job on a local model. */
export const LOCAL_MODEL_CLAIM_FIELD = 'localModel'

/**
 * Whether a claim says the job runs on a model on the Mac. The claim route
 * writes it on the session (`local_model`) at every claim; only `true` counts.
 */
export function localModelFromClaimBody(body: Record<string, unknown>): boolean {
  return body[LOCAL_MODEL_CLAIM_FIELD] === true
}

/**
 * The session columns the Mac body's checks read, beside checkSessionToken's
 * own, named one by one: `local_model` and `start_words` come with migration
 * 418 (WS-C), a hard prerequisite, so before it every call fails closed (503)
 * instead of reading a missing flag as false. The folder and the device name
 * the job on its cards.
 */
const MAC_SESSION_COLUMNS =
  'conversation_id, started_by, mode, request, created_at, idempotency_key, local_model, start_words, ' +
  'folder:device_folder!folder_id(label), device:user_device!local_agent_session_device_fk(name)'

interface MacSessionRow extends TokenSessionRow {
  conversation_id: string | null
  started_by: string
  mode: string
  request: string
  created_at: string
  idempotency_key: string | null
  local_model: boolean | null
  start_words: string[] | null
  folder?: { label?: string | null } | null
  device?: { name?: string | null } | null
}

/** The job, as the checks proved it. */
export interface MacSession {
  /** The local_agent_session id (Rust's job id). */
  id: string
  userId: string
  workspaceId: string
  /** The job's thread: the conversation its spec is rebuilt for. */
  conversationId: string
  startedBy: string
  mode: string
  /** What the job was asked (the person's words when they started it). */
  request: string
  createdAt: string
  /** The person's words that started it from a typed chat turn, as stored then (418). */
  startWords: string[]
  /** The Mac runs this job on a model on the Mac. */
  localModel: boolean
  /** For its cards: "Native Intelligence on <deviceName>", in <folderLabel>. */
  deviceName: string
  folderLabel: string
}

/** A verified Mac body call: its token, its job, its caller class. */
export interface MacBody {
  claims: ModelTokenClaims
  session: MacSession
  caller: CallerClass
}

/** The chat tool's start key (start_local_agent from a typed turn): local-agent:<conv>:session:<s>:turn:<t>:call:<c>. */
const CHAT_START_KEY = /^local-agent:[^:]+:session:/

/**
 * The trust authority's class for a Mac job (caller.ts), on a POSITIVE marker
 * only: a job the person started, or one the cloud agent started from the
 * person's typed turn (the chat tool's start key), acts for the person away
 * from the app's screen. Anything else (a loop's start among them) is
 * unattended (fail closed).
 */
export function macCallerClass(startedBy: string, idempotencyKey?: string | null): CallerClass {
  if (startedBy === 'person') return 'person_remote'
  if (startedBy === 'agent' && typeof idempotencyKey === 'string' && CHAT_START_KEY.test(idempotencyKey)) return 'person_remote'
  return 'agent_unattended'
}

/** The person's words as stored: strings only, trimmed, non-empty. */
function wordsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((w): w is string => typeof w === 'string' && !!w.trim()) : []
}

/**
 * Every check a Mac body call passes before anything else (see the header),
 * except the usage limit, which each route checks where it would anyway.
 * A Response is the refusal to return.
 */
export async function authorizeMacBody(request: Request, svc: SupabaseClient): Promise<MacBody | Response> {
  const checked = await checkSessionToken<MacSessionRow>(request, svc, MAC_SESSION_COLUMNS)
  if (!checked.ok) return checked.response
  const { claims, session } = checked
  if (session.workspace_id !== claims.wid) return forbidden('This local agent is not running in this workspace')
  // 418 is a hard prerequisite: a flag that can't be read is never "not local".
  if (typeof session.local_model !== 'boolean') {
    return apiError('This local agent’s model setting can’t be read', { status: 503, code: 'UNAVAILABLE' })
  }
  const { data: member, error } = await svc
    .from('member')
    .select('id')
    .eq('workspace_id', session.workspace_id)
    .eq('user_id', session.user_id)
    .maybeSingle()
  if (error) return apiError('Membership check failed', { status: 503, code: 'UNAVAILABLE' })
  if (!member) return forbidden('You are no longer a member of this workspace')
  if (!session.conversation_id) {
    return conflict('This local agent has no conversation to work in', undefined, 'NO_CONVERSATION')
  }
  return {
    claims,
    session: {
      id: session.id,
      userId: session.user_id,
      workspaceId: session.workspace_id,
      conversationId: session.conversation_id,
      startedBy: session.started_by,
      mode: session.mode,
      request: session.request,
      createdAt: session.created_at,
      startWords: wordsOf(session.start_words),
      localModel: session.local_model,
      deviceName: session.device?.name?.trim() || 'your Mac',
      folderLabel: session.folder?.label?.trim() || 'a shared folder',
    },
    caller: macCallerClass(session.started_by, session.idempotency_key),
  }
}

/**
 * The person's usage limit as a refusal (its 429 / 503), or null to go on. A
 * check that throws anything else is 503, never a bare 500. Opted in to the
 * ChatGPT free tier: a person on their own plan goes on, since the Mac body's
 * model runs on their plan (the relay's plan path) and web-tools.ts runs its
 * search on the plan too, never Exa; everyone else is checked as before.
 */
export async function usageRefusal(userId: string): Promise<Response | null> {
  try {
    await checkUsageLimits(userId, undefined, { chatgptPlan: true })
    return null
  } catch (err) {
    if (err instanceof Response) return err
    console.error('[local-agent] usage check failed:', err instanceof Error ? err.message : err)
    return apiError('Usage check unavailable', { status: 503, code: 'BILLING_UNAVAILABLE' })
  }
}

// ── The ceiling ─────────────────────────────────────────────────────────────

const BROWSER_TOOL_NAMES = TOOL_CATEGORIES.find((c) => c.id === 'browser')?.tools.map((t) => t.name) ?? []

/** Registry tools the Mac body never holds, whatever its caller class (see the header). */
export const MAC_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  ...CHAT_NATIVE_TOOL_NAMES,
  // The quick helpers (not a registry tool): a cloud chat's alone.
  'helpers',
  ...BROWSER_TOOL_NAMES,
  'show',
  'read_card',
  // Its markers are drawn in the chat's own messages, which the Mac's turns
  // aren't (the helpers' rule too).
  'suggest_changes',
  ...LIVE_MEETING_TOOL_NAMES,
  // They call back into the app as the person, with a JWT no session token carries.
  'generate_email_drafts',
  'draft_followup_email',
])

/** Everything the Mac body never holds for this caller class. */
export function macExcludedTools(caller: CallerClass): Set<string> {
  return new Set([...MAC_EXCLUDED_TOOLS, ...attendedOnlyToolsDeniedTo(caller)])
}

/**
 * The Mac body's ceiling, from the main chat's (resolveChatCeiling for no
 * agent: a set, or null for "no limit", which means every registry tool) and
 * the person's external tool names: minus the Mac's exclusions, plus the web
 * tools (not on a local model) and the Mac's own tools. Always a set.
 * `search_tools` is reachable as on every chat, beside this.
 */
export function macCeiling(
  chatCeiling: ReadonlySet<string> | readonly string[] | null,
  externalMcpToolNames: readonly string[],
  opts: { caller: CallerClass; localModel: boolean },
): Set<string> {
  const out = new Set<string>(chatCeiling ?? [...REGISTRY_TOOLS, ...externalMcpToolNames])
  out.delete('search_tools')
  for (const name of macExcludedTools(opts.caller)) out.delete(name)
  if (!opts.localModel) for (const name of MAC_WEB_TOOL_NAMES) out.add(name)
  for (const entry of macNativeToolEntries()) out.add(entry.name)
  return out
}

// ── The call context ────────────────────────────────────────────────────────

/**
 * The createTools options the Mac body's calls run under (its origin here,
 * strictWorkspace beside it), recorded on every approval it raises so the
 * approved call runs under the same fence:
 *   - its status writes are an AGENT's, one hop from the person (as a
 *     teammate's), so an automation does not re-fire on them by default;
 *   - every id-based tool is fenced to the session's workspace: a job works
 *     in the one workspace it was started in.
 */
export const MAC_ORIGIN = Object.freeze({ actor: 'agent' as const, depth: 1 })

/**
 * The job, on every approval it raises: the per-job cap counts by it, and the
 * card's words name "Native Intelligence on <Mac>" and the job (WS-D's copy reads it).
 */
export interface MacApprovalJob {
  sessionId: string
  deviceName: string
  folderLabel: string
}

/**
 * What an approval the Mac body raises records for its accept-time re-check:
 * the main chat's ceiling, the options its call ran under (an unattended
 * job's are the unattended fence, as a loop's run), and the job.
 */
export function macApprovalContext(body: MacBody): ApprovalContext {
  const tools: ApprovalToolOptions =
    body.caller === 'agent_unattended'
      ? { ...UNATTENDED_TOOL_OPTIONS, origin: { ...MAC_ORIGIN } }
      : { origin: { ...MAC_ORIGIN }, strictWorkspace: true }
  // `localAgent` rides as JSON on tool_approval.context; ApprovalContext names it once WS-D adds it.
  const context: ApprovalContext & { localAgent: MacApprovalJob } = {
    tools,
    localAgent: { sessionId: body.session.id, deviceName: body.session.deviceName, folderLabel: body.session.folderLabel },
  }
  return context
}

/**
 * The createTools options for a Mac body call (beside MAC_ORIGIN and
 * strictWorkspace, recorded on its approvals):
 *   - a canon section edit is labelled as resting on outside text: the Mac
 *     body works from files, pages and command output the server never saw;
 *   - the main chat's search window (its prompt carries the guidance);
 *   - the turn's outside reads, as the cloud body's (keyed by the Mac's scope);
 *   - the zone a calendar card's days are in, when the Mac sent a real one;
 *   - an unattended job (a loop's start) takes a loop run's fence: no private
 *     captures, no HubSpot writeback, drafts on the daily cap, the actions it
 *     files arrive as suggestions and it confirms none.
 */
export function macCreateToolsOptions(
  body: MacBody,
  ctx: ToolDispatchContext,
  scope: { sessionId?: unknown; turnId?: unknown; timeZone?: unknown },
): CreateToolsOptions {
  const turnKey = goAheadTurnKey({ userId: ctx.keyScope, sessionId: scope.sessionId, turnId: scope.turnId })
  const unattended = body.caller === 'agent_unattended'
  return {
    origin: { ...MAC_ORIGIN },
    strictWorkspace: true,
    canonContext: { attended: false, outsideReadsRunId: null },
    approvalContext: ctx.approvalContext,
    searchDefaultWindow: 'past_4_weeks',
    flowContext: { turnReadOutside: () => turnOutsideReadTools(turnKey) },
    ...(isTimeZone(scope.timeZone) ? { timeZone: scope.timeZone } : {}),
    ...(unattended
      ? {
          omitPrivateCaptures: true,
          unattended: true,
          automaticDrafts: true,
          actionRules: { unattended: true, fileActionsAsSuggested: true },
        }
      : {}),
  }
}

/** How many of the person's own words the reviewer reads (reviewPersonMessages keeps 3). */
const PERSON_WORDS_MAX = 3

/**
 * The person's own words for a Mac job, as the SERVER stored them, never taken
 * from what the Mac posts (its "user" messages are mostly the cloud agent's,
 * and a token holder could post anything), and never found by timestamp: the
 * reviewer's evidence (action-review.ts), oldest first, at most 3, read only
 * when a review runs.
 *   - the words that started it: what the person typed in the chat turn that
 *     started it (`start_words`, stored at start), else, for a job the person
 *     started themselves, its request;
 *   - the words that joined it since: a message the person sent the job
 *     (author 'person'), and the person's typed words behind a message the
 *     cloud agent sent it from their turn (`person_words`, stored at join).
 * A failed read is no words: the blocking review then holds the call as their card.
 */
export function macPersonWords(svc: SupabaseClient, session: MacSession): () => Promise<string[]> {
  return async () => {
    const started = session.startWords.length > 0 ? session.startWords : session.startedBy === 'person' ? [session.request] : []
    const joined: string[] = []
    const { data } = await svc
      .from('local_agent_message')
      .select('author, text, person_words, created_at')
      .eq('session_id', session.id)
      .eq('user_id', session.userId)
      .order('created_at', { ascending: false })
      .limit(PERSON_WORDS_MAX * 2)
    for (const m of ((data ?? []) as Array<{ author?: unknown; text?: unknown; person_words?: unknown }>).reverse()) {
      if (m.author === 'person') joined.push(...wordsOf([m.text]))
      else joined.push(...wordsOf(m.person_words))
    }
    return [...started, ...joined].slice(-PERSON_WORDS_MAX)
  }
}

/** The shared dispatch's context for a Mac body call. */
export function macDispatchContext(supabase: SupabaseClient, body: MacBody): ToolDispatchContext {
  // `mustEnforce` (WS-D): blocking whatever the env says. It rides through
  // the override until GateRequest declares it.
  const review = {
    personMessages: macPersonWords(supabase, body.session),
    personMessagesStale: undefined,
    personMessageSeq: null,
    mustEnforce: true as const,
  }
  return {
    supabase,
    userId: body.session.userId,
    workspaceId: body.session.workspaceId,
    conversationId: body.session.conversationId,
    caller: body.caller,
    approvalContext: macApprovalContext(body),
    // Nobody reads the Mac's turns in a chat, where a card would draw under
    // the message that raised it: its cards ask in the person's home thread.
    cardConversationId: null,
    // The Mac body's turns are its own: never counted as the cloud chat's.
    keyScope: `mac:${body.session.id}`,
    // The reviewer's evidence is the person's words as the server stored them,
    // never what the Mac posts (a loop-started job's route sets the loop's).
    reviewOverride: review,
  }
}

/** What the model on the Mac reads about a card it raised: where it waits, and to carry on. */
export function macHeldMessage(toolName: string): string {
  return `Nothing ran yet. ${toolName} needs the person's approval: its card is waiting in their Native Intelligence home chat, and it runs once they approve it there. Carry on without it, say in your report that it is waiting, and do not call it again.`
}

/**
 * The gate for a Mac body call: the local-model gate (or the usual one), with
 * a held card's message saying where the card really is (a chat's wording,
 * "right under your message", isn't true on the Mac). The per-job card cap is
 * createToolApproval's (APPROVAL_PENDING_MAX_PER_MAC_JOB).
 */
export function macGate(body: MacBody, _svc: SupabaseClient): typeof gateRiskyCall {
  const gate = localModelGate(body)
  return async <T,>(request: GateRequest, run: () => Promise<T>) => {
    const gated = await gate(request, run)
    if (gated.held && gated.output.code === 'APPROVAL_REQUIRED' && gated.output.approval_id) {
      return { held: true as const, output: { ...gated.output, message: macHeldMessage(request.toolName) } }
    }
    return gated
  }
}

/**
 * The person's MCP tools for the Mac: mcp_confirm_call's answer says where its
 * card really is (the adapter's says "right under your message"); its card
 * keeps to createToolApproval's per-job cap.
 */
export function withMacConfirmWording(tools: Record<string, Tool>, _svc: SupabaseClient, body: MacBody): Record<string, Tool> {
  const confirm = Object.hasOwn(tools, 'mcp_confirm_call') ? tools.mcp_confirm_call : undefined
  if (!confirm || typeof confirm.execute !== 'function') return tools
  const execute = confirm.execute
  return {
    ...tools,
    mcp_confirm_call: {
      ...confirm,
      async execute(input: never, options: never) {
        const out = (await execute(input, options)) as Record<string, unknown>
        if (out && typeof out === 'object' && out.status === 'approval_requested') {
          return { ...out, message: macHeldMessage(String(out.tool ?? 'This call')) }
        }
        return out
      },
    } as Tool,
  }
}

/**
 * A local model's gate (the integration notes' "Local-model Macs"): every
 * RISKY call (outward, delete, automation-write, an outside tool) is held as
 * the person's card (asked in their home thread), whatever the reviewer would
 * say; for an unattended job it is refused NEEDS_PERSON (no one is there to
 * answer). Internal writes aren't risky: they run, through the usual gate
 * (apply with undo). Not a local model: the usual gate.
 */
export function localModelGate(body: MacBody): typeof gateRiskyCall {
  if (!body.session.localModel) return gateRiskyCall
  return async <T,>(request: GateRequest, run: () => Promise<T>) => {
    if (!request.sideEffect) return gateRiskyCall(request, run)
    if (decideAction(body.caller, 'outward', request.toolName) !== 'ask') {
      const output: HeldCallOutput = {
        success: false,
        code: 'NEEDS_PERSON',
        approval_id: null,
        message: `Nothing ran. On a model on the Mac, ${request.toolName} needs the person's yes, and nobody is here to give it. Say what you would have done.`,
      }
      return { held: true as const, output }
    }
    const held = await createToolApproval(request.approval.supabase, {
      door: request.door,
      userId: request.userId,
      workspaceId: request.workspaceId,
      toolName: request.toolName,
      sideEffect: request.sideEffect,
      input: request.input,
      conversationId: request.approval.conversationId ?? null,
      context: request.approval.context,
      reason: 'local_model',
      personMessageSeq: request.personMessageSeq ?? null,
      card: {
        title: `Approve ${request.toolName}?`,
        why: `Native Intelligence on ${body.session.deviceName} (in ${body.session.folderLabel}) is running on a model on your Mac, so anything that changes or sends something outside your workspace waits for you. This runs ${request.toolName} once, with exactly the inputs below.`,
      },
    })
    const output: HeldCallOutput = {
      success: false,
      code: 'APPROVAL_REQUIRED',
      approval_id: held.ok ? held.approvalId : null,
      message: held.ok
        ? macHeldMessage(request.toolName)
        : `Nothing ran. ${request.toolName} needs the person's approval, and no approval card was made: ${held.error} Tell the person.`,
    }
    return { held: true as const, output }
  }
}

// ── The spec ────────────────────────────────────────────────────────────────

/** The Mac body's model: the relay's (its allowlist holds this one), and how it is called. */
export function macModel(): { model: string; modelPolicy: ChatModelPolicy } {
  return { model: LOCAL_AGENT_MODEL_SLUG, modelPolicy: chatModelPolicy(SURFACE_MODELS.coding_runs, 'standard') }
}

/** The helper fields of the spec: the quick helpers are a cloud chat's. */
export const MAC_HELPER_FIELDS = Object.freeze({
  helpersAllowed: false,
  helpersRefusal: 'Helpers run in the cloud chat, not on the Mac. Do the work yourself, step by step.',
  helperToolNames: [] as string[],
})

/** The durable facts the main chat's spec is rebuilt from, for the session's conversation. */
export function macChatClaims(body: MacBody): ChatRunTokenClaims {
  return {
    conversationId: body.session.conversationId,
    workspaceId: body.session.workspaceId,
    userId: body.session.userId,
    exp: body.claims.exp * 1000,
  }
}

/** One advertised tool entry, as ChatSpec.ceilingTools carries it. */
type SpecTool = ChatSpec['ceilingTools'][number]

function specTool(name: string, description: string, inputSchema: z.ZodType, includeSchemas: boolean): SpecTool {
  const schema = includeSchemas ? toolInputJsonSchema({ inputSchema } as Tool) : null
  return { name, description, ...(schema ? { inputSchema: schema } : {}) }
}

/** The Mac body's spec, from the main chat's: see the header and the plan's C1. */
export type MacSpec = Omit<ChatSpec, 'ceiling' | 'gatewayTelemetry' | 'modelRoute' | 'cards'> & {
  ceiling: string[]
  helpersAllowed: false
  helpersRefusal: string
  helperToolNames: string[]
  host: typeof MAC_HOST
  localModel: boolean
  session: { id: string; conversationId: string }
}

/**
 * Narrow the main chat's spec to the Mac body: its ceiling ({@link macCeiling}),
 * the tools it advertises (the web tools and its own tools added, with their
 * schemas when asked for), the relay's model, no Gateway telemetry or route
 * record (the relay tags and meters the Mac's calls), no cards, no folders
 * section (the Mac body never starts local agents), no Now file, no helpers.
 */
export function macSpec(spec: ChatSpec, body: MacBody, opts: { includeSchemas?: boolean } = {}): MacSpec {
  const { ceiling: chatCeiling, gatewayTelemetry: _telemetry, modelRoute: _route, cards: _cards, turnContext, turnContextHeld, ...rest } = spec
  const localModel = body.session.localModel
  const ceiling = macCeiling(chatCeiling ?? spec.ceilingTools.map((t) => t.name), [], { caller: body.caller, localModel })
  const extra: SpecTool[] = [
    ...(localModel ? [] : MAC_WEB_TOOL_NAMES.map((name) => specTool(name, MAC_WEB_TOOL_DEFINITIONS[name].description, MAC_WEB_TOOL_DEFINITIONS[name].inputSchema, !!opts.includeSchemas))),
    ...macNativeToolEntries().map((t) => ({ name: t.name, description: t.description, ...(opts.includeSchemas ? { inputSchema: t.inputSchema } : {}) })),
  ]
  const extraNames = new Set(extra.map((t) => t.name))
  const ceilingTools = [
    ...spec.ceilingTools.filter((t) => !extraNames.has(t.name) && (t.name === 'search_tools' || ceiling.has(t.name))),
    ...extra,
  ]
  const coreToolNames = [...new Set([...spec.coreToolNames.filter((name) => ceiling.has(name)), ...extraNames])]
  // Never the environment (the Mac body never starts local agents) or the
  // person's Now file (docs/plans/now-file.md: the main chat in the app and
  // its check-in only; a Mac job reads local files and the web).
  const dropped = new Set([ENVIRONMENT_SECTION_KEY, NOW_SECTION_KEY])
  const held = turnContextHeld?.filter((key) => !dropped.has(key))
  return {
    ...rest,
    ...macModel(),
    ceiling: [...ceiling],
    ceilingTools,
    coreToolNames,
    ...(turnContext ? { turnContext: turnContext.filter((section) => !dropped.has(section.key)) } : {}),
    ...(held && held.length > 0 ? { turnContextHeld: held } : {}),
    ...MAC_HELPER_FIELDS,
    host: MAC_HOST,
    localModel,
    session: { id: body.session.id, conversationId: body.session.conversationId },
  }
}
