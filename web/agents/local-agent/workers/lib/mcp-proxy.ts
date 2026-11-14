/**
 * The stdio MCP server an agent gets when it can't take an HTTP one (stdio is
 * the only MCP transport ACP requires of every agent): `acp.mjs --mcp-proxy`,
 * started by the agent as its child, so inside the agent's fence. It holds no
 * Native Intelligence credential and does nothing itself: each JSON-RPC line
 * on stdin is POSTed to the adapter's MCP server on 127.0.0.1 (mcp-http.ts)
 * with the per-launch bearer, and the answer goes back as a line on stdout.
 *
 *   NI_MCP_PORT   the adapter's MCP port (the only local port the fence opens)
 *   NI_MCP_TOKEN  its bearer
 */
import { MCP_PATH } from './mcp-http.js'
import { createLineSplitter } from './protocol.js'

/** The longest stdin line forwarded (the server reads at most 1 MB). */
const MAX_LINE = 1024 * 1024

export async function runMcpProxy(env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  const port = Number(env.NI_MCP_PORT)
  const token = env.NI_MCP_TOKEN
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) {
    process.stderr.write('mcp proxy: NI_MCP_PORT and NI_MCP_TOKEN are required\n')
    process.exit(2)
  }
  const url = `http://127.0.0.1:${port}${MCP_PATH}`
  const write = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`)
  let inflight = 0
  let ended = false
  const done = () => {
    if (ended && inflight === 0) process.exit(0)
  }

  const forward = async (line: string) => {
    let id: unknown = null
    try {
      id = (JSON.parse(line) as { id?: unknown }).id ?? null
    } catch {
      return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` },
        body: line,
      })
      const body = await res.text()
      if (res.status === 202 || !body) return // a notification
      const parsed: unknown = JSON.parse(body)
      for (const m of Array.isArray(parsed) ? parsed : [parsed]) write(m)
    } catch (err) {
      if (id !== null) write({ jsonrpc: '2.0', id, error: { code: -32603, message: `Native Intelligence is not reachable: ${err instanceof Error ? err.message : String(err)}` } })
    }
  }

  const lines = createLineSplitter(
    (line) => {
      if (!line.trim()) return
      inflight += 1
      void forward(line).finally(() => {
        inflight -= 1
        done()
      })
    },
    { maxBytes: MAX_LINE, onTooLong: () => write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `a message over ${MAX_LINE} bytes was dropped` } }) },
  )
  process.stdin.on('data', (chunk: Buffer) => lines.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)))
  process.stdin.on('end', () => {
    lines.end()
    ended = true
    done()
  })
}
