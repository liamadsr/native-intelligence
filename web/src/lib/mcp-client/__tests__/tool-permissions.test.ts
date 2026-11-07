/**
 * Tool permissions (tool-permissions.ts): Claude's Always allow / Needs
 * approval / Blocked over a connected MCP server's own lists, per tool and
 * per group, agreeing with the approval policy the outward gate enforces.
 */
import { describe, it, expect } from 'vitest'
import { mcpToolRequiresApproval } from '../approval-policy'
import { isMcpToolHidden } from '../tool-access'
import {
  canAlwaysAllow,
  groupPermission,
  groupToolsByType,
  toolDisplayName,
  toolPermission,
  withToolPermission,
  type McpPermissionLists,
} from '../tool-permissions'

// A server we don't know: a read-shaped name is read-only, its own hints never count.
const CUSTOM = 'https://mcp.internal.example/mcp'
const get = { name: 'get_issue' }
const list = { name: 'list_projects' }
const create = { name: 'create_issue' }
const remove = { name: 'delete_issue' }
const TOOLS = [get, list, create, remove]

function server(over: Partial<McpPermissionLists> = {}): McpPermissionLists {
  return {
    server_url: CUSTOM,
    disabled_tools: [],
    allowed_tools: TOOLS.map((t) => t.name),
    // What a new URL connection starts with: its writes pinned to ask.
    require_approval_tools: ['create_issue', 'delete_issue'],
    approval_free_tools: [],
    ...over,
  }
}

describe('reading', () => {
  it('reads, writes and a switched-off tool', () => {
    const s = server({ disabled_tools: ['list_projects'] })
    expect(TOOLS.map((t) => toolPermission(t, s))).toEqual(['allow', 'blocked', 'ask', 'ask'])
  })

  it('a tool the server added since (not on the allow-list) is Blocked: the agent can’t see it', () => {
    const s = server({ allowed_tools: ['get_issue'] })
    expect(toolPermission(list, s)).toBe('blocked')
    expect(isMcpToolHidden(s, 'list_projects')).toBe(true)
  })

  it('groups read-only and write tools by the policy’s own test for this server', () => {
    expect(groupToolsByType(TOOLS, server())).toEqual({ readOnly: [get, list], write: [create, remove] })
    // A server we don't know never gets read-only from its own hint.
    const sneaky = { name: 'update_issue', annotations: { readOnlyHint: true } }
    expect(groupToolsByType([sneaky], server()).write).toEqual([sneaky])
  })

  it('a group reads its one shared permission, mixed when its tools differ, null when empty', () => {
    expect(groupPermission([get, list], server())).toBe('allow')
    expect(groupPermission([create, remove], server())).toBe('ask')
    expect(groupPermission([get, create], server())).toBe('mixed')
    expect(groupPermission([], server())).toBeNull()
  })
})

describe('writing', () => {
  it('Always allow on a write records the person’s approval-free choice; the policy then runs it', () => {
    const s = server()
    const next = { ...s, ...withToolPermission(s, [create], 'allow') }
    expect(next.approval_free_tools).toEqual(['create_issue'])
    expect(next.require_approval_tools).toEqual(['delete_issue'])
    expect(mcpToolRequiresApproval(create, next)).toBe(false)
    expect(toolPermission(create, next)).toBe('allow')
  })

  it('Needs approval on a read pins it to ask', () => {
    const s = server()
    const next = { ...s, ...withToolPermission(s, [get], 'ask') }
    expect(next.require_approval_tools).toContain('get_issue')
    expect(mcpToolRequiresApproval(get, next)).toBe(true)
  })

  it('Blocked hides it, and keeps a write pinned to ask so switching it back on never frees it', () => {
    const s = { ...server(), require_approval_tools: [], approval_free_tools: ['create_issue'] }
    const next = { ...s, ...withToolPermission(s, [create], 'blocked') }
    expect(isMcpToolHidden(next, 'create_issue')).toBe(true)
    expect(next.require_approval_tools).toContain('create_issue')
    expect(next.approval_free_tools).not.toContain('create_issue')
  })

  it('a permission on a new tool adds it to the allow-list (the person has now seen it)', () => {
    const s = server({ allowed_tools: ['get_issue'] })
    const next = withToolPermission(s, [list], 'allow')
    expect(next.allowed_tools).toEqual(['get_issue', 'list_projects'])
    expect(isMcpToolHidden({ ...s, ...next }, 'list_projects')).toBe(false)
  })

  it('a group set applies to every tool in it, in one set of lists', () => {
    const s = server()
    const next = { ...s, ...withToolPermission(s, [create, remove], 'blocked') }
    expect(next.disabled_tools).toEqual(['create_issue', 'delete_issue'])
    expect(groupPermission([create, remove], next)).toBe('blocked')
  })

  it('an allow-list not seeded yet stays null', () => {
    expect(withToolPermission(server({ allowed_tools: null }), [get], 'ask').allowed_tools).toBeNull()
  })
})

describe('a catalog app’s always-ask tools', () => {
  // Typefully: every tool that is not a plain read always asks (suggested.ts alwaysAskWrites).
  const TYPEFULLY = 'https://mcp.typefully.com/mcp'
  const publish = { name: 'create_draft' }
  const read = { name: 'list_drafts' }

  it('can’t be set to Always allow, alone or in a group', () => {
    const s = server({ server_url: TYPEFULLY, allowed_tools: ['create_draft', 'list_drafts'], require_approval_tools: [] })
    expect(canAlwaysAllow(publish, s)).toBe(false)
    expect(canAlwaysAllow(read, s)).toBe(true)
    const next = { ...s, ...withToolPermission(s, [publish, read], 'allow') }
    expect(next.approval_free_tools).not.toContain('create_draft')
    expect(toolPermission(publish, next)).toBe('ask')
  })
})

describe('toolDisplayName', () => {
  it('reads snake, kebab and camel names as a sentence, keeping acronyms', () => {
    expect(toolDisplayName({ name: 'get_draft_email' })).toBe('Get draft email')
    expect(toolDisplayName({ name: 'getJiraIssue' })).toBe('Get jira issue')
    expect(toolDisplayName({ name: 'search-code' })).toBe('Search code')
    expect(toolDisplayName({ name: 'fetch_URL' })).toBe('Fetch URL')
  })

  it('prefers the server’s own title', () => {
    expect(toolDisplayName({ name: 'gmail_get', annotations: { title: 'Get email message' } })).toBe('Get email message')
  })
})
