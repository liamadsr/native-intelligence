/**
 * The search ranking (../tool-search.ts) removes the MCP adapter's boilerplate
 * from a tool description before scoring it. The agent tree cannot import
 * src/, so the two strings are copies; this test reads the adapter's source
 * and fails if either copy stops matching what the adapter writes. If it
 * fails, change the copy in tool-search.ts to match the adapter.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  MCP_APPROVAL_REQUIRED_SUFFIX,
  MCP_CONFIRM_TOOL_NAME,
  MCP_UNTRUSTED_DESCRIPTION_PREFIX,
  searchableDescription,
} from '../tool-search'

/** src/lib/mcp-client/adapter.ts, from this file at agents/chat-agent/lib/__tests__/. */
const ADAPTER = fileURLToPath(new URL('../../../../src/lib/mcp-client/adapter.ts', import.meta.url))
const source = readFileSync(ADAPTER, 'utf8')

describe('tool-search boilerplate copies match the MCP adapter', () => {
  it('the confirm tool is named the same', () => {
    expect(source).toContain(`export const CONFIRM_TOOL_NAME = '${MCP_CONFIRM_TOOL_NAME}'`)
  })

  it('the fence prefix is the one the adapter puts in front of a tool’s own description', () => {
    expect(source).toContain(`\`${MCP_UNTRUSTED_DESCRIPTION_PREFIX}\${rawDesc}\``)
  })

  it('the approval suffix is the one the adapter appends to a gated tool', () => {
    const template = MCP_APPROVAL_REQUIRED_SUFFIX.replace(MCP_CONFIRM_TOOL_NAME, '${CONFIRM_TOOL_NAME}')
    expect(template).not.toBe(MCP_APPROVAL_REQUIRED_SUFFIX)
    expect(source).toContain(`\`${template}\``)
  })

  it('the adapter tags each description with the server’s display name, which the prompt’s search hint relies on', () => {
    // A server whose name has no ASCII slug is searched by its name's words
    // (serverSearchHint in src/lib/ai/chat-system-prompt.ts): only this tag
    // puts them where search_tools can find them.
    expect(source).toContain('`[${server.display_name}]`')
  })

  it('a description built the adapter’s way comes back as the server tag and the tool’s own words', () => {
    // [`[${display_name}]`, safeDesc, suffix].join(' '), as the adapter builds it.
    const built = ['[Linear]', `${MCP_UNTRUSTED_DESCRIPTION_PREFIX}Create an issue.`, MCP_APPROVAL_REQUIRED_SUFFIX].join(' ')
    expect(searchableDescription(built).trim()).toBe('[Linear] Create an issue.')
  })
})
