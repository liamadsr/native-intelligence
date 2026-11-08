'use client'

/**
 * The person's environment for local agents, on the client: the folders on
 * their Macs the Native Intelligence agent can work in, in every chat until they remove one
 * (Liam, 10-21: "once I attach a folder, it's attached until I remove it").
 * One small external store, shared by the side panel's Environment card
 * (side-panels/environment-section.tsx) and the composer's + → Select folder…
 * (chat/composer-state.ts useComposerFolders), so a folder added from the chat
 * shows in the card at once.
 *
 *   read     GET /api/local-agent/environment: {devices, folders, worktrees}.
 *            On a consumer's mount (unless read within 5 s), after an add or
 *            a remove, and every 30 s while the panel is open and the page
 *            visible (useLocalEnvironment's `poll`). No other timer.
 *   add      the desktop's native picker (tauriBridge.localAgent.pickFolder,
 *            Rust's own edit confirm), then the relay's heartbeat
 *            (refreshLocalAgentDevice) so the server mirrors the new grant
 *            and gives it an id, then a read. That heartbeat is a rejoin: a
 *            Mac removed from Native Intelligence ("Remove this Mac") comes back this way,
 *            and only this way.
 *   remove   tauriBridge.localAgent.removeGrant on THIS Mac (a folder on
 *            another Mac is removed there), then the heartbeat, which revokes
 *            the server's mirror, then a read. Rust refuses while a local
 *            agent works in the folder: that refusal is the toast. A removed
 *            folder stays hidden until the server stops listing it, so a
 *            heartbeat that didn't land never brings it back.
 *
 * Desktop only for add and remove; the web shows the environment read-only.
 * Every bridge call answers a LocalAgentResult and never rejects.
 *
 * Environments (docs/plans/environments.md §6, migration 420), the second
 * half of this file: where a chat's work runs. Two more reads, neither on a
 * timer:
 *
 *   the list   GET /api/account/environments: your Macs, then the
 *              workspace's cloud environments you can see. When the
 *              composer's environment menu opens, when Settings →
 *              Environments or a project's panel mounts, and after an edit.
 *   a chat's   GET /api/account/environments/chat?conversationId=…: the
 *              environment the chat sends work to, and where that came from.
 *              Once per conversation (a fresh read is skipped), and again when
 *              the side panel opens. A chat with no id yet (a new one) reads
 *              it without the id: where a new chat here starts.
 *
 * A pick is PUT at once and shown at once (put back if it's refused). Both
 * caches are the window's workspace's (lib/workspace-fetch.ts, the workspace
 * its requests name): after a switch nothing of the last one is shown, and
 * the next read is the new one's.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { isDesktopApp } from '@/lib/platform'
import { tauriBridge, type LocalAgentDevice, type LocalAgentGrant, type LocalAgentResult, type LocalAgentStatus } from '@/lib/tauri-bridge'
import {
  NEW_CLOUD_NETWORK_ACCESS,
  isNetworkAccess,
  type ChatEnvironmentSource,
  type CloudEnvironment,
  type MacEnvironment,
  type MacFolder,
} from '@/lib/environments/types'
import { getClientWorkspaceId } from '@/lib/workspace-fetch'
import { refreshLocalAgentDevice, type HeartbeatResult } from './relay-core'

// ── Shapes ──────────────────────────────────────────────────────────────────

export interface EnvironmentDevice {
  id: string
  name: string
  online: boolean
}

export interface EnvironmentFolder {
  /** The server's id (device_folder.id). */
  id: string
  deviceId: string
  /** Rust's grant id, for a remove on this Mac. */
  grantId: string
  label: string
  /** Where it is on the Mac: the person's own view only (the model never gets it). */
  path: string
  mode: 'read' | 'edit'
  isGit: boolean
  deviceName: string
  online: boolean
}

export interface EnvironmentWorktree {
  sessionId: string
  folderId: string
  branch: string
  /** The edit job is live: its branch may still move. */
  live: boolean
}

export interface EnvironmentSnapshot {
  /** The first read landed. */
  loaded: boolean
  devices: readonly EnvironmentDevice[]
  /** Without any the person removed here that the server still lists. */
  folders: readonly EnvironmentFolder[]
  worktrees: readonly EnvironmentWorktree[]
  /** This Mac's device id, in the desktop app: its folders are the ones × removes. */
  thisDeviceId: string | null
  /** The desktop app with local agents available: Add folder… and × are offered. */
  canEdit: boolean
  /** The native picker (or the heartbeat after it) is open. */
  picking: boolean
  /** Folders being removed now. */
  removing: readonly string[]
}

