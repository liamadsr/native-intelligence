/**
 * What OpenAI's plan route accepts, applied to the Responses request an eve
 * agent's model sends through the plan proxy
 * (src/app/api/internal/chatgpt-plan/v1/responses/route.ts), and what its
 * answers mean (docs/plans/chatgpt-free-tier.md §4 and §6).
 *
 * Tested 10-20 with a real plan token: api.openai.com/v1/responses requires
 * `store: false` and `stream: true`, and refuses each of REJECTED_FIELDS, an
 * input item with the `system` role, and hosted tools. A spent plan answers
 * 429 `subscription_sharing_usage_limit_exceeded`. Tested 10-22: OpenAI's own
 * `web_search` is the exception (a bare `{ type: 'web_search' }` searched and
 * answered with citations); `web_search_preview` is refused (400). A chat
 * turn's shape works too: function tools beside web search, then a second
 * step carrying the `web_search_call`, `function_call` and its output back.
 */

import { PLAN_MODELS } from './plan-models'

const REJECTED_FIELDS = [
  'temperature',
  'max_output_tokens',
  'metadata',
  'user',
  'safety_identifier',
  'prompt_cache_retention',
  'truncation',
  'top_p',
  'top_logprobs',
  'background',
  'conversation',
  'max_tool_calls',
  'moderation',
  'multi_agent',
  'prompt',
  // Needs a stored response, and nothing is stored.
  'previous_response_id',
  // Untested on the plan route. eve sets it for a model it reads as OpenAI's
  // own (the plan's search model, CHATGPT_PLAN_SEARCH_PROVIDER), which no
  // plan step sent before; dropped until a real plan says it's accepted.
  'prompt_cache_key',
] as const

/** The one hosted tool the plan route takes (see the header). */
const WEB_SEARCH_TOOL = 'web_search'

/**
 * Kept from `include`: the reasoning a store-less call carries forward, and
 * the pages a web search returned (`web_search_call.action.sources`, which
 * the SDK asks for with web search; accepted by the plan route, 10-22).
 */
const KEPT_INCLUDES = new Set(['reasoning.encrypted_content', 'web_search_call.action.sources'])

/** OpenAI error codes that mean the person's plan can't serve this call now. */
const OUT_OF_CREDITS_CODES = new Set(['subscription_sharing_usage_limit_exceeded'])

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Why a body can't be sent: `invalid_body` (400), or `hosted_tool` (403): a
 * provider-run tool on a route that doesn't take one.
 */
export type PlanRequestRefusal = 'invalid_body' | 'hosted_tool'

export type PlanRequest = { ok: true; body: Json; model: string } | { ok: false; error: string; code: PlanRequestRefusal }

export interface PlanRequestOptions {
  /**
   * OpenAI's hosted web search, for the cloud agents (their `web_search` on
   * the plan): kept bare, and every other hosted tool dropped. Off (a local
   * agent on the person's Mac, whose network is off), any tool but a function
   * tool refuses the call, as the Gateway relay refuses a provider-run tool
   * (src/lib/local-agent/relay.ts): OpenAI would run it outside the fence.
   */
  webSearch: boolean
}

/**
 * The body to send to OpenAI, or why it can't be sent. Pure: never mutates
 * `raw`.
 */
export function planRequestBody(raw: unknown, opts: PlanRequestOptions): PlanRequest {
  if (!isRecord(raw)) return { ok: false, error: 'body must be a JSON object', code: 'invalid_body' }
  const model = typeof raw.model === 'string' ? raw.model : ''
  if (!PLAN_MODELS.has(model)) return { ok: false, error: `model ${JSON.stringify(model)} is not a plan model`, code: 'invalid_body' }
  if (!opts.webSearch && Array.isArray(raw.tools)) {
    const hosted = raw.tools.find((tool) => !isRecord(tool) || tool.type !== 'function')
    if (hosted !== undefined) {
      const type = isRecord(hosted) && typeof hosted.type === 'string' ? hosted.type : String(hosted)
      return { ok: false, error: `provider-run tool ${JSON.stringify(type)} is not allowed here (only function tools)`, code: 'hosted_tool' }
    }
  }
  const body: Json = { ...raw, store: false, stream: true }
  for (const field of REJECTED_FIELDS) delete body[field]
  if (Array.isArray(raw.input)) {
    body.input = raw.input.map((item) => (isRecord(item) && item.role === 'system' ? { ...item, role: 'developer' } : item))
  }
  if (Array.isArray(raw.include)) {
    const include = raw.include.filter((entry) => typeof entry === 'string' && KEPT_INCLUDES.has(entry))
    if (include.length) body.include = include
    else delete body.include
  }
  if (Array.isArray(raw.tools)) {
    // Function tools, and OpenAI's web search exactly as the 10-22 test sent
    // it: bare, once, its options (filters, location, context size) dropped,
    // since the plan route's answer to them is untested. (Without webSearch,
    // a hosted tool was refused above.)
    const tools: unknown[] = raw.tools.filter((tool) => isRecord(tool) && tool.type === 'function')
    if (raw.tools.some((tool) => isRecord(tool) && tool.type === WEB_SEARCH_TOOL)) tools.push({ type: WEB_SEARCH_TOOL })
    if (tools.length) body.tools = tools
    else delete body.tools
  }
  // A choice naming a hosted tool: untested on the plan route, so the model
  // chooses for itself (web search stays offered).
  if (isRecord(raw.tool_choice) && raw.tool_choice.type !== 'function') delete body.tool_choice
  if (!body.tools) delete body.tool_choice
  return { ok: true, body, model }
}

