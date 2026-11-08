/**
 * The whole L1–L3 local-agent chain on DEV, headless (Part B of the L1 e2e).
 * Only the webview and Rust are stood in for; everything else is real:
 *
 *   chat turn ──▶ next dev :3001 /eve/chat-agent (real chat-agent) ──▶ start_local_agent
 *        ──▶ /api/internal/chat/tool ──▶ local_agent_session + tracked_job + doorbell (DEV)
 *   headless relay (relay-core) ◀── Realtime device:<uid> (or the 5 s poll)
 *        ──▶ /api/local-agent/* (real routes) ──▶ fake Rust (e2e/fake-rust.ts, as the desktop)
 *        ──▶ the REAL launcher, LOCAL_AGENT_MODEL_BASE_URL = <base>/api/local-agent/model,
 *            the claim's model token ──▶ the REAL model relay route ──▶ AI Gateway
 *
 * Steps (each PASS / FAIL / SKIP / KNOWN-BUG, timed; DB checks through the
 * service role, DEV only):
 *   D0 preflight: migration 410 is on DEV, the fixture person and workspace,
 *      a session for them, the app answering on the base URL.
 *   D1 the device: heartbeat → user_device + device_folder rows.
 *   C1 a real chat turn ("take a look at the folder I attached…") calls
 *      start_local_agent → a queued session, its ledger row, the doorbell.
 *      (--chat-fallback: the chat tool route's start_local_agent branch with
 *      a minted chat-run token instead, the way the route tests call it.)
 *   C2 the headless relay claims it and spawns the launcher on the relay path
 *      with the claim's token; the run rebind lands.
 *   C3 model calls go through the real relay route (the job progresses with
 *      no dev key; ai_usage_logs gets feature local_agent).
 *   C4 a person steer through the person route lands mid-turn.
 *   C5 finish → waiting; the turn's tracked_job settles.
 *   C6 the report lands in the chat; the Native Intelligence agent's home turn runs (needs
 *      the Inngest dev server; SKIP without it).
 *   C7 the app is killed, relaunched; a person message resumes the same eve
 *      session on a new run and is answered.
 *   C8 stop → cancelled.
 *   E1 an edit job (a second chat turn, or the fallback): Rust's worktree,
 *      the change, the finish commit, the `branch` event on the session; the
 *      original checkout untouched, its hook never run.
 *   E2 stop the edit job.
 *   Z  nothing left running.
 *
 * HARD GUARD: refuses unless NEXT_PUBLIC_SUPABASE_URL's host is
 * edrjddsxjoigpbecqgfb.supabase.co (DEV); PROD (bzfthjzyzevjokbuhqci) never.
 * The base URL must be loopback on :3001; :3000 is never touched.
 *
 * The fixture (DEV only, reused across runs): the auth user
 * local-agent-e2e@dial8-evals.test (a reserved .test domain, no password),
 * their own workspace marked settings.eval_fixture = true with them as its
 * only member, a complimentary subscription (the usage gate), and a new chat
 * conversation per run. scripts/eval-fixture.ts is the precedent. A session
 * comes from a magic link verified server side (scripts/eve-chat-driver.ts),
 * sent to the routes as `Authorization: Bearer <access token>`.
 *
 *   npx tsx scripts/local-agent/e2e-dev.ts --dry-run                  # the guard + config only: no DB, no network
 *   npx tsx scripts/local-agent/e2e-dev.ts --start-next [--log <path.jsonl>] [--chat-fallback] [--only read|edit] [--keep]
 *
 * --start-next runs `npm run dev` on PORT=3001 for the run (logged next to
 * the e2e log) and stops it after; without it the app must already answer on
 * --base (default http://127.0.0.1:3001). Spends at most 2 local-agent jobs
 * and 2 chat turns. Never prints a secret; the log is redacted.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { EVAL_DEV_SUPABASE_HOST, isDevSupabaseUrl } from '../../agents/chat-agent/lib/eval-fixture-identity'
import { runHeadlessRelay, type LocalAgentRelay } from '@/lib/local-agent/relay-core'
import { relayBridgeFor } from './e2e/bridge'
import { forkFakeRust, type Entry, type FakeRustConfig, type FakeRustProcess, type SentLine } from './e2e/fake-rust'
import { alive, createHarness, FIXTURE_README, leftovers, makeFixtures, sleep, waitFor } from './e2e/harness'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const agentDir = join(repo, 'agents/local-agent')
const args = process.argv.slice(2)
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const DRY_RUN = args.includes('--dry-run')
const START_NEXT = args.includes('--start-next')
const CHAT_FALLBACK = args.includes('--chat-fallback')
const KEEP = args.includes('--keep')
const ONLY = arg('--only') ?? null
const BASE = (arg('--base') ?? 'http://127.0.0.1:3001').replace(/\/+$/, '')
const LOG_PATH = resolve(arg('--log') ?? join(tmpdir(), `l1-e2e-log-${Date.now()}.jsonl`))
const NEXT_LOG = resolve(arg('--next-log') ?? join(dirname(LOG_PATH), 'e2e-next.log'))

const PROD_REF = 'bzfthjzyzevjokbuhqci'
const FIXTURE_EMAIL = 'local-agent-e2e@dial8-evals.test'
const FIXTURE_NAME = 'Ada Fixture'
const WORKSPACE_NAME = 'Native Intelligence Local Agent E2E (fixture)'
const INNGEST_DEV = 'http://127.0.0.1:8288'

/** Bugs found outside this script, by the checks they break (Part A's report). */
const KNOWN_BUGS: Record<string, string> = {
  serverDerivedTheNewRun:
    'BUG-1 device.ts ingestEvents: the seq floor (row.last_seq) ignores last_seq_run_id, so after an app relaunch (the ring restarts at 1) no event of the new run is derived',
}

// ── The environment (the app's own files; nothing here is printed) ──────────

