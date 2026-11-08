/**
 * The only tools a worker CLI gets: the folder's fence, served to it over MCP
 * (mcp-http.ts). Every command and file access goes through the host-folder
 * sandbox (../../lib/host-folder-sandbox.ts), the same Seatbelt fence eve's
 * `bash`, `read_file` and `write_file` run under: the kernel refuses a read
 * outside the folder, a write in read mode, a write to the worktree's `.git`,
 * and any network, whatever this file or the model does.
 *
 * Plus the three manager tools of the eve local agent (`report`,
 * `ask_manager`, `finish`). They do nothing here: the adapter sees the call
 * in the CLI's own output and turns it into the same `report` / `ask` /
 * `finish` events the launcher emits.
 */
import type { SandboxSession } from 'eve/sandbox'
import type { LocalAgentMode } from '../../lib/seatbelt.js'

/** The MCP server's name: the CLI shows its tools as `mcp__dial8_folder__bash` (Claude Code) or `dial8_folder.bash` (Codex). Not `workspace`: Claude Code reserves that name and drops a server called so. */
export const FENCE_SERVER = 'dial8_folder'

/** The tools whose calls become their own events instead of tool + tool_result (same as the launcher's). */
export const MANAGER_TOOLS = new Set(['report', 'ask_manager', 'finish'])

export interface FenceToolDef {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly annotations: { readonly readOnlyHint: boolean; readonly destructiveHint?: boolean; readonly openWorldHint: false }
}

export interface FenceToolResult {
  readonly text: string
  readonly isError: boolean
}

/** One command's longest run, and its default. */
export const BASH_MAX_TIMEOUT_MS = 10 * 60_000
export const BASH_DEFAULT_TIMEOUT_MS = 2 * 60_000
/** How much of a command's stdout and stderr each goes back to the model (head and tail kept). */
export const COMMAND_OUTPUT_LIMIT = 30_000
/** How much of a file one read returns; longer files are read in line ranges. */
export const READ_LIMIT = 100_000

const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra })
const int = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'integer', description, ...extra })
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false })

