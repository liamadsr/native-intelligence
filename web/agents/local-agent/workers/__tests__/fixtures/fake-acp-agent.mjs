#!/usr/bin/env node
// A stand-in ACP agent for the worker tests: newline-delimited JSON-RPC on
// stdio, the way a real agent's ACP adapter speaks it. Node built-ins only: in
// the e2e test it runs under the worker's real Seatbelt profile.
//
// What it advertises: by its path (installed as the `codex-acp` package it
// takes no HTTP MCP server, no system prompt and no session/resume, only
// session/load; otherwise all of them), overridden by FAKE_ACP_HTTP,
// FAKE_ACP_SYSTEM_PROMPT, FAKE_ACP_RESUME and FAKE_ACP_LOAD ('1' / '0').
// Not signed in: FAKE_ACP_SIGNED_OUT=1, or a `<cli>.signed-out` file next to
// its CLI. Every request it gets is logged as a JSON line to FAKE_ACP_LOG
// (else $HOME/fake-acp.log).
//
// What a prompt does, by a word in it: PROBE <json ops>, TOOLS, PERMISSION,
// SLOW, REFUSE, NOFINISH, ASK, AUTHFAIL, WAIT, FINISH2; anything else is echoed back
// and finished (FAKE_ACP_IGNORE_NUDGE=1: the `finish` nudge is answered without one).
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'

const env = process.env
const codexLike = /codex-acp/.test(process.argv[1])
const flag = (name, dflt) => (env[name] === undefined ? dflt : env[name] === '1')
const caps = {
  http: flag('FAKE_ACP_HTTP', !codexLike),
  systemPrompt: flag('FAKE_ACP_SYSTEM_PROMPT', !codexLike),
  resume: flag('FAKE_ACP_RESUME', !codexLike),
  load: flag('FAKE_ACP_LOAD', true),
}
const cli = env.CLAUDE_CODE_EXECUTABLE || env.CODEX_PATH || ''
const signedOut = env.FAKE_ACP_SIGNED_OUT === '1' || (cli && existsSync(`${cli}.signed-out`))
const logFile = env.FAKE_ACP_LOG || `${env.HOME}/fake-acp.log`
const MODES = ['read-only', 'agent-full-access']

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`)
const update = (sessionId, u) => out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } })
const say = (sessionId, text, messageId) => update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, ...(messageId ? { messageId } : {}) })
const AUTH = { code: -32000, message: 'Authentication required' }

let nextId = 1000
const waiting = new Map()
function ask(method, params) {
  const id = nextId++
  out({ jsonrpc: '2.0', id, method, params })
  return new Promise((resolve) => waiting.set(id, resolve))
}

const sessions = new Map() // id -> { mcp, mode, cancel }

// ── The manager tools, over the MCP server the client handed us ──
async function mcpClient(server) {
  if (server.type === 'http') {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
    for (const h of server.headers) headers[h.name] = h.value
    let id = 1
    const rpc = async (method, params) => (await (await fetch(server.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }) })).json()).result
    await rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'fake-acp' }, capabilities: {} })
    return { call: (name, args) => rpc('tools/call', { name, arguments: args }), list: () => rpc('tools/list', {}), transport: 'http' }
  }
  const child = spawn(server.command, server.args, { env: { ...Object.fromEntries(server.env.map((e) => [e.name, e.value])), PATH: env.PATH }, stdio: ['pipe', 'pipe', 'inherit'] })
  const pending = new Map()
  let buf = ''
  child.stdout.setEncoding('utf8').on('data', (d) => {
    buf += d
    for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
      const msg = JSON.parse(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
      pending.get(msg.id)?.(msg.result ?? { error: msg.error })
      pending.delete(msg.id)
    }
  })
  let id = 1
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const n = id++
      pending.set(n, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`)
    })
  await rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'fake-acp' }, capabilities: {} })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  return { call: (name, args) => rpc('tools/call', { name, arguments: args }), list: () => rpc('tools/list', {}), transport: 'stdio' }
}
const clients = new Map()
function tools(sessionId) {
  if (!clients.has(sessionId)) clients.set(sessionId, mcpClient(sessions.get(sessionId).mcp))
  return clients.get(sessionId)
}

