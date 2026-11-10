/**
 * The Claude Code adapter: the person's own `claude` CLI, signed in with
 * their own account (Anthropic allows a person's unmodified binary inside
 * another product; Native Intelligence never touches the login), run as
 *
 *   claude -p --verbose --input-format stream-json --output-format stream-json
 *     --include-partial-messages --replay-user-messages
 *     --session-id=<uuid> | --resume=<uuid>   one argv element, and only a UUID
 *     --tools ''                       no built-in tool at all (Bash, Read, Edit, WebFetch, Task...)
 *     --setting-sources ''             none of the person's or the folder's settings: no hooks,
 *                                      plugins, permission rules or env from settings files
 *     --strict-mcp-config --mcp-config <file>   only the fence's MCP server
 *     --allowedTools mcp__ni_folder__bash,...   those tools run without a prompt
 *     --disable-slash-commands         no skills
 *     --append-system-prompt <job>     instructions.ts
 *     [--restricted] [--permission-prompts none] [--no-chrome]   when this version has them
 *
 * It runs in its own empty working folder (`<job dir>/cli`), never the
 * granted one, so it loads no CLAUDE.md, AGENTS.md or `.claude/` of the
 * folder's (run.ts cliWorkingFolder), and with CLAUDE_CODE_DISABLE_AUTO_MEMORY.
 * Message text goes through neutralizeClaudeText, so an `@path` or a leading
 * `/`, `!`, `#`, `&` can't make the CLI attach a file or run a command.
 *
 * One process per session: messages are stream-json `user` lines on stdin.
 * The `system/init` line is checked: every tool offered must be a fence tool
 * and the fence server must be connected, or the job fails before the model
 * acts; work before a passing init is fatal too. A stop kills the process:
 * the CLI's stream-json `interrupt` can leave it unable to take the next
 * message (Native Intelligence's own Claude Code chat hit this, src/lib/claude-session,
 * removed 2026-10), and the transcript Claude Code keeps on disk makes
 * `--resume` lossless.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { FENCE_SERVER, FENCE_TOOLS, MANAGER_TOOLS } from './fence-tools.js'
import { INPUT_LIMIT, OUTPUT_LIMIT, isSessionId, managerText, truncateJson, truncateText, type NormalizedEvent } from './protocol.js'
import { WorkerLaunchError } from './env.js'
import { workerInstructions } from './instructions.js'
import { helpFlags, lastLine, parseVersion, type AdapterContext, type CliAdapter, type CliOutput, type CliProbe, type ProbeRunner, type TurnSpec } from './adapter.js'

const TOOL_PREFIX = `mcp__${FENCE_SERVER}__`

/** Flags the adapter cannot run without (each guards the fence or the protocol). */
export const CLAUDE_REQUIRED_FLAGS = [
  '--print',
  '--verbose',
  '--input-format',
  '--output-format',
  '--include-partial-messages',
  '--session-id',
  '--resume',
  '--tools',
  '--setting-sources',
  '--mcp-config',
  '--strict-mcp-config',
  '--allowedTools',
  '--disable-slash-commands',
  '--append-system-prompt',
] as const

/** Used when this version has them: more of the same fence, or a cleaner turn boundary. */
export const CLAUDE_OPTIONAL_FLAGS = ['--replay-user-messages', '--restricted', '--permission-prompts', '--no-chrome'] as const

const UPDATE_HINT = 'Update it (run `claude update` in Terminal), then try again.'
const SIGN_IN = "Claude Code isn't signed in on this Mac, or its login expired. Open Terminal, run `claude`, and sign in; then try again."

export const FENCE_TOOL_NAMES = FENCE_TOOLS.map((t) => `${TOOL_PREFIX}${t.name}`)

/** The MCP config Claude Code reads: the fence server only, over HTTP with the per-launch bearer. */
export function claudeMcpConfig(mcp: { url: string; token: string }): string {
  return JSON.stringify({ mcpServers: { [FENCE_SERVER]: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } } })
}