export const FENCE_TOOLS: readonly FenceToolDef[] = [
  {
    name: 'bash',
    description:
      'Run a bash command in the folder (/workspace, also the current directory). It runs in a sandbox with no network: ' +
      'nothing outside /workspace is readable and, in a read-only job, nothing is writable. Returns the exit code, stdout and stderr.',
    inputSchema: object(
      {
        command: str('The command, run with bash -c.'),
        cwd: str('Directory to run in, inside /workspace (default: /workspace).'),
        timeout_ms: int(`Stop the command after this long (default ${BASH_DEFAULT_TIMEOUT_MS}, at most ${BASH_MAX_TIMEOUT_MS}).`, { minimum: 1000, maximum: BASH_MAX_TIMEOUT_MS }),
      },
      ['command'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: 'read_file',
    description: `Read a text file in /workspace (a path under /workspace, or relative to it). Optional 1-based line range. At most ${READ_LIMIT} characters per read.`,
    inputSchema: object(
      {
        path: str('The file, e.g. /workspace/src/index.ts or src/index.ts.'),
        start_line: int('First line to return (1-based).', { minimum: 1 }),
        end_line: int('Last line to return (inclusive).', { minimum: 1 }),
      },
      ['path'],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'write_file',
    description: 'Create or replace a text file in /workspace with the given content. Fails in a read-only job, and on .git.',
    inputSchema: object({ path: str('The file to write, under /workspace.'), content: str('The whole new content.') }, ['path', 'content']),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: 'edit_file',
    description:
      'Replace an exact piece of text in a file in /workspace. old_string must appear exactly once (include enough context), ' +
      'unless replace_all is true. Fails in a read-only job.',
    inputSchema: object(
      {
        path: str('The file to edit, under /workspace.'),
        old_string: str('The exact text to replace.'),
        new_string: str('The text to put in its place.'),
        replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' },
      },
      ['path', 'old_string', 'new_string'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: 'report',
    description:
      'Report progress on the request: what you looked at, what you found, what you are about to do. ' +
      'Call it as you go, in a sentence or two. The person and the Native Intelligence agent see it.',
    inputSchema: object({ text: str('The progress note.', { minLength: 1, maxLength: 4000 }) }, ['text']),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'ask_manager',
    description:
      'Ask the Native Intelligence agent (your manager) one question when you are blocked and cannot find the answer in the folder. ' +
      'Then end your turn and wait: the answer arrives as your next message.',
    inputSchema: object({ question: str('One clear question.', { minLength: 1, maxLength: 2000 }) }, ['question']),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'finish',
    description:
      'Finish the request: give a summary of what you found or did, including anything that was blocked. ' +
      'Call it once the request is done, then end your turn.',
    inputSchema: object({ summary: str('What you found or did, for the person and the Native Intelligence agent.', { minLength: 1, maxLength: 8000 }) }, ['summary']),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
]

/** Keep the head and the tail of a long output, saying how much was cut. */
export function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  const head = Math.floor(limit * 0.7)
  const tail = limit - head
  return `${text.slice(0, head)}\n… [${text.length - limit} characters cut] …\n${text.slice(text.length - tail)}`
}

function argString(args: Record<string, unknown>, key: string, opts: { required?: boolean; max?: number; allowEmpty?: boolean } = {}): string | undefined {
  const v = args[key]
  if (v === undefined || v === null) {
    if (opts.required) throw new FenceArgError(`${key} is required`)
    return undefined
  }
  if (typeof v !== 'string') throw new FenceArgError(`${key} must be a string`)
  if (!opts.allowEmpty && v.trim() === '') throw new FenceArgError(`${key} must not be empty`)
  if (opts.max !== undefined && v.length > opts.max) throw new FenceArgError(`${key} is longer than ${opts.max} characters`)
  return v
}

function argInt(args: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = args[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new FenceArgError(`${key} must be an integer from ${min} to ${max}`)
  return v
}

class FenceArgError extends Error {}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) n += 1
  return n
}

/**
 * The tool handlers over one fenced session. `call` never throws for a tool
 * failure: a refused path, a missing file or a timed-out command comes back
 * as `isError` text the model can act on.
 */
export function createFenceTools(session: SandboxSession, mode: LocalAgentMode) {
  const readOnly = (path: string): FenceToolResult => ({ text: `This folder was granted read-only: ${path} cannot be written.`, isError: true })

  async function bash(args: Record<string, unknown>, signal: AbortSignal): Promise<FenceToolResult> {
    const command = argString(args, 'command', { required: true })!
    const cwd = argString(args, 'cwd')
    const timeoutMs = argInt(args, 'timeout_ms', 1000, BASH_MAX_TIMEOUT_MS) ?? BASH_DEFAULT_TIMEOUT_MS
    const timeout = AbortSignal.timeout(timeoutMs)
    try {
      const res = await session.run({ command, ...(cwd ? { workingDirectory: cwd } : {}), abortSignal: AbortSignal.any([signal, timeout]) })
      const parts = [`exit code: ${res.exitCode}`]
      if (res.stdout) parts.push(clip(res.stdout, COMMAND_OUTPUT_LIMIT))
      if (res.stderr) parts.push(`[stderr]\n${clip(res.stderr, COMMAND_OUTPUT_LIMIT)}`)
      return { text: parts.join('\n'), isError: false }
    } catch (err) {
      if (timeout.aborted && !signal.aborted) return { text: `The command ran longer than ${timeoutMs} ms and was stopped.`, isError: true }
      if (signal.aborted) return { text: 'The command was stopped.', isError: true }
      return { text: errorText(err), isError: true }
    }
  }

  async function readFile(args: Record<string, unknown>, signal: AbortSignal): Promise<FenceToolResult> {
    const path = argString(args, 'path', { required: true })!
    const startLine = argInt(args, 'start_line', 1, Number.MAX_SAFE_INTEGER)
    const endLine = argInt(args, 'end_line', 1, Number.MAX_SAFE_INTEGER)
    const text = await session.readTextFile({ path, startLine, endLine, abortSignal: signal })
    if (text === null) return { text: `${path} does not exist.`, isError: true }
    if (text.length <= READ_LIMIT) return { text, isError: false }
    return { text: `${text.slice(0, READ_LIMIT)}\n… [cut at ${READ_LIMIT} characters: read the rest with start_line / end_line]`, isError: false }
  }

  async function writeFile(args: Record<string, unknown>, signal: AbortSignal): Promise<FenceToolResult> {
    const path = argString(args, 'path', { required: true })!
    const content = argString(args, 'content', { required: true, allowEmpty: true })!
    if (mode === 'read') return readOnly(path)
    await session.writeTextFile({ path, content, abortSignal: signal })
    return { text: `Wrote ${Buffer.byteLength(content)} bytes to ${path}.`, isError: false }
  }

  async function editFile(args: Record<string, unknown>, signal: AbortSignal): Promise<FenceToolResult> {
    const path = argString(args, 'path', { required: true })!
    const oldString = argString(args, 'old_string', { required: true, allowEmpty: true })!
    const newString = argString(args, 'new_string', { required: true, allowEmpty: true })!
    const replaceAll = args.replace_all === true
    if (mode === 'read') return readOnly(path)
    if (oldString === '') return { text: 'old_string must not be empty: use write_file to create a file.', isError: true }
    if (oldString === newString) return { text: 'old_string and new_string are the same.', isError: true }
    const text = await session.readTextFile({ path, abortSignal: signal })
    if (text === null) return { text: `${path} does not exist.`, isError: true }
    const count = countOccurrences(text, oldString)
    if (count === 0) return { text: `old_string was not found in ${path}.`, isError: true }
    if (count > 1 && !replaceAll) return { text: `old_string appears ${count} times in ${path}: include more context, or set replace_all.`, isError: true }
    const next = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, () => newString)
    await session.writeTextFile({ path, content: next, abortSignal: signal })
    return { text: `Replaced ${replaceAll ? count : 1} occurrence${(replaceAll ? count : 1) === 1 ? '' : 's'} in ${path}.`, isError: false }
  }

  function manager(name: string, args: Record<string, unknown>): FenceToolResult {
    if (name === 'report') {
      argString(args, 'text', { required: true, max: 4000 })
      return { text: 'Reported.', isError: false }
    }
    if (name === 'ask_manager') {
      argString(args, 'question', { required: true, max: 2000 })
      return { text: 'Question sent. End your turn now; the answer will arrive as your next message.', isError: false }
    }
    argString(args, 'summary', { required: true, max: 8000 })
    return { text: 'Finished. End your turn now.', isError: false }
  }

  return {
    async call(name: string, rawArgs: unknown, signal: AbortSignal): Promise<FenceToolResult> {
      const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {}
      try {
        switch (name) {
          case 'bash':
            return await bash(args, signal)
          case 'read_file':
            return await readFile(args, signal)
          case 'write_file':
            return await writeFile(args, signal)
          case 'edit_file':
            return await editFile(args, signal)
          case 'report':
          case 'ask_manager':
          case 'finish':
            return manager(name, args)
          default:
            return { text: `Unknown tool: ${name}`, isError: true }
        }
      } catch (err) {
        return { text: errorText(err), isError: true }
      }
    },
  }
}

export type FenceTools = ReturnType<typeof createFenceTools>