// ── Pure pieces (exported for tests) ────────────────────────────────────────

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** A route answer as the environment, malformed rows dropped; null when it isn't one. */
export function parseEnvironment(json: unknown): Pick<EnvironmentSnapshot, 'devices' | 'folders' | 'worktrees'> | null {
  if (!json || typeof json !== 'object') return null
  const j = json as Record<string, unknown>
  if (!Array.isArray(j.folders)) return null
  const rows = (v: unknown) => (Array.isArray(v) ? v : []).filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
  const devices = rows(j.devices)
    .filter((d) => str(d.id))
    // Presence only: lastSeenAt moves every heartbeat and would redraw the card for nothing.
    .map((d): EnvironmentDevice => ({ id: str(d.id), name: str(d.name), online: d.online === true }))
  const folders = rows(j.folders)
    .filter((f) => str(f.id) && typeof f.label === 'string')
    .map(
      (f): EnvironmentFolder => ({
        id: str(f.id),
        deviceId: str(f.deviceId),
        grantId: str(f.grantId),
        label: str(f.label),
        path: str(f.path),
        mode: f.mode === 'edit' ? 'edit' : 'read',
        isGit: f.isGit === true,
        deviceName: str(f.deviceName),
        online: f.online === true,
      }),
    )
  const worktrees = rows(j.worktrees)
    .filter((w) => str(w.sessionId) && str(w.folderId) && str(w.branch))
    .map((w): EnvironmentWorktree => ({ sessionId: str(w.sessionId), folderId: str(w.folderId), branch: str(w.branch), live: w.live === true }))
  return { devices, folders, worktrees }
}

/** A Mac path with the home folder as `~` (`/Users/liam/code` → `~/code`). */
export function abbreviateHome(path: string): string {
  const m = /^\/(?:Users|home)\/[^/]+(?=\/|$)/.exec(path)
  return m ? `~${path.slice(m[0].length)}` : path
}

/** Where a folder sits: its parent, home abbreviated (`~/code/dial8-v2`); empty for a root. */
export function folderParent(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')
  if (cut <= 0) return ''
  return abbreviateHome(trimmed.slice(0, cut))
}

