/**
 * What a worker CLI adapter supplies to the driver (driver.ts): how to check
 * the CLI, how to start it, what to write to it, and how its streaming JSON
 * maps to the launcher's NormalizedEvents.
 */
import type { NormalizedEvent, WorkerName } from './protocol.js'
import type { WorkerLaunch } from './env.js'

/** One line from the CLI, mapped. */
export type CliOutput =
  | { readonly kind: 'event'; readonly event: NormalizedEvent }
  /** The session id the CLI resumes by (Codex's thread id; Claude Code's is chosen up front). */
  | { readonly kind: 'session'; readonly sessionId: string }
  /** The CLI is working on a turn (any output that belongs to one). */
  | { readonly kind: 'activity' }
  /** The CLI picked up a message we wrote (Claude Code's `--replay-user-messages` echo). */
  | { readonly kind: 'consumed' }
  /**
   * The turn is over (Claude Code's `result`, Codex's `turn.completed` / `turn.failed`). `more`:
   * the CLI says another turn it queued follows (Claude Code's `queued_turn_count`); unknown when absent.
   */
  | { readonly kind: 'turn_end'; readonly more?: boolean }
  /** The CLI did something outside the fence: the job is killed at once and fails with this message. */
  | { readonly kind: 'violation'; readonly message: string }
  /** A line to write back on the CLI's stdin (a control_response). */
  | { readonly kind: 'reply'; readonly line: string }

/** What a probe of the CLI found: its version and which optional flags it has. */
export interface CliProbe {
  readonly version: string
  readonly flags: ReadonlySet<string>
  /** Codex: the feature flags `features list` knows (each is turned off if it is in the off-list). */
  readonly features?: ReadonlySet<string>
}

/** Runs the CLI with `args` (under its profile) to completion. */
export type ProbeRunner = (args: readonly string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>

export interface AdapterContext {
  readonly launch: WorkerLaunch
  /** The fence's MCP server. */
  readonly mcp: { readonly url: string; readonly token: string }
  /** The CLI's own temp folder (holds its MCP config). */
  readonly cliTmp: string
  /** The CLI's working folder: empty, one per job, never the granted folder (cli-profile.ts). */
  readonly cliCwd: string
}

export interface TurnSpec {
  /** Null on a first Codex turn: the thread id comes back in its output. */
  readonly sessionId: string | null
  readonly resume: boolean
}

export interface CliAdapter {
  readonly worker: WorkerName
  /** The CLI's name in sentences: "Claude Code", "Codex". */
  readonly label: string
  /** One process for the whole session (Claude Code), or one per turn (Codex). */
  readonly persistent: boolean
  /** The session id is chosen here before the first spawn (Claude Code's `--session-id`). */
  readonly chooseSessionId: boolean
  /** The CLI's state under HOME: folders, and files it rewrites next to themselves. */
  stateDirs(home: string): string[]
  stateFiles(home: string): string[]
  /**
   * The parts of that state holding code the CLI would run later: never
   * writable. Folders, files (`*` matches within a name), and folders where no
   * script is writable at any depth.
   */
  protectedState(home: string): { dirs: string[]; files: string[]; scriptsUnder: string[] }
  /**
   * State folders holding other sessions' entries, where only this job's own
   * is writable (cli-profile.ts `ownOnlyUnder`); `cliCwd` is the CLI's working
   * folder, which names its own.
   */
  ownOnlyUnder?(home: string, cliCwd: string): { parent: string; own: string }[]
  /** Check the CLI before anything starts; throws WorkerLaunchError with a sentence for the person. */
  probe(run: ProbeRunner): Promise<CliProbe>
  /** Write what the CLI reads at start (its MCP config), in ctx.cliTmp. */
  prepare(ctx: AdapterContext, probe: CliProbe): void
  /** Extra environment for the CLI. */
  env(ctx: AdapterContext): Record<string, string>
  args(ctx: AdapterContext, probe: CliProbe, turn: TurnSpec): string[]
  /** stdin for one message. A persistent CLI keeps stdin open; a per-turn one gets EOF after this. */
  input(ctx: AdapterContext, text: string, opts: { first: boolean; sessionId: string | null }): string
  /** A fresh mapper for one CLI process's stdout lines. */
  createNormalizer(): (line: string) => CliOutput[]
  /** A sentence for a CLI process that exited without ending its turn. */
  describeExit(code: number | null, signal: NodeJS.Signals | null, stderrTail: string): string
}

/** A version number out of `--version` output (`2.1.292 (Claude Code)`, `codex-cli 0.48.0`). */
export function parseVersion(text: string): string | null {
  return /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(text)?.[1] ?? null
}

/** The long flags a `--help` lists. */
export function helpFlags(help: string): Set<string> {
  return new Set([...help.matchAll(/(?:^|[\s,[(])(--[a-zA-Z][\w-]*)/g)].map((m) => m[1]))
}

/** The last non-empty line of a stderr tail, for a short message. */
export function lastLine(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  return lines.at(-1) ?? ''
}
