/**
 * Environments (docs/plans/environments.md §3, migration 420): where an
 * agent's work runs. Two kinds:
 *
 *   mac    one of the person's Macs: exactly one environment per Mac, named
 *          after it. Its folders are the Mac's live grants (device_folder),
 *          each with the grant's mode ceiling and two settings the web may
 *          change, a base branch (E3) and a linked repo.
 *   cloud  a workspace's settings for a fresh Vercel Sandbox per run: a
 *          network level, env vars and a setup script. No repos: the repo
 *          comes from the work. Shared with the workspace, or only its
 *          creator's.
 *
 * Client-safe: the types, limits and validators the routes, the server
 * library and the SQL CHECKs share (the patterns are pinned against
 * migration 420 by its test). Nothing here carries a folder's path: a
 * model may see these shapes, and a path never reaches one.
 */

export type EnvironmentKind = 'mac' | 'cloud'
export type NetworkAccess = 'trusted' | 'restricted' | 'isolated'
export type FolderMode = 'read' | 'edit'

export const NETWORK_ACCESS: readonly NetworkAccess[] = ['trusted', 'restricted', 'isolated']
/** A new cloud environment starts restricted (GitHub + the npm registry): open egress is a choice. */
export const NEW_CLOUD_NETWORK_ACCESS: NetworkAccess = 'restricted'
/** What a run with no environment gets, and what the backfill's "Default cloud" keeps. */
export const NO_ENVIRONMENT_NETWORK_ACCESS: NetworkAccess = 'trusted'

/** migration 420's check: char_length(name) between 1 and 80. */
export const ENVIRONMENT_NAME_MAX = 80
/** A Mac environment's name when the Mac sent none (migration 420's backfill says the same). */
export const MAC_ENVIRONMENT_FALLBACK_NAME = 'My Mac'
/** The backfill's per-workspace default (trusted). */
export const DEFAULT_CLOUD_NAME = 'Default cloud'
/** A cloud environment's env vars and setup script, at most this many bytes each (migration 420's checks). */
export const ENV_TEXT_MAX_BYTES = 65_536

/** A base branch for edit jobs: a local branch name (migration 420's check; Rust checks it again in E3). */
export const BASE_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/
/** …and none of these: HEAD itself, a `refs/` name, `..`, `//`, `@{`, a `.lock` or `/` or `.` ending (Rust refuses the same). */
export const BASE_BRANCH_FORBIDDEN_RE = /(^HEAD$|^refs\/|[.][.]|\/\/|@[{]|[.]lock$|\/$|[.]$)/
/** owner/repo, as GitHub allows them (migration 420's check). */
export const REPO_FULL_NAME_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/

export function isNetworkAccess(v: unknown): v is NetworkAccess {
  return typeof v === 'string' && (NETWORK_ACCESS as readonly string[]).includes(v)
}

export function isBaseBranch(v: unknown): v is string {
  return typeof v === 'string' && BASE_BRANCH_RE.test(v) && !BASE_BRANCH_FORBIDDEN_RE.test(v)
}

export function isRepoFullName(v: unknown): v is string {
  return typeof v === 'string' && REPO_FULL_NAME_RE.test(v)
}

/** The first `max` characters, by code point (Postgres' char_length), never splitting a surrogate pair. */
export function clipChars(s: string, max: number): string {
  const chars = Array.from(s)
  return chars.length <= max ? s : chars.slice(0, max).join('')
}

/**
 * The whitespace a Mac's name loses at either end: space, tab, newline,
 * vertical tab, form feed, carriage return. Migration 420's backfill trims
 * the same six (btrim with chr(9) to chr(13)), so a name made there and one
 * made here agree.
 */
const MAC_NAME_EDGE_WHITESPACE = /^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g

/** A Mac environment's name from its device's: trimmed, the fallback when empty, at most 80 characters. */
export function macEnvironmentName(deviceName: string | null | undefined): string {
  const trimmed = typeof deviceName === 'string' ? deviceName.replace(MAC_NAME_EDGE_WHITESPACE, '') : ''
  return clipChars(trimmed || MAC_ENVIRONMENT_FALLBACK_NAME, ENVIRONMENT_NAME_MAX)
}

/** UTF-8 bytes of a string (Postgres' octet_length), in the browser and on the server alike. */
export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length
}