export function claudeArgs(ctx: AdapterContext, probe: CliProbe, turn: TurnSpec): string[] {
  // One argv element (`--resume=<uuid>`), and only a UUID: `--resume` takes an optional value, so anything else could be a flag.
  if (!isSessionId(turn.sessionId)) throw new Error('Claude Code needs a UUID session id')
  const has = (f: string) => probe.flags.has(f)
  return [
    '-p',
    '--verbose',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    ...(has('--replay-user-messages') ? ['--replay-user-messages'] : []),
    `${turn.resume ? '--resume' : '--session-id'}=${turn.sessionId}`,
    '--tools',
    '',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    join(ctx.cliTmp, 'mcp.json'),
    '--allowedTools',
    FENCE_TOOL_NAMES.join(','),
    '--disable-slash-commands',
    ...(has('--restricted') ? ['--restricted'] : []),
    ...(has('--permission-prompts') ? ['--permission-prompts', 'none'] : []),
    ...(has('--no-chrome') ? ['--no-chrome'] : []),
    '--append-system-prompt',
    workerInstructions(ctx.launch.mode),
  ]
}

/** U+2060 WORD JOINER: invisible, and enough to stop a prompt parser matching. */
const WORD_JOINER = '\u2060'

/**
 * Message text as Claude Code's own prompt parser would leave it alone. Its
 * input path acts on more than words: an `@path` mention attaches that file
 * (read by the CLI, whose profile reaches its own state: `~/.claude.json`, other
 * sessions), and a message starting with `/`, `!`, `#` or `&` is a command
 * (slash command, shell, memory, background). Messages are words from the
 * Native Intelligence agent or the person (invariant 2), so each of those gets a word
 * joiner in front: the model reads the same text, and the parser matches
 * nothing (U+2060 is not whitespace, so the `@` no longer starts a word). An
 * `@` inside a word (an email address) is not a mention and is left as is.
 */
