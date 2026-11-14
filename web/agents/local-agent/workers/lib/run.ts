/**
 * One worker job, end to end: the process the desktop spawns instead of the
 * launcher when a job asks for an ACP agent (workers/acp.ts).
 *
 *   1. One adapter per job dir: the same exclusive `O_EXLOCK` on
 *      `<cwd>/.launcher.lock` the launcher takes, so a launcher and a worker
 *      can never run one job twice.
 *   2. The launch environment (env.ts) and the registry entry it names, then
 *      the grant re-checked exactly as for the eve agent (resolveHostFolder:
 *      the folder, the worktree's repository, where HOME's credentials live).
 *   3. The agent's private home, `<job dir>/home`, with the person's login
 *      linked in (agent-home.ts), its temp folder, and the manager tools as an MCP server
 *      on 127.0.0.1 (mcp-http.ts).
 *   4. The agent under its one profile (agent-profile.ts), and ACP
 *      `initialize`. Any failure is a `fatal` with a sentence, before `ready`.
 *   5. `ready`, then the stdin lines, one at a time, in order (like the
 *      launcher's chain).
 *
 * stdout carries ONLY protocol lines. Logs, the agent's stderr included, go to
 * stderr (the desktop's log). The MCP bearer is never logged.
 */
import { constants as fsConstants, existsSync, mkdtempSync, openSync, realpathSync, rmSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { nodeRuntimeRoot, resolveHostFolder } from '../../lib/host-folder-sandbox.js'
import { AgentHomeError, prepareAgentHome, returnLoginFiles } from './agent-home.js'
import { agentReadRoots, buildAgentProfile } from './agent-profile.js'
import { WorkerDriver } from './driver.js'
import { WorkerLaunchError, workerLaunchFromEnv, type WorkerEnv } from './env.js'
import { createPromptBroker } from '../../launcher/prompts.js'
import { MANAGER_TOOLS, createManagerTools } from './manager-tools.js'
import { TOOL_RESULT_LINE_MAX, createWorkspaceBridge, loadToolsFile, type WorkspaceBridge } from './workspace-tools.js'
import { workspaceSection } from './instructions.js'
import { startManagerMcp, type ManagerMcpServer } from './mcp-http.js'
import { agentEnv, killBelow, processesBelow, spawnSandboxed } from './process.js'
import { toolchainEnv } from './toolchains.js'
import { MAX_LINE_BYTES, createLineSplitter, parseInbound, serializeLine, type OutboundMessage } from './protocol.js'
import { agentLaunch, loadRegistry, type Registry } from './registry.js'

/** Where each job's agent temp folder is made (mkdtemp), removed at exit: short, because Claude Code keeps unix sockets there. */
export const AGENT_TMP_PREFIX = '/private/tmp/dial8-acp-'

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

export async function runWorker(opts: { env?: WorkerEnv; registry?: Registry; entryScript?: string } = {}): Promise<void> {
  const env = opts.env ?? process.env
  const write = (msg: OutboundMessage) => process.stdout.write(serializeLine(msg))
  const log = (line: string) => process.stderr.write(`${line}\n`)
  /** No more stdin lines are taken (a stop, EOF, a signal or a fatal). */
  let exiting = false
  /** No more stdout lines either: after a `fatal`, the job's last line. */
  let silenced = false
  let mcp: ManagerMcpServer | null = null
  let agentTmp: string | null = null
  let driver: WorkerDriver | null = null
  /** The job's workspace tools, through the desktop (workspace-tools.ts): null without a tools file. */
  let workspace: WorkspaceBridge | null = null
  /** What ran below the adapter before the agent was stopped (its children outlive it, re-parented). */
  let started: ReturnType<typeof processesBelow> = { pids: [], groups: [] }

  /** Kill the agent and what it left, then the MCP server; then exit. */
  // The launcher's own prompt broker (one prompt on screen at a time, ids, timeouts): a worker sends only `push`.
  const prompts = createPromptBroker({ write: (line) => !silenced && write(line), log })
  const teardown = async (code: number): Promise<never> => {
    workspace?.cancelAll()
    prompts.close()
    killBelow(started)
    await mcp?.close().catch(() => {})
    // A process still exiting from the stop's SIGTERM can write one last file (Node's compile cache): let it finish first.
    await new Promise((r) => setTimeout(r, 150))
    killBelow(started)
    // No login repair here: a process that left the tree may still run until the desktop's sweep, which then
    // runs `acp.mjs --return-logins` (agent-home.ts). And teardown never throws: a surviving process can race it.
    try {
      if (agentTmp) rmSync(agentTmp, { recursive: true, force: true })
    } catch (err) {
      log(`[worker] could not remove ${agentTmp}: ${message(err)}`)
    }
    // stdout is a pipe, written asynchronously: let the last lines (a `fatal`, `cancelled`) reach the desktop.
    await new Promise<void>((resolve) => process.stdout.write('', () => resolve()))
    process.exit(code)
  }
  const fatal = (text: string): void => {
    if (silenced) return
    exiting = true
    silenced = true
    started = processesBelow()
    write({ type: 'fatal', message: text })
    void teardown(1)
  }

  try {
    if (acquireJobLock(process.cwd()) === null) return fatal('job already running')
  } catch (err) {
    return fatal(`could not lock the job dir: ${message(err)}`)
  }

  // Input from the start, so a stop, EOF or SIGTERM during the launch still tears down. Lines that arrive before
  // `ready` wait for the driver, in order.
  let openGate!: () => void
  const gate = new Promise<void>((resolve) => (openGate = resolve))
  const shutdown = async (graceMs: number) => {
    if (exiting) return
    exiting = true
    started = processesBelow()
    workspace?.cancelAll() // every waiting call answered to the agent as cancelled
    await driver?.stop(graceMs)
    await teardown(0)
  }
  let chain: Promise<unknown> = gate
  const onLine = (line: string) => {
    if (!line.trim() || exiting) return
    // A workspace tool's answer (one for no waiting call is logged and dropped); the only line allowed past 256 KB.
    if (workspace?.handleLine(line)) return
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      write({ type: 'event', event: { kind: 'error', message: `a message on stdin was longer than ${MAX_LINE_BYTES} bytes and was dropped` } })
      return
    }
    // The answer to a push prompt (or any `prompt_answer`: one for an id not open is logged and dropped).
    if (prompts.handleLine(line)) return
    const msg = parseInbound(line)
    if (!msg) {
      write({ type: 'event', event: { kind: 'error', message: 'unreadable message on stdin' } })
      return
    }
    if (msg.type === 'token' || msg.type === 'prompt_answer') return // a worker has no relay token; answers went to the broker
    if (msg.type === 'stop') return void shutdown(800) // never behind a slow line: the desktop SIGTERMs the group 5 s after a stop
    chain = chain
      .then(() => {
        if (exiting || !driver) return
        if (msg.type === 'start') driver.start(msg.request)
        else if (msg.type === 'resume') driver.resume(msg.sessionId, msg.streamIndex)
        else driver.send(msg.text, msg.policy)
      })
      .catch((err: unknown) => {
        if (!driver?.sessionId) return fatal(`could not ${msg.type}: ${message(err)}`)
        write({ type: 'event', event: { kind: 'error', message: message(err) } })
      })
  }
  const splitter = createLineSplitter(onLine, {
    maxBytes: TOOL_RESULT_LINE_MAX,
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

  let label = 'The agent'
  let workspaceText: string | undefined
  let worker = ''
  let version: string
  try {
    const launch = workerLaunchFromEnv(env, opts.registry ?? loadRegistry())
    const { entry } = launch
    label = entry.label
    worker = launch.worker
    const cfg = await resolveHostFolder(
      { folder: launch.folder, mode: launch.mode, toolPath: launch.toolPath, ...(launch.extraRead ? { extraRead: launch.extraRead } : {}) },
      { sessionId: launch.jobId, home: launch.home, tmpRoot: launch.tmpdir, lang: launch.lang, env },
    )
    // A stop, EOF or signal meanwhile: teardown is under way, so make nothing more (no temp folder it would miss).
    if (exiting) return

    const node = realpathSync(process.execPath)
    const entryScript = realpathSync(opts.entryScript ?? process.argv[1])
    // The adapter's own script must be where the registry says, inside LOCAL_AGENT_ACP_DIR.
    for (const a of agentLaunch(entry, { node, acpDir: launch.acpDir, cli: launch.bin, tmp: '', home: '' }).command.slice(1)) {
      if (a.startsWith(`${launch.acpDir}/`) && !(realpathOrNull(a) ?? '').startsWith(`${launch.acpDir}/`)) {
        throw new WorkerLaunchError(`${label}'s ACP adapter is not installed in LOCAL_AGENT_ACP_DIR (${a}): run install-agents.sh`)
      }
    }

    const prepared = prepareAgentHome(realpathSync(process.cwd()), launch.home, entry)
    const agentHome = prepared.home
    agentTmp = realpathSync(mkdtempSync(AGENT_TMP_PREFIX))
    const { command: argv, env: extraEnv } = agentLaunch(entry, { node, acpDir: launch.acpDir, cli: launch.bin, tmp: agentTmp, home: agentHome })
    // The agent can call the tools only once it runs, and it runs only after the driver exists.
    const manager = createManagerTools((event, pullRequest) => driver?.onManagerEvent(event, pullRequest), launch.mode)
    // The workspace tools, read once: no file (or a bad one) and the job runs as without.
    const tools = loadToolsFile(launch.toolsFile, log)
    workspace = tools ? createWorkspaceBridge(tools, { write: (line) => !silenced && write(line), log, turn: () => driver?.currentTurnId() ?? null }) : null
    const managerNames = new Set<string>(MANAGER_TOOLS.map((t) => t.name))
    const bridge = workspace
    mcp = await startManagerMcp(
      (name, args, signal) => (managerNames.has(name) || !bridge ? manager.call(name, args, signal) : bridge.call(name, args, signal)),
      { log, ...(tools ? { workspaceTools: tools.tools, workspaceInstructions: workspaceSection(tools.instructions) ?? undefined } : {}) },
    )
    workspaceText = tools ? tools.instructions : undefined
    if (exiting) return

    const readRoots = agentReadRoots(
      { bin: launch.bin, toolPath: launch.toolPath, home: launch.home, extra: [(await nodeRuntimeRoot(node)).runtime, launch.acpDir, dirname(entryScript)] },
      realpathOrNull,
      existsSync,
    )
    const profile = buildAgentProfile({
      home: launch.home,
      agentHome,
      agentTmp,
      mode: launch.mode,
      folder: launch.folder,
      ...(launch.extraRead ? { extraRead: launch.extraRead } : {}),
      readRoots,
      homeFolders: prepared.folders,
      ...(prepared.keychain ? { keychain: prepared.keychain } : {}),
      loginFiles: prepared.loginFiles,
      // This job's own MCP port is never closed (a listed server that went away could have freed it).
      closedPorts: launch.closedPorts.filter((p) => p !== mcp?.port),
      jobId: launch.jobId,
      fenceDir: launch.fenceDir,
      readProtected: cfg.profileInput.readProtected,
      ...(cfg.profileInput.toolchainRealpaths ? { toolchainRealpaths: cfg.profileInput.toolchainRealpaths } : {}),
    })
    const environment = agentEnv(
      // The person's tool PATH first; this Node last, for a CLI that is a `#!/usr/bin/env node` script.
      { home: agentHome, path: `${launch.toolPath}:${dirname(node)}`, lang: launch.lang, tmpdir: agentTmp, user: userInfo().username },
      // The person's toolchains (read-only), then the registry entry's own settings.
      { ...toolchainEnv(launch.home, existsSync), ...extraEnv },
    )
    const child = spawnSandboxed(profile, argv, { cwd: launch.folder, env: environment })
    driver = new WorkerDriver(
      child,
      {
        entry,
        mode: launch.mode,
        cwd: launch.folder,
        mcp: { url: mcp.url, port: mcp.port, token: mcp.token, proxy: { command: node, args: [entryScript, '--mcp-proxy'] } },
        ...(workspaceText !== undefined ? { workspaceInstructions: workspaceText } : {}),
      },
      {
        write: (msg) => {
          if (!silenced) write(msg)
        },
        log,
        fatal,
        ask: (kind, detail) => prompts.ask(kind, detail),
      },
    )
    ;({ version } = await driver.initialize().catch((err: unknown) => {
      throw new WorkerLaunchError(message(err))
    }))
    log(`[worker] ${label} (ACP adapter ${version}) in ${launch.mode} mode; manager tools on 127.0.0.1:${mcp.port}`)
  } catch (err) {
    if (exiting) return // the stop ended the launch: not a failure to report
    return fatal(err instanceof WorkerLaunchError || err instanceof AgentHomeError ? err.message : `${label} could not start: ${message(err)}`)
  }

  if (exiting) return // a stop or EOF arrived during the launch: teardown is under way
  write({ type: 'ready', port: 0, worker, workerVersion: version })
  openGate()
}

/**
 * `acp.mjs --return-logins`, run by the desktop UNSANDBOXED after it has
 * swept the job's processes (cwd: the job dir; LOCAL_AGENT_WORKER, HOME):
 * puts back what the agent saved beside its login links (agent-home.ts). One
 * line, `{"type":"logins","returned":<n>}` and exit 0, or `fatal` and exit 1.
 * Starts no agent and touches nothing but the job's home and the login files.
 */
export function runReturnLogins(env: WorkerEnv = process.env, registry?: Registry): number {
  const write = (msg: object) => process.stdout.write(`${JSON.stringify(msg)}\n`)
  try {
    const worker = env.LOCAL_AGENT_WORKER
    const all = registry ?? loadRegistry()
    if (!worker || !Object.hasOwn(all, worker)) throw new WorkerLaunchError(`no worker is called ${JSON.stringify(worker ?? null)}`)
    if (!env.HOME?.startsWith('/')) throw new WorkerLaunchError('HOME is missing or not absolute')
    const returned = returnLoginFiles(realpathSync(process.cwd()), realpathSync(env.HOME), all[worker], (l) => process.stderr.write(`${l}\n`))
    write({ type: 'logins', returned })
    return 0
  } catch (err) {
    write({ type: 'fatal', message: `the logins could not be put back: ${message(err)}` })
    return 1
  }
}
