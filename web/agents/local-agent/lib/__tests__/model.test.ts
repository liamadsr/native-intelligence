/**
 * The local agent's model route: relay vs dev from the environment, the token
 * file, and the relay fetch that puts the CURRENT token on every request and
 * never sends it anywhere but the relay. No model is called here: the fetch
 * is driven directly with a recording stand-in. (The launcher's relay test
 * drives a whole turn through a fake relay.)
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PLAN_WINDOW_TOKENS } from '../chatgpt-plan-model'
import {
  MIN_LOCAL_MODEL_CONTEXT,
  MAX_LOCAL_MODEL_CONTEXT,
  LOCAL_AGENT_CONTEXT_WINDOW,
  LOCAL_AGENT_MODEL,
  LOCAL_AGENT_PLAN_MODEL,
  createLocalAgentModel,
  describeLocalModelFailure,
  localAgentContextWindow,
  localAgentPlanStep,
  localModelBaseUrl,
  localModelFetch,
  localModelMessages,
  modelRouteFromEnv,
  onChatGptPlanNow,
  probeLocalModel,
  readModelToken,
  relayBaseUrl,
  relayFetch,
  resolveLocalAgentContextWindow,
  tokenIsOnChatGptPlan,
  type LocalModelRoute,
} from '../model'

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'la-model-test-')))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const TOKEN_A = 'tok.A-0123456789abcdef'
const TOKEN_B = 'tok.B-fedcba9876543210'

describe('relayBaseUrl', () => {
  it.each([
    ['https://dial8.ai/api/local-agent/model', 'https://dial8.ai/api/local-agent/model'],
    ['https://dial8.ai/api/local-agent/model/', 'https://dial8.ai/api/local-agent/model'],
    ['http://localhost:3000/api/local-agent/model', 'http://localhost:3000/api/local-agent/model'],
    ['http://127.0.0.1:3000/api/local-agent/model', 'http://127.0.0.1:3000/api/local-agent/model'],
  ])('%s', (raw, expected) => {
    expect(relayBaseUrl(raw)).toBe(expected)
  })

  it.each([
    undefined,
    '',
    'not a url',
    'http://dial8.ai/api/local-agent/model',
    'http://192.168.1.2:3000/x',
    'https://user:pass@dial8.ai/x',
    'https://dial8.ai/x?token=1',
    'https://dial8.ai/x#f',
    'file:///etc/passwd',
  ])('rejects %j', (raw) => {
    expect(relayBaseUrl(raw)).toBeNull()
  })
})

describe('modelRouteFromEnv', () => {
  it('is the dev path when no relay is configured', () => {
    expect(modelRouteFromEnv({})).toEqual({ kind: 'dev' })
    expect(modelRouteFromEnv({ AI_GATEWAY_API_KEY: 'x' })).toEqual({ kind: 'dev' })
  })

  it('is the relay when both the base URL and the token file are set', () => {
    expect(modelRouteFromEnv({ LOCAL_AGENT_MODEL_BASE_URL: 'https://dial8.ai/api/local-agent/model/', LOCAL_AGENT_MODEL_TOKEN_FILE: '/j/.model-token' })).toEqual({
      kind: 'relay',
      baseURL: 'https://dial8.ai/api/local-agent/model',
      tokenFile: '/j/.model-token',
    })
  })

  it('throws on a half-configured or malformed relay (never falls back to a dev key)', () => {
    expect(() => modelRouteFromEnv({ LOCAL_AGENT_MODEL_BASE_URL: 'https://dial8.ai/m', AI_GATEWAY_API_KEY: 'x' })).toThrow(/TOKEN_FILE/)
    expect(() => modelRouteFromEnv({ LOCAL_AGENT_MODEL_TOKEN_FILE: '/j/.model-token' })).toThrow(/BASE_URL/)
    expect(() => modelRouteFromEnv({ LOCAL_AGENT_MODEL_BASE_URL: 'http://dial8.ai/m', LOCAL_AGENT_MODEL_TOKEN_FILE: '/j/t' })).toThrow(/https/)
    expect(() => modelRouteFromEnv({ LOCAL_AGENT_MODEL_BASE_URL: 'https://dial8.ai/m', LOCAL_AGENT_MODEL_TOKEN_FILE: 'relative' })).toThrow(/absolute/)
  })
})

describe('readModelToken', () => {
  it('reads the token, trimmed', () => {
    const f = join(dir, 'tok1')
    writeFileSync(f, `${TOKEN_A}\n`)
    expect(readModelToken(f)).toBe(TOKEN_A)
  })

  it('throws on a missing file or a value that is not a token, without echoing it', () => {
    expect(() => readModelToken(join(dir, 'missing'))).toThrow(/could not be read/)
    for (const bad of ['', 'short', 'has a space in it 0123456789', `x${'\n'}y-0123456789abcdef`]) {
      const f = join(dir, 'bad')
      writeFileSync(f, bad)
      expect(() => readModelToken(f)).toThrow(/does not hold a token/)
    }
  })
})

describe('relayFetch', () => {
  const tokenFile = join(dir, '.model-token')
  const route = { kind: 'relay' as const, baseURL: 'https://dial8.ai/api/local-agent/model', tokenFile }
  const recorder = () => {
    const calls: { url: string; headers: Headers; method?: string; body?: unknown }[] = []
    const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const headers = input instanceof Request ? input.headers : new Headers(init?.headers)
      calls.push({ url, headers, method: init?.method ?? (input instanceof Request ? input.method : undefined), body: init?.body })
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    return { calls, base }
  }

  it("replaces the provider's placeholder with the file's current token on every request, keeping other headers", async () => {
    const { calls, base } = recorder()
    const f = relayFetch(route, base)
    writeFileSync(tokenFile, TOKEN_A)
    await f(`${route.baseURL}/language-model`, {
      method: 'POST',
      headers: { Authorization: 'Bearer replaced-per-request-by-relayFetch', 'ai-language-model-id': LOCAL_AGENT_MODEL },
      body: '{}',
    })
    writeFileSync(tokenFile, TOKEN_B) // a refresh: the launcher rewrote the file
    await f(new Request(`${route.baseURL}/language-model`, { method: 'POST', headers: { 'ai-language-model-streaming': 'true' }, body: '{}' }))
    expect(calls.map((c) => c.headers.get('authorization'))).toEqual([`Bearer ${TOKEN_A}`, `Bearer ${TOKEN_B}`])
    expect(calls[0].headers.get('ai-language-model-id')).toBe(LOCAL_AGENT_MODEL)
    expect(calls[0].method).toBe('POST')
    expect(calls[1].headers.get('ai-language-model-streaming')).toBe('true')
  })

  it('refuses to send the token anywhere but the relay', async () => {
    const { calls, base } = recorder()
    const f = relayFetch(route, base)
    writeFileSync(tokenFile, TOKEN_A)
    for (const url of ['https://ai-gateway.vercel.sh/v4/ai/language-model', 'https://dial8.ai/api/local-agent/modelx', 'https://evil.example/api/local-agent/model/x']) {
      await expect(f(url, { method: 'POST' })).rejects.toThrow(/outside the relay/)
    }
    expect(calls).toEqual([])
  })

  it('sends nothing when the token file is gone', async () => {
    const { calls, base } = recorder()
    rmSync(tokenFile, { force: true })
    await expect(relayFetch(route, base)(`${route.baseURL}/language-model`, {})).rejects.toThrow(/could not be read/)
    expect(calls).toEqual([])
  })
})

describe('createLocalAgentModel', () => {
  it('always builds a Gateway LanguageModel for the local model (dev and relay alike)', () => {
    const dev = createLocalAgentModel({})
    const relay = createLocalAgentModel({ LOCAL_AGENT_MODEL_BASE_URL: 'https://dial8.ai/api/local-agent/model', LOCAL_AGENT_MODEL_TOKEN_FILE: join(dir, 't') })
    for (const m of [dev, relay]) {
      expect(typeof m).toBe('object')
      expect(m).toMatchObject({ provider: 'gateway', modelId: LOCAL_AGENT_MODEL })
    }
  })

  it('throws on a half-configured relay', () => {
    expect(() => createLocalAgentModel({ LOCAL_AGENT_MODEL_BASE_URL: 'https://dial8.ai/m' })).toThrow()
  })
})

describe('on the ChatGPT plan', () => {
  const tokenFile = join(dir, '.plan-token')
  const env = { LOCAL_AGENT_MODEL_BASE_URL: 'https://dial8.ai/api/local-agent/model', LOCAL_AGENT_MODEL_TOKEN_FILE: tokenFile }
  // The shape the relay mints (src/lib/local-agent/tokens.ts); the MAC is never checked here.
  const laToken = (claims: object) => `la1.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.bWFjLW5vdC1jaGVja2VkLWhlcmU`
  const PLAN_TOKEN = laToken({ sid: 's1', uid: 'u1', wid: 'w1', exp: 9_999_999_999, cp: true })
  const PAID_TOKEN = laToken({ sid: 's1', uid: 'u1', wid: 'w1', exp: 9_999_999_999 })

  it('reads the `cp` claim without the key, and never throws', () => {
    expect(tokenIsOnChatGptPlan(PLAN_TOKEN)).toBe(true)
    expect(tokenIsOnChatGptPlan(PAID_TOKEN)).toBe(false)
    expect(tokenIsOnChatGptPlan(laToken({ cp: 'true' }))).toBe(false)
    expect(tokenIsOnChatGptPlan(PLAN_TOKEN.replace(/^la1/, 'la2'))).toBe(false)
    expect(tokenIsOnChatGptPlan('la1.%%%not-base64-json%%%.sig')).toBe(false)
    expect(tokenIsOnChatGptPlan(TOKEN_A)).toBe(false)
  })

  it('reads the current token file: dev and an unreadable file are not on the plan', () => {
    const route = modelRouteFromEnv(env)
    rmSync(tokenFile, { force: true })
    expect(onChatGptPlanNow(route)).toBe(false)
    expect(onChatGptPlanNow({ kind: 'dev' })).toBe(false)
    writeFileSync(tokenFile, PAID_TOKEN)
    expect(onChatGptPlanNow(route)).toBe(false)
    writeFileSync(tokenFile, PLAN_TOKEN)
    expect(onChatGptPlanNow(route)).toBe(true)
  })

  it("gives a relay step the plan's model while the current token says so, building it once", () => {
    writeFileSync(tokenFile, PAID_TOKEN)
    expect(localAgentPlanStep(env)).toBeNull()
    writeFileSync(tokenFile, PLAN_TOKEN) // a refresh that gained the flag
    const plan = localAgentPlanStep(env)
    expect(plan?.model).toMatchObject({ provider: 'chatgpt-plan.responses', modelId: LOCAL_AGENT_PLAN_MODEL })
    expect(localAgentPlanStep(env)).toBe(plan)
    writeFileSync(tokenFile, PAID_TOKEN) // and lost it (the person subscribed)
    expect(localAgentPlanStep(env)).toBeNull()
  })

  it("builds the plan's Responses model with store:false, the plan window and an explicit effort; nothing off the relay", () => {
    writeFileSync(tokenFile, PLAN_TOKEN)
    const plan = localAgentPlanStep(env)!
    expect(plan.modelContextWindowTokens).toBe(PLAN_WINDOW_TOKENS)
    expect(plan.modelOptions).toEqual({ providerOptions: { openai: { store: false } } })
    expect(plan.reasoning).toBe('medium')
    // The dev key and a model on the Mac are never on the plan.
    expect(localAgentPlanStep({})).toBeNull()
    expect(localAgentPlanStep({ LOCAL_AGENT_LOCAL_MODEL_BASE_URL: 'http://127.0.0.1:11434/v1', LOCAL_AGENT_LOCAL_MODEL_ID: 'gpt-oss:20b', LOCAL_AGENT_LOCAL_MODEL_SERVER: 'ollama' })).toBeNull()
  })
})

// ── A model on this Mac (L4) ─────────────────────────────────────────────────

const OLLAMA = 'http://127.0.0.1:11434/v1'
const LOCAL_ENV = { LOCAL_AGENT_LOCAL_MODEL_BASE_URL: OLLAMA, LOCAL_AGENT_LOCAL_MODEL_ID: 'gpt-oss:20b', LOCAL_AGENT_LOCAL_MODEL_SERVER: 'ollama' }
const ollamaRoute: LocalModelRoute = { kind: 'local', baseURL: OLLAMA, modelId: 'gpt-oss:20b', server: 'ollama' }
const lmRoute: LocalModelRoute = { kind: 'local', baseURL: 'http://127.0.0.1:1234/v1', modelId: 'qwen3-8b', server: 'lmstudio' }

interface FakeOpts {
  models?: string[]
  /** Ollama /api/show (and LM Studio /api/v0/models/<id>) body; null answers 404. */
  info?: Record<string, unknown> | null
  /** Ollama /api/ps context for the model; null = not loaded (until a load, when `loadTo` is set). */
  loaded?: number | null
  /** The context Ollama gives the model when /api/generate loads it (unset: what it had). */
  loadTo?: number | null
  /** An /api/generate status other than 200 (a load that failed). */
  loadStatus?: number
  chat?: { status: number; body: string }
  down?: boolean
}