export function neutralizeClaudeText(text: string): string {
  const t = text.replace(/(^|[\s([{"'`<>,;])@(?=\S)/g, `$1${WORD_JOINER}@`)
  return /^\s*[/!#&]/.test(t) ? `${WORD_JOINER}${t}` : t
}

/** Claude Code names a longer folder by a cut and a hash, which isn't known here: such a job is refused. */
export const CLAUDE_PROJECT_KEY_MAX = 200

/**
 * The name of a working folder's project folder under `~/.claude/projects`:
 * every character but a letter or a digit becomes `-` (seen on 2.1.292, e.g.
 * `/private/tmp/x/cli` -> `-private-tmp-x-cli`). `cwd` is a realpath (run.ts
 * cliWorkingFolder), as the CLI's own `process.cwd()` is.
 */
export function claudeProjectKey(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * The `~/.claude` folders Claude Code writes as it runs (sessions, transcripts,
 * caches; seen on 2.1.292). A path the settings name inside one is protected
 * as that path only, never the whole folder.
 */
export const CLAUDE_RUNTIME_DIRS = ['projects', 'sessions', 'session-env', 'shell-snapshots', 'file-history', 'todos', 'tasks', 'plans', 'ide', 'debug', 'telemetry', 'statsig', 'cache', 'paste-cache', 'state', 'backups'] as const

/**
 * Paths under `~/.claude` that the person's settings point at as something to
 * run (a status line, hooks, `apiKeyHelper`): every string value in
 * `settings.json` / `settings.local.json`, searched for `.claude/<path>` after
 * a `/` however the home is spelled (`~/`, `$HOME/`, `"$HOME"/`, `${HOME}/`,
 * `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/`, the absolute home), and normalized.
 * A script there runs the next time the person uses Claude Code, with no
 * fence, so each is never writable to the worker's CLI, as a file and as a
 * folder. (A script is also covered by its extension; this catches one
 * without. A path named relative to `~/.claude` after a `cd` is not found:
 * README, known risks.)
 */
export function settingsReferencedFiles(home: string, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): string[] {
  const dir = join(home, '.claude')
  const found = new Set<string>()
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/\/\.claude\}?\/([\w./@+-]+)/g)) {
        const path = posix.normalize(`${dir}/${m[1]}`).replace(/\/+$/, '')
        if (path.startsWith(`${dir}/`)) found.add(path)
      }
    } else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  for (const f of ['settings.json', 'settings.local.json']) {
    try {
      walk(JSON.parse(read(join(dir, f))))
    } catch {
      // missing or not JSON: nothing it names
    }
  }
  return [...found].sort()
}

/** One user message on stdin (the envelope Native Intelligence's desktop used with Claude Code until 2026-10). */
export function claudeUserLine(text: string, sessionId: string | null): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: neutralizeClaudeText(text) }, parent_tool_use_id: null, session_id: sessionId ?? '' })}\n`
}

async function probeClaude(run: ProbeRunner): Promise<CliProbe> {
  const v = await run(['--version'])
  const version = v.code === 0 ? parseVersion(v.stdout) : null
  if (!version) throw new WorkerLaunchError(`Claude Code didn't start on this Mac${lastLine(v.stderr) ? `: ${lastLine(v.stderr)}` : ''}.`)
  const help = await run(['--help'])
  const flags = helpFlags(help.stdout)
  const missing = CLAUDE_REQUIRED_FLAGS.filter((f) => !flags.has(f))
  if (missing.length) throw new WorkerLaunchError(`This Claude Code (${version}) is too old for Native Intelligence: it has no ${missing.join(', ')}. ${UPDATE_HINT}`)
  // Only when `auth` is a listed command: on a CLI without it, `claude auth status` would be a prompt.
  if (/^\s+auth\b/m.test(help.stdout)) {
    const auth = await run(['auth', 'status', '--json'])
    try {
      if ((JSON.parse(auth.stdout) as { loggedIn?: unknown }).loggedIn === false) throw new WorkerLaunchError(SIGN_IN)
    } catch (err) {
      if (err instanceof WorkerLaunchError) throw err
      // No JSON (an older `auth status`): a missing login shows on the first turn instead.
    }
  }
  return { version, flags: new Set([...CLAUDE_OPTIONAL_FLAGS].filter((f) => flags.has(f))) }
}

/**
 * A tool the API ran itself (`server_tool_use`: web search or fetch, code
 * execution; `mcp_tool_use`: a remote MCP server; their `*_tool_result`):
 * outside the folder's fence, and none is ever offered, so one is a violation.
 * Only `tool_use` (the CLI's own call) and `tool_result` are expected.
 */
function isServerToolBlock(type: unknown): boolean {
  return typeof type === 'string' && type !== 'tool_use' && type !== 'tool_result' && /(?:^|_)tool_(?:use|result)$/.test(type)
}

function serverTool(type: unknown): CliOutput {
  return { kind: 'violation', message: `Claude Code's answer used a tool the API runs itself (${String(type)}), outside the folder's fence, so the job was stopped.` }
}

type Block = { type?: string; id?: string; name?: string; input?: unknown; text?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }

function blocks(message: unknown): Block[] {
  const content = message && typeof message === 'object' ? (message as { content?: unknown }).content : undefined
  return Array.isArray(content) ? (content as Block[]).filter((b) => b && typeof b === 'object') : []
}

function field(input: unknown, key: string): string {
  const v = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined
  return typeof v === 'string' ? v : ''
}

/** A tool result's content as text: a string, or the text blocks joined. */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => (c && typeof c === 'object' && (c as { type?: unknown }).type === 'text' ? String((c as { text?: unknown }).text ?? '') : ''))
    .filter(Boolean)
    .join('\n')
}

