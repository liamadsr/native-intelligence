/**
 * The ChatGPT plan proxy's core: one Responses request, on the person's own
 * ChatGPT plan (docs/plans/chatgpt-free-tier.md §4–6). Two routes call it,
 * each after authenticating its caller its own way:
 *   - POST /api/internal/chatgpt-plan/v1/responses: the cloud eve agents
 *     (their run credentials, src/lib/chatgpt/plan-caller.ts);
 *   - POST /api/local-agent/model/plan/responses: a local agent on the
 *     person's Mac (its model token and live session, the relay route).
 *
 * It swaps in the person's plan access token (refreshed under the lease,
 * ./connection.ts), applies the plan route's rules (./plan-request.ts) and
 * streams OpenAI's answer back as it comes. Nothing here ever reaches the AI
 * Gateway or a Native Intelligence key: no token, no call.
 *
 * A call that made no connection to OpenAI (DNS, refused, connect timeout)
 * is tried once more before it fails 502; one that may have reached OpenAI
 * never is.
 *
 * Out of credits: OpenAI's `subscription_sharing_usage_limit_exceeded` marks
 * the connection `exhausted` and answers 402 (not OpenAI's 429, which the SDK
 * would retry for nothing). The next call tries again; one that completes
 * marks it `active`.
 *
 * Status: OpenAI's own on success and for its errors (bodies passed through),
 * except 402 out of credits; 400 a body the plan route can't take; 403 a
 * provider-run tool from a caller that didn't allow web search; 401 no
 * usable connection (`chatgpt_plan_unavailable`); 502 OpenAI unreachable; 503
 * a refresh that failed or is busy, or a connection that couldn't be read
 * (the SDK retries it).
 */
import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { CHATGPT_PLAN_RESOURCE } from './config'
import { getPlanAccessToken, setConnectionStatus } from './connection'
import {
  isConnectFailure,
  isOutOfCredits,
  networkErrorCode,
  openAiErrorCode,
  planRequestBody,
  planStreamReader,
  type PlanStreamOutcome,
} from './plan-request'

const RESPONSES_URL = `${CHATGPT_PLAN_RESOURCE}/responses`

/** Tries at OpenAI: a second only when the first made no connection (isConnectFailure). */
const UPSTREAM_ATTEMPTS = 2
const CONNECT_RETRY_DELAY_MS = 250

const OUT_OF_CREDITS_MESSAGE = "Your ChatGPT plan's usage limit is reached. AI in Native Intelligence picks up again when your plan resets."

/** An error in OpenAI's shape, so the SDK reports its message. */
export function planError(status: number, code: string, message: string): Response {
  return NextResponse.json({ error: { message, type: 'chatgpt_plan_error', code } }, { status })
}

/** How a proxied call ended, for a caller that meters it or holds a slot for it. */
export interface PlanCallSettled {
  /** The plan model the request named (a PLAN_MODELS id), or null when the body was refused. */
  model: string | null
  /** The stream's outcome (its usage, an error code), or null when no answer streamed back. */
  outcome: PlanStreamOutcome | null
}

export interface ProxyPlanOptions {
  /**
   * Called exactly once when the call is over, however it ends: the stream's
   * end, its error (OpenAI dropping the connection), the client's cancel, or
   * right away when no answer streams back (a refusal, an error, a
   * connection that couldn't be read). Awaited before the stream closes on
   * its end, so a caller that writes here should only hand the work on (the
   * relay resolves a promise its `after()` waits on).
   */
  onSettled?: (settled: PlanCallSettled) => void | Promise<void>
  /** The request body as text, when the caller already read it (to check its size). */
  rawBody?: string
  /**
   * Let OpenAI's hosted web search through (plan-request.ts's `webSearch`):
   * the cloud agents' route sets it. Off by default, so a caller that doesn't
   * say (the local agent's relay, whose network is off) gets function tools
   * only, and any other tool is refused 403.
   */
  webSearch?: boolean
}

/**
 * Proxy one Responses request for `userId`, whose plan pays: the caller has
 * already said who that is. Never throws for an expected state.
 */