// ── What a probe can try, each answered with what happened ──
async function op(o, sessionId) {
  try {
    if (o.read !== undefined) return `read ${readFileSync(o.read).length} bytes`
    if (o.write !== undefined) return writeFileSync(o.write, o.content ?? 'x'), 'wrote'
    if (o.replace !== undefined) return unlinkSync(o.replace), writeFileSync(o.replace, o.content ?? 'x'), 'replaced'
    if (o.list !== undefined) return `listed ${readdirSync(o.list).length}`
    if (o.exec !== undefined) return `exec: ${execFileSync(o.exec[0], o.exec.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()}`
    if (o.connect !== undefined) {
      return await new Promise((resolve) => {
        const s = connect({ host: o.host ?? '127.0.0.1', port: o.connect })
        s.setTimeout(2000, () => (s.destroy(), resolve('timeout')))
        s.once('connect', () => (s.destroy(), resolve('connected')))
        s.once('error', (e) => resolve(e.code))
      })
    }
    if (o.env !== undefined) return `env ${o.env}=${env[o.env] ?? ''}`
    if (o.listen !== undefined) {
      return await new Promise((resolve) => {
        const srv = createServer()
        srv.once('error', (e) => resolve(e.code))
        srv.listen(0, o.listen, () => srv.close(() => resolve('listening')))
      })
    }
    if (o.tool !== undefined) {
      // A workspace tool on the same MCP server as the manager's: its answer as the agent sees it.
      const r = await (await tools(sessionId)).call(o.tool, o.args ?? {})
      return `${r.isError ? 'error' : 'ok'}: ${r.content?.[0]?.text ?? JSON.stringify(r.error ?? r)}`
    }
    if (o.toolsList) return `tools: ${((await (await tools(sessionId)).list()).tools ?? []).map((t) => t.name).join(',')}`
    if (o.server) {
      // A server the agent leaves running: a child process listening on loopback, which a stop must end.
      const child = spawn(process.execPath, ['-e', "require('net').createServer().listen(0, '127.0.0.1', () => console.log('up'))"], { stdio: ['ignore', 'pipe', 'ignore'] })
      await new Promise((r) => child.stdout.once('data', r))
      return `server ${child.pid}`
    }
    if (o.spawn) {
      // A child that leaves the agent's process group, and one that stays: both must die with the job.
      const away = spawn('/bin/sleep', ['60'], { detached: true, stdio: 'ignore' })
      const near = spawn('/bin/sleep', ['60'], { stdio: 'ignore' })
      away.unref()
      return `pids ${away.pid} ${near.pid}`
    }
    if (o.cwd) return `cwd ${process.cwd()}`
    return 'unknown op'
  } catch (e) {
    return e.code ?? `status ${e.status}`
  }
}

async function prompt(sessionId, text) {
  const s = sessions.get(sessionId)
  if (text.includes('AUTHFAIL')) return { error: AUTH }
  if (text.includes('PROBE')) {
    const ops = JSON.parse(text.slice(text.indexOf('PROBE') + 5).trim().split('\n')[0])
    const results = []
    for (const o of ops) results.push(await op(o, sessionId))
    say(sessionId, JSON.stringify(results))
    const t = await tools(sessionId)
    await t.call('report', { text: `probed over ${t.transport}` })
    await t.call('finish', { summary: 'Probed.' })
    return { stopReason: 'end_turn' }
  }
  if (text.includes('TOOLS')) {
    say(sessionId, 'Looking. ', 'm1')
    update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } })
    update(sessionId, { sessionUpdate: 'plan', entries: [] })
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Edit big.txt', kind: 'edit', status: 'pending', rawInput: { path: 'big.txt', text: 'y'.repeat(10_000) } })
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'in_progress' })
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', content: [{ type: 'diff', path: '/x/big.txt', oldText: null, newText: 'z'.repeat(200_000) }, { type: 'terminal', terminalId: 't1' }] })
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed' }) // a repeat: one result only
    // Its input only in a later update, as Claude Code sends it.
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call-3', title: 'Terminal', kind: 'execute', status: 'pending', rawInput: {} })
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-3', title: 'Run ls', status: 'in_progress', rawInput: { command: 'ls' } })
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-3', status: 'completed', rawOutput: { exit: 0 } })
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call-2', title: 'Run false', kind: 'execute', status: 'failed', rawInput: { command: 'false' }, content: [{ type: 'content', content: { type: 'text', text: 'exit 1' } }] })
    update(sessionId, { sessionUpdate: 'usage_update', used: 1, size: 2 })
    say(sessionId, 'Done ', 'm2')
    say(sessionId, 'w'.repeat(100_000), 'm2')
    await (await tools(sessionId)).call('finish', { summary: 'Tools done.' })
    return { stopReason: 'end_turn' }
  }
  if (text.includes('PERMISSION')) {
    const res = await ask('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 'call-p', title: 'Write a.txt' },
      options: [
        { optionId: 'no', name: 'No', kind: 'reject_once' },
        { optionId: 'always', name: 'Always', kind: 'allow_always' },
        { optionId: 'once', name: 'Once', kind: 'allow_once' },
      ],
    })
    say(sessionId, `picked ${res.result?.outcome?.optionId ?? res.error?.message}`)
    await (await tools(sessionId)).call('finish', { summary: 'Asked.' })
    return { stopReason: 'end_turn' }
  }
  if (text.includes('SLOW')) {
    say(sessionId, 'working')
    await new Promise((resolve) => (s.cancel = resolve))
    return { stopReason: 'cancelled' }
  }
  if (text.includes('REFUSE')) return { stopReason: 'refusal' }
  if (text.includes('FINISHPR')) {
    // finish with a pull request (twice with FINISHPR2: the second is ignored), then a last word.
    const t = await tools(sessionId)
    const r = await t.call('finish', { summary: 'Fixed the flaky test.', pull_request: { title: 'Fix the flaky test', body: 'It waited on a timer.' } })
    if (text.includes('FINISHPR2')) await t.call('finish', { summary: 'Again.', pull_request: { title: 'Again' } })
    say(sessionId, `tool said: ${r.content[0].text}`)
    return { stopReason: 'end_turn' }
  }
  if (text.includes('FINISH2')) {
    // finish early and twice, then keep working: the desktop must see it once, after the turn.
    const t = await tools(sessionId)
    await t.call('finish', { summary: 'First finish.' })
    await t.call('finish', { summary: 'Second finish.' })
    await new Promise((r) => setTimeout(r, 300))
    say(sessionId, 'still writing')
    return { stopReason: 'end_turn' }
  }
  if (text.includes('ended without a call to `finish`')) {
    if (env.FAKE_ACP_IGNORE_NUDGE === '1') return say(sessionId, 'Still not done.'), { stopReason: 'end_turn' }
    say(sessionId, 'Finishing now.')
    await (await tools(sessionId)).call('finish', { summary: 'Finished after the nudge.' })
    return { stopReason: 'end_turn' }
  }
  if (text.includes('NOFINISH')) {
    say(sessionId, 'Did some of it.')
    return { stopReason: 'end_turn' }
  }
  if (text.includes('ASK')) {
    await (await tools(sessionId)).call('ask_manager', { question: 'Which branch?' })
    return { stopReason: 'end_turn' }
  }
  if (text.includes('WAIT')) await new Promise((r) => setTimeout(r, 400))
  say(sessionId, `got: ${text.split('\n').at(-1)} (mode ${s.mode ?? 'default'})`)
  await (await tools(sessionId)).call('finish', { summary: 'Done.' })
  return { stopReason: 'end_turn' }
}

