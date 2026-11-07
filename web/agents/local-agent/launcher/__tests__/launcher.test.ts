/**
 * The launcher's protocol pieces, without a model or a server: stdin parsing,
 * the dotenv key reader, event normalization over recorded-shape eve events,
 * and the job driver's stream handling against a scripted fake session.
 */
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import type { MessageStreamEvent } from 'eve/client'
import {
  INPUT_LIMIT,
  JobDriver,
  MODEL_TOKEN_FILE,
  OUTPUT_LIMIT,
  type OutboundMessage,
  acquireJobLock,
  apiOriginFromEnv,
  c1OriginRefusal,
  createLineSplitter,
  createNormalizer,
  deliveryIdOf,
  descendants,
  grantEnvRefusal,
  hostMarkerRefusal,
  killJobProcesses,
  localModelBaseUrl,
  modelLaunchFromEnv,
  parseInbound,
  readGatewayKey,
  relayBaseUrl,
  serializeLine,
  truncateJson,
  writeModelToken,
} from '../launcher'

let n = 0
/** A stamped eve event, shaped like the ones eve 0.79.1 writes (see the smoke log). */
function ev(type: string, data: Record<string, unknown> = {}, deliveryIds?: string[]): MessageStreamEvent {
  n += 1
  return {
    type,
    data: { sequence: n, turnId: 'turn_1', stepIndex: 0, ...data },
    meta: { id: `evt_${String(n).padStart(6, '0')}`, at: '2026-10-20T00:00:00.000Z', ...(deliveryIds ? { deliveryIds } : {}) },
  } as unknown as MessageStreamEvent
}

const call = (callId: string, toolName: string, input: Record<string, unknown>) => ({ kind: 'tool-call', callId, toolName, input })
const result = (callId: string, toolName: string, output: unknown, status = 'completed', isError?: boolean) =>
  ev('action.result', { status, result: { kind: 'tool-result', callId, toolName, output, ...(isError ? { isError } : {}) } })

/** One recorded-shape turn: narration, a bash call, a teammate tool (C4), finish, then the boundary. */
function recordedTurn(deliveryIds = ['dlv_1']): MessageStreamEvent[] {
  return [
    ev('session.started', { sessionId: 'wrun_1' }),
    ev('turn.started', {}, deliveryIds),
    ev('message.received', { message: 'list the files' }, deliveryIds),
    ev('step.started', {}, deliveryIds),
    ev('message.appended', { messageDelta: 'Let me ' }, deliveryIds),
    ev('message.appended', { messageDelta: 'look.' }, deliveryIds),
    ev('message.completed', { message: 'Let me look.', finishReason: 'tool-calls' }, deliveryIds),
    ev('actions.requested', { actions: [call('c1', 'bash', { command: 'ls' }), call('c2', 'report_to_person', { text: 'Listing files' })] }, deliveryIds),
    result('c1', 'bash', { status: 'completed', exitCode: 0, stdout: 'README.md\n', stderr: '' }),
    result('c2', 'report_to_person', { ok: true }),
    ev('actions.requested', { actions: [call('c3', 'finish', { summary: 'One file: README.md' })] }, deliveryIds),
    result('c3', 'finish', { ok: true }),
    ev('step.completed', { finishReason: 'tool-calls' }, deliveryIds),
    ev('turn.completed', {}, deliveryIds),
    ev('session.waiting', { wait: 'next-user-message' }, deliveryIds),
  ]
}

describe('parseInbound', () => {
  it.each([
    ['{"type":"start","request":"do it"}', { type: 'start', request: 'do it' }],
    ['{"type":"resume","sessionId":"wrun_1","streamIndex":12}', { type: 'resume', sessionId: 'wrun_1', streamIndex: 12 }],
    ['{"type":"send","text":"also X","policy":"steer"}', { type: 'send', text: 'also X', policy: 'steer' }],
    ['{"type":"send","text":"later","policy":"queue"}', { type: 'send', text: 'later', policy: 'queue' }],
    ['{"type":"stop"}', { type: 'stop' }],
    ['{"type":"token","modelToken":"v1.eyJzaWQiOiJ4In0.c2ln-_"}', { type: 'token', modelToken: 'v1.eyJzaWQiOiJ4In0.c2ln-_' }],
  ])('%s', (line, expected) => {
    expect(parseInbound(line)).toEqual(expected)
  })

  it.each([
    'not json',
    '[]',
    '{"type":"start"}',
    '{"type":"start","request":"  "}',
    '{"type":"resume","sessionId":"wrun_1","streamIndex":-1}',
    '{"type":"resume","sessionId":"wrun_1","streamIndex":1.5}',
    '{"type":"send","text":"x","policy":"interrupt"}',
    '{"type":"exec","command":"rm -rf /"}',
    '{"type":"token"}',
    '{"type":"token","modelToken":"short"}',
    '{"type":"token","modelToken":"has a space 0123456789abc"}',
    '{"type":"token","modelToken":"line\\nbreak-0123456789abc"}',
    `{"type":"token","modelToken":"${'x'.repeat(2049)}"}`,
    '{"type":"token","modelToken":12345678901234567890}',
  ])('rejects %s', (line) => {
    expect(parseInbound(line)).toBeNull()
  })
})

