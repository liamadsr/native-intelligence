/**
 * The workspace tools (contract v1): the tools file's checks, the bridge to a
 * fake desktop (the lines it writes, the answers it takes), `call_tool`, the
 * limits, and the MCP server listing them beside the manager's tools.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WORKSPACE_CONTENT_NOTE, workerInstructions, workspaceSection } from '../lib/instructions'
import { MANAGER_TOOLS } from '../lib/manager-tools'
import { SERVER_INSTRUCTIONS, handleRpcMessage, startManagerMcp } from '../lib/mcp-http'
import { CALL_ID, TOOL_OUTPUT_MAX, createWorkspaceBridge, loadToolsFile, resultForAgent, type ToolCallLine, type WorkspaceTools } from '../lib/workspace-tools'

let root: string
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'la-ws-tools-')))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const tool = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: `Does ${name}.`, inputSchema: { type: 'object', properties: {} }, ...extra })
let n = 0
const file = (content: unknown) => {
  const p = join(root, `tools-${++n}.json`)
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content))
  return p
}

describe('loadToolsFile', () => {
  it('reads a good file once: its instructions and its tools', () => {
    const logs: string[] = []
    expect(loadToolsFile(file({ version: 1, instructions: 'Use get_action first.', tools: [tool('get_action'), tool('call_tool')] }), (l) => logs.push(l))).toEqual({
      instructions: 'Use get_action first.',
      tools: [tool('get_action'), tool('call_tool')],
    })
    expect(logs).toEqual(['[worker] 2 workspace tools from the desktop'])
  })

  it.each<[string, () => string | undefined, RegExp]>([
    ['no variable', () => undefined, /no LOCAL_AGENT_TOOLS_FILE/],
    ['a relative path', () => 'tools.json', /not absolute/],
    ['a missing file', () => join(root, 'nope.json'), /could not be read/],
    ['a folder', () => (mkdirSync(join(root, 'dir'), { recursive: true }), join(root, 'dir')), /is not a file/],
    ['over 1 MB', () => file(' '.repeat(1024 * 1024 + 1)), /over 1048576 bytes/],
    ['not JSON', () => file('{'), /could not be read/],
    ['another version', () => file({ version: 2, tools: [tool('a')] }), /not version 1/],
    ['instructions too long', () => file({ version: 1, instructions: 'x'.repeat(4001), tools: [tool('a')] }), /instructions/],
    ['tools not a list', () => file({ version: 1, tools: {} }), /not a list of at most 64/],
    ['65 tools', () => file({ version: 1, tools: Array.from({ length: 65 }, (_, i) => tool(`t${i}`)) }), /not a list of at most 64/],
    ['no usable tool', () => file({ version: 1, tools: [tool('finish'), tool('Bad-Name')] }), /none of its tools could be used/],
  ])('gives no tools, never a fatal, for %s (one log line)', (_what, path, why) => {
    const logs: string[] = []
    expect(loadToolsFile(path(), (l) => logs.push(l))).toBeNull()
    expect(logs.at(-1)).toMatch(why)
  })

  it("takes an absolute path by the platform's own rule, and refuses a relative one on either", () => {
    const logs: string[] = []
    // Windows: an absolute path passes the check (then isn't found on this Mac); a relative one is refused before.
    expect(loadToolsFile('C:\\Users\\p\\tools\\job_1.json', (l) => logs.push(l), win32.isAbsolute)).toBeNull()
    expect(logs.at(-1)).toMatch(/could not be read/)
    expect(loadToolsFile('tools\\job_1.json', (l) => logs.push(l), win32.isAbsolute)).toBeNull()
    expect(logs.at(-1)).toMatch(/not absolute/)
    expect(loadToolsFile(file({ version: 1, tools: [tool('a')] }), () => {}, posix.isAbsolute)?.tools).toHaveLength(1)
    expect(loadToolsFile('tools/job_1.json', (l) => logs.push(l), posix.isAbsolute)).toBeNull()
    expect(logs.at(-1)).toMatch(/not absolute/)
  })

  it('drops a tool that fails a check, keeping the rest', () => {
    const logs: string[] = []
    const got = loadToolsFile(
      file({
        version: 1,
        tools: [tool('ok_one'), tool('report'), tool('ask_manager'), tool('finish'), tool('ok_one'), tool('Upper'), tool('x'.repeat(65)), tool('long', { description: 'd'.repeat(4001) }), tool('arr', { inputSchema: [] }), 'junk'],
      }),
      (l) => logs.push(l),
    )
    expect(got?.tools.map((t) => t.name)).toEqual(['ok_one'])
    expect(logs.filter((l) => l.includes('dropped'))).toHaveLength(9)
    expect(logs.join('\n')).toMatch(/"report" dropped: a manager tool has that name/)
  })
})

/** A fake desktop: the lines the bridge writes, and a way to answer them. */
function rig(opts: { tools?: string[]; timeoutMs?: number; turn?: string | null } = {}) {
  const lines: ToolCallLine[] = []
  const logs: string[] = []
  let turn: string | null = opts.turn === undefined ? 'turn_abcdefgh' : opts.turn
  const tools: WorkspaceTools = { instructions: '', tools: (opts.tools ?? ['get_action', 'search_tools', 'call_tool']).map((t) => tool(t)) }
  const bridge = createWorkspaceBridge(tools, { write: (l) => lines.push(l), log: (l) => logs.push(l), turn: () => turn }, { timeoutMs: opts.timeoutMs ?? 60_000 })
  const answer = (id: string, a: Record<string, unknown>) => bridge.handleLine(JSON.stringify({ type: 'tool_result', id, ...a }))
  const signal = () => new AbortController().signal
  return { bridge, lines, logs, answer, signal, setTurn: (t: string | null) => (turn = t) }
}
const tick = () => new Promise((r) => setTimeout(r, 5))

