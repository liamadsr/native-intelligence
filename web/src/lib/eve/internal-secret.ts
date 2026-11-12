/**
 * Resolve a run-token family's internal secret, and say out loud (once per
 * process) WHERE it came from.
 *
 * The chat, agent-run and live-agent run tokens are HMACs over the bare payload,
 * with no domain prefix (only utility adds one), so the only thing that keeps
 * one family's token from verifying as another's is that their keys differ.
 * Each family prefers its dedicated env var and falls back to
 * RUN_SKILL_INTERNAL_SECRET so one secret bootstraps dev. An EMPTY dedicated
 * value counts as unset. So a dedicated secret that is missing, stored empty
 * (`vercel env add NAME < file` can store an empty value), or equal to
 * RUN_SKILL's leaves that family keyed by the skill-runner's secret, and every
 * surface still works. Nothing else can tell: the values are sensitive and
 * cannot be read back.
 *
 * This resolver makes that state observable without logging a secret. The
 * first time a family resolves in a process (and again if the answer changes),
 * it logs one line:
 *
 *   [internal-secret] {"family":"chat","env":"CHAT_INTERNAL_SECRET","secretSource":"dedicated"}
 *
 * secretSource is one of:
 *   - dedicated: the family's own env var, distinct from EVERY other internal
 *                secret (RUN_SKILL's and every other family's): the goal;
 *   - shared:    the family's own env var, but EQUAL to at least one other
 *                internal secret. The line then carries
 *                `"sharedWith":["<ENV_NAME>",...]`: env var NAMES only, never a
 *                value. Two families sharing a key can forge each other's
 *                tokens, which is exactly what the dedicated keys exist to stop;
 *   - fallback:  the family's env var is unset or empty, so RUN_SKILL's is used;
 *   - unset:     neither is set (the family refuses to run).
 * Only the dedicated case is logged at info; the other three are warnings. The
 * cutover runbook (docs/plans/eve-everywhere-cutover.md §b.0) reads these lines
 * on the preview before prod: six `dedicated` lines prove the seven internal
 * secrets are pairwise distinct.
 *
 * The local agent's model token (`la1`, src/lib/local-agent/tokens.ts) is a
 * family here too: LOCAL_AGENT_TOKEN_SECRET, falling back to RUN_SKILL's like
 * the rest (security review 2026-10-31), so its line says the same four
 * things and every other family is compared against it.
 *
 * The capture feed's (CAPTURE_FEED_SECRET, src/lib/capture-feed/auth.ts) is
 * held by a producer outside the app's containers (the call recorder, in
 * LiveKit's stack), so it never falls back: `{ fallback: false }` makes an
 * unset one `unset`, and the feed is off, rather than hand that service the
 * skill-runner's key.
 */

export type InternalSecretFamily = 'chat' | 'agent-run' | 'live-agent' | 'utility' | 'browser' | 'local-agent' | 'capture-feed'
export type InternalSecretSource = 'dedicated' | 'shared' | 'fallback' | 'unset'

/** The root of the internal-secret chain (the skill-runner's own secret). */
export const ROOT_INTERNAL_SECRET_ENV = 'RUN_SKILL_INTERNAL_SECRET'

/**
 * Every internal-secret env var: the root plus each family's dedicated one. A
 * family's value is compared with all of them, so any two that hold the same
 * value are both reported `shared`.
 */
export const INTERNAL_SECRET_ENVS = [
  ROOT_INTERNAL_SECRET_ENV,
  'AGENT_RUN_INTERNAL_SECRET',
  'CHAT_INTERNAL_SECRET',
  'UTILITY_INTERNAL_SECRET',
  'LIVE_AGENT_INTERNAL_SECRET',
  'BROWSER_INTERNAL_SECRET',
  'LOCAL_AGENT_TOKEN_SECRET',
  'CAPTURE_FEED_SECRET',
] as const

export interface InternalSecretStatus {
  source: InternalSecretSource
  /** Env var NAMES (never values) whose value equals this family's; empty unless `shared`. */
  sharedWith: string[]
}

/** What was last logged per family, as a comparable key. */
const lastLogged = new Map<InternalSecretFamily, string>()

function nonEmpty(v: string | undefined): string | null {
  return v && v.length > 0 ? v : null
}

/** Where `dedicatedEnv` resolves from right now, and which other env vars share its value. Never returns a secret. */
export function internalSecretStatus(dedicatedEnv: string, opts: { fallback?: boolean } = {}): InternalSecretStatus {
  const own = nonEmpty(process.env[dedicatedEnv])
  if (!own) {
    return { source: opts.fallback !== false && nonEmpty(process.env[ROOT_INTERNAL_SECRET_ENV]) ? 'fallback' : 'unset', sharedWith: [] }
  }
  const sharedWith = INTERNAL_SECRET_ENVS.filter((env) => env !== dedicatedEnv && nonEmpty(process.env[env]) === own)
  return { source: sharedWith.length > 0 ? 'shared' : 'dedicated', sharedWith }
}

/** Where `dedicatedEnv` resolves from right now, without logging. Never returns a secret. */
export function internalSecretSource(dedicatedEnv: string): InternalSecretSource {
  return internalSecretStatus(dedicatedEnv).source
}

/**
 * The family's secret: its dedicated env var when non-empty, else
 * RUN_SKILL_INTERNAL_SECRET, else null. Logs the source once per process per
 * family (again only if the source or its sharedWith list changes); the log
 * carries env var names only, never a secret value.
 */
export function resolveInternalSecret(family: InternalSecretFamily, dedicatedEnv: string, opts: { fallback?: boolean } = {}): string | null {
  const { source, sharedWith } = internalSecretStatus(dedicatedEnv, opts)
  const fields: Record<string, unknown> = { family, env: dedicatedEnv, secretSource: source }
  if (sharedWith.length > 0) fields.sharedWith = sharedWith
  const line = JSON.stringify(fields)
  if (lastLogged.get(family) !== line) {
    lastLogged.set(family, line)
    if (source === 'dedicated') console.info(`[internal-secret] ${line}`)
    else console.warn(`[internal-secret] ${line}`)
  }
  if (opts.fallback === false) return nonEmpty(process.env[dedicatedEnv])
  return nonEmpty(process.env[dedicatedEnv]) ?? nonEmpty(process.env[ROOT_INTERNAL_SECRET_ENV])
}

/** Test-only: forget what was logged, so a test can observe the first-resolution line. */
export function __resetInternalSecretLogForTests(): void {
  lastLogged.clear()
}
