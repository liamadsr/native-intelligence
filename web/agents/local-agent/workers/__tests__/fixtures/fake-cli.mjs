#!/usr/bin/env node
// A stand-in for `claude` or `codex` (chosen by this file's path), for the
// worker e2e test. It speaks the CLI's flags and streaming JSON, calls the
// fence's MCP server for real, and probes the profile it runs under: a direct
// read of $HOME/secret.txt and a request to another local port must both fail.
// Node built-ins only: it runs from a fake HOME under the CLI's sandbox profile.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const self = process.argv[1]
const args = process.argv.slice(2)
const isCodex = /codex/.test(self)
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`)

// `--name value` or `--name=value` (session ids come as one `--resume=<uuid>` element).
function flagValue(name) {
  const joined = args.find((a) => a.startsWith(`${name}=`))
  if (joined) return joined.slice(name.length + 1)
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const resumed = args.some((a) => a.startsWith('--resume='))

async function mcp(url, token, method, params, id = 1) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  return (await res.json()).result
}

async function probes(otherPort, folder) {
  const tryRead = (path) => {
    try {
      readFileSync(path, 'utf8')
      return 'read it'
    } catch (err) {
      return err.code
    }
  }
  const direct = tryRead(`${process.env.HOME}/secret.txt`)
  const inFolder = tryRead(`${folder}/README.md`)
  let other
  try {
    await fetch(`http://127.0.0.1:${otherPort}/`, { signal: AbortSignal.timeout(2000) })
    other = 'reached'
  } catch {
    other = 'refused'
  }
  return `direct read: ${direct}; folder read: ${inFolder}; other port: ${other}; cwd: ${process.cwd()}; tmp: ${process.env.TMPDIR}`
}

// The e2e's slow probe: with ~/.claude/slow-probe there, each probe step is logged with its TMPDIR, and
// `--version` takes 3 s, so a stop lands mid-probe.
if (!isCodex && existsSync(`${process.env.HOME}/.claude/slow-probe`) && ['--version', '--help', 'auth'].includes(args[0])) {
  appendFileSync(`${process.env.HOME}/.claude/probe-log`, `${args[0]} ${process.env.TMPDIR}\n`)
  if (args[0] === '--version') await new Promise((r) => setTimeout(r, 3000))
}

if (args[0] === '--version') {
  console.log(isCodex ? 'codex-cli 9.9.9' : '9.9.9 (Claude Code)')
  process.exit(0)
}