describe('readGatewayKey', () => {
  it('reads only AI_GATEWAY_API_KEY, in any common dotenv form', () => {
    expect(readGatewayKey('A=1\nAI_GATEWAY_API_KEY=abc123\nB=2')).toBe('abc123')
    expect(readGatewayKey('export AI_GATEWAY_API_KEY="q u"')).toBe('q u')
    expect(readGatewayKey("AI_GATEWAY_API_KEY='sq'")).toBe('sq')
    expect(readGatewayKey('AI_GATEWAY_API_KEY=v # comment')).toBe('v')
    expect(readGatewayKey('# AI_GATEWAY_API_KEY=commented\nOTHER=x')).toBeUndefined()
    expect(readGatewayKey('AI_GATEWAY_API_KEY=')).toBeUndefined()
    expect(readGatewayKey('NOT_AI_GATEWAY_API_KEY=x')).toBeUndefined()
  })
})

describe('the model launch (relay, a local model, or dev)', () => {
  const token = 'v1.eyJzaWQiOiJ4In0.c2lnbmF0dXJl'
  it('is the dev path with neither variable, the relay with both', () => {
    expect(modelLaunchFromEnv({})).toEqual({ kind: 'dev' })
    expect(modelLaunchFromEnv({ LOCAL_AGENT_MODEL_BASE_URL: 'http://localhost:3000/api/local-agent/model/', LOCAL_AGENT_MODEL_TOKEN: token })).toEqual({
      kind: 'relay',
      baseURL: 'http://localhost:3000/api/local-agent/model',
      token,
    })
  })

  it('refuses one without the other, a non-https base and a malformed token', () => {
    expect(() => modelLaunchFromEnv({ LOCAL_AGENT_MODEL_TOKEN: token })).toThrow(/set together/)
    expect(() => modelLaunchFromEnv({ LOCAL_AGENT_MODEL_BASE_URL: 'https://dial8.ai/m' })).toThrow(/set together/)
    expect(() => modelLaunchFromEnv({ LOCAL_AGENT_MODEL_BASE_URL: 'http://dial8.ai/m', LOCAL_AGENT_MODEL_TOKEN: token })).toThrow(/https/)
    expect(() => modelLaunchFromEnv({ LOCAL_AGENT_MODEL_BASE_URL: 'https://dial8.ai/m', LOCAL_AGENT_MODEL_TOKEN: 'a b' })).toThrow(/not a model token/)
  })

  it('is a local model with the LOCAL_AGENT_LOCAL_MODEL_* pair; the session token then serves C1 only', () => {
    const local = { LOCAL_AGENT_LOCAL_MODEL_BASE_URL: 'http://127.0.0.1:11434/v1/', LOCAL_AGENT_LOCAL_MODEL_ID: 'llama3.1:8b', LOCAL_AGENT_LOCAL_MODEL_SERVER: 'ollama' }
    expect(modelLaunchFromEnv({ ...local, LOCAL_AGENT_MODEL_TOKEN: token })).toEqual({
      kind: 'local',
      local: { baseURL: 'http://127.0.0.1:11434/v1', id: 'llama3.1:8b', server: 'ollama' },
      token,
    })
    expect(modelLaunchFromEnv({ LOCAL_AGENT_LOCAL_MODEL_BASE_URL: 'http://[::1]:1234/v1', LOCAL_AGENT_LOCAL_MODEL_ID: 'qwen3' })).toEqual({
      kind: 'local',
      local: { baseURL: 'http://[::1]:1234/v1', id: 'qwen3' },
      token: null,
    })
    // The context is the model server's (lib/model.ts probes it): a context variable is neither checked nor passed on.
    expect(modelLaunchFromEnv({ ...local, LOCAL_AGENT_LOCAL_MODEL_CONTEXT: '1024' })).toEqual(modelLaunchFromEnv(local))
  })

  it('a local-model run never falls back: no relay URL, no dev key, both halves, loopback only', () => {
    const local = { LOCAL_AGENT_LOCAL_MODEL_BASE_URL: 'http://127.0.0.1:11434/v1', LOCAL_AGENT_LOCAL_MODEL_ID: 'llama3.1:8b' }
    expect(() => modelLaunchFromEnv({ LOCAL_AGENT_LOCAL_MODEL_ID: 'x' })).toThrow(/set together/)
    expect(() => modelLaunchFromEnv({ LOCAL_AGENT_LOCAL_MODEL_BASE_URL: 'http://127.0.0.1:11434/v1' })).toThrow(/set together/)
    expect(() => modelLaunchFromEnv({ ...local, LOCAL_AGENT_MODEL_BASE_URL: 'https://dial8.ai/api/local-agent/model', LOCAL_AGENT_MODEL_TOKEN: token })).toThrow(/never has LOCAL_AGENT_MODEL_BASE_URL/)
    expect(() => modelLaunchFromEnv({ ...local, LOCAL_AGENT_DEV_ENV_FILE: '/tmp/.env.local' })).toThrow(/never has LOCAL_AGENT_DEV_ENV_FILE/)
    expect(() => modelLaunchFromEnv({ ...local, LOCAL_AGENT_LOCAL_MODEL_BASE_URL: 'http://192.168.1.4:11434/v1' })).toThrow(/loopback/)
    expect(() => modelLaunchFromEnv({ ...local, LOCAL_AGENT_LOCAL_MODEL_ID: 'has space' })).toThrow(/model id/)
    expect(() => modelLaunchFromEnv({ ...local, LOCAL_AGENT_LOCAL_MODEL_SERVER: 'vllm' })).toThrow(/ollama or lmstudio/)
    expect(() => modelLaunchFromEnv({ ...local, LOCAL_AGENT_MODEL_TOKEN: 'a b' })).toThrow(/not a model token/)
    // The same rule as lib/model.ts: 127.0.0.1 or [::1] only (not localhost, which a hosts file can point anywhere).
    for (const bad of ['https://example.com/v1', 'http://localhost:11434/v1', 'http://u:p@127.0.0.1/v1', 'http://127.0.0.1:11434/v1?x=1', 'file:///tmp']) expect(localModelBaseUrl(bad)).toBeNull()
  })

  it('takes LOCAL_AGENT_API_ORIGIN as an origin only, and the same one as the relay (C1)', () => {
    expect(apiOriginFromEnv({})).toBeNull()
    expect(apiOriginFromEnv({ LOCAL_AGENT_API_ORIGIN: 'https://dial8.ai' })).toBe('https://dial8.ai')
    expect(apiOriginFromEnv({ LOCAL_AGENT_API_ORIGIN: 'http://127.0.0.1:3001/' })).toBe('http://127.0.0.1:3001')
    expect(apiOriginFromEnv({ LOCAL_AGENT_API_ORIGIN: 'http://localhost:3000' })).toBe('http://localhost:3000')
    expect(apiOriginFromEnv({ LOCAL_AGENT_API_ORIGIN: 'https://dial8.ai', LOCAL_AGENT_MODEL_BASE_URL: 'https://dial8.ai/api/local-agent/model' })).toBe('https://dial8.ai')
    for (const bad of ['https://dial8.ai/api', 'http://dial8.ai', 'http://10.0.0.2:3000', 'https://u:p@dial8.ai', 'nope']) expect(() => apiOriginFromEnv({ LOCAL_AGENT_API_ORIGIN: bad })).toThrow(/origin/)
    expect(() => apiOriginFromEnv({ LOCAL_AGENT_API_ORIGIN: 'https://dial8.ai', LOCAL_AGENT_MODEL_BASE_URL: 'https://other.test/api/local-agent/model' })).toThrow(/different origins/)
  })

  it('refuses a local-model run whose session token has no origin to reach (C1)', () => {
    const local = (token: string | null) => ({ kind: 'local', local: { baseURL: 'http://127.0.0.1:11434/v1', id: 'qwen3' }, token }) as const
    expect(c1OriginRefusal(local(token), null)).toMatch(/needs LOCAL_AGENT_API_ORIGIN/)
    expect(c1OriginRefusal(local(token), 'https://dial8.ai')).toBeNull()
    expect(c1OriginRefusal(local(null), null)).toBeNull()
    expect(c1OriginRefusal({ kind: 'relay', baseURL: 'https://dial8.ai/api/local-agent/model', token }, null)).toBeNull()
    expect(c1OriginRefusal({ kind: 'dev' }, null)).toBeNull()
  })

  it('runs only the Mac build, and a local model only on a build that has one', () => {
    const relay = { kind: 'relay', baseURL: 'https://dial8.ai/api/local-agent/model', token } as const
    const local = { kind: 'local', local: { baseURL: 'http://127.0.0.1:11434/v1', id: 'qwen3' }, token: null } as const
    expect(hostMarkerRefusal({ host: 'mac', localModel: false }, relay)).toBeNull()
    expect(hostMarkerRefusal({ host: 'mac', localModel: true }, local)).toBeNull()
    expect(hostMarkerRefusal({ host: 'mac', localModel: false }, local)).toMatch(/cannot run a model on this Mac/)
    for (const bad of [null, undefined, 'mac', {}, { host: 'cloud' }]) expect(hostMarkerRefusal(bad, relay)).toMatch(/not the Mac body/)
  })

  it('accepts https anywhere and http to loopback only', () => {
    expect(relayBaseUrl('https://dial8.ai/api/local-agent/model')).toBe('https://dial8.ai/api/local-agent/model')
    expect(relayBaseUrl('http://[::1]:3000/m')).toBe('http://[::1]:3000/m')
    for (const bad of ['http://10.0.0.1/m', 'https://u:p@dial8.ai/m', 'https://dial8.ai/m?x=1', 'ftp://dial8.ai/m']) expect(relayBaseUrl(bad)).toBeNull()
  })

  it('writes the token file 0600 and atomically, overwriting the old token and leaving no temp file', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'la-token-test-')))
    try {
      const file = writeModelToken(dir, token)
      expect(file).toBe(join(dir, MODEL_TOKEN_FILE))
      expect(readFileSync(file, 'utf8')).toBe(token)
      expect(statSync(file).mode & 0o777).toBe(0o600)
      writeModelToken(dir, `${token}-renewed`)
      expect(readFileSync(file, 'utf8')).toBe(`${token}-renewed`)
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(readdirSync(dir)).toEqual([MODEL_TOKEN_FILE])
      expect(() => writeModelToken(dir, 'bad token')).toThrow()
      expect(readFileSync(file, 'utf8')).toBe(`${token}-renewed`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('grantEnvRefusal', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'la-grant-env-test-')))
  const gitDir = join(root, 'repo', '.git')
  mkdirSync(gitDir, { recursive: true })
  writeFileSync(join(root, 'repo', 'file.git'), '')
  const job = join(root, 'jobs', 'j1')
  const wt = join(root, 'worktrees', 'j1')
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('allows read mode, and edit mode with the repository .git', () => {
    expect(grantEnvRefusal({ LOCAL_AGENT_MODE: 'read', LOCAL_AGENT_FOLDER: join(root, 'repo') }, job)).toBeNull()
    expect(grantEnvRefusal({ LOCAL_AGENT_MODE: 'edit', LOCAL_AGENT_FOLDER: wt, LOCAL_AGENT_EXTRA_READ: gitDir }, job)).toBeNull()
  })

  it.each([
    ['an unknown mode', { LOCAL_AGENT_MODE: 'write', LOCAL_AGENT_FOLDER: wt }, /unsupported mode/],
    ['edit without the git dir', { LOCAL_AGENT_MODE: 'edit', LOCAL_AGENT_FOLDER: wt }, /needs LOCAL_AGENT_EXTRA_READ/],
    ['an extra read root in read mode', { LOCAL_AGENT_MODE: 'read', LOCAL_AGENT_FOLDER: wt, LOCAL_AGENT_EXTRA_READ: gitDir }, /only allowed in edit mode/],
    ['an extra read root not named .git', { LOCAL_AGENT_MODE: 'edit', LOCAL_AGENT_FOLDER: wt, LOCAL_AGENT_EXTRA_READ: join(root, 'repo') }, /named \.git/],
    ['a missing .git', { LOCAL_AGENT_MODE: 'edit', LOCAL_AGENT_FOLDER: wt, LOCAL_AGENT_EXTRA_READ: join(root, 'other', '.git') }, /named \.git/],
    ['a relative .git', { LOCAL_AGENT_MODE: 'edit', LOCAL_AGENT_FOLDER: wt, LOCAL_AGENT_EXTRA_READ: 'repo/.git' }, /named \.git/],
    ['a job dir inside the folder', { LOCAL_AGENT_MODE: 'read', LOCAL_AGENT_FOLDER: join(root, 'jobs') }, /overlap/],
    ['a job dir inside the git dir', { LOCAL_AGENT_MODE: 'edit', LOCAL_AGENT_FOLDER: wt, LOCAL_AGENT_EXTRA_READ: gitDir }, /overlap/, join(gitDir, 'j')],
  ])('refuses %s', (_label, env, why, jobDir = job) => {
    expect(grantEnvRefusal(env, jobDir)).toMatch(why)
  })
})

