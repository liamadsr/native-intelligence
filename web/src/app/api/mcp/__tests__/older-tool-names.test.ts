/**
 * POST /api/mcp, the whole way through the transport: a client that fetched
 * its tool list before the rename still calls `dial8_*`, and the call reaches
 * the tool this server lists as `ni_*` (src/lib/mcp/tool-names.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

const echoed = vi.hoisted(() => ({ calls: [] as string[] }))

vi.mock('@/lib/mcp/auth', () => ({
  authenticateMcpRequest: async () => ({ userId: 'user-1', workspaceId: 'ws-1', supabase: {}, scopes: [], tokenId: null }),
  hashToken: (token: string) => `hash:${token}`,
  setActiveWorkspace: async () => {},
}))
vi.mock('@/lib/mcp/server', () => ({
  createMcpServer: async () => {
    const server = new McpServer({ name: 'native-intelligence', version: 'test' })
    server.tool('ni_echo', 'Says it back.', { text: z.string() }, async ({ text }) => {
      echoed.calls.push(text)
      return { content: [{ type: 'text' as const, text }] }
    })
    return server
  },
}))

const { POST } = await import('../route')

const rpc = (body: unknown) =>
  new Request('https://app.test/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer token' },
    body: JSON.stringify(body),
  })
const call = (name: string, text: string, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { text } } })

beforeEach(() => {
  echoed.calls = []
})

describe('POST /api/mcp with a tool name from before the rename', () => {
  it('runs the same tool under either prefix', async () => {
    for (const name of ['ni_echo', 'dial8_echo']) {
      const res = await POST(rpc(call(name, `via ${name}`)))
      expect(res.status, name).toBe(200)
      expect(await res.json(), name).toMatchObject({ id: 1, result: { content: [{ type: 'text', text: `via ${name}` }] } })
    }
    expect(echoed.calls).toEqual(['via ni_echo', 'via dial8_echo'])
  })

  it('lists tools under the current prefix only, and still refuses a name it never had', async () => {
    const listed = await (await POST(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))).json()
    expect(listed.result.tools.map((t: { name: string }) => t.name)).toEqual(['ni_echo'])
    const unknown = await (await POST(rpc(call('dial8_nothing', 'x', 3)))).json()
    expect(JSON.stringify(unknown)).toMatch(/not found|unknown tool/i)
    expect(echoed.calls).toEqual([])
  })
})