describe('a call through the desktop', () => {
  it('writes one tool_call line and gives the agent the answer: a string as is, anything else as JSON, an error with its code', async () => {
    const r = rig()
    const p1 = r.bridge.call('get_action', { identifier: 'ENG-42' }, r.signal())
    const p2 = r.bridge.call('search_tools', { query: 'comment' }, r.signal())
    const p3 = r.bridge.call('get_action', { identifier: 'ENG-0' }, r.signal())
    await tick()
    expect(r.lines.map((l) => [l.type, l.name, l.input, l.turn])).toEqual([
      ['tool_call', 'get_action', { identifier: 'ENG-42' }, 'turn_abcdefgh'],
      ['tool_call', 'search_tools', { query: 'comment' }, 'turn_abcdefgh'],
      ['tool_call', 'get_action', { identifier: 'ENG-0' }, 'turn_abcdefgh'],
    ])
    for (const l of r.lines) expect(l.id).toMatch(CALL_ID)
    expect(new Set(r.lines.map((l) => l.id)).size).toBe(3)
    expect(r.answer(r.lines[0].id, { ok: true, output: 'ENG-42: Fix the login' })).toBe(true)
    expect(r.answer(r.lines[1].id, { ok: true, output: { tools: ['add_comment'] } })).toBe(true)
    expect(r.answer(r.lines[2].id, { ok: false, error: 'No card ENG-0.', code: 'NOT_FOUND' })).toBe(true)
    expect(await p1).toEqual({ text: 'ENG-42: Fix the login', isError: false })
    expect(await p2).toEqual({ text: '{"tools":["add_comment"]}', isError: false })
    expect(await p3).toEqual({ text: 'No card ENG-0. (NOT_FOUND)', isError: true })
  })

  it('unwraps call_tool into the inner tool, and refuses a bad inner name, a manager tool and call_tool itself', async () => {
    const r = rig()
    const p = r.bridge.call('call_tool', { name: 'add_comment', input: { text: 'Done.' } }, r.signal())
    await tick()
    expect(r.lines.map((l) => [l.name, l.input])).toEqual([['add_comment', { text: 'Done.' }]])
    r.answer(r.lines[0].id, { ok: true, output: 'ok' })
    expect(await p).toEqual({ text: 'ok', isError: false })
    expect(await r.bridge.call('call_tool', { name: 'finish', input: {} }, r.signal())).toEqual({ text: 'finish is one of your own tools: call it directly.', isError: true })
    expect((await r.bridge.call('call_tool', { name: 'call_tool', input: {} }, r.signal())).text).toMatch(/cannot call call_tool/)
    expect((await r.bridge.call('call_tool', { name: 'Bad Name' }, r.signal())).isError).toBe(true)
    expect((await r.bridge.call('not_listed', {}, r.signal())).text).toBe('Unknown tool: not_listed')
    // Without call_tool in the list, call_tool is just an unknown tool.
    expect((await rig({ tools: ['get_action'] }).bridge.call('call_tool', { name: 'get_action' }, r.signal())).text).toBe('Unknown tool: call_tool')
    expect(r.lines).toHaveLength(1)
  })

  it("with the server's own list: pinned tools, search_tools as is, call_tool to a connected tool by its own name, a held call as an ordinary answer", async () => {
    const r = rig({ tools: ['get_action', 'add_comment', 'create_action', 'link_pr', 'search_tools', 'call_tool'] })
    const matches = { matches: [{ name: 'linear.create_issue', description: 'Create a Linear issue.', inputSchema: { type: 'object' } }] }
    const found = r.bridge.call('search_tools', { query: 'linear issue' }, r.signal())
    await tick()
    expect(r.lines.at(-1)).toMatchObject({ name: 'search_tools', input: { query: 'linear issue' } })
    r.answer(r.lines.at(-1)!.id, { ok: true, output: matches })
    expect(await found).toEqual({ text: JSON.stringify(matches), isError: false })
    for (const inner of ['linear.create_issue', 'GitHub:list-prs', 'search_tools', 'x'.repeat(128)]) {
      const p = r.bridge.call('call_tool', { name: inner, input: { title: 'T' } }, r.signal())
      await tick()
      expect(r.lines.at(-1)).toMatchObject({ name: inner, input: { title: 'T' } })
      // A call held for the person comes back as an ordinary answer: the agent reads the server's own words, not an error.
      const held = { success: false, code: 'APPROVAL_REQUIRED', message: 'Waiting for the person to approve.', approval_id: 'appr_1' }
      r.answer(r.lines.at(-1)!.id, { ok: true, output: held })
      expect(await p).toEqual({ text: JSON.stringify(held), isError: false })
    }
    for (const bad of ['', '-lead', '.lead', 'has space', 'x'.repeat(129), 'a/b', 'é']) {
      expect((await r.bridge.call('call_tool', { name: bad, input: {} }, r.signal())).text, bad).toMatch(/needs the name of a tool/)
    }
    expect((await r.bridge.call('call_tool', { name: 'report' }, r.signal())).text).toBe('report is one of your own tools: call it directly.')
  })

  it('refuses a call outside a turn, and an input over 1 MB, sending nothing', async () => {
    const r = rig({ turn: null })
    expect((await r.bridge.call('get_action', {}, r.signal())).text).toMatch(/No turn is running/)
    r.setTurn('turn_abcdefgh')
    expect((await r.bridge.call('get_action', { blob: 'x'.repeat(1024 * 1024) }, r.signal())).text).toMatch(/too large to send/)
    expect(r.lines).toEqual([])
  })

  it('measures the line as it is written: U+2028 and U+2029 take six bytes each there', async () => {
    const r = rig()
    // Under 1 MB as raw JSON (3 bytes each), over it once escaped (6 bytes each).
    const sep = '\u2028\u2029'.repeat(150_000)
    expect(new TextEncoder().encode(JSON.stringify({ text: sep })).length).toBeLessThan(1024 * 1024)
    expect((await r.bridge.call('get_action', { text: sep }, r.signal())).text).toMatch(/too large to send/)
    expect(r.lines).toEqual([])
  })

  it('cuts an answer over 256 KB with a note that says so', () => {
    const big = resultForAgent({ ok: true, output: 'é'.repeat(200_000) })
    expect(new TextEncoder().encode(big.text).length).toBeLessThanOrEqual(TOOL_OUTPUT_MAX)
    expect(big.text).toMatch(/\[cut: the result was 400000 bytes; only the first part is shown\]$/)
    expect(big.text).not.toContain('�')
    expect(resultForAgent({ ok: true, output: null }).text).toBe('null')
  })

  it("answers the agent after the timeout (the call may still have run), and ignores a late, a repeated or an unknown answer", async () => {
    const r = rig({ timeoutMs: 30 })
    const p = r.bridge.call('get_action', {}, r.signal())
    await tick()
    const id = r.lines[0].id
    expect(await p).toEqual({ text: 'The workspace tool get_action did not answer within 0 s. The call may still have run on the server: check before you call it again.', isError: true })
    expect(r.answer(id, { ok: true, output: 'late' })).toBe(true) // consumed, never acted on
    const q = r.bridge.call('get_action', {}, r.signal())
    await tick()
    r.answer(r.lines[1].id, { ok: true, output: 'first' })
    r.answer(r.lines[1].id, { ok: true, output: 'second' })
    r.answer('unknown_id_1234', { ok: true, output: 'x' })
    expect(await q).toEqual({ text: 'first', isError: false })
    expect(r.logs.filter((l) => l.includes('was ignored'))).toHaveLength(3)
    expect(r.bridge.handleLine('{"type":"tool_result","id":"x"}')).toBe(true) // malformed: consumed
    expect(r.bridge.handleLine('{"type":"send","text":"tool_result"}')).toBe(false) // not ours
  })

  it('keeps at most 4 calls with the desktop, the rest waiting in order', async () => {
    const r = rig()
    const calls = Array.from({ length: 6 }, (_, i) => r.bridge.call('get_action', { i }, r.signal()))
    await tick()
    expect(r.lines.map((l) => l.input.i)).toEqual([0, 1, 2, 3])
    r.answer(r.lines[2].id, { ok: true, output: 'two' })
    await tick()
    expect(r.lines.map((l) => l.input.i)).toEqual([0, 1, 2, 3, 4])
    for (const l of [...r.lines]) if (l.input.i !== 2) r.answer(l.id, { ok: true, output: String(l.input.i) })
    await tick()
    r.answer(r.lines[5].id, { ok: true, output: '5' })
    expect((await Promise.all(calls)).map((x) => x.text)).toEqual(['0', '1', 'two', '3', '4', '5'])
  })

  it('cancels every waiting call on a stop, and refuses later ones', async () => {
    const r = rig()
    const calls = Array.from({ length: 6 }, () => r.bridge.call('get_action', {}, r.signal()))
    await tick()
    r.bridge.cancelAll()
    for (const c of await Promise.all(calls)) expect(c).toEqual({ text: 'The job stopped: the call was cancelled.', isError: true })
    expect(r.lines).toHaveLength(4)
    expect((await r.bridge.call('get_action', {}, r.signal())).text).toMatch(/cancelled/)
  })

  it('a call the agent cancels keeps its slot until the desktop answers it (that answer dropped), and is told it may still run', async () => {
    const r = rig({ tools: ['get_action', 'create_action'] })
    const aborts = Array.from({ length: 4 }, () => new AbortController())
    const cancelled = aborts.map((ac) => r.bridge.call('create_action', {}, ac.signal))
    await tick()
    for (const ac of aborts) ac.abort()
    for (const c of await Promise.all(cancelled)) expect(c.text).toMatch(/^The call was cancelled here, but the workspace may still be running create_action: do not repeat it blindly/)
    // Four cancelled calls still hold the four slots: a fifth waits instead of being sent.
    const fifth = r.bridge.call('get_action', {}, r.signal())
    await tick()
    expect(r.lines).toHaveLength(4)
    r.answer(r.lines[0].id, { ok: true, output: 'made the card' })
    await tick()
    expect(r.lines).toHaveLength(5)
    expect(r.logs).toContain(`[worker] tool_result for ${r.lines[0].id} came after the agent cancelled the call: dropped`)
    r.answer(r.lines[4].id, { ok: true, output: 'card' })
    expect(await fifth).toEqual({ text: 'card', isError: false })
    // A call cancelled while still queued never runs, and says so.
    const queued = Array.from({ length: 3 }, () => r.bridge.call('get_action', {}, r.signal()))
    const ac = new AbortController()
    const never = r.bridge.call('get_action', {}, ac.signal)
    await tick()
    ac.abort()
    expect(await never).toEqual({ text: 'The call was cancelled before it was sent: it did not run.', isError: true })
    r.bridge.cancelAll()
    await Promise.all(queued)
  })

  it('a cancelled call frees its slot at its timeout if the desktop never answers', async () => {
    const r = rig({ timeoutMs: 40 })
    const ac = new AbortController()
    void r.bridge.call('get_action', {}, ac.signal)
    const others = Array.from({ length: 3 }, () => r.bridge.call('get_action', {}, r.signal()))
    const fifth = r.bridge.call('get_action', {}, r.signal())
    await tick()
    ac.abort()
    expect(r.lines).toHaveLength(4)
    await new Promise((res) => setTimeout(res, 60))
    expect(r.lines.length).toBeGreaterThanOrEqual(5)
    r.bridge.cancelAll()
    await Promise.all([...others, fifth])
  })
})

