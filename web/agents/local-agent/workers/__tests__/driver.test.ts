/**
 * The driver against a stand-in link (an AgentLink in this process, playing
 * the scripted turns of fixtures/fake-common.mjs), with the real
 * manager-tools MCP server and the launcher's own prompt broker. The links
 * themselves are claude-stream.test.ts's and codex-app-server.test.ts's; the
 * fence is worker.e2e.test.ts's.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { createPromptBroker } from '../../launcher/prompts'
import { AuthRequiredError, SentenceError, type AgentLink, type AgentProcess, type Launchers, type LinkEvents, type LinkFactory, type SessionParams, type StopReason } from '../lib/agent-link'
import { PUSH_NOTES, WorkerDriver, pushNote } from '../lib/driver'
import { EDIT_JOB, FINISH_NUDGE, READ_JOB, WORKER_INSTRUCTIONS } from '../lib/instructions'
import { createManagerTools } from '../lib/manager-tools'
import { startManagerMcp } from '../lib/mcp-http'
import { INPUT_LIMIT, OUTPUT_LIMIT, TEXT_LIMIT, serializeLine, type NormalizedEvent, type OutboundMessage } from '../lib/protocol'
import { loadRegistry, type RegistryEntry } from '../lib/registry'
// A plain .mjs fixture, shared with the stand-in CLIs.
import { mcpClient, turn as scriptedTurn } from './fixtures/fake-common.mjs'
const REGISTRY = loadRegistry()

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

interface FakeOptions {
  /** Fail `start` / `resume` / `initialize` with this. */
  startError?: Error
  resumeError?: Error
  initError?: Error
  ignoreNudge?: boolean
  /** Start a real (sleeping) process at `start`, as a link does. */
  process?: boolean
}

/** A link that plays the scripted turns, and records what the driver asked of it. */
function fakeLink(o: FakeOptions = {}) {
  const seen = { prompts: [] as string[], starts: [] as SessionParams[], resumes: [] as [string, SessionParams][], cancels: 0 }
  let events!: LinkEvents
  let launchers!: Launchers
  let params: SessionParams | null = null
  let cancel = () => {}
  let proc: AgentProcess | null = null
  const link: AgentLink = {
    async initialize() {
      if (o.initError) throw o.initError
      return { version: '9.9.9' }
    },
    async start(p) {
      seen.starts.push(p)
      if (o.process) proc = launchers.spawn(['agent'])
      if (o.startError && proc) {
        // The process dies while the session starts, and then the start fails: its sentence must win.
        const child = proc as unknown as ChildProcess
        child.kill('SIGKILL')
        await new Promise((r) => child.once('close', r))
      }
      if (o.startError) throw o.startError
      params = p
      return 'sess-1'
    },
    async resume(id, p) {
      seen.resumes.push([id, p])
      if (o.process) proc = launchers.spawn(['agent', '--resume', id])
      if (o.resumeError) throw o.resumeError
      params = p
    },
    async prompt(text): Promise<StopReason> {
      seen.prompts.push(text)
      const server = { url: params!.mcp.url, headers: { authorization: `Bearer ${params!.mcp.token}` } }
      let client: Promise<unknown> | null = null
      const io = {
        tools: () => (client ??= mcpClient(server)),
        cancelled: new Promise<void>((resolve) => (cancel = resolve)),
        say: (t: string, id: string) => events.text(t, `${seen.prompts.length}-${id}`),
        tool: (callId: string, name: string, input: unknown) => events.toolStart({ callId, name, input }),
        result: (callId: string, name: string, ok: boolean, output: string) => events.toolEnd({ callId, name, ok, output }),
      }
      const r = (await scriptedTurn(text, io, { ignoreNudge: o.ignoreNudge })) as { stop?: string; error?: string; auth?: boolean }
      if (r.error) throw r.auth ? new AuthRequiredError(r.error) : new Error(r.error)
      return r.stop === 'max_turns' ? 'max_turn_requests' : (r.stop as StopReason)
    },
    cancel() {
      seen.cancels += 1
      cancel()
    },
  }
  const factory: LinkFactory = (l, e) => {
    launchers = l
    events = e
    return link
  }
  return { factory, seen, events: () => events, proc: () => proc as unknown as ChildProcess | null }
}