export async function proxyPlanResponses(request: Request, userId: string, opts: ProxyPlanOptions = {}): Promise<Response> {
  let model: string | null = null
  const settle = async (outcome: PlanStreamOutcome | null) => {
    try {
      await opts.onSettled?.({ model, outcome })
    } catch (err) {
      console.error('[chatgpt-plan] settle failed:', err instanceof Error ? err.message : String(err))
    }
  }
  const early = async (res: Response) => {
    await settle(null)
    return res
  }

  let raw: unknown
  try {
    raw = JSON.parse(opts.rawBody ?? (await request.text()))
  } catch {
    return early(planError(400, 'invalid_body', 'The request body is not JSON.'))
  }
  const planRequest = planRequestBody(raw, { webSearch: opts.webSearch === true })
  if (!planRequest.ok) return early(planError(planRequest.code === 'hosted_tool' ? 403 : 400, planRequest.code, planRequest.error))
  model = planRequest.model

  const service = getServiceClient()
  let token: Awaited<ReturnType<typeof getPlanAccessToken>>
  try {
    token = await getPlanAccessToken(service, userId)
  } catch (err) {
    // The connection couldn't be read, leased or decrypted: retried by the SDK.
    console.error('[chatgpt-plan] connection read failed:', err instanceof Error ? err.message : String(err))
    return early(planError(503, 'chatgpt_plan_unreadable', 'Your ChatGPT plan could not be reached. Try again in a moment.'))
  }
  if (!token.ok) {
    if (token.reason === 'busy' || token.reason === 'refresh_failed') {
      return early(planError(503, `chatgpt_plan_${token.reason}`, 'Your ChatGPT plan could not be reached. Try again in a moment.'))
    }
    return early(planError(401, 'chatgpt_plan_unavailable', 'Reconnect ChatGPT to keep using AI on your plan.'))
  }

  // Best effort: a status write never fails the call it describes.
  const markStatus = async (status: 'active' | 'exhausted', lastError: string | null) => {
    await setConnectionStatus(service, userId, status, lastError).catch((err: unknown) => {
      console.error('[chatgpt-plan] status update failed:', err instanceof Error ? err.message : String(err))
    })
  }

  // One more try when the first never reached OpenAI (no connection made),
  // so a network blip doesn't spend the AI SDK's attempts. A call that may
  // have reached OpenAI is never sent twice.
  const requestBody = JSON.stringify(planRequest.body)
  let upstream: Response | null = null
  for (let attempt = 1; !upstream; attempt++) {
    try {
      upstream = await fetch(RESPONSES_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token.accessToken}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: requestBody,
        // A cancelled call stops the OpenAI call too.
        signal: request.signal,
      })
    } catch (err) {
      if (request.signal.aborted) return early(new Response(null, { status: 499 }))
      const cause = networkErrorCode(err)
      if (attempt < UPSTREAM_ATTEMPTS && isConnectFailure(err)) {
        console.warn(`[chatgpt-plan] OpenAI connect failed (${cause}); trying once more`)
        await new Promise((r) => setTimeout(r, CONNECT_RETRY_DELAY_MS))
        continue
      }
      console.error('[chatgpt-plan] OpenAI unreachable:', err instanceof Error ? err.message : String(err), cause ?? '')
      return early(planError(502, 'chatgpt_plan_unreachable', 'OpenAI could not be reached. Try again in a moment.'))
    }
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '')
    let parsed: unknown = null
    try {
      parsed = JSON.parse(text)
    } catch {
      // Not JSON: passed through as text below.
    }
    const code = openAiErrorCode(parsed)
    console.warn(`[chatgpt-plan] OpenAI ${upstream.status} ${code ?? ''}`.trim())
    if (isOutOfCredits(code)) {
      await markStatus('exhausted', code)
      return early(planError(402, code!, OUT_OF_CREDITS_MESSAGE))
    }
    return early(
      new Response(text || null, {
        status: upstream.ok ? 502 : upstream.status,
        headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
      }),
    )
  }

  // Stream it through as it comes, reading the events on the way for the
  // outcome: a spent plan mid-stream marks it exhausted, a completed call
  // after one clears it. The call settles once, however the stream ends: its
  // end, OpenAI's side failing, or the client cancelling (a TransformStream's
  // flush runs on the first only).
  const reader = planStreamReader()
  const decoder = new TextDecoder()
  const wasExhausted = token.status === 'exhausted'
  const source = upstream.body.getReader()
  let finished = false
  const finish = async () => {
    if (finished) return
    finished = true
    reader.push(decoder.decode())
    const outcome = reader.outcome()
    if (isOutOfCredits(outcome.errorCode)) await markStatus('exhausted', outcome.errorCode)
    else if (outcome.completed && wasExhausted) await markStatus('active', null)
    await settle(outcome)
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await source.read()
      } catch (err) {
        controller.error(err)
        await finish()
        return
      }
      if (chunk.done) {
        await finish()
        controller.close()
        return
      }
      controller.enqueue(chunk.value)
      reader.push(decoder.decode(chunk.value, { stream: true }))
    },
    async cancel(reason) {
      await source.cancel(reason).catch(() => undefined)
      await finish()
    },
  })
  return new Response(body, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'text/event-stream',
      'cache-control': 'no-store',
      ...(upstream.headers.get('x-request-id') ? { 'x-request-id': upstream.headers.get('x-request-id')! } : {}),
    },
  })
}