/** `text` at most `max` characters, cut in the middle (`claude/agent-…cal-fc09cf`). */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  const keep = Math.max(2, max - 1)
  const head = Math.ceil(keep / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`
}

/** Rust's refusal as a sentence ("a local agent is running…" → "A local agent is running…."). */
function sentence(text: string): string {
  const t = text.trim()
  if (!t) return ''
  const s = t[0].toUpperCase() + t.slice(1)
  return /[.!?]$/.test(s) ? s : `${s}.`
}

// ── Dependencies (injectable for tests) ─────────────────────────────────────

export interface EnvironmentDeps {
  fetch: typeof fetch
  isDesktop: () => boolean
  status: () => Promise<LocalAgentStatus>
  device: () => Promise<LocalAgentResult<LocalAgentDevice>>
  pickFolder: () => Promise<LocalAgentResult<LocalAgentGrant | null>>
  removeGrant: (grantId: string) => Promise<LocalAgentResult<void>>
  /** Stop one local agent on this Mac (removing its folder ends it). */
  stop: (jobId: string) => Promise<LocalAgentResult<void>>
  /** The relay's heartbeat now: the server mirrors this Mac's grants. Null when it didn't land. `rejoin` after an add. */
  refreshMirror: (opts?: { rejoin?: boolean }) => Promise<HeartbeatResult | null>
  now: () => number
  /** Wait between status reads while stopped agents exit. */
  sleep: (ms: number) => Promise<void>
  /** The window's workspace (the one its requests name): the environments caches are keyed by it. */
  workspaceId: () => string | null
}

const defaultDeps = (): EnvironmentDeps => ({
  fetch: (input, init) => fetch(input, init),
  isDesktop: isDesktopApp,
  status: () => tauriBridge.localAgent.status(),
  device: () => tauriBridge.localAgent.device(),
  pickFolder: () => tauriBridge.localAgent.pickFolder(),
  removeGrant: (grantId) => tauriBridge.localAgent.removeGrant(grantId),
  stop: (jobId) => tauriBridge.localAgent.stop(jobId),
  refreshMirror: (opts) => refreshLocalAgentDevice(undefined, opts),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  workspaceId: getClientWorkspaceId,
})

let deps: EnvironmentDeps | null = null
const d = (): EnvironmentDeps => (deps ??= defaultDeps())

// ── The store ───────────────────────────────────────────────────────────────

export const ENVIRONMENT_URL = '/api/local-agent/environment'
/** While the panel is open and the page visible, a read this often. */
export const ENVIRONMENT_POLL_MS = 30_000
/** A consumer mounting within this of the last read reads nothing. */
export const ENVIRONMENT_FRESH_MS = 5_000

interface StoreState {
  loaded: boolean
  devices: readonly EnvironmentDevice[]
  /** As the server listed them. */
  listed: readonly EnvironmentFolder[]
  worktrees: readonly EnvironmentWorktree[]
  thisDeviceId: string | null
  canEdit: boolean
  picking: boolean
  removing: readonly string[]
  /** Removed on this Mac, hidden until the server stops listing them. */
  hidden: readonly string[]
}

const EMPTY: StoreState = {
  loaded: false,
  devices: [],
  listed: [],
  worktrees: [],
  thisDeviceId: null,
  canEdit: false,
  picking: false,
  removing: [],
  hidden: [],
}

const SERVER_SNAPSHOT: EnvironmentSnapshot = {
  loaded: false,
  devices: [],
  folders: [],
  worktrees: [],
  thisDeviceId: null,
  canEdit: false,
  picking: false,
  removing: [],
}

let state: StoreState = EMPTY
let snapshot: EnvironmentSnapshot = SERVER_SNAPSHOT
/** The JSON of the last environment applied: an unchanged read changes nothing. */
let appliedKey = ''
let lastReadAt = 0
let readSeq = 0
let appliedSeq = 0
let inflight: Promise<void> | null = null
let desktopChecked: Promise<void> | null = null
const listeners = new Set<() => void>()

function toSnapshot(s: StoreState): EnvironmentSnapshot {
  const gone = new Set([...s.hidden, ...s.removing])
  const folders = gone.size ? s.listed.filter((f) => !gone.has(f.id)) : s.listed
  const shown = new Set(folders.map((f) => f.id))
  const worktrees = gone.size ? s.worktrees.filter((w) => shown.has(w.folderId)) : s.worktrees
  return {
    loaded: s.loaded,
    devices: s.devices,
    folders,
    worktrees,
    thisDeviceId: s.thisDeviceId,
    canEdit: s.canEdit,
    picking: s.picking,
    removing: s.removing,
  }
}

function set(patch: Partial<StoreState>): void {
  const next = { ...state, ...patch }
  if ((Object.keys(patch) as Array<keyof StoreState>).every((k) => next[k] === state[k])) return
  state = next
  snapshot = toSnapshot(state)
  for (const l of listeners) l()
}

export function getEnvironmentSnapshot(): EnvironmentSnapshot {
  return snapshot
}

export function getServerEnvironmentSnapshot(): EnvironmentSnapshot {
  return SERVER_SNAPSHOT
}

export function subscribeEnvironment(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

async function readOnce(): Promise<void> {
  const seq = ++readSeq
  let parsed: ReturnType<typeof parseEnvironment> = null
  try {
    const res = await d().fetch(ENVIRONMENT_URL, { cache: 'no-store' })
    parsed = res.ok ? parseEnvironment(await res.json().catch(() => null)) : null
  } catch {
    parsed = null
  }
  // A failed read keeps what is shown; a read older than one applied is dropped.
  if (!parsed || seq < appliedSeq) return
  appliedSeq = seq
  lastReadAt = d().now()
  const listedIds = new Set(parsed.folders.map((f) => f.id))
  const hidden = state.hidden.filter((id) => listedIds.has(id))
  const key = JSON.stringify(parsed)
  if (key === appliedKey && state.loaded) {
    if (hidden.length !== state.hidden.length) set({ hidden })
    return
  }
  appliedKey = key
  set({ loaded: true, devices: parsed.devices, listed: parsed.folders, worktrees: parsed.worktrees, hidden })
}

/**
 * Read the environment now. `maxAgeMs`: skip when a read landed that recently.
 * `force`: a read that starts after this call (an add or a remove just
 * changed the server), even while another is in flight.
 */
export function refreshEnvironment(opts: { maxAgeMs?: number; force?: boolean } = {}): Promise<void> {
  if (!opts.force && opts.maxAgeMs && state.loaded && d().now() - lastReadAt < opts.maxAgeMs) return Promise.resolve()
  if (inflight && !opts.force) return inflight
  const run = (inflight && opts.force ? inflight.then(readOnce) : readOnce()).finally(() => {
    if (inflight === run) inflight = null
  })
  inflight = run
  return run
}

/**
 * Whether this is the desktop app with local agents available, and this Mac's
 * device id. Once per session unless `force` (the + menu opening: they can be
 * switched on meanwhile).
 */
export function checkLocalAgents(opts: { force?: boolean } = {}): Promise<void> {
  if (desktopChecked && !opts.force) return desktopChecked
  const run = (async () => {
    if (!d().isDesktop()) {
      set({ canEdit: false, thisDeviceId: null })
      return
    }
    const [status, device] = await Promise.all([
      d().status().catch(() => null),
      d().device().catch(() => null),
    ])
    set({ canEdit: status?.available === true, thisDeviceId: device?.ok ? device.value.deviceId || null : state.thisDeviceId })
  })()
  desktopChecked = run
  return run
}

/** Add a folder to the environment: the Mac's picker, the heartbeat, a read. */
export async function addEnvironmentFolder(): Promise<void> {
  if (state.picking) return
  set({ picking: true })
  try {
    const picked = await d().pickFolder()
    if (!picked.ok) {
      if (picked.unavailable) set({ canEdit: false })
      toast.error("Couldn't open the folder picker", { description: picked.error || undefined })
      return
    }
    // The person cancelled the picker.
    if (!picked.value) return
    const grant = picked.value
    // A folder picked on this Mac brings it back if it was removed from Native Intelligence.
    const mirror = await d().refreshMirror({ rejoin: true }).catch(() => null)
    const row = mirror?.folders.find((f) => f.grantId === grant.id)
    if (!row) {
      toast.error("Couldn't add the folder", { description: mirror ? 'Native Intelligence did not register it. Try again.' : "Native Intelligence couldn't be reached. Try again." })
      return
    }
    // Picked again after a remove whose revoke hadn't landed: it shows again.
    if (state.hidden.includes(row.id)) set({ hidden: state.hidden.filter((id) => id !== row.id) })
    await refreshEnvironment({ force: true })
  } finally {
    set({ picking: false })
  }
}

/** Rust refuses to remove a grant while a launcher runs in that folder. */
const RUNNING_IN_FOLDER = /running in this folder/i
/** How long stopped local agents get to exit before the remove is retried. */
export const STOP_WAIT_MS = 8_000
const STOP_POLL_MS = 300

/**
 * End the local agents running in a folder before it is removed (Liam,
 * 2026-10-21: removing a folder shouldn't fail because a finished agent is
 * idle there). Idle ones (their turn ended) are stopped without asking; one
 * still working is stopped only with `stopWorking`, else 'working' comes back
 * so the person can choose. Then waits until none is live, up to STOP_WAIT_MS.
 */
async function endLocalAgentsIn(grantId: string, stopWorking: boolean): Promise<'stopped' | 'working'> {
  const live = async () => ((await d().status().catch(() => null))?.jobs ?? []).filter((j) => j.grantId === grantId && j.live)
  const jobs = await live()
  if (!stopWorking && jobs.some((j) => j.status === 'running' || j.status === 'starting')) return 'working'
  await Promise.all(jobs.map((j) => d().stop(j.id).catch(() => null)))
  const deadline = d().now() + STOP_WAIT_MS
  while ((await live()).length > 0 && d().now() < deadline) await d().sleep(STOP_POLL_MS)
  return 'stopped'
}

/**
 * Remove a folder from the environment: on this Mac, then the heartbeat, then
 * a read. Local agents idle in it are ended first; one still working is ended
 * only after the person says so (`stopWorking`, from the toast's action).
 */
export async function removeEnvironmentFolder(folderId: string, opts: { stopWorking?: boolean } = {}): Promise<void> {
  const folder = state.listed.find((f) => f.id === folderId)
  if (!folder || state.removing.includes(folderId) || state.hidden.includes(folderId)) return
  if (!state.canEdit || !state.thisDeviceId || folder.deviceId !== state.thisDeviceId) {
    toast.error(`Remove ${folder.label} in Native Intelligence on ${folder.deviceName || 'the Mac it is on'}`)
    return
  }
  set({ removing: [...state.removing, folderId] })
  try {
    let removed = await d().removeGrant(folder.grantId)
    if (!removed.ok && RUNNING_IN_FOLDER.test(removed.error)) {
      if ((await endLocalAgentsIn(folder.grantId, opts.stopWorking === true)) === 'working') {
        toast.error(`A local agent is working in ${folder.label}`, {
          description: 'Stop it and remove the folder?',
          action: { label: 'Stop and remove', onClick: () => void removeEnvironmentFolder(folderId, { stopWorking: true }) },
        })
        return
      }
      removed = await d().removeGrant(folder.grantId)
    }
    // A grant this Mac no longer has is gone already: the heartbeat revokes the mirror.
    if (!removed.ok && !/unknown folder/i.test(removed.error)) {
      toast.error(`Couldn't remove ${folder.label}`, { description: sentence(removed.error) || undefined })
      return
    }
    set({ hidden: [...state.hidden, folderId] })
    await d().refreshMirror().catch(() => null)
    await refreshEnvironment({ force: true })
  } finally {
    set({ removing: state.removing.filter((id) => id !== folderId) })
  }
}