async function setup(opts: { entry?: Partial<RegistryEntry>; mode?: 'read' | 'edit'; link?: FakeOptions; workspace?: string } = {}) {
  const out: OutboundMessage[] = []
  const fatal: string[] = []
  const logs: string[] = []
  const mode = opts.mode ?? 'read'
  let driver: WorkerDriver
  const mcp = await startManagerMcp(createManagerTools((e, pr) => driver.onManagerEvent(e, pr), mode).call)
  const prompts = createPromptBroker({ write: (l) => out.push(l), log: (l) => logs.push(l) }, { idPrefix: 'p-test' })
  const fake = fakeLink(opts.link)
  const children: ChildProcess[] = []
  const launchers: Launchers = {
    // A real process that waits, writes one stderr line, and ends on a signal.
    spawn: () => {
      const child = spawn(process.execPath, ['-e', "process.stderr.write('agent started\\n'); setInterval(() => {}, 1000)"], { stdio: ['pipe', 'pipe', 'pipe'] })
      children.push(child)
      return child as unknown as AgentProcess
    },
    run: async () => ({ code: 0, signal: null, stdout: '', stderr: '' }),
  }
  driver = new WorkerDriver(
    { entry: { ...REGISTRY['claude-code'], ...opts.entry }, mode, cwd: '/x/project', mcp: { url: mcp.url, token: mcp.token }, setupTimeoutMs: 5000, ...(opts.workspace ? { workspaceInstructions: opts.workspace } : {}) },
    { write: (m) => out.push(m), log: (l) => logs.push(l), fatal: (m) => fatal.push(m), ask: (kind, detail) => prompts.ask(kind, detail) },
    { launchers, link: fake.factory },
  )
  cleanups.push(async () => {
    for (const c of children) c.kill('SIGKILL')
    prompts.close()
    await mcp.close()
  })
  const events = () => out.flatMap((m) => (m.type === 'event' ? [m.event] : []))
  const until = async (test: () => boolean, ms = 5000) => {
    const end = Date.now() + ms
    while (!test()) {
      if (Date.now() > end) throw new Error(`timed out; out: ${JSON.stringify(out).slice(0, 4000)}\nfatal: ${fatal}\nlogs: ${logs.join('\n')}`)
      await new Promise((r) => setTimeout(r, 5))
    }
  }
  const waiting = (count: number) => until(() => events().filter((e) => e.kind === 'status' && e.status === 'waiting').length >= count)
  const answer = (id: string, allow: boolean) => prompts.handleLine(JSON.stringify({ type: 'prompt_answer', id, allow }))
  return { driver, mcp, out, fatal, logs, events, until, waiting, answer, seen: fake.seen, link: fake, children, closePrompts: () => prompts.close() }
}

