import { describe, expect, it } from 'vitest'
import { isConnectFailure, isOutOfCredits, networkErrorCode, openAiErrorCode, planRequestBody, planStreamReader } from '../plan-request'

/** The cloud agents' route: OpenAI's web search allowed. */
const WEB = { webSearch: true }
/** The local agent's relay: function tools only. */
const NO_WEB = { webSearch: false }

describe('planRequestBody', () => {
  it('forces store:false and stream:true and strips what the plan route refuses', () => {
    const raw = {
      model: 'gpt-6.1-sol',
      store: true,
      stream: false,
      temperature: 0.2,
      max_output_tokens: 4000,
      metadata: { a: 'b' },
      user: 'u1',
      safety_identifier: 's',
      previous_response_id: 'resp_1',
      prompt_cache_key: 'k',
      reasoning: { effort: 'low' },
      include: ['reasoning.encrypted_content', 'web_search_call.action.sources'],
      input: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      ],
      tools: [
        { type: 'function', name: 'find', parameters: {} },
        { type: 'web_search' },
      ],
      tool_choice: 'auto',
    }
    const result = planRequestBody(raw, WEB)
    expect(result).toEqual({
      ok: true,
      model: 'gpt-6.1-sol',
      body: {
        model: 'gpt-6.1-sol',
        store: false,
        stream: true,
        reasoning: { effort: 'low' },
        include: ['reasoning.encrypted_content', 'web_search_call.action.sources'],
        input: [
          { role: 'developer', content: 'be brief' },
          { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        ],
        tools: [{ type: 'function', name: 'find', parameters: {} }, { type: 'web_search' }],
        tool_choice: 'auto',
      },
    })
    // The caller's object is left alone.
    expect(raw.store).toBe(true)
    expect(raw.input[0].role).toBe('system')
  })

  it('keeps OpenAI web search bare and once, and drops every other hosted tool', () => {
    const result = planRequestBody({
      model: 'gpt-6-luna',
      input: [],
      tools: [
        { type: 'web_search', search_context_size: 'high', filters: { allowed_domains: ['a.com'] }, user_location: { type: 'approximate' } },
        { type: 'web_search' },
        { type: 'web_search_preview' },
        { type: 'file_search', vector_store_ids: ['vs_1'] },
        { type: 'code_interpreter', container: { type: 'auto' } },
        { type: 'image_generation' },
      ],
      tool_choice: { type: 'web_search' },
    }, WEB)
    expect(result.ok && result.body).toEqual({ model: 'gpt-6-luna', input: [], store: false, stream: true, tools: [{ type: 'web_search' }] })
  })

  it('drops a tool choice that names a hosted tool, and an emptied tool list', () => {
    const result = planRequestBody({ model: 'gpt-6-luna', input: [], tools: [{ type: 'file_search' }], tool_choice: { type: 'file_search' } }, WEB)
    expect(result.ok && result.body).toEqual({ model: 'gpt-6-luna', input: [], store: false, stream: true })
  })

  it('without web search (the local agent, network off): refuses web search and every other hosted tool', () => {
    for (const tool of [{ type: 'web_search' }, { type: 'web_search_preview' }, { type: 'file_search' }, { type: 'code_interpreter' }, { type: 'mcp', server_url: 'https://x.example' }, 'web_search', null]) {
      const result = planRequestBody({ model: 'gpt-6-luna', input: [], tools: [{ type: 'function', name: 'bash', parameters: {} }, tool] }, NO_WEB)
      expect(result).toMatchObject({ ok: false, code: 'hosted_tool' })
    }
  })

  it('without web search: function tools pass as they are', () => {
    const tools = [{ type: 'function', name: 'bash', parameters: {} }]
    const result = planRequestBody({ model: 'gpt-6-luna', input: [], tools, tool_choice: 'auto' }, NO_WEB)
    expect(result.ok && result.body).toEqual({ model: 'gpt-6-luna', input: [], store: false, stream: true, tools, tool_choice: 'auto' })
  })

  it('refuses a model that is not a plan model, and a body that is not an object', () => {
    expect(planRequestBody({ model: 'openai/gpt-6.1-sol' }, WEB)).toMatchObject({ ok: false, code: 'invalid_body' })
    expect(planRequestBody({ model: 'gpt-6-astra' }, WEB)).toMatchObject({ ok: false, code: 'invalid_body' })
    expect(planRequestBody(null, WEB)).toMatchObject({ ok: false, code: 'invalid_body' })
    expect(planRequestBody([], WEB)).toMatchObject({ ok: false, code: 'invalid_body' })
  })
})