if (!isCodex) {
  if (args[0] === '--help') {
    console.log(
      [
        'Usage: claude [options] [command] [prompt]',
        ...'--print --verbose --input-format --output-format --include-partial-messages --replay-user-messages --session-id --resume --tools --setting-sources --mcp-config --strict-mcp-config --allowedTools --disable-slash-commands --append-system-prompt --permission-prompts'
          .split(' ')
          .map((f) => `  ${f} <x>   flag`),
        'Commands:',
        '  auth   Manage authentication',
      ].join('\n'),
    )
    process.exit(0)
  }
  if (args[0] === 'auth') {
    console.log('{"loggedIn":true}')
    process.exit(0)
  }
  // -p --input-format stream-json ...
  const sessionId = flagValue('--session-id') ?? flagValue('--resume')
  const config = JSON.parse(readFileSync(flagValue('--mcp-config'), 'utf8')).mcpServers.ni_folder
  const token = config.headers.Authorization.slice('Bearer '.length)
  let ready = null
  let n = 0
  const call = async (name, input) => {
    n += 1
    const id = `toolu_${n}`
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: `mcp__ni_folder__${name}`, input }] }, parent_tool_use_id: null, session_id: sessionId })
    const r = await mcp(config.url, token, 'tools/call', { name, arguments: input }, n + 10)
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: r.content, ...(r.isError ? { is_error: true } : {}) }] }, parent_tool_use_id: null, session_id: sessionId })
  }
  const rl = createInterface({ input: process.stdin })
  let chain = Promise.resolve()
  rl.on('line', (line) =>
    (chain = chain.then(async () => {
      const msg = JSON.parse(line)
      ready ??= (async () => {
        await mcp(config.url, token, 'initialize', { protocolVersion: '2025-11-25', clientInfo: { name: 'fake-claude' } })
        const { tools } = await mcp(config.url, token, 'tools/list', {}, 2)
        out({ type: 'system', subtype: 'init', session_id: sessionId, tools: tools.map((t) => `mcp__ni_folder__${t.name}`), mcp_servers: [{ name: 'ni_folder', status: 'connected' }], claude_code_version: '9.9.9', resumed })
      })()
      await ready
      out({ type: 'user', message: { role: 'user', content: msg.message.content }, isReplay: true, session_id: sessionId })
      const text = msg.message.content
      if (text.startsWith('probe ')) {
        await call('report', { text: 'Looking around.' })
        await call('bash', { command: `cat ${process.env.HOME}/secret.txt; echo x > /workspace/new.txt; ls /workspace` })
        await call('read_file', { path: '/workspace/README.md' })
        await call('write_file', { path: '/workspace/new.txt', content: 'x' })
        out({ type: 'assistant', message: { content: [{ type: 'text', text: await probes(text.split(' ')[1], text.split(' ')[2]) }] }, parent_tool_use_id: null, session_id: sessionId })
        await call('finish', { summary: 'Looked around.' })
      } else {
        out({ type: 'assistant', message: { content: [{ type: 'text', text: `${resumed ? 'resumed' : 'same process'}: ${text}` }] }, parent_tool_use_id: null, session_id: sessionId })
      }
      out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sessionId, queued_turn_count: 0 })
    })),
  )
  rl.on('close', () => chain.then(() => process.exit(0)))
} else {
  const rest = args.filter((a, i) => a !== '-c' && args[i - 1] !== '-c' && a !== '--ignore-user-config')
  const overrides = args.filter((a, i) => args[i - 1] === '-c')
  if (rest[0] === '--help') {
    console.log(['Usage: codex [OPTIONS] [PROMPT]', '  --ignore-user-config', '  -c, --config <key=value>'].join('\n'))
    process.exit(0)
  }
  if (rest[0] === 'exec' && rest[1] === '--help') {
    console.log(['Usage: codex exec [OPTIONS] [PROMPT]', '  --json', '  --skip-git-repo-check', '  -s, --sandbox <MODE>', '  --ignore-user-config', '  -C, --cd <DIR>'].join('\n'))
    process.exit(0)
  }
  if (rest[0] === 'features' && rest[1] === 'list') {
    for (const f of ['shell_tool', 'unified_exec', 'personality']) {
      console.log(`${f.padEnd(30)} stable  ${overrides.includes(`features.${f}=false`) ? 'false' : 'true'}`)
    }
    process.exit(0)
  }
  if (rest[0] === 'login') {
    console.log('Logged in using ChatGPT')
    process.exit(0)
  }
  // exec --json ... [resume <id>] -
  const url = JSON.parse(overrides.find((o) => o.startsWith('mcp_servers.ni_folder.url=')).split('=').slice(1).join('='))
  const token = process.env.NI_WORKSPACE_MCP_TOKEN
  const r = rest.indexOf('resume')
  const thread = r === -1 ? '0199b000-0000-7000-8000-000000000001' : rest[r + 1]
  let prompt = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) prompt += chunk
  out({ type: 'thread.started', thread_id: thread })
  out({ type: 'turn.started' })
  await mcp(url, token, 'initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'fake-codex' } })
  const item = { id: 'item_1', type: 'mcp_tool_call', server: 'ni_folder', tool: 'bash', arguments: { command: `cat ${process.env.HOME}/secret.txt; ls /workspace` }, status: 'in_progress' }
  out({ type: 'item.started', item })
  const res = await mcp(url, token, 'tools/call', { name: 'bash', arguments: item.arguments }, 2)
  out({ type: 'item.completed', item: { ...item, status: 'completed', result: { content: res.content } } })
  const probe = /probe (\d+) (\S+)/.exec(prompt)
  const said = probe ? await probes(probe[1], probe[2]) : `turn on ${r === -1 ? 'a new thread' : 'the same thread'}: ${prompt.split('\n').at(-1)}`
  out({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: said } })
  out({ type: 'item.started', item: { id: 'item_3', type: 'mcp_tool_call', server: 'ni_folder', tool: 'finish', arguments: { summary: 'Done.' }, status: 'in_progress' } })
  out({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })
  process.exit(0)
}