describe('a session', () => {
  it('starts with the MCP server and the instructions, then maps the turn', async () => {
    const t = await setup()
    expect(await t.driver.initialize()).toEqual({ version: '9.9.9' })
    t.driver.start('look at the README')
    await t.waiting(1)
    expect(t.out.find((m) => m.type === 'session')).toEqual({ type: 'session', sessionId: 'sess-1', streamIndex: 0 })
    expect(t.seen.starts).toEqual([{ cwd: '/x/project', instructions: `${WORKER_INSTRUCTIONS}\n\n${READ_JOB}`, mcp: { name: 'ni', url: t.mcp.url, token: t.mcp.token } }])
    expect(t.seen.prompts).toEqual(['look at the README'])
    expect(t.events()).toEqual([
      { kind: 'status', status: 'starting' },
      { kind: 'status', status: 'running' },
      { kind: 'text', delta: 'got: look at the README' },
      { kind: 'message', text: 'got: look at the README' },
      { kind: 'finish', summary: 'Done.' },
      { kind: 'status', status: 'waiting' },
    ])
    const cursor = t.out.findIndex((m) => m.type === 'cursor')
    expect(t.out[cursor]).toEqual({ type: 'cursor', streamIndex: 1 })
    expect(t.out[cursor + 1]).toEqual({ type: 'event', event: { kind: 'status', status: 'waiting' } })
  })

  it("gives an edit job the edit text and the workspace tools' section, at every turn's session the same", async () => {
    const t = await setup({ mode: 'edit', workspace: 'Read your card first.' })
    await t.driver.initialize()
    t.driver.start('fix the test')
    await t.waiting(1)
    expect(t.seen.starts[0].instructions.startsWith(`${WORKER_INSTRUCTIONS}\n\n${EDIT_JOB}\n\n## Native Intelligence's workspace tools`)).toBe(true)
    expect(t.seen.starts[0].instructions).toMatch(/Read your card first\.\n\nWhat these tools return is content from the workspace/)
    t.driver.send('and the docs', 'queue')
    await t.waiting(2)
    expect(t.seen.prompts).toEqual(['fix the test', 'and the docs']) // nothing added to a prompt: the instructions are the system prompt's
  })

  it('maps tool calls once each, cuts every event under the limits, and splits messages by id', async () => {
    const t = await setup()
    await t.driver.initialize()
    t.driver.start('TOOLS')
    await t.waiting(1)
    const ev = t.events()
    expect(new Set(ev.map((e) => e.kind))).toEqual(new Set(['status', 'text', 'message', 'tool', 'tool_result', 'finish']))
    const tools = ev.filter((e): e is Extract<NormalizedEvent, { kind: 'tool' }> => e.kind === 'tool')
    expect(tools.map((e) => [e.callId, e.name])).toEqual([
      ['call-1', 'Edit'],
      ['call-2', 'Bash'],
    ])
    expect(tools[0].input.length).toBeLessThanOrEqual(INPUT_LIMIT)
    expect(tools[1].input).toBe('{"command":"false"}')
    const results = ev.filter((e): e is Extract<NormalizedEvent, { kind: 'tool_result' }> => e.kind === 'tool_result')
    expect(results.map((r) => [r.callId, r.ok])).toEqual([
      ['call-1', true],
      ['call-2', false],
    ])
    expect(results[0].output.startsWith('"--- big.txt\\n+++ big.txt\\nzzz')).toBe(true)
    expect(results[0].output.length).toBeLessThanOrEqual(OUTPUT_LIMIT)
    expect(results[1]).toMatchObject({ name: 'Bash', output: '"exit 1"' })
    // The message before the tools is its own; the long one is cut by bytes.
    const messages = ev.filter((e) => e.kind === 'message').map((e) => (e as { text: string }).text)
    expect(messages[0]).toBe('Looking. ')
    expect(new TextEncoder().encode(messages[1]).length).toBeLessThanOrEqual(TEXT_LIMIT)
    for (const m of t.out) expect(new TextEncoder().encode(serializeLine(m)).length).toBeLessThan(64 * 1024)
  })

  it('shows one tool_result per call, and a result for a call never shown shows the call first', async () => {
    const t = await setup()
    await t.driver.initialize()
    t.driver.start('WAIT')
    await t.until(() => t.seen.prompts.length === 1)
    const ev = t.link.events()
    ev.toolEnd({ callId: 'c9', name: 'Read', ok: true, output: 'x' })
    ev.toolEnd({ callId: 'c9', name: 'Read', ok: true, output: 'again' })
    ev.toolStart({ callId: 'c9', name: 'Read', input: { path: 'a' } })
    await t.waiting(1)
    expect(t.events().filter((e) => e.kind === 'tool' || e.kind === 'tool_result')).toEqual([
      { kind: 'tool', callId: 'c9', name: 'Read', input: '{}' },
      { kind: 'tool_result', callId: 'c9', name: 'Read', ok: true, output: '"x"' },
    ])
  })

  it('queues messages that arrive during a turn and sends them together as the next', async () => {
    const t = await setup()
    await t.driver.initialize()
    t.driver.start('WAIT first')
    await t.until(() => t.seen.prompts.length === 1)
    t.driver.send('second', 'steer')
    t.driver.send('third', 'queue')
    await t.waiting(1)
    expect(t.seen.prompts).toEqual(['WAIT first', 'second\n\nthird'])
    expect(t.out.filter((m) => m.type === 'cursor')).toEqual([
      { type: 'cursor', streamIndex: 1 },
      { type: 'cursor', streamIndex: 2 },
    ])
    expect(t.events().filter((e) => e.kind === 'status')).toEqual([
      { kind: 'status', status: 'starting' },
      { kind: 'status', status: 'running' },
      { kind: 'status', status: 'waiting' },
    ])
  })

  it("stops a turn with the link's cancel, then ends the agent's process and reports cancelled", async () => {
    const t = await setup({ link: { process: true } })
    await t.driver.initialize()
    t.driver.start('SLOW')
    await t.until(() => t.events().some((e) => e.kind === 'text'))
    await t.driver.stop(2000)
    expect(t.seen.cancels).toBe(1)
    expect(t.events().at(-1)).toEqual({ kind: 'status', status: 'cancelled' })
    const child = t.children[0]
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    expect(t.fatal).toEqual([])
    expect(t.events().some((e) => e.kind === 'error')).toBe(false)
  })

  it("fails with a sentence and the stderr's last line when the agent's process exits on its own", async () => {
    const t = await setup({ link: { process: true } })
    await t.driver.initialize()
    t.driver.start('WAIT')
    await t.waiting(1)
    t.children[0].kill('SIGKILL')
    await t.until(() => t.fatal.length > 0)
    expect(t.fatal).toEqual(['Claude Code stopped unexpectedly (SIGKILL): agent started'])
  })

  it("puts the link's own setup sentence first, not the exit, when the process dies while the session starts", async () => {
    const t = await setup({ link: { process: true, startError: new Error('it exited (exit code 1): no login') } })
    await t.driver.initialize()
    t.driver.start('hello')
    await t.until(() => t.fatal.length > 0)
    await new Promise((r) => setTimeout(r, 50))
    expect(t.fatal).toEqual(['Claude Code could not start the session: it exited (exit code 1): no login'])
  })

  it('shows what the link reports as an error event, without ending the turn', async () => {
    const t = await setup()
    await t.driver.initialize()
    t.driver.start('WAIT')
    await t.until(() => t.seen.prompts.length === 1)
    t.link.events().error("Claude Code could not connect to Native Intelligence's tools (failed), so it can't report back or finish this job.")
    await t.waiting(1)
    expect(t.events()).toContainEqual({ kind: 'error', message: "Claude Code could not connect to Native Intelligence's tools (failed), so it can't report back or finish this job." })
    expect(t.events()).toContainEqual({ kind: 'finish', summary: 'Done.' })
  })

  it('shows the model the link names once, again only when it changes, and never a nameless one', async () => {
    const t = await setup()
    await t.driver.initialize()
    t.driver.start('WAIT')
    await t.until(() => t.seen.prompts.length === 1)
    const say = t.link.events().model
    say({ model: 'gpt-fake', effort: 'high' })
    say({ model: 'gpt-fake', effort: 'high' })
    say({ model: '', effort: 'low' })
    say({ model: 'gpt-fake', effort: null })
    await t.waiting(1)
    expect(t.events().filter((e) => e.kind === 'model')).toEqual([
      { kind: 'model', model: 'gpt-fake', effort: 'high' },
      { kind: 'model', model: 'gpt-fake' },
    ])
  })

  it('says why the link could not start: its own sentence as is, anything else after the label', async () => {
    const own = await setup({ link: { initError: new SentenceError('Codex 0.34.0 on this Mac could not start its app server. Update Codex.') } })
    await expect(own.driver.initialize()).rejects.toThrow(/^Codex 0\.34\.0 on this Mac could not start its app server\. Update Codex\.$/)
    const other = await setup({ link: { initError: new Error('spawn EACCES') } })
    await expect(other.driver.initialize()).rejects.toThrow(/^Claude Code could not start: spawn EACCES$/)
  })
})

