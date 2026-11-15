// What the two stand-in CLIs (fake-claude.mjs, fake-codex.mjs) share: their
// options, a log of what they were asked, the probe operations a test can run
// inside the fence, an MCP client for the manager tools, and the scripted
// turns. Node built-ins only: in the e2e test they run under the worker's real
// Seatbelt profile.
//
// Options: JSON in FAKE_OPTS, merged over JSON in `<cli>.fake.json` beside the
// CLI (FAKE_CLI is the wrapper's own path; the fence passes no FAKE_OPTS):
//   signedOut       no login (each CLI says so its own way)
//   mcp             'failed': report our MCP server as failed
//   noHandshake     (Claude) never answer the initialize control request
//   old             (Codex) behave like a Codex with no app-server
//   crash           (Codex) exit at the start of app-server, as one that can't open its state
//   ignoreNudge     the finish nudge is answered without a finish
//
// What a turn does, by a word in its text: PROBE <json ops>, TOOLS, SLOW,
// REFUSE, MAXTURNS, FAIL, AUTHFAIL, NOFINISH, ASK, WAIT, FINISH2, FINISHPR,
// FINISHPR2, APPROVAL (Codex); anything else is echoed back and finished.
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'

export const env = process.env

export function options() {
  const file = env.FAKE_CLI ? `${env.FAKE_CLI}.fake.json` : null
  const fromFile = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  return { ...fromFile, ...(env.FAKE_OPTS ? JSON.parse(env.FAKE_OPTS) : {}) }
}

/** One JSON line per request, to FAKE_LOG (else $HOME/<name>.log). */
export function logger(name) {
  const file = env.FAKE_LOG || `${env.HOME}/${name}.log`
  return (entry) => appendFileSync(file, `${JSON.stringify(entry)}\n`)
}

/** The manager tools over the Streamable HTTP server the CLI was given. */
export async function mcpClient(server) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...server.headers }
  let id = 1
  const rpc = async (method, params) => {
    const res = await fetch(server.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()).result
  }
  await rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'fake-cli' }, capabilities: {} })
  return { call: (name, args) => rpc('tools/call', { name, arguments: args }), list: () => rpc('tools/list', {}) }
}

/** One probe operation, answered with what happened. */
async function op(o, tools) {
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
      const r = await (await tools()).call(o.tool, o.args ?? {})
      return `${r.isError ? 'error' : 'ok'}: ${r.content?.[0]?.text ?? JSON.stringify(r)}`
    }
    if (o.toolsList) return `tools: ${((await (await tools()).list()).tools ?? []).map((t) => t.name).join(',')}`
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
    if (o.argv) return `argv ${JSON.stringify(process.argv.slice(2))}`
    return 'unknown op'
  } catch (e) {
    return e.code ?? `status ${e.status}`
  }
}

/**
 * One scripted turn. `io` is the CLI's own wire: say(text, messageId),
 * tool(id, name, input), result(id, name, ok, output), subagent() (steps of a
 * sub-agent, which must not be shown), cancelled (a promise), approval() (Codex).
 * Answers `{ stop }` ('end_turn' | 'refusal' | 'max_turns' | 'cancelled') or
 * `{ error, auth? }`.
 */
export async function turn(text, io, opts) {
  const tools = io.tools
  if (text.includes('AUTHFAIL')) return { error: 'Not logged in · Please run /login', auth: true }
  if (text.includes('PROBE')) {
    const ops = JSON.parse(text.slice(text.indexOf('PROBE') + 5).trim().split('\n')[0])
    const results = []
    for (const o of ops) results.push(await op(o, tools))
    io.say(JSON.stringify(results), 'probe')
    const t = await tools()
    await t.call('report', { text: 'probed over http' })
    await t.call('finish', { summary: 'Probed.' })
    return { stop: 'end_turn' }
  }
  if (text.includes('TOOLS')) {
    io.say('Looking. ', 'm1')
    io.subagent?.()
    io.tool('call-1', 'Edit', { path: 'big.txt', text: 'y'.repeat(10_000) })
    io.result('call-1', 'Edit', true, `--- big.txt\n+++ big.txt\n${'z'.repeat(200_000)}`)
    io.tool('call-2', 'Bash', { command: 'false' })
    io.result('call-2', 'Bash', false, 'exit 1')
    io.say('Done ', 'm2')
    io.say('w'.repeat(100_000), 'm2')
    await (await tools()).call('finish', { summary: 'Tools done.' })
    return { stop: 'end_turn' }
  }
  if (text.includes('SLOW')) {
    io.say('working', 'm1')
    await io.cancelled
    return { stop: 'cancelled' }
  }
  if (text.includes('REFUSE')) return { stop: 'refusal' }
  if (text.includes('MAXTURNS')) return { stop: 'max_turns' }
  if (text.includes('FAIL')) return { error: 'boom' }
  if (text.includes('APPROVAL') && io.approval) {
    io.say(`approvals: ${JSON.stringify(await io.approval())}`, 'm1')
    await (await tools()).call('finish', { summary: 'Approved.' })
    return { stop: 'end_turn' }
  }
  if (text.includes('FINISHPR')) {
    // finish with a pull request (twice with FINISHPR2: the second is ignored), then a last word.
    const t = await tools()
    const r = await t.call('finish', { summary: 'Fixed the flaky test.', pull_request: { title: 'Fix the flaky test', body: 'It waited on a timer.' } })
    if (text.includes('FINISHPR2')) await t.call('finish', { summary: 'Again.', pull_request: { title: 'Again' } })
    io.say(`tool said: ${r.content[0].text}`, 'm1')
    return { stop: 'end_turn' }
  }
  if (text.includes('FINISH2')) {
    // finish early and twice, then keep working: the desktop must see it once, after the turn.
    const t = await tools()
    await t.call('finish', { summary: 'First finish.' })
    await t.call('finish', { summary: 'Second finish.' })
    await new Promise((r) => setTimeout(r, 300))
    io.say('still writing', 'm1')
    return { stop: 'end_turn' }
  }
  if (text.includes('ended without a call to `finish`')) {
    if (opts.ignoreNudge) return io.say('Still not done.', 'm1'), { stop: 'end_turn' }
    io.say('Finishing now.', 'm1')
    await (await tools()).call('finish', { summary: 'Finished after the nudge.' })
    return { stop: 'end_turn' }
  }
  if (text.includes('NOFINISH')) {
    io.say('Did some of it.', 'm1')
    return { stop: 'end_turn' }
  }
  if (text.includes('ASK')) {
    await (await tools()).call('ask_manager', { question: 'Which branch?' })
    return { stop: 'end_turn' }
  }
  if (text.includes('WAIT')) await new Promise((r) => setTimeout(r, 400))
  io.say(`got: ${text.split('\n').at(-1)}`, 'm1')
  await (await tools()).call('finish', { summary: 'Done.' })
  return { stop: 'end_turn' }
}