/**
 * The environment, live. Reads on mount (unless read within 5 s) and checks
 * the desktop once; with `poll`, again every 30 s while the page is visible
 * and when it comes back. Off (`enabled: false`): nothing read, nothing shown.
 */
export function useLocalEnvironment({ enabled = true, poll = false }: { enabled?: boolean; poll?: boolean } = {}): EnvironmentSnapshot {
  const snap = useSyncExternalStore(subscribeEnvironment, getEnvironmentSnapshot, getServerEnvironmentSnapshot)
  useEffect(() => {
    if (!enabled) return
    void checkLocalAgents()
    void refreshEnvironment({ maxAgeMs: ENVIRONMENT_FRESH_MS })
  }, [enabled])
  useEffect(() => {
    if (!enabled || !poll || typeof document === 'undefined') return
    void refreshEnvironment({ maxAgeMs: ENVIRONMENT_FRESH_MS })
    const visible = () => document.visibilityState === 'visible'
    const timer = setInterval(() => {
      if (visible()) void refreshEnvironment()
    }, ENVIRONMENT_POLL_MS)
    const onVisibility = () => {
      if (visible()) void refreshEnvironment({ maxAgeMs: ENVIRONMENT_POLL_MS })
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [enabled, poll])
  return enabled ? snap : SERVER_SNAPSHOT
}

// ── Environments: the list and each chat's (migration 420) ─────────────────

/** A Mac as the list gives it, plus whether its app branches edit jobs from a base branch (E3; missing: false). */
export interface MacEnvironmentItem extends MacEnvironment {
  supportsBaseBranch: boolean
}

/** One environment as the routes give it. */
export type EnvironmentItem = MacEnvironmentItem | CloudEnvironment

/** Where a chat's environment came from: its own pick, your default here, your Mac, the workspace's default cloud, or nothing. */
export type { ChatEnvironmentSource }

export interface EnvironmentsSnapshot {
  /** The first read landed. */
  loaded: boolean
  /** Your Macs first (the most recently online first), then the workspace's cloud environments. */
  environments: readonly EnvironmentItem[]
  /** Your own default for this workspace (a pick in a chat with no id yet sets it). */
  defaultEnvironmentId: string | null
}

export interface ChatEnvironment {
  loaded: boolean
  environmentId: string | null
  source: ChatEnvironmentSource
  environment: EnvironmentItem | null
}

export const ENVIRONMENTS_URL = '/api/account/environments'
export const CHAT_ENVIRONMENT_URL = '/api/account/environments/chat'
export const DEFAULT_ENVIRONMENT_URL = '/api/account/environments/default'
/** A list read this recent is reused (the menu opening twice, a panel remounting). */
export const ENVIRONMENTS_FRESH_MS = 5_000
/** A chat's environment read this recent is reused (a remount, the side panel opening again). */
export const CHAT_ENVIRONMENT_FRESH_MS = 30_000

const CHAT_SOURCES: readonly ChatEnvironmentSource[] = ['chat', 'default', 'mac', 'workspace', 'none']
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function parseMacFolder(f: Record<string, unknown>): MacFolder | null {
  if (!str(f.id) || typeof f.label !== 'string') return null
  return {
    id: str(f.id),
    label: str(f.label),
    mode: f.mode === 'edit' ? 'edit' : 'read',
    isGit: f.isGit === true,
    baseBranch: strOrNull(f.baseBranch),
    repoFullName: strOrNull(f.repoFullName),
  }
}

/** One environment from a route, or null when it isn't one. A Mac without `supportsBaseBranch` can't take a base branch. */
export function parseEnvironmentItem(raw: unknown): EnvironmentItem | null {
  if (!isRecord(raw) || !str(raw.id) || typeof raw.name !== 'string') return null
  if (raw.kind === 'mac') {
    return {
      kind: 'mac',
      id: str(raw.id),
      name: str(raw.name),
      deviceId: str(raw.deviceId),
      deviceName: str(raw.deviceName),
      appVersion: str(raw.appVersion),
      lastSeenAt: strOrNull(raw.lastSeenAt),
      online: raw.online === true,
      folders: (Array.isArray(raw.folders) ? raw.folders : []).flatMap((f) => (isRecord(f) ? (parseMacFolder(f) ?? []) : [])),
      createdAt: str(raw.createdAt),
      updatedAt: str(raw.updatedAt),
      supportsBaseBranch: raw.supportsBaseBranch === true,
    }
  }
  if (raw.kind === 'cloud') {
    const canEdit = raw.canEdit === true
    return {
      kind: 'cloud',
      id: str(raw.id),
      name: str(raw.name),
      workspaceId: str(raw.workspaceId),
      shared: raw.shared === true,
      networkAccess: isNetworkAccess(raw.networkAccess) ? raw.networkAccess : NEW_CLOUD_NETWORK_ACCESS,
      createdBy: strOrNull(raw.createdBy),
      canEdit,
      envVars: canEdit && typeof raw.envVars === 'string' ? raw.envVars : null,
      setupScript: canEdit && typeof raw.setupScript === 'string' ? raw.setupScript : null,
      secretsHidden: raw.secretsHidden === true || !canEdit,
      hasEnvVars: raw.hasEnvVars === true,
      hasSetupScript: raw.hasSetupScript === true,
      isWorkspaceDefault: raw.isWorkspaceDefault === true,
      projectCount: typeof raw.projectCount === 'number' ? raw.projectCount : 0,
      archivedAt: strOrNull(raw.archivedAt),
      createdAt: str(raw.createdAt),
      updatedAt: str(raw.updatedAt),
    }
  }
  return null
}

/** GET /api/account/environments as the list, or null when it isn't one. Archived ones are dropped. */
export function parseEnvironmentList(json: unknown): Omit<EnvironmentsSnapshot, 'loaded'> | null {
  if (!isRecord(json) || !Array.isArray(json.environments)) return null
  const environments = json.environments.flatMap((e) => {
    const item = parseEnvironmentItem(e)
    return item && !(item.kind === 'cloud' && item.archivedAt) ? [item] : []
  })
  return { environments, defaultEnvironmentId: strOrNull(json.defaultEnvironmentId) }
}

/** GET /api/account/environments/chat as the chat's environment, or null when it isn't one. */
export function parseChatEnvironment(json: unknown): Omit<ChatEnvironment, 'loaded'> | null {
  if (!isRecord(json)) return null
  const environment = parseEnvironmentItem(json.environment)
  const source = (CHAT_SOURCES as readonly unknown[]).includes(json.source) ? (json.source as ChatEnvironmentSource) : environment ? 'chat' : 'none'
  return { environmentId: environment?.id ?? strOrNull(json.environmentId), source: environment ? source : 'none', environment }
}

/** A refusal's sentence from an api-errors body ({ error, code }), or the fallback. */
export async function readRefusal(res: Response, fallback: string): Promise<{ error: string; code: string | null }> {
  const body = (await res.json().catch(() => null)) as { error?: unknown; code?: unknown } | null
  return { error: typeof body?.error === 'string' && body.error ? body.error : fallback, code: typeof body?.code === 'string' ? body.code : null }
}

// Every cache below is the window's workspace's (the one its requests name,
// lib/workspace-fetch.ts): a switch reads afresh rather than show another
// workspace's list or new-chat default.
const ws = (): string => d().workspaceId() ?? ''

// The list: the window's workspace's, one at a time.
const EMPTY_LIST: EnvironmentsSnapshot = { loaded: false, environments: [], defaultEnvironmentId: null }
let list: EnvironmentsSnapshot = EMPTY_LIST
/** The workspace `list` is. */
let listWs = ''
let listKey = ''
let listReadAt = 0
let listSeq = 0
let listAppliedSeq = 0
let listInflight: { ws: string; run: Promise<void> } | null = null

// Each chat's, by workspace and conversation id; a chat with no id yet (a new one) by the workspace alone.
const chatKey = (workspace: string, conversationId: string | null): string => `${workspace} ${conversationId ?? ''}`
function splitChatKey(key: string): { workspace: string; conversationId: string | null } {
  const cut = key.indexOf(' ')
  return { workspace: key.slice(0, cut), conversationId: key.slice(cut + 1) || null }
}
const EMPTY_CHAT: ChatEnvironment = { loaded: false, environmentId: null, source: 'none', environment: null }
const chats = new Map<string, ChatEnvironment>()
const chatReadAt = new Map<string, number>()
const chatSeq = new Map<string, number>()
const chatInflight = new Map<string, Promise<void>>()
let chatSeqCounter = 0

const envListeners = new Set<() => void>()
function emitEnvironments(): void {
  for (const l of envListeners) l()
}
export function subscribeEnvironments(listener: () => void): () => void {
  envListeners.add(listener)
  return () => {
    envListeners.delete(listener)
  }
}
/** The list of the window's workspace (none read yet: not loaded). */
export function getEnvironmentsSnapshot(): EnvironmentsSnapshot {
  return listWs === ws() ? list : EMPTY_LIST
}
const getServerEnvironmentsSnapshot = (): EnvironmentsSnapshot => EMPTY_LIST
export function getChatEnvironmentSnapshot(conversationId: string | null): ChatEnvironment {
  return chats.get(chatKey(ws(), conversationId)) ?? EMPTY_CHAT
}
/** The list is the window's workspace's and has been read. */
const listHere = (): boolean => list.loaded && listWs === ws()

function setList(workspace: string, next: Omit<EnvironmentsSnapshot, 'loaded'>): void {
  const key = JSON.stringify(next)
  if (workspace === listWs && key === listKey && list.loaded) return
  listWs = workspace
  listKey = key
  list = { loaded: true, ...next }
  emitEnvironments()
}

function setChat(key: string, next: ChatEnvironment): void {
  const prev = chats.get(key)
  if (prev && prev.loaded === next.loaded && prev.environmentId === next.environmentId && prev.source === next.source && JSON.stringify(prev.environment) === JSON.stringify(next.environment)) return
  chats.set(key, next)
  emitEnvironments()
}

async function readList(): Promise<void> {
  const workspace = ws()
  const seq = ++listSeq
  let parsed: ReturnType<typeof parseEnvironmentList> = null
  try {
    const res = await d().fetch(ENVIRONMENTS_URL, { cache: 'no-store' })
    parsed = res.ok ? parseEnvironmentList(await res.json().catch(() => null)) : null
  } catch {
    parsed = null
  }
  // A failed read keeps what is shown; a read older than one applied, or for a workspace the window has left, is dropped.
  if (!parsed || seq < listAppliedSeq || workspace !== ws()) return
  listAppliedSeq = seq
  listReadAt = d().now()
  setList(workspace, parsed)
}

/** Read the list now. `maxAgeMs`: skip when a read landed that recently. `force`: a read that starts after this call. */
export function refreshEnvironments(opts: { maxAgeMs?: number; force?: boolean } = {}): Promise<void> {
  const workspace = ws()
  if (!opts.force && opts.maxAgeMs && listHere() && d().now() - listReadAt < opts.maxAgeMs) return Promise.resolve()
  const running = listInflight?.ws === workspace ? listInflight.run : null
  if (running && !opts.force) return running
  const run = (running && opts.force ? running.then(readList) : readList()).finally(() => {
    if (listInflight?.run === run) listInflight = null
  })
  listInflight = { ws: workspace, run }
  return run
}

async function readChat(key: string): Promise<void> {
  const { conversationId } = splitChatKey(key)
  const seq = ++chatSeqCounter
  chatSeq.set(key, seq)
  let parsed: ReturnType<typeof parseChatEnvironment> = null
  try {
    // No id: where a new chat here would start (the route's own order, from your default on).
    const url = conversationId ? `${CHAT_ENVIRONMENT_URL}?conversationId=${encodeURIComponent(conversationId)}` : CHAT_ENVIRONMENT_URL
    const res = await d().fetch(url, { cache: 'no-store' })
    parsed = res.ok ? parseChatEnvironment(await res.json().catch(() => null)) : null
  } catch {
    parsed = null
  }
  // A newer read (or a pick) since this one started wins.
  if (!parsed || chatSeq.get(key) !== seq) return
  chatReadAt.set(key, d().now())
  setChat(key, { loaded: true, ...parsed })
}

function refreshChatKey(key: string, opts: { maxAgeMs?: number; force?: boolean }): Promise<void> {
  const readAt = chatReadAt.get(key)
  if (!opts.force && opts.maxAgeMs && readAt !== undefined && chats.get(key)?.loaded && d().now() - readAt < opts.maxAgeMs) {
    return Promise.resolve()
  }
  const running = chatInflight.get(key)
  if (running && !opts.force) return running
  const run = (running && opts.force ? running.then(() => readChat(key)) : readChat(key)).finally(() => {
    if (chatInflight.get(key) === run) chatInflight.delete(key)
  })
  chatInflight.set(key, run)
  return run
}

/** Read a chat's environment now (`maxAgeMs`: unless read that recently). Null: a new chat's. */
export function refreshChatEnvironment(conversationId: string | null, opts: { maxAgeMs?: number; force?: boolean } = {}): Promise<void> {
  return refreshChatKey(chatKey(ws(), conversationId), opts)
}

/**
 * Send this chat's work to an environment (C-A PUT), shown at once and put
 * back when refused. The server records it as your default here too, so a
 * new chat starts on it; a chat with no id yet sets only that. True when it
 * took.
 */
export async function pickChatEnvironment(conversationId: string | null, environment: EnvironmentItem): Promise<boolean> {
  const workspace = ws()
  const key = chatKey(workspace, conversationId)
  const newChat = chatKey(workspace, null)
  const was = chats.get(key)
  // A read in flight now is older than the pick: it is dropped when it lands.
  chatSeq.set(key, ++chatSeqCounter)
  setChat(key, { loaded: true, environmentId: environment.id, source: conversationId ? 'chat' : 'default', environment })
  const ok = await put(CHAT_ENVIRONMENT_URL, conversationId ? { conversationId, environmentId: environment.id } : { environmentId: environment.id })
  if (ok) {
    const now = d().now()
    chatReadAt.set(key, now)
    // Your default here is this one now: a new chat starts on it.
    if (key !== newChat) {
      chatSeq.set(newChat, ++chatSeqCounter)
      chatReadAt.set(newChat, now)
      setChat(newChat, { loaded: true, environmentId: environment.id, source: 'default', environment })
    }
    if (list.loaded && listWs === workspace && list.defaultEnvironmentId !== environment.id) {
      setList(workspace, { environments: list.environments, defaultEnvironmentId: environment.id })
    }
  } else if (chats.get(key)?.environmentId === environment.id) {
    if (was) setChat(key, was)
    else {
      chats.delete(key)
      emitEnvironments()
    }
  }
  return ok
}

async function put(url: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await d().fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (res.ok) return true
    toast.error("Couldn't switch the environment", { description: (await readRefusal(res, 'Try again.')).error })
  } catch {
    toast.error("Couldn't switch the environment", { description: "Native Intelligence couldn't be reached. Try again." })
  }
  return false
}

/** An environment saved or made (Edit environment): the list and every chat showing it take it at once. */
export function applyEnvironment(next: EnvironmentItem): void {
  const here = listHere()
  const prev = here ? list.environments.find((e) => e.id === next.id) : undefined
  // A PATCH answer may not say what the Mac's app supports: what the list said stands.
  const merged: EnvironmentItem =
    next.kind === 'mac' && prev?.kind === 'mac' ? { ...next, supportsBaseBranch: next.supportsBaseBranch || prev.supportsBaseBranch } : next
  if (here) {
    const environments = prev ? list.environments.map((e) => (e.id === merged.id ? merged : e)) : [...list.environments, merged]
    setList(listWs, { environments, defaultEnvironmentId: list.defaultEnvironmentId })
  }
  // A Mac is the same in every workspace: every chat showing it takes it.
  for (const [key, chat] of chats) {
    if (chat.environment?.id === merged.id) {
      const keep = chat.environment.kind === 'mac' && merged.kind === 'mac' ? { ...merged, supportsBaseBranch: merged.supportsBaseBranch || chat.environment.supportsBaseBranch } : merged
      setChat(key, { ...chat, environment: keep })
    }
  }
}

/** A Mac folder's two settings saved: every Mac showing that folder takes them. */
export function applyFolderSetting(folderId: string, setting: { baseBranch: string | null; repoFullName: string | null }): void {
  const patch = (e: EnvironmentItem): EnvironmentItem =>
    e.kind === 'mac' && e.folders.some((f) => f.id === folderId)
      ? { ...e, folders: e.folders.map((f) => (f.id === folderId ? { ...f, ...setting } : f)) }
      : e
  if (listHere()) setList(listWs, { environments: list.environments.map(patch), defaultEnvironmentId: list.defaultEnvironmentId })
  for (const [key, chat] of chats) if (chat.environment) setChat(key, { ...chat, environment: patch(chat.environment) })
}

/**
 * An environment archived or a Mac removed: it leaves the list, and the chats
 * that used it read where they run now (another workspace's, when it is next
 * shown).
 */
export function forgetEnvironment(environmentId: string): void {
  if (listHere() && list.environments.some((e) => e.id === environmentId)) {
    setList(listWs, {
      environments: list.environments.filter((e) => e.id !== environmentId),
      defaultEnvironmentId: list.defaultEnvironmentId === environmentId ? null : list.defaultEnvironmentId,
    })
  }
  const workspace = ws()
  for (const [key, chat] of [...chats]) {
    if (chat.environmentId !== environmentId) continue
    if (splitChatKey(key).workspace === workspace) void refreshChatKey(key, { force: true })
    else {
      chats.delete(key)
      chatReadAt.delete(key)
    }
  }
}

/**
 * The list, live: the window's workspace's. `read`: read it on mount and when
 * the workspace changes (unless read within ENVIRONMENTS_FRESH_MS). Off
 * (`enabled: false`): nothing read, nothing shown.
 */
export function useEnvironments({ enabled = true, read = true }: { enabled?: boolean; read?: boolean } = {}): EnvironmentsSnapshot {
  const workspace = ws()
  const snap = useSyncExternalStore(subscribeEnvironments, getEnvironmentsSnapshot, getServerEnvironmentsSnapshot)
  useEffect(() => {
    if (enabled && read) void refreshEnvironments({ maxAgeMs: ENVIRONMENTS_FRESH_MS })
  }, [enabled, read, workspace])
  return enabled ? snap : EMPTY_LIST
}

/**
 * Where this chat's work runs, live: read once per conversation and
 * workspace (unless read within CHAT_ENVIRONMENT_FRESH_MS). A chat with no id
 * yet: where a new chat in this workspace starts (your default here, else your
 * Mac, else the workspace's default cloud). Off: nothing read.
 */
export function useChatEnvironment(conversationId: string | null, { enabled = true }: { enabled?: boolean } = {}): ChatEnvironment {
  const key = chatKey(ws(), conversationId)
  const getSnap = useMemo(() => () => chats.get(key) ?? EMPTY_CHAT, [key])
  const chat = useSyncExternalStore(subscribeEnvironments, getSnap, () => EMPTY_CHAT)
  useEffect(() => {
    if (enabled) void refreshChatKey(key, { maxAgeMs: CHAT_ENVIRONMENT_FRESH_MS })
  }, [enabled, key])
  return enabled ? chat : EMPTY_CHAT
}

/** Test seam: swap the dependencies (merged over the defaults), or reset them with null. */
export function configureEnvironment(over: Partial<EnvironmentDeps> | null): void {
  deps = over ? { ...defaultDeps(), ...over } : null
}

/** Test seam: forget everything read and checked. */
export function resetEnvironmentStore(): void {
  state = EMPTY
  snapshot = SERVER_SNAPSHOT
  appliedKey = ''
  lastReadAt = 0
  readSeq = 0
  appliedSeq = 0
  inflight = null
  desktopChecked = null
  list = EMPTY_LIST
  listWs = ''
  listKey = ''
  listReadAt = 0
  listSeq = 0
  listAppliedSeq = 0
  listInflight = null
  chats.clear()
  chatReadAt.clear()
  chatSeq.clear()
  chatInflight.clear()
  chatSeqCounter = 0
}