describe('resume', () => {
  it('picks the session up through the link, then waits', async () => {
    const t = await setup()
    await t.driver.initialize()
    t.driver.resume('sess-abc', 4)
    await t.waiting(1)
    expect(t.out[0]).toEqual({ type: 'session', sessionId: 'sess-abc', streamIndex: 4 })
    expect(t.seen.resumes).toEqual([['sess-abc', { cwd: '/x/project', instructions: `${WORKER_INSTRUCTIONS}\n\n${READ_JOB}`, mcp: { name: 'ni', url: t.mcp.url, token: t.mcp.token } }]])
    t.driver.send('go on', 'queue')
    await t.waiting(2)
    expect(t.seen.prompts).toEqual(['go on'])
    expect(t.out.filter((m) => m.type === 'cursor')).toEqual([{ type: 'cursor', streamIndex: 5 }])
  })

  it('fails with a sentence for a session the agent does not know, and for an id it would not keep', async () => {
    const unknown = await setup({ link: { resumeError: new Error('it has no conversation with this session id') } })
    await unknown.driver.initialize()
    unknown.driver.resume('other-1', 0)
    await unknown.until(() => unknown.fatal.length > 0)
    expect(unknown.fatal).toEqual(['Claude Code could not pick up the session: it has no conversation with this session id'])
    expect(unknown.out.some((m) => m.type === 'session')).toBe(false)

    const bad = await setup()
    await bad.driver.initialize()
    bad.driver.resume('--settings={}', 0)
    expect(bad.fatal).toEqual(["this job can't resume: its session id is not one a worker made"])
    expect(bad.seen.resumes).toEqual([])
  })
})