/**
 * A stand-in model server, answering by path and recording each request:
 * `/v1/models`, Ollama's `/api/show`, `/api/ps` and `/api/generate` (a load),
 * LM Studio's `/api/v0/models/<id>`, and the chat route.
 */
function fakeServer(opts: FakeOpts = {}) {
  const calls: { url: string; method: string; redirect?: RequestRedirect; body?: string }[] = []
  let loaded = opts.loaded === undefined ? 65536 : opts.loaded
  const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init)
    const body = typeof init?.body === 'string' ? init.body : undefined
    calls.push({ url: req.url, method: req.method, redirect: init?.redirect ?? (input instanceof Request ? input.redirect : undefined), body })
    if (opts.down) throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' }) })
    const path = new URL(req.url).pathname
    const id = opts.models?.[0] ?? (path.includes('qwen') ? 'qwen3-8b' : 'gpt-oss:20b')
    if (path === '/v1/models') return Response.json({ object: 'list', data: (opts.models ?? ['gpt-oss:20b', 'qwen3-8b']).map((m) => ({ id: m, object: 'model' })) })
    if (path === '/api/show' || path.startsWith('/api/v0/models/')) {
      if (opts.info === null) return new Response('not found', { status: 404 })
      return Response.json(opts.info ?? { capabilities: ['completion', 'tools'] })
    }
    if (path === '/api/ps') return Response.json({ models: loaded === null ? [] : [{ name: id, model: id, context_length: loaded }] })
    if (path === '/api/generate') {
      if (opts.loadStatus) return new Response('{"error":"llama runner process has terminated"}', { status: opts.loadStatus })
      if (opts.loadTo !== undefined) loaded = opts.loadTo
      return Response.json({ model: id, response: '', done: true, done_reason: 'load' })
    }
    if (path === '/v1/chat/completions') return new Response(opts.chat?.body ?? '{}', { status: opts.chat?.status ?? 200 })
    return new Response('no route', { status: 404 })
  }) as typeof fetch
  return { calls, base }
}

