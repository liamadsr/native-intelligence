/**
 * A model on this Mac, end to end without a model: the REAL launcher starts
 * the REAL built Mac body (scripts/local-agent/build.sh) with
 * LOCAL_AGENT_LOCAL_MODEL_* pointed at a fake Ollama on 127.0.0.1, and C1
 * (LOCAL_AGENT_API_ORIGIN + the session token) pointed at a fake app on
 * another loopback port. One turn of two model steps: a fenced `bash` call,
 * then text. It proves the runtime takes the local model, that every model
 * request goes to that server and nowhere else (no relay and no Gateway key
 * are set, so any other model call would fail the turn), that the probe ran
 * first, that the fence ran the command, and that the app gets only C1's
 * routes, never a model call.
 * Skipped when the agent is not built or not on macOS.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const AGENT_DIR = fileURLToPath(new URL('../..', import.meta.url))
const LAUNCHER = fileURLToPath(new URL('../../launcher/launcher.ts', import.meta.url))
const built = existsSync(join(AGENT_DIR, '.output', 'server', 'index.mjs'))
const MODEL = 'qwen3:8b'
const TOKEN = 'test-session-token.0123456789abcdef'
/** A file in the granted folder that the fenced `ls` must list. */
const FIXTURE = 'LOCAL-MODEL-FIXTURE.txt'

interface Seen {
  method: string
  path: string
  authorization: string | undefined
  body: Record<string, unknown> | null
}

/** The spec C1 would send (as in launcher/__tests__/relay.test.ts): one workspace tool. */
const SPEC = {
  systemPrompt: 'SPEC-PROMPT-MARKER: you are the person’s Dial8 agent.',
  model: 'anthropic/claude-sonnet-5.5',
  ceiling: ['list_actions'],
  ceilingTools: [{ name: 'list_actions', description: 'List the workspace actions.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
  coreToolNames: ['list_actions'],
  helpersAllowed: false,
  host: 'mac',
}

const sse = (chunks: unknown[]) => `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`
const chunk = (delta: unknown, finish: string | null = null) => ({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 0, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })
const usage = { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 0, model: MODEL, choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }

function listen(handler: (req: { method: string; path: string; authorization: string | undefined; body: Record<string, unknown> | null }, res: import('node:http').ServerResponse) => void): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8').on('data', (d: string) => (raw += d))
    req.on('end', () => {
      let body: Record<string, unknown> | null = null
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
      } catch {
        // not JSON
      }
      handler({ method: req.method ?? '', path: req.url ?? '', authorization: req.headers.authorization, body }, res)
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port })))
}

/** Ollama's OpenAI-compatible API, enough for the provider and the probe: the model list, capabilities, a load, the loaded context, and two chat answers. */
function fakeOllama(seen: Seen[]) {
  let chats = 0
  return listen((req, res) => {
    seen.push(req)
    const json = (o: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o))
    if (req.method === 'GET' && req.path === '/v1/models') return json({ object: 'list', data: [{ id: MODEL, object: 'model' }] })
    if (req.method === 'POST' && req.path === '/api/show') return json({ capabilities: ['completion', 'tools'] })
    if (req.method === 'POST' && req.path === '/api/generate') return json({ model: MODEL, response: '', done: true, done_reason: 'load' })
    if (req.method === 'GET' && req.path === '/api/ps') return json({ models: [{ name: MODEL, model: MODEL, context_length: 65536 }] })
    if (req.method === 'POST' && req.path === '/v1/chat/completions') {
      chats += 1
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (chats === 1) {
        return res.end(
          sse([
            chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: '' } }] }),
            chunk({ tool_calls: [{ index: 0, function: { arguments: '{"command":"ls"}' } }] }),
            chunk({}, 'tool_calls'),
            usage,
          ]),
        )
      }
      return res.end(sse([chunk({ role: 'assistant', content: 'all done' }), chunk({}, 'stop'), usage]))
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}')
  })
}

/** The app's C1 routes: the spec (and its liveness check) and the tool route. Anything else is a 404. */
function fakeApp(seen: Seen[]) {
  return listen((req, res) => {
    seen.push(req)
    const json = (o: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o))
    if (req.method === 'GET' && req.path.startsWith('/api/local-agent/agent/spec?')) return json(SPEC)
    if (req.method === 'POST' && req.path === '/api/local-agent/agent/tool') return json({ output: { actions: [] } })
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"not here"}}')
  })
}

interface Run {
  lines: Record<string, unknown>[]
  stderr: () => string
  send(msg: object): void
  waitFor(pred: (l: Record<string, unknown>) => boolean, ms: number, what: string): Promise<Record<string, unknown>>
  exit: Promise<number | null>
  child: ChildProcessWithoutNullStreams
}

function launch(env: Record<string, string>, cwd: string): Run {
  const child = spawn(process.execPath, [LAUNCHER], { cwd, env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] })
  const lines: Record<string, unknown>[] = []
  let stderr = ''
  const waiters: { pred: (l: Record<string, unknown>) => boolean; resolve: (l: Record<string, unknown>) => void }[] = []
  createInterface({ input: child.stdout }).on('line', (raw) => {
    const line = JSON.parse(raw) as Record<string, unknown>
    lines.push(line)
    for (const w of [...waiters]) if (w.pred(line)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(line))
  })
  child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
  return {
    child,
    lines,
    stderr: () => stderr,
    exit: new Promise((r) => child.once('exit', (code) => r(code))),
    send: (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`),
    waitFor(pred, ms, what) {
      const hit = lines.find(pred)
      if (hit) return Promise.resolve(hit)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}: ${JSON.stringify(lines.slice(-6))}\n${stderr.slice(-2000)}`)), ms)
        waiters.push({ pred, resolve: (l) => (clearTimeout(timer), resolve(l)) })
      })
    },
  }
}