describe('truncateJson', () => {
  it('keeps short values whole and cuts long ones to the limit', () => {
    expect(truncateJson({ a: 1 }, 100)).toBe('{"a":1}')
    const long = truncateJson({ s: 'x'.repeat(10_000) }, OUTPUT_LIMIT)
    expect(long).toHaveLength(OUTPUT_LIMIT)
    expect(long.endsWith('…')).toBe(true)
    expect(truncateJson(undefined, 10)).toBe('null')
  })
})

describe('createNormalizer', () => {
  it('maps a recorded turn: finish becomes ONLY its own event, the teammate tools stay tool events', () => {
    const normalize = createNormalizer()
    const out = recordedTurn().flatMap(normalize)
    expect(out).toEqual([
      { kind: 'status', status: 'starting' },
      { kind: 'status', status: 'running' },
      { kind: 'text', delta: 'Let me ' },
      { kind: 'text', delta: 'look.' },
      { kind: 'message', text: 'Let me look.' },
      { kind: 'tool', callId: 'c1', name: 'bash', input: '{"command":"ls"}' },
      { kind: 'tool', callId: 'c2', name: 'report_to_person', input: '{"text":"Listing files"}' },
      { kind: 'tool_result', callId: 'c1', name: 'bash', ok: true, output: '{"status":"completed","exitCode":0,"stdout":"README.md\\n","stderr":""}' },
      { kind: 'tool_result', callId: 'c2', name: 'report_to_person', ok: true, output: '{"ok":true}' },
      { kind: 'finish', summary: 'One file: README.md' },
      { kind: 'status', status: 'waiting' },
    ])
    for (const e of out) {
      if (e.kind === 'tool' || e.kind === 'tool_result') expect(e.name).not.toBe('finish')
    }
  })

  it('maps message_teammate to ordinary tool events (the server writes the thread, C4), never ask', () => {
    const normalize = createNormalizer()
    expect(normalize(ev('actions.requested', { actions: [call('c9', 'message_teammate', { text: 'Which branch?' })] }))).toEqual([
      { kind: 'tool', callId: 'c9', name: 'message_teammate', input: '{"text":"Which branch?"}' },
    ])
    expect(normalize(result('c9', 'message_teammate', { ok: true }))).toEqual([
      { kind: 'tool_result', callId: 'c9', name: 'message_teammate', ok: true, output: '{"ok":true}' },
    ])
  })

  it('marks failed tool results and truncates input (2 KB) and output (4 KB)', () => {
    const normalize = createNormalizer()
    const [tool] = normalize(ev('actions.requested', { actions: [call('c1', 'read_file', { filePath: 'x'.repeat(5000) })] }))
    expect(tool).toMatchObject({ kind: 'tool', name: 'read_file' })
    expect((tool as { input: string }).input).toHaveLength(INPUT_LIMIT)
    const [failed] = normalize(ev('action.result', { status: 'failed', error: { code: 'TOOL_ERROR', message: '/workspace/../x is outside the granted folder' }, result: { kind: 'tool-result', callId: 'c1', toolName: 'read_file', output: { error: 'y'.repeat(9000) }, isError: true } }))
    expect(failed).toMatchObject({ kind: 'tool_result', callId: 'c1', name: 'read_file', ok: false })
    expect((failed as { output: string }).output).toHaveLength(OUTPUT_LIMIT)
    const [bashFail] = normalize(result('c2', 'bash', { exitCode: 1 }, 'completed', true))
    expect(bashFail).toMatchObject({ ok: false })
  })

  it('keeps cancelled through the session.waiting that follows a cancel', () => {
    const normalize = createNormalizer()
    expect(normalize(ev('turn.cancelled'))).toEqual([{ kind: 'status', status: 'cancelled' }])
    expect(normalize(ev('session.waiting'))).toEqual([])
    expect(normalize(ev('turn.started'))).toEqual([{ kind: 'status', status: 'running' }])
    expect(normalize(ev('session.waiting'))).toEqual([{ kind: 'status', status: 'waiting' }])
  })

  it('maps failures, input requests and the terminal outcomes', () => {
    const normalize = createNormalizer()
    expect(normalize(ev('turn.failed', { code: 'MODEL_CALL_FAILED', message: 'boom', terminal: false }))).toEqual([{ kind: 'error', message: 'boom' }])
    expect(normalize(ev('session.failed', { code: 'X', message: 'dead', sessionId: 's' }))).toEqual([
      { kind: 'error', message: 'dead' },
      { kind: 'status', status: 'failed' },
    ])
    expect(normalize(ev('input.requested', { requests: [{ requestId: 'r', kind: 'session-limit', prompt: 'Keep going?' }] }))).toEqual([{ kind: 'ask', question: 'Keep going?' }])
    expect(normalize(ev('turn.waiting', { on: 'input' }))).toEqual([{ kind: 'status', status: 'waiting' }])
    expect(normalize(ev('turn.waiting', { on: 'tasks' }))).toEqual([])
    expect(normalize(ev('session.completed'))).toEqual([{ kind: 'status', status: 'completed' }])
    expect(normalize(ev('reasoning.appended', { reasoningDelta: 'hmm' }))).toEqual([])
  })
})