const paths = (calls: { url: string; method: string }[]) => calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)

describe('localModelBaseUrl', () => {
  it.each([
    [OLLAMA, OLLAMA],
    ['http://127.0.0.1:1234/v1/', 'http://127.0.0.1:1234/v1'],
    ['http://[::1]:11434/v1', 'http://[::1]:11434/v1'],
  ])('%s', (raw, expected) => {
    expect(localModelBaseUrl(raw)).toBe(expected)
  })

  it.each([
    undefined,
    '',
    'not a url',
    'http://localhost:11434/v1', // a name a resolver could point elsewhere
    'http://192.168.1.20:11434/v1',
    'https://api.openai.com/v1',
    'http://127.0.0.1.nip.io:11434/v1',
    'http://user:pw@127.0.0.1:11434/v1',
    'http://127.0.0.1:11434/v1?x=1',
    'http://127.0.0.1:11434/v1#f',
    'file:///v1',
  ])('rejects %j', (raw) => {
    expect(localModelBaseUrl(raw)).toBeNull()
  })
})

describe('modelRouteFromEnv: a model on this Mac', () => {
  it('is the local route when the base URL and the model id are set', () => {
    expect(modelRouteFromEnv(LOCAL_ENV)).toEqual(ollamaRoute)
    expect(modelRouteFromEnv({ ...LOCAL_ENV, LOCAL_AGENT_LOCAL_MODEL_SERVER: 'lmstudio' })).toMatchObject({ server: 'lmstudio' })
    expect(modelRouteFromEnv({ ...LOCAL_ENV, LOCAL_AGENT_LOCAL_MODEL_SERVER: 'vllm' })).toMatchObject({ server: null })
    // The C1 session token has its own name, which the model never reads.
    expect(modelRouteFromEnv({ ...LOCAL_ENV, LOCAL_AGENT_SESSION_TOKEN_FILE: '/j/.session-token' })).toEqual(ollamaRoute)
  })

  it('refuses a relay or Gateway credential beside a local model', () => {
    for (const k of ['LOCAL_AGENT_MODEL_BASE_URL', 'LOCAL_AGENT_MODEL_TOKEN_FILE', 'LOCAL_AGENT_MODEL_TOKEN', 'AI_GATEWAY_API_KEY']) {
      expect(() => modelRouteFromEnv({ ...LOCAL_ENV, [k]: 'x' }), k).toThrow(new RegExp(`${k} must not be set with a model on this Mac`))
    }
  })

  it('throws on a half-configured or malformed local model (never falls back to the relay or a dev key)', () => {
    expect(() => modelRouteFromEnv({ LOCAL_AGENT_LOCAL_MODEL_BASE_URL: OLLAMA })).toThrow(/MODEL_ID/)
    expect(() => modelRouteFromEnv({ LOCAL_AGENT_LOCAL_MODEL_ID: 'gpt-oss:20b' })).toThrow(/LOCAL_MODEL_BASE_URL/)
    expect(() => modelRouteFromEnv({ ...LOCAL_ENV, LOCAL_AGENT_LOCAL_MODEL_BASE_URL: 'https://api.openai.com/v1' })).toThrow(/loopback/)
    expect(() => modelRouteFromEnv({ ...LOCAL_ENV, LOCAL_AGENT_LOCAL_MODEL_ID: 'has a space' })).toThrow(/model id/)
  })
})

