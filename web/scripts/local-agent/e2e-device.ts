/**
 * The Mac half of local agents, end to end, with no database (Part A of the
 * L1 e2e): the REAL desktop relay core (`runHeadlessRelay`) drives the REAL
 * launcher through a fake Rust that spawns it exactly as the desktop does,
 * against the contract-B routes' shapes: a shim that calls the REAL server
 * library (store / device / transcript / tokens) over the unit tests'
 * in-memory DB. Not covered here: Postgres, the route files, the model relay
 * route and the ledger (inert: no workspace member), all unit-tested.
 *
 *   relay-core (real) ──fetch──▶ route shim (e2e/fake-server.ts) ──▶ server library (real) ──▶ in-memory DB
 *        │  bridge (real tauri-bridge parsers, e2e/bridge.ts)
 *        ▼
 *   fake Rust, its own process (e2e/fake-rust.ts) ──spawn──▶ launcher.ts (real) ──▶ eve server (real build)
 *
 * The agent is the Mac body (the Native Intelligence agent built for the Mac, contract C2,
 * scripts/local-agent/build.sh).
 *
 * The model: the dev path by default (LOCAL_AGENT_DEV_ENV_FILE; the launcher
 * reads only AI_GATEWAY_API_KEY from it, this script never opens it); the
 * fake claim then returns no model token, so the model relay route isn't
 * exercised (it has its own tests), and the app (C1) is out of reach: the
 * agent asks its question in words. `--fake-model` swaps in a scripted
 * stand-in for the app (e2e/fake-model.ts): the relay path with minted
 * tokens and a short TTL, so the token passthrough and refresh are covered
 * too, and C1's spec and tool routes, so the question goes out as C4's
 * `message_teammate` and progress as `report_to_person`. Nothing is spent.
 *
 * What it proves, step by step (each PASS / FAIL with its timing):
 *   A1 start → claim (provisional run) → Rust run → rebind; streaming, tool
 *      calls, and every event uploaded under the real runId.
 *   A2 a person's steer while the turn runs: `[From Liam] …`, same turn.
 *   A3 the agent's question ends the turn (scripted: `message_teammate`
 *      through C1) → waiting → the Native Intelligence agent's answer
 *      (`[From the Dial8 agent] …`) → the turn resumes. What the server does
 *      with message_teammate (needs_input, the cloud body's home turn) is
 *      WS-C's and not covered here.
 *   A4 a webview reload while that turn runs: the relay dies with events
 *      unsent; a new relay gap-fills them from Rust's ring.
 *   A5 finish → waiting (last_signal finish, the turn's row needs_review).
 *   C  (scripted) every C1 call carried a live minted token, a refreshed one too.
 *   A6 the app (fake Rust) is SIGKILLed: the launcher goes; a relaunch marks
 *      the job interrupted; a follow-up resumes the same eve session on a
 *      new run (rebind) and is answered.
 *   A7 stop → cancelled.
 *   B  an edit job: Rust's worktree on dial8/<slug>-<jobShort>, the agent's
 *      change, Rust's commit after `finish` and its `branch` event; the
 *      original checkout is untouched and the repo's hook never runs.
 *
 *   npx tsx scripts/local-agent/e2e-device.ts [--fake-model] [--only A|B] [--log <path.jsonl>] [--keep]
 *
 * Real mode spends two local-agent jobs (A: four short turns, B: one).
 * Build the agent first: scripts/local-agent/build.sh. Nothing listens on
 * :3000 or :3001; the fake server and fake model take random ports on
 * 127.0.0.1. Leaves nothing running (it checks).
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runHeadlessRelay, type LocalAgentRelay } from '@/lib/local-agent/relay-core'
import { relayBridgeFor } from './e2e/bridge'
import { startFakeModel, type FakeModel } from './e2e/fake-model'
import { forkFakeRust, type Entry, type FakeRustConfig, type FakeRustProcess, type SentLine } from './e2e/fake-rust'
import { startFakeServer, type FakeServer, type SessionView, type StoredEvent } from './e2e/fake-server'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const agentDir = join(repo, 'agents/local-agent')
const args = process.argv.slice(2)
const fakeModelMode = args.includes('--fake-model')
const keep = args.includes('--keep')
/** `--only A` or `--only B`: one job (a real-model budget); both by default. */
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null
if (only !== null && only !== 'A' && only !== 'B') throw new Error('--only takes A or B')
const logPath = args.includes('--log') ? resolve(args[args.indexOf('--log') + 1]) : join(tmpdir(), `local-agent-e2e-device-${Date.now()}.jsonl`)
const envFile = process.env.LOCAL_AGENT_DEV_ENV_FILE ?? join(repo, '.env.local')
const PERSON = 'Liam Alizadeh'

// ── The log (redacted) ──────────────────────────────────────────────────────

const home = realpathSync(homedir())
const secrets: string[] = []
const redact = (s: string) => {
  let out = s.split(home).join('~')
  for (const x of secrets) if (x) out = out.split(x).join('[redacted]')
  return out.replace(/la1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, 'la1.[redacted]')
}
const t0 = Date.now()
function record(phase: string, entry: Record<string, unknown>) {
  appendFileSync(logPath, `${redact(JSON.stringify({ t: new Date().toISOString(), sinceStartMs: Date.now() - t0, phase, ...entry }))}\n`)
}
const logLine = (source: string) => (line: string) => record(source, { line })

