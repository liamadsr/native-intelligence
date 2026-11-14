#!/usr/bin/env node
// A stand-in for Codex's CLI: `--version`, and `app-server` speaking line
// JSON-RPC without the "jsonrpc" member, the shapes Codex 0.169.0 writes
// (lib/codex-app-server.ts). Every request is logged (fake-common.mjs logger:
// `fake-codex.log`). Threads are files in $HOME/fake-codex-threads, so a later
// launch can resume one. With the `old` option it behaves like Codex 0.34.0,
// which has no app-server: the word becomes a prompt for its terminal UI, which
// fails without a terminal; with `crash`, like a current one that fails at its
// start.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { env, logger, mcpClient, options, turn } from './fake-common.mjs'

const args = process.argv.slice(2)
if (args[0] === '--version') {
  process.stdout.write('codex-cli 9.9.9\n')
  process.exit(0)
}
const opts = options()
if (args[0] === 'app-server' && args[1] === '--help') {
  // An old Codex prints its main help (no app-server in it); a current one its app-server help.
  process.stdout.write(opts.old ? 'Codex CLI\n\nUsage: codex [OPTIONS] [PROMPT]\n' : 'Run the app server\n\nUsage: codex app-server [OPTIONS] [COMMAND]\n')
  process.exit(0)
}
if (args[0] === 'app-server' && opts.crash) {
  process.stderr.write('Error: failed to initialize sqlite state runtime\n')
  process.exit(1)
}
if (args[0] !== 'app-server' || opts.old) {
  process.stdout.write('\x1b[?2004h')
  process.stderr.write('Error: Device not configured (os error 6)\n')
  process.exit(1)
}
const log = logger('fake-codex')
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`)
const notify = (method, params) => out({ method, params })
const threads = `${env.HOME}/fake-codex-threads`
mkdirSync(threads, { recursive: true })

let nextId = 1000
const waiting = new Map()
function ask(method, params) {
  const id = nextId++
  out({ id, method, params })
  return new Promise((resolve) => waiting.set(id, resolve))
}

let threadId = null
let mcp = null
let client = null
const tools = () => (client ??= mcpClient(mcp))
let cancel = () => {}
let current = null

async function connectMcp() {
  notify('mcpServer/startupStatus/updated', { threadId, name: 'ni', status: 'starting', error: null })
  try {
    if (opts.mcp === 'failed') throw new Error('handshaking with MCP server failed')
    await tools()
    notify('mcpServer/startupStatus/updated', { threadId, name: 'ni', status: 'ready', error: null })
  } catch (e) {
    client = null
    notify('mcpServer/startupStatus/updated', { threadId, name: 'ni', status: 'failed', error: `MCP client for \`ni\` failed to start: ${e.message}` })
  }
}

function setThread(p) {
  const server = p.config?.mcp_servers?.ni
  mcp = server ? { url: server.url, headers: server.http_headers ?? {} } : null
}

