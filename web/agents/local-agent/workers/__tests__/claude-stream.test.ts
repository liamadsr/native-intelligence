/**
 * The `claude-stream` link against a stand-in Claude Code CLI
 * (fixtures/fake-claude.mjs, the stream-json shapes of Claude Code 2.1.311)
 * run as a real process, with the real manager tools' MCP server.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { AuthRequiredError, SentenceError } from '../lib/agent-link'
import { AUTH_TEXT, claudeArgs, claudeStreamLink } from '../lib/claude-stream'
import { linkHarness } from './fixtures/links'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

async function setup(opts: Record<string, unknown> = {}, setupTimeoutMs = 5000) {
  const h = await linkHarness('fake-claude.mjs', opts)
  cleanups.push(h.close)
  const link = claudeStreamLink(h.launchers, h.events, { label: 'Claude Code', setupTimeoutMs })
  return { ...h, link }
}

describe('claude-stream', () => {
  it("reads the CLI's version from `claude --version`", async () => {
    const t = await setup()
    expect(await t.link.initialize()).toEqual({ version: '9.9.9' })
    expect(t.children).toHaveLength(0) // a short command, not the agent
  })

  it('starts one process with our flags and its own session id, and runs two turns over the same stdin', async () => {
    const t = await setup()
    const id = await t.link.start(t.params)
    expect(id).toMatch(UUID)
    const [launch] = t.requests().filter((r) => r.argv)
    expect(launch.argv).toEqual(claudeArgs(t.params, { start: id }))
    expect(launch.argv).toEqual(expect.arrayContaining(['-p', '--setting-sources', 'user', '--strict-mcp-config', '--permission-mode', 'bypassPermissions', '--session-id', id]))
    expect(launch.argv).not.toContain('--bare')
    expect(JSON.parse(launch.argv![launch.argv!.indexOf('--mcp-config') + 1])).toEqual({ mcpServers: { ni: { type: 'http', url: t.mcp.url, headers: { Authorization: `Bearer ${t.mcp.token}` } } } })
    expect(launch.argv![launch.argv!.indexOf('--append-system-prompt') + 1]).toBe(t.params.instructions)
    expect(await t.link.prompt('hello')).toBe('end_turn')
    expect(await t.link.prompt('and again')).toBe('end_turn')
    expect(t.children).toHaveLength(1)
    // Each text once (the whole assistant message after its deltas is not shown again), by message.
    expect(t.seen.text.map(([d]) => d)).toEqual(['got: hello', 'got: and again'])
    expect(new Set(t.seen.text.map(([, m]) => m)).size).toBe(2)
    expect(t.calls).toEqual([
      { kind: 'finish', summary: 'Done.' },
      { kind: 'finish', summary: 'Done.' },
    ])
    const stdin = t.requests().flatMap((r) => (r.stdin ? [r.stdin] : []))
    expect(stdin[0]).toEqual({ type: 'control_request', request_id: 'ni-init', request: { subtype: 'initialize' } })
    expect(stdin.slice(1)).toEqual([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'and again' }] } },
    ])
    expect(t.seen.errors).toEqual([])
  })

  it("reports the top-level agent's tools once each, with their results, and none of a sub-agent's steps", async () => {
    const t = await setup()
    await t.link.start(t.params)
    expect(await t.link.prompt('TOOLS')).toBe('end_turn')
    expect(t.seen.toolStarts.map((s) => [s.callId, s.name])).toEqual([
      ['call-1', 'Edit'],
      ['call-2', 'Bash'],
    ])
    expect(t.seen.toolStarts[1].input).toEqual({ command: 'false' })
    expect(t.seen.toolEnds.map((e) => [e.callId, e.name, e.ok])).toEqual([
      ['call-1', 'Edit', true],
      ['call-2', 'Bash', false],
    ])
    expect(t.seen.toolEnds[1].output).toBe('exit 1')
    expect(t.text()).not.toContain('SUBAGENT')
    expect(t.seen.text[0]).toEqual(['Looking. ', expect.any(String)])
  })

  it('maps how a turn ends: a refusal, the step limit, a failure', async () => {
    const t = await setup()
    await t.link.start(t.params)
    expect(await t.link.prompt('REFUSE')).toBe('refusal')
    expect(await t.link.prompt('MAXTURNS')).toBe('max_turn_requests')
    await expect(t.link.prompt('FAIL')).rejects.toThrow(/^boom$/)
    expect(await t.link.prompt('hello')).toBe('end_turn') // the process goes on
  })

  it('resumes a session of an earlier launch, and fails for one it does not know, before any turn', async () => {
    const first = await setup()
    const id = await first.link.start(first.params)
    expect(await first.link.prompt('hello')).toBe('end_turn')
    first.children[0].stdin!.end()
    await new Promise((r) => first.children[0].once('close', r))

    // The same home, a new launch.
    const again = claudeStreamLink(first.launchers, first.events, { label: 'Claude Code', setupTimeoutMs: 5000 })
    await again.resume(id, first.params)
    expect(first.requests().filter((r) => r.argv).at(-1)!.argv).toEqual(claudeArgs(first.params, { resume: id }))
    expect(await again.prompt('go on')).toBe('end_turn')

    const unknown = await setup()
    const started = Date.now()
    await expect(claudeStreamLink(unknown.launchers, unknown.events, { label: 'Claude Code', setupTimeoutMs: 5000 }).resume('6f1d2c3b-4a5e-4f60-8172-93a4b5c6d7e8', unknown.params)).rejects.toThrow(/^it has no conversation with this session id$/)
    expect(Date.now() - started).toBeLessThan(4000)
    await expect(unknown.link.resume('--settings={}', unknown.params)).rejects.toThrow(SentenceError)
  })

  it('cancels a turn with SIGINT: the turn ends as cancelled', async () => {
    const t = await setup()
    await t.link.start(t.params)
    const turn = t.link.prompt('SLOW')
    while (!t.text().includes('working')) await new Promise((r) => setTimeout(r, 10))
    t.link.cancel()
    expect(await turn).toBe('cancelled')
  })

  it('says it is not signed in at the start when no login was found, and at a turn when the CLI says so', async () => {
    const t = await setup({ signedOut: true })
    await expect(t.link.start(t.params)).rejects.toBeInstanceOf(AuthRequiredError)

    // A CLI that does not answer the handshake is taken as started; the turn then says it.
    const quiet = await setup({ signedOut: true, noHandshake: true }, 500)
    await quiet.link.start(quiet.params)
    expect(quiet.seen.logs).toContain('[worker] Claude Code did not answer its initialize request: taken as started')
    await expect(quiet.link.prompt('hello')).rejects.toBeInstanceOf(AuthRequiredError)
    expect(quiet.text()).toBe('') // Claude Code's own "Not logged in" message is not the agent's words

    const turn = await setup()
    await turn.link.start(turn.params)
    await expect(turn.link.prompt('AUTHFAIL')).rejects.toBeInstanceOf(AuthRequiredError)
    expect(AUTH_TEXT.test('Not logged in · Please run /login')).toBe(true)
    expect(AUTH_TEXT.test('boom')).toBe(false)
  })

  it('shows once that our MCP server did not connect', async () => {
    const t = await setup({ mcp: 'failed' })
    await t.link.start(t.params)
    await t.link.prompt('NOFINISH')
    await t.link.prompt('NOFINISH')
    expect(t.seen.errors).toEqual(["Claude Code could not connect to Native Intelligence's tools (failed), so it can't report back or finish this job."])
  })

  it('fails the start with the reason when the process exits before it answers', async () => {
    const t = await setup({ noHandshake: true })
    const started = t.link.start(t.params)
    await new Promise((r) => setTimeout(r, 100))
    t.children[0].kill('SIGKILL')
    await expect(started).rejects.toThrow(/^it exited \(SIGKILL\)/)
    await expect(t.link.prompt('hello')).rejects.toThrow(/^it exited/)
  })
})
