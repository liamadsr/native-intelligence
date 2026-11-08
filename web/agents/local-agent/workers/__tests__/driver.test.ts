/**
 * The worker driver with the real adapters and fake CLI processes fed the
 * fixtures: the lines the desktop gets, and what is written to the CLI.
 */
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { AdapterContext, CliAdapter, CliProbe } from '../lib/adapter'
import { claudeCodeAdapter } from '../lib/claude-code'
import { codexAdapter } from '../lib/codex'
import { WorkerDriver, type CliProcess } from '../lib/driver'
import type { OutboundMessage } from '../lib/protocol'

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8').split('\n').filter(Boolean)

class FakeProc extends EventEmitter implements CliProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  written = ''
  stdinEnded = false
  constructor(readonly args: string[]) {
    super()
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (d: string) => (this.written += d))
    this.stdin.on('end', () => (this.stdinEnded = true))
  }
  lines(lines: string[]) {
    for (const l of lines) this.stdout.write(`${l}\n`)
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null, stderr = '') {
    if (stderr) this.stderr.write(stderr)
    this.exitCode = code
    this.signalCode = signal
    this.stdout.end()
    setImmediate(() => this.emit('close', code, signal))
  }
  kill(signal: NodeJS.Signals = 'SIGTERM') {
    if (this.exitCode === null && this.signalCode === null) this.exit(null, signal)
    return true
  }
}

const tick = () => new Promise((r) => setTimeout(r, 15))

function setup(adapter: CliAdapter, probe: CliProbe = { version: '1.0.0', flags: new Set(['--replay-user-messages']) }) {
  const out: OutboundMessage[] = []
  const procs: FakeProc[] = []
  const fatal: string[] = []
  const ctx: AdapterContext = {
    launch: { worker: adapter.worker, bin: '/b/cli', binPath: '/b/cli', jobId: 'job1', folder: '/Users/p/app', mode: 'read', toolPath: '/usr/bin', home: '/Users/p', tmpdir: '/t', lang: 'en_US.UTF-8' },
    mcp: { url: 'http://127.0.0.1:4100/mcp', token: 'tok' },
    cliTmp: '/private/tmp/dial8-cli-x',
    cliCwd: '/Users/p/Library/job1/cli',
  }
  const driver = new WorkerDriver(
    adapter,
    ctx,
    probe,
    {
      write: (m) => out.push(m),
      log: () => {},
      spawn: (args) => {
        const p = new FakeProc(args)
        procs.push(p)
        return p
      },
      fatal: (m) => fatal.push(m),
    },
    () => 'aaaaaaaa-1111-4222-8333-444444444444',
  )
  const statuses = () => out.flatMap((m) => (m.type === 'event' && m.event.kind === 'status' ? [m.event.status] : []))
  const kinds = () => out.map((m) => (m.type === 'event' ? m.event.kind : m.type))
  return { driver, out, procs, fatal, statuses, kinds }
}