// ── The driver against a scripted fake session ───────────────────────────────

const DELIVERY = Symbol('acceptedDeliveryId')
const fakeResponse = (id: string) => ({ [DELIVERY]: id })

/** A fake eve session: a growing event log and a following stream from the handle's cursor. */
function fakeSession() {
  const log: MessageStreamEvent[] = []
  const waiters: (() => void)[] = []
  const state = { sessionId: 'wrun_fake', streamIndex: 0 }
  const sends: { text: string; policy?: string }[] = []
  let nextDelivery = 2
  const push = (...events: MessageStreamEvent[]) => {
    log.push(...events)
    waiters.splice(0).forEach((w) => w())
  }
  const session = {
    get state() {
      return { ...state }
    },
    async *stream(opts: { signal?: AbortSignal; follow?: boolean } = {}) {
      for (;;) {
        while (state.streamIndex < log.length) {
          const e = log[state.streamIndex]
          state.streamIndex += 1
          yield e
        }
        if (opts.follow === false || opts.signal?.aborted) return
        await new Promise<void>((r) => {
          waiters.push(r)
          opts.signal?.addEventListener('abort', () => r(), { once: true })
        })
        if (opts.signal?.aborted) return
      }
    },
    async send(text: string, o: { turnPolicy?: string }) {
      sends.push({ text, policy: o.turnPolicy })
      return fakeResponse(`dlv_${nextDelivery++}`)
    },
    async cancel() {
      return { status: 'accepted' }
    },
  }
  const setCursor = (i: number) => {
    state.streamIndex = i
  }
  return { session, push, sends, log, setCursor }
}

