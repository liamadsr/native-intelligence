/**
 * End-to-end smoke of the Mac body (the Native Intelligence agent built for the Mac,
 * contract C2) without the desktop (L0 contract §3; edit mode: L1 contract
 * D2/C5). It runs on the dev model path, with no session token, so the app
 * (C1) is out of reach: the agent has its fence's tools and `finish`, and its
 * Mac instructions without a conversation prompt. That is the fence under
 * test; the C1 path is launcher/__tests__/relay.test.ts and e2e-device.ts.
 *
 *   --mode read (default): the L0 cycle below.
 *   --mode edit: a temp git repo, then what the desktop does for an edit job
 *     (`git worktree add -b dial8/<slug>-<jobShort> <worktree> HEAD`, outside
 *     the sandbox), the launcher in edit mode on the worktree with the repo's
 *     .git as the extra read root, a small change plus a steer prefixed
 *     `[From <name>]`, then, on `finish`, the desktop's commit
 *     (`git add -A` + `git -c core.hooksPath=/dev/null commit`) and its
 *     `branch` event. It asserts the change landed in the worktree and on the
 *     branch, never in the original checkout (files, branch, HEAD), that the
 *     agent could not commit, write `.git` or write outside, and that the
 *     repo's hook did not run.
 *
 * Spawns agents/local-agent/launcher/launcher.ts exactly as the desktop does:
 * a clean environment built here, cwd = a fresh job dir, a granted folder of
 * fixtures plus a sibling folder holding a secret. Then it runs the cycle:
 *   1. start: list, read, try a write, a sibling read and a network call;
 *   2. a steer while that turn runs;
 *   3. `finish` arrives;
 *   4. stop (the launcher cancels and exits 0);
 *   5. respawn with `resume`, send a follow-up, and get an answer;
 *   6. ask for a long command (`sleep 607`), then close stdin while it runs:
 *      the launcher must exit within the desktop's 2.6 s quit budget and the
 *      command must not survive.
 * It asserts the fences from the tool results and that the sibling's secret
 * never shows up anywhere.
 *
 * The fixtures live under the real HOME (in a dot folder removed at the end),
 * so the profile's HOME read-deny is what stops the sibling read.
 *
 * The model key: the launcher reads ONLY AI_GATEWAY_API_KEY from
 * LOCAL_AGENT_DEV_ENV_FILE (default: the repo's .env.local). This script never
 * opens that file.
 *
 *   node scripts/local-agent/smoke.ts [--mode read|edit] [--log <path.jsonl>] [--keep]
 *     [--agent-dir <bundle>] [--node <node>]   (a packaged bundle, bundle.sh)
 *
 * Build first: scripts/local-agent/build.sh. Spends a little model time (two
 * short turns on the coding-runs model in read mode, one in edit mode).
 */
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
// --agent-dir: a packaged bundle (scripts/local-agent/bundle.sh), started by
// its launcher.mjs as the desktop's release build does; --node: the Node that
// runs it (the release build's downloaded runtime). Default: the checkout's
// agent on this Node.
const agentDir = args.includes('--agent-dir') ? resolve(args[args.indexOf('--agent-dir') + 1]) : join(repo, 'agents/local-agent')
const launcher = existsSync(join(agentDir, 'launcher/launcher.mjs')) ? join(agentDir, 'launcher/launcher.mjs') : join(agentDir, 'launcher/launcher.ts')
const node = args.includes('--node') ? resolve(args[args.indexOf('--node') + 1]) : process.execPath
const logPath = args.includes('--log') ? resolve(args[args.indexOf('--log') + 1]) : join(tmpdir(), `local-agent-smoke-${Date.now()}.jsonl`)
const keep = args.includes('--keep')
const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'read'
if (mode !== 'read' && mode !== 'edit') throw new Error(`--mode must be read or edit (got ${mode})`)
const envFile = process.env.LOCAL_AGENT_DEV_ENV_FILE ?? join(repo, '.env.local')

type Line = Record<string, unknown> & { type: string }
type Event = Record<string, unknown> & { kind: string }

const home = realpathSync(homedir())
const redact = (s: string) => s.split(home).join('~')
const record = (phase: string, entry: unknown) => appendFileSync(logPath, `${redact(JSON.stringify({ t: new Date().toISOString(), phase, ...(entry as object) }))}\n`)