async function handle(msg) {
  appendFileSync(logFile, `${JSON.stringify({ method: msg.method, params: msg.params })}\n`)
  const reply = (result) => out({ jsonrpc: '2.0', id: msg.id, result })
  const fail = (error) => out({ jsonrpc: '2.0', id: msg.id, error })
  const p = msg.params ?? {}
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: 1,
        agentInfo: { name: 'fake-acp', title: 'Fake', version: '9.9.9' },
        agentCapabilities: {
          loadSession: caps.load,
          mcpCapabilities: { http: caps.http, sse: false },
          sessionCapabilities: { ...(caps.resume ? { resume: {} } : {}), ...(caps.systemPrompt ? { systemPrompt: {} } : {}) },
        },
        authMethods: [],
      })
    case 'session/new': {
      if (signedOut) return fail(AUTH)
      const id = `sess-${Math.random().toString(36).slice(2, 10)}`
      sessions.set(id, { mcp: p.mcpServers[0] })
      return reply({ sessionId: id, modes: { currentModeId: 'read-only', availableModes: MODES.map((m) => ({ id: m, name: m })) } })
    }
    case 'session/resume':
    case 'session/load': {
      if (signedOut) return fail(AUTH)
      if (!String(p.sessionId).startsWith('sess-')) return fail({ code: -32002, message: 'Resource not found' })
      sessions.set(p.sessionId, { mcp: p.mcpServers[0] })
      if (msg.method === 'session/load') {
        update(p.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'an old request' } })
        say(p.sessionId, 'an old reply')
        update(p.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'old-1', title: 'Old tool', status: 'completed' })
      }
      return reply({})
    }
    case 'session/set_mode':
      if (!MODES.includes(p.modeId)) return fail({ code: -32602, message: `no mode ${p.modeId}` })
      sessions.get(p.sessionId).mode = p.modeId
      return reply({})
    case 'session/prompt': {
      const text = p.prompt.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
      const r = await prompt(p.sessionId, text)
      return r.error ? fail(r.error) : reply(r)
    }
    case 'session/cancel':
      sessions.get(p.sessionId)?.cancel?.()
      return
    default:
      if (msg.id !== undefined) fail({ code: -32601, message: `no method ${msg.method}` })
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
    if (msg.method === undefined && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg)
      waiting.delete(msg.id)
      continue
    }
    void handle(msg)
  }
})
process.stdin.on('end', () => process.exit(0))
