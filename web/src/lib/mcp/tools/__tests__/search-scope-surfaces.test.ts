/**
 * The search scope options the agent sets per call (all_time,
 * include_transcripts, since / until, attachments through types) reach every
 * surface that bridges the search tools' zod schemas: the MCP connector
 * (dial8_find / dial8_deep_search) and the live meeting agent's read tools.
 * So the capability the "My captures" picker gave the person is the agent's
 * on each of them. Neither is the main chat, so both keep the all-time default
 * (the past-4-weeks default is the main chat's alone).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Tool } from 'ai'
const seen = vi.hoisted(() => ({ defaults: [] as unknown[] }))
vi.mock('@/lib/ai/tools/search', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/tools/search')>()
  return {
    ...actual,
    createSearchTools: (...args: Parameters<typeof actual.createSearchTools>) => {
      seen.defaults.push(args[4])
      return actual.createSearchTools(...args)
    },
  }
})

import { registerTools } from '../index'
import { buildLiveAgentReadTools } from '@/lib/live-agent/read-tools'

function chainableStub(): unknown {
  const stub: unknown = new Proxy(function () {}, {
    get: (_target, prop) => (prop === 'then' ? undefined : stub),
    apply: () => stub,
  })
  return stub
}
const fakeSupabase = chainableStub() as SupabaseClient

type Parseable = { shape?: Record<string, unknown>; parse: (v: unknown) => Record<string, unknown> }

function expectScopeOptions(schema: Parseable | undefined, tool: 'find' | 'deep_search') {
  expect(schema, tool).toBeDefined()
  const keys = Object.keys(schema!.shape ?? {})
  for (const key of ['since', 'until', 'all_time', 'types']) expect(keys, `${tool}.${key}`).toContain(key)
  if (tool === 'deep_search') expect(keys).toContain('include_transcripts')
  // Defaults: no widening named. Transcripts are left to the toolset (on
  // outside the main chat, as before: search.scope.test.ts).
  const parsed = schema!.parse({ query: 'q' })
  expect(parsed.all_time).toBe(false)
  if (tool === 'deep_search') expect(parsed.include_transcripts).toBeUndefined()
  // Every widening parses.
  const wide = schema!.parse({
    query: 'q',
    all_time: true,
    since: 'past_90_days',
    types: tool === 'find' ? ['claim', 'capture', 'attachment'] : ['captures', 'attachments', 'claims'],
    ...(tool === 'deep_search' ? { include_transcripts: true } : {}),
  })
  expect(wide.all_time).toBe(true)
}

beforeEach(() => {
  seen.defaults = []
})

describe('the MCP connector bridges the scope options', () => {
  it('dial8_find and dial8_deep_search take since / until / all_time / types (and include_transcripts)', async () => {
    const server = new McpServer({ name: 'dial8-test', version: '0.0.0' })
    await registerTools(server, 'user-1', fakeSupabase, 'ws-1', 'Test Workspace')
    const tools = (server as unknown as { _registeredTools: Record<string, { inputSchema?: Parseable }> })._registeredTools
    expectScopeOptions(tools['dial8_find']?.inputSchema, 'find')
    expectScopeOptions(tools['dial8_deep_search']?.inputSchema, 'deep_search')
  })

  it('searches all time by default, as before', async () => {
    const server = new McpServer({ name: 'dial8-test', version: '0.0.0' })
    await registerTools(server, 'user-1', fakeSupabase, 'ws-1', 'Test Workspace')
    expect(seen.defaults.length).toBeGreaterThan(0)
    for (const d of seen.defaults) expect(d).toBe('all_time')
  })
})

describe('the live meeting agent keeps them', () => {
  it('its read tools include find and deep_search with the same options', () => {
    const read = buildLiveAgentReadTools('u', fakeSupabase, 'w') as Record<string, Tool>
    expectScopeOptions(read.find?.inputSchema as unknown as Parseable, 'find')
    expectScopeOptions(read.deep_search?.inputSchema as unknown as Parseable, 'deep_search')
  })

  it('searches all time by default, as before', () => {
    buildLiveAgentReadTools('u', fakeSupabase, 'w')
    expect(seen.defaults).toEqual(['all_time'])
  })
})
