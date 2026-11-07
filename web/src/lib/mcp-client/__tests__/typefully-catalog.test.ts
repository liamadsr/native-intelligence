/**
 * Typefully in the app catalog (content-skill-set.md §8, the C2a route):
 * Typefully's own MCP server, per-person OAuth. Its publish, schedule and
 * delete tools always ask, whatever the person or the agent set (decision 2,
 * "user always approves"); a draft with no publish time is P7's to free.
 */
import { describe, expect, it } from 'vitest'
import { SUGGESTED_MCP_SERVERS, suggestedMcpServerById, suggestedMcpServerFor } from '../suggested'
import { catalogAlwaysAsks, mcpToolRequiresApproval } from '../approval-policy'
import { asksByDefault, mcpToolState, withToolAccess } from '../tool-access'

const URL = 'https://mcp.typefully.com/mcp'

describe('Typefully', () => {
  it('is a streamable-HTTP catalog app at the endpoint the plan names', () => {
    const entry = suggestedMcpServerById('typefully')!
    expect(entry).toMatchObject({ display_name: 'Typefully', server_url: URL, transport: 'streamable_http' })
    expect(suggestedMcpServerFor('https://mcp.typefully.com/other')?.id).toBe('typefully')
    expect(SUGGESTED_MCP_SERVERS.filter((s) => s.id === 'typefully')).toHaveLength(1)
  })

  it('its publish, schedule and delete tools always ask, even when someone made them approval-free', () => {
    const lists = { server_url: URL, require_approval_tools: [], approval_free_tools: ['typefully_create_draft', 'publish_now', 'list_drafts'] }
    for (const name of ['typefully_create_draft', 'typefully_edit_draft', 'typefully_delete_draft', 'publish_now', 'schedule_post']) {
      expect(catalogAlwaysAsks(URL, name), name).toBe(true)
      expect(mcpToolRequiresApproval({ name, annotations: { readOnlyHint: true } }, lists), name).toBe(true)
    }
    // A read the person made approval-free stays theirs.
    expect(mcpToolRequiresApproval({ name: 'list_drafts', annotations: { readOnlyHint: true } }, lists)).toBe(false)
    // By shape, never by name or hint: any non-read asks, a read the server calls a write asks too.
    expect(catalogAlwaysAsks(URL, { name: 'post_thread', annotations: { readOnlyHint: true } })).toBe(true)
    expect(catalogAlwaysAsks(URL, { name: 'get_queue', annotations: { readOnlyHint: false } })).toBe(true)
    expect(catalogAlwaysAsks(URL, { name: 'get_queue' })).toBe(false)
    // Another host is not Typefully, whatever its tools are called.
    expect(catalogAlwaysAsks('https://evil.example/mcp', 'typefully_create_draft')).toBe(false)
  })

  it('an approval-free choice on one never frees it (the state stays ask)', () => {
    const tool = { name: 'typefully_create_draft' }
    const server = { server_url: URL, allowed_tools: ['typefully_create_draft'], disabled_tools: [], require_approval_tools: [], approval_free_tools: [] }
    expect(asksByDefault(tool, server)).toBe(true)
    const freed = withToolAccess(server, tool.name, 'read_only', true)
    expect(mcpToolState(tool, { ...server, ...freed })).toBe('ask')
  })
})
