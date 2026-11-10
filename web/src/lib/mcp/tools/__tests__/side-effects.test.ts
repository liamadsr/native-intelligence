/**
 * Every tool the MCP server registers has a side-effect class (Sequence step 2,
 * plan A.2): bridged registry tools carry theirs in the registry; the
 * hand-registered ones are in MCP_TOOL_SIDE_EFFECTS. The guard's read/write
 * decision reads that classification first and falls back to its name regex
 * only for a tool neither knows.
 */
import { describe, it, expect } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { registerTools } from '../index'
import { MCP_TOOL_SIDE_EFFECTS, resolveMcpToolSideEffect } from '../../tool-side-effects'
import { classifyToolAccess } from '../../guard'
import { getToolSideEffect } from '@/lib/ai/tool-registry'

function chainableStub(): unknown {
  const stub: unknown = new Proxy(function () {}, {
    get: (_target, prop) => (prop === 'then' ? undefined : stub),
    apply: () => stub,
  })
  return stub
}

async function registeredNames(): Promise<string[]> {
  const server = new McpServer({ name: 'ni-test', version: '0.0.0' })
  await registerTools(server, 'user-1', chainableStub() as SupabaseClient, 'ws-1', 'Test Workspace')
  return Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools)
}

describe('MCP tool side-effect classes', () => {
  it('every registered tool resolves to a class — registry or the MCP-only map', async () => {
    const names = await registeredNames()
    expect(names.length).toBeGreaterThan(100)
    const unclassified = names.filter((n) => resolveMcpToolSideEffect(n) === undefined)
    expect(unclassified).toEqual([])
  })

  it('the MCP-only map covers only tools that are NOT registry tools (no shadowing)', () => {
    const shadowed = Object.keys(MCP_TOOL_SIDE_EFFECTS).filter((n) => getToolSideEffect(n) !== undefined)
    expect(shadowed).toEqual([])
  })

  it('the guard classifies by class first: reads read, everything else writes', () => {
    expect(classifyToolAccess('ni_get_pr_status')).toBe('read')
    expect(classifyToolAccess('ni_list_workspaces')).toBe('read')
    expect(classifyToolAccess('ni_link_pr')).toBe('write')
    expect(classifyToolAccess('ni_delete_agent')).toBe('write')
    expect(classifyToolAccess('ni_create_agent')).toBe('write')
    // Registry classes win over a read-shaped name and vice versa.
    expect(classifyToolAccess('ni_list_actions')).toBe('read')
    expect(classifyToolAccess('ni_create_action')).toBe('write')
    // Navigation and the dispatcher stay allowed under a read-only token.
    expect(classifyToolAccess('ni_set_workspace')).toBe('read')
    expect(classifyToolAccess('ni_call_tool')).toBe('read')
    // The main agent's bot-work reads (bots-v4 A1) stay reads under a read-only token.
    expect(classifyToolAccess('ni_list_bot_work')).toBe('read')
    expect(classifyToolAccess('ni_get_bot_item')).toBe('read')
    // Their writes on that work (bots-v4 A2) are writes: a read-only token can't reach them.
    expect(classifyToolAccess('ni_settle_work_item')).toBe('write')
    expect(classifyToolAccess('ni_send_work_answer')).toBe('write')
    // Unknown names still fail closed.
    expect(classifyToolAccess('ni_frobnicate')).toBe('write')
    expect(classifyToolAccess('ni_get_frobnicate')).toBe('read')
  })
})