describe('probeLocalModel', () => {
  it("Ollama: checks the list, the model's info and the context it has, and records it for compaction", async () => {
    const { calls, base } = fakeServer({ loaded: 131072 })
    expect(await probeLocalModel(ollamaRoute, base)).toBe(131072)
    expect(paths(calls)).toEqual(['GET /v1/models', 'POST /api/show', 'POST /api/generate', 'GET /api/ps'])
    expect(calls.every((c) => c.redirect === 'error')).toBe(true)
    expect(localAgentContextWindow(LOCAL_ENV)).toBe(131072)
  })

  it("Ollama: loads the model as the job's requests will (an empty prompt, no options: no generation), then reads what it got", async () => {
    const { calls, base } = fakeServer({ loaded: null, loadTo: 40960 })
    expect(await probeLocalModel(ollamaRoute, base)).toBe(40960)
    expect(paths(calls)).toEqual(['GET /v1/models', 'POST /api/show', 'POST /api/generate', 'GET /api/ps'])
    expect(JSON.parse(calls[2].body!)).toEqual({ model: 'gpt-oss:20b', prompt: '', stream: false })
    // Another client loaded it with a larger num_ctx: Ollama reloads it at the job's own, which is what counts.
    expect(await probeLocalModel(ollamaRoute, fakeServer({ loaded: 131072, loadTo: 40960 }).base)).toBe(40960)
  })

  it("Ollama: refuses, before anything loads, when /api/show doesn't say where the model runs; and a load that fails", async () => {
    const silent = fakeServer({ info: null })
    await expect(probeLocalModel(ollamaRoute, silent.base)).rejects.toThrow(/Ollama didn't say where gpt-oss:20b runs/)
    expect(paths(silent.calls)).toEqual(['GET /v1/models', 'POST /api/show'])
    await expect(probeLocalModel(ollamaRoute, fakeServer({ loadStatus: 500 }).base)).rejects.toThrow(/Ollama couldn't load gpt-oss:20b/)
  })

  it("Ollama: falls back to the Modelfile's num_ctx when /api/ps can't say", async () => {
    const { base } = fakeServer({ loaded: null, loadTo: null, info: { capabilities: ['tools'], parameters: 'stop "<|end|>"\nnum_ctx                        65536' } })
    expect(await probeLocalModel(ollamaRoute, base)).toBe(65536)
  })

  it('counts a reported context past MAX_LOCAL_MODEL_CONTEXT as that', async () => {
    expect(await probeLocalModel(ollamaRoute, fakeServer({ loaded: 50_000_000 }).base)).toBe(MAX_LOCAL_MODEL_CONTEXT)
  })

  it('LM Studio: the loaded context length, from its own model endpoint', async () => {
    const { calls, base } = fakeServer({ info: { capabilities: ['tool_use'], state: 'loaded', loaded_context_length: 32768, max_context_length: 131072 } })
    expect(await probeLocalModel(lmRoute, base)).toBe(32768)
    expect(paths(calls)).toEqual(['GET /v1/models', 'GET /api/v0/models/qwen3-8b'])
  })

  it('refuses a context it cannot tell, or one under the floor, saying what to change', async () => {
    await expect(probeLocalModel(ollamaRoute, fakeServer({ loaded: null, loadTo: null }).base)).rejects.toThrow(/Couldn't tell how much context Ollama gives gpt-oss:20b.*OLLAMA_CONTEXT_LENGTH=32768/)
    await expect(probeLocalModel(ollamaRoute, fakeServer({ loaded: 4096 }).base)).rejects.toThrow(/only 4096 tokens of context.*at least 32768.*OLLAMA_CONTEXT_LENGTH/)
    await expect(probeLocalModel(lmRoute, fakeServer({ info: { capabilities: ['tool_use'], state: 'not-loaded', max_context_length: 131072 } }).base)).rejects.toThrow(/isn't loaded in LM Studio.*context length of at least 32768/)
    await expect(probeLocalModel(lmRoute, fakeServer({ info: { loaded_context_length: 8192 } }).base)).rejects.toThrow(/LM Studio loaded qwen3-8b with only 8192 tokens/)
    await expect(probeLocalModel({ ...ollamaRoute, server: null }, fakeServer().base)).rejects.toThrow(/Couldn't tell how much context the model server gives/)
  })

  it('refuses an Ollama cloud model: by its name, or by what /api/show says', async () => {
    const cloud = { ...ollamaRoute, modelId: 'gpt-oss:120b-cloud' }
    await expect(probeLocalModel(cloud, fakeServer({ models: ['gpt-oss:120b-cloud'] }).base)).rejects.toThrow(/runs on Ollama's servers, not on this Mac/)
    await expect(probeLocalModel(ollamaRoute, fakeServer({ info: { capabilities: ['tools'], remote_host: 'https://ollama.com:443', remote_model: 'gpt-oss:120b' } }).base)).rejects.toThrow(/runs on Ollama's servers/)
  })

  it('says the server is not running, the model is missing, or it cannot call tools', async () => {
    await expect(probeLocalModel(ollamaRoute, fakeServer({ down: true }).base)).rejects.toThrow(localModelMessages.unreachable(ollamaRoute))
    await expect(probeLocalModel(ollamaRoute, fakeServer({ models: ['llama3.1:8b'] }).base)).rejects.toThrow(/ollama pull gpt-oss:20b/)
    await expect(probeLocalModel(ollamaRoute, fakeServer({ info: { capabilities: ['completion'] } }).base)).rejects.toThrow(/can't call tools/)
  })
})

describe('localModelFetch', () => {
  const chat = `${OLLAMA}/chat/completions`

  it('only reaches the loopback server in the route, and never follows a redirect', async () => {
    const { calls, base } = fakeServer()
    const f = localModelFetch(ollamaRoute, base)
    for (const url of ['https://ai-gateway.vercel.sh/v4/ai/language-model', 'http://127.0.0.1:11434/v1x/chat', 'http://127.0.0.1:1234/v1/chat/completions']) {
      await expect(f(url, { method: 'POST' })).rejects.toThrow(/outside the model server/)
    }
    expect(calls).toEqual([])
    await f(chat, { method: 'POST', body: '{}', redirect: 'follow' })
    await f(new Request(chat, { method: 'POST', body: '{}' }))
    const chats = calls.filter((c) => c.url === chat)
    expect(chats).toHaveLength(2)
    expect(calls.every((c) => c.redirect === 'error')).toBe(true)
  })

  it('probes once, before the first request, and again after a failed probe', async () => {
    let down = true
    const ok = fakeServer()
    const calls: string[] = []
    const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new URL(input instanceof Request ? input.url : String(input)).pathname)
      if (down) throw new TypeError('fetch failed')
      return ok.base(input, init)
    }) as typeof fetch
    const f = localModelFetch(ollamaRoute, base)
    await expect(f(chat, { method: 'POST' })).rejects.toThrow(/isn't answering/)
    down = false // the person started Ollama
    await f(chat, { method: 'POST' })
    await f(chat, { method: 'POST' })
    expect(calls).toEqual(['/v1/models', '/v1/models', '/api/show', '/api/generate', '/api/ps', '/v1/chat/completions', '/v1/chat/completions'])
  })

  it("turns the server's failures into sentences and passes other answers through", async () => {
    const noTools = fakeServer({
      chat: { status: 400, body: JSON.stringify({ error: { message: 'registry.ollama.ai/library/gemma:2b does not support tools', type: 'api_error' } }) },
    })
    await expect(localModelFetch(ollamaRoute, noTools.base)(chat, { method: 'POST' })).rejects.toThrow(/can't call tools/)
    const gone = fakeServer({ chat: { status: 404, body: JSON.stringify({ error: { message: 'model "gpt-oss:20b" not found, try pulling it first' } }) } })
    await expect(localModelFetch(ollamaRoute, gone.base)(chat, { method: 'POST' })).rejects.toThrow(/isn't available/)
    const other = fakeServer({ chat: { status: 500, body: 'boom' } })
    const res = await localModelFetch(ollamaRoute, other.base)(chat, { method: 'POST' })
    expect(res.status).toBe(500) // the provider reports it with the status and body
    expect(await res.text()).toBe('boom')
  })

  it('reads the context again after a "too long" answer: a server that reloaded the model with less', async () => {
    // LM Studio unloaded the idle model and loaded it again at its default: first 65536, then 40960, then 8192.
    let loaded = 65536
    const tooLong = JSON.stringify({ error: 'The number of tokens to keep from the initial prompt is greater than the context length' })
    const calls: string[] = []
    const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      calls.push(url.pathname)
      if (url.pathname === '/v1/models') return Response.json({ data: [{ id: 'qwen3-8b' }] })
      if (url.pathname.startsWith('/api/v0/models/')) return Response.json({ capabilities: ['tool_use'], loaded_context_length: loaded })
      return new Response(tooLong, { status: 400 })
    }) as typeof fetch
    const env = { LOCAL_AGENT_LOCAL_MODEL_BASE_URL: 'http://127.0.0.1:1234/v1', LOCAL_AGENT_LOCAL_MODEL_ID: 'qwen3-8b', LOCAL_AGENT_LOCAL_MODEL_SERVER: 'lmstudio' }
    const f = localModelFetch(lmRoute, base)
    expect(await resolveLocalAgentContextWindow(env, base)).toBe(65536)
    loaded = 40960
    await expect(f(`${lmRoute.baseURL}/chat/completions`, { method: 'POST' })).rejects.toThrow(/no longer fits/)
    expect(localAgentContextWindow(env)).toBe(40960) // eve compacts at what it has now
    expect(calls.filter((c) => c === '/v1/models')).toHaveLength(2) // one probe, then one more after the answer
    loaded = 8192
    await expect(f(`${lmRoute.baseURL}/chat/completions`, { method: 'POST' })).rejects.toThrow(/LM Studio loaded qwen3-8b with only 8192 tokens/)
  })

  it('lets an abort through as is, so eve can cancel a turn', async () => {
    const ok = fakeServer()
    const abort = new DOMException('The operation was aborted.', 'AbortError')
    const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input instanceof Request ? input.url : input).endsWith('/chat/completions')) throw abort
      return ok.base(input, init)
    }) as typeof fetch
    await expect(localModelFetch(ollamaRoute, base)(chat, { method: 'POST' })).rejects.toBe(abort)
  })

  it('a request aborted while the probe is still running returns at once, and the probe stays shared', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const ok = fakeServer()
    const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input instanceof Request ? input.url : input).endsWith('/v1/models')) await gate // a slow server
      return ok.base(input, init)
    }) as typeof fetch
    const f = localModelFetch(ollamaRoute, base)
    const controller = new AbortController()
    const first = f(`${OLLAMA}/chat/completions`, { method: 'POST', signal: controller.signal })
    controller.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    release()
    const res = await f(`${OLLAMA}/chat/completions`, { method: 'POST' })
    expect(res.ok).toBe(true)
  })
})

