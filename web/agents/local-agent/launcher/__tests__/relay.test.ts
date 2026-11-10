/**
 * The model relay and the app (C1) end to end, without a model: the REAL
 * launcher starts the REAL built Mac body (the Native Intelligence agent built with
 * NI_AGENT_HOST=mac, scripts/local-agent/build.sh) with
 * LOCAL_AGENT_MODEL_BASE_URL + LOCAL_AGENT_MODEL_TOKEN pointed at a fake app on
 * 127.0.0.1. It answers C1's spec route with a small spec, its tool route with
 * a canned output, and each model call with a canned Gateway stream: a call of
 * the spec's one tool, then a reply. It proves:
 *   - every model request goes to `<base>/language-model` with the token as a
 *     Bearer, and the model id the relay allowlists;
 *   - the spec and the tool call go to C1's routes on the same origin with the
 *     same token as a Bearer, and nothing else does (no shared secret, no
 *     internal route);
 *   - the model sees the spec's prompt with the Mac body's own instructions,
 *     the fence's tools and the spec's tools, C1's web tools as proxies (not
 *     eve's native ones), and a `bash` call runs in the host-folder fence;
 *   - the usage gate asks C1's liveness before every model step, and a tool
 *     that acts on the Mac asks again when that answer is over 2 s old (the
 *     edit job's model answers slowly, so bash and read_file each ask);
 *   - reading a PNG gives the model a note, never the image, and stages
 *     nothing into the folder: in a read job, and in an edit job, where the
 *     worktree is writable and anything staged there would be committed;
 *   - a `{"type":"token"}` line changes the token the NEXT request carries,
 *     on every route, with no restart;
 *   - the token file is 0600 while the job runs and gone after stop;
 *   - a build without the Mac host marker, a local model on a build without
 *     one, and a half-configured relay are each fatal before anything starts.
 * A token that says the person runs on their own ChatGPT plan (`cp`) sends
 * every model call to `<base>/plan/responses` instead, for the plan's model
 * with `store: false`: a two-step turn (the spec's tool, then the reply) must
 * carry the first step's items inline, never as references to responses the
 * plan route never stored (canned Responses streams).
 *
 * Skipped when the agent is not built or not on macOS.
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const LAUNCHER = fileURLToPath(new URL('../launcher.ts', import.meta.url))
const AGENT_DIR = dirname(dirname(LAUNCHER))
const built = existsSync(join(AGENT_DIR, '.output', 'server', 'index.mjs'))
const TOKEN_A = 'test-token-A.0123456789abcdef'
const TOKEN_B = 'test-token-B.fedcba9876543210'
/** A model token as the relay mints it for a person on their own ChatGPT plan (its `cp` flag; the MAC is never checked here). */
const PLAN_TOKEN = `la1.${Buffer.from(JSON.stringify({ sid: 's1', uid: 'u1', wid: 'w1', exp: 9_999_999_999, cp: true })).toString('base64url')}.test-token-plan-mac`

interface Seen {
  path: string
  authorization: string | undefined
  modelId: string | undefined
  secret: string | undefined
  body: string
}

/** The spec C1 would send for the session's conversation (src/lib/chat/chat-run-rebuild.ts ChatSpec, host 'mac'). */
const SPEC = {
  systemPrompt: 'SPEC-PROMPT-MARKER: you are the person’s Native Intelligence agent.',
  model: 'anthropic/claude-sonnet-5.5',
  ceiling: ['list_actions', 'web_fetch', 'web_search'],
  ceilingTools: [
    { name: 'list_actions', description: 'List the workspace actions.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    // C1 serves the web tools on the server (the Mac's network stays off).
    { name: 'web_fetch', description: 'Fetch a public page (server side).', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
    { name: 'web_search', description: 'Search the web (server side).', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  ],
  coreToolNames: ['list_actions', 'web_fetch', 'web_search'],
  helpersAllowed: false,
  host: 'mac',
}

/** A file in the granted folder that a sandboxed `ls` must list. */
const FIXTURE = 'RELAY-FIXTURE.txt'
/** A 1×1 PNG in the granted folder for `read_file`: eve's own would attach it, and stage it into the folder. */
const PIXEL = 'pixel.png'
const PIXEL_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const usage = { inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 4, text: 4, reasoning: 0 } }
const sse = (parts: object[]) => parts.map((p) => `data: ${JSON.stringify(p)}\n\n`).join('')

/** A canned Gateway stream: one text part and a finish (LanguageModelV4 stream parts as SSE). */
function cannedStream(text: string): string {
  return sse([
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage, providerMetadata: { gateway: { cost: '0' } } },
  ])
}