describe('the manager tools and the end of a job', () => {
  it("fails with the entry's sign-in sentence when the agent is not signed in, at the session or at a turn", async () => {
    const out = await setup({ link: { startError: new AuthRequiredError() } })
    await out.driver.initialize()
    out.driver.start('hello')
    await out.until(() => out.fatal.length > 0)
    expect(out.fatal).toEqual(["Claude Code isn't signed in on this Mac. Open Terminal, run `claude`, then `/login`."])

    const turn = await setup({ entry: REGISTRY.codex })
    await turn.driver.initialize()
    turn.driver.start('AUTHFAIL')
    await turn.until(() => turn.fatal.length > 0)
    expect(turn.fatal).toEqual(["Codex isn't signed in on this Mac. Open Terminal and run `codex login`."])
  })

  it('emits ask from ask_manager, nudges no one who asked, and reports a refusal, the step limit and a failed turn as errors', async () => {
    const t = await setup()
    await t.driver.initialize()
    t.driver.start('ASK')
    await t.waiting(1)
    expect(t.events()).toContainEqual({ kind: 'ask', question: 'Which branch?' })
    for (const [i, word] of ['REFUSE', 'MAXTURNS', 'FAIL'].entries()) {
      t.driver.send(word, 'queue')
      await t.waiting(i + 2)
    }
    expect(t.seen.prompts).toEqual(['ASK', 'REFUSE', 'MAXTURNS', 'FAIL'])
    expect(t.events().filter((e) => e.kind === 'error')).toEqual([
      { kind: 'error', message: 'Claude Code refused to go on with this request.' },
      { kind: 'error', message: 'Claude Code stopped: the turn reached its limit of steps.' },
      { kind: 'error', message: 'Claude Code failed the turn: boom' },
    ])
    expect(t.fatal).toEqual([])
  })

  it('sends one follow-up when a turn ends without finish, once per job', async () => {
    const t = await setup()
    await t.driver.initialize()
    t.driver.start('NOFINISH')
    await t.waiting(1)
    expect(t.seen.prompts).toEqual(['NOFINISH', FINISH_NUDGE])
    expect(t.events()).toContainEqual({ kind: 'finish', summary: 'Finished after the nudge.' })
    t.driver.send('NOFINISH again', 'queue')
    await t.waiting(2)
    expect(t.seen.prompts).toHaveLength(3) // finish was called in this job: no more follow-ups

    const stubborn = await setup({ link: { ignoreNudge: true } })
    await stubborn.driver.initialize()
    stubborn.driver.start('NOFINISH')
    await stubborn.waiting(1)
    stubborn.driver.send('NOFINISH', 'queue')
    await stubborn.waiting(2)
    expect(stubborn.seen.prompts).toEqual(['NOFINISH', FINISH_NUDGE, 'NOFINISH'])
  })
})

describe('finish', () => {
  it('is held until the turn ends, then emitted once, after everything the turn said', async () => {
    const t = await setup()
    await t.driver.initialize()
    t.driver.start('FINISH2')
    await t.waiting(1)
    const kinds = t.events().map((e) => e.kind)
    expect(t.events().filter((e) => e.kind === 'finish')).toEqual([{ kind: 'finish', summary: 'First finish.' }])
    expect(kinds.indexOf('finish')).toBeGreaterThan(kinds.lastIndexOf('message')) // 'still writing' came after the call
    expect(t.logs).toContain('[worker] ignored a second finish in this turn')
  })

  it('from a command between turns (anyone holding the bearer) is not an event', async () => {
    const t = await setup()
    await t.driver.initialize()
    t.driver.start('hello')
    await t.waiting(1)
    const before = t.events().length
    const res = await fetch(t.mcp.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t.mcp.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'finish', arguments: { summary: 'Forged.' } } }),
    })
    expect(res.status).toBe(200)
    expect(t.events().length).toBe(before)
    expect(t.logs).toContain('[worker] ignored a finish call outside a turn')
  })
})