describe('openAiErrorCode / isOutOfCredits', () => {
  it('reads the code from an error body, a failed response and an error event', () => {
    expect(openAiErrorCode({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'x' } })).toBe(
      'subscription_sharing_usage_limit_exceeded',
    )
    expect(openAiErrorCode({ type: 'response.failed', response: { error: { code: 'server_error' } } })).toBe('server_error')
    expect(openAiErrorCode({ type: 'error', code: 'rate_limit_exceeded', message: 'x' })).toBe('rate_limit_exceeded')
    expect(openAiErrorCode({ error: { type: 'invalid_request_error' } })).toBe('invalid_request_error')
    expect(openAiErrorCode('nope')).toBeNull()
  })

  it('knows the spent-plan code only', () => {
    expect(isOutOfCredits('subscription_sharing_usage_limit_exceeded')).toBe(true)
    expect(isOutOfCredits('rate_limit_exceeded')).toBe(false)
    expect(isOutOfCredits(null)).toBe(false)
  })
})

describe('planStreamReader', () => {
  const sse = (event: Record<string, unknown>) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`

  it('takes the final usage from response.completed, across any chunking', () => {
    const text =
      sse({ type: 'response.created', response: { id: 'r1' } }) +
      sse({ type: 'response.output_text.delta', delta: 'hi' }) +
      sse({
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 1200,
            output_tokens: 80,
            input_tokens_details: { cached_tokens: 1000 },
            output_tokens_details: { reasoning_tokens: 30 },
          },
        },
      })
    const reader = planStreamReader()
    for (let i = 0; i < text.length; i += 7) reader.push(text.slice(i, i + 7))
    expect(reader.outcome()).toEqual({
      completed: true,
      errorCode: null,
      usage: { inputTokens: 1200, outputTokens: 80, cachedInputTokens: 1000, reasoningTokens: 30 },
    })
  })

  it('names a failure and handles CRLF and an unterminated last event', () => {
    const reader = planStreamReader()
    reader.push(sse({ type: 'response.created' }).replace(/\n/g, '\r\n'))
    reader.push(`data: ${JSON.stringify({ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } })}`)
    expect(reader.outcome()).toEqual({ completed: false, errorCode: 'subscription_sharing_usage_limit_exceeded', usage: null })
  })

  it('ignores lines that are not JSON', () => {
    const reader = planStreamReader()
    reader.push(': keep-alive\n\ndata: [DONE]\n\ndata: {oops\n\n')
    expect(reader.outcome()).toEqual({ completed: false, errorCode: null, usage: null })
  })
})

describe('isConnectFailure', () => {
  it('is a fetch that made no connection (undici puts the code on its cause)', () => {
    for (const code of ['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']) {
      expect(isConnectFailure(new TypeError('fetch failed', { cause: { code } })), code).toBe(true)
    }
    // Nested one deeper, as undici sometimes wraps it.
    expect(isConnectFailure(new TypeError('fetch failed', { cause: new Error('x', { cause: { code: 'ENOTFOUND' } }) }))).toBe(true)
  })

  it('is never a failure after the request may have gone out, or an error with no code', () => {
    expect(isConnectFailure(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }))).toBe(false)
    expect(isConnectFailure(new TypeError('fetch failed', { cause: { code: 'UND_ERR_SOCKET' } }))).toBe(false)
    expect(isConnectFailure(new Error('socket hang up'))).toBe(false)
    expect(isConnectFailure(null)).toBe(false)
    expect(networkErrorCode(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }))).toBe('ECONNRESET')
  })
})