/** A folder of a Mac environment: one live grant. No path, ever. */
export interface MacFolder {
  /** The device_folder id: jobs and settings name this. */
  id: string
  label: string
  /** The grant's ceiling, set only by the Mac's native confirm. */
  mode: FolderMode
  isGit: boolean
  /** Edit jobs branch from this local branch (E3); null: HEAD. */
  baseBranch: string | null
  /** The linked repo (owner/repo) for the offline fallback. */
  repoFullName: string | null
}

export interface MacEnvironment {
  kind: 'mac'
  id: string
  name: string
  deviceId: string
  /** The device's own name, as the Mac reports it. */
  deviceName: string
  appVersion: string
  lastSeenAt: string | null
  /** A heartbeat within 120 s (ONLINE_WINDOW_MS). */
  online: boolean
  /**
   * The Mac's app resolves a base branch for edit jobs (E3: its heartbeat
   * says `baseBranch`). Show the base-branch field only when true; an older
   * app branches from HEAD whatever is set.
   */
  supportsBaseBranch: boolean
  folders: MacFolder[]
  createdAt: string
  updatedAt: string
}

/**
 * What a Mac's app can say it does, in its heartbeat (user_device.capabilities,
 * migration 420). The server keeps only these names.
 */
export const MAC_CAPABILITIES = ['baseBranch'] as const
export type MacCapability = (typeof MAC_CAPABILITIES)[number]

export function isMacCapability(v: unknown): v is MacCapability {
  return typeof v === 'string' && (MAC_CAPABILITIES as readonly string[]).includes(v)
}

export interface CloudEnvironment {
  kind: 'cloud'
  id: string
  name: string
  workspaceId: string
  /** Every member may use it; false: only its creator (admins can still see it). */
  shared: boolean
  networkAccess: NetworkAccess
  createdBy: string | null
  /** The creator or a workspace admin: sees the env vars and setup script, and may edit or archive it. */
  canEdit: boolean
  /** The plaintext .env text, or null when there is none or it is hidden (secretsHidden). */
  envVars: string | null
  setupScript: string | null
  /** True when envVars and setupScript are withheld from this viewer. */
  secretsHidden: boolean
  hasEnvVars: boolean
  hasSetupScript: boolean
  /** The workspace's default cloud environment (runs with no project environment use it). */
  isWorkspaceDefault: boolean
  /** Projects using it. */
  projectCount: number
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export type Environment = MacEnvironment | CloudEnvironment

/**
 * Where a chat's environment came from (plan §7 Q1), in the order it is
 * looked for: the chat's own, the person's default for the chat's workspace
 * (the one they picked last there), their first Mac (online first, then the
 * first added), the workspace's default cloud environment, else none. The
 * first turn or start that resolves it pins it on the chat.
 */
export type ChatEnvironmentSource = 'chat' | 'default' | 'mac' | 'workspace' | 'none'

/** GET /api/account/environments/chat. */
export interface ChatEnvironmentView {
  environmentId: string | null
  source: ChatEnvironmentSource
  /** As GET /api/account/environments shows it; null with source 'none'. */
  environment: Environment | null
}

/** A cloud run's sandbox settings, as resolveRunEnvironment found them. */
export interface RunEnvironment {
  environmentId: string
  name: string
  /** Where it came from: the run's own, its project's, or the workspace default. */
  source: 'run' | 'project' | 'workspace'
  networkAccess: NetworkAccess
  /** Raw .env text (parse it with parseEnvText). */
  envVars: string | null
  setupScript: string | null
}

export type EnvironmentErrorCode = 'not_found' | 'bad_request' | 'forbidden' | 'conflict'

/** A refusal the routes turn into an api-errors response (src/lib/environments/http.ts). */
export class EnvironmentError extends Error {
  constructor(
    readonly code: EnvironmentErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'EnvironmentError'
  }
}

/** A cloud environment a project or the workspace default uses can't become "only me" (409 details.code). */
export const ENVIRONMENT_IN_USE_CODE = 'ENVIRONMENT_IN_USE'
/** "Remove this Mac" while a local agent is live on it (409 details.code). */
export const MAC_BUSY_CODE = 'MAC_BUSY'
/** A run whose own environment was archived or can't be used any more: it fails rather than run elsewhere. */
export const RUN_ENVIRONMENT_UNUSABLE_CODE = 'RUN_ENVIRONMENT_UNUSABLE'