describe('a pull request', () => {
  it("in an edit job: finish, then the launcher's push prompt, then (after the answer) the cursor; the agent hears the outcome next turn", async () => {
    for (const allow of [true, false]) {
      const t = await setup({ mode: 'edit' })
      await t.driver.initialize()
      t.driver.start('FINISHPR')
      await t.until(() => t.out.some((m) => m.type === 'prompt'))
      const kinds = t.out.map((m) => (m.type === 'event' ? m.event.kind : m.type))
      expect(kinds.slice(kinds.indexOf('finish'))).toEqual(['finish', 'prompt']) // and no cursor until the person answers
      expect(t.out.find((m) => m.type === 'prompt')).toEqual({ type: 'prompt', id: 'p-test-1', kind: 'push', detail: { title: 'Fix the flaky test', body: 'It waited on a timer.', timeoutMs: expect.any(Number) } })
      expect(t.events()).toContainEqual({ kind: 'finish', summary: 'Fixed the flaky test.' })
      expect(t.events()).toContainEqual({ kind: 'message', text: expect.stringMatching(/^tool said: Finished\. When your turn ends, the person is asked on their Mac/) })
      t.driver.send('go on', 'queue') // waits: the turn isn't over until the answer
      expect(t.answer('p-test-1', allow)).toBe(true)
      await t.waiting(1)
      const after = t.out.map((m) => (m.type === 'event' ? m.event.kind : m.type))
      expect(after.indexOf('cursor')).toBeGreaterThan(after.indexOf('prompt'))
      expect(t.seen.prompts[1]).toBe(`[From Native Intelligence] ${allow ? PUSH_NOTES.yes : PUSH_NOTES.no}\n\ngo on`)
      expect(t.seen.prompts).toHaveLength(2) // the outcome is told with the next message, not as a turn of its own
      t.driver.send('and then', 'queue')
      await t.waiting(2)
      expect(t.seen.prompts[2]).toBe('and then') // once, never again
    }
  })

  it('nobody answering is told once too; no prompt, no note', async () => {
    const t = await setup({ mode: 'edit' })
    await t.driver.initialize()
    t.driver.start('FINISHPR')
    await t.until(() => t.out.some((m) => m.type === 'prompt'))
    t.closePrompts() // the desktop went away: nobody can answer
    await t.waiting(1)
    t.driver.send('go on', 'queue')
    await t.waiting(2)
    t.driver.send('more', 'queue')
    await t.waiting(3)
    expect(t.seen.prompts.slice(1)).toEqual([`[From Native Intelligence] ${PUSH_NOTES.none}\n\ngo on`, 'more'])
    for (const p of t.seen.prompts) expect(p).not.toMatch(/https?:|was opened/)
    // A finish without a pull request asks nothing and adds nothing.
    const plain = await setup({ mode: 'edit' })
    await plain.driver.initialize()
    plain.driver.start('hello')
    await plain.waiting(1)
    plain.driver.send('next', 'queue')
    await plain.waiting(2)
    expect(plain.seen.prompts).toEqual(['hello', 'next'])
    expect(plain.out.some((m) => m.type === 'prompt')).toBe(false)
  })

  it('in a read job: a plain finish, no prompt, and the agent is told nothing was changed', async () => {
    const t = await setup()
    await t.driver.initialize()
    t.driver.start('FINISHPR')
    await t.waiting(1)
    expect(t.out.some((m) => m.type === 'prompt')).toBe(false)
    expect(t.events()).toContainEqual({ kind: 'finish', summary: 'Fixed the flaky test.' })
    expect(t.events()).toContainEqual({ kind: 'message', text: expect.stringMatching(/^tool said: Finished\. This job is read-only: nothing was changed/) })
  })

  it('a second finish in the turn is still ignored, its pull request too; an answer for no open prompt is dropped', async () => {
    const t = await setup({ mode: 'edit' })
    await t.driver.initialize()
    t.driver.start('FINISHPR2')
    await t.until(() => t.out.some((m) => m.type === 'prompt'))
    expect(t.events().filter((e) => e.kind === 'finish')).toEqual([{ kind: 'finish', summary: 'Fixed the flaky test.' }])
    expect(t.answer('p-test-9', true)).toBe(true)
    expect(t.logs).toContain('[local-agent] prompt_answer for p-test-9, which is not open, was ignored')
    expect(t.answer('p-test-1', false)).toBe(true)
    await t.waiting(1)
    expect(t.out.filter((m) => m.type === 'prompt')).toHaveLength(1)
  })
})

describe('pushNote', () => {
  it('says only what the adapter knows: yes, no, or nobody answered; never a link', () => {
    expect(pushNote({ allowed: true, reason: 'allowed' })).toBe(PUSH_NOTES.yes)
    expect(pushNote({ allowed: false, reason: 'denied' })).toBe(PUSH_NOTES.no)
    for (const reason of ['timeout', 'unavailable', 'invalid'] as const) expect(pushNote({ allowed: false, reason })).toBe(PUSH_NOTES.none)
    for (const n of Object.values(PUSH_NOTES)) expect(n).not.toMatch(/https?:|link|was opened|conversation/)
  })
})