/** An OpenAI error's code, from a JSON error body or a streamed failure. */
export function openAiErrorCode(value: unknown): string | null {
  if (!isRecord(value)) return null
  const error = isRecord(value.error) ? value.error : isRecord(value.response) && isRecord(value.response.error) ? value.response.error : value
  const code = typeof error.code === 'string' ? error.code : typeof error.type === 'string' ? error.type : null
  return code
}

/** Whether an OpenAI error code means the plan's credits ran out. */
export function isOutOfCredits(code: string | null): boolean {
  return code !== null && OUT_OF_CREDITS_CODES.has(code)
}

/**
 * Network errors that mean a call never reached OpenAI: no connection was
 * made (DNS, refused, unreachable, the connect timed out), so nothing was
 * sent and trying again can't run the request twice. A reset or a failure
 * after the request went out is not here: OpenAI may have taken it.
 */
const CONNECT_FAILURE_CODES: ReadonlySet<string> = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
])

/** The network error code under a failed `fetch` (undici's `cause`, or a nested one), or null. */
export function networkErrorCode(err: unknown): string | null {
  for (let e: unknown = err, depth = 0; isRecord(e) && depth < 4; e = e.cause, depth++) {
    if (typeof e.code === 'string' && e.code.length > 0) return e.code
  }
  return null
}

/**
 * Whether a thrown `fetch` failed before the request reached OpenAI, so the
 * plan proxy may try once more (on DEV, 10-21, a stalled network made every
 * free user's call fail the AI SDK's three attempts, where a Gateway call
 * would have been retried and routed around).
 */
export function isConnectFailure(err: unknown): boolean {
  const code = networkErrorCode(err)
  return code !== null && CONNECT_FAILURE_CODES.has(code)
}

export interface PlanUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
}

/** What one streamed Responses call ended with. */
export interface PlanStreamOutcome {
  /** The final `response.completed` / `response.incomplete` usage, if any. */
  usage: PlanUsage | null
  /** The failure's code (`response.failed` or an `error` event), if any. */
  errorCode: string | null
  /** True once a `response.completed` arrived. */
  completed: boolean
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0)

function usageOf(response: unknown): PlanUsage | null {
  if (!isRecord(response) || !isRecord(response.usage)) return null
  const usage = response.usage
  return {
    inputTokens: count(usage.input_tokens),
    outputTokens: count(usage.output_tokens),
    cachedInputTokens: isRecord(usage.input_tokens_details) ? count(usage.input_tokens_details.cached_tokens) : 0,
    reasoningTokens: isRecord(usage.output_tokens_details) ? count(usage.output_tokens_details.reasoning_tokens) : 0,
  }
}

/**
 * Reads a Responses SSE stream as it passes through, for the usage and the
 * outcome. Feed it the decoded text in any chunking; `outcome()` at the end.
 */
export function planStreamReader(): { push(text: string): void; outcome(): PlanStreamOutcome } {
  let buffer = ''
  const result: PlanStreamOutcome = { usage: null, errorCode: null, completed: false }
  const handle = (event: string) => {
    const data = event
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (!data || data === '[DONE]') return
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    if (!isRecord(parsed)) return
    switch (parsed.type) {
      case 'response.completed':
        result.completed = true
        result.usage = usageOf(parsed.response) ?? result.usage
        break
      case 'response.incomplete':
        result.usage = usageOf(parsed.response) ?? result.usage
        break
      case 'response.failed':
      case 'error':
        result.errorCode = openAiErrorCode(parsed) ?? 'unknown_error'
        result.usage = usageOf(parsed.response) ?? result.usage
        break
    }
  }
  return {
    push(text) {
      buffer += text.replace(/\r\n/g, '\n')
      let end = buffer.indexOf('\n\n')
      while (end !== -1) {
        handle(buffer.slice(0, end))
        buffer = buffer.slice(end + 2)
        end = buffer.indexOf('\n\n')
      }
    },
    outcome() {
      if (buffer.trim()) {
        handle(buffer)
        buffer = ''
      }
      return { ...result }
    },
  }
}
