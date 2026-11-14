/**
 * The ACP driver against a stand-in agent (fixtures/fake-acp-agent.mjs) run
 * as a real process, with the real manager-tools MCP server and, for an agent
 * that takes no HTTP MCP server, the real stdio proxy from the bundle. No
 * fence here (worker.e2e.test.ts runs it under the profile).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createPromptBroker } from '../../launcher/prompts'
import { PUSH_NOTES, WorkerDriver, pickPermission, pushNote, toolOutput } from '../lib/driver'
import { FINISH_NUDGE, READ_JOB, EDIT_JOB, WORKER_INSTRUCTIONS } from '../lib/instructions'
import { createManagerTools } from '../lib/manager-tools'
import { startManagerMcp } from '../lib/mcp-http'
import { INPUT_LIMIT, OUTPUT_LIMIT, TEXT_LIMIT, serializeLine, type NormalizedEvent, type OutboundMessage } from '../lib/protocol'
import { loadRegistry, type RegistryEntry } from '../lib/registry'
const REGISTRY = loadRegistry()

const FAKE = join(__dirname, 'fixtures', 'fake-acp-agent.mjs')
let root: string
let folder: string
let bundle: string
let n = 0
const cleanups: (() => Promise<void> | void)[] = []

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'la-acp-driver-')))
  folder = join(root, 'project')
  mkdirSync(folder)
  bundle = join(root, 'acp.mjs')
  await build({
    entryPoints: [join(__dirname, '..', 'acp.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    logLevel: 'warning',
    banner: { js: "import { createRequire as __niRequire } from 'node:module'; const require = __niRequire(import.meta.url);" },
    outfile: bundle,
  })
})
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

async function setup(opts: { env?: Record<string, string>; entry?: Partial<RegistryEntry>; mode?: 'read' | 'edit' } = {}) {
  n += 1
  const log = join(root, `requests-${n}.jsonl`)
  const out: OutboundMessage[] = []
  const fatal: string[] = []
  const logs: string[] = []
  const child: ChildProcess = spawn(process.execPath, [FAKE], {
    cwd: folder,
    env: { PATH: '/usr/bin:/bin', HOME: root, FAKE_ACP_LOG: log, ...opts.env } as Record<string, string> as NodeJS.ProcessEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let driver: WorkerDriver
  const mode = opts.mode ?? 'read'
  const mcp = await startManagerMcp(createManagerTools((e, pr) => driver.onManagerEvent(e, pr), mode).call)
  // The launcher's own prompt broker, writing its lines where the driver writes its own.
  const prompts = createPromptBroker({ write: (l) => out.push(l), log: (l) => logs.push(l) }, { idPrefix: 'p-test' })
  driver = new WorkerDriver(
    child as never,
    {
      entry: { ...REGISTRY['claude-code'], ...opts.entry },
      mode,
      cwd: folder,
      mcp: { url: mcp.url, port: mcp.port, token: mcp.token, proxy: { command: process.execPath, args: [bundle, '--mcp-proxy'] } },
      setupTimeoutMs: 10_000,
    },
    { write: (m) => out.push(m), log: (l) => logs.push(l), fatal: (m) => fatal.push(m), ask: (kind, detail) => prompts.ask(kind, detail) },
  )
  cleanups.push(async () => {
    child.kill('SIGKILL')
    await mcp.close()
  })
  const events = () => out.flatMap((m) => (m.type === 'event' ? [m.event] : []))
  const requests = (method?: string) =>
    (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [])
      .map((l) => JSON.parse(l) as { method: string; params: Record<string, unknown> })
      .filter((r) => !method || r.method === method)
  const until = async (test: () => boolean, ms = 8000) => {
    const end = Date.now() + ms
    while (!test()) {
      if (Date.now() > end) throw new Error(`timed out; out: ${JSON.stringify(out)}\nfatal: ${fatal}\nlogs: ${logs.join('\n')}`)
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  const waiting = (count: number) => until(() => events().filter((e) => e.kind === 'status' && e.status === 'waiting').length >= count)
  const promptsSent = () => requests('session/prompt').map((r) => (r.params.prompt as { text: string }[])[0].text)
  const answer = (id: string, allow: boolean) => prompts.handleLine(JSON.stringify({ type: 'prompt_answer', id, allow }))
  return { driver, child, mcp, out, fatal, logs, events, requests, until, waiting, prompts: promptsSent, answer, closePrompts: () => prompts.close() }
}

describe('a session', () => {
  it('starts with the HTTP MCP server and the instructions as a system prompt, then maps the turn', async () => {
    const t = await setup()
    expect(await t.driver.initialize()).toEqual({ version: '9.9.9' })
    t.driver.start('look at the README')
    await t.waiting(1)
    const session = t.out.find((m) => m.type === 'session')
    expect(session).toEqual({ type: 'session', sessionId: expect.stringMatching(/^sess-/), streamIndex: 0 })
    const [created] = t.requests('session/new')
    expect(created.params).toEqual({
      cwd: folder,
      mcpServers: [{ type: 'http', name: 'ni', url: t.mcp.url, headers: [{ name: 'Authorization', value: `Bearer ${t.mcp.token}` }] }],
      systemPrompt: { mode: 'append', content: [{ type: 'text', text: `${WORKER_INSTRUCTIONS}\n\n${READ_JOB}` }] },
    })
    expect(t.requests('session/set_mode')).toEqual([]) // Claude Code's entry names no mode
    expect(t.prompts()).toEqual(['look at the README'])
    expect(t.events()).toEqual([
      { kind: 'status', status: 'starting' },
      { kind: 'status', status: 'running' },
      { kind: 'text', delta: 'got: look at the README (mode default)' },
      { kind: 'message', text: 'got: look at the README (mode default)' },
      { kind: 'finish', summary: 'Done.' },
      { kind: 'status', status: 'waiting' },
    ])
    const cursor = t.out.findIndex((m) => m.type === 'cursor')
    expect(t.out[cursor]).toEqual({ type: 'cursor', streamIndex: 1 })
    expect(t.out[cursor + 1]).toEqual({ type: 'event', event: { kind: 'status', status: 'waiting' } })
    expect(t.requests('initialize')[0].params).toMatchObject({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
  })

  it('hands an agent without HTTP MCP the stdio proxy, and puts the instructions at the top of the first prompt only', async () => {
    const t = await setup({ env: { FAKE_ACP_HTTP: '0', FAKE_ACP_SYSTEM_PROMPT: '0' }, mode: 'edit' })
    await t.driver.initialize()
    t.driver.start('fix the test')
    await t.waiting(1)
    const [created] = t.requests('session/new')
    expect(created.params).toEqual({
      cwd: folder,
      mcpServers: [
        {
          name: 'ni',
          command: process.execPath,
          args: [bundle, '--mcp-proxy'],
          env: [
            { name: 'NI_MCP_PORT', value: String(t.mcp.port) },
            { name: 'NI_MCP_TOKEN', value: t.mcp.token },
          ],
        },
      ],
    })
    // The finish came through the proxy.
    expect(t.events()).toContainEqual({ kind: 'finish', summary: 'Done.' })
    t.driver.send('and the docs', 'queue')
    await t.waiting(2)
    const [first, second] = t.prompts()
    expect(first).toBe(`${WORKER_INSTRUCTIONS}\n\n${EDIT_JOB}\n\n---\n\n# The request\n\nfix the test`)
    expect(second).toBe('and the docs')
  })

  it("sets the entry's session mode after the session exists, and fails when the agent refuses it", async () => {
    const t = await setup({ entry: REGISTRY.codex })
    await t.driver.initialize()
    t.driver.start('hello')
    await t.waiting(1)
    expect(t.requests().map((r) => r.method)).toEqual(['initialize', 'session/new', 'session/set_mode', 'session/prompt'])
    expect(t.requests('session/set_mode')[0].params).toMatchObject({ modeId: 'agent-full-access' })
    expect(t.events()).toContainEqual({ kind: 'message', text: 'got: hello (mode agent-full-access)' })

    const bad = await setup({ entry: { ...REGISTRY.codex, sessionMode: 'nope' } })
    await bad.driver.initialize()
    bad.driver.start('hello')
    await bad.until(() => bad.fatal.length > 0)
    expect(bad.fatal).toEqual([expect.stringMatching(/^Codex could not switch to its "nope" mode/)])
    expect(bad.requests('session/prompt')).toEqual([])
  })

  it('maps tool calls once each, cuts every event under the limits, and drops thoughts, plans and usage', async () => {
    const t = await setup()
    await t.driver.initialize()
    t.driver.start('TOOLS')
    await t.waiting(1)
    const ev = t.events()
    expect(new Set(ev.map((e) => e.kind))).toEqual(new Set(['status', 'text', 'message', 'tool', 'tool_result', 'finish']))
    const tools = ev.filter((e) => e.kind === 'tool')
    expect(tools.map((e) => (e as { callId: string; name: string }).callId)).toEqual(['call-1', 'call-3', 'call-2'])
    expect(tools[1]).toEqual({ kind: 'tool', callId: 'call-3', name: 'Run ls', input: '{"command":"ls"}' }) // held until its input came
    expect(tools[0]).toMatchObject({ name: 'Edit big.txt' })
    expect((tools[0] as { input: string }).input.length).toBeLessThanOrEqual(INPUT_LIMIT)
    const results = ev.filter((e): e is Extract<NormalizedEvent, { kind: 'tool_result' }> => e.kind === 'tool_result')
    expect(results.map((r) => [r.callId, r.ok])).toEqual([
      ['call-1', true],
      ['call-3', true],
      ['call-2', false],
    ])
    expect(results[1]).toMatchObject({ name: 'Run ls', output: '{"exit":0}' })
    expect(results[0].name).toBe('Edit big.txt')
    expect(results[0].output.startsWith('"--- /x/big.txt\\n+++ /x/big.txt\\nzzz')).toBe(true)
    expect(results[0].output.length).toBeLessThanOrEqual(OUTPUT_LIMIT)
    expect(results[2]).toMatchObject({ name: 'Run false', output: '"exit 1"' })
    // The message before the tools is its own; the long one is cut by bytes.
    const messages = ev.filter((e) => e.kind === 'message').map((e) => (e as { text: string }).text)
    expect(messages[0]).toBe('Looking. ')
    expect(new TextEncoder().encode(messages[1]).length).toBeLessThanOrEqual(TEXT_LIMIT)
    for (const m of t.out) expect(new TextEncoder().encode(serializeLine(m)).length).toBeLessThan(64 * 1024)
  })

  it('answers a permission request with allow_once, as activity, not a prompt', async () => {
    const t = await setup()
    await t.driver.initialize()
    t.driver.start('PERMISSION')
    await t.waiting(1)
    expect(t.events()).toContainEqual({ kind: 'message', text: 'picked once' })
    expect(t.logs).toContainEqual('[worker] permission for Write a.txt: allow_once')
    expect(pickPermission([{ optionId: 'a', kind: 'reject_once' }, { optionId: 'b', kind: 'allow_always' }])).toEqual({ optionId: 'b', kind: 'allow_always' })
    expect(pickPermission([])).toBeNull()
  })

  it('queues messages that arrive during a turn and sends them together as the next', async () => {
    const t = await setup()
    await t.driver.initialize()
    t.driver.start('WAIT first')
    await t.until(() => t.prompts().length === 1)
    t.driver.send('second', 'steer')
    t.driver.send('third', 'queue')
    await t.waiting(1)
    expect(t.prompts()).toEqual(['WAIT first', 'second\n\nthird'])
    // One boundary per prompt; `waiting` only when nothing is left.
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

  it('stops a turn with session/cancel, then ends the agent and reports cancelled', async () => {
    const t = await setup()
    await t.driver.initialize()
    t.driver.start('SLOW')
    await t.until(() => t.events().some((e) => e.kind === 'text'))
    await t.driver.stop(2000)
    expect(t.requests('session/cancel')).toHaveLength(1)
    expect(t.events().at(-1)).toEqual({ kind: 'status', status: 'cancelled' })
    expect(t.child.exitCode !== null || t.child.signalCode !== null).toBe(true)
    expect(t.fatal).toEqual([])
    expect(t.events().some((e) => e.kind === 'error')).toBe(false)
  })

  it('fails with a sentence when the agent exits on its own', async () => {
    const t = await setup()
    await t.driver.initialize()
    t.child.kill('SIGKILL')
    await t.until(() => t.fatal.length > 0)
    expect(t.fatal[0]).toMatch(/^Claude Code stopped unexpectedly \(SIGKILL\)/)
  })
})

describe('resume', () => {
  it('uses session/resume when the agent has it, then waits', async () => {
    const t = await setup()
    await t.driver.initialize()
    t.driver.resume('sess-abc', 4)
    await t.waiting(1)
    expect(t.out[0]).toEqual({ type: 'session', sessionId: 'sess-abc', streamIndex: 4 })
    expect(t.requests('session/resume')[0].params).toMatchObject({ sessionId: 'sess-abc', cwd: folder, systemPrompt: { mode: 'append' } })
    expect(t.requests('session/load')).toEqual([])
    t.driver.send('go on', 'queue')
    await t.waiting(2)
    expect(t.prompts()).toEqual(['go on'])
    expect(t.out.filter((m) => m.type === 'cursor')).toEqual([{ type: 'cursor', streamIndex: 5 }])
  })

  it('falls back to session/load and swallows the replay', async () => {
    const t = await setup({ env: { FAKE_ACP_RESUME: '0' } })
    await t.driver.initialize()
    t.driver.resume('sess-abc', 1)
    await t.waiting(1)
    expect(t.requests('session/load')).toHaveLength(1)
    expect(t.events()).toEqual([{ kind: 'status', status: 'waiting' }])
  })

  it('fails with a sentence with neither, for an id it would not keep, and for a session the agent does not know', async () => {
    const none = await setup({ env: { FAKE_ACP_RESUME: '0', FAKE_ACP_LOAD: '0' } })
    await none.driver.initialize()
    none.driver.resume('sess-abc', 0)
    await none.until(() => none.fatal.length > 0)
    expect(none.fatal[0]).toBe("Claude Code can't pick up a session from an earlier run, so this job can't go on. Start a new job.")

    const bad = await setup()
    await bad.driver.initialize()
    bad.driver.resume('--settings={}', 0)
    expect(bad.fatal).toEqual(["this job can't resume: its session id is not one a worker made"])

    const unknown = await setup()
    await unknown.driver.initialize()
    unknown.driver.resume('other-1', 0)
    await unknown.until(() => unknown.fatal.length > 0)
    expect(unknown.fatal[0]).toMatch(/^Claude Code could not pick up the session: Resource not found/)
    expect(unknown.out.some((m) => m.type === 'session')).toBe(false)
  })
})

describe('the manager tools and the end of a job', () => {
  it("fails with the entry's sign-in sentence when the agent is not signed in, at the session or at a turn", async () => {
    const out = await setup({ env: { FAKE_ACP_SIGNED_OUT: '1' } })
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

  it('emits ask from ask_manager, nudges no one who asked, and reports a refusal as an error', async () => {
    const t = await setup()
    await t.driver.initialize()
    t.driver.start('ASK')
    await t.waiting(1)
    expect(t.events()).toContainEqual({ kind: 'ask', question: 'Which branch?' })
    t.driver.send('REFUSE', 'queue')
    await t.waiting(2)
    expect(t.prompts()).toEqual(['ASK', 'REFUSE'])
    expect(t.events()).toContainEqual({ kind: 'error', message: 'Claude Code refused to go on with this request.' })
  })

  it('sends one follow-up when a turn ends without finish, once per job', async () => {
    const t = await setup()
    await t.driver.initialize()
    t.driver.start('NOFINISH')
    await t.waiting(1)
    expect(t.prompts()).toEqual(['NOFINISH', FINISH_NUDGE])
    expect(t.events()).toContainEqual({ kind: 'finish', summary: 'Finished after the nudge.' })
    t.driver.send('NOFINISH again', 'queue')
    await t.waiting(2)
    expect(t.prompts()).toHaveLength(3) // finish was called in this job: no more follow-ups

    const stubborn = await setup({ env: { FAKE_ACP_IGNORE_NUDGE: '1' } })
    await stubborn.driver.initialize()
    stubborn.driver.start('NOFINISH')
    await stubborn.waiting(1)
    stubborn.driver.send('NOFINISH', 'queue')
    await stubborn.waiting(2)
    expect(stubborn.prompts()).toEqual(['NOFINISH', FINISH_NUDGE, 'NOFINISH'])
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
      expect(t.prompts()[1]).toBe(`[From Native Intelligence] ${allow ? PUSH_NOTES.yes : PUSH_NOTES.no}\n\ngo on`)
      expect(t.prompts()).toHaveLength(2) // the outcome is told with the next message, not as a turn of its own
      t.driver.send('and then', 'queue')
      await t.waiting(2)
      expect(t.prompts()[2]).toBe('and then') // once, never again
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
    expect(t.prompts().slice(1)).toEqual([`[From Native Intelligence] ${PUSH_NOTES.none}\n\ngo on`, 'more'])
    for (const p of t.prompts()) expect(p).not.toMatch(/https?:|was opened/)
    // A finish without a pull request asks nothing and adds nothing.
    const plain = await setup({ mode: 'edit' })
    await plain.driver.initialize()
    plain.driver.start('hello')
    await plain.waiting(1)
    plain.driver.send('next', 'queue')
    await plain.waiting(2)
    expect(plain.prompts()).toEqual(['hello', 'next'])
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

describe('toolOutput', () => {
  it('reads text, resources, diffs and terminals, else the raw output', () => {
    expect(toolOutput({ content: [{ type: 'content', content: { type: 'text', text: 'ok' } }, { type: 'terminal', terminalId: 't' }] })).toBe('"ok\\n[terminal t]"')
    expect(toolOutput({ content: [{ type: 'diff', path: '/a', newText: 'b' }] })).toBe('"--- /a\\n+++ /a\\nb"')
    expect(toolOutput({ rawOutput: { code: 0 } })).toBe('{"code":0}')
    expect(toolOutput({ content: [{ type: 'content', content: { type: 'text', text: 'x'.repeat(50_000) } }] }).length).toBeLessThanOrEqual(OUTPUT_LIMIT)
  })
})