/** A canned Gateway stream that calls one tool. */
function toolCallStream(callId: string, toolName: string, input: Record<string, unknown> = {}): string {
  return sse([
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId: callId, toolName, input: JSON.stringify(input) },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage, providerMetadata: { gateway: { cost: '0' } } },
  ])
}

/**
 * A canned OpenAI Responses stream for the relay's plan path: a call of the
 * spec's `list_actions` (`toolCall`), or one message, then a completion with usage.
 */
function cannedResponsesStream(n: number, toolCall: boolean): string {
  const created = { type: 'response.created', response: { id: `resp_${n}`, created_at: 1_760_000_000, model: 'gpt-6.1-sol' } }
  const completed = { type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 4, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } }
  const call = { type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name: 'list_actions', arguments: '' }
  const message = { type: 'message', id: `msg_${n}` }
  const middle = toolCall
    ? [
        { type: 'response.output_item.added', output_index: 0, item: call },
        { type: 'response.function_call_arguments.delta', item_id: call.id, output_index: 0, delta: '{}' },
        { type: 'response.output_item.done', output_index: 0, item: { ...call, arguments: '{}', status: 'completed' } },
      ]
    : [
        { type: 'response.output_item.added', output_index: 0, item: message },
        { type: 'response.output_text.delta', item_id: message.id, output_index: 0, delta: `plan reply ${n}` },
        { type: 'response.output_item.done', output_index: 0, item: message },
      ]
  return [created, ...middle, completed].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}

/** How many tool results the current turn has (prompt messages after the last user message). */
function toolResultsThisTurn(body: string): number {
  try {
    const prompt = (JSON.parse(body) as { prompt?: { role?: string }[] }).prompt ?? []
    const lastUser = prompt.map((m) => m.role).lastIndexOf('user')
    return prompt.slice(lastUser + 1).filter((m) => m.role === 'tool').length
  } catch {
    return 0
  }
}

/** How long the fake model takes to answer with a tool call (the edit job sets it past the tool guard's 2 s). */
const slowToolCalls = { ms: 0 }

function startFakeRelay(seen: Seen[]): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res) => {
      const chunks: Uint8Array[] = []
      req.on('data', (c: Buffer) => chunks.push(new Uint8Array(c.buffer, c.byteOffset, c.byteLength)))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        seen.push({
          path: req.url ?? '',
          authorization: req.headers.authorization,
          modelId: typeof req.headers['ai-language-model-id'] === 'string' ? req.headers['ai-language-model-id'] : undefined,
          secret: typeof req.headers['x-chat-run-secret'] === 'string' ? req.headers['x-chat-run-secret'] : undefined,
          body,
        })
        if (req.method === 'POST' && req.url === '/api/local-agent/model/language-model') {
          // A turn runs `ls` in the fence, reads the PNG, uses the spec's tool, then replies.
          const done = toolResultsThisTurn(body)
          const answer =
            done === 0
              ? toolCallStream(`call_${seen.length}`, 'bash', { command: 'ls' })
              : done === 1
                ? toolCallStream(`call_${seen.length}`, 'read_file', { filePath: `/workspace/${PIXEL}` })
                : done === 2
                  ? toolCallStream(`call_${seen.length}`, 'list_actions')
                  : cannedStream(`reply ${seen.length}`)
          setTimeout(() => {
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            res.end(answer)
          }, done <= 2 ? slowToolCalls.ms : 0)
        } else if (req.method === 'POST' && req.url === '/api/local-agent/model/plan/responses') {
          // A plan turn: the spec's tool, then a reply.
          const step = seen.filter((s) => s.path === '/api/local-agent/model/plan/responses').length
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end(cannedResponsesStream(step, step === 1))
        } else if (req.method === 'GET' && req.url?.startsWith('/api/local-agent/agent/spec?')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(SPEC))
        } else if (req.method === 'POST' && req.url === '/api/local-agent/agent/tool') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ output: { actions: [], marker: 'TOOL-OUTPUT-MARKER' } }))
        } else {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end('{"error":{"message":"not here"}}')
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0 })
    })
  })
}

