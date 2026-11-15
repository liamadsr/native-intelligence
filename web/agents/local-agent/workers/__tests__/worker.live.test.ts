/**
 * Opt-in: the built worker end to end with the person's REAL CLI, under the
 * real profile, the real private home and the person's own login (keychain
 * link for Claude Code, the `~/.codex/auth.json` link for Codex). One tiny
 * read job in a throwaway folder that must call our `finish`. It spends a
 * little of the person's own plan, so it runs only when named:
 *
 *   LA_TEST_LIVE_CLAUDE_BIN=<path of `claude`>   (its name must be `claude`)
 *   LA_TEST_LIVE_CODEX_BIN=<path of `codex`>     (its name must be `codex`; one with `app-server`)
 *
 * After the job, `worker.mjs --return-logins` runs as the desktop runs it, so a
 * login the CLI saved beside its link goes back onto the person's own.
 * Each run's lines and the worker's stderr are printed.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const onMac = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')
const CLAUDE = process.env.LA_TEST_LIVE_CLAUDE_BIN
const CODEX = process.env.LA_TEST_LIVE_CODEX_BIN

type Line = Record<string, unknown> & { type: string }

class Worker {
  readonly lines: Line[] = []
  stderr = ''
  readonly exited: Promise<number | null>
  constructor(readonly child: ChildProcess) {
    let buf = ''
    child.stdout!.setEncoding('utf8').on('data', (d: string) => {
      buf += d
      for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
        const raw = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (raw.trim()) this.lines.push(JSON.parse(raw) as Line)
      }
    })
    child.stderr!.setEncoding('utf8').on('data', (d: string) => (this.stderr += d))
    this.exited = new Promise((r) => child.once('exit', (code) => r(code)))
  }
  send(o: unknown) {
    this.child.stdin!.write(`${JSON.stringify(o)}\n`)
  }
  async until(test: () => boolean, ms: number) {
    const end = Date.now() + ms
    while (!test() && Date.now() < end) await new Promise((r) => setTimeout(r, 100))
    return test()
  }
  events() {
    return this.lines.flatMap((l) => (l.type === 'event' ? [l.event as Record<string, unknown>] : []))
  }
  /** The run, short: one row per line (text deltas folded into their messages), then the worker's log. */
  transcript() {
    const rows = this.lines
      .filter((l) => !(l.type === 'event' && (l.event as { kind: string }).kind === 'text'))
      .map((l) => JSON.stringify(l).slice(0, 400))
    return `${rows.join('\n')}\n--- stderr ---\n${this.stderr.split('\n').slice(-80).join('\n')}`
  }
}