async function runTurn(turnId, text) {
  const item = (type, extra) => ({ type, ...extra })
  const io = {
    tools,
    cancelled: new Promise((resolve) => (cancel = resolve)),
    say(t, id) {
      const itemId = `${turnId}-${id}`
      notify('item/started', { threadId, turnId, item: item('agentMessage', { id: itemId, text: '' }) })
      notify('item/agentMessage/delta', { threadId, turnId, itemId, delta: t })
      notify('item/completed', { threadId, turnId, item: item('agentMessage', { id: itemId, text: t }) })
    },
    tool(id, name, input) {
      const it = name === 'Bash' ? item('commandExecution', { id, command: input.command, cwd: process.cwd(), status: 'inProgress', aggregatedOutput: null, exitCode: null }) : item('fileChange', { id, changes: [{ path: input.path, kind: { type: 'add' }, diff: '' }], status: 'inProgress' })
      current = it
      notify('item/started', { threadId, turnId, item: it })
    },
    result(id, name, ok, output) {
      const it = name === 'Bash' ? { ...current, status: 'completed', aggregatedOutput: output, exitCode: ok ? 0 : 1 } : { ...current, status: ok ? 'completed' : 'failed', changes: [{ ...current.changes[0], diff: output }] }
      notify('item/completed', { threadId, turnId, item: it })
    },
    subagent() {
      notify('item/agentMessage/delta', { threadId: 'another-thread', turnId: 'x', itemId: 'x', delta: 'SUBAGENT' })
      notify('item/completed', { threadId, turnId, item: item('reasoning', { id: 'r1', summary: ['thinking'], content: [] }) })
      notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: {} })
    },
    async approval() {
      const a = await ask('item/commandExecution/requestApproval', { threadId, turnId, itemId: 'c1', command: 'rm -rf build', reason: 'cleanup' })
      const b = await ask('item/tool/requestUserInput', { threadId, turnId, itemId: 'q1', questions: [] })
      return [a.result ?? a.error, b.result ?? b.error]
    },
  }
  // An MCP tool call of our own server shows as an item too.
  const r = await turn(text, io, opts)
  const done = (status, error = null) => notify('turn/completed', { threadId, turn: { id: turnId, items: [], status, error } })
  if (r.error) return done('failed', { message: r.auth ? 'unexpected status 401 Unauthorized' : r.error, codexErrorInfo: r.auth ? 'unauthorized' : 'other', additionalDetails: null })
  if (r.stop === 'cancelled') return done('interrupted')
  if (r.stop === 'refusal') return done('failed', { message: 'The model refused.', codexErrorInfo: 'other', additionalDetails: null })
  done('completed')
}

async function handle(msg) {
  log({ method: msg.method, params: msg.params })
  const reply = (result) => out({ id: msg.id, result })
  const fail = (code, message) => out({ error: { code, message }, id: msg.id })
  const p = msg.params ?? {}
  switch (msg.method) {
    case 'initialize':
      return reply({ userAgent: 'native-intelligence/9.9.9 (Mac OS 27.2.0; arm64) unknown (native-intelligence; 1)', codexHome: `${env.HOME}/.codex`, platformFamily: 'unix', platformOs: 'macos' })
    case 'initialized':
      return
    case 'account/read':
      return reply(opts.signedOut ? { account: null, userId: null, requiresOpenaiAuth: true } : { account: { type: 'chatgpt', email: 'person@example.com', planType: 'plus' }, userId: 'u-1', requiresOpenaiAuth: true })
    case 'thread/start': {
      threadId = randomUUID()
      writeFileSync(`${threads}/${threadId}`, '')
      setThread(p)
      reply({ thread: { id: threadId, cwd: p.cwd }, model: 'fake', approvalPolicy: p.approvalPolicy, sandbox: p.sandbox })
      notify('thread/started', { thread: { id: threadId } })
      return connectMcp()
    }
    case 'thread/resume': {
      if (!existsSync(`${threads}/${p.threadId}`)) return fail(-32600, `no rollout found for thread id ${p.threadId}`)
      threadId = p.threadId
      setThread(p)
      reply({ thread: { id: threadId, turns: [] } })
      return connectMcp()
    }
    case 'turn/start': {
      const turnId = randomUUID()
      const text = p.input.filter((i) => i.type === 'text').map((i) => i.text).join('\n')
      reply({ turn: { id: turnId, items: [], status: 'inProgress', error: null } })
      notify('turn/started', { threadId, turn: { id: turnId } })
      return runTurn(turnId, text)
    }
    case 'turn/interrupt':
      reply({})
      return cancel()
    default:
      if (msg.id !== undefined) fail(-32601, `no method ${msg.method}`)
  }
}

let buf = ''
process.stdin.setEncoding('utf8').on('data', (d) => {
  buf += d
  for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    if ('jsonrpc' in msg) log({ unexpected: 'a jsonrpc member' })
    if (msg.method === undefined && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg)
      waiting.delete(msg.id)
      continue
    }
    void handle(msg)
  }
})
process.stdin.on('end', () => process.exit(0))
