/**
 * A scripted stand-in for the app the Mac body reaches, for
 * `e2e-device.ts --fake-model`: the Dial8 model relay (`/api/local-agent/model/*`)
 * and C1's two routes (`GET /api/local-agent/agent/spec`, `POST .../tool`,
 * contract C1 in docs/plans/teammate-agent.md), on one origin as on the real
 * app. The whole device half runs with no model spend, so the script itself
 * can be iterated on. The real run uses the real model (the dev key) instead,
 * and has no session token, so no C1.
 *
 * C1 here is a stand-in, not WS-A's routes: the spec is fixed (C1_SPEC, the
 * Mac body's teammate tools from C4 plus one workspace read), and the tool
 * route records each call and answers a canned output. What the server does
 * with message_teammate (the open question, needs_input, the cloud body's
 * home turn) is WS-C's and not covered here.
 *
 * The "model" follows directives in the user messages, one tool call per
 * request, in a deterministic order:
 *
 *   @bash <command>          → bash {command}
 *   @report <text>           → report_to_person {text}   (C1)
 *   @ask <question>          → message_teammate {text}   (C1; ends the turn)
 *   @finish <summary>        → finish {summary}        (ends the turn; `\n` = a newline)
 *   @read <path>             → read_file {filePath}  (eve's write_file needs a read first)
 *   @write <path> :: <text>  → write_file {filePath, content}
 *   @say <text>              → plain text, ends the turn
 *
 * The newest user message goes first (a steer pre-empts the rest of the turn),
 * then older ones, each in order. A directive is done once a tool call this
 * stub emitted for it is in the prompt. With nothing left, it answers "Done."
 *
 * It also records what each request carried (path, model id, whether the
 * Bearer matched a token the fake server minted), never the token itself.
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

export const MODEL_PATH = '/api/local-agent/model/language-model'
export const C1_SPEC_PATH = '/api/local-agent/agent/spec'
export const C1_TOOL_PATH = '/api/local-agent/agent/tool'

/** The spec C1 sends the Mac body (the cloud ChatSpec, host 'mac'), cut to what the scripted runs use. */
export const C1_SPEC = {
  systemPrompt: 'You are the person’s Dial8 agent (the e2e stand-in for C1’s spec).',
  model: 'anthropic/claude-sonnet-5.5',
  ceiling: ['report_to_person', 'message_teammate', 'list_actions'],
  ceilingTools: [
    { name: 'report_to_person', description: 'A note for the person in this conversation.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    { name: 'message_teammate', description: 'A question for the Dial8 agent in the cloud; ends your turn.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    { name: 'list_actions', description: 'List the workspace actions.', inputSchema: { type: 'object', properties: {} } },
  ],
  coreToolNames: ['report_to_person', 'message_teammate', 'list_actions'],
  helpersAllowed: false,
  host: 'mac',
}

export interface C1RequestRecord {
  at: number
  route: 'spec' | 'tool'
  auth: ModelRequestRecord['auth']
  tokenGen: number | null
  /** A tool call's name, input and eve's ids. */
  toolName?: string
  input?: unknown
  ids?: { callId?: unknown; turnId?: unknown; sessionId?: unknown }
}

export interface ModelRequestRecord {
  at: number
  path: string
  modelId: string | null
  streaming: boolean
  /** The Bearer, classified by the fake server's token registry. */
  auth: 'current' | 'stale' | 'unknown' | 'missing'
  /** The token's generation (1 = the claim's, 2+ = refreshes), when known. */
  tokenGen: number | null
  tools: string[]
  emitted: string
}

export interface FakeModel {
  url: string
  origin: string
  requests: ModelRequestRecord[]
  /** C1 calls (spec and tool), in order. */
  c1: C1RequestRecord[]
  /** The tool input schemas seen on the first request (names → property keys). */
  toolSchemas: Record<string, string[]>
  close(): Promise<void>
}

interface Directive {
  key: string
  kind: 'bash' | 'report' | 'ask' | 'finish' | 'read' | 'write' | 'say'
  arg: string
}

type PromptPart = { type: string; text?: string; toolCallId?: string; toolName?: string }
type PromptMessage = { role: string; content: string | PromptPart[] }

function textOf(m: PromptMessage): string {
  if (typeof m.content === 'string') return m.content
  return m.content
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n')
}

export function parseDirectives(text: string, msgKey: string): Directive[] {
  const out: Directive[] = []
  let j = 0
  for (const raw of text.split('\n')) {
    const m = /^\s*@(bash|report|ask|finish|read|write|say)\s+(.+?)\s*$/.exec(raw)
    if (!m) continue
    out.push({ key: `${msgKey}:${j++}`, kind: m[1] as Directive['kind'], arg: m[2] })
  }
  return out
}

function sse(parts: unknown[]): string {
  return parts.map((p) => `data: ${JSON.stringify(p)}\n\n`).join('')
}

const USAGE = { inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 8, text: 8, reasoning: 0 } }