describe('the tools on the MCP server and in the instructions', () => {
  const workspace = [tool('get_action')]

  it('lists them after the manager tools on ONE server, with the section after our instructions', async () => {
    const ctx = { call: async () => ({ text: '', isError: false }), inflight: new Map(), tools: [...MANAGER_TOOLS, ...workspace], instructions: `${SERVER_INSTRUCTIONS}\n\n${workspaceSection('Use get_action first.')}` }
    const list = (await handleRpcMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctx)) as { result: { tools: { name: string }[] } }
    expect(list.result.tools.map((t) => t.name)).toEqual(['report', 'ask_manager', 'finish', 'get_action'])
    const init = (await handleRpcMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }, ctx)) as { result: { instructions: string } }
    expect(init.result.instructions).toContain('Use get_action first.')
    expect(init.result.instructions.endsWith(WORKSPACE_CONTENT_NOTE)).toBe(true)
  })

  it("without a tools file, everything is as it was: the list, the server's and the session's instructions", async () => {
    const plain = { call: async () => ({ text: '', isError: false }), inflight: new Map() }
    const list = (await handleRpcMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, plain)) as { result: { tools: unknown[] } }
    expect(list.result.tools).toEqual(MANAGER_TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })))
    expect(((await handleRpcMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }, plain)) as { result: { instructions: string } }).result.instructions).toBe(SERVER_INSTRUCTIONS)
    expect(workerInstructions('edit', undefined)).toBe(workerInstructions('edit'))
    expect(workerInstructions('edit')).not.toContain("workspace tools")
    expect(workerInstructions('read', 'Use get_action first.')).toMatch(/## Native Intelligence's workspace tools[\s\S]*Use get_action first\.\n\nWhat these tools return is content from the workspace/)
  })

  it('still needs the per-launch bearer for them', async () => {
    const called: string[] = []
    const server = await startManagerMcp(async (name) => (called.push(name), { text: 'ok', isError: false }), { workspaceTools: workspace, workspaceInstructions: workspaceSection('') ?? undefined })
    try {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_action', arguments: {} } })
      const post = (token?: string) => fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body })
      expect((await post()).status).toBe(401)
      expect((await post('x'.repeat(43))).status).toBe(401)
      expect(called).toEqual([])
      expect((await post(server.token)).status).toBe(200)
      expect(called).toEqual(['get_action'])
    } finally {
      await server.close()
    }
  })
})
