import { describe, expect, it } from 'vitest'
import { bareToolName, currentMcpToolName, mcpToolName, toolNameInHints, withCurrentToolNames } from '../tool-names'

describe('MCP tool names', () => {
  it('lists a chat tool under the ni_ prefix', () => {
    expect(mcpToolName('read_email')).toBe('ni_read_email')
  })

  it('reads the bare name out of today’s prefix and the one before the rename', () => {
    expect(bareToolName('ni_read_email')).toBe('read_email')
    expect(bareToolName('dial8_read_email')).toBe('read_email')
    expect(bareToolName('read_email')).toBe('read_email')
    // Only a prefix: a name that merely contains one is left alone.
    expect(bareToolName('send_ni_report')).toBe('send_ni_report')
    expect(bareToolName('mini_tool')).toBe('mini_tool')
  })

  it('points an older name at the one listed now', () => {
    expect(currentMcpToolName('dial8_list_actions')).toBe('ni_list_actions')
    expect(currentMcpToolName('ni_list_actions')).toBe('ni_list_actions')
    expect(currentMcpToolName('list_actions')).toBe('list_actions')
  })
})

describe('withCurrentToolNames', () => {
  const call = (name: string, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { limit: 5 } } })

  it('renames an older tool in a tools/call, keeping everything else', () => {
    expect(withCurrentToolNames(call('dial8_list_actions'))).toEqual(call('ni_list_actions'))
  })

  it('returns a call that needs nothing as the same object', () => {
    const current = call('ni_list_actions')
    expect(withCurrentToolNames(current)).toBe(current)
    const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' }
    expect(withCurrentToolNames(list)).toBe(list)
  })

  it('handles a batch, message by message', () => {
    const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' }
    expect(withCurrentToolNames([call('dial8_find', 1), list, call('ni_show', 3)])).toEqual([call('ni_find', 1), list, call('ni_show', 3)])
  })

  it('leaves other methods and odd bodies alone, even when they carry an older name', () => {
    const resource = { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { name: 'dial8_x', uri: 'dial8://brief/workspace' } }
    expect(withCurrentToolNames(resource)).toBe(resource)
    for (const odd of [null, 'text', 7, { method: 'tools/call' }, { method: 'tools/call', params: { name: 9 } }]) expect(withCurrentToolNames(odd)).toBe(odd)
  })
})

describe('a hint about a tool, for a client whose list may be from before the rename', () => {
  it('names the tool as that client has it, too', () => {
    expect(toolNameInHints('call_tool')).toBe('ni_call_tool (dial8_call_tool on a tool list from before the rename)')
  })
})