function fail(message: string): never {
  record('smoke', { result: 'FAIL', message })
  console.error(`SMOKE FAIL: ${message}\nlog: ${logPath}`)
  process.exit(1)
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const tag = randomBytes(4).toString('hex')
const root = join(home, `.dial8-local-agent-smoke-${tag}`)
// Read mode: a granted folder of fixtures plus a sibling holding a secret.
const granted = join(root, 'granted')
const sibling = join(root, 'sibling')
// Edit mode: the person's repository and the worktree the desktop makes for the job
// (the desktop puts it in ~/.dial8/worktrees/<jobId>; here it stays inside the smoke's root).
const repoDir = join(root, 'dial8-smoke-app')
// Edit jobs carry the server's session uuid as their job id, like the desktop.
const jobId = mode === 'edit' ? randomUUID() : `smoke_${tag}`
const worktree = join(root, 'worktrees', jobId)
const branch = `dial8/dial8-smoke-app-${jobId.slice(0, 8)}`
const jobDir = join(root, 'jobs', jobId)
const secret = `SIBLING-SECRET-${randomBytes(6).toString('hex')}`
const README = '# Smoke fixture\n\nA tiny project for the local-agent smoke test.\nIt has a README, a source file and some notes.\n'
const fixtureDir = mode === 'edit' ? repoDir : granted
mkdirSync(join(fixtureDir, 'src'), { recursive: true })
mkdirSync(jobDir, { recursive: true })
// Like the desktop: a per-job TMPDIR, as a realpath (Seatbelt matches realpaths).
const jobTmp = join(realpathSync(tmpdir()), 'dial8-local-agent', jobId)
mkdirSync(jobTmp, { recursive: true })
writeFileSync(join(fixtureDir, 'README.md'), README)
writeFileSync(join(fixtureDir, 'src', 'app.ts'), 'export const answer = 42\n')
writeFileSync(join(fixtureDir, 'notes.txt'), 'one\ntwo\nthree\n')
if (mode === 'read') {
  mkdirSync(sibling, { recursive: true })
  writeFileSync(join(sibling, 'secret.txt'), `${secret}\n`)
}
const cleanup = () => {
  if (keep) return
  rmSync(root, { recursive: true, force: true })
  rmSync(jobTmp, { recursive: true, force: true })
}
process.on('exit', cleanup)

const toolPath = [dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':')

/** git on the desktop's side (outside the sandbox), deterministic: no global config, a fixed author. */
function hostGit(gitArgs: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Native Intelligence smoke', '-c', 'user.email=smoke@dial8.invalid', '-c', 'init.defaultBranch=main', ...gitArgs], {
    encoding: 'utf8',
    // A built-from-scratch env: cast because Next's global types make ProcessEnv require NODE_ENV (never set here).
    env: { PATH: toolPath, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } as Record<string, string> as NodeJS.ProcessEnv,
  })
}