describe('describeLocalModelFailure', () => {
  it.each([
    [400, '{"error":{"message":"registry.ollama.ai/library/llama2 does not support tools"}}', /can't call tools/],
    [400, '{"error":"Tools are not supported for this model"}', /can't call tools/],
    [400, '{"error":"The number of tokens to keep from the initial prompt is greater than the context length"}', /no longer fits/],
    [404, '{"error":"model not found"}', /isn't available/],
    [400, '{"error":"model \\"qwen3\\" not found, try pulling it first"}', /isn't available/],
    [400, '{"error":"No models loaded. Please load a model in the developer page"}', /isn't available/],
    [400, '{"error":"model qwen2.5-7b-instruct not found"}', /isn't available/],
    [400, '{"error":"Model llama3.1:8b is not loaded"}', /isn't available/],
  ])('%i %s', async (status, body, expected) => {
    expect(await describeLocalModelFailure(ollamaRoute, new Response(body, { status }))).toMatch(expected)
  })

  it('names a missing model with a dot in its id (LM Studio says it by id)', async () => {
    const dotted = { ...lmRoute, modelId: 'qwen2.5-7b-instruct' }
    expect(await describeLocalModelFailure(dotted, new Response('{"error":"Failed to load: qwen2.5-7b-instruct was not loaded. Load it first."}', { status: 400 }))).toMatch(/qwen2\.5-7b-instruct isn't available/)
  })

  it('leaves other failures to the provider, a stray "not found" included', async () => {
    expect(await describeLocalModelFailure(ollamaRoute, new Response('{"error":"rate limited"}', { status: 429 }))).toBeNull()
    expect(await describeLocalModelFailure(ollamaRoute, new Response('{"error":"template file not found"}', { status: 500 }))).toBeNull()
    expect(await describeLocalModelFailure(ollamaRoute, new Response('{"error":"the model called tool \'grep\', which was not found"}', { status: 400 }))).toBeNull()
  })
})

describe('createLocalAgentModel and the context window: a model on this Mac', () => {
  it('builds an OpenAI-compatible LanguageModel for the local model', () => {
    expect(createLocalAgentModel(LOCAL_ENV)).toMatchObject({ provider: 'local.chat', modelId: 'gpt-oss:20b', specificationVersion: 'v4' })
  })

  it("compacts at the context the probe read, at the floor before it ran, else at the Gateway window", async () => {
    expect(localAgentContextWindow({})).toBe(LOCAL_AGENT_CONTEXT_WINDOW)
    const env = { ...LOCAL_ENV, LOCAL_AGENT_LOCAL_MODEL_ID: 'llama-unprobed:8b' }
    expect(localAgentContextWindow(env)).toBe(MIN_LOCAL_MODEL_CONTEXT)
    await probeLocalModel({ ...ollamaRoute, modelId: 'llama-unprobed:8b' }, fakeServer({ models: ['llama-unprobed:8b'], loaded: 98304 }).base)
    expect(localAgentContextWindow(env)).toBe(98304)
  })

  it('resolves the window after the probe, sharing it with the first model request, so even step one compacts at the real context', async () => {
    expect(await resolveLocalAgentContextWindow({})).toBe(LOCAL_AGENT_CONTEXT_WINDOW)
    const env = { ...LOCAL_ENV, LOCAL_AGENT_LOCAL_MODEL_ID: 'llama-shared:8b' }
    const server = fakeServer({ models: ['llama-shared:8b'], loaded: 49152 })
    const [window] = await Promise.all([resolveLocalAgentContextWindow(env, server.base), localModelFetch({ ...ollamaRoute, modelId: 'llama-shared:8b' }, server.base)(`${OLLAMA}/chat/completions`, { method: 'POST' })])
    expect(window).toBe(49152)
    expect(paths(server.calls).filter((p) => p === 'GET /v1/models')).toHaveLength(1) // one probe for both
    expect(localAgentContextWindow(env)).toBe(49152)
    // A refused model fails here, before eve compacts anything, with the probe's sentence.
    await expect(resolveLocalAgentContextWindow({ ...env, LOCAL_AGENT_LOCAL_MODEL_ID: 'gone:8b' }, server.base)).rejects.toThrow(/gone:8b isn't available/)
  })
})