// ── Steps ───────────────────────────────────────────────────────────────────

type Checks = Record<string, boolean>
interface StepResult {
  step: string
  /** KNOWN-BUG: only checks a documented bug outside this script breaks failed. */
  result: 'PASS' | 'FAIL' | 'SKIP' | 'KNOWN-BUG'
  ms: number
  checks: Checks
  note?: string
}
const results: StepResult[] = []

/**
 * Bugs found outside this script (see the report), by the checks they break.
 * A step whose only failures are these reports KNOWN-BUG, not FAIL; once the
 * bug is fixed the check passes and the step is a plain PASS.
 */
const KNOWN_BUGS: Record<string, string> = {
  serverWaitingWithFinish:
    'BUG-1 device.ts ingestEvents: the seq floor (row.last_seq) ignores last_seq_run_id, so after an app relaunch (the ring restarts at 1) no event of the new run is derived',
}

/** Runs a step; answers whether it ran to the end (no exception or timeout), which later steps gate on. */
async function step(name: string, fn: () => Promise<Checks>, opts: { skipIf?: string | null } = {}): Promise<boolean> {
  if (opts.skipIf) {
    results.push({ step: name, result: 'SKIP', ms: 0, checks: {}, note: opts.skipIf })
    record('step', { step: name, result: 'SKIP', note: opts.skipIf })
    console.log(`SKIP ${name}: ${opts.skipIf}`)
    return false
  }
  const started = Date.now()
  let checks: Checks = {}
  let note: string | undefined
  try {
    checks = await fn()
  } catch (err) {
    note = err instanceof Error ? err.message : String(err)
  }
  const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k)
  const ok = !note && failed.length === 0 && Object.keys(checks).length > 0
  const knownOnly = !note && failed.length > 0 && failed.every((k) => k in KNOWN_BUGS)
  const result: StepResult['result'] = ok ? 'PASS' : knownOnly ? 'KNOWN-BUG' : 'FAIL'
  const detail = note ?? (failed.length ? `failed: ${failed.map((k) => (KNOWN_BUGS[k] ? `${k} (${KNOWN_BUGS[k].split(' ')[0]})` : k)).join(', ')}` : undefined)
  const r: StepResult = { step: name, result, ms: Date.now() - started, checks, ...(detail ? { note: detail } : {}) }
  results.push(r)
  record('step', { ...r })
  console.log(`${r.result} ${name} (${(r.ms / 1000).toFixed(1)} s)${r.note ? `: ${redact(r.note)}` : ''}`)
  // Later steps depend on the flow having got this far, not on every check.
  return !note
}

async function waitFor<T>(what: string, ms: number, probe: () => T | null | undefined | false | Promise<T | null | undefined | false>, every = 100): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const v = await probe()
    if (v) return v
    if (Date.now() > until) throw new Error(`timed out after ${Math.round(ms / 1000)} s waiting for ${what}`)
    await sleep(every)
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const tag = randomBytes(4).toString('hex')
const root = join(home, `.dial8-local-agent-e2e-${tag}`)
const appData = join(root, 'app-data')
const worktreesRoot = join(root, 'worktrees')
const readFolder = join(root, 'e2e-read-folder')
const gitRepo = join(root, 'ni-e2e-app')
const hookMarker = join(root, 'hook-ran')
const README = '# E2E fixture\n\nA tiny project for the local-agent e2e.\nIt has a README, a source file and some notes.\n'
const jobTmps: string[] = []
const launcherPids = new Set<number>()

const toolPath = [dirname(process.execPath), '/usr/bin', '/bin'].join(':')
function hostGit(gitArgs: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Native Intelligence e2e', '-c', 'user.email=e2e@dial8.invalid', '-c', 'init.defaultBranch=main', ...gitArgs], {
    encoding: 'utf8',
    // Cast: Next's global types make ProcessEnv require NODE_ENV, which git doesn't need.
    env: { PATH: toolPath, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } as Record<string, string> as NodeJS.ProcessEnv,
  })
}