export async function startFakeModel(opts: {
  classifyToken: (token: string | null) => { auth: ModelRequestRecord['auth']; gen: number | null }
  latencyMs?: number
  log?: (line: string) => void
}): Promise<FakeModel> {
  const requests: ModelRequestRecord[] = []
  const c1: C1RequestRecord[] = []
  const toolSchemas: Record<string, string[]> = {}
  /** toolCallId → the directive it carried out. */
  const emittedFor = new Map<string, string>()
  /** Directives answered with plain text (no call id to find them by). */
  const said = new Set<string>()
  let callN = 0
  const latency = opts.latencyMs ?? 300

  function next(prompt: PromptMessage[]): Directive | null {
    const done = new Set<string>(said)
    for (const m of prompt) {
      if (m.role !== 'assistant' || typeof m.content === 'string') continue
      for (const p of m.content) {
        if (p.type === 'tool-call' && p.toolCallId && emittedFor.has(p.toolCallId)) done.add(emittedFor.get(p.toolCallId)!)
      }
    }
    // Key each user message by its text and how many times that text came before.
    const seen = new Map<string, number>()
    const perMessage: Directive[][] = []
    for (const m of prompt) {
      if (m.role !== 'user') continue
      const text = textOf(m)
      const h = createHash('sha1').update(text).digest('hex').slice(0, 12)
      const n = seen.get(h) ?? 0
      seen.set(h, n + 1)
      perMessage.push(parseDirectives(text, `${h}.${n}`))
    }
    for (let i = perMessage.length - 1; i >= 0; i--) {
      const d = perMessage[i].find((x) => !done.has(x.key))
      if (d) return d
    }
    return null
  }

  function respond(body: Record<string, unknown>, streaming: boolean): { payload: string; emitted: string } {
    const prompt = Array.isArray(body.prompt) ? (body.prompt as PromptMessage[]) : []
    const d = next(prompt)
    const textParts = (id: string, text: string) => [
      { type: 'text-start', id },
      { type: 'text-delta', id, delta: text },
      { type: 'text-end', id },
    ]
    if (!streaming) {
      // A non-streaming call (eve's own housekeeping, if any): a short text.
      const json = { content: [{ type: 'text', text: 'Summary.' }], finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE, warnings: [] }
      return { payload: JSON.stringify(json), emitted: 'text(generate)' }
    }
    if (!d || d.kind === 'say') {
      if (d) said.add(d.key)
      const text = d ? d.arg : 'Done.'
      return {
        payload: sse([
          { type: 'stream-start', warnings: [] },
          ...textParts('t0', text),
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE, providerMetadata: { gateway: { cost: '0' } } },
        ]),
        emitted: d ? `say` : 'done',
      }
    }
    const id = `call_fake_${++callN}`
    emittedFor.set(id, d.key)
    let toolName: string
    let input: Record<string, unknown>
    let say: string
    switch (d.kind) {
      case 'bash':
        toolName = 'bash'
        input = { command: d.arg }
        say = `Running \`${d.arg}\`.`
        break
      case 'report':
        toolName = 'report_to_person'
        input = { text: d.arg }
        say = 'A progress note.'
        break
      case 'ask':
        toolName = 'message_teammate'
        input = { text: d.arg }
        say = 'I need to ask my teammate.'
        break
      case 'finish':
        toolName = 'finish'
        input = { summary: d.arg.replace(/\\n/g, '\n') }
        say = 'Finishing.'
        break
      case 'read':
        toolName = 'read_file'
        input = { filePath: d.arg }
        say = `Reading ${d.arg}.`
        break
      case 'write': {
        const [path, ...rest] = d.arg.split(' :: ')
        toolName = 'write_file'
        input = { filePath: path.trim(), content: rest.join(' :: ').replace(/\\n/g, '\n') }
        say = `Writing ${path.trim()}.`
        break
      }
    }
    return {
      payload: sse([
        { type: 'stream-start', warnings: [] },
        ...textParts(`t${callN}`, say),
        { type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage: USAGE, providerMetadata: { gateway: { cost: '0' } } },
      ]),
      emitted: `${toolName}`,
    }
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Uint8Array[] = []
    req.on('data', (c: Buffer) => chunks.push(new Uint8Array(c.buffer, c.byteOffset, c.byteLength)))
    req.on('end', () => {
      const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : null
      const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null
      const cls = opts.classifyToken(bearer)
      const modelId = typeof req.headers['ai-language-model-id'] === 'string' ? req.headers['ai-language-model-id'] : null
      const streaming = req.headers['ai-language-model-streaming'] !== 'false'
      const route = req.method === 'GET' && req.url?.startsWith(`${C1_SPEC_PATH}?`) ? 'spec' : req.method === 'POST' && req.url === C1_TOOL_PATH ? 'tool' : null
      if (route) {
        // C1 (the stand-in): the same token check as the relay, then a fixed spec or a canned tool output.
        const rec: C1RequestRecord = { at: Date.now(), route, auth: cls.auth, tokenGen: cls.gen }
        if (route === 'tool') {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
            Object.assign(rec, { toolName: body.toolName, input: body.input, ids: { callId: body.callId, turnId: body.turnId, sessionId: body.sessionId } })
          } catch {
            // recorded without a body
          }
        }
        c1.push(rec)
        opts.log?.(`[fake-c1] ${route}${rec.toolName ? ` ${String(rec.toolName)}` : ''} (${cls.auth})`)
        if (cls.auth !== 'current') {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end('{"error":"Invalid model token"}')
          return
        }
        const output = rec.toolName === 'message_teammate' ? { status: 'sent', note: 'Your teammate answers as your next message.' } : rec.toolName === 'report_to_person' ? { status: 'posted' } : { actions: [] }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(route === 'spec' ? C1_SPEC : { output }))
        return
      }
      if (req.method !== 'POST' || req.url !== MODEL_PATH) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"error":{"message":"not here"}}')
        return
      }
      if (cls.auth !== 'current') {
        requests.push({ at: Date.now(), path: req.url, modelId, streaming, auth: cls.auth, tokenGen: cls.gen, tools: [], emitted: 'refused' })
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end('{"error":{"message":"bad model token","type":"authentication_error"}}')
        return
      }
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      } catch {
        // an empty body: answer anyway
      }
      const tools = Array.isArray(body.tools) ? (body.tools as Array<{ name?: string; inputSchema?: { properties?: Record<string, unknown> } }>) : []
      if (Object.keys(toolSchemas).length === 0) {
        for (const t of tools) if (t.name) toolSchemas[t.name] = Object.keys(t.inputSchema?.properties ?? {})
      }
      const { payload, emitted } = respond(body, streaming)
      requests.push({ at: Date.now(), path: req.url, modelId, streaming, auth: cls.auth, tokenGen: cls.gen, tools: tools.map((t) => t.name ?? '?'), emitted })
      opts.log?.(`[fake-model] #${requests.length} ${emitted}`)
      setTimeout(() => {
        res.writeHead(200, { 'content-type': streaming ? 'text/event-stream' : 'application/json' })
        res.end(payload)
      }, latency)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return {
    origin: `http://127.0.0.1:${port}`,
    url: `http://127.0.0.1:${port}/api/local-agent/model`,
    requests,
    c1,
    toolSchemas,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