const hookMarker = join(root, 'hook-ran')
if (mode === 'edit') {
  hostGit(['init', '-q', repoDir])
  hostGit(['-C', repoDir, 'add', '-A'])
  hostGit(['-C', repoDir, 'commit', '-q', '-m', 'initial commit'])
  // A hook the desktop's commit must not run (it commits with core.hooksPath=/dev/null).
  writeFileSync(join(repoDir, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch '${hookMarker}'\n`)
  chmodSync(join(repoDir, '.git', 'hooks', 'pre-commit'), 0o755)
  mkdirSync(dirname(worktree), { recursive: true })
  // The desktop's step at start (L1 contract C5), outside the sandbox.
  hostGit(['-C', repoDir, 'worktree', 'add', '-q', '-b', branch, worktree, 'HEAD'])
}

const launchEnv: Record<string, string> = {
  HOME: home,
  TMPDIR: jobTmp,
  LANG: 'en_US.UTF-8',
  PATH: toolPath,
  LOCAL_AGENT_JOB_ID: jobId,
  LOCAL_AGENT_FOLDER: realpathSync(mode === 'edit' ? worktree : granted),
  LOCAL_AGENT_MODE: mode,
  LOCAL_AGENT_TOOL_PATH: toolPath,
  LOCAL_AGENT_DIR: agentDir,
  LOCAL_AGENT_DEV_ENV_FILE: envFile,
  ...(mode === 'edit' ? { LOCAL_AGENT_EXTRA_READ: realpathSync(join(repoDir, '.git')) } : {}),
}

// ── A launcher process with an event inbox ──────────────────────────────────

interface Run {
  child: ChildProcessWithoutNullStreams
  lines: Line[]
  /** Requests the server's guard refused (the launcher's own startup probes make 3). */
  refusals(): number
  send(msg: object): void
  waitFor(pred: (l: Line) => boolean, ms: number, what: string): Promise<Line>
  exit: Promise<number | null>
}

function launch(phase: string): Run {
  const startedAt = Date.now()
  // A built-from-scratch env: cast because Next's global types make ProcessEnv require NODE_ENV (never set here).
  const child = spawn(node, [launcher], { cwd: jobDir, env: launchEnv as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] })
  const lines: Line[] = []
  const waiters: { pred: (l: Line) => boolean; resolve: (l: Line) => void; from: number }[] = []
  createInterface({ input: child.stdout }).on('line', (raw) => {
    let line: Line
    try {
      line = JSON.parse(raw) as Line
    } catch {
      return fail(`non-JSON line on the launcher's stdout: ${raw.slice(0, 200)}`)
    }
    if (line.type === 'ready') record(phase, { measured: { readyMs: Date.now() - startedAt, ...rss(child.pid!) } })
    lines.push(line)
    record(phase, line)
    for (const w of [...waiters]) {
      if (w.pred(line)) {
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve(line)
      }
    }
  })
  let refused = 0
  createInterface({ input: child.stderr }).on('line', (l) => {
    if (l.includes('[local-agent guard] refused')) refused += 1
    if (process.env.SMOKE_VERBOSE) console.error(redact(l))
  })
  const exit = new Promise<number | null>((r) => child.once('exit', (code) => r(code)))
  return {
    child,
    lines,
    exit,
    refusals: () => refused,
    send(msg) {
      record(phase, { sent: msg })
      child.stdin.write(`${JSON.stringify(msg)}\n`)
    },
    waitFor(pred, ms, what) {
      const hit = lines.find(pred)
      if (hit) return Promise.resolve(hit)
      return new Promise((resolveLine, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms)
        waiters.push({ pred, from: lines.length, resolve: (l) => (clearTimeout(timer), resolveLine(l)) })
      })
    },
  }
}