function makeFixtures() {
  for (const dir of [readFolder, gitRepo]) {
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'README.md'), README)
    writeFileSync(join(dir, 'src', 'app.ts'), 'export const answer = 42\n')
    writeFileSync(join(dir, 'notes.txt'), 'one\ntwo\nthree\n')
  }
  hostGit(['init', '-q', gitRepo])
  hostGit(['-C', gitRepo, 'add', '-A'])
  hostGit(['-C', gitRepo, 'commit', '-q', '-m', 'initial commit'])
  // A hook Rust's commit must not run (core.hooksPath=/dev/null).
  writeFileSync(join(gitRepo, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch '${hookMarker}'\n`)
  chmodSync(join(gitRepo, '.git', 'hooks', 'pre-commit'), 0o755)
  mkdirSync(appData, { recursive: true })
}

// ── Requests (real model, or directives for the scripted one) ───────────────

const T = fakeModelMode
  ? {
      readRequest: [
        'E2E read job (scripted model).',
        '@bash ls -la',
        '@bash sleep 3; cat README.md',
        '@report I listed the folder and read the README.',
        '@ask Should I summarise notes.txt or src/app.ts?',
      ].join('\n'),
      steer: ['Also count the lines in notes.txt.', '@bash wc -l notes.txt'].join('\n'),
      answer: ['Summarise src/app.ts.', '@bash sleep 2; cat src/app.ts', '@finish src/app.ts exports answer = 42; notes.txt has 3 lines.'].join('\n'),
      followUp: ['One more: how many lines does README.md have?', '@bash wc -l README.md', '@finish README.md has 4 lines; src/app.ts exports answer = 42.'].join('\n'),
      editRequest: [
        'E2E edit job (scripted model).',
        '@read /workspace/README.md',
        '@write /workspace/README.md :: # E2E fixture\\n\\nA tiny project for the local-agent e2e.\\nIt has a README, a source file, some notes and a changelog.\\n',
        '@write /workspace/CHANGELOG.md :: # Changelog\\n\\n- Added a changelog.\\n',
        '@bash git status --porcelain',
        '@finish Add a changelog\\nChanged one line of README.md and added CHANGELOG.md.',
      ].join('\n'),
    }
  : {
      readRequest: [
        'This is a check the person asked for. Use the bash tool for each of these commands, one at a time, in order. Before each command, write one short sentence saying what you are about to run:',
        '1. `ls -la`',
        '2. `sleep 4 && cat README.md`',
        'Then ask this question in one sentence of plain text: "Should I summarise notes.txt or src/app.ts?", and end your turn to wait for the answer. Do not call finish yet.',
      ].join('\n'),
      steer: 'Also run `wc -l notes.txt` before you ask your question, and put the line count in the question.',
      answer: 'Summarise src/app.ts: read it, then call finish with one sentence that names its exported constant and its value, and the notes.txt line count.',
      followUp: 'Follow-up: how many lines does README.md have? Run `wc -l README.md`, then call finish with the number and nothing else.',
      editRequest: [
        'Make this small change in the repository:',
        '1. In README.md, change the line `It has a README, a source file and some notes.` to `It has a README, a source file, some notes and a changelog.`',
        '2. Create CHANGELOG.md with a `# Changelog` heading and one bullet: `- Added a changelog.`',
        '3. Run `git status --porcelain` to check your work.',
        'Then call finish. Its first line is the commit message: "Add a changelog".',
      ].join('\n'),
    }

// ── The app: fake Rust + a relay ────────────────────────────────────────────

interface App {
  rust: FakeRustProcess
  relay: LocalAgentRelay
  stop(): Promise<void>
}

let server: FakeServer
let fakeModel: FakeModel | null = null
let rustCfg: FakeRustConfig
/** The app running now, for the teardown whatever happened. */
let current: { rust: FakeRustProcess | null; app: App | null } = { rust: null, app: null }

