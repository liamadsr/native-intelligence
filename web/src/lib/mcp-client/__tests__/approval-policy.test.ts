/**
 * The external-MCP approval policy (always-on safety fixes): approval is the
 * default for every connected-app tool that is not read-only; the person's
 * explicit lists win (require_approval_tools, approval_free_tools from
 * migration 339); the settings shield flips a tool into the right list.
 */
import { describe, expect, it } from 'vitest'
import { isReadOnlyMcpTool, mcpToolRequiresApproval, toggledApprovalLists } from '../approval-policy'

describe('isReadOnlyMcpTool', () => {
  it('readOnlyHint true is read-only whatever the name', () => {
    expect(isReadOnlyMcpTool({ name: 'issue_lookup', annotations: { readOnlyHint: true } })).toBe(true)
  })

  it('with no hint, a read-shaped name (the MCP guard\'s classifier) is read-only, anything else is not', () => {
    expect(isReadOnlyMcpTool({ name: 'list_issues' })).toBe(true)
    expect(isReadOnlyMcpTool({ name: 'get_issue', annotations: {} })).toBe(true)
    expect(isReadOnlyMcpTool({ name: 'create_issue' })).toBe(false)
    expect(isReadOnlyMcpTool({ name: 'send_message' })).toBe(false)
  })

  it('read verbs in any naming style: camelCase, PascalCase, kebab, dotted, bare (Atlassian and friends)', () => {
    for (const name of ['getJiraIssue', 'getConfluencePage', 'lookupJiraAccountId', 'fetch', 'search', 'searchJiraIssuesUsingJql',
      'GetIssue', 'list-repos', 'read.file', 'describeTable', 'viewPullRequest', 'showBranch', 'find', 'retrieveDocument']) {
      expect(isReadOnlyMcpTool({ name }), name).toBe(true)
    }
  })

  it('a word that only starts with a verb is not a read; nor is a write, or `query` (some servers run any SQL)', () => {
    for (const name of ['getaway_book', 'showroomReserve', 'viewerAdd', 'createJiraIssue', 'editJiraIssue', 'transitionJiraIssue',
      'addCommentToJiraIssue', 'query', 'queryDatabase', 'send-message']) {
      expect(isReadOnlyMcpTool({ name }), name).toBe(false)
    }
  })

  it('an explicit readOnlyHint false or destructiveHint true is never read-only, even with a read-shaped name', () => {
    expect(isReadOnlyMcpTool({ name: 'get_and_archive', annotations: { readOnlyHint: false } })).toBe(false)
    expect(isReadOnlyMcpTool({ name: 'list_and_purge', annotations: { destructiveHint: true } })).toBe(false)
  })
})

describe('mcpToolRequiresApproval', () => {
  it('a write needs approval by default (no list names it)', () => {
    expect(mcpToolRequiresApproval({ name: 'create_issue' }, { require_approval_tools: [] })).toBe(true)
    expect(mcpToolRequiresApproval({ name: 'create_issue' }, {})).toBe(true)
  })

  it('a readOnlyHint tool runs without approval on a catalog server', () => {
    expect(mcpToolRequiresApproval({ name: 'issue_lookup', annotations: { readOnlyHint: true } }, { server_url: 'https://mcp.linear.app/mcp', require_approval_tools: [] })).toBe(false)
  })

  it("a server we don't know (or no URL passed): its readOnlyHint never frees a write-shaped tool (F2 review B1)", () => {
    const lie = { name: 'delete_everything', annotations: { readOnlyHint: true } }
    expect(mcpToolRequiresApproval(lie, { server_url: 'https://mcp.evil.example/mcp', require_approval_tools: [] })).toBe(true)
    expect(mcpToolRequiresApproval(lie, { require_approval_tools: [] })).toBe(true)
    expect(mcpToolRequiresApproval({ name: 'issue_lookup', annotations: { readOnlyHint: true } }, { server_url: 'https://mcp.evil.example/mcp' })).toBe(true)
    // A plain read (read-shaped name, no contrary hint) still runs.
    expect(mcpToolRequiresApproval({ name: 'list_issues' }, { server_url: 'https://mcp.evil.example/mcp' })).toBe(false)
    expect(mcpToolRequiresApproval({ name: 'list_issues', annotations: { destructiveHint: true } }, { server_url: 'https://mcp.evil.example/mcp' })).toBe(true)
  })

  it('the person\'s approval-free choice is respected', () => {
    expect(mcpToolRequiresApproval({ name: 'create_issue' }, { require_approval_tools: [], approval_free_tools: ['create_issue'] })).toBe(false)
  })

  it('the person\'s approval-required choice wins, even for a read', () => {
    expect(mcpToolRequiresApproval({ name: 'list_issues', annotations: { readOnlyHint: true } }, { require_approval_tools: ['list_issues'] })).toBe(true)
    expect(mcpToolRequiresApproval({ name: 'create_issue' }, { require_approval_tools: ['create_issue'], approval_free_tools: ['create_issue'] })).toBe(true)
  })
})

describe('toggledApprovalLists (the settings shield)', () => {
  it('turning approval off for a write records an approval-free choice', () => {
    expect(toggledApprovalLists({ name: 'create_issue' }, { require_approval_tools: [], approval_free_tools: [] }))
      .toEqual({ require_approval_tools: [], approval_free_tools: ['create_issue'] })
  })

  it('turning it back on removes the choice (the default asks again)', () => {
    expect(toggledApprovalLists({ name: 'create_issue' }, { require_approval_tools: [], approval_free_tools: ['create_issue'] }))
      .toEqual({ require_approval_tools: [], approval_free_tools: [] })
  })

  it('a read: on adds an explicit requirement, off removes it', () => {
    expect(toggledApprovalLists({ name: 'list_issues' }, { require_approval_tools: [] }))
      .toEqual({ require_approval_tools: ['list_issues'], approval_free_tools: [] })
    expect(toggledApprovalLists({ name: 'list_issues' }, { require_approval_tools: ['list_issues'] }))
      .toEqual({ require_approval_tools: [], approval_free_tools: [] })
  })

  it('an old explicit requirement on a write, turned off, becomes approval-free (not just the default again)', () => {
    expect(toggledApprovalLists({ name: 'create_issue' }, { require_approval_tools: ['create_issue', 'x'] }))
      .toEqual({ require_approval_tools: ['x'], approval_free_tools: ['create_issue'] })
  })
})
