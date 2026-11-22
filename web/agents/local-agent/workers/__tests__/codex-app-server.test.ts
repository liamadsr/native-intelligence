/**
 * The `codex-app-server` link against a stand-in Codex CLI
 * (fixtures/fake-codex.mjs, the app-server shapes of Codex 0.169.0) run as a
 * real process, with the real manager tools' MCP server.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { AuthRequiredError, SentenceError } from '../lib/agent-link'
import { codexAppServerLink, threadParams, toolOf } from '../lib/codex-app-server'
import { linkHarness } from './fixtures/links'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

/**
 * The stand-in Codex is its own process and logs each message as it reads it.
 * `initialized` is a notification the link sends without waiting for an answer,
 * so `initialize()` can resolve before the other process has logged it: wait
 * for the log to catch up rather than read it at once (it lost that race on a
 * loaded machine).
 */
async function until(test: () => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (!test()) {
    if (Date.now() > end) throw new Error('timed out waiting for the stand-in Codex')
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function setup(opts: Record<string, unknown> = {}) {
  const h = await linkHarness('fake-codex.mjs', opts)
  cleanups.push(h.close)
  const link = codexAppServerLink(h.launchers, h.events, { label: 'Codex', setupTimeoutMs: 5000 })
  return { ...h, link }
}

describe('codex-app-server', () => {
  it('starts `codex app-server`, initializes, and reads the version from its user agent', async () => {
    const t = await setup()
    expect(await t.link.initialize()).toEqual({ version: '9.9.9' })
    await until(() => t.requests().length >= 2)
    const log = t.requests()
    expect(log.map((r) => r.method)).toEqual(['initialize', 'initialized'])
    expect(log[0].params).toEqual({ clientInfo: { name: 'native-intelligence', title: 'Native Intelligence', version: '1' }, capabilities: null })
    expect(log.some((r) => r.unexpected)).toBe(false) // no "jsonrpc" member sent
  })

  it("says to update a Codex that has no app-server, with its version and what it said", async () => {
    const t = await setup({ old: true })
    const err = await t.link.initialize().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SentenceError)
    expect((err as Error).message).toBe(
      'Codex 9.9.9 on this Mac has no app server (Error: Device not configured (os error 6)), which this app needs: update Codex on this Mac (for example `npm install -g @openai/codex@latest`), then try again.',
    )
  })

  it('says what a Codex that has an app-server wrote when it fails to start, without asking for an update', async () => {
    const t = await setup({ crash: true })
    await expect(t.link.initialize()).rejects.toThrow(/^Codex 9\.9\.9 on this Mac could not start its app server \(Error: failed to initialize sqlite state runtime\)\.$/)
  })

  it('starts a thread with our settings and runs two turns: text, tools, finish through our MCP server', async () => {
    const t = await setup()
    await t.link.initialize()
    const id = await t.link.start(t.params)
    expect(id).toMatch(UUID)
    const started = t.requests().find((r) => r.method === 'thread/start')!
    expect(started.params).toEqual(threadParams(t.params))
    expect(started.params).toMatchObject({ cwd: t.cwd, approvalPolicy: 'never', sandbox: 'danger-full-access', developerInstructions: t.params.instructions, config: { mcp_servers: { ni: { url: t.mcp.url, http_headers: { Authorization: `Bearer ${t.mcp.token}` } } } } })
    expect(t.requests().map((r) => r.method).slice(0, 4)).toEqual(['initialize', 'initialized', 'account/read', 'thread/start'])
    // The thread's own model and effort, as Codex answered them.
    expect(t.seen.models).toEqual([{ model: 'fake', effort: 'high' }])
    expect(await t.link.prompt('TOOLS')).toBe('end_turn')
    expect(await t.link.prompt('hello')).toBe('end_turn')
    expect(t.requests().filter((r) => r.method === 'turn/start').map((r) => r.params)).toEqual([
      { threadId: id, input: [{ type: 'text', text: 'TOOLS', text_elements: [] }] },
      { threadId: id, input: [{ type: 'text', text: 'hello', text_elements: [] }] },
    ])
    expect(t.text()).toBe(`Looking. Done ${'w'.repeat(100_000)}got: hello`) // each delta once; another thread's never
    expect(t.seen.toolStarts.map((s) => [s.callId, s.name])).toEqual([
      ['call-1', 'edit'],
      ['call-2', 'shell'],
    ])
    expect(t.seen.toolStarts[1].input).toMatchObject({ command: 'false' })
    expect(t.seen.toolEnds.map((e) => [e.callId, e.ok])).toEqual([
      ['call-1', true],
      ['call-2', false],
    ])
    expect(t.seen.toolEnds[1].output).toBe('exit 1\n[exit code 1]')
    expect(t.calls).toEqual([
      { kind: 'finish', summary: 'Tools done.' },
      { kind: 'finish', summary: 'Done.' },
    ])
    expect(t.seen.errors).toEqual([]) // our MCP server came up
  })

  it('resumes a thread of an earlier launch, and fails for one it does not know', async () => {
    const first = await setup()
    await first.link.initialize()
    const id = await first.link.start(first.params)
    first.children[0].stdin!.end()
    await new Promise((r) => first.children[0].once('close', r))

    const again = codexAppServerLink(first.launchers, first.events, { label: 'Codex', setupTimeoutMs: 5000 })
    await again.initialize()
    await again.resume(id, first.params)
    // A resume says the model again; with no effort named, none is shown.
    expect(first.seen.models).toEqual([{ model: 'fake', effort: 'high' }, { model: 'fake-resumed', effort: null }])
    expect(first.requests().find((r) => r.method === 'thread/resume')!.params).toEqual({ threadId: id, ...threadParams(first.params), excludeTurns: true })
    expect(await again.prompt('go on')).toBe('end_turn')

    const unknown = await setup()
    await unknown.link.initialize()
    await expect(unknown.link.resume('01a1dbfc-62c6-7540-995b-2f8c9a20c505', unknown.params)).rejects.toThrow(/^no rollout found for thread id 01a1dbfc/)
  })

  it('cancels a turn with turn/interrupt: the turn ends as cancelled', async () => {
    const t = await setup()
    await t.link.initialize()
    await t.link.start(t.params)
    const turn = t.link.prompt('SLOW')
    while (!t.text().includes('working')) await new Promise((r) => setTimeout(r, 10))
    t.link.cancel()
    expect(await turn).toBe('cancelled')
    expect(t.requests().find((r) => r.method === 'turn/interrupt')!.params).toMatchObject({ threadId: expect.any(String), turnId: expect.any(String) })
  })

  it('says it is not signed in before the thread, and at a turn Codex refuses as unauthorized', async () => {
    const out = await setup({ signedOut: true })
    await out.link.initialize()
    await expect(out.link.start(out.params)).rejects.toBeInstanceOf(AuthRequiredError)
    expect(out.requests().some((r) => r.method === 'thread/start')).toBe(false)

    const t = await setup()
    await t.link.initialize()
    await t.link.start(t.params)
    await expect(t.link.prompt('AUTHFAIL')).rejects.toBeInstanceOf(AuthRequiredError)
    await expect(t.link.prompt('FAIL')).rejects.toThrow(/^boom$/)
  })

  it('shows once that our MCP server failed to start', async () => {
    const t = await setup({ mcp: 'failed' })
    await t.link.initialize()
    await t.link.start(t.params)
    await t.link.prompt('NOFINISH')
    expect(t.seen.errors).toEqual(["Codex could not connect to Native Intelligence's tools, so it can't report back or finish this job."])
  })

  it("accepts Codex's approval requests (logged) and refuses anything else", async () => {
    const t = await setup()
    await t.link.initialize()
    await t.link.start(t.params)
    expect(await t.link.prompt('APPROVAL')).toBe('end_turn')
    expect(t.text()).toBe('approvals: [{"decision":"accept"},{"code":-32601,"message":"item/tool/requestUserInput is not supported by this client"}]')
    expect(t.seen.logs).toContain('[worker] Codex asked for approval (item/commandExecution/requestApproval: rm -rf build): accepted')
  })

  it('fails a turn whose process died, and every later one', async () => {
    const t = await setup()
    await t.link.initialize()
    await t.link.start(t.params)
    const turn = t.link.prompt('SLOW')
    while (!t.text().includes('working')) await new Promise((r) => setTimeout(r, 10))
    t.children[0].kill('SIGKILL')
    await expect(turn).rejects.toThrow(/^it exited \(SIGKILL\)/)
    await expect(t.link.prompt('hello')).rejects.toThrow(/^it exited/)
  })
})

describe('toolOf', () => {
  it('shows an MCP tool call by its server and tool, with its text or its error', () => {
    expect(toolOf({ type: 'mcpToolCall', id: 'm1', server: 'ni', tool: 'finish', status: 'completed', arguments: { summary: 'x' }, result: { content: [{ type: 'text', text: 'Finished.' }, { type: 'image' }] }, error: null })).toEqual({
      name: 'mcp__ni__finish',
      input: { summary: 'x' },
      ok: true,
      output: 'Finished.\n[image]',
    })
    expect(toolOf({ type: 'mcpToolCall', id: 'm2', server: 'ni', tool: 'report', status: 'failed', arguments: {}, result: null, error: { message: 'HTTP 401' } })).toMatchObject({ ok: false, output: 'HTTP 401' })
    expect(toolOf({ type: 'reasoning', id: 'r' })).toBeNull()
    expect(toolOf({ type: 'commandExecution', id: 'c', command: 'ls', cwd: '/x', status: 'completed', aggregatedOutput: 'a\n', exitCode: 0 })).toEqual({ name: 'shell', input: { command: 'ls', cwd: '/x' }, ok: true, output: 'a\n' })
  })
})
