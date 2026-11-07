/**
 * The Codex adapter: the person's own `codex` CLI, signed in with their own
 * ChatGPT or API login (Dial8 never reads it), one process per turn:
 *
 *   codex exec --json --skip-git-repo-check --ignore-user-config [--ignore-rules] [--color never]
 *     --sandbox read-only --cd <an empty folder of its own>
 *     -c approval_policy="never" -c project_doc_max_bytes=0 -c web_search="disabled" -c tools.view_image=false
 *     -c features.<f>=false            each of CODEX_FEATURES_OFF that this version knows
 *                                      (shell_tool, unified_exec, multi_agent, hooks, ...)
 *     -c mcp_servers.dial8_folder.url=... (+ bearer_token_env_var, required, timeouts, approve)
 *     [resume <thread id>] -           the prompt comes on stdin
 *
 *   - `--ignore-user-config` drops `~/.codex/config.toml`: none of the
 *     person's MCP servers, profiles, `notify` programs or project trust. The
 *     login (`auth.json`) is separate and still used.
 *   - `features.shell_tool=false` (and `unified_exec`) leave Codex with no
 *     command execution of its own: the fence's `bash` is the only way to run
 *     anything. The probe runs `features list` with the same overrides and
 *     refuses a Codex that cannot show `shell_tool` turned off.
 *   - `--sandbox read-only` with approvals never: an apply_patch that slips
 *     through is refused by Codex's own sandbox.
 *   - Backstop: a `command_execution`, an applied `file_change` or a
 *     `web_search` in the output means Codex acted outside the fence, and the
 *     job is killed at once.
 *
 * What does not map: Codex's `exec` has no mid-turn input, so a steer waits
 * for the turn to end (like a queued message), and there are no text deltas
 * (each message arrives whole). A stop kills the turn's process; the thread is
 * on disk, so the next message resumes it.
 */
import { FENCE_SERVER, MANAGER_TOOLS } from './fence-tools.js'
import { INPUT_LIMIT, OUTPUT_LIMIT, isSessionId, managerText, truncateJson, truncateText, type NormalizedEvent } from './protocol.js'
import { WorkerLaunchError } from './env.js'
import { codexFirstPrompt } from './instructions.js'
import { helpFlags, lastLine, parseVersion, type AdapterContext, type CliAdapter, type CliOutput, type CliProbe, type ProbeRunner, type TurnSpec } from './adapter.js'

/** `codex exec` flags the adapter cannot run without. */
export const CODEX_REQUIRED_FLAGS = ['--json', '--skip-git-repo-check', '--sandbox', '--ignore-user-config', '--cd'] as const
export const CODEX_OPTIONAL_FLAGS = ['--ignore-rules', '--color'] as const

/**
 * Feature flags turned off when this version knows them: command execution,
 * subagents, hooks, memories, apps/connectors, installs, web search, image
 * reads off disk, and automatic git commits. `shell_tool` must be among them.
 */
export const CODEX_FEATURES_OFF = [
  'shell_tool',
  'unified_exec',
  'multi_agent',
  'hooks',
  'codex_hooks',
  'memories',
  'apps',
  'skill_mcp_dependency_install',
  'web_search',
  'web_search_request',
  'view_image_tool',
  'codex_git_commit',
] as const
/** Turned on when this version knows it: older versions reach HTTP MCP servers only through it. */
export const CODEX_FEATURES_ON = ['rmcp_client'] as const

export const CODEX_TOKEN_ENV = 'DIAL8_WORKSPACE_MCP_TOKEN'

const UPDATE_HINT = 'Update it (`npm install -g @openai/codex@latest`, or `brew upgrade codex`), then try again.'
const SIGN_IN = "Codex isn't signed in on this Mac, or its login expired. Open Terminal, run `codex login`, then try again."

/** `-c` values are parsed as TOML (JSON on older versions): a JSON string or number is valid in both. */
const c = (key: string, value: string | number | boolean) => ['-c', `${key}=${typeof value === 'string' ? JSON.stringify(value) : String(value)}`]

/** The feature overrides for this version: off-list ∩ known, on-list ∩ known. */
export function codexFeatureArgs(features: ReadonlySet<string> | undefined): string[] {
  const known = features ?? new Set<string>(['shell_tool'])
  return [
    ...CODEX_FEATURES_OFF.filter((f) => known.has(f)).flatMap((f) => c(`features.${f}`, false)),
    ...CODEX_FEATURES_ON.filter((f) => known.has(f)).flatMap((f) => c(`features.${f}`, true)),
  ]
}

