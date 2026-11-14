#!/usr/bin/env node
// A stand-in for Claude Code's CLI in print mode with stream-json in and out,
// the shapes Claude Code 2.1.311 writes (lib/claude-stream.ts). `--version`
// prints a version line. Every launch's argv, and every stdin line, are
// logged (fake-common.mjs logger: `fake-claude.log`). Sessions are files in
// $HOME/fake-claude-sessions, so a later launch can resume one and an unknown
// id fails the way the real CLI does: before reading anything.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { env, logger, mcpClient, options, turn } from './fake-common.mjs'

const args = process.argv.slice(2)
if (args[0] === '--version') {
  process.stdout.write('9.9.9 (Claude Code)\n')
  process.exit(0)
}
const opts = options()
const log = logger('fake-claude')
log({ argv: args })
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`)

const sessions = `${env.HOME}/fake-claude-sessions`
mkdirSync(sessions, { recursive: true })
const resumed = flag('--resume')
const sessionId = resumed ?? flag('--session-id')
if (resumed && !existsSync(`${sessions}/${resumed}`)) {
  process.stderr.write(`No conversation found with session ID: ${resumed}\n`)
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, stop_reason: null, session_id: resumed })
  process.exit(1)
}
writeFileSync(`${sessions}/${sessionId}`, '')
const mcp = Object.entries(JSON.parse(flag('--mcp-config') ?? '{"mcpServers":{}}').mcpServers).map(([name, s]) => ({ name, ...s }))
let client = null
const tools = () => (client ??= mcpClient(mcp[0]))

let cancel = () => {}
process.on('SIGINT', () => {
  // The real CLI ends the turn; this one ends the process, the harder case for the driver.
  cancel()
  process.exit(130)
})

let n = 0
const io = {
  tools,
  say(text, id) {
    const messageId = `msg-${n}-${id}`
    out({ type: 'stream_event', parent_tool_use_id: null, session_id: sessionId, event: { type: 'message_start', message: { id: messageId } } })
    out({ type: 'stream_event', parent_tool_use_id: null, session_id: sessionId, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })
    // The whole message after its deltas: never shown twice.
    out({ type: 'assistant', parent_tool_use_id: null, session_id: sessionId, message: { id: messageId, role: 'assistant', content: [{ type: 'text', text }] } })
  },
  tool(id, name, input) {
    out({ type: 'assistant', parent_tool_use_id: null, session_id: sessionId, message: { id: `msg-${n}-${id}`, role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', id, name, input }] } })
  },
  result(id, _name, ok, output) {
    out({ type: 'user', parent_tool_use_id: null, session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: output }], ...(ok ? {} : { is_error: true }) }] } })
  },
  subagent() {
    // A sub-agent's own steps: not the top-level agent's, so not shown.
    out({ type: 'stream_event', parent_tool_use_id: 'task-1', session_id: sessionId, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'SUBAGENT' } } })
    out({ type: 'assistant', parent_tool_use_id: 'task-1', session_id: sessionId, message: { id: 'sub', content: [{ type: 'text', text: 'SUBAGENT' }, { type: 'tool_use', id: 'sub-1', name: 'Read', input: {} }] } })
  },
}

async function onUser(text) {
  n += 1
  out({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(), claude_code_version: '9.9.9', mcp_servers: mcp.map((s) => ({ name: s.name, status: opts.mcp === 'failed' ? 'failed' : 'connected' })) })
  if (opts.signedOut) {
    out({ type: 'assistant', parent_tool_use_id: null, session_id: sessionId, error: 'authentication_failed', is_api_error_message: true, message: { id: `synthetic-${n}`, model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } })
    return out({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', stop_reason: 'stop_sequence', session_id: sessionId })
  }
  const r = await turn(text, { ...io, cancelled: new Promise((resolve) => (cancel = resolve)) }, opts)
  if (r.error) {
    if (r.auth) out({ type: 'assistant', parent_tool_use_id: null, session_id: sessionId, error: 'authentication_failed', message: { id: `synthetic-${n}`, content: [{ type: 'text', text: r.error }] } })
    return out({ type: 'result', subtype: r.auth ? 'success' : 'error_during_execution', is_error: true, ...(r.auth ? { result: r.error } : { errors: [r.error] }), session_id: sessionId })
  }
  if (r.stop === 'max_turns') return out({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id: sessionId })
  out({ type: 'rate_limit_event', rate_limit_info: {} })
  out({ type: 'result', subtype: 'success', is_error: false, stop_reason: r.stop, result: '', session_id: sessionId })
}

let chain = Promise.resolve()
let buf = ''
process.stdin.setEncoding('utf8').on('data', (d) => {
  buf += d
  for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    log({ stdin: msg })
    if (msg.type === 'control_request') {
      if (opts.noHandshake) continue
      const account = opts.signedOut ? { tokenSource: 'none', apiProvider: 'firstParty' } : { email: 'person@example.com', subscriptionType: 'Claude Pro', apiProvider: 'firstParty' }
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { claude_code_version: '9.9.9', account } } })
      continue
    }
    if (msg.type === 'user') {
      const text = msg.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
      chain = chain.then(() => onUser(text))
    }
  }
})
process.stdin.on('end', () => chain.then(() => process.exit(0)))