function harness() {
  const fake = fakeSession()
  const out: OutboundMessage[] = []
  const client = {
    sessions: {
      create: async () => ({ session: fake.session, response: fakeResponse('dlv_1') }),
      attach: (_id: string, o: { streamIndex: number }) => {
        fake.setCursor(o.streamIndex)
        return fake.session
      },
    },
  }
  const driver = new JobDriver(client as never, { write: (m) => out.push(m), log: () => {} })
  const events = () => out.filter((m) => m.type === 'event').map((m) => (m as { event: { kind: string } }).event)
  return { fake, out, driver, events }
}

const tick = () => new Promise((r) => setTimeout(r, 10))

describe('JobDriver', () => {
  it('reads the delivery id eve keeps on a response', () => {
    expect(deliveryIdOf(fakeResponse('dlv_9'))).toBe('dlv_9')
    expect(deliveryIdOf({})).toBeUndefined()
  })

  it('start: emits session, streams the turn, sends a cursor at the boundary and stops reading there', async () => {
    const h = harness()
    await h.driver.start('list the files')
    expect(h.out[1]).toEqual({ type: 'session', sessionId: 'wrun_fake', streamIndex: 0 })
    h.fake.push(...recordedTurn(['dlv_1']))
    await tick()
    const cursors = h.out.filter((m) => m.type === 'cursor')
    expect(cursors).toEqual([{ type: 'cursor', streamIndex: 15 }])
    expect(h.events().map((e) => e.kind)).toEqual(['status', 'status', 'status', 'text', 'text', 'message', 'tool', 'tool', 'tool_result', 'tool_result', 'finish', 'status'])
    // Nothing is read past the boundary until a new message.
    h.fake.push(ev('turn.started', {}, ['dlv_x']))
    await tick()
    expect(h.events().at(-1)).toEqual({ kind: 'status', status: 'waiting' })
  })

  it('dedupes replayed events on meta.id', () => {
    const h = harness()
    h.driver.session = h.fake.session as never
    const e = ev('message.appended', { messageDelta: 'once' })
    h.driver.ingest(e)
    h.driver.ingest(e)
    expect(h.events()).toEqual([{ kind: 'text', delta: 'once' }])
  })

  it('a message sent while idle starts a new pump that reads its turn', async () => {
    const h = harness()
    await h.driver.start('first')
    h.fake.push(...recordedTurn(['dlv_1']))
    await tick()
    await h.driver.send('and the follow-up?', 'steer')
    h.fake.push(ev('turn.started', {}, ['dlv_2']), ev('message.received', { message: 'and the follow-up?' }, ['dlv_2']), ev('message.completed', { message: 'Answer.', finishReason: 'stop' }, ['dlv_2']), ev('session.waiting', {}, ['dlv_2']))
    await tick()
    expect(h.events().slice(-3)).toEqual([
      { kind: 'status', status: 'running' },
      { kind: 'message', text: 'Answer.' },
      { kind: 'status', status: 'waiting' },
    ])
    expect(h.fake.sends).toEqual([{ text: 'and the follow-up?', policy: 'steer' }])
  })

  it('a queued message keeps the pump reading through the first boundary into its own turn', async () => {
    const h = harness()
    await h.driver.start('first')
    h.fake.push(ev('turn.started', {}, ['dlv_1']), ev('message.received', {}, ['dlv_1']))
    await tick()
    await h.driver.send('after that, count them', 'queue')
    h.fake.push(ev('turn.completed', {}, ['dlv_1']), ev('session.waiting', {}, ['dlv_1']))
    await tick()
    h.fake.push(ev('turn.started', {}, ['dlv_2']), ev('message.received', {}, ['dlv_2']), ev('message.completed', { message: 'Two.', finishReason: 'stop' }, ['dlv_2']), ev('session.waiting', {}, ['dlv_2']))
    await tick()
    expect(h.events().filter((e) => e.kind === 'message')).toEqual([{ kind: 'message', text: 'Two.' }])
    expect(h.out.filter((m) => m.type === 'cursor')).toHaveLength(2)
  })

  it('resume: an idle session reports waiting; a turn that ran on past the cursor is followed', async () => {
    const idle = harness()
    idle.fake.push(...recordedTurn(['dlv_1']))
    await idle.driver.resume('wrun_fake', 15)
    expect(idle.out[0]).toEqual({ type: 'session', sessionId: 'wrun_fake', streamIndex: 15 })
    expect(idle.events()).toEqual([{ kind: 'status', status: 'waiting' }])

    const busy = harness()
    const turn = recordedTurn(['dlv_1'])
    busy.fake.push(...turn.slice(0, 6))
    await busy.driver.resume('wrun_fake', 0)
    expect(busy.events().at(-1)).toEqual({ kind: 'status', status: 'running' })
    busy.fake.push(...turn.slice(6))
    await tick()
    expect(busy.events().at(-1)).toEqual({ kind: 'status', status: 'waiting' })
  })

  it('stop: cancels the running turn, drains to its boundary, ends with cancelled', async () => {
    const h = harness()
    await h.driver.start('long job')
    h.fake.push(ev('turn.started', {}, ['dlv_1']), ev('message.received', {}, ['dlv_1']))
    await tick()
    const stopping = h.driver.stop(1000)
    await tick()
    h.fake.push(ev('turn.cancelled', {}, ['dlv_1']), ev('session.waiting', {}, ['dlv_1']))
    await stopping
    const statuses = h.events().filter((e) => e.kind === 'status')
    expect(statuses.at(-1)).toEqual({ kind: 'status', status: 'cancelled' })
    expect(statuses.filter((s) => (s as unknown as { status: string }).status === 'cancelled')).toHaveLength(1)
    expect(h.out.at(-1)).toEqual({ type: 'cursor', streamIndex: 4 })
  })

  it('stop while idle still reports cancelled', async () => {
    const h = harness()
    h.fake.push(...recordedTurn(['dlv_1']))
    await h.driver.resume('wrun_fake', 15)
    await h.driver.stop(500)
    expect(h.events().at(-1)).toEqual({ kind: 'status', status: 'cancelled' })
  })
})