interface Run {
  child: ChildProcessWithoutNullStreams
  lines: Record<string, unknown>[]
  send(msg: object): void
  waitFor(pred: (l: Record<string, unknown>) => boolean, ms: number, what: string): Promise<Record<string, unknown>>
  exit: Promise<number | null>
}

function launch(env: Record<string, string>, cwd: string): Run {
  // Cast: Next's global types make ProcessEnv require NODE_ENV, which the launcher never gets.
  const child = spawn(process.execPath, [LAUNCHER], { cwd, env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] })
  const lines: Record<string, unknown>[] = []
  const waiters: { pred: (l: Record<string, unknown>) => boolean; resolve: (l: Record<string, unknown>) => void }[] = []
  createInterface({ input: child.stdout }).on('line', (raw) => {
    const line = JSON.parse(raw) as Record<string, unknown>
    lines.push(line)
    for (const w of [...waiters]) if (w.pred(line)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(line))
  })
  child.stderr.resume()
  return {
    child,
    lines,
    exit: new Promise((r) => child.once('exit', (code) => r(code))),
    send: (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`),
    waitFor(pred, ms, what) {
      const hit = lines.find(pred)
      if (hit) return Promise.resolve(hit)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}: ${JSON.stringify(lines.slice(-5))}`)), ms)
        waiters.push({ pred, resolve: (l) => (clearTimeout(timer), resolve(l)) })
      })
    },
  }
}

const isEvent = (kind: string, status?: string) => (l: Record<string, unknown>) =>
  l.type === 'event' && (l.event as Record<string, unknown>).kind === kind && (status === undefined || (l.event as Record<string, unknown>).status === status)

