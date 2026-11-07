/**
 * One worker job, end to end: the process the desktop spawns instead of the
 * launcher when a job asks for Claude Code or Codex (workers/<worker>.ts).
 *
 *   1. One adapter per job dir: the same exclusive `O_EXLOCK` on
 *      `<cwd>/.launcher.lock` the launcher takes, so a launcher and a worker
 *      can never run one job twice.
 *   2. The launch environment (env.ts), then the folder's fence: the
 *      host-folder sandbox resolves and re-checks the grant
 *      (resolveHostFolder) exactly as for the eve agent, with the job id as
 *      its session (the scratch dir under the job's TMPDIR).
 *   3. The fence's tools as an MCP server on 127.0.0.1 (mcp-http.ts).
 *   4. The CLI's own profile (cli-profile.ts) and environment, and a probe of
 *      the CLI under that profile: version, flags, login. Any failure is a
 *      `fatal` with a sentence for the person, before `ready`.
 *   5. `ready`, then the stdin lines, one at a time, in order (like the
 *      launcher's chain).
 *
 * stdout carries ONLY protocol lines. Logs, the CLI's stderr included, go to
 * stderr (the desktop's log). The MCP bearer is never logged.
 */
import { constants as fsConstants, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { createHostFolderSession, resolveHostFolder } from '../../lib/host-folder-sandbox.js'
import type { AdapterContext, CliAdapter } from './adapter.js'
import { buildCliProfile, cliReadRoots, foldersToMake, type CliProfileInput } from './cli-profile.js'
import { WorkerDriver } from './driver.js'
import { WorkerLaunchError, workerLaunchFromEnv, type WorkerEnv } from './env.js'
import { createFenceTools } from './fence-tools.js'
import { startFenceMcp, type FenceMcpServer } from './mcp-http.js'
import { SANDBOX_EXEC, cliEnv, killBelow, runProbe, spawnCli } from './process.js'
import { MAX_LINE_BYTES, createLineSplitter, parseInbound, serializeLine, type OutboundMessage } from './protocol.js'

/** Where each job's CLI temp folder is made (mkdtemp), removed at exit. */
export const CLI_TMP_PREFIX = '/private/tmp/dial8-cli-'

/** macOS open(2) O_EXLOCK (<fcntl.h>); Node does not export it. */
const O_EXLOCK = 0x20

/** The launcher's job lock (launcher.ts acquireJobLock), restated: null when another process holds it. */
export function acquireJobLock(dir: string): number | null {
  const exlock = process.platform === 'darwin' ? O_EXLOCK : 0
  try {
    return openSync(join(dir, '.launcher.lock'), fsConstants.O_RDWR | fsConstants.O_CREAT | exlock | fsConstants.O_NONBLOCK, 0o600)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EAGAIN' || code === 'EWOULDBLOCK') return null
    throw err
  }
}

/**
 * The CLI's working folder: `<job dir>/cli`, empty, the same on every launch
 * of the job (Claude Code keys its sessions by working folder, so a resume
 * must start there again). Never the granted folder: a CLI loads CLAUDE.md,
 * AGENTS.md and project config from where it starts, and those would be
 * folder content steering the CLI's own reads (cli-profile.ts).
 */
export function cliWorkingFolder(jobDir: string): string {
  const dir = join(jobDir, 'cli')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a folder`)
  const real = realpathSync(dir)
  if (readdirSync(real).length > 0) throw new Error(`the CLI's working folder is not empty: ${real}`)
  return real
}

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function runWorker(adapter: CliAdapter, env: WorkerEnv = process.env): Promise<void> {
  const write = (msg: OutboundMessage) => process.stdout.write(serializeLine(msg))
  const log = (line: string) => process.stderr.write(`${line}\n`)
  /** No more stdin lines are taken (a stop, EOF, a signal or a fatal). */
  let exiting = false
  /** No more stdout lines either: after a `fatal`, the job's last line. */
  let silenced = false
  let mcp: FenceMcpServer | null = null
  let killFence: (() => Promise<void>) | null = null
  let cliTmp: string | null = null
  let driver: WorkerDriver | null = null

  /** Kill the CLI and what it left, then the fence's commands, then the MCP server; then exit. */
  const teardown = async (code: number): Promise<never> => {
    killBelow()
    await killFence?.().catch(() => {})
    await mcp?.close().catch(() => {})
    if (cliTmp) rmSync(cliTmp, { recursive: true, force: true })
    // stdout is a pipe, written asynchronously: let the last lines (a `fatal`, `cancelled`) reach the desktop.
    await new Promise<void>((resolve) => process.stdout.write('', () => resolve()))
    process.exit(code)
  }
  const fatal = (text: string): void => {
    if (silenced) return
    exiting = true
    silenced = true
    write({ type: 'fatal', message: text })
    void teardown(1)
  }

  try {
    if (acquireJobLock(process.cwd()) === null) return fatal('job already running')
  } catch (err) {
    return fatal(`could not lock the job dir: ${message(err)}`)
  }

  // Input from the start, so a stop, EOF or SIGTERM during the probe still tears down (probes and the
  // CLI's temp folder included). Lines that arrive before `ready` wait for the driver, in order.
  let openGate!: () => void
  const gate = new Promise<void>((resolve) => (openGate = resolve))
  const shutdown = async (graceMs: number) => {
    if (exiting) return
    exiting = true
    await driver?.stop(graceMs)
    await teardown(0)
  }
  let chain: Promise<unknown> = gate
  const onLine = (line: string) => {
    if (!line.trim() || exiting) return
    const msg = parseInbound(line)
    if (!msg) {
      write({ type: 'event', event: { kind: 'error', message: 'unreadable message on stdin' } })
      return
    }
    if (msg.type === 'token' || msg.type === 'prompt_answer') return // a worker has no relay token and asks no prompts
    if (msg.type === 'stop' && !driver) return void shutdown(800)
    chain = chain
      .then(async () => {
        if (exiting || !driver) return
        if (msg.type === 'start') driver.start(msg.request)
        else if (msg.type === 'resume') driver.resume(msg.sessionId, msg.streamIndex)
        else if (msg.type === 'send') driver.send(msg.text, msg.policy)
        else await shutdown(800) // the desktop SIGTERMs the group 5 s after a stop
      })
      .catch((err: unknown) => {
        if (!driver?.sessionId) return fatal(`could not ${msg.type}: ${message(err)}`)
        write({ type: 'event', event: { kind: 'error', message: message(err) } })
      })
  }
  const splitter = createLineSplitter(onLine, {
    maxBytes: MAX_LINE_BYTES,
    onTooLong: () => write({ type: 'event', event: { kind: 'error', message: `a message on stdin was longer than ${MAX_LINE_BYTES} bytes and was dropped` } }),
  })
  process.stdin.on('data', (chunk: Buffer) => splitter.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)))
  // stdin EOF (the app went away) or SIGTERM: the desktop SIGKILLs the group at 2.6 s.
  process.stdin.on('end', () => {
    splitter.end()
    void shutdown(500)
  })
  process.on('SIGTERM', () => void shutdown(500))
  process.on('SIGINT', () => void shutdown(500))

  let ctx: AdapterContext
  let probe: Awaited<ReturnType<CliAdapter['probe']>>
  let profile: string
  let cliEnvironment: Record<string, string>
  try {
    const launch = workerLaunchFromEnv(env, adapter.worker)
    const cfg = await resolveHostFolder(
      { folder: launch.folder, mode: launch.mode, toolPath: launch.toolPath, ...(launch.extraRead ? { extraRead: launch.extraRead } : {}) },
      { sessionId: launch.jobId, home: launch.home, tmpRoot: launch.tmpdir, lang: launch.lang },
    )
    // A stop, EOF or signal meanwhile: teardown is under way, so make nothing more (no CLI temp folder it would miss).
    if (exiting) return
    const fence = createHostFolderSession(cfg)
    killFence = fence.killAll
    mcp = await startFenceMcp(createFenceTools(fence.session, launch.mode).call, { log })
    if (exiting) return

    // The CLI's own temp folder (0700): apart from the fence's scratch, unreadable to fenced commands
    // (/private/tmp is read-denied to them), and short, because Claude Code makes unix sockets in it
    // and the job's TMPDIR is too long a path for one.
    cliTmp = realpathSync(mkdtempSync(CLI_TMP_PREFIX))
    ctx = { launch, mcp: { url: mcp.url, token: mcp.token }, cliTmp, cliCwd: cliWorkingFolder(process.cwd()) }

    const protectedState = adapter.protectedState(launch.home)
    const profileInput: CliProfileInput = {
      home: launch.home,
      folder: launch.folder,
      ...(launch.extraRead ? { extraRead: launch.extraRead } : {}),
      cliCwd: ctx.cliCwd,
      cliTmp,
      stateDirs: adapter.stateDirs(launch.home),
      stateFiles: adapter.stateFiles(launch.home),
      readRoots: cliReadRoots(launch.bin, launch.toolPath, launch.home, realpathOrNull),
      protectedDirs: protectedState.dirs,
      protectedFiles: protectedState.files,
      protectedScriptsUnder: protectedState.scriptsUnder,
      ownOnlyUnder: adapter.ownOnlyUnder?.(launch.home, ctx.cliCwd) ?? [],
      mcpPort: mcp.port,
    }
    profile = buildCliProfile(profileInput)
    // The pinned folders the CLI may not create itself (a first run on this Mac included): made here, outside its profile.
    for (const dir of foldersToMake(profileInput)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    cliEnvironment = cliEnv({ home: launch.home, path: launch.toolPath, lang: launch.lang, tmpdir: cliTmp, user: userInfo().username }, adapter.env(ctx))
    // After a stop, no further probe step starts: teardown has already killed what was running.
    probe = await adapter.probe((args) =>
      exiting ? Promise.reject(new Error('the job is stopping')) : runProbe(SANDBOX_EXEC, ['-p', profile, launch.bin, ...args], { env: cliEnvironment, cwd: ctx.cliCwd }),
    )
    adapter.prepare(ctx, probe)
    log(`[worker] ${adapter.label} ${probe.version} in ${launch.mode} mode; fence tools on 127.0.0.1:${mcp.port}`)
  } catch (err) {
    if (exiting) return // the stop killed the probe: not a failure to report
    return fatal(err instanceof WorkerLaunchError ? err.message : `${adapter.label} could not start: ${message(err)}`)
  }

  if (exiting) return // a stop or EOF arrived during the probe: teardown is under way
  write({ type: 'ready', port: 0, worker: adapter.worker, workerVersion: probe.version })

  driver = new WorkerDriver(
    adapter,
    ctx,
    probe,
    {
      write: (msg) => {
        if (!silenced) write(msg)
      },
      log,
      spawn: (args) => spawnCli({ profile, bin: ctx.launch.bin, args, cwd: ctx.cliCwd, env: cliEnvironment }),
      fatal,
    },
    () => crypto.randomUUID(),
  )
  openGate()
}