// ── Framing, terminal outcomes, the job lock, quitting ───────────────────────

describe('line framing', () => {
  it('splits on \\n only, so U+2028/U+2029 inside a message stay in it', () => {
    const lines: string[] = []
    const split = createLineSplitter((l) => lines.push(l))
    const msg = JSON.stringify({ type: 'send', text: 'a\u2028b\u2029c', policy: 'steer' })
    const bytes = new TextEncoder().encode(`${msg}\n{"type":"stop"}\r\n`)
    // Feed byte by byte: a multi-byte character split across chunks stays whole.
    for (const b of bytes) split.push(new Uint8Array([b]))
    split.end()
    expect(lines).toEqual([msg, '{"type":"stop"}'])
    expect(parseInbound(lines[0])).toEqual({ type: 'send', text: 'a\u2028b\u2029c', policy: 'steer' })
  })

  it('flushes a last line with no newline at EOF', () => {
    const lines: string[] = []
    const split = createLineSplitter((l) => lines.push(l))
    split.push(new TextEncoder().encode('{"type":"stop"}'))
    split.end()
    expect(lines).toEqual(['{"type":"stop"}'])
  })

  it('escapes U+2028/U+2029 in output lines, which stay valid JSON', () => {
    const line = serializeLine({ type: 'event', event: { kind: 'text', delta: 'x\u2028y\u2029z' } })
    expect(line).not.toMatch(/[\u2028\u2029]/)
    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.parse(line)).toEqual({ type: 'event', event: { kind: 'text', delta: 'x\u2028y\u2029z' } })
  })
})