describe('Claude Code: one process for the session', () => {
  it('starts with its chosen session id, maps the turn, and ends it with the cursor then waiting', async () => {
    const t = setup(claudeCodeAdapter)
    t.driver.start('What does this project do?')
    expect(t.out[0]).toEqual({ type: 'event', event: { kind: 'status', status: 'starting' } })
    expect(t.out[1]).toEqual({ type: 'session', sessionId: 'aaaaaaaa-1111-4222-8333-444444444444', streamIndex: 0 })
    expect(t.procs).toHaveLength(1)
    expect(t.procs[0].args).toContain('--session-id=aaaaaaaa-1111-4222-8333-444444444444')
    await tick()
    expect(JSON.parse(t.procs[0].written)).toMatchObject({ type: 'user', message: { content: 'What does this project do?' } })
    t.procs[0].lines(fixture('claude-code-turn.jsonl'))
    await tick()
    expect(t.statuses()).toEqual(['starting', 'running', 'waiting'])
    const cursorAt = t.out.findIndex((m) => m.type === 'cursor')
    expect(t.out[cursorAt]).toEqual({ type: 'cursor', streamIndex: 1 })
    expect(t.out[cursorAt + 1]).toEqual({ type: 'event', event: { kind: 'status', status: 'waiting' } })
    expect(t.kinds()).toContain('finish')
    expect(t.fatal).toEqual([])
  })

  it('keeps one process: a later message is a stdin line, and a turn runs again', async () => {
    const t = setup(claudeCodeAdapter)
    t.driver.start('first')
    t.procs[0].lines(fixture('claude-code-turn.jsonl'))
    await tick()
    t.driver.send('[From the Dial8 agent] and the tests', 'steer')
    await tick()
    expect(t.procs).toHaveLength(1)
    expect(t.procs[0].written.trim().split('\n')).toHaveLength(2)
    t.procs[0].lines(['{"type":"assistant","message":{"content":[{"type":"text","text":"Sure."}]},"parent_tool_use_id":null}', '{"type":"result","subtype":"success","is_error":false,"queued_turn_count":0}'])
    await tick()
    expect(t.statuses()).toEqual(['starting', 'running', 'waiting', 'running', 'waiting'])
    expect(t.out.filter((m) => m.type === 'cursor')).toEqual([
      { type: 'cursor', streamIndex: 1 },
      { type: 'cursor', streamIndex: 2 },
    ])
  })

  it('stays running across a boundary the CLI says another queued turn follows', async () => {
    const t = setup(claudeCodeAdapter)
    t.driver.start('First')
    t.driver.send('Second', 'queue')
    const lines = fixture('claude-code-queued.jsonl')
    t.procs[0].lines(lines.slice(0, 4)) // up to the first result (queued_turn_count: 1)
    await tick()
    expect(t.statuses()).toEqual(['starting', 'running'])
    t.procs[0].lines(lines.slice(4))
    await tick()
    expect(t.statuses()).toEqual(['starting', 'running', 'waiting'])
  })

  it('without queued_turn_count, uses the replay echoes to see a message not taken up yet', async () => {
    const t = setup(claudeCodeAdapter)
    t.driver.start('First')
    t.driver.send('Second', 'queue')
    await tick()
    t.procs[0].lines(['{"type":"user","message":{"role":"user","content":"First"},"isReplay":true}', '{"type":"result","subtype":"success","is_error":false}'])
    await tick()
    expect(t.statuses()).toEqual(['starting', 'running'])
    t.procs[0].lines(['{"type":"user","message":{"role":"user","content":"Second"},"isReplay":true}', '{"type":"result","subtype":"success","is_error":false}'])
    await tick()
    expect(t.statuses()).toEqual(['starting', 'running', 'waiting'])
  })

  it('resumes idle, and the next message starts the CLI with --resume', async () => {
    const t = setup(claudeCodeAdapter)
    t.driver.resume('99999999-1111-4222-8333-444444444444', 4)
    expect(t.out).toEqual([
      { type: 'session', sessionId: '99999999-1111-4222-8333-444444444444', streamIndex: 4 },
      { type: 'event', event: { kind: 'status', status: 'waiting' } },
    ])
    expect(t.procs).toHaveLength(0)
    t.driver.send('go on', 'queue')
    expect(t.procs[0].args).toContain('--resume=99999999-1111-4222-8333-444444444444')
    t.procs[0].lines(['{"type":"result","subtype":"success","is_error":false}'])
    await tick()
    expect(t.out.find((m) => m.type === 'cursor')).toEqual({ type: 'cursor', streamIndex: 5 })
  })

  it('resumes with --resume when the process went away between turns', async () => {
    const t = setup(claudeCodeAdapter)
    t.driver.start('first')
    t.procs[0].lines(fixture('claude-code-turn.jsonl'))
    await tick()
    t.procs[0].exit(0)
    await tick()
    t.driver.send('again', 'queue')
    expect(t.procs).toHaveLength(2)
    expect(t.procs[1].args).toContain('--resume=aaaaaaaa-1111-4222-8333-444444444444')
    expect(t.fatal).toEqual([])
  })

  it('fails the job when the first process dies before doing anything', async () => {
    const t = setup(claudeCodeAdapter)
    t.driver.start('first')
    t.procs[0].exit(1, null, "error: unknown option '--tools'\n")
    await tick()
    expect(t.fatal).toEqual([expect.stringMatching(/too old/)])
  })

  it('reports a mid-turn crash as an error and goes back to waiting', async () => {
    const t = setup(claudeCodeAdapter)
    t.driver.start('first')
    t.procs[0].lines(fixture('claude-code-turn.jsonl').slice(0, 5))
    await tick()
    t.procs[0].exit(null, 'SIGSEGV')
    await tick()
    expect(t.kinds().slice(-3)).toEqual(['error', 'cursor', 'status'])
    expect(t.statuses().at(-1)).toBe('waiting')
    expect(t.fatal).toEqual([])
  })

  it('kills the job at once on a fence violation', async () => {
    const t = setup(claudeCodeAdapter)
    t.driver.start('first')
    t.procs[0].lines(fixture('claude-code-builtin-tools.jsonl'))
    await tick()
    expect(t.fatal).toEqual([expect.stringMatching(/outside the folder's fence/)])
    expect(t.procs[0].signalCode).toBe('SIGKILL')
  })

  it('answers a control request on stdin', async () => {
    const t = setup(claudeCodeAdapter)
    t.driver.start('first')
    await tick()
    t.procs[0].lines(['{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{}}}'])
    await tick()
    const reply = t.procs[0].written.trim().split('\n').at(-1)!
    expect(JSON.parse(reply)).toMatchObject({ type: 'control_response', response: { request_id: 'r1', response: { behavior: 'deny' } } })
  })

  it('stops by killing the process, then cancelled', async () => {
    const t = setup(claudeCodeAdapter)
    t.driver.start('first')
    await t.driver.stop(200)
    expect(t.procs[0].signalCode).toBe('SIGTERM')
    expect(t.statuses().at(-1)).toBe('cancelled')
  })
})

describe('Codex: one process per turn', () => {
  const probe: CliProbe = { version: '0.48.0', flags: new Set(), features: new Set(['shell_tool']) }

  it('runs the first turn with the instructions on stdin, and takes the thread id as the session', async () => {
    const t = setup(codexAdapter, probe)
    t.driver.start('What does this project do?')
    expect(t.out.some((m) => m.type === 'session')).toBe(false) // the id comes from the CLI
    await tick()
    expect(t.procs[0].stdinEnded).toBe(true)
    expect(t.procs[0].written).toMatch(/^# Working for Native Intelligence[\s\S]*What does this project do\?$/)
    expect(t.procs[0].args).not.toContain('resume')
    t.procs[0].lines(fixture('codex-turn.jsonl'))
    await tick()
    expect(t.out.find((m) => m.type === 'session')).toEqual({ type: 'session', sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53', streamIndex: 0 })
    expect(t.statuses()).toEqual(['starting', 'running']) // the boundary is the exit
    t.procs[0].exit(0)
    await tick()
    expect(t.out.slice(-2)).toEqual([
      { type: 'cursor', streamIndex: 1 },
      { type: 'event', event: { kind: 'status', status: 'waiting' } },
    ])
  })

  it('holds messages sent during a turn, then runs them together as the next turn on the same thread', async () => {
    const t = setup(codexAdapter, probe)
    t.driver.start('first')
    t.driver.send('[From Liam] also check the tests', 'steer')
    t.driver.send('[From the Dial8 agent] and the docs', 'queue')
    expect(t.procs).toHaveLength(1)
    t.procs[0].lines(fixture('codex-turn.jsonl'))
    t.procs[0].exit(0)
    await tick()
    expect(t.procs).toHaveLength(2)
    expect(t.procs[1].args.slice(-3)).toEqual(['resume', '0199a213-81c0-7800-8aa1-bbab2a035a53', '-'])
    await tick()
    expect(t.procs[1].written).toBe('[From Liam] also check the tests\n\n[From the Dial8 agent] and the docs')
    expect(t.statuses()).toEqual(['starting', 'running']) // still running into the next turn
    t.procs[1].lines(['{"type":"turn.started"}', '{"type":"turn.completed","usage":{}}'])
    t.procs[1].exit(0)
    await tick()
    expect(t.statuses()).toEqual(['starting', 'running', 'waiting'])
    expect(t.out.filter((m) => m.type === 'cursor').map((m) => (m as { streamIndex: number }).streamIndex)).toEqual([1, 2])
  })

  it('a failed login ends the turn with the sign-in sentence, not the job', async () => {
    const t = setup(codexAdapter, probe)
    t.driver.start('first')
    t.procs[0].lines(fixture('codex-auth-failed.jsonl'))
    t.procs[0].exit(1)
    await tick()
    expect(t.fatal).toEqual([])
    expect(t.statuses().at(-1)).toBe('waiting')
    expect(t.out.some((m) => m.type === 'event' && m.event.kind === 'error' && /codex login/.test(m.event.message))).toBe(true)
  })

  it('fails the job when the first turn dies before the thread exists', async () => {
    const t = setup(codexAdapter, probe)
    t.driver.start('first')
    t.procs[0].exit(1, null, 'Error: MCP client for `dial8_folder` failed to start\n')
    await tick()
    expect(t.fatal).toEqual([expect.stringMatching(/couldn't reach the folder's tools/)])
  })

  it('kills the job when Codex runs a command of its own', async () => {
    const t = setup(codexAdapter, probe)
    t.driver.start('first')
    t.procs[0].lines(fixture('codex-shell.jsonl'))
    await tick()
    expect(t.fatal).toEqual([expect.stringMatching(/ran a command of its own/)])
  })

  it('a later message after resume starts a resumed turn', async () => {
    const t = setup(codexAdapter, probe)
    t.driver.resume('0199c000-0000-7000-8000-000000000007', 2)
    t.driver.send('more', 'queue')
    expect(t.procs[0].args.slice(-3)).toEqual(['resume', '0199c000-0000-7000-8000-000000000007', '-'])
    await tick()
    expect(t.procs[0].written).toBe('more')
  })
})

describe('session ids from outside', () => {
  it.each(['-x', '--settings={"hooks":{}}', '--last', '--mcp-config=/tmp/x.json', 'AAAAAAAA-1111-4222-8333-444444444444', 'abc', ''])('refuses to resume %j (it would be a CLI argument)', (id) => {
    for (const adapter of [claudeCodeAdapter, codexAdapter]) {
      const t = setup(adapter, adapter === codexAdapter ? { version: '0.48.0', flags: new Set(), features: new Set(['shell_tool']) } : undefined)
      t.driver.resume(id, 0)
      expect(t.fatal).toEqual([expect.stringMatching(/session id is not one a worker made/)])
      t.driver.send('go', 'queue')
      expect(t.procs).toHaveLength(0)
    }
  })

  it("stops a Codex that reports a thread id that isn't a UUID", async () => {
    const t = setup(codexAdapter, { version: '0.48.0', flags: new Set(), features: new Set(['shell_tool']) })
    t.driver.start('first')
    t.procs[0].lines(['{"type":"thread.started","thread_id":"--last"}'])
    await tick()
    expect(t.fatal).toEqual([expect.stringMatching(/isn't a UUID/)])
    expect(t.out.some((m) => m.type === 'session')).toBe(false)
  })
})

describe('protocol errors', () => {
  it('refuses a second start and a send before any session', () => {
    const t = setup(claudeCodeAdapter)
    t.driver.send('hi', 'queue')
    expect(t.out).toEqual([{ type: 'event', event: { kind: 'error', message: expect.stringMatching(/no session yet/) } }])
    t.driver.start('a')
    t.driver.start('b')
    expect(t.out.at(-1)).toEqual({ type: 'event', event: { kind: 'error', message: 'this job already has a session' } })
  })
})