/** A failed `result` as a sentence: a missing login and a used-up plan say what to do. */
export function claudeResultError(e: { subtype?: unknown; result?: unknown; error?: unknown; api_error_status?: unknown }): string {
  const text = typeof e.result === 'string' ? e.result : ''
  const code = typeof e.error === 'string' ? e.error : ''
  if (e.api_error_status === 401 || /authenticat/i.test(code) || /authenticate|invalid api key|not logged in|please run \/login|\b401\b/i.test(text)) return SIGN_IN
  if (/usage limit|limit reached|rate limit|overloaded/i.test(text)) return `Claude Code: ${truncateText(text, 500)} The job can go on later: send a message to continue.`
  return `Claude Code: ${truncateText(text || String(e.subtype ?? 'the turn failed'), 2000)}`
}

/**
 * The stdout mapper for one Claude Code process. Stateful: it keeps the tool
 * calls' names (results carry only the id) and the manager calls (whose
 * results it drops).
 */
export function createClaudeNormalizer() {
  const toolNames = new Map<string, string>()
  const managerCalls = new Set<string>()
  /** The init line passed the fence check. Nothing the model does counts before it. */
  let initOk = false
  const noInit: CliOutput = { kind: 'violation', message: "Claude Code started working without reporting its tools, so the job was stopped (the fence check couldn't run)." }

  return function normalize(line: string): CliOutput[] {
    let e: Record<string, unknown>
    try {
      const v: unknown = JSON.parse(line)
      if (!v || typeof v !== 'object' || Array.isArray(v)) return []
      e = v as Record<string, unknown>
    } catch {
      return [] // a stray non-JSON line (a warning)
    }
    // A subagent's line: with `--tools ''` there is no Task tool, so one means the CLI ran something it shouldn't.
    if (e.parent_tool_use_id !== undefined && e.parent_tool_use_id !== null && (e.type === 'assistant' || e.type === 'user' || e.type === 'stream_event')) {
      return [{ kind: 'violation', message: "Claude Code ran a subagent, which this job doesn't allow, so the job was stopped." }]
    }
    switch (e.type) {
      case 'system': {
        if (e.subtype !== 'init') return []
        const tools = Array.isArray(e.tools) ? e.tools.filter((t): t is string => typeof t === 'string') : []
        const outside = tools.filter((t) => !FENCE_TOOL_NAMES.includes(t))
        if (outside.length) return [{ kind: 'violation', message: `Claude Code offered tools outside the folder's fence (${outside.slice(0, 8).join(', ')}), so the job was stopped before it ran.` }]
        const servers = Array.isArray(e.mcp_servers) ? (e.mcp_servers as { name?: unknown; status?: unknown }[]) : []
        const fence = servers.find((s) => s && s.name === FENCE_SERVER)
        if (!fence || fence.status !== 'connected') {
          return [{ kind: 'violation', message: `Claude Code couldn't reach the folder's tools (${fence ? String(fence.status) : 'not listed'}), so the job was stopped.` }]
        }
        // Exactly the fence tools: one missing means the fence server isn't the one this worker serves.
        const missing = FENCE_TOOL_NAMES.filter((t) => !tools.includes(t))
        if (missing.length || tools.length !== FENCE_TOOL_NAMES.length) {
          return [{ kind: 'violation', message: `Claude Code didn't offer the folder's tools as served (${missing.slice(0, 8).join(', ') || 'duplicates'}), so the job was stopped before it ran.` }]
        }
        initOk = true
        return []
      }
      case 'stream_event': {
        if (!initOk) return [noInit]
        const ev = e.event as { type?: string; delta?: { type?: string; text?: string }; content_block?: { type?: unknown } } | undefined
        if (ev?.type === 'content_block_start' && isServerToolBlock(ev.content_block?.type)) return [serverTool(ev.content_block?.type)]
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          return [{ kind: 'activity' }, { kind: 'event', event: { kind: 'text', delta: ev.delta.text } }]
        }
        return [{ kind: 'activity' }]
      }
      case 'assistant': {
        // The CLI's own stand-in for a failed request ("Not logged in · Please run /login"): the result says it better.
        if (e.is_api_error_message === true) return [{ kind: 'activity' }]
        if (!initOk) return [noInit]
        const out: CliOutput[] = [{ kind: 'activity' }]
        for (const b of blocks(e.message)) {
          if (b.type === 'text' && b.text?.trim()) out.push({ kind: 'event', event: { kind: 'message', text: truncateText(b.text) } })
          if (isServerToolBlock(b.type)) {
            out.push(serverTool(b.type))
            continue
          }
          if (b.type !== 'tool_use' || typeof b.id !== 'string' || typeof b.name !== 'string') continue
          if (!b.name.startsWith(TOOL_PREFIX)) {
            out.push({ kind: 'violation', message: `Claude Code called ${b.name}, a tool outside the folder's fence, so the job was stopped.` })
            continue
          }
          const name = b.name.slice(TOOL_PREFIX.length)
          if (MANAGER_TOOLS.has(name)) {
            managerCalls.add(b.id)
            const event: NormalizedEvent =
              name === 'report'
                ? { kind: 'report', text: managerText('report', field(b.input, 'text')) }
                : name === 'ask_manager'
                  ? { kind: 'ask', question: managerText('ask_manager', field(b.input, 'question')) }
                  : { kind: 'finish', summary: managerText('finish', field(b.input, 'summary')) }
            out.push({ kind: 'event', event })
            continue
          }
          toolNames.set(b.id, name)
          out.push({ kind: 'event', event: { kind: 'tool', callId: b.id, name, input: truncateJson(b.input ?? {}, INPUT_LIMIT) } })
        }
        return out
      }
      case 'user': {
        // A message of ours, echoed back by --replay-user-messages as the CLI takes it up.
        if (e.isReplay === true) return [{ kind: 'consumed' }]
        const results = blocks(e.message).filter((b) => b.type === 'tool_result')
        if (results.length === 0) return []
        if (!initOk) return [noInit]
        const out: CliOutput[] = [{ kind: 'activity' }]
        for (const r of results) {
          if (typeof r.tool_use_id !== 'string' || managerCalls.has(r.tool_use_id)) continue
          const name = toolNames.get(r.tool_use_id) ?? 'unknown'
          out.push({ kind: 'event', event: { kind: 'tool_result', callId: r.tool_use_id, name, ok: r.is_error !== true, output: truncateJson(resultText(r.content), OUTPUT_LIMIT) } })
        }
        return out
      }
      case 'result': {
        const failed = e.is_error === true || (typeof e.subtype === 'string' && e.subtype !== 'success')
        const end: CliOutput = typeof e.queued_turn_count === 'number' ? { kind: 'turn_end', more: e.queued_turn_count > 0 } : { kind: 'turn_end' }
        return failed ? [{ kind: 'event', event: { kind: 'error', message: claudeResultError(e) } }, end] : [end]
      }
      case 'control_request': {
        // Nothing should ask (every fence tool is allowed, nothing else exists); anything that does is refused.
        const id = e.request_id
        if (typeof id !== 'string') return []
        const subtype = (e.request as { subtype?: unknown } | undefined)?.subtype
        const response =
          subtype === 'can_use_tool'
            ? { subtype: 'success', request_id: id, response: { behavior: 'deny', message: "Only the folder tools (ni_folder) can be used in this job." } }
            : { subtype: 'error', request_id: id, error: 'not supported by the Native Intelligence worker' }
        return [{ kind: 'reply', line: `${JSON.stringify({ type: 'control_response', response })}\n` }]
      }
      default:
        return []
    }
  }
}

