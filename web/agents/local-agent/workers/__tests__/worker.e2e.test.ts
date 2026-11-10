/**
 * The whole worker on darwin, as the desktop runs it: the bundled adapter
 * (build.sh's esbuild settings) spawned with the desktop's environment, the
 * real fence (sandbox-exec), the real MCP server on 127.0.0.1 and the real
 * CLI profile, around a stand-in CLI (fixtures/fake-cli.mjs) installed in a
 * FAKE home. The stand-in calls the fence tools for real and probes its own
 * profile. No vendor CLI and no model.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const onMac = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')
const WORKERS = join(__dirname, '..')

type Line = Record<string, unknown> & { type: string }

/** One worker process and the lines it wrote. */
class Worker {
  readonly lines: Line[] = []
  readonly raw: string[] = []
  stderr = ''
  readonly exited: Promise<number | null>
  private waiters: { test: (l: Line) => boolean; resolve: (l: Line) => void }[] = []
  constructor(readonly child: ChildProcess) {
    let buf = ''
    child.stdout!.setEncoding('utf8').on('data', (d: string) => {
      buf += d
      for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
        const raw = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        this.raw.push(raw)
        const line = JSON.parse(raw) as Line
        this.lines.push(line)
        this.waiters = this.waiters.filter((w) => (w.test(line) ? (w.resolve(line), false) : true))
      }
    })
    child.stderr!.setEncoding('utf8').on('data', (d: string) => (this.stderr += d))
    this.exited = new Promise((r) => child.once('exit', (code) => r(code)))
  }
  send(o: unknown) {
    this.child.stdin!.write(`${JSON.stringify(o)}\n`)
  }
  next(test: (l: Line) => boolean, timeoutMs = 20_000): Promise<Line> {
    const seen = this.lines.find(test)
    if (seen) return Promise.resolve(seen)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out; lines: ${this.raw.join('\n')}\nstderr: ${this.stderr}`)), timeoutMs)
      this.waiters.push({ test, resolve: (l) => (clearTimeout(timer), resolve(l)) })
    })
  }
  /** The nth `waiting` status (1-based). */
  waiting(n: number) {
    return this.next(() => this.events().filter((e) => e.kind === 'status' && e.status === 'waiting').length >= n)
  }
  events(): Record<string, unknown>[] {
    return this.lines.flatMap((l) => (l.type === 'event' ? [l.event as Record<string, unknown>] : []))
  }
}

describe.runIf(onMac)('a worker job end to end (darwin)', { timeout: 120_000 }, () => {
  let root: string
  let home: string
  let folder: string
  let toolPath: string
  let bundle: string
  let other: Server
  let otherPort: number
  const workers: Worker[] = []

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'la-worker-e2e-')))
    home = join(root, 'home')
    folder = join(home, 'project')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'README.md'), '# Demo project\n')
    writeFileSync(join(home, 'secret.txt'), 'home-secret-value\n')
    // node for the stand-in's `#!/usr/bin/env node`, on a tool PATH dir under the fake HOME (an APFS clone).
    const nodeBin = join(home, '.nodebin')
    mkdirSync(nodeBin)
    try {
      execFileSync('/bin/cp', ['-c', process.execPath, join(nodeBin, 'node')])
    } catch {
      copyFileSync(process.execPath, join(nodeBin, 'node'))
    }
    toolPath = `${nodeBin}:/usr/bin:/bin`
    for (const where of ['.local/share/claude/versions/claude-fake.mjs', '.npm-global/lib/node_modules/@openai/codex/bin/codex.js']) {
      mkdirSync(dirname(join(home, where)), { recursive: true })
      copyFileSync(join(__dirname, 'fixtures', 'fake-cli.mjs'), join(home, where))
      chmodSync(join(home, where), 0o755)
    }
    bundle = join(root, 'bundle')
    for (const worker of ['claude-code', 'codex']) {
      await build({
        entryPoints: [join(WORKERS, `${worker}.ts`)],
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node24',
        logLevel: 'warning',
        banner: { js: "import { createRequire as __niRequire } from 'node:module'; const require = __niRequire(import.meta.url);" },
        outfile: join(bundle, 'workers', `${worker}.mjs`),
      })
    }
    other = createServer((_q, r) => r.end('other'))
    otherPort = await new Promise<number>((r) => other.listen(0, '127.0.0.1', () => r((other.address() as AddressInfo).port)))
  })

  afterAll(async () => {
    for (const w of workers) w.child.kill('SIGKILL')
    other?.close()
    rmSync(root, { recursive: true, force: true })
  })

  function launch(worker: 'claude-code' | 'codex', jobId: string, extra: Record<string, string> = {}): Worker {
    const jobDir = join(home, 'Library/Application Support/ni-test/jobs', jobId)
    const tmp = join(root, 'tmp', jobId)
    mkdirSync(jobDir, { recursive: true })
    mkdirSync(tmp, { recursive: true })
    const bin = worker === 'claude-code' ? join(home, '.local/share/claude/versions/claude-fake.mjs') : join(home, '.npm-global/lib/node_modules/@openai/codex/bin/codex.js')
    const env: Record<string, string> = {
      HOME: home,
      TMPDIR: tmp,
      LANG: 'en_US.UTF-8',
      PATH: toolPath,
      LOCAL_AGENT_JOB_ID: jobId,
      LOCAL_AGENT_FOLDER: folder,
      LOCAL_AGENT_MODE: 'read',
      LOCAL_AGENT_TOOL_PATH: toolPath,
      LOCAL_AGENT_DIR: bundle,
      LOCAL_AGENT_WORKER: worker,
      LOCAL_AGENT_WORKER_BIN: bin,
      ...extra,
    }
    const w = new Worker(spawn(process.execPath, [join(bundle, 'workers', `${worker}.mjs`)], { cwd: jobDir, env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] }))
    workers.push(w)
    return w
  }

  const text = (w: Worker) => w.raw.join('\n')

  it('Claude Code: a read job in the fence, a second message in the same process, a token line ignored, a stop', async () => {
    const w = launch('claude-code', 'jobclaude1')
    expect(await w.next((l) => l.type === 'ready')).toEqual({ type: 'ready', port: 0, worker: 'claude-code', workerVersion: '9.9.9' })
    w.send({ type: 'start', request: `probe ${otherPort} ${folder}` })
    const session = await w.next((l) => l.type === 'session')
    expect(session.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    await w.waiting(1)

    const ev = w.events()
    expect(ev.find((e) => e.kind === 'report')).toEqual({ kind: 'report', text: 'Looking around.' })
    const bash = ev.find((e) => e.kind === 'tool_result' && e.name === 'bash')!
    expect(bash.output).toMatch(/Operation not permitted/) // the fence refused the HOME read and the write
    expect(ev.find((e) => e.kind === 'tool_result' && e.name === 'read_file')).toMatchObject({ ok: true, output: JSON.stringify('# Demo project\n') })
    expect(ev.find((e) => e.kind === 'tool_result' && e.name === 'write_file')).toMatchObject({ ok: false, output: expect.stringMatching(/read-only/) })
    // The CLI's own profile: no direct read of HOME, no other local port.
    const probe = ev.find((e) => e.kind === 'message' && String(e.text).startsWith('direct read'))!
    expect(probe.text).toMatch(/^direct read: EPERM; folder read: EPERM; other port: refused; cwd: .+\/jobs\/jobclaude1\/cli; tmp: \/private\/tmp\/dial8-cli-/)
    expect(ev.find((e) => e.kind === 'finish')).toEqual({ kind: 'finish', summary: 'Looked around.' })
    expect(existsSync(join(folder, 'new.txt'))).toBe(false)
    expect(text(w)).not.toContain('home-secret-value')
    const cursor = w.lines.findIndex((l) => l.type === 'cursor')
    expect(w.lines[cursor]).toEqual({ type: 'cursor', streamIndex: 1 })
    expect(w.lines[cursor + 1]).toEqual({ type: 'event', event: { kind: 'status', status: 'waiting' } })

    w.send({ type: 'token', modelToken: 'la1.not-for-a-worker-0123456789' })
    w.send({ type: 'send', text: 'second', policy: 'steer' })
    await w.waiting(2)
    expect(w.events().some((e) => e.kind === 'message' && e.text === 'same process: second')).toBe(true)
    expect(w.events().some((e) => e.kind === 'error')).toBe(false)

    w.send({ type: 'stop' })
    expect(await w.exited).toBe(0)
    expect(w.events().at(-1)).toEqual({ kind: 'status', status: 'cancelled' })
    const cliTmp = /tmp: (\/private\/tmp\/dial8-cli-[A-Za-z0-9]+)/.exec(String(probe.text))![1]
    expect(existsSync(cliTmp)).toBe(false) // the CLI's temp folder (its MCP config and bearer) is gone
  })

  it('Claude Code: a relaunch resumes the session by id', async () => {
    const w = launch('claude-code', 'jobclaude2')
    await w.next((l) => l.type === 'ready')
    w.send({ type: 'resume', sessionId: '11111111-2222-4333-8444-555555555555', streamIndex: 3 })
    expect(await w.next((l) => l.type === 'session')).toEqual({ type: 'session', sessionId: '11111111-2222-4333-8444-555555555555', streamIndex: 3 })
    await w.waiting(1)
    w.send({ type: 'send', text: 'go on', policy: 'queue' })
    await w.waiting(2)
    expect(w.events().some((e) => e.kind === 'message' && e.text === 'resumed: go on')).toBe(true)
    expect(await w.next((l) => l.type === 'cursor')).toEqual({ type: 'cursor', streamIndex: 4 })
    w.child.stdin!.end() // the app went away
    expect(await w.exited).toBe(0)
  })

  it('Codex: a turn per process, the thread id as the session, the next turn resumes it', async () => {
    const w = launch('codex', 'jobcodex1')
    expect(await w.next((l) => l.type === 'ready')).toEqual({ type: 'ready', port: 0, worker: 'codex', workerVersion: '9.9.9' })
    w.send({ type: 'start', request: `probe ${otherPort} ${folder}` })
    expect(await w.next((l) => l.type === 'session')).toEqual({ type: 'session', sessionId: '0199b000-0000-7000-8000-000000000001', streamIndex: 0 })
    await w.waiting(1)
    const ev = w.events()
    expect(ev.find((e) => e.kind === 'tool_result' && e.name === 'bash')!.output).toMatch(/Operation not permitted/)
    expect(ev.find((e) => e.kind === 'message')!.text).toMatch(/^direct read: EPERM; folder read: EPERM; other port: refused; cwd: .+\/jobs\/jobcodex1\/cli;/)
    expect(ev.find((e) => e.kind === 'finish')).toEqual({ kind: 'finish', summary: 'Done.' })
    expect(text(w)).not.toContain('home-secret-value')

    w.send({ type: 'send', text: 'and the tests', policy: 'queue' })
    await w.waiting(2)
    expect(w.events().some((e) => e.kind === 'message' && e.text === 'turn on the same thread: and the tests')).toBe(true)
    w.send({ type: 'stop' })
    expect(await w.exited).toBe(0)
  })

  it('refuses a second adapter for the same job, and a worker on a Mac set to a local model', async () => {
    const a = launch('claude-code', 'jobclaude3')
    await a.next((l) => l.type === 'ready')
    const b = launch('claude-code', 'jobclaude3')
    expect(await b.next((l) => l.type === 'fatal')).toEqual({ type: 'fatal', message: 'job already running' })
    expect(await b.exited).toBe(1)
    a.send({ type: 'stop' })
    await a.exited
    const local = launch('codex', 'jobcodex2', { LOCAL_AGENT_LOCAL_MODEL_BASE_URL: 'http://127.0.0.1:11434/v1', LOCAL_AGENT_LOCAL_MODEL_ID: 'qwen3' })
    expect(await local.next((l) => l.type === 'fatal')).toEqual({ type: 'fatal', message: expect.stringMatching(/keep the model on the Mac/) })
    expect(await local.exited).toBe(1)
  })

  it('ends quietly on a stop before ready; drops an overlong line; refuses a session id that is not a UUID', async () => {
    const early = launch('codex', 'jobcodex3')
    early.send({ type: 'stop' }) // read before the probe starts
    expect(await early.exited).toBe(0)
    expect(early.lines.filter((l) => l.type === 'ready' || l.type === 'fatal')).toEqual([])

    const w = launch('claude-code', 'jobclaude4')
    await w.next((l) => l.type === 'ready')
    w.child.stdin!.write(`${JSON.stringify({ type: 'send', text: 'x'.repeat(300 * 1024), policy: 'queue' })}\n`)
    expect(await w.next((l) => l.type === 'event' && (l.event as { kind: string }).kind === 'error')).toEqual({
      type: 'event',
      event: { kind: 'error', message: expect.stringMatching(/longer than 262144 bytes and was dropped/) },
    })
    w.send({ type: 'resume', sessionId: '--settings={"hooks":{}}', streamIndex: 0 })
    expect(await w.next((l) => l.type === 'fatal')).toEqual({ type: 'fatal', message: expect.stringMatching(/session id is not one a worker made/) })
    expect(await w.exited).toBe(1)
    expect(w.lines.some((l) => l.type === 'session')).toBe(false)
  })

  // (The probe runner also refuses a step once the stop is in, for a step whose exit was already queued when the stop
  // came; that window is microtasks wide and isn't reproduced here.)
  it('a stop during the probe kills it, ends without ready or fatal, and removes the CLI temp folder', async () => {
    const state = join(home, '.claude')
    const log = join(state, 'probe-log')
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, 'slow-probe'), '')
    try {
      const w = launch('claude-code', 'jobclaude5')
      for (let i = 0; i < 200 && !existsSync(log); i++) await new Promise((r) => setTimeout(r, 50))
      w.send({ type: 'stop' })
      expect(await w.exited).toBe(0)
      expect(w.lines.filter((l) => l.type === 'ready' || l.type === 'fatal')).toEqual([])
      await new Promise((r) => setTimeout(r, 1500)) // a step started after the stop would have logged by now
      const steps = readFileSync(log, 'utf8').trim().split('\n')
      expect(steps.map((s) => s.split(' ')[0])).toEqual(['--version'])
      const cliTmp = steps[0].split(' ')[1]
      expect(cliTmp).toMatch(/^\/private\/tmp\/dial8-cli-/)
      expect(existsSync(cliTmp)).toBe(false)
    } finally {
      rmSync(join(state, 'slow-probe'), { force: true })
      rmSync(log, { force: true })
    }
  })
})