export function codexArgs(ctx: AdapterContext, probe: CliProbe, turn: TurnSpec): string[] {
  // The thread id becomes an argument after `resume`: only a UUID, never anything Codex could read as a flag.
  if (turn.resume && !isSessionId(turn.sessionId)) throw new Error('Codex resumes only a UUID thread id')
  const has = (f: string) => probe.flags.has(f)
  const server = `mcp_servers.${FENCE_SERVER}`
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ignore-user-config',
    ...(has('--ignore-rules') ? ['--ignore-rules'] : []),
    ...(has('--color') ? ['--color', 'never'] : []),
    '--sandbox',
    'read-only',
    // An empty folder of its own, not the granted one: no AGENTS.md or .codex/ project config of anyone's making.
    '--cd',
    ctx.cliCwd,
    ...c('approval_policy', 'never'),
    ...c('project_doc_max_bytes', 0),
    ...c('web_search', 'disabled'),
    ...c('tools.view_image', false),
    ...codexFeatureArgs(probe.features),
    ...c(`${server}.url`, ctx.mcp.url),
    ...c(`${server}.bearer_token_env_var`, CODEX_TOKEN_ENV),
    ...c(`${server}.required`, true),
    ...c(`${server}.startup_timeout_sec`, 30),
    ...c(`${server}.tool_timeout_sec`, 660),
    ...c(`${server}.default_tools_approval_mode`, 'approve'),
    ...(turn.resume ? ['resume', turn.sessionId!] : []),
    '-',
  ]
}

/** `features list` rows: name → enabled (last column), where it can be read. */
export function parseFeatureList(text: string): Map<string, boolean | null> {
  const out = new Map<string, boolean | null>()
  for (const raw of text.split('\n')) {
    const cols = raw.trim().split(/\s+/)
    if (cols.length < 2 || !/^[a-z][a-z0-9_]*$/.test(cols[0])) continue
    const last = cols.at(-1)!.toLowerCase()
    out.set(cols[0], ['true', 'on', 'enabled', 'yes'].includes(last) ? true : ['false', 'off', 'disabled', 'no'].includes(last) ? false : null)
  }
  return out
}

async function probeCodex(run: ProbeRunner): Promise<CliProbe> {
  const v = await run(['--version'])
  const version = v.code === 0 ? parseVersion(v.stdout) : null
  if (!version) throw new WorkerLaunchError(`Codex didn't start on this Mac${lastLine(v.stderr) ? `: ${lastLine(v.stderr)}` : ''}.`)
  const help = await run(['exec', '--help'])
  const flags = helpFlags(help.stdout)
  const missing = CODEX_REQUIRED_FLAGS.filter((f) => !flags.has(f))
  if (missing.length) throw new WorkerLaunchError(`This Codex (${version}) is too old for Dial8: \`codex exec\` has no ${missing.join(', ')}. ${UPDATE_HINT}`)

  // `features list` and `login status` read config too: the person's is left out there as well, when this
  // version takes --ignore-user-config before a subcommand (else they read it, and only read it).
  const top = helpFlags((await run(['--help'])).stdout)
  const own = top.has('--ignore-user-config') ? ['--ignore-user-config'] : []

  // The overrides as `exec` will get them, then the resolved states: shell_tool must read as off.
  const first = await run([...own, 'features', 'list'])
  const all = parseFeatureList(first.stdout)
  if (first.code !== 0 || !all.has('shell_tool')) {
    throw new WorkerLaunchError(`This Codex (${version}) can't turn off its built-in shell, which Dial8 needs. ${UPDATE_HINT}`)
  }
  const features = new Set(all.keys())
  const checked = parseFeatureList((await run([...own, ...codexFeatureArgs(features), 'features', 'list'])).stdout)
  const stillOn = CODEX_FEATURES_OFF.filter((f) => features.has(f) && checked.get(f) !== false)
  if (stillOn.includes('shell_tool') || stillOn.includes('unified_exec')) {
    throw new WorkerLaunchError(`Codex (${version}) didn't turn off its built-in shell (${stillOn.join(', ')}), so Dial8 won't run it.`)
  }

  const login = await run([...own, 'login', 'status'])
  if (login.code !== 0) throw new WorkerLaunchError(/config|toml|parse/i.test(login.stderr) ? `Codex couldn't read its settings: ${truncateText(lastLine(login.stderr), 300)}` : SIGN_IN)
  return { version, flags: new Set([...CODEX_OPTIONAL_FLAGS].filter((f) => flags.has(f))), features }
}