describe.runIf(onMac && (CLAUDE || CODEX))('a worker job with the real CLI (opt-in, spends the plan)', { timeout: 300_000 }, () => {
  let root: string
  let bundle: string
  beforeAll(async () => {
    // Under the real home, as the desktop's job dirs and a granted folder are (a grant can't sit in /private); removed after.
    root = realpathSync(mkdtempSync(join(homedir(), 'ni-worker-live-')))
    bundle = join(root, 'bundle')
    await build({
      entryPoints: [join(__dirname, '..', 'worker.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      logLevel: 'warning',
      banner: { js: "import { createRequire as __niRequire } from 'node:module'; const require = __niRequire(import.meta.url);" },
      outfile: join(bundle, 'workers', 'worker.mjs'),
    })
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  async function job(worker: 'claude-code' | 'codex', bin: string) {
    const home = homedir()
    const jobId = `live${worker.replace('-', '')}${Date.now().toString(36)}`
    const jobDir = join(root, 'jobs', jobId)
    const fence = join(root, 'fence')
    const tmp = realpathSync(mkdtempSync('/private/tmp/ni-live-'))
    const folder = join(root, `folder-${worker}`)
    for (const d of [jobDir, fence, folder]) mkdirSync(d, { recursive: true })
    for (const f of [jobId, `${jobId}.open`]) writeFileSync(join(fence, f), '')
    writeFileSync(join(folder, 'README.md'), '# A tiny project\n\nThe secret word is pelican.\n')
    const toolPath = [dirname(bin), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':')
    const env = {
      HOME: home,
      TMPDIR: tmp,
      LANG: 'en_US.UTF-8',
      PATH: toolPath,
      LOCAL_AGENT_JOB_ID: jobId,
      LOCAL_AGENT_FOLDER: realpathSync(folder),
      LOCAL_AGENT_MODE: 'read',
      LOCAL_AGENT_TOOL_PATH: toolPath,
      LOCAL_AGENT_DIR: bundle,
      LOCAL_AGENT_WORKER: worker,
      LOCAL_AGENT_WORKER_BIN: bin,
      LOCAL_AGENT_FENCE_DIR: fence,
    }
    const w = new Worker(spawn(process.execPath, [join(bundle, 'workers', 'worker.mjs')], { cwd: jobDir, env: env as unknown as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] }))
    let ok = false
    try {
      expect(await w.until(() => w.lines.some((l) => l.type === 'ready' || l.type === 'fatal'), 60_000), w.transcript()).toBe(true)
      expect(w.lines.find((l) => l.type === 'fatal'), w.transcript()).toBeUndefined()
      w.send({
        type: 'start',
        request: 'Read README.md in your working folder. Then call the `finish` tool of the `ni` server with the summary set to the secret word written there. Do nothing else, and keep it short.',
      })
      await w.until(() => w.events().some((e) => e.kind === 'finish') || w.lines.some((l) => l.type === 'fatal') || w.events().filter((e) => e.kind === 'status' && e.status === 'waiting').length > 0, 240_000)
      // The turn ends after `finish` (it is held until then): wait for its `waiting`.
      await w.until(() => w.events().some((e) => e.kind === 'status' && e.status === 'waiting') || w.lines.some((l) => l.type === 'fatal'), 120_000)
      ok = true
    } finally {
      w.send({ type: 'stop' })
      await Promise.race([w.exited, new Promise((r) => setTimeout(r, 10_000))])
      w.child.kill('SIGKILL')
      // As the desktop does after its sweep: a login saved beside its link goes back onto the person's own.
      const back = spawnSync(process.execPath, [join(bundle, 'workers', 'worker.mjs'), '--return-logins'], { cwd: jobDir, env: { LOCAL_AGENT_WORKER: worker, HOME: home, PATH: '/usr/bin:/bin' } as unknown as NodeJS.ProcessEnv, encoding: 'utf8' })
      rmSync(tmp, { recursive: true, force: true })
      console.log(`=== ${worker} (${basename(bin)}) ${ok ? '' : '(did not get to the end)'}\n${w.transcript()}\n--- return-logins ---\n${back.stdout.trim()} ${back.stderr.trim()}`)
    }
    return w
  }

  it.runIf(CLAUDE)("Claude Code: starts under the profile on the person's login, reads the folder, calls finish", async () => {
    const w = await job('claude-code', CLAUDE!)
    expect(w.lines.find((l) => l.type === 'ready'), w.transcript()).toMatchObject({ worker: 'claude-code', workerVersion: expect.stringMatching(/^\d+\.\d+\.\d+/) })
    expect(w.lines.find((l) => l.type === 'fatal'), w.transcript()).toBeUndefined()
    expect(w.events().filter((e) => e.kind === 'error'), w.transcript()).toEqual([])
    expect(w.events().find((e) => e.kind === 'finish'), w.transcript()).toEqual({ kind: 'finish', summary: expect.stringMatching(/pelican/i) })
  })

  it.runIf(CODEX)("Codex: starts under the profile on the person's login, reads the folder, calls finish", async () => {
    const w = await job('codex', CODEX!)
    expect(w.lines.find((l) => l.type === 'ready'), w.transcript()).toMatchObject({ worker: 'codex', workerVersion: expect.stringMatching(/^\d+\.\d+\.\d+/) })
    expect(w.lines.find((l) => l.type === 'fatal'), w.transcript()).toBeUndefined()
    expect(w.events().filter((e) => e.kind === 'error'), w.transcript()).toEqual([])
    expect(w.events().find((e) => e.kind === 'finish'), w.transcript()).toEqual({ kind: 'finish', summary: expect.stringMatching(/pelican/i) })
  })
})