describe.runIf(built && process.platform === 'darwin')('the model relay through the real launcher (fake relay, no model)', { timeout: 120_000 }, () => {
  const seen: Seen[] = []
  let relay: Server
  let base: string
  let root: string
  let home: string
  let granted: string

  beforeAll(async () => {
    const r = await startFakeRelay(seen)
    relay = r.server
    base = `http://127.0.0.1:${r.port}/api/local-agent/model`
    root = realpathSync(mkdtempSync(join(tmpdir(), 'la-relay-test-')))
    home = join(root, 'home')
    granted = join(home, 'granted')
    mkdirSync(granted, { recursive: true })
    writeFileSync(join(granted, FIXTURE), 'a fixture\n')
    writeFileSync(join(granted, PIXEL), new Uint8Array(Buffer.from(PIXEL_BASE64, 'base64')))
  })

  afterAll(() => {
    relay?.close()
    rmSync(root, { recursive: true, force: true })
  })

  const envFor = (jobId: string, extra: Record<string, string>) => {
    const jobTmp = join(root, 'tmp', jobId)
    mkdirSync(jobTmp, { recursive: true })
    return {
      HOME: home,
      TMPDIR: jobTmp,
      LANG: 'en_US.UTF-8',
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      LOCAL_AGENT_JOB_ID: jobId,
      LOCAL_AGENT_FOLDER: granted,
      LOCAL_AGENT_MODE: 'read',
      LOCAL_AGENT_TOOL_PATH: '/usr/bin:/bin',
      LOCAL_AGENT_DIR: AGENT_DIR,
      ...extra,
    }
  }
  const jobDir = (jobId: string) => {
    const d = join(root, 'jobs', jobId)
    mkdirSync(d, { recursive: true })
    return d
  }

  it('sends each model, spec and tool call with the current token, and a token line refreshes it in place', async () => {
    const dir = jobDir('relay1')
    const run = launch(envFor('relay1', { LOCAL_AGENT_MODEL_BASE_URL: base, LOCAL_AGENT_MODEL_TOKEN: TOKEN_A }), dir)
    await run.waitFor((l) => l.type === 'ready', 60_000, 'ready')
    const tokenFile = join(dir, '.model-token')
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600)

    run.send({ type: 'start', request: 'Say hello.' })
    await run.waitFor((l) => isEvent('message')(l), 60_000, 'the first reply')
    await run.waitFor(isEvent('status', 'waiting'), 30_000, 'waiting')
    const first = seen.length
    expect(first).toBeGreaterThanOrEqual(1)

    run.send({ type: 'token', modelToken: TOKEN_B })
    run.send({ type: 'send', text: '[From the Dial8 agent] And again.', policy: 'queue' })
    await run.waitFor((l) => isEvent('message')(l) && run.lines.filter(isEvent('message')).length >= 2, 60_000, 'the second reply')
    await run.waitFor((l) => isEvent('status', 'waiting')(l) && run.lines.filter(isEvent('status', 'waiting')).length >= 2, 30_000, 'waiting again')

    run.send({ type: 'stop' })
    expect(await run.exit).toBe(0)
    expect(existsSync(tokenFile)).toBe(false)

    // Every request went to the relay or C1's two routes, with the token of
    // its time as a Bearer and never a shared secret.
    const model = '/api/local-agent/model/language-model'
    const isSpec = (s: Seen) => s.path === '/api/local-agent/agent/spec?skills=1&schemas=1&turnContext=1'
    const isLive = (s: Seen) => s.path === '/api/local-agent/agent/spec?live=1'
    const isTool = (s: Seen) => s.path === '/api/local-agent/agent/tool'
    expect(seen.filter((s) => s.path !== model && !isSpec(s) && !isLive(s) && !isTool(s))).toEqual([])
    expect(seen.filter((s) => s.secret !== undefined)).toEqual([])
    expect(new Set(seen.filter((s) => s.path === model).map((s) => s.modelId))).toEqual(new Set(['anthropic/claude-sonnet-5.5']))
    expect(seen.slice(0, first).map((s) => s.authorization)).toEqual(seen.slice(0, first).map(() => `Bearer ${TOKEN_A}`))
    expect(seen.slice(first).length).toBeGreaterThanOrEqual(1)
    expect(seen.slice(first).map((s) => s.authorization)).toEqual(seen.slice(first).map(() => `Bearer ${TOKEN_B}`))
    for (const turn of [seen.slice(0, first), seen.slice(first)]) {
      expect(turn.some(isSpec)).toBe(true)
      expect(turn.filter(isTool)).toHaveLength(1)
      // The usage gate asks C1 before every model step (a Stop ends the turn at its next model call),
      // and bash and read_file ask again when that answer is over 2 s old (lib/mac-guard.ts).
      const steps = turn.filter((s) => s.path === model).length
      expect(turn.filter(isLive).length).toBeGreaterThanOrEqual(steps)
      expect(turn.filter(isLive).length).toBeLessThanOrEqual(steps + 2)
    }

    // The tool call: the spec's tool, its input, and eve's durable ids beside it.
    const toolBody = JSON.parse(seen.find(isTool)!.body) as Record<string, unknown>
    expect(toolBody).toMatchObject({ toolName: 'list_actions', input: {} })
    for (const id of ['callId', 'turnId', 'sessionId']) expect(typeof toolBody[id]).toBe('string')
    // The request was the cloud body's wording, not the person's: no evidence rides along.
    expect(toolBody.personMessages).toBeUndefined()

    // What the model saw: the spec's prompt and the Mac body's own
    // instructions, the fence's tools, the spec's tool and its result.
    const calls = seen.filter((s) => s.path === model)
    const firstCall = calls[0].body
    expect(firstCall).toContain('SPEC-PROMPT-MARKER')
    expect(firstCall).toContain("You are on the person's Mac")
    expect(firstCall).toContain('This job is read-only')
    const tools = (JSON.parse(firstCall) as { tools?: { name: string; type?: string }[] }).tools ?? []
    const toolNames = new Set(tools.map((t) => t.name))
    for (const name of ['bash', 'read_file', 'write_file', 'finish', 'request_folder_access', 'list_actions', 'search_tools']) expect(toolNames).toContain(name)
    for (const name of ['agent', 'helpers']) expect(toolNames).not.toContain(name)
    // The web tools are C1's proxies (ordinary function tools), not eve's native ones (provider tools).
    for (const name of ['web_fetch', 'web_search']) expect(tools.find((t) => t.name === name)?.type, name).toBe('function')
    expect(calls.some((c) => c.body.includes('TOOL-OUTPUT-MARKER'))).toBe(true)
    // bash ran in the fence on the granted folder: the sandboxed `ls` listed its file.
    expect(calls.some((c) => c.body.includes(FIXTURE))).toBe(true)
    // read_file of the PNG: the model got the Mac's note, never the image, and
    // nothing was staged into the folder (eve's attachments dir).
    expect(calls.some((c) => c.body.includes("Images and PDFs aren't shown to you on the Mac"))).toBe(true)
    expect(calls.some((c) => c.body.includes(PIXEL_BASE64.slice(0, 40)))).toBe(false)
    expect(existsSync(join(granted, '.eve'))).toBe(false)
    // And it was read as an image (eve's file path), not refused.
    expect(calls.some((c) => c.body.includes('"toolName":"read_file","output":{"type":"json"'))).toBe(true)
    // The build's sandbox slot is the host-folder fence (a build without it would run eve's default).
    const manifest = JSON.parse(readFileSync(join(AGENT_DIR, '.output', '.eve', 'compile', 'compiled-agent-manifest.json'), 'utf8')) as { sandbox?: { providerName?: string } }
    expect(manifest.sandbox?.providerName).toBe('dial8-host-folder')
    // The token never reached stdout.
    expect(JSON.stringify(run.lines)).not.toContain('test-token-')
  })

  it("on the person's ChatGPT plan, sends every model call to the relay's plan path for the plan model, never the Gateway path", async () => {
    seen.length = 0
    const dir = jobDir('relay-plan')
    const run = launch(envFor('relay-plan', { LOCAL_AGENT_MODEL_BASE_URL: base, LOCAL_AGENT_MODEL_TOKEN: PLAN_TOKEN }), dir)
    await run.waitFor((l) => l.type === 'ready', 60_000, 'ready')
    run.send({ type: 'start', request: 'Say hello.' })
    const reply = await run.waitFor((l) => isEvent('message')(l), 60_000, 'the plan reply')
    await run.waitFor(isEvent('status', 'waiting'), 30_000, 'waiting')
    run.send({ type: 'stop' })
    expect(await run.exit).toBe(0)

    expect(JSON.stringify(reply)).toContain('plan reply 2')
    const plan = seen.filter((s) => s.path === '/api/local-agent/model/plan/responses')
    expect(plan).toHaveLength(2)
    expect(seen.filter((s) => s.path === '/api/local-agent/model/language-model')).toEqual([])
    expect(plan.map((s) => s.authorization)).toEqual(plan.map(() => `Bearer ${PLAN_TOKEN}`))
    const bodies = plan.map((s) => JSON.parse(s.body) as { model?: string; store?: boolean; stream?: boolean; input?: { type?: string }[] })
    for (const body of bodies) expect(body).toMatchObject({ model: 'gpt-6.1-sol', store: false, stream: true })
    // The second step carries the tool call and its output inline, never a reference to a stored response.
    const second = bodies[1].input ?? []
    expect(second.map((i) => i.type)).toEqual(expect.arrayContaining(['function_call', 'function_call_output']))
    expect(second.some((i) => i.type === 'item_reference')).toBe(false)
    // The spec's tool ran through C1, with the plan token.
    expect(seen.filter((s) => s.path === '/api/local-agent/agent/tool').map((s) => s.authorization)).toEqual([`Bearer ${PLAN_TOKEN}`])
    expect(JSON.stringify(run.lines)).not.toContain('test-token-')
  })

  it('in an edit job, reading a PNG stages nothing into the worktree (writable there, and committed on finish)', async () => {
    const git = (args: string[]) =>
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main', ...args], {
        encoding: 'utf8',
        // Cast: Next's global types make ProcessEnv require NODE_ENV (not set here).
        env: { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } as Record<string, string> as NodeJS.ProcessEnv,
      })
    const repo = join(home, 'code', 'app')
    const worktree = join(home, '.dial8', 'worktrees', 'edit1')
    mkdirSync(repo, { recursive: true })
    mkdirSync(dirname(worktree), { recursive: true })
    writeFileSync(join(repo, FIXTURE), 'a fixture\n')
    writeFileSync(join(repo, PIXEL), new Uint8Array(Buffer.from(PIXEL_BASE64, 'base64')))
    git(['init', '-q', repo])
    git(['-C', repo, 'add', '-A'])
    git(['-C', repo, 'commit', '-q', '-m', 'initial commit'])
    git(['-C', repo, 'worktree', 'add', '-q', '-b', 'dial8/edit1', worktree, 'HEAD'])

    const from = seen.length
    const env = envFor('edit1', { LOCAL_AGENT_MODEL_BASE_URL: base, LOCAL_AGENT_MODEL_TOKEN: TOKEN_A, LOCAL_AGENT_MODE: 'edit', LOCAL_AGENT_FOLDER: worktree, LOCAL_AGENT_EXTRA_READ: join(repo, '.git') })
    const run = launch(env, jobDir('edit1'))
    await run.waitFor((l) => l.type === 'ready', 60_000, 'ready')
    slowToolCalls.ms = 2_100
    try {
      run.send({ type: 'start', request: 'Look at the picture.' })
      await run.waitFor(isEvent('message'), 60_000, 'the reply')
      await run.waitFor(isEvent('status', 'waiting'), 30_000, 'waiting')
    } finally {
      slowToolCalls.ms = 0
    }
    run.send({ type: 'stop' })
    expect(await run.exit).toBe(0)

    const calls = seen.slice(from).filter((s) => s.path === '/api/local-agent/model/language-model')
    // The model took over 2 s to answer each tool call, so bash and read_file each asked C1
    // again before acting (lib/mac-guard.ts); list_actions is C1's own and does not.
    expect(seen.slice(from).filter((s) => s.path === '/api/local-agent/agent/spec?live=1')).toHaveLength(calls.length + 2)
    expect(calls[0].body).toContain('Make the changes in')
    // bash ran in the worktree, and read_file read the PNG as an image (eve's file path), not refused…
    expect(calls.some((c) => c.body.includes(FIXTURE))).toBe(true)
    expect(calls.some((c) => c.body.includes('"toolName":"read_file","output":{"type":"json"'))).toBe(true)
    // …but the model got the Mac's note, never the image…
    expect(calls.some((c) => c.body.includes("Images and PDFs aren't shown to you on the Mac"))).toBe(true)
    expect(calls.some((c) => c.body.includes(PIXEL_BASE64.slice(0, 40)))).toBe(false)
    // …and nothing was staged into the worktree: no eve attachments dir, nothing for the commit.
    expect(existsSync(join(worktree, '.eve'))).toBe(false)
    expect(git(['-C', worktree, 'status', '--porcelain', '--untracked-files=all'])).toBe('')
  })

  it('refuses an agent build that is not the Mac body, and a local model on a build without one', async () => {
    // A built server with no host marker (a cloud build, or an old one): fatal before any spawn.
    const notMac = join(root, 'not-mac')
    mkdirSync(join(notMac, '.output', 'server'), { recursive: true })
    writeFileSync(join(notMac, '.output', 'server', 'index.mjs'), 'process.exit(3)\n')
    const run = launch({ ...envFor('marker1', { LOCAL_AGENT_MODEL_BASE_URL: base, LOCAL_AGENT_MODEL_TOKEN: TOKEN_A }), LOCAL_AGENT_DIR: notMac }, jobDir('marker1'))
    expect((await run.waitFor((l) => l.type === 'fatal', 30_000, 'fatal')).message).toMatch(/not the Mac body/)
    expect(await run.exit).toBe(1)
    // This tree's build has no local route yet (its marker says so): a local-model launch is refused.
    const marker = JSON.parse(readFileSync(join(AGENT_DIR, '.output', 'dial8-host.json'), 'utf8')) as { host: string; localModel: boolean }
    expect(marker.host).toBe('mac')
    if (!marker.localModel) {
      const local = launch(envFor('marker2', { LOCAL_AGENT_LOCAL_MODEL_BASE_URL: 'http://127.0.0.1:9/v1', LOCAL_AGENT_LOCAL_MODEL_ID: 'qwen3' }), jobDir('marker2'))
      expect((await local.waitFor((l) => l.type === 'fatal', 30_000, 'fatal')).message).toMatch(/cannot run a model on this Mac/)
      expect(await local.exit).toBe(1)
    }
  })

  it('refuses a half-configured relay before starting anything', async () => {
    const run = launch(envFor('relay2', { LOCAL_AGENT_MODEL_BASE_URL: base }), jobDir('relay2'))
    const fatal = await run.waitFor((l) => l.type === 'fatal', 30_000, 'fatal')
    expect(fatal.message).toMatch(/set together/)
    expect(await run.exit).toBe(1)
  })
})