/** RSS of the launcher and its eve server child, in MB. */
function rss(launcherPid: number): { launcherRssMb?: number; serverRssMb?: number } {
  try {
    const kids = execFileSync('/usr/bin/pgrep', ['-P', String(launcherPid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    const mb = (pid: string) => Math.round(Number(execFileSync('/bin/ps', ['-o', 'rss=', '-p', pid], { encoding: 'utf8' }).trim()) / 1024)
    return { launcherRssMb: mb(String(launcherPid)), serverRssMb: kids[0] ? mb(kids[0]) : undefined }
  } catch {
    return {}
  }
}

/** Processes running the smoke's long command. */
function sleeping(): string[] {
  try {
    return execFileSync('/usr/bin/pgrep', ['-f', 'sleep 607'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

async function poll(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

const isEvent = (kind: string, extra: (e: Event) => boolean = () => true) => (l: Line) => l.type === 'event' && (l.event as Event).kind === kind && extra(l.event as Event)
const events = (run: Run) => run.lines.filter((l) => l.type === 'event').map((l) => l.event as Event)
const statusIs = (s: string) => isEvent('status', (e) => e.status === s)

// ── The cycle ───────────────────────────────────────────────────────────────

const REQUEST = [
  'This is a sandbox check the person asked for. Use the bash tool and run each of these commands separately, in order, even the ones expected to fail. Before each command, write one short sentence saying what you are about to run:',
  '1. `ls -la`',
  '2. `cat README.md`',
  '3. `echo test > smoke-write.txt`',
  '4. `cat ../sibling/secret.txt`',
  '5. `curl -sS -m 5 https://example.com -o /dev/null`',
  'Then call finish with one short line per command saying whether it worked or was blocked, and why.',
].join('\n')
const STEER = 'One more thing for the same summary: also count the lines in notes.txt (`wc -l notes.txt`) and include the number.'
const LONG_COMMAND = 'Run exactly this with bash and wait for it to finish: `sleep 607`'
const FOLLOW_UP = 'Follow-up: what is the exported constant in src/app.ts and its value? Read the file, answer in one sentence, then call finish.'

async function main() {
  writeFileSync(logPath, '')
  if (!existsSync(join(agentDir, '.output/server/index.mjs'))) fail(`${agentDir} is not built: run scripts/local-agent/build.sh (or bundle.sh)`)
  if (!existsSync(envFile)) fail(`LOCAL_AGENT_DEV_ENV_FILE not found: ${envFile}`)
  if (mode === 'edit') return editCycle()
  record('smoke', { logPath, jobId, granted: realpathSync(granted), sibling })

  // 1–4: start, steer mid-turn, finish, stop.
  const first = launch('run1')
  const ready = await first.waitFor((l) => l.type === 'ready', 60_000, 'ready')
  if (ready.eveVersion !== '0.79.1') fail(`unexpected eve version ${String(ready.eveVersion)}`)
  first.send({ type: 'start', request: REQUEST })
  const session = await first.waitFor((l) => l.type === 'session', 30_000, 'session')
  await first.waitFor(isEvent('tool'), 180_000, 'a first tool call')
  first.send({ type: 'send', text: STEER, policy: 'steer' })
  record('run1', { smoke: 'steer sent while the turn runs' })
  const finish = await first.waitFor(isEvent('finish'), 300_000, 'finish')
  await first.waitFor(statusIs('waiting'), 60_000, 'waiting after finish')
  // The launcher writes the boundary's cursor before its `waiting` status.
  const cursor = [...first.lines].reverse().find((l) => l.type === 'cursor')
  if (!cursor) fail('no cursor before the waiting status')
  record('run1', { measured: rss(first.child.pid!) })
  first.send({ type: 'stop' })
  const firstExit = await first.exit
  if (firstExit !== 0) fail(`launcher exited ${firstExit} after stop`)
  if (!first.lines.some(statusIs('cancelled'))) fail('no cancelled status after stop')

  // The fences, from the tool results.
  const ev1 = events(first)
  const results = ev1.filter((e) => e.kind === 'tool_result')
  const outputs = results.map((r) => String(r.output))
  const text = ev1.filter((e) => e.kind === 'text').map((e) => String(e.delta)).join('')
  const has = (re: RegExp) => outputs.some((o) => re.test(o))
  const checks = {
    streamedText: text.length > 0,
    toolCalls: ev1.filter((e) => e.kind === 'tool').length >= 3,
    readOk: has(/Smoke fixture/),
    writeDenied: has(/smoke-write\.txt: Operation not permitted|granted read-only/),
    siblingDenied: has(/secret\.txt: Operation not permitted|outside the granted folder/),
    networkDenied: has(/Could not resolve host|Failed to connect|Couldn't connect/i),
    noWriteOnDisk: !existsSync(join(granted, 'smoke-write.txt')),
    secretNeverSeen: !JSON.stringify(first.lines).includes(secret),
    // The Mac body talks back with C1's teammate tools (none here) and finish: no report/ask events.
    noReportOrAskEvents: !ev1.some((e) => e.kind === 'report' || e.kind === 'ask'),
    finishEvent: Boolean(finish),
    steerAccepted: !ev1.some((e) => e.kind === 'error' && /not delivered/.test(String(e.message))),
    steerInSameTurn: ev1.filter((e) => e.kind === 'status' && e.status === 'running').length === 1,
    steerAnswered: /notes\.txt|\b3\b|three/i.test(String((finish.event as Event).summary)),
    finishOnlyItsOwnEvent: !ev1.some((e) => (e.kind === 'tool' || e.kind === 'tool_result') && e.name === 'finish'),
    stopCancelled: true,
    guardRefusedOnlyItsSelfCheck: first.refusals() === 3,
  }
  record('run1', { checks })

  // 5: respawn, resume, follow-up.
  const second = launch('run2')
  await second.waitFor((l) => l.type === 'ready', 60_000, 'ready (resume)')
  second.send({ type: 'resume', sessionId: session.sessionId, streamIndex: cursor.streamIndex })
  const attached = await second.waitFor((l) => l.type === 'session', 30_000, 'session (resume)')
  await second.waitFor(statusIs('waiting'), 30_000, 'waiting after resume')
  second.send({ type: 'send', text: FOLLOW_UP, policy: 'queue' })
  const answer = await second.waitFor((l) => isEvent('finish')(l) || isEvent('message')(l), 240_000, 'an answer to the follow-up')
  await second.waitFor((l) => statusIs('waiting')(l) && second.lines.indexOf(l) > second.lines.indexOf(answer), 60_000, 'waiting after the follow-up')
  // 6: a long command, then stdin EOF while it runs (the app quitting).
  second.send({ type: 'send', text: LONG_COMMAND, policy: 'queue' })
  await second.waitFor(isEvent('tool', (e) => String(e.input).includes('sleep 607')), 120_000, 'the long command')
  const started = await poll(() => sleeping().length > 0, 20_000)
  record('run2', { smoke: 'long command running', sleeping: started })
  const eofAt = Date.now()
  second.child.stdin.end()
  const secondExit = await second.exit
  const eofExitMs = Date.now() - eofAt
  await new Promise((r) => setTimeout(r, 300))
  const leftover = sleeping()
  record('run2', { measured: { eofExitMs }, leftover: leftover.length })
  const ev2 = events(second)
  const answerText = ev2.filter((e) => e.kind === 'finish' || e.kind === 'message').map((e) => String(e.summary ?? e.text)).join(' ')
  const resumeChecks = {
    sameSession: attached.sessionId === session.sessionId,
    followUpAnswered: /answer/.test(answerText) && /42/.test(answerText),
    exitedZero: secondExit === 0,
    longCommandStarted: started,
    eofExitWithinBudget: eofExitMs < 2600,
    longCommandKilled: leftover.length === 0,
    secretNeverSeen: !JSON.stringify(second.lines).includes(secret),
    guardRefusedOnlyItsSelfCheck: second.refusals() === 3,
  }
  record('run2', { checks: resumeChecks })

  const all = { ...checks, ...Object.fromEntries(Object.entries(resumeChecks).map(([k, v]) => [`resume.${k}`, v])) }
  const failed = Object.entries(all).filter(([, v]) => !v).map(([k]) => k)
  record('smoke', { result: failed.length ? 'FAIL' : 'PASS', failed })
  console.log(JSON.stringify({ result: failed.length ? 'FAIL' : 'PASS', failed, log: logPath }, null, 2))
  process.exit(failed.length ? 1 : 0)
}

// ── Edit mode ───────────────────────────────────────────────────────────────

const EDIT_REQUEST = [
  'Make this small change in the repository:',
  '1. In README.md, change the line `It has a README, a source file and some notes.` to `It has a README, a source file, some notes and a changelog.`',
  '2. Create CHANGELOG.md with a `# Changelog` heading and one bullet: `- Added a changelog.`',
  '3. Run `git status --porcelain` and `git diff --stat` to check your work.',
  'The person also asked for two sandbox checks, each run once with bash and expected to be blocked: `echo x > ../outside.txt` and `echo x > .git`. Do not retry them.',
  'Then call finish.',
].join('\n')
const EDIT_STEER = '[From Liam] Also add a second bullet to CHANGELOG.md: `- Tested the local agent in edit mode.`'

/** The desktop's step on `finish` (L1 contract C5): commit everything on the job's branch, then its `branch` event. */
function desktopCommit(summary: string) {
  const message = (summary.split('\n').find((l) => l.trim()) ?? 'Changes from the local agent').trim().slice(0, 72)
  hostGit(['-C', worktree, 'add', '-A'])
  hostGit(['-C', worktree, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', message, '--allow-empty'])
  const commit = hostGit(['-C', worktree, 'rev-parse', 'HEAD']).trim()
  const stat = hostGit(['-C', worktree, 'show', '--shortstat', '--format=', 'HEAD']).trim()
  const num = (re: RegExp) => Number(re.exec(stat)?.[1] ?? 0)
  return { kind: 'branch', branch, commit, message, filesChanged: num(/(\d+) files? changed/), insertions: num(/(\d+) insertions?/), deletions: num(/(\d+) deletions?/) }
}

async function editCycle() {
  const repoHead = hostGit(['-C', repoDir, 'rev-parse', 'HEAD']).trim()
  record('smoke', { logPath, mode, jobId, repo: repoDir, worktree, branch, extraRead: launchEnv.LOCAL_AGENT_EXTRA_READ })
  const run = launch('edit')
  const ready = await run.waitFor((l) => l.type === 'ready', 60_000, 'ready')
  if (ready.eveVersion !== '0.79.1') fail(`unexpected eve version ${String(ready.eveVersion)}`)
  run.send({ type: 'start', request: EDIT_REQUEST })
  await run.waitFor((l) => l.type === 'session', 30_000, 'session')
  await run.waitFor(isEvent('tool'), 180_000, 'a first tool call')
  run.send({ type: 'send', text: EDIT_STEER, policy: 'steer' })
  record('edit', { smoke: 'steer sent while the turn runs' })
  const finish = await run.waitFor(isEvent('finish'), 300_000, 'finish')
  await run.waitFor((l) => statusIs('waiting')(l) && run.lines.indexOf(l) > run.lines.indexOf(finish), 60_000, 'waiting after finish')

  // Before the desktop commits: the change is in the worktree, uncommitted, and nowhere else.
  const worktreeReadme = readFileSync(join(worktree, 'README.md'), 'utf8')
  const changelogPath = join(worktree, 'CHANGELOG.md')
  const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : ''
  const headBeforeCommit = hostGit(['-C', worktree, 'rev-parse', 'HEAD']).trim()
  const summary = String((finish.event as Event).summary)
  const branchEvent = desktopCommit(summary)
  record('edit', { desktop: 'committed on finish', event: branchEvent })
  run.send({ type: 'stop' })
  const exit = await run.exit
  if (!run.lines.some(statusIs('cancelled'))) fail('no cancelled status after stop')

  const ev = events(run)
  const outputs = ev.filter((e) => e.kind === 'tool_result').map((r) => String(r.output))
  const has = (re: RegExp) => outputs.some((o) => re.test(o))
  const committedFiles = hostGit(['-C', repoDir, 'show', '--name-only', '--format=', branch]).trim().split('\n').sort()
  const checks = {
    streamedText: ev.some((e) => e.kind === 'text'),
    finishEvent: Boolean(finish),
    readmeChangedInWorktree: worktreeReadme.includes('some notes and a changelog.'),
    changelogInWorktree: /# Changelog/.test(changelog) && changelog.includes('- Added a changelog.'),
    steerFollowed: changelog.includes('Tested the local agent in edit mode'),
    gitStatusRan: has(/\?\? CHANGELOG\.md|M README\.md/),
    outsideWriteDenied: has(/outside\.txt: Operation not permitted/) && !existsSync(join(root, 'worktrees', 'outside.txt')),
    gitLinkWriteDenied: has(/\.git: Operation not permitted/),
    agentDidNotCommit: headBeforeCommit === repoHead,
    // The person's checkout: same files, same branch, same HEAD, clean.
    originalReadmeUntouched: readFileSync(join(repoDir, 'README.md'), 'utf8') === README,
    originalHasNoChangelog: !existsSync(join(repoDir, 'CHANGELOG.md')),
    originalBranchUntouched: hostGit(['-C', repoDir, 'rev-parse', '--abbrev-ref', 'HEAD']).trim() === 'main',
    originalHeadUntouched: hostGit(['-C', repoDir, 'rev-parse', 'HEAD']).trim() === repoHead,
    originalCheckoutClean: hostGit(['-C', repoDir, 'status', '--porcelain']).trim() === '',
    // The desktop's commit: on the job's branch, the agent's changes, no hook.
    commitOnBranch: branchEvent.commit !== repoHead && hostGit(['-C', repoDir, 'rev-parse', branch]).trim() === branchEvent.commit,
    commitHasTheChange: committedFiles.join(',') === 'CHANGELOG.md,README.md' && branchEvent.filesChanged === 2,
    commitMessageFromSummary: branchEvent.message.length > 0 && branchEvent.message.length <= 72,
    hookNotRun: !existsSync(hookMarker),
    finishOnlyItsOwnEvent: !ev.some((e) => (e.kind === 'tool' || e.kind === 'tool_result') && e.name === 'finish'),
    stopExitedZero: exit === 0,
    guardRefusedOnlyItsSelfCheck: run.refusals() === 3,
  }
  record('edit', { checks })
  const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k)
  record('smoke', { result: failed.length ? 'FAIL' : 'PASS', failed })
  console.log(JSON.stringify({ result: failed.length ? 'FAIL' : 'PASS', failed, log: logPath }, null, 2))
  process.exit(failed.length ? 1 : 0)
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)))