function loadEnvFile(path: string): void {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (!m) continue
    let val = m[2]
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    if (process.env[m[1]] === undefined) process.env[m[1]] = val
  }
}

interface Guard {
  ok: boolean
  problems: string[]
  config: Record<string, unknown>
}

/** The hard guard and the config, from the environment and the file system only (no DB, no network). */
function checkGuard(env: NodeJS.ProcessEnv = process.env): Guard {
  const problems: string[] = []
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    // not a URL
  }
  if (url.includes(PROD_REF) || host.startsWith(`${PROD_REF}.`)) problems.push(`refusing: NEXT_PUBLIC_SUPABASE_URL is PROD (${PROD_REF})`)
  else if (!isDevSupabaseUrl(url)) problems.push(`refusing: NEXT_PUBLIC_SUPABASE_URL's host is ${host || '(unset)'}, not DEV (${EVAL_DEV_SUPABASE_HOST})`)
  let base: URL | null = null
  try {
    base = new URL(BASE)
  } catch {
    problems.push(`--base is not a URL: ${BASE}`)
  }
  if (base) {
    if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname)) problems.push(`--base must be http on 127.0.0.1 or localhost (got ${base.origin})`)
    if (base.port !== '3001') problems.push(`--base must be port 3001 (got ${base.port || '(default)'}); :3000 is never used`)
  }
  const has = (k: string) => !!env[k] && env[k]!.length > 0
  if (!has('SUPABASE_SERVICE_ROLE_KEY')) problems.push('SUPABASE_SERVICE_ROLE_KEY is not set (.env.local)')
  if (!has('NEXT_PUBLIC_SUPABASE_ANON_KEY')) problems.push('NEXT_PUBLIC_SUPABASE_ANON_KEY is not set (.env.local)')
  if (!has('LOCAL_AGENT_TOKEN_SECRET') && !has('RUN_SKILL_INTERNAL_SECRET')) problems.push('no model token secret (LOCAL_AGENT_TOKEN_SECRET or RUN_SKILL_INTERNAL_SECRET): the claim would mint no token')
  if (!has('CHAT_INTERNAL_SECRET') && !has('RUN_SKILL_INTERNAL_SECRET')) problems.push('no chat internal secret (CHAT_INTERNAL_SECRET or RUN_SKILL_INTERNAL_SECRET)')
  if (!has('AI_GATEWAY_API_KEY') && !has('VERCEL_OIDC_TOKEN')) problems.push('no gateway credential (AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN): the model relay route would 503')
  const built = existsSync(join(agentDir, '.output/server/index.mjs'))
  if (!built) problems.push('agents/local-agent is not built: run scripts/local-agent/build.sh')
  const nodeMajor = Number(process.versions.node.split('.')[0])
  if (nodeMajor !== 24) problems.push(`Node ${process.versions.node}: the launcher needs Node 24`)
  if (ONLY !== null && ONLY !== 'read' && ONLY !== 'edit') problems.push('--only takes read or edit')
  return {
    ok: problems.length === 0,
    problems,
    config: {
      supabaseHost: host || null,
      dev: isDevSupabaseUrl(url),
      base: base?.origin ?? BASE,
      startNext: START_NEXT,
      chatPath: CHAT_FALLBACK ? 'the chat tool route (fallback)' : 'a real chat turn (EveChatTransport → /eve/chat-agent)',
      only: ONLY ?? 'read + edit',
      fixture: FIXTURE_EMAIL,
      log: LOG_PATH,
      nextLog: START_NEXT ? NEXT_LOG : null,
      present: {
        SUPABASE_SERVICE_ROLE_KEY: has('SUPABASE_SERVICE_ROLE_KEY'),
        NEXT_PUBLIC_SUPABASE_ANON_KEY: has('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
        modelTokenSecret: has('LOCAL_AGENT_TOKEN_SECRET') ? 'LOCAL_AGENT_TOKEN_SECRET' : has('RUN_SKILL_INTERNAL_SECRET') ? 'RUN_SKILL_INTERNAL_SECRET (fallback)' : null,
        chatInternalSecret: has('CHAT_INTERNAL_SECRET') ? 'CHAT_INTERNAL_SECRET' : has('RUN_SKILL_INTERNAL_SECRET') ? 'RUN_SKILL_INTERNAL_SECRET (fallback)' : null,
        gatewayCredential: has('AI_GATEWAY_API_KEY') ? 'AI_GATEWAY_API_KEY' : has('VERCEL_OIDC_TOKEN') ? 'VERCEL_OIDC_TOKEN' : null,
      },
      agentBuilt: built,
      node: process.versions.node,
      spend: 'at most 2 local-agent jobs and 2 chat turns',
    },
  }
}

// ── Requests ────────────────────────────────────────────────────────────────

const READ_PROMPT =
  'Take a look at the folder I attached (e2e-read-folder) with a local agent on my Mac: have it read README.md and src/app.ts, ' +
  'then tell me what the exported constant in src/app.ts is and its value. It only needs to read.'
const STEER = 'Also count the lines in notes.txt (`wc -l notes.txt`) and include the number in your summary.'
const FOLLOW_UP = 'Follow-up: how many lines does README.md have? Run `wc -l README.md`, then call finish with the number.'
const EDIT_PROMPT =
  'Now in the dial8-e2e-app folder (edits allowed), start a local agent in edit mode to make this change: in README.md change the line ' +
  '"It has a README, a source file and some notes." to "It has a README, a source file, some notes and a changelog.", and create CHANGELOG.md ' +
  'with a "# Changelog" heading and one bullet "- Added a changelog.". The first line of its finish summary is the commit message "Add a changelog".'
const EDIT_REQUEST =
  'Make this change: in README.md change the line `It has a README, a source file and some notes.` to `It has a README, a source file, some notes and a changelog.`, ' +
  'and create CHANGELOG.md with a `# Changelog` heading and one bullet `- Added a changelog.`. Run `git status --porcelain` to check, then call finish; its first line is the commit message "Add a changelog".'