describe('terminal outcomes and idle resume', () => {
  it('reports session.completed / session.failed to the launcher so it exits', () => {
    const terminal: [string, string][] = []
    const d = new JobDriver({} as never, { write: () => {}, log: () => {}, terminal: (s, m) => terminal.push([s, m]) })
    d.ingest(ev('session.failed', { code: 'X', message: 'dead', sessionId: 's' }))
    d.ingest(ev('session.completed'))
    expect(terminal).toEqual([
      ['failed', 'dead'],
      ['completed', 'the session completed'],
    ])
  })

  it('a resume whose replay ends on a cancelled turn still reports waiting', async () => {
    const h = harness()
    h.fake.push(ev('turn.started', {}, ['dlv_1']), ev('turn.cancelled', {}, ['dlv_1']), ev('session.waiting', {}, ['dlv_1']))
    await h.driver.resume('wrun_fake', 0)
    expect(h.events()).toEqual([
      { kind: 'status', status: 'running' },
      { kind: 'status', status: 'cancelled' },
      { kind: 'status', status: 'waiting' },
    ])
  })
})

describe('the job lock', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'la-lock-test-')))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it.runIf(process.platform === 'darwin')('is exclusive and released on close', () => {
    const fd = acquireJobLock(dir)
    expect(fd).not.toBeNull()
    expect(acquireJobLock(dir)).toBeNull()
    closeSync(fd!)
    const again = acquireJobLock(dir)
    expect(again).not.toBeNull()
    closeSync(again!)
  })

  it.runIf(process.platform === 'darwin')('a second launcher in the same job dir refuses with "job already running"', async () => {
    const fd = acquireJobLock(dir)!
    try {
      // Cast: Next's global types make ProcessEnv require NODE_ENV, which the launcher never gets.
      const child = spawn(process.execPath, [LAUNCHER], { cwd: dir, env: { PATH: '/usr/bin:/bin' } as Record<string, string> as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'ignore'] })
      let out = ''
      child.stdout.on('data', (d) => (out += d))
      const code = await new Promise((r) => child.once('exit', r))
      expect(code).not.toBe(0)
      expect(out.trim()).toBe('{"type":"fatal","message":"job already running"}')
    } finally {
      closeSync(fd)
    }
  })
})