export const claudeCodeAdapter: CliAdapter = {
  worker: 'claude-code',
  label: 'Claude Code',
  persistent: true,
  chooseSessionId: true,
  stateDirs: (home) => [join(home, '.claude'), join(home, 'Library/Caches/claude-cli-nodejs'), join(home, '.cache/claude'), join(home, '.local/state/claude')],
  stateFiles: (home) => [join(home, '.claude.json')],
  // Hooks, plugins, agents, commands, skills, settings, memory, an npm local install (`local/`, `bin/`), any script,
  // and any path the settings name would run or load outside any fence the next time the person uses Claude Code:
  // never writable.
  // `~/.claude.json` (MCP server commands) can't be protected: the CLI rewrites it all the time (README, known risks).
  protectedState: (home) => {
    const named = settingsReferencedFiles(home)
    // A named folder is protected with all it holds, unless it is one the CLI writes as it runs (a hook may well name
    // `~/.claude/projects`): there only the named path itself is.
    const runtime = CLAUDE_RUNTIME_DIRS.map((d) => join(home, '.claude', d))
    const namedDirs = named.filter((p) => !runtime.some((r) => p === r || p.startsWith(`${r}/`)))
    return {
      // `local` and `bin`: an npm local install of Claude Code, which runs every time the person uses it.
      // `projects/*/memory`: auto memory, loaded into every later session of that project (the person's own, unfenced).
      // `scheduled-tasks`: prompts the app runs later on its own.
      dirs: [...['plugins', 'hooks', 'agents', 'commands', 'skills', 'output-styles', 'rules', 'local', 'bin', 'scheduled-tasks', 'projects/*/memory'].map((d) => join(home, '.claude', d)), ...namedDirs],
      files: [...['settings.json', 'settings.local.json', 'CLAUDE.md', 'keybindings.json'].map((f) => join(home, '.claude', f)), ...named],
      scriptsUnder: [join(home, '.claude')],
    }
  },
  probe: probeClaude,
  // Other projects' folders under `~/.claude/projects` (their transcripts, their auto memory) are never written: only
  // this job's own, named after its working folder. Renaming one into place is refused too (cli-profile.ts).
  ownOnlyUnder: (home, cliCwd) => {
    const key = claudeProjectKey(cliCwd)
    if (key.length > CLAUDE_PROJECT_KEY_MAX) throw new WorkerLaunchError(`This job's folder path is too long for Claude Code (${key.length} characters, at most ${CLAUDE_PROJECT_KEY_MAX}).`)
    return [{ parent: join(home, '.claude', 'projects'), own: join(home, '.claude', 'projects', key) }]
  },
  prepare(ctx) {
    writeFileSync(join(ctx.cliTmp, 'mcp.json'), claudeMcpConfig(ctx.mcp), { mode: 0o600 })
  },
  env: (ctx) => ({
    // Claude Code keeps its per-uid temp dir in /tmp whatever TMPDIR says; this moves it into the CLI's own.
    CLAUDE_CODE_TMPDIR: ctx.cliTmp,
    // The auto-updater would rewrite the binary under a running job (its install is read-only to it anyway).
    DISABLE_AUTOUPDATER: '1',
    // A Native Intelligence job neither writes what it read into the person's Claude memory nor loads that memory.
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    // A fence command may run for minutes (fence-tools.ts BASH_MAX_TIMEOUT_MS) plus margin.
    MCP_TOOL_TIMEOUT: String(11 * 60_000),
    MCP_TIMEOUT: '30000',
  }),
  args: claudeArgs,
  input: (_ctx, text, opts) => claudeUserLine(text, opts.sessionId),
  createNormalizer: createClaudeNormalizer,
  describeExit(code, signal, stderrTail) {
    if (/unknown option|unexpected argument/i.test(stderrTail)) return `This Claude Code is too old for Native Intelligence (${lastLine(stderrTail)}). ${UPDATE_HINT}`
    if (/not logged in|\/login|authenticat/i.test(stderrTail)) return SIGN_IN
    const why = lastLine(stderrTail)
    return `Claude Code stopped unexpectedly (${signal ?? `exit ${code}`})${why ? `: ${truncateText(why, 500)}` : ''}.`
  },
}