function errorSentence(message: string): string {
  if (/\b401\b|unauthori[sz]ed|not logged in|log in again|login|authenticat|refresh token|token (?:has )?expired/i.test(message)) return SIGN_IN
  return `Codex: ${truncateText(message, 2000)}`
}

/** An MCP result's text: the text blocks joined. */
function mcpResultText(result: unknown): string {
  const content = result && typeof result === 'object' ? (result as { content?: unknown }).content : undefined
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
    .filter(Boolean)
    .join('\n')
}

function field(input: unknown, key: string): string {
  const v = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined
  return typeof v === 'string' ? v : ''
}

type Item = { id?: unknown; type?: unknown; server?: unknown; tool?: unknown; arguments?: unknown; result?: unknown; error?: unknown; status?: unknown; text?: unknown; message?: unknown; command?: unknown; query?: unknown }

/**
 * The stdout mapper for one `codex exec --json` process (one turn). Stateful:
 * it keeps which tool calls it announced and which were manager calls.
 */
export function createCodexNormalizer() {
  const announced = new Set<string>()
  const managerCalls = new Set<string>()

  const toolCall = (item: Item, id: string): CliOutput[] => {
    if (announced.has(id)) return []
    const name = typeof item.tool === 'string' ? item.tool : 'unknown'
    if (MANAGER_TOOLS.has(name)) {
      if (item.arguments === undefined) return [] // announce once the arguments are known
      announced.add(id)
      managerCalls.add(id)
      const event: NormalizedEvent =
        name === 'report'
          ? { kind: 'report', text: managerText('report', field(item.arguments, 'text')) }
          : name === 'ask_manager'
            ? { kind: 'ask', question: managerText('ask_manager', field(item.arguments, 'question')) }
            : { kind: 'finish', summary: managerText('finish', field(item.arguments, 'summary')) }
      return [{ kind: 'event', event }]
    }
    announced.add(id)
    return [{ kind: 'event', event: { kind: 'tool', callId: id, name, input: truncateJson(item.arguments ?? {}, INPUT_LIMIT) } }]
  }

  const outsideFence = (item: Item, phase: 'started' | 'completed'): string | null => {
    switch (item.type) {
      case 'command_execution':
        return `Codex ran a command of its own (${truncateText(String(item.command ?? ''), 200)}) instead of the folder's tools, so the job was stopped.`
      case 'web_search':
        return 'Codex searched the web, which this job does not allow, so the job was stopped.'
      case 'file_change':
        return phase === 'completed' && item.status === 'completed' ? "Codex changed files without the folder's tools, so the job was stopped." : null
      case 'mcp_tool_call':
        return item.server !== FENCE_SERVER ? `Codex called a tool of another MCP server (${String(item.server)}), so the job was stopped.` : null
      case 'agent_message':
      case 'reasoning':
      case 'todo_list':
      case 'error':
        return null
      default:
        // Default-deny: an item type this adapter doesn't know (a `collab_tool_call` from a version that ignores
        // `multi_agent=false`, say) may act outside the fence.
        return `Codex did something this job doesn't know (${truncateText(String(item.type ?? 'an item with no type'), 80)}), so the job was stopped.`
    }
  }

  return function normalize(line: string): CliOutput[] {
    let e: Record<string, unknown>
    try {
      const v: unknown = JSON.parse(line)
      if (!v || typeof v !== 'object' || Array.isArray(v)) return []
      e = v as Record<string, unknown>
    } catch {
      return []
    }
    if (typeof e.type !== 'string' && 'msg' in e) {
      return [{ kind: 'violation', message: `This Codex speaks an older JSON format. ${UPDATE_HINT}` }]
    }
    switch (e.type) {
      case 'thread.started':
        return isSessionId(e.thread_id) ? [{ kind: 'session', sessionId: e.thread_id }] : [{ kind: 'violation', message: "Codex reported a thread id that isn't a UUID, so the job was stopped." }]
      case 'turn.started':
        return [{ kind: 'activity' }]
      case 'turn.completed':
        return [{ kind: 'turn_end' }]
      case 'turn.failed': {
        const message = field(e.error, 'message') || 'the turn failed'
        return [{ kind: 'event', event: { kind: 'error', message: errorSentence(message) } }, { kind: 'turn_end' }]
      }
      case 'error':
        return [{ kind: 'event', event: { kind: 'error', message: errorSentence(typeof e.message === 'string' ? e.message : 'Codex reported an error') } }]
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const item = (e.item ?? {}) as Item
        const id = typeof item.id === 'string' ? item.id : ''
        const phase = e.type === 'item.completed' ? 'completed' : 'started'
        const why = outsideFence(item, phase)
        if (why) return [{ kind: 'violation', message: why }]
        const out: CliOutput[] = [{ kind: 'activity' }]
        if (item.type === 'mcp_tool_call' && id) {
          out.push(...toolCall(item, id))
          if (phase === 'completed' && !managerCalls.has(id)) {
            const error = field(item.error, 'message')
            const result = item.result as { isError?: unknown; is_error?: unknown } | undefined
            const ok = item.status === 'completed' && !error && result?.isError !== true && result?.is_error !== true
            const name = typeof item.tool === 'string' ? item.tool : 'unknown'
            out.push({ kind: 'event', event: { kind: 'tool_result', callId: id, name, ok, output: truncateJson(error || mcpResultText(item.result), OUTPUT_LIMIT) } })
          }
        } else if (phase === 'completed' && item.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) {
          out.push({ kind: 'event', event: { kind: 'message', text: truncateText(item.text) } })
        } else if (phase === 'completed' && item.type === 'error' && typeof item.message === 'string') {
          out.push({ kind: 'event', event: { kind: 'error', message: errorSentence(item.message) } })
        }
        return out
      }
      default:
        return []
    }
  }
}

