import { describe, expect, it } from 'vitest'
import { LOCAL_AGENT_MODEL_SLUG, allowedProviderOptions, prepareBody } from '../relay'

/**
 * The model relay's body check (relay.ts prepareBody): "network off" holds on
 * the server, so a local agent's call carries its own function tools and the
 * provider options its eve sends, and nothing that would have a provider
 * reach the network for it (security review 2026-10-31).
 */

const ctx = { userId: 'u1', sessionId: 's1' }

function forwarded(body: Record<string, unknown>): Record<string, unknown> {
  const prepared = prepareBody(JSON.stringify(body), ctx)
  if (!prepared.ok) throw new Error(`refused: ${prepared.reason}`)
  return JSON.parse(prepared.body) as Record<string, unknown>
}

describe('prepareBody: provider options', () => {
  it('keeps what the local agent sends: the Gateway caching and session, Anthropic metadata and reasoning', () => {
    const sent = forwarded({
      prompt: [],
      providerOptions: {
        gateway: { caching: 'auto', sessionId: 'sess', models: [LOCAL_AGENT_MODEL_SLUG], tags: ['mine'] },
        anthropic: { metadata: { userId: 'owner' }, thinking: { type: 'adaptive' }, effort: 'medium', cacheControl: { type: 'ephemeral' } },
      },
    })
    expect(sent.providerOptions).toEqual({
      gateway: { caching: 'auto', sessionId: 'sess', models: [LOCAL_AGENT_MODEL_SLUG], tags: ['local_agent', 'mine'], user: 'u1' },
      anthropic: { metadata: { userId: 'owner' }, thinking: { type: 'adaptive' }, effort: 'medium', cacheControl: { type: 'ephemeral' } },
    })
  })

  it("drops Anthropic's server-side MCP, hosted skills, model fallbacks and betas", () => {
    const sent = forwarded({
      prompt: [],
      providerOptions: {
        anthropic: {
          effort: 'low',
          mcpServers: [{ type: 'url', name: 'x', url: 'https://attacker.example/mcp' }],
          container: { skills: [{ type: 'anthropic', skillId: 'pptx' }] },
          fallbacks: [{ model: 'claude-opus-5.5' }],
          anthropicBeta: ['mcp-client-2025-04-04'],
          speed: 'fast',
        },
      },
    })
    expect(sent.providerOptions).toEqual({ anthropic: { effort: 'low' }, gateway: { user: 'u1', tags: ['local_agent'] } })
  })

  it('drops every other provider, and Gateway options the local agent never sends (routing, quota, BYOK)', () => {
    const sent = forwarded({
      prompt: [],
      providerOptions: {
        openai: { store: true, previousResponseId: 'r' },
        google: { useSearchGrounding: true },
        xai: { searchParameters: { mode: 'on' } },
        gateway: {
          caching: 'auto',
          byok: { anthropic: [{ apiKey: 'k' }] },
          only: ['bedrock'],
          order: ['vertex'],
          quotaEntityId: 'someone-else',
          serviceTier: 'priority',
          webSearch: true,
          user: 'someone-else',
        },
      },
    })
    expect(sent.providerOptions).toEqual({ gateway: { caching: 'auto', user: 'u1', tags: ['local_agent'] } })
  })

  it('tags the person even with no provider options at all', () => {
    expect(forwarded({ prompt: [] }).providerOptions).toEqual({ gateway: { user: 'u1', tags: ['local_agent'] } })
    expect(forwarded({ prompt: [], providerOptions: 'nope' }).providerOptions).toEqual({ gateway: { user: 'u1', tags: ['local_agent'] } })
  })

  it('still refuses a fallback model off the allowlist', () => {
    const prepared = prepareBody(JSON.stringify({ prompt: [], providerOptions: { gateway: { models: ['openai/gpt-6'] } } }), ctx)
    expect(prepared).toEqual({ ok: false, reason: 'model', model: 'openai/gpt-6' })
  })

  it('allowedProviderOptions reads defensively', () => {
    expect(allowedProviderOptions(null)).toEqual({})
    expect(allowedProviderOptions([])).toEqual({})
    expect(allowedProviderOptions({ gateway: 'x', anthropic: [] })).toEqual({})
    expect(allowedProviderOptions({ anthropic: { mcpServers: [] } })).toEqual({})
  })
})

describe('prepareBody: tools', () => {
  it('refuses a provider-run tool beside the function tools', () => {
    const prepared = prepareBody(
      JSON.stringify({
        prompt: [],
        tools: [
          { type: 'function', name: 'bash', inputSchema: {} },
          { type: 'provider', id: 'anthropic.web_search_20260209', name: 'web_search', args: {} },
        ],
      }),
      ctx,
    )
    expect(prepared).toEqual({ ok: false, reason: 'tool', tool: 'anthropic.web_search_20260209' })
  })

  it('passes function tools through unchanged', () => {
    const tools = [{ type: 'function', name: 'bash', inputSchema: {} }]
    expect(forwarded({ prompt: [], tools }).tools).toEqual(tools)
  })
})