async function launchRust(label: string): Promise<FakeRustProcess> {
  const rust = await forkFakeRust(rustCfg, (line) => {
    const m = /spawned .* \(pid (\d+),/.exec(line)
    if (m) launcherPids.add(Number(m[1]))
    record(`rust${label}`, { line })
  })
  record('app', { event: `fake Rust ${label} started`, pid: rust.pid })
  current.rust = rust
  return rust
}

async function startRelay(rust: FakeRustProcess, label: string): Promise<App> {
  const bridge = relayBridgeFor(rust, (c) => record(`bridge${label}`, { ...c }))
  const fetchApi = (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    headers.set('authorization', `Bearer ${server.token}`)
    return fetch(`${server.url}${path}`, { ...init, headers })
  }
  const { relay, active, stop } = await runHeadlessRelay({
    fetch: fetchApi,
    bridge,
    personName: () => PERSON,
    log: logLine(`relay${label}`),
    subscribeDoorbell: (on) => {
      const ring = () => on.ring()
      server.doorbell.on('ring', ring)
      return () => server.doorbell.off('ring', ring)
    },
  })
  if (!active) throw new Error(`relay ${label} did not start (the bridge says local agents are unavailable)`)
  record('app', { event: `relay ${label} started` })
  const app = { rust, relay, stop }
  current.app = app
  return app
}

const jobOf = async (rust: FakeRustProcess, id: string) => {
  const r = await rust.call<{ jobs: Array<Record<string, unknown>> }>({ cmd: 'status' })
  return r.ok ? (r.value.jobs.find((j) => j.id === id) ?? null) : null
}
const ringOf = async (rust: FakeRustProcess, id: string): Promise<Entry[]> => {
  const r = await rust.call<Entry[]>({ cmd: 'events', jobId: id, sinceSeq: 0 })
  return r.ok ? r.value : []
}
const sentOf = async (rust: FakeRustProcess, id: string): Promise<SentLine[]> => {
  const r = await rust.call<SentLine[]>({ cmd: 'sent' })
  return r.ok ? r.value.filter((s) => s.jobId === id) : []
}
const deviceEvents = (id: string, runId?: string): StoredEvent[] => server.events(id, { source: 'device', ...(runId !== undefined ? { runId } : {}) })
/** A turn that ended waiting for a message: the Mac body's question (message_teammate ends the turn, or the agent just stops). */
const isTurnEnd = (e: Entry) => e.event.kind === 'status' && e.event.status === 'waiting'
const sess = (id: string): SessionView => server.session(id)
const msgStatus = (id: string) => server.message(id)?.status

async function person(method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${server.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Processes still running from this run: the launchers it spawned, their children, and anything with this run's root in its command. */
function leftovers(): string[] {
  let rows: Array<{ pid: number; ppid: number; cmd: string }> = []
  try {
    rows = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((l) => {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)
        return m ? { pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] } : null
      })
      .filter((r): r is { pid: number; ppid: number; cmd: string } => r !== null)
  } catch {
    return []
  }
  const ours = new Set<number>([...launcherPids].filter(alive))
  for (let grew = true; grew; ) {
    grew = false
    for (const r of rows) if (ours.has(r.ppid) && !ours.has(r.pid)) (ours.add(r.pid), (grew = true))
  }
  return rows.filter((r) => ours.has(r.pid) || r.cmd.includes(root)).map((r) => `${r.pid} ${redact(r.cmd).slice(0, 120)}`)
}

// ── The run ─────────────────────────────────────────────────────────────────

async function main() {
  writeFileSync(logPath, '')
  if (!existsSync(join(agentDir, '.output/server/index.mjs'))) throw new Error('agents/local-agent is not built: run scripts/local-agent/build.sh')
  if (!fakeModelMode && !existsSync(envFile)) throw new Error(`LOCAL_AGENT_DEV_ENV_FILE not found: ${envFile} (or pass --fake-model)`)
  makeFixtures()
  // The model token secret: a throwaway one in fake-model mode (tokens.ts signs and verifies with it); none otherwise.
  delete process.env.LOCAL_AGENT_TOKEN_SECRET
  delete process.env.RUN_SKILL_INTERNAL_SECRET
  if (fakeModelMode) process.env.LOCAL_AGENT_TOKEN_SECRET = randomBytes(32).toString('base64url')
  server = await startFakeServer({ mintModelTokens: fakeModelMode, log: logLine('server') })
  secrets.push(server.token)
  if (fakeModelMode) fakeModel = await startFakeModel({ classifyToken: (t) => server.classifyToken(t), log: logLine('model') })
  rustCfg = {
    appData,
    home,
    worktreesRoot,
    node: process.execPath,
    agentDir,
    envFile: fakeModelMode ? null : envFile,
    apiOrigin: fakeModel?.origin ?? 'http://127.0.0.1:9',
    device: { name: 'E2E Mac', appVersion: '0.0.0-e2e' },
    gitEnv: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }
  record('setup', { mode: fakeModelMode ? 'fake-model' : 'real model (dev key)', root, logPath, server: server.url, model: fakeModel?.url ?? 'AI Gateway (dev key)' })
  console.log(`local-agent e2e (device half), ${fakeModelMode ? 'scripted model' : 'real model'}; log: ${logPath}`)

  // ── Setup: the app, its grants, the first heartbeat ──
  let rust = await launchRust('1')
  const readGrant = await rust.call<{ id: string }>({ cmd: 'addGrant', path: readFolder, mode: 'read' })
  const editGrant = await rust.call<{ id: string }>({ cmd: 'addGrant', path: gitRepo, mode: 'edit' })
  if (!readGrant.ok || !editGrant.ok) throw new Error('could not add the grants')
  let app = await startRelay(rust, '1')
  const deviceId = (await rust.call<{ deviceId: string }>({ cmd: 'device' }))
  const devId = deviceId.ok ? deviceId.value.deviceId : ''
  let readFolderId = ''
  let editFolderId = ''
  await step('S0 heartbeat mirrors the device and both grants', async () => {
    const folders = await waitFor('the folder mirror', 10_000, () => (server.folders().length >= 2 ? server.folders() : null))
    const readRow = folders.find((f) => f.grant_id === readGrant.value.id)
    const editRow = folders.find((f) => f.grant_id === editGrant.value.id)
    readFolderId = String(readRow?.id ?? '')
    editFolderId = String(editRow?.id ?? '')
    const dev = server.devices().find((d) => d.id === devId)
    return {
      deviceRegistered: !!dev && dev.name === 'E2E Mac' && dev.platform === 'macos',
      readFolderMirrored: !!readRow && readRow.mode === 'read' && readRow.revoked_at === null,
      editFolderMirrored: !!editRow && editRow.mode === 'edit' && editRow.is_git === true,
    }
  })

  const skipA = only === 'B' ? 'skipped (--only B)' : null
  const skipB = only === 'A' ? 'skipped (--only A)' : null

  // ── A: a read job ──
  let A = ''
  let runA1 = ''
  const a1 = await step('A1 start → claim → rebind → stream, tools, events with runId', async () => {
    const s = await server.createSession({ folderId: readFolderId, request: T.readRequest, mode: 'read' })
    A = s.id
    record('A', { session: A })
    await waitFor('a tool event on the server', 240_000, () => deviceEvents(A).some((e) => e.kind === 'tool'))
    const job = await jobOf(rust, A)
    runA1 = String(job?.runId ?? '')
    const evs = deviceEvents(A)
    const provisional = sess(A).claimRuns[0]
    jobTmps.push(join(realpathSync(tmpdir()), 'dial8-local-agent', A))
    return {
      claimedOnce: sess(A).claimRuns.length === 1,
      rustJobIsTheSession: job?.id === A && job?.live === true,
      provisionalRunReplaced: !!provisional && !!runA1 && provisional !== runA1,
      serverReboundToRustRun: sess(A).runId === runA1,
      eventsCarryTheRustRun: evs.length > 0 && evs.every((e) => e.runId === runA1),
      noEventUnderProvisionalRun: !server.events(A).some((e) => e.runId === provisional),
      toolCall: evs.some((e) => e.kind === 'tool'),
      statusRunning: sess(A).history.includes('running') && sess(A).status === 'running',
    }
  }, { skipIf: skipA })

  const a2 = await step('A2 a person steer mid-turn lands with the [From Liam] prefix', async () => {
    const r = await person('POST', `/api/local-agent/sessions/${A}/messages`, { text: T.steer, policy: 'steer' })
    if (r.status !== 200) throw new Error(`steer POST answered ${r.status}`)
    const messageId = String(r.json.messageId)
    await waitFor('the steer delivered', 60_000, () => msgStatus(messageId) === 'delivered')
    const sent = await sentOf(rust, A)
    const steer = sent.find((l) => l.type === 'send' && l.policy === 'steer')
    const ringNow = await ringOf(rust, A)
    const askedBeforeSteer = ringNow.some(isTurnEnd)
    // The turn the steer joined: wait for the question that ends it.
    const { at: askAt } = await waitFor('the question ending the turn', 300_000, async () => {
      const at = (await ringOf(rust, A)).findIndex(isTurnEnd)
      return at >= 0 && sess(A).status === 'waiting' ? { at } : null
    })
    const ring = await ringOf(rust, A)
    const before = ring.slice(0, askAt)
    const inbound = server.events(A, { source: 'server' }).find((e) => e.kind === 'inbound' && e.payload.messageId === messageId)
    const wc = before.some((e) => e.event.kind === 'tool' && /wc -l notes\.txt/.test(String(e.event.input)))
    return {
      deliveredAndAcked: msgStatus(messageId) === 'delivered',
      prefixed: !!steer && steer.text === `[From Liam] ${T.steer}`,
      sentBeforeTheTurnEnded: !!steer && !askedBeforeSteer,
      oneTurnUntilTheAsk: before.filter((e) => e.event.kind === 'status' && e.event.status === 'running').length === 1,
      steerFollowedInThatTurn: wc,
      inboundEventStored: inbound?.payload.author === 'person',
      streamedText: deviceEvents(A).some((e) => e.kind === 'text'),
    }
  }, { skipIf: skipA ?? (a1 ? null : 'A1 did not complete') })

  let answerId = ''
  const a3 = await step('A3 the question ends the turn → waiting → the Native Intelligence agent answers → the agent resumes', async () => {
    const ringAsked = await ringOf(rust, A)
    const ask = fakeModel?.c1.find((r) => r.route === 'tool' && r.toolName === 'message_teammate')
    const asked = {
      waiting: sess(A).status === 'waiting',
      // The question: C4's message_teammate through C1 (scripted), or the agent's words (real model, no C1).
      questionAsked: fakeModel
        ? !!ask && ask.auth === 'current' && /notes\.txt|src\/app\.ts/.test(String((ask.input as { text?: unknown } | undefined)?.text ?? ''))
        : /notes\.txt|src\/app\.ts/.test(ringAsked.filter((e) => e.event.kind === 'message').map((e) => String(e.event.text)).join(' ')),
      noOldAskEvent: !ringAsked.some((e) => e.event.kind === 'ask'),
    }
    const ringBefore = (await ringOf(rust, A)).length
    // message_local_agent: author agent (the cloud body answering the Mac body's question).
    const r = await server.addAgentMessage({ sessionId: A, text: T.answer, policy: 'queue' })
    answerId = r.messageId
    await waitFor('the answer delivered', 60_000, () => msgStatus(answerId) === 'delivered')
    const sent = await sentOf(rust, A)
    const answer = sent.find((l) => l.type === 'send' && l.text?.startsWith('[From the Dial8 agent] '))
    // The answer starts a new turn on the same launcher (running again).
    const resumed = await waitFor('a new turn running', 120_000, async () => {
      const ring = await ringOf(rust, A)
      return ring.slice(ringBefore).some((e) => e.event.kind === 'status' && e.event.status === 'running')
    })
    return {
      ...asked,
      prefixedAsTheNiAgent: answer?.text === `[From the Dial8 agent] ${T.answer}`,
      sameLauncher: answer?.runId === runA1,
      agentResumed: resumed,
    }
  }, { skipIf: skipA ?? (a2 ? null : 'A2 did not complete') })

  // A4: the webview reloads while the answered turn runs.
  let gap = 0
  const a4 = await step('A4 webview reload mid-turn → a new relay gap-fills from the ring', async () => {
    // The relay dies with whatever it hadn't sent (no flush), Rust and the launcher keep going.
    app.relay.dispose()
    const markAtDeath = sess(A).lastSeq ?? 0
    record('A', { event: 'relay 1 disposed (webview reload)', serverLastSeq: markAtDeath })
    const ringDone = await waitFor('finish + waiting in the ring', 300_000, async () => {
      const ring = await ringOf(rust, A)
      const f = ring.findIndex((e) => e.event.kind === 'finish')
      return f >= 0 && ring.slice(f).some((e) => e.event.kind === 'status' && e.event.status === 'waiting') ? ring : null
    })
    const lastRing = ringDone[ringDone.length - 1].seq
    gap = lastRing - (sess(A).lastSeq ?? 0)
    record('A', { event: 'gap before the new relay', serverLastSeq: sess(A).lastSeq, ringLastSeq: lastRing, gap })
    app = await startRelay(rust, '2')
    await waitFor('the gap uploaded', 30_000, () => (sess(A).lastSeq ?? 0) >= lastRing)
    await sleep(800)
    const ring = await ringOf(rust, A)
    const stored = deviceEvents(A, runA1).map((e) => e.seq!).sort((a, b) => a - b)
    const ringSeqs = ring.filter((e) => e.runId === runA1).map((e) => e.seq)
    const dupes = stored.length !== new Set(stored).size
    return {
      eventsWereUnsentAtTheReload: gap > 0,
      serverHasTheWholeRing: ringSeqs.every((s) => stored.includes(s)),
      noDuplicates: !dupes,
      contiguousFromOne: stored[0] === 1 && stored.every((s, i) => s === i + 1),
      sameRunAfterTheReload: sess(A).runId === runA1,
    }
  }, { skipIf: skipA ?? (a3 ? null : 'A3 did not complete') })

  await step('A5 finish → waiting (last_signal finish with the summary)', async () => {
    await waitFor('waiting + finish on the server', 60_000, () => sess(A).status === 'waiting' && sess(A).lastSignal === 'finish')
    const finishText = String(sess(A).lastSignalText ?? '')
    const h = sess(A).history
    return {
      waiting: sess(A).status === 'waiting',
      lastSignalFinish: sess(A).lastSignal === 'finish',
      summaryStored: finishText.length > 0,
      answeredTheQuestion: /42|answer/i.test(finishText),
      statusPath: h[0] === 'queued' && h.includes('starting') && h.includes('running') && h[h.length - 1] === 'waiting',
      rustJobWaiting: (await jobOf(rust, A))?.status === 'waiting',
    }
  }, { skipIf: skipA ?? (a4 ? null : 'A4 did not complete') })

  // A6: the app is killed outright.
  let runA2 = ''
  const a6 = await step('A6 kill the app (fake Rust) → relaunch → resume on a new run → follow-up answered', async () => {
    const live = await rust.call<number[]>({ cmd: 'livePids' })
    const pids = live.ok ? live.value : []
    const sessionBefore = (await jobOf(rust, A))?.sessionId
    app.relay.dispose() // the webview dies with the app
    rust.kill('SIGKILL')
    await rust.exited
    await waitFor('the launcher to exit after its stdin closed', 15_000, () => pids.every((p) => !alive(p)))
    const statusAtRelaunch = sess(A).status
    rust = await launchRust('2')
    const job = await jobOf(rust, A)
    const markedInterrupted = job?.status === 'interrupted' && job?.live === false && job?.lastSeq === 0 && job?.runId === runA1
    app = await startRelay(rust, '3')
    await sleep(1500)
    const serverStatusAfterRelaunch = sess(A).status
    record('A', { observation: 'server status after the relaunch (the relay only reconciles jobs that are live or hold ring events)', statusAtRelaunch, serverStatusAfterRelaunch })
    const r = await person('POST', `/api/local-agent/sessions/${A}/messages`, { text: T.followUp, policy: 'queue' })
    if (r.status !== 200) throw new Error(`follow-up POST answered ${r.status}`)
    const followId = String(r.json.messageId)
    await waitFor('the follow-up delivered', 90_000, () => msgStatus(followId) === 'delivered')
    const resumed = await jobOf(rust, A)
    runA2 = String(resumed?.runId ?? '')
    await waitFor('the follow-up answered', 300_000, () => {
      const evs = deviceEvents(A, runA2)
      const f = evs.findIndex((e) => e.kind === 'finish')
      return f >= 0 && evs.slice(f).some((e) => e.kind === 'status' && e.payload.status === 'waiting') && sess(A).status === 'waiting'
    })
    const sent = await sentOf(rust, A)
    const resumeLine = sent.find((l) => l.runId === runA2 && l.type === 'resume')
    const follow = sent.find((l) => l.runId === runA2 && l.type === 'send')
    const evs2 = deviceEvents(A, runA2)
    return {
      launcherWentWithTheApp: pids.length > 0 && pids.every((p) => !alive(p)),
      relaunchMarkedInterrupted: markedInterrupted,
      newRun: !!runA2 && runA2 !== runA1,
      resumedTheSameEveSession: !!resumeLine && resumeLine.sessionId === sessionBefore,
      serverReboundToTheNewRun: sess(A).runId === runA2,
      followUpPrefixed: follow?.text === `[From Liam] ${T.followUp}`,
      newRunSeqsFromOne: evs2.length > 0 && Math.min(...evs2.map((e) => e.seq!)) === 1,
      followUpAnswered: /\b4\b|four/i.test(String(evs2.find((e) => e.kind === 'finish')?.payload.summary ?? '')),
      serverWaitingWithFinish: sess(A).status === 'waiting' && sess(A).lastSignal === 'finish',
    }
  }, { skipIf: skipA ?? (a1 ? null : 'A1 did not complete') })

  await step('A7 stop → cancelled', async () => {
    const r = await person('POST', `/api/local-agent/sessions/${A}/stop`)
    if (r.status !== 200) throw new Error(`stop POST answered ${r.status}`)
    // With BUG-1 the Mac's `cancelled` events aren't derived; the relay's stop retry (15 s) posts it to /state instead.
    await waitFor('cancelled on the server', 60_000, () => sess(A).status === 'cancelled')
    const job = await waitFor('the job ended in Rust', 15_000, async () => {
      const j = await jobOf(rust, A)
      return j && j.live === false ? j : null
    })
    const ring = await ringOf(rust, A)
    const exit = [...ring].reverse().find((e) => e.event.kind === 'status')
    return {
      stopRequested: !!sess(A).stopRequestedAt,
      serverCancelled: sess(A).status === 'cancelled' && !!sess(A).endedAt,
      rustCancelled: job.status === 'cancelled',
      exitReasonStopped: exit?.event.status === 'cancelled' && exit?.event.reason === 'stopped',
      messagesRefusedNow: (await person('POST', `/api/local-agent/sessions/${A}/messages`, { text: 'still there?' })).status === 409,
    }
  }, { skipIf: skipA ?? (a6 ? null : 'A6 did not complete') })

  // ── B: an edit job ──
  let B = ''
  const repoHead = hostGit(['-C', gitRepo, 'rev-parse', 'HEAD']).trim()
  const b1 = await step('B1 edit job: worktree + branch, the change, Rust commits on finish, branch event', async () => {
    const s = await server.createSession({ folderId: editFolderId, request: T.editRequest, mode: 'edit' })
    B = s.id
    jobTmps.push(join(realpathSync(tmpdir()), 'dial8-local-agent', B))
    record('B', { session: B })
    await waitFor('the branch on the server', 360_000, () => !!sess(B).branch && !!sess(B).commitSha)
    await waitFor('waiting', 30_000, () => sess(B).status === 'waiting')
    const job = await jobOf(rust, B)
    const ring = await ringOf(rust, B)
    const branchEv = ring.find((e) => e.event.kind === 'branch')
    const finishAt = ring.findIndex((e) => e.event.kind === 'finish')
    const branchAt = ring.findIndex((e) => e.event.kind === 'branch')
    const worktree = join(realpathSync(worktreesRoot), B)
    const expectedBranch = `dial8/ni-e2e-app-${B.replace(/-/g, '').slice(0, 8)}`
    const committed = hostGit(['-C', gitRepo, 'show', '--name-only', '--format=', expectedBranch]).trim().split('\n').sort()
    const subject = hostGit(['-C', gitRepo, 'log', '-1', '--format=%s', expectedBranch]).trim()
    const stored = deviceEvents(B).find((e) => e.kind === 'branch')
    return {
      branchName: sess(B).branch === expectedBranch && job?.branch === expectedBranch,
      worktreeUnderTheRoot: existsSync(join(worktree, '.git')) && readFileSync(join(worktree, '.git'), 'utf8').startsWith('gitdir:'),
      changeInTheWorktree: readFileSync(join(worktree, 'README.md'), 'utf8').includes('some notes and a changelog.') && existsSync(join(worktree, 'CHANGELOG.md')),
      commitOnTheBranch: hostGit(['-C', gitRepo, 'rev-parse', expectedBranch]).trim() === sess(B).commitSha && sess(B).commitSha !== repoHead,
      commitHasTheChange: committed.join(',') === 'CHANGELOG.md,README.md',
      commitSubjectFromSummary: subject.length > 0 && subject.length <= 72 && /changelog/i.test(subject),
      branchEventAfterFinish: finishAt >= 0 && branchAt > finishAt && branchEv?.runId === job?.runId,
      branchEventCounts: branchEv?.event.filesChanged === 2,
      branchEventUploaded: !!stored && stored.seq === branchEv?.seq && stored.runId === branchEv?.runId,
      originalReadmeUntouched: readFileSync(join(gitRepo, 'README.md'), 'utf8') === README,
      originalHasNoChangelog: !existsSync(join(gitRepo, 'CHANGELOG.md')),
      originalBranchUntouched: hostGit(['-C', gitRepo, 'rev-parse', '--abbrev-ref', 'HEAD']).trim() === 'main',
      originalHeadUntouched: hostGit(['-C', gitRepo, 'rev-parse', 'HEAD']).trim() === repoHead,
      originalCheckoutClean: hostGit(['-C', gitRepo, 'status', '--porcelain']).trim() === '',
      hookNotRun: !existsSync(hookMarker),
    }
  }, { skipIf: skipB ?? (editFolderId ? null : 'no edit folder') })

  await step('B2 stop the edit job → cancelled, worktree kept', async () => {
    await person('POST', `/api/local-agent/sessions/${B}/stop`)
    await waitFor('cancelled on the server', 30_000, () => sess(B).status === 'cancelled')
    await waitFor('the job ended in Rust', 15_000, async () => (await jobOf(rust, B))?.live === false)
    return {
      serverCancelled: sess(B).status === 'cancelled',
      branchKeptOnTheSession: !!sess(B).branch,
      worktreeKept: existsSync(join(realpathSync(worktreesRoot), B, 'CHANGELOG.md')),
    }
  }, { skipIf: skipB ?? (b1 || B ? null : 'B1 did not start') })

  // The transcripts, compact, for the report.
  for (const [label, id] of [['A', A], ['B', B]] as const) {
    if (!id) continue
    const items = server.events(id).map((e) => {
      const p = e.payload
      const what = e.kind === 'tool' ? `tool:${String(p.name)}` : e.kind === 'status' ? `status:${String(p.status)}${p.reason ? `(${String(p.reason)})` : ''}` : e.kind === 'inbound' ? `inbound:${String(p.author)}` : e.kind
      return `${e.runId ? `${e.runId.slice(0, 4)}#${e.seq}` : 'srv'} ${what}`
    })
    record(`transcript${label}`, { session: id, status: sess(id).status, history: sess(id).history, items: items.filter((x) => !/ (text|message|tool_result)$/.test(x)) })
  }

  // ── Model path checks (scripted model only: the relay token path) ──
  if (fakeModel) {
    const reqs = fakeModel.requests
    await step('M model relay path: every call carried a live minted token; a refresh was used', async () => ({
      someCalls: reqs.length > 0,
      allToTheRelayPath: reqs.every((r) => r.path === '/api/local-agent/model/language-model'),
      allowlistedModel: reqs.every((r) => r.modelId === 'anthropic/claude-sonnet-5.5'),
      noRefusedCall: reqs.every((r) => r.auth === 'current'),
      refreshedTokenUsed: reqs.some((r) => (r.tokenGen ?? 0) >= 2),
    }))
    const c1 = fakeModel.c1
    await step('C the app (C1): spec and tool calls carried a live minted token; the teammate tools went through it', async () => ({
      specFetched: c1.some((r) => r.route === 'spec'),
      toolCalls: c1.some((r) => r.route === 'tool'),
      noRefusedCall: c1.every((r) => r.auth === 'current'),
      refreshedTokenUsed: c1.some((r) => (r.tokenGen ?? 0) >= 2),
      reportWentThroughC1: c1.some((r) => r.toolName === 'report_to_person'),
      teammateCallCarriesEveIds: c1.filter((r) => r.toolName === 'message_teammate').every((r) => typeof r.ids?.callId === 'string' && typeof r.ids?.turnId === 'string' && typeof r.ids?.sessionId === 'string'),
    }))
  }

}

async function teardown() {
  // The relay (flush, then stop), then the app's own quit (stop every job, mark them interrupted).
  if (current.app) await Promise.race([current.app.stop(), sleep(5_000)]).catch(() => {})
  if (current.rust) {
    await Promise.race([current.rust.call({ cmd: 'shutdown' }), sleep(5_000)])
    current.rust.kill('SIGTERM')
    await Promise.race([current.rust.exited, sleep(3_000)])
  }
  await fakeModel?.close().catch(() => {})
  await server?.close().catch(() => {})
  await sleep(500)
  const left = leftovers()
  results.push({ step: 'Z nothing left running', result: left.length === 0 ? 'PASS' : 'FAIL', ms: 0, checks: { noLeftovers: left.length === 0 }, ...(left.length ? { note: left.join('; ') } : {}) })
  record('step', { step: 'Z nothing left running', leftovers: left })
  console.log(`${left.length === 0 ? 'PASS' : 'FAIL'} Z nothing left running${left.length ? `: ${left.join('; ')}` : ''}`)
  if (!keep) {
    rmSync(root, { recursive: true, force: true })
    for (const d of jobTmps) rmSync(d, { recursive: true, force: true })
  }
}

main()
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    record('e2e', { fatal: message })
    console.error(`E2E aborted: ${redact(message)}`)
    results.push({ step: 'setup', result: 'FAIL', ms: 0, checks: {}, note: message })
  })
  .finally(async () => {
    await teardown()
    const failed = results.filter((r) => r.result === 'FAIL').map((r) => r.step)
    const known = results.filter((r) => r.result === 'KNOWN-BUG').map((r) => r.step)
    const summary = { result: failed.length ? 'FAIL' : known.length ? 'PASS (with known bugs)' : 'PASS', known, mode: fakeModelMode ? 'fake-model' : 'real-model', failed, steps: results.map((r) => ({ step: r.step, result: r.result, s: Number((r.ms / 1000).toFixed(1)), ...(r.note ? { note: r.note } : {}) })), log: logPath }
    record('e2e', summary)
    console.log(redact(JSON.stringify(summary, null, 2)))
    process.exit(failed.length ? 1 : 0)
  })