describe('quitting kills what the job left running', () => {
  it('finds descendants and their groups, never its own group', () => {
    const rows = [
      { pid: 10, ppid: 1, pgid: 10 }, // launcher
      { pid: 11, ppid: 10, pgid: 10 }, // server, in the launcher's group
      { pid: 12, ppid: 11, pgid: 12 }, // a sandboxed command group
      { pid: 13, ppid: 12, pgid: 12 },
      { pid: 14, ppid: 13, pgid: 14 }, // eve's background job, still parented
      { pid: 20, ppid: 1, pgid: 20 }, // unrelated
    ]
    expect(descendants(rows, 11, 10)).toEqual({ pids: [12, 13, 14], groups: [12, 14] })
  })

  it.runIf(process.platform === 'darwin')('a long-running tool command (sleep 600) does not survive; a group a pid file names is never killed', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'la-quit-test-')))
    const jobs = join(root, 'dial8-local-agent', 'wrun_quit', 'tmp', '.eve', 'jobs')
    mkdirSync(join(jobs, 'j1'), { recursive: true })
    // A stand-in for the eve server with one detached command group (as the
    // sandbox runs), and an unrelated process group outside its tree that an
    // eve job pid file names: sandboxed commands can write those files, so the
    // launcher must not act on them (the sandbox's reaper stops its own jobs).
    const bystander = spawn('/bin/sleep', ['600'], { detached: true, stdio: 'ignore' })
    writeFileSync(join(jobs, 'j1', 'pid'), String(bystander.pid))
    const script = `
      const { spawn } = require('node:child_process')
      const cmd = spawn('/bin/sleep', ['600'], { detached: true, stdio: 'ignore' })
      console.log(cmd.pid)
      setInterval(() => {}, 1000)
    `
    const fake = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] })
    try {
      const cmdPid = Number.parseInt(await new Promise<string>((r) => fake.stdout.once('data', (d) => r(String(d)))), 10)
      expect(isAlive(cmdPid) && isAlive(bystander.pid!)).toBe(true)
      killJobProcesses(fake.pid)
      await until(() => !isAlive(cmdPid))
      expect(isAlive(bystander.pid!)).toBe(true)
    } finally {
      fake.kill('SIGKILL')
      bystander.kill('SIGKILL')
      rmSync(root, { recursive: true, force: true })
    }
  })
})

const LAUNCHER = fileURLToPath(new URL('../launcher.ts', import.meta.url))

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}