export const codexAdapter: CliAdapter = {
  worker: 'codex',
  label: 'Codex',
  persistent: false,
  chooseSessionId: false,
  stateDirs: (home) => [`${home}/.codex`],
  stateFiles: () => [],
  // Its config (MCP server commands, notify programs, profiles), instructions, rules, skills, plugins, automations and
  // memories: what a later session of the person's own (unfenced) runs or loads.
  protectedState: (home) => ({
    dirs: ['rules', 'skills', 'prompts', 'bin', 'plugins', 'automations', 'memories', 'memories_v2'].map((d) => `${home}/.codex/${d}`),
    // `.env`: Codex loads it into its own environment at every start. `memories*`: the memory stores (sqlite, WAL
    // files included; the worker runs with `features.memories=false`). `instructions.md`, `config.json`: older config.
    files: ['*.toml', 'config.json', 'AGENTS.md', 'AGENTS.override.md', 'instructions.md', 'hooks.json', '.env', 'memories*'].map((f) => `${home}/.codex/${f}`),
    scriptsUnder: [`${home}/.codex`],
  }),
  probe: probeCodex,
  prepare() {
    // Everything goes in the arguments; the bearer goes in the environment (below), never the arguments.
  },
  env: (ctx) => ({ [CODEX_TOKEN_ENV]: ctx.mcp.token }),
  args: codexArgs,
  input: (ctx, text, opts) => (opts.first ? codexFirstPrompt(ctx.launch.mode, text) : text),
  createNormalizer: createCodexNormalizer,
  describeExit(code, signal, stderrTail) {
    if (/unexpected argument|unrecognized|unknown (?:option|flag)/i.test(stderrTail)) return `This Codex is too old for Dial8 (${truncateText(lastLine(stderrTail), 300)}). ${UPDATE_HINT}`
    if (/mcp/i.test(stderrTail) && new RegExp(FENCE_SERVER).test(stderrTail)) return `Codex couldn't reach the folder's tools: ${truncateText(lastLine(stderrTail), 500)}`
    if (/\b401\b|unauthori[sz]ed|not logged in|codex login/i.test(stderrTail)) return SIGN_IN
    const why = lastLine(stderrTail)
    return `Codex stopped unexpectedly (${signal ?? `exit ${code}`})${why ? `: ${truncateText(why, 500)}` : ''}.`
  },
}
