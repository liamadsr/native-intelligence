/**
 * The whole worker on darwin, as the desktop runs it: the bundled adapter
 * (build.sh's esbuild settings) spawned with the desktop's environment, the
 * real profile around a stand-in ACP agent (fixtures/fake-acp-agent.mjs,
 * installed where install-agents.sh puts the real ones), the real MCP server
 * and, for the agent that takes no HTTP MCP server, the real stdio proxy.
 * A FAKE home, with stand-in CLIs, keychain folder and login file. No vendor
 * agent and no model.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FINISH_NUDGE, WORKER_INSTRUCTIONS } from '../lib/instructions'

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
  let worktree: string
  let repoGit: string
  let acpDir: string
  let toolPath: string
  let bundle: string
  let other: Server
  let otherPort: number
  const workers: Worker[] = []
  const appData = () => join(home, 'Library/Application Support/ni-test/local-agent')
  /** A job's private home: `<job dir>/home`. */
  const agentHome = (jobId: string) => join(appData(), 'jobs', jobId, 'home')
  const bins = () => ({ 'claude-code': join(home, '.local/bin/claude'), codex: join(home, '.npm-global/bin/codex') })

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'la-worker-e2e-')))
    home = join(root, 'home')
    const put = (path: string, body: string, mode = 0o644) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, body, { mode })
    }
    folder = join(home, 'project')
    put(join(folder, 'README.md'), '# Demo project\n')
    put(join(folder, '.env'), 'TOKEN=folder-secret-value\n')
    put(join(home, 'secret.txt'), 'home-secret-value\n')
    put(join(home, 'Library/Keychains/login.keychain-db'), 'kc')
    put(join(home, '.codex/auth.json'), '{"demo":true}')
    put(join(home, '.codex/config.toml'), 'notify = ["/bin/echo"]\n')
    // The CLIs, as the desktop finds them: a native install behind a ~/.local/bin link, and an npm global script.
    put(join(home, '.local/share/claude/versions/9.9.9'), '#!/bin/sh\necho "9.9.9 (Claude Code)"\n', 0o755)
    mkdirSync(dirname(bins()['claude-code']), { recursive: true })
    symlinkSync(join(home, '.local/share/claude/versions/9.9.9'), bins()['claude-code'])
    put(join(home, '.npm-global/lib/node_modules/@openai/codex/bin/codex.js'), '#!/bin/sh\necho "codex-cli 9.9.9"\n', 0o755)
    mkdirSync(dirname(bins().codex), { recursive: true })
    symlinkSync('../lib/node_modules/@openai/codex/bin/codex.js', bins().codex)
    // The ACP adapters, where install-agents.sh would put them.
    acpDir = join(root, 'acp')
    for (const pkg of ['claude-agent-acp', 'codex-acp']) {
      const to = join(acpDir, 'node_modules/@agentclientprotocol', pkg, 'dist/index.js')
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(join(__dirname, 'fixtures', 'fake-acp-agent.mjs'), to)
    }
    // A repository and the job's worktree, made outside the sandbox as the desktop does.
    const repo = join(home, 'repo')
    put(join(repo, 'README.md'), '# Repo\n')
    const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: repo, stdio: 'ignore' })
    git('init', '-q', '-b', 'main')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    worktree = join(home, 'wt')
    git('worktree', 'add', '-q', '-b', 'job', worktree)
    repoGit = realpathSync(join(repo, '.git'))
    toolPath = '/usr/bin:/bin'
    bundle = join(root, 'bundle')
    await build({
      entryPoints: [join(WORKERS, 'acp.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      logLevel: 'warning',
      banner: { js: "import { createRequire as __niRequire } from 'node:module'; const require = __niRequire(import.meta.url);" },
      outfile: join(bundle, 'workers', 'acp.mjs'),
    })
    other = createServer((_q, r) => r.end('other'))
    otherPort = await new Promise<number>((r) => other.listen(0, '127.0.0.1', () => r((other.address() as AddressInfo).port)))
  })

  afterAll(async () => {
    for (const w of workers) w.child.kill('SIGKILL')
    other?.close()
    rmSync(root, { recursive: true, force: true })
  })

  function launch(worker: 'claude-code' | 'codex', jobId: string, extra: Record<string, string> = {}): Worker {
    const jobDir = join(appData(), 'jobs', jobId)
    // The desktop's fence markers for this job.
    const fence = join(appData(), 'fence')
    mkdirSync(fence, { recursive: true })
    for (const f of [jobId, `${jobId}.open`]) writeFileSync(join(fence, f), '')
    const tmp = join(root, 'tmp', jobId)
    mkdirSync(jobDir, { recursive: true })
    mkdirSync(tmp, { recursive: true })
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
      LOCAL_AGENT_WORKER_BIN: bins()[worker],
      LOCAL_AGENT_ACP_DIR: acpDir,
      LOCAL_AGENT_FENCE_DIR: fence,
      ...extra,
    }
    const w = new Worker(spawn(process.execPath, [join(bundle, 'workers', 'acp.mjs')], { cwd: jobDir, env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] }))
    workers.push(w)
    return w
  }

  const text = (w: Worker) => w.raw.join('\n')
  const requests = (jobId: string) =>
    readFileSync(join(agentHome(jobId), 'fake-acp.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { method: string; params: Record<string, unknown> })
  const probe = (ops: unknown[]) => `PROBE ${JSON.stringify(ops)}`
  const probeResults = (w: Worker) => JSON.parse(String(w.events().find((e) => e.kind === 'message' && String(e.text).startsWith('['))!.text)) as string[]

  it('Claude Code: a read job inside the fence, over HTTP MCP, a second turn, a token line ignored, a stop', async () => {
    const w = launch('claude-code', 'jobclaude1')
    expect(await w.next((l) => l.type === 'ready')).toEqual({ type: 'ready', port: 0, worker: 'claude-code', workerVersion: '9.9.9' })
    const kc = join(agentHome('jobclaude1'), 'Library/Keychains')
    w.send({
      type: 'start',
      request: probe([
        { cwd: true },
        { read: join(home, 'secret.txt') },
        { read: join(folder, 'README.md') },
        { read: join(folder, '.env') },
        { write: join(folder, 'new.txt') },
        { connect: otherPort },
        { connect: 80, host: '192.0.2.1' },
        { listen: '127.0.0.1' },
        { listen: '0.0.0.0' },
        { exec: [bins()['claude-code'], '--version'] },
        { list: kc },
        { write: join(kc, 'probe') },
        { read: join(home, '.codex/auth.json') },
        { env: 'NO_BROWSER' },
        { env: 'CLAUDE_CODE_EXECUTABLE' },
        { env: 'CLAUDE_CODE_TMPDIR' },
        { env: 'HOME' },
        { server: true },
        { spawn: true },
      ]),
    })
    const session = await w.next((l) => l.type === 'session')
    expect(session.sessionId).toMatch(/^sess-/)
    await w.waiting(1)
    expect(probeResults(w)).toEqual([
      `cwd ${folder}`,
      'EPERM', // the real HOME
      'read 15 bytes',
      'EPERM', // the folder's .env
      'EPERM', // a read job writes nothing
      'connected', // a server on this Mac's loopback, not the agent's (the accepted cost)
      'EPERM', // plain HTTP to another machine
      'listening', // on loopback
      'listening', // on the wildcard address (the accepted cost: reachable from the network while the job runs)
      'exec: 9.9.9 (Claude Code)',
      'listed 1', // the keychain, through the home's link
      'wrote',
      'EPERM', // another agent's login file
      'env NO_BROWSER=1',
      `env CLAUDE_CODE_EXECUTABLE=${realpathSync(bins()['claude-code'])}`,
      expect.stringMatching(/^env CLAUDE_CODE_TMPDIR=\/private\/tmp\/dial8-acp-[A-Za-z0-9]+$/),
      `env HOME=${agentHome('jobclaude1')}`,
      expect.stringMatching(/^server \d+$/),
      expect.stringMatching(/^pids \d+ \d+$/),
    ])
    const agentTmp = probeResults(w).at(-4)!.slice('env CLAUDE_CODE_TMPDIR='.length)
    // A server it left listening, a child that left its process group, and one that stayed: all must die at the stop.
    const pids = [...probeResults(w).at(-1)!.split(' ').slice(1), probeResults(w).at(-2)!.split(' ')[1]].map(Number)
    for (const pid of pids) expect(() => process.kill(pid, 0)).not.toThrow() // alive while the job runs
    expect(existsSync(agentTmp)).toBe(true)
    const ev = w.events()
    expect(ev).toContainEqual({ kind: 'report', text: 'probed over http' })
    expect(ev).toContainEqual({ kind: 'finish', summary: 'Probed.' })
    expect(existsSync(join(folder, 'new.txt'))).toBe(false)
    expect(text(w)).not.toMatch(/home-secret-value|folder-secret-value/)
    const cursor = w.lines.findIndex((l) => l.type === 'cursor')
    expect(w.lines[cursor]).toEqual({ type: 'cursor', streamIndex: 1 })
    expect(w.lines[cursor + 1]).toEqual({ type: 'event', event: { kind: 'status', status: 'waiting' } })
    // The session: the folder, the HTTP server with its bearer, the instructions as a system prompt.
    const created = requests('jobclaude1').find((r) => r.method === 'session/new')!.params
    expect(created).toMatchObject({ cwd: folder, mcpServers: [{ type: 'http', name: 'ni', headers: [{ name: 'Authorization' }] }] })
    expect((created.systemPrompt as { content: { text: string }[] }).content[0].text.startsWith(WORKER_INSTRUCTIONS)).toBe(true)

    w.send({ type: 'token', modelToken: 'la1.not-for-a-worker-0123456789' })
    w.send({ type: 'send', text: 'second', policy: 'steer' })
    await w.waiting(2)
    expect(w.events()).toContainEqual({ kind: 'message', text: 'got: second (mode default)' })
    expect(w.events().some((e) => e.kind === 'error')).toBe(false)

    w.send({ type: 'stop' })
    expect(await w.exited).toBe(0)
    expect(w.events().at(-1)).toEqual({ kind: 'status', status: 'cancelled' })
    expect(existsSync(agentTmp)).toBe(false) // its temp folder (its sockets) is gone
    // Every process the agent started died with the job, the one that left its process group too.
    for (const pid of pids) expect(() => process.kill(pid, 0), String(pid)).toThrow()
  })

  it('Codex: an edit job over the stdio proxy, its mode set, no commit possible; a relaunch picks the session up by session/load', async () => {
    const w = launch('codex', 'jobcodex1', { LOCAL_AGENT_FOLDER: worktree, LOCAL_AGENT_MODE: 'edit', LOCAL_AGENT_EXTRA_READ: repoGit })
    expect(await w.next((l) => l.type === 'ready')).toMatchObject({ worker: 'codex' })
    const own = join(agentHome('jobcodex1'), '.codex')
    const realAuth = join(home, '.codex/auth.json')
    const authBefore = readFileSync(realAuth, 'utf8')
    w.send({
      type: 'start',
      request: probe([
        { write: join(worktree, 'new.txt') },
        { write: join(worktree, '.git') },
        { write: join(worktree, '.mcp.json') },
        { exec: ['/usr/bin/git', '-C', worktree, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '--allow-empty', '-qm', 'x'] },
        { read: join(own, 'auth.json') },
        { write: join(own, 'auth.json'), content: '{"demo":2}' },
        { read: join(home, '.codex/config.toml') },
        { write: join(home, '.codex/config.toml') },
        { write: join(home, '.codex/refreshed.json') },
        { write: join(own, 'config.toml') },
        { list: join(agentHome('jobcodex1'), 'Library/Keychains') },
        { read: join(home, 'secret.txt') },
      ]),
    })
    const session = await w.next((l) => l.type === 'session')
    await w.waiting(1)
    const results = probeResults(w)
    expect(results.slice(0, 3)).toEqual(['wrote', 'EPERM', 'EPERM'])
    expect(results[3]).toMatch(/^status [1-9]/) // git can't write the repository
    // Its login file, through the link, read and saved; nothing else of the person's Codex folder; its own config denied by name.
    expect(results.slice(4)).toEqual(['read 13 bytes', 'wrote', 'EPERM', 'EPERM', 'EPERM', 'EPERM', 'ENOENT', 'EPERM'])
    expect(readFileSync(join(worktree, 'new.txt'), 'utf8')).toBe('x')
    expect(readFileSync(realAuth, 'utf8')).toBe('{"demo":2}')
    expect(existsSync(join(home, '.codex/refreshed.json'))).toBe(false)
    expect(readFileSync(join(home, '.codex/config.toml'), 'utf8')).toBe('notify = ["/bin/echo"]\n')
    writeFileSync(realAuth, authBefore)
    expect(lstatSync(join(own, 'auth.json')).isSymbolicLink()).toBe(true)
    expect(execFileSync('/usr/bin/git', ['log', '--oneline', 'job'], { cwd: worktree, encoding: 'utf8' }).trim().split('\n')).toHaveLength(1)
    expect(w.events()).toContainEqual({ kind: 'report', text: 'probed over stdio' })
    const log = requests('jobcodex1')
    expect(log.find((r) => r.method === 'session/set_mode')!.params).toMatchObject({ modeId: 'agent-full-access' })
    const created = log.find((r) => r.method === 'session/new')!.params
    expect(created.systemPrompt).toBeUndefined()
    expect((created.mcpServers as { args: string[] }[])[0].args.at(-1)).toBe('--mcp-proxy')
    const firstPrompt = (log.find((r) => r.method === 'session/prompt')!.params.prompt as { text: string }[])[0].text
    expect(firstPrompt.startsWith(WORKER_INSTRUCTIONS)).toBe(true)
    expect(firstPrompt).toContain('This job may change files')
    w.child.stdin!.end() // the app went away
    expect(await w.exited).toBe(0)

    const again = launch('codex', 'jobcodex1', { LOCAL_AGENT_FOLDER: worktree, LOCAL_AGENT_MODE: 'edit', LOCAL_AGENT_EXTRA_READ: repoGit })
    await again.next((l) => l.type === 'ready')
    again.send({ type: 'resume', sessionId: session.sessionId, streamIndex: 1 })
    expect(await again.next((l) => l.type === 'session')).toEqual({ type: 'session', sessionId: session.sessionId, streamIndex: 1 })
    await again.waiting(1)
    again.send({ type: 'send', text: 'go on', policy: 'queue' })
    await again.waiting(2)
    // The replay of the old session never reached the desktop; the mode was set again.
    expect(again.events().some((e) => String(e.text ?? e.name ?? '').match(/an old reply|Old tool/))).toBe(false)
    expect(again.events()).toContainEqual({ kind: 'message', text: 'got: go on (mode agent-full-access)' })
    expect(await again.next((l) => l.type === 'cursor')).toEqual({ type: 'cursor', streamIndex: 2 })
    again.send({ type: 'stop' })
    expect(await again.exited).toBe(0)
  })

  it('nudges once when a turn ends without finish', async () => {
    const w = launch('claude-code', 'jobclaude2')
    await w.next((l) => l.type === 'ready')
    w.send({ type: 'start', request: 'NOFINISH' })
    await w.waiting(1)
    const prompts = requests('jobclaude2').filter((r) => r.method === 'session/prompt').map((r) => (r.params.prompt as { text: string }[])[0].text)
    expect(prompts.slice(-2)).toEqual(['NOFINISH', FINISH_NUDGE])
    expect(w.events()).toContainEqual({ kind: 'finish', summary: 'Finished after the nudge.' })
    w.send({ type: 'stop' })
    expect(await w.exited).toBe(0)
  })

  it("gives each job its own home, which another job can't read or write", async () => {
    const w = launch('claude-code', 'jobclaude6')
    await w.next((l) => l.type === 'ready')
    w.send({ type: 'start', request: probe([{ list: agentHome('jobclaude1') }, { read: join(agentHome('jobclaude1'), 'fake-acp.log') }, { write: join(agentHome('jobclaude1'), 'CLAUDE.md') }, { env: 'HOME' }]) })
    await w.waiting(1)
    expect(probeResults(w)).toEqual(['EPERM', 'EPERM', 'EPERM', `env HOME=${agentHome('jobclaude6')}`])
    w.send({ type: 'stop' })
    expect(await w.exited).toBe(0)
  })

  /** `acp.mjs --return-logins` as the desktop runs it after its sweep: unsandboxed, cwd the job dir. */
  const returnLogins = (jobId: string, env: Record<string, string>) => {
    const started = Date.now()
    const r = spawnSync(process.execPath, [join(bundle, 'workers', 'acp.mjs'), '--return-logins'], { cwd: join(appData(), 'jobs', jobId), env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 10_000 })
    return { code: r.status, lines: r.stdout.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>), ms: Date.now() - started }
  }

  it("leaves a login the agent saved beside its link for --return-logins, which puts it onto the person's own and relinks", async () => {
    const realAuth = join(home, '.codex/auth.json')
    const before = readFileSync(realAuth, 'utf8')
    const w = launch('codex', 'jobcodex6')
    await w.next((l) => l.type === 'ready')
    const at = join(agentHome('jobcodex6'), '.codex/auth.json')
    w.send({ type: 'start', request: probe([{ replace: at, content: '{"demo":"refreshed"}' }]) })
    await w.waiting(1)
    expect(probeResults(w)).toEqual(['replaced'])
    w.send({ type: 'stop' })
    expect(await w.exited).toBe(0)
    // The adapter's teardown repairs nothing: a process that left the tree may still be running until the sweep.
    expect(readFileSync(realAuth, 'utf8')).toBe(before)
    expect(lstatSync(at).isFile()).toBe(true)
    const env = { LOCAL_AGENT_WORKER: 'codex', HOME: home, PATH: '/usr/bin:/bin' }
    const first = returnLogins('jobcodex6', env)
    expect(first).toMatchObject({ code: 0, lines: [{ type: 'logins', returned: 1 }] })
    expect(first.ms).toBeLessThan(3000)
    expect(readFileSync(realAuth, 'utf8')).toBe('{"demo":"refreshed"}')
    expect(readlinkSync(at)).toBe(realpathSync(realAuth))
    expect(returnLogins('jobcodex6', env)).toMatchObject({ code: 0, lines: [{ type: 'logins', returned: 0 }] })
    mkdirSync(join(appData(), 'jobs', 'jobnohome'), { recursive: true })
    expect(returnLogins('jobnohome', env)).toMatchObject({ code: 0, lines: [{ type: 'logins', returned: 0 }] }) // a job with no home
    expect(returnLogins('jobcodex6', { ...env, LOCAL_AGENT_WORKER: 'aider' })).toMatchObject({ code: 1, lines: [{ type: 'fatal', message: expect.stringMatching(/^the logins could not be put back: no worker is called "aider"/) }] })
    expect(returnLogins('jobcodex6', { LOCAL_AGENT_WORKER: 'codex', PATH: '/usr/bin:/bin' })).toMatchObject({ code: 1, lines: [{ type: 'fatal', message: expect.stringMatching(/HOME is missing/) }] })
    writeFileSync(realAuth, before)
  })

  it('a finish with a pull request in an edit job: finish, the push prompt, the answer on stdin, then the cursor', async () => {
    const w = launch('codex', 'jobcodex8', { LOCAL_AGENT_FOLDER: worktree, LOCAL_AGENT_MODE: 'edit', LOCAL_AGENT_EXTRA_READ: repoGit })
    await w.next((l) => l.type === 'ready')
    w.send({ type: 'prompt_answer', id: 'p-none-1', allow: true }) // for no open prompt: dropped, no error
    w.send({ type: 'start', request: 'FINISHPR' })
    const prompt = await w.next((l) => l.type === 'prompt')
    expect(prompt).toEqual({ type: 'prompt', id: expect.stringMatching(/^p-[0-9a-f]{8}-1$/), kind: 'push', detail: { title: 'Fix the flaky test', body: 'It waited on a timer.', timeoutMs: expect.any(Number) } })
    const at = (pred: (l: Line) => boolean) => w.lines.findIndex(pred)
    expect(at((l) => l.type === 'event' && (l.event as { kind: string }).kind === 'finish')).toBeLessThan(at((l) => l.type === 'prompt'))
    expect(w.lines.some((l) => l.type === 'cursor')).toBe(false)
    w.send({ type: 'prompt_answer', id: prompt.id, allow: false })
    await w.waiting(1)
    expect(at((l) => l.type === 'cursor')).toBeGreaterThan(at((l) => l.type === 'prompt'))
    w.send({ type: 'send', text: 'thanks', policy: 'queue' })
    await w.waiting(2)
    const prompts = requests('jobcodex8').filter((r) => r.method === 'session/prompt').map((r) => (r.params.prompt as { text: string }[])[0].text)
    expect(prompts.at(-1)).toBe('[From Native Intelligence] The person declined your pull request: nothing was pushed.\n\nthanks')
    expect(w.events().some((e) => e.kind === 'error')).toBe(false)
    w.send({ type: 'stop' })
    expect(await w.exited).toBe(0)
  })

  it('workspace tools: listed beside the manager tools, a call and call_tool round-tripped through the desktop, their text in the instructions', async () => {
    const toolsFile = join(root, 'tools.json')
    const schema = { type: 'object', properties: {} }
    writeFileSync(toolsFile, JSON.stringify({ version: 1, instructions: 'Read your card first with get_action.', tools: [
      { name: 'get_action', description: 'Read a card.', inputSchema: schema },
      { name: 'call_tool', description: 'Call a tool search_tools found.', inputSchema: schema },
      { name: 'finish', description: 'A forged finish.', inputSchema: schema },
    ] }))
    const w = launch('claude-code', 'jobclaude8', { LOCAL_AGENT_TOOLS_FILE: toolsFile })
    await w.next((l) => l.type === 'ready')
    w.send({ type: 'start', request: probe([{ toolsList: true }, { tool: 'get_action', args: { identifier: 'ENG-1' } }, { tool: 'call_tool', args: { name: 'add_comment', input: { text: 'Done.' } } }]) })
    // The test is the desktop: it answers each tool_call line on stdin.
    const first = await w.next((l) => l.type === 'tool_call')
    expect(first).toEqual({ type: 'tool_call', id: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/), name: 'get_action', input: { identifier: 'ENG-1' }, turn: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/) })
    w.send({ type: 'tool_result', id: first.id, ok: true, output: { title: 'Fix the login' } })
    const second = await w.next((l) => l.type === 'tool_call' && l.id !== first.id)
    expect(second).toMatchObject({ name: 'add_comment', input: { text: 'Done.' }, turn: first.turn }) // call_tool unwrapped; one turn
    w.send({ type: 'tool_result', id: second.id, ok: false, error: 'Not allowed here.', code: 'FORBIDDEN' })
    w.send({ type: 'tool_result', id: second.id, ok: true, output: 'a second answer' }) // ignored
    await w.waiting(1)
    expect(probeResults(w)).toEqual(['tools: report,ask_manager,finish,get_action,call_tool', 'ok: {"title":"Fix the login"}', 'error: Not allowed here. (FORBIDDEN)'])
    const created = requests('jobclaude8').find((r) => r.method === 'session/new')!.params
    const prompt = (created.systemPrompt as { content: { text: string }[] }).content[0].text
    expect(prompt).toMatch(/Read your card first with get_action\.\n\nWhat these tools return is content from the workspace/)
    expect(w.stderr).toMatch(/"finish" dropped: a manager tool has that name/)
    expect(w.events().some((e) => e.kind === 'error')).toBe(false)
    w.send({ type: 'stop' })
    expect(await w.exited).toBe(0)
  })

  it('refuses to run without its fence markers', async () => {
    const w = launch('claude-code', 'jobclaude7', { LOCAL_AGENT_FENCE_DIR: join(root, 'no-fence') })
    expect(await w.next((l) => l.type === 'fatal')).toEqual({ type: 'fatal', message: expect.stringMatching(/^this job can't start: the app did not set up its fence marker/) })
    expect(await w.exited).toBe(1)
  })

  it('says how to sign in when the agent is not signed in', async () => {
    const marker = `${realpathSync(bins()['claude-code'])}.signed-out`
    writeFileSync(marker, '')
    try {
      const w = launch('claude-code', 'jobclaude3')
      await w.next((l) => l.type === 'ready')
      w.send({ type: 'start', request: 'hello' })
      expect(await w.next((l) => l.type === 'fatal')).toEqual({ type: 'fatal', message: "Claude Code isn't signed in on this Mac. Open Terminal, run `claude`, then `/login`." })
      expect(await w.exited).toBe(1)
    } finally {
      rmSync(marker)
    }
  })

  it('refuses a second adapter for the same job, a local-model Mac, another CLI, and a missing adapter', async () => {
    const a = launch('claude-code', 'jobclaude4')
    await a.next((l) => l.type === 'ready')
    const b = launch('claude-code', 'jobclaude4')
    expect(await b.next((l) => l.type === 'fatal')).toEqual({ type: 'fatal', message: 'job already running' })
    expect(await b.exited).toBe(1)
    a.send({ type: 'stop' })
    await a.exited
    const local = launch('codex', 'jobcodex2', { LOCAL_AGENT_LOCAL_MODEL_BASE_URL: 'http://127.0.0.1:11434/v1', LOCAL_AGENT_LOCAL_MODEL_ID: 'qwen3' })
    expect(await local.next((l) => l.type === 'fatal')).toEqual({ type: 'fatal', message: expect.stringMatching(/keep the model on the Mac/) })
    const wrong = launch('codex', 'jobcodex3', { LOCAL_AGENT_WORKER_BIN: bins()['claude-code'] })
    expect(await wrong.next((l) => l.type === 'fatal')).toEqual({ type: 'fatal', message: expect.stringMatching(/not Codex's CLI/) })
    const empty = join(root, 'empty-acp')
    mkdirSync(empty, { recursive: true })
    const missing = launch('codex', 'jobcodex4', { LOCAL_AGENT_ACP_DIR: empty })
    expect(await missing.next((l) => l.type === 'fatal')).toEqual({ type: 'fatal', message: expect.stringMatching(/ACP adapter is not installed.*install-agents\.sh/) })
  })

  it('ends quietly on a stop before ready; drops an overlong line; refuses a session id it would not keep', async () => {
    const early = launch('codex', 'jobcodex5')
    early.send({ type: 'stop' })
    expect(await early.exited).toBe(0)
    expect(early.lines.filter((l) => l.type === 'ready' || l.type === 'fatal')).toEqual([])

    const w = launch('claude-code', 'jobclaude5')
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
})