// ── The run ─────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  loadEnvFile(join(repo, '.env.development.local'))
  loadEnvFile(join(repo, '.env.local'))
  const guard = checkGuard()
  if (DRY_RUN) {
    console.log(JSON.stringify({ dryRun: true, ok: guard.ok, problems: guard.problems, config: guard.config }, null, 2))
    return guard.ok ? 0 : 1
  }
  if (!guard.ok) {
    for (const p of guard.problems) console.error(`e2e-dev: ${p}`)
    return 1
  }

  const home = realpathSync(homedir())
  mkdirSync(dirname(LOG_PATH), { recursive: true })
  const h = createHarness({ logPath: LOG_PATH, home, knownBugs: KNOWN_BUGS })
  for (const k of ['SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'LOCAL_AGENT_TOKEN_SECRET', 'RUN_SKILL_INTERNAL_SECRET', 'CHAT_INTERNAL_SECRET', 'AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN']) {
    h.secret(process.env[k])
  }
  h.record('setup', { config: guard.config })
  console.log(`local-agent e2e on DEV; log: ${LOG_PATH}`)

  const tag = randomBytes(4).toString('hex')
  const root = join(home, `.dial8-local-agent-e2e-dev-${tag}`)
  const fx = makeFixtures(root, home)
  const startedAt = new Date().toISOString()
  const launcherPids = new Set<number>()
  const jobTmps: string[] = []
  const created: Record<string, unknown> = {}
  let next: ChildProcess | null = null
  let rust: FakeRustProcess | null = null
  let relay: { relay: LocalAgentRelay; stop: () => Promise<void> } | null = null
  let realtime: SupabaseClient | null = null

  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } })
  let userId = ''
  let workspaceId = ''
  let conversationId = ''
  let accessToken = ''

  const api = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${accessToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    let json: Record<string, unknown> = {}
    try {
      json = (await res.json()) as Record<string, unknown>
    } catch {
      // empty
    }
    return { status: res.status, json }
  }
  const sessionRow = async (id: string) => {
    const { data } = await admin.from('local_agent_session').select('*').eq('id', id).maybeSingle()
    return (data as Record<string, unknown> | null) ?? null
  }
  const deviceEvents = async (id: string, runId?: string) => {
    let q = admin.from('local_agent_event').select('id, run_id, seq, kind, payload, source').eq('session_id', id).eq('source', 'device')
    if (runId) q = q.eq('run_id', runId)
    const { data } = await q.order('id', { ascending: true }).limit(2000)
    return (data ?? []) as Array<{ id: number; run_id: string | null; seq: number | null; kind: string; payload: Record<string, unknown> }>
  }
  const trackedJob = async (id: string | null | undefined) => {
    if (!id) return null
    const { data } = await admin.from('tracked_job').select('id, kind, status, title, origin, source').eq('id', id).maybeSingle()
    return (data as Record<string, unknown> | null) ?? null
  }
  const jobOf = async (id: string) => {
    if (!rust) return null
    const r = await rust.call<{ jobs: Array<Record<string, unknown>> }>({ cmd: 'status' })
    return r.ok ? (r.value.jobs.find((j) => j.id === id) ?? null) : null
  }
  const ringOf = async (id: string): Promise<Entry[]> => {
    if (!rust) return []
    const r = await rust.call<Entry[]>({ cmd: 'events', jobId: id, sinceSeq: 0 })
    return r.ok ? r.value : []
  }
  const sentOf = async (id: string): Promise<SentLine[]> => {
    if (!rust) return []
    const r = await rust.call<SentLine[]>({ cmd: 'sent' })
    return r.ok ? r.value.filter((s) => s.jobId === id) : []
  }

  const rustCfg: FakeRustConfig = {
    appData: join(root, 'app-data'),
    home,
    worktreesRoot: join(root, 'worktrees'),
    node: process.execPath,
    agentDir,
    // No dev key: the relay is the only way to the model.
    envFile: null,
    apiOrigin: BASE,
    device: { name: 'E2E Mac (DEV)', appVersion: '0.0.0-e2e' },
    gitEnv: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }
  const launchRust = async (label: string) => {
    const r = await forkFakeRust(rustCfg, (line) => {
      const m = /spawned .* \(pid (\d+),/.exec(line)
      if (m) launcherPids.add(Number(m[1]))
      h.record(`rust${label}`, { line })
    })
    rust = r
    return r
  }
  const startRelay = async (r: FakeRustProcess, label: string) => {
    const started = await runHeadlessRelay({
      fetch: (path, init) => {
        const headers = new Headers(init?.headers)
        headers.set('authorization', `Bearer ${accessToken}`)
        return fetch(`${BASE}${path}`, { ...init, headers })
      },
      bridge: relayBridgeFor(r, (c) => h.record(`bridge${label}`, { ...c })),
      personName: () => FIXTURE_NAME,
      log: h.logLine(`relay${label}`),
      subscribeDoorbell: (on) => subscribeDoorbell(on),
    })
    if (!started.active) throw new Error('the relay did not start')
    relay = started
    return started
  }
  /** Realtime on device:<uid> with the person's token (the relay's 5 s poll covers a miss). */
  const subscribeDoorbell = (on: { ring: () => void; reconnected: () => void }) => {
    let off = () => {}
    void (async () => {
      try {
        const { DOORBELL_EVENT, deviceTopic } = await import('@/lib/local-agent/doorbell')
        realtime = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${accessToken}` } },
        })
        await realtime.realtime.setAuth(accessToken)
        const channel = realtime
          .channel(deviceTopic(userId), { config: { private: true } })
          .on('broadcast', { event: DOORBELL_EVENT }, () => on.ring())
          .subscribe((status) => {
            h.record('doorbell', { status })
            if (status === 'SUBSCRIBED') on.reconnected()
          })
        off = () => void realtime?.removeChannel(channel)
      } catch (err) {
        h.record('doorbell', { error: err instanceof Error ? err.message : String(err) })
      }
    })()
    return () => off()
  }

  /** One chat turn through the app's own transport; the tool calls it made. */
  const chatTurn = async (prompt: string) => {
    const origFetch = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      origFetch(typeof input === 'string' && input.startsWith('/') ? `${BASE}${input}` : input, init)) as typeof fetch
    const calls: Array<{ name: string; input: unknown; output?: unknown }> = []
    let text = ''
    let error: string | null = null
    try {
      const { EveChatTransport } = await import('@/lib/chat/eve/eve-chat-transport')
      const transport = new EveChatTransport({ getAccessToken: () => accessToken, host: `${BASE}/eve/chat-agent` })
      const stream = await transport.sendMessages({
        chatId: `e2e-${tag}`,
        messageId: `u-${randomUUID()}`,
        trigger: 'submit-message',
        messages: [{ id: `u-${randomUUID()}`, role: 'user', parts: [{ type: 'text', text: prompt }] }],
        abortSignal: undefined,
        headers: undefined,
        body: { conversationId },
      } as never)
      const reader = (stream as ReadableStream<Record<string, unknown>>).getReader()
      const timer = setTimeout(() => void reader.cancel().catch(() => {}), 240_000)
      const byId = new Map<string, { name: string; input: unknown; output?: unknown }>()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const c = value as Record<string, unknown> & { type: string }
        if (c.type === 'text-delta') text += String(c.delta)
        else if (c.type === 'tool-input-available') {
          const call = { name: String(c.toolName), input: c.input }
          byId.set(String(c.toolCallId), call)
          calls.push(call)
        } else if (c.type === 'tool-output-available') {
          const call = byId.get(String(c.toolCallId))
          if (call) call.output = c.output
        } else if (c.type === 'error') error = JSON.stringify(c).slice(0, 300)
      }
      clearTimeout(timer)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      globalThis.fetch = origFetch
    }
    // The transport's persist is fire-and-forget (eve-chat-driver.ts): let it land.
    await sleep(3000)
    h.record('chat', { prompt: prompt.slice(0, 120), tools: calls.map((c) => c.name), text: text.slice(0, 400), error })
    return { calls, text, error }
  }

  /** The fallback: the chat tool route's start_local_agent branch with a minted chat-run token (as the route tests call it). */
  const startViaToolRoute = async (folderId: string, request: string, mode: 'read' | 'edit') => {
    const { CHAT_RUN_SECRET_HEADER, CHAT_RUN_TOKEN_HEADER, internalSecret, mintChatRunToken } = await import('@/lib/chat/chat-run-token')
    const secret = internalSecret()
    if (!secret) throw new Error('no chat internal secret')
    const token = mintChatRunToken({ conversationId, workspaceId, userId })
    h.secret(token)
    const res = await fetch(`${BASE}/api/internal/chat/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CHAT_RUN_SECRET_HEADER]: secret, [CHAT_RUN_TOKEN_HEADER]: token },
      body: JSON.stringify({ toolName: 'start_local_agent', input: { folder_id: folderId, request, mode }, callId: `e2e-call-${randomUUID()}`, turnId: `e2e-turn-${tag}`, sessionId: `e2e-session-${tag}` }),
    })
    const json = (await res.json().catch(() => ({}))) as { output?: { session_id?: string }; error?: string }
    h.record('chat', { fallback: 'start_local_agent via /api/internal/chat/tool', status: res.status, output: json.output ?? json.error })
    return json.output?.session_id ?? null
  }

  const newestSession = async (mode: 'read' | 'edit') => {
    const { data } = await admin
      .from('local_agent_session')
      .select('id')
      .eq('user_id', userId)
      .eq('conversation_id', conversationId)
      .eq('mode', mode)
      .gte('created_at', startedAt)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    return (data as { id: string } | null)?.id ?? null
  }

  try {
    // ── D0 ──
    const d0 = await h.step('D0 preflight: migration 410 on DEV, the fixture, a session, the app on :3001', async () => {
      const probe = await admin.from('local_agent_session').select('id').limit(1)
      if (probe.error) throw new Error(`local_agent_session is not readable on DEV (${probe.error.code ?? ''} ${probe.error.message}): is migration 410 applied?`)
      const fixture = await ensureFixture(admin)
      userId = fixture.userId
      workspaceId = fixture.workspaceId
      Object.assign(created, { userId, workspaceId, userCreated: fixture.userCreated, subscriptionGranted: fixture.subscriptionGranted })
      const { data: conv, error: cErr } = await admin
        .from('chat_conversations')
        .insert({ user_id: userId, workspace_id: workspaceId, title: `Local agent e2e ${tag}` })
        .select('id')
        .single()
      if (cErr || !conv) throw new Error(`chat_conversations insert: ${cErr?.message ?? 'no row'}`)
      conversationId = conv.id as string
      created.conversationId = conversationId
      accessToken = await signIn(admin)
      h.secret(accessToken)
      if (START_NEXT) next = await startNextDev()
      const up = await waitFor('the app on the base URL', START_NEXT ? 300_000 : 10_000, async () => {
        try {
          const r = await fetch(`${BASE}/api/local-agent/sessions`, { headers: { authorization: `Bearer ${accessToken}` } })
          return r.status === 200 ? r : null
        } catch {
          return null
        }
      }, 2000)
      return { migration410: true, fixtureSingleMember: fixture.singleMember, evalFixture: fixture.evalFixture, signedIn: !!accessToken, personRouteAnswers: up.status === 200 }
    })
    if (!d0) return finish()

    // ── D1 ──
    let readFolderId = ''
    let editFolderId = ''
    const r1 = await launchRust('1')
    const readGrant = await r1.call<{ id: string }>({ cmd: 'addGrant', path: fx.readFolder, mode: 'read' })
    const editGrant = await r1.call<{ id: string }>({ cmd: 'addGrant', path: fx.gitRepo, mode: 'edit' })
    if (!readGrant.ok || !editGrant.ok) throw new Error('could not add the grants')
    const dev = await r1.call<{ deviceId: string }>({ cmd: 'device' })
    const deviceId = dev.ok ? dev.value.deviceId : ''
    created.deviceId = deviceId
    await startRelay(r1, '1')
    const d1 = await h.step('D1 heartbeat: user_device and both device_folder rows on DEV', async () => {
      const folders = await waitFor('the folder mirror', 20_000, async () => {
        const { data } = await admin.from('device_folder').select('id, grant_id, mode, is_git, revoked_at').eq('user_id', userId).eq('device_id', deviceId)
        return data && data.length >= 2 ? (data as Array<Record<string, unknown>>) : null
      })
      readFolderId = String(folders.find((f) => f.grant_id === readGrant.value.id)?.id ?? '')
      editFolderId = String(folders.find((f) => f.grant_id === editGrant.value.id)?.id ?? '')
      created.folderIds = [readFolderId, editFolderId]
      const { data: device } = await admin.from('user_device').select('id, name, last_seen_at').eq('user_id', userId).eq('id', deviceId).maybeSingle()
      // The environment: both folders, in every chat (nothing is attached per conversation).
      const env = await api('GET', '/api/local-agent/environment')
      const listed = Array.isArray(env.json.folders) ? (env.json.folders as Array<{ id?: unknown }>).map((f) => f.id) : []
      return {
        deviceRow: !!device,
        readFolder: !!readFolderId,
        editFolderAllowsEdits: folders.find((f) => f.id === editFolderId)?.mode === 'edit',
        inEnvironment: env.status === 200 && listed.includes(readFolderId) && listed.includes(editFolderId),
      }
    })
    if (!d1) return finish()

    // ── C: the read job ──
    let A = ''
    let runA1 = ''
    let trackedA: string | null = null
    const c1 = await h.step(`C1 ${CHAT_FALLBACK ? 'the chat tool route (fallback)' : 'a real chat turn'} calls start_local_agent → a queued session, its ledger row`, async () => {
      let path = 'chat turn'
      if (!CHAT_FALLBACK) {
        const turn = await chatTurn(READ_PROMPT)
        const call = turn.calls.find((c) => c.name === 'start_local_agent')
        A = (call?.output as { session_id?: string } | undefined)?.session_id ?? (await newestSession('read')) ?? ''
        if (!A) {
          path = 'chat turn did not start one: fell back to the tool route'
          A = (await startViaToolRoute(readFolderId, READ_PROMPT, 'read')) ?? ''
        }
      } else {
        path = 'tool route'
        A = (await startViaToolRoute(readFolderId, READ_PROMPT, 'read')) ?? ''
      }
      if (!A) throw new Error('no local agent session was created')
      created.readSessionId = A
      h.record('C', { session: A, path })
      jobTmps.push(join(realpathSync(tmpdir()), 'dial8-local-agent', A))
      const row = await sessionRow(A)
      trackedA = (row?.current_tracked_job_id as string | null) ?? null
      const tj = await trackedJob(trackedA)
      return {
        startedByTheChat: path === 'chat turn' || CHAT_FALLBACK,
        sessionRow: !!row && row.conversation_id === conversationId && row.started_by === 'agent' && row.mode === 'read',
        idempotencyKey: typeof row?.idempotency_key === 'string' && String(row.idempotency_key).startsWith(`local-agent:${conversationId}:`),
        ledgerRow: !!tj && tj.kind === 'local_agent',
      }
    })

    const c2 = await h.step('C2 the headless relay claims it; the launcher runs on the relay path with the claim token; the rebind lands', async () => {
      await waitFor('the session running on the Mac', 120_000, async () => ['starting', 'running', 'waiting'].includes(String((await sessionRow(A))?.status)))
      const job = await waitFor('the Rust job', 30_000, () => jobOf(A))
      runA1 = String(job.runId ?? '')
      const row = await waitFor('the rebind', 30_000, async () => {
        const r = await sessionRow(A)
        return r && r.run_id === runA1 ? r : null
      })
      const ring = await waitFor('a first tool event', 240_000, async () => ((await ringOf(A)).some((e) => e.event.kind === 'tool') ? ringOf(A) : null))
      const logs = await readRustLog(LOG_PATH, A)
      return {
        claimed: !!row.claimed_at,
        reboundToTheRustRun: row.run_id === runA1,
        launcherOnTheRelay: logs.some((l) => l.includes(`run ${runA1} (read, model relay)`)),
        toolEvents: ring.length > 0,
      }
    }, { skipIf: c1 ? null : 'C1 did not complete' })

    await h.step('C3 model calls go through the real relay route', async () => {
      const evs = await waitFor('tool events on DEV', 120_000, async () => {
        const e = await deviceEvents(A, runA1)
        return e.some((x) => x.kind === 'tool') ? e : null
      })
      let usageLogged: boolean | null = null
      try {
        const { data, error } = await admin.from('ai_usage_logs').select('*').eq('user_id', userId).eq('feature', 'local_agent').gte('created_at', startedAt).limit(50)
        usageLogged = error ? null : (data ?? []).length > 0
        h.record('C', { usageRows: data?.length ?? null, usageError: error?.message ?? null })
      } catch {
        usageLogged = null
      }
      return {
        // No dev key in the launcher's env: only the relay could have answered.
        progressedWithoutADevKey: evs.some((x) => x.kind === 'tool'),
        eventsCarryTheRun: evs.every((x) => x.run_id === runA1),
        ...(usageLogged === null ? {} : { usageLoggedAsLocalAgent: usageLogged }),
      }
    }, { skipIf: c2 ? null : 'C2 did not complete' })

    await h.step('C4 a person steer through the person route lands mid-turn', async () => {
      const r = await api('POST', `/api/local-agent/sessions/${A}/messages`, { text: STEER, policy: 'steer' })
      if (r.status !== 200) throw new Error(`steer POST answered ${r.status}`)
      const messageId = String(r.json.messageId)
      created.steerMessageId = messageId
      const msg = await waitFor('the steer delivered', 90_000, async () => {
        const { data } = await admin.from('local_agent_message').select('status').eq('id', messageId).maybeSingle()
        return data && data.status !== 'pending' ? data : null
      })
      const sent = await sentOf(A)
      const steer = sent.find((l) => l.type === 'send' && l.policy === 'steer')
      const { data: inbound } = await admin.from('local_agent_event').select('payload').eq('session_id', A).eq('kind', 'inbound').limit(10)
      return {
        delivered: msg.status === 'delivered',
        prefixed: steer?.text === `[From Ada] ${STEER}`,
        inboundEvent: ((inbound ?? []) as Array<{ payload: { messageId?: string } }>).some((e) => e.payload.messageId === messageId),
      }
    }, { skipIf: c2 ? null : 'C2 did not complete' })

    const c5 = await h.step('C5 finish → waiting; the turn row settles', async () => {
      const row = await waitFor('waiting with finish on DEV', 300_000, async () => {
        const r = await sessionRow(A)
        return r && r.status === 'waiting' && r.last_signal === 'finish' ? r : null
      })
      // The session goes waiting first in the turn-ending upload; the turn row
      // settles just after (moveTurn, then the recorder's finish), so wait for it.
      const turnId = (row.current_tracked_job_id as string | null) ?? trackedA
      const tj = await waitFor('the turn row to settle', 15_000, async () => {
        const t = await trackedJob(turnId)
        return t && ['done', 'needs_review'].includes(String(t.status)) ? t : null
      }).catch(async () => trackedJob(turnId))
      h.record('C', { turnRow: tj })
      return {
        waiting: row.status === 'waiting',
        finishSummary: typeof row.last_signal_text === 'string' && /42|answer/i.test(String(row.last_signal_text)),
        steerFollowed: /\b3\b|three/i.test(String(row.last_signal_text)),
        turnRowSettled: !!tj && ['done', 'needs_review'].includes(String(tj.status)),
      }
    }, { skipIf: c2 ? null : 'C2 did not complete' })

    await h.step('C6 the report lands in the chat; the home turn runs', async (): Promise<Record<string, boolean>> => {
      const report = await waitFor('the report message', 90_000, async () => {
        const { data } = await admin
          .from('chat_messages')
          .select('id, conversation_id, ui_message, created_at')
          .eq('user_id', userId)
          .gte('created_at', startedAt)
          .order('created_at', { ascending: false })
          .limit(50)
        const rows = (data ?? []) as Array<{ id: string; conversation_id: string; ui_message: { metadata?: { kind?: string } } }>
        return rows.find((m) => m.ui_message?.metadata?.kind === 'teammate_report') ?? null
      })
      created.reportMessageId = report.id
      const inngest = await fetch(INNGEST_DEV).then(() => true, () => false)
      if (!inngest) {
        h.record('C', { homeTurn: 'not checked: the Inngest dev server is not running (npm run dev:inngest)' })
        return { reportInTheChat: true }
      }
      const turn = await waitFor('a home turn', 240_000, async () => {
        const { data } = await admin.from('home_turn').select('id, status, reason').eq('user_id', userId).gte('created_at', startedAt).limit(5)
        return (data ?? []).find((t) => ['sent', 'done', 'skipped'].includes(String(t.status))) ?? null
      }, 5000)
      created.homeTurnId = turn.id
      return { reportInTheChat: true, homeTurnRan: true }
    }, { skipIf: c5 ? null : 'C5 did not complete' })

    let runA2 = ''
    const c7 = await h.step('C7 kill the app → relaunch → a message resumes the same eve session on a new run → answered', async () => {
      const live = await r1.call<number[]>({ cmd: 'livePids' })
      const pids = live.ok ? live.value : []
      const before = await jobOf(A)
      relay?.relay.dispose()
      r1.kill('SIGKILL')
      await r1.exited
      await waitFor('the launcher to exit', 15_000, () => pids.every((p) => !alive(p)))
      const r2 = await launchRust('2')
      const after = await jobOf(A)
      await startRelay(r2, '2')
      const r = await api('POST', `/api/local-agent/sessions/${A}/messages`, { text: FOLLOW_UP, policy: 'queue' })
      if (r.status !== 200) throw new Error(`follow-up POST answered ${r.status}`)
      const followId = String(r.json.messageId)
      await waitFor('the follow-up delivered', 120_000, async () => {
        const { data } = await admin.from('local_agent_message').select('status').eq('id', followId).maybeSingle()
        return data?.status === 'delivered'
      })
      runA2 = String((await jobOf(A))?.runId ?? '')
      const evs = await waitFor('the follow-up answered', 300_000, async () => {
        const e = await deviceEvents(A, runA2)
        const f = e.findIndex((x) => x.kind === 'finish')
        return f >= 0 && e.slice(f).some((x) => x.kind === 'status' && x.payload.status === 'waiting') ? e : null
      })
      await sleep(1500)
      const row = await sessionRow(A)
      const resumeLine = (await sentOf(A)).find((l) => l.runId === runA2 && l.type === 'resume')
      return {
        launcherWentWithTheApp: pids.length > 0 && pids.every((p) => !alive(p)),
        relaunchMarkedInterrupted: after?.status === 'interrupted',
        newRun: !!runA2 && runA2 !== runA1,
        sameEveSession: !!resumeLine && resumeLine.sessionId === before?.sessionId,
        reboundToTheNewRun: row?.run_id === runA2,
        followUpAnswered: /\b4\b|four/i.test(String(evs.find((x) => x.kind === 'finish')?.payload.summary ?? '')),
        serverDerivedTheNewRun: row?.last_signal === 'finish' && row?.last_seq_run_id === runA2,
      }
    }, { skipIf: c5 ? null : 'C5 did not complete' })

    await h.step('C8 stop → cancelled', async () => {
      const r = await api('POST', `/api/local-agent/sessions/${A}/stop`)
      if (r.status !== 200) throw new Error(`stop POST answered ${r.status}`)
      const row = await waitFor('cancelled on DEV', 60_000, async () => {
        const s = await sessionRow(A)
        return s?.status === 'cancelled' ? s : null
      })
      return { cancelled: row.status === 'cancelled' && !!row.ended_at, rustJobEnded: (await jobOf(A))?.live === false }
    }, { skipIf: c7 || c5 ? null : 'C5 did not complete' })

    // ── E: the edit job ──
    if (ONLY !== 'read') {
      let B = ''
      const repoHead = fx.hostGit(['-C', fx.gitRepo, 'rev-parse', 'HEAD']).trim()
      const e1 = await h.step('E1 edit job: the worktree, the change, the finish commit, the branch on the session', async () => {
        if (!CHAT_FALLBACK) {
          const turn = await chatTurn(EDIT_PROMPT)
          const call = turn.calls.find((c) => c.name === 'start_local_agent')
          B = (call?.output as { session_id?: string } | undefined)?.session_id ?? (await newestSession('edit')) ?? ''
        }
        if (!B) B = (await startViaToolRoute(editFolderId, EDIT_REQUEST, 'edit')) ?? ''
        if (!B) throw new Error('no edit session was created')
        created.editSessionId = B
        jobTmps.push(join(realpathSync(tmpdir()), 'dial8-local-agent', B))
        const row = await waitFor('the branch on DEV', 420_000, async () => {
          const s = await sessionRow(B)
          return s?.branch && s?.commit_sha ? s : null
        })
        const branch = String(row.branch)
        const committed = fx.hostGit(['-C', fx.gitRepo, 'show', '--name-only', '--format=', branch]).trim().split('\n').sort()
        const ring = await ringOf(B)
        const branchEv = ring.find((e) => e.event.kind === 'branch')
        const stored = (await deviceEvents(B)).find((e) => e.kind === 'branch')
        return {
          editMode: row.mode === 'edit',
          branchName: /^dial8\/dial8-e2e-app-[0-9a-f]{8}$/.test(branch),
          commitOnTheBranch: fx.hostGit(['-C', fx.gitRepo, 'rev-parse', branch]).trim() === row.commit_sha,
          commitHasTheChange: committed.includes('CHANGELOG.md') && committed.includes('README.md'),
          branchEventStored: !!stored && stored.seq === branchEv?.seq,
          originalReadmeUntouched: readFileSync(join(fx.gitRepo, 'README.md'), 'utf8') === FIXTURE_README,
          originalHasNoChangelog: !existsSync(join(fx.gitRepo, 'CHANGELOG.md')),
          originalBranchUntouched: fx.hostGit(['-C', fx.gitRepo, 'rev-parse', '--abbrev-ref', 'HEAD']).trim() === 'main',
          originalHeadUntouched: fx.hostGit(['-C', fx.gitRepo, 'rev-parse', 'HEAD']).trim() === repoHead,
          originalCheckoutClean: fx.hostGit(['-C', fx.gitRepo, 'status', '--porcelain']).trim() === '',
          hookNotRun: !existsSync(fx.hookMarker),
        }
      }, { skipIf: d1 ? null : 'D1 did not complete' })
      await h.step('E2 stop the edit job → cancelled', async () => {
        await api('POST', `/api/local-agent/sessions/${B}/stop`)
        const row = await waitFor('cancelled on DEV', 60_000, async () => {
          const s = await sessionRow(B)
          return s?.status === 'cancelled' ? s : null
        })
        return { cancelled: row.status === 'cancelled', branchKept: !!row.branch }
      }, { skipIf: e1 || B ? null : 'E1 did not start' })
    }
    return finish()
  } catch (err) {
    h.record('e2e', { fatal: err instanceof Error ? err.message : String(err) })
    console.error(`e2e-dev aborted: ${h.redact(err instanceof Error ? err.message : String(err))}`)
    h.results.push({ step: 'aborted', result: 'FAIL', ms: 0, checks: {}, note: err instanceof Error ? err.message : String(err) })
    return finish()
  }

  async function finish(): Promise<number> {
    const rel = relay as { relay: LocalAgentRelay; stop: () => Promise<void> } | null
    if (rel) await Promise.race([rel.stop(), sleep(5_000)]).catch(() => {})
    const rt = realtime as SupabaseClient | null
    if (rt) await rt.removeAllChannels().catch(() => [])
    const r = rust as FakeRustProcess | null
    if (r) {
      await Promise.race([r.call({ cmd: 'shutdown' }), sleep(5_000)])
      r.kill('SIGTERM')
      await Promise.race([r.exited, sleep(3_000)])
    }
    const n = next as ChildProcess | null
    if (n?.pid) await stopProcessGroup(n.pid)
    await sleep(500)
    const left = leftovers([...launcherPids, ...(n?.pid ? [n.pid] : [])], root, h.redact)
    h.results.push({ step: 'Z nothing left running', result: left.length === 0 ? 'PASS' : 'FAIL', ms: 0, checks: { noLeftovers: left.length === 0 }, ...(left.length ? { note: left.join('; ') } : {}) })
    console.log(`${left.length === 0 ? 'PASS' : 'FAIL'} Z nothing left running${left.length ? `: ${left.join('; ')}` : ''}`)
    if (!KEEP) {
      rmSync(root, { recursive: true, force: true })
      for (const d of jobTmps) rmSync(d, { recursive: true, force: true })
    }
    const summary = h.summary({ devRows: created, note: 'DEV rows are left in place for the orchestrator (cleanup by ids above).' })
    h.record('e2e', summary)
    console.log(h.redact(JSON.stringify(summary, null, 2)))
    return (summary.failed as string[]).length ? 1 : 0
  }

  async function startNextDev(): Promise<ChildProcess> {
    // Nothing else may hold :3001 (and :3000 is never touched).
    const busy = await fetch(BASE).then(() => true, () => false)
    if (busy) throw new Error(`something already answers on ${BASE}; stop it or drop --start-next`)
    mkdirSync(dirname(NEXT_LOG), { recursive: true })
    const fd = openSync(NEXT_LOG, 'a')
    const child = spawn('npm', ['run', 'dev'], { cwd: repo, env: { ...process.env, PORT: '3001' } as NodeJS.ProcessEnv, stdio: ['ignore', fd, fd], detached: true })
    closeSync(fd)
    h.record('next', { started: true, pid: child.pid, log: NEXT_LOG })
    return child
  }
}

