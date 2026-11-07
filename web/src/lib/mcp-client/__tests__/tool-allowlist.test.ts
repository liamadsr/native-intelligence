/**
 * A connected app's tools are an allow-list (migration 396, tool-access.ts):
 * a tool the server adds after the person connected it stays invisible, to
 * the chat's adapter and the live agent's catalog alike, until they add it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../index', () => ({
  callTool: vi.fn(),
  callToolByServerId: vi.fn(),
  listTools: vi.fn(async () => {
    throw new Error('offline')
  }),
  McpTokenExpiredError: class extends Error {},
}))

import { isMcpToolHidden, newMcpTools, seedAllowedTools, visibleMcpTools } from '../tool-access'
import { createExternalMcpTools } from '../adapter'
import { buildLiveLookupCatalog } from '@/lib/live-agent/mcp-lookups'

const TOOLS = [
  { name: 'list_issues', annotations: { readOnlyHint: true } },
  { name: 'get_issue', annotations: { readOnlyHint: true } },
  { name: 'search_everything', annotations: { readOnlyHint: true } },
]

describe('tool-access allow-list', () => {
  it('no allow-list yet: nothing is new, switched-off tools stay hidden', () => {
    const server = { disabled_tools: ['get_issue'], allowed_tools: null }
    expect(visibleMcpTools(server, TOOLS).map((t) => t.name)).toEqual(['list_issues', 'search_everything'])
    expect(newMcpTools(server, TOOLS)).toEqual([])
  })

  it('a tool off the allow-list is new and hidden', () => {
    const server = { disabled_tools: [], allowed_tools: ['list_issues', 'get_issue'] }
    expect(isMcpToolHidden(server, 'search_everything')).toBe(true)
    expect(newMcpTools(server, TOOLS).map((t) => t.name)).toEqual(['search_everything'])
    expect(visibleMcpTools(server, TOOLS).map((t) => t.name)).toEqual(['list_issues', 'get_issue'])
  })

  it('seeds only when unseeded and the listing found tools; never widens a seeded list', () => {
    expect(seedAllowedTools(null, TOOLS)).toEqual(['list_issues', 'get_issue', 'search_everything'])
    expect(seedAllowedTools(undefined, [])).toBeNull()
    expect(seedAllowedTools(['list_issues'], TOOLS)).toEqual(['list_issues'])
    expect(seedAllowedTools([], TOOLS)).toEqual([])
  })
})

describe('readers honour the allow-list', () => {
  const server = {
    id: 'srv-1',
    user_id: 'u1',
    display_name: 'Linear',
    is_enabled: true,
    disabled_tools: [],
    require_approval_tools: [],
    allowed_tools: ['list_issues'],
    tools_cache: TOOLS.map((t) => ({ ...t, inputSchema: { type: 'object', properties: {} } })),
  }

  it("the chat's adapter builds no tool for a new one", async () => {
    const db = { from: () => ({ select: () => ({ eq: async () => ({ data: [server], error: null }) }) }) } as never
    const { tools, meta } = await createExternalMcpTools('u1', db)
    expect(Object.keys(tools)).toEqual(['mcp__linear__list_issues'])
    expect(meta.has('mcp__linear__search_everything')).toBe(false)
  })

  it("the live agent's lookups skip a new one", () => {
    const catalog = buildLiveLookupCatalog([server as never])
    expect(catalog.map((t) => t.toolName)).toEqual(['list_issues'])
  })
})

describe('migration 396', () => {
  const sql = readFileSync(join(process.cwd(), 'supabase/migrations/396_mcp_tool_allowlist.sql'), 'utf8')
  const body = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .toLowerCase()

  it('adds a nullable allow-list idempotently and backfills only non-empty caches still unseeded', () => {
    expect(sql.includes('\\')).toBe(false)
    expect(body).toContain('alter table public.connected_mcp_server add column if not exists allowed_tools text[];')
    expect(body).toContain('where s.allowed_tools is null')
    expect(body).toContain('jsonb_array_length(s.tools_cache) > 0')
    expect(body).not.toMatch(/not null default/)
  })
})