const event = (l: Record<string, unknown>) => (l.type === 'event' ? (l.event as Record<string, unknown>) : null)

describe.runIf(built && process.platform === 'darwin')('a model on this Mac in the built Mac body, through the real launcher', { timeout: 120_000 }, () => {
  const ollamaSeen: Seen[] = []
  const appSeen: Seen[] = []
  let root: string
  let ollama: { server: Server; port: number }
  let app: { server: Server; port: number }

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'la-local-model-')))
    mkdirSync(join(root, 'home', 'project'), { recursive: true })
    writeFileSync(join(root, 'home', 'project', FIXTURE), 'a fixture\n')
    ollama = await fakeOllama(ollamaSeen)
    app = await fakeApp(appSeen)
  })

  afterAll(() => {
    ollama?.server.close()
    app?.server.close()
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('runs a two-step turn on the local model: every model request on the loopback model server, C1 only on the app', async () => {
    const marker = JSON.parse(readFileSync(join(AGENT_DIR, '.output', 'dial8-host.json'), 'utf8')) as { host: string; localModel: boolean }
    expect(marker).toEqual({ host: 'mac', localModel: true })
    const job = join(root, 'jobs', 'jobmodel1')
    const tmp = join(root, 'tmp')
    for (const d of [job, tmp]) mkdirSync(d, { recursive: true })
    const run = launch(
      {
        HOME: join(root, 'home'),
        TMPDIR: tmp,
        LANG: 'en_US.UTF-8',
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        LOCAL_AGENT_JOB_ID: 'jobmodel1',
        LOCAL_AGENT_FOLDER: join(root, 'home', 'project'),
        LOCAL_AGENT_MODE: 'read',
        LOCAL_AGENT_TOOL_PATH: '/usr/bin:/bin',
        LOCAL_AGENT_DIR: AGENT_DIR,
        LOCAL_AGENT_API_ORIGIN: `http://127.0.0.1:${app.port}`,
        LOCAL_AGENT_MODEL_TOKEN: TOKEN,
        LOCAL_AGENT_LOCAL_MODEL_BASE_URL: `http://127.0.0.1:${ollama.port}/v1`,
        LOCAL_AGENT_LOCAL_MODEL_ID: MODEL,
        LOCAL_AGENT_LOCAL_MODEL_SERVER: 'ollama',
      },
      job,
    )
    await run.waitFor((l) => l.type === 'ready', 60_000, 'ready')
    run.send({ type: 'start', request: 'Say hello, then stop.' })
    await run.waitFor((l) => event(l)?.kind === 'status' && (event(l)?.status === 'waiting' || event(l)?.status === 'failed'), 60_000, 'the turn boundary')
    const events = run.lines.map(event).filter((e): e is Record<string, unknown> => e !== null)
    expect(events.filter((e) => e.kind === 'error' || e.status === 'failed')).toEqual([])
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool', name: 'bash' }))
    expect(events).toContainEqual({ kind: 'message', text: 'all done' })
    run.send({ type: 'stop' })
    expect(await run.exit).toBe(0)

    // The model server: the probe first, then the two model steps; nothing else, and no key sent.
    expect(ollamaSeen.map((s) => `${s.method} ${s.path}`)).toEqual(['GET /v1/models', 'POST /api/show', 'POST /api/generate', 'GET /api/ps', 'POST /v1/chat/completions', 'POST /v1/chat/completions'])
    expect(ollamaSeen[2].body).toEqual({ model: MODEL, prompt: '', stream: false }) // a load with no options: no generation
    expect(ollamaSeen.filter((s) => s.authorization !== undefined)).toEqual([])
    const [first, second] = ollamaSeen.filter((s) => s.path === '/v1/chat/completions').map((s) => s.body!)
    expect(first.model).toBe(MODEL)
    expect(first.stream).toBe(true)
    expect(JSON.stringify(first.messages)).toContain('SPEC-PROMPT-MARKER')
    const toolNames = (first.tools as { function: { name: string } }[]).map((t) => t.function.name)
    for (const name of ['bash', 'read_file', 'write_file', 'finish', 'list_actions']) expect(toolNames).toContain(name)
    // The fence ran the command on the granted folder: its `ls` listed the fixture.
    const toolMessage = (second.messages as { role: string; tool_call_id?: string; content?: unknown }[]).find((m) => m.role === 'tool' && m.tool_call_id === 'call_1')
    expect(JSON.stringify(toolMessage?.content)).toContain(FIXTURE)

    // The app: C1's routes only, each with the session token; never a model call.
    expect(appSeen.length).toBeGreaterThan(0)
    expect(appSeen.filter((s) => !s.path.startsWith('/api/local-agent/agent/spec?') && s.path !== '/api/local-agent/agent/tool')).toEqual([])
    expect(appSeen.filter((s) => s.authorization !== `Bearer ${TOKEN}`)).toEqual([])
    // The token never reached stdout.
    expect(JSON.stringify(run.lines)).not.toContain(TOKEN)
  })
})