/** SIGTERM a process group, then SIGKILL it after 10 s. */
async function stopProcessGroup(pid: number) {
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    return
  }
  const until = Date.now() + 10_000
  while (Date.now() < until && alive(pid)) await sleep(250)
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // gone
  }
}

/** The fake Rust's log lines for a job, from the e2e log. */
async function readRustLog(logPath: string, jobId: string): Promise<string[]> {
  try {
    return readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((l) => l.includes(`[local-agent:${jobId}]`))
      .map((l) => {
        try {
          return String((JSON.parse(l) as { line?: unknown }).line ?? '')
        } catch {
          return ''
        }
      })
  } catch {
    return []
  }
}

// ── The fixture (DEV only; scripts/eval-fixture.ts is the precedent) ────────

async function findUserId(admin: SupabaseClient, email: string): Promise<string | null> {
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw new Error(`listUsers: ${error.message}`)
    const hit = data.users.find((u) => u.email?.toLowerCase() === email)
    if (hit) return hit.id
    if (data.users.length < 200) return null
  }
  return null
}

async function ensureFixture(admin: SupabaseClient) {
  if (!isDevSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL)) throw new Error('refusing: not DEV')
  let userId = await findUserId(admin, FIXTURE_EMAIL)
  let userCreated = false
  if (!userId) {
    const { data, error } = await admin.auth.admin.createUser({ email: FIXTURE_EMAIL, email_confirm: true, user_metadata: { full_name: FIXTURE_NAME } })
    if (error || !data.user) throw new Error(`createUser: ${error?.message ?? 'no user'}`)
    userId = data.user.id
    userCreated = true
  }
  // The signup trigger makes the person's own workspace; it may take a moment.
  const memberships = await waitFor('the fixture workspace', 30_000, async () => {
    const { data, error } = await admin.from('member').select('workspace_id').eq('user_id', userId!)
    if (error) throw new Error(`member: ${error.message}`)
    return data && data.length > 0 ? data : null
  })
  if (memberships.length !== 1) throw new Error(`expected the fixture in exactly one workspace, found ${memberships.length}`)
  const workspaceId = memberships[0].workspace_id as string
  const { data: members } = await admin.from('member').select('user_id').eq('workspace_id', workspaceId)
  const singleMember = !!members && members.length === 1 && members[0].user_id === userId
  if (!singleMember) throw new Error('the fixture workspace has another member: refusing to use it')
  const { data: ws, error: wsErr } = await admin.from('workspace').select('settings').eq('id', workspaceId).single()
  if (wsErr) throw new Error(`workspace: ${wsErr.message}`)
  const settings = { ...((ws?.settings as Record<string, unknown> | null) ?? {}), eval_fixture: true }
  const { error: upErr } = await admin.from('workspace').update({ name: WORKSPACE_NAME, settings }).eq('id', workspaceId)
  if (upErr) throw new Error(`workspace update: ${upErr.message}`)
  // No free tier (migration 243): a complimentary grant, as scripts/eval-fixture.ts does, once.
  let subscriptionGranted = false
  const { data: sub } = await admin.from('subscriptions').select('id').eq('user_id', userId).in('status', ['active', 'trialing']).limit(1).maybeSingle()
  if (!sub) {
    const { error: gErr } = await admin.from('subscriptions').insert({
      user_id: userId,
      stripe_subscription_id: `granted_local_agent_e2e_${Date.now()}`,
      stripe_customer_id: null,
      status: 'active',
      current_period_start: new Date().toISOString(),
      current_period_end: null,
      cancel_at_period_end: false,
    })
    if (gErr) throw new Error(`subscriptions insert: ${gErr.message}`)
    const { data: plan } = await admin.from('ai_plan_definitions').select('id').eq('name', 'subscriber').single()
    if (plan) await admin.from('ai_user_plans').upsert({ user_id: userId, plan_id: plan.id, is_active: true }, { onConflict: 'user_id' })
    subscriptionGranted = true
  }
  return { userId, workspaceId, userCreated, subscriptionGranted, singleMember, evalFixture: true }
}

/** A session for the fixture: a magic link verified server side (scripts/eve-chat-driver.ts). */
async function signIn(admin: SupabaseClient): Promise<string> {
  const { data: link, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: FIXTURE_EMAIL })
  if (error) throw new Error(`generateLink: ${error.message}`)
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: verified, error: otpErr } = await anon.auth.verifyOtp({ type: 'email', token_hash: link.properties.hashed_token })
  if (otpErr || !verified.session) throw new Error(`verifyOtp: ${otpErr?.message ?? 'no session'}`)
  return verified.session.access_token
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`e2e-dev: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  },
)

