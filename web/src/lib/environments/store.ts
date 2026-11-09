/**
 * Environments: typed DB operations over migration 420 (docs/plans/
 * environments.md §3–§5). The routes under /api/account/environments call
 * these; E2's routing and UI build on them.
 *
 * `svc` is always a SERVICE-ROLE client: the tables have SELECT-only RLS,
 * and env_vars / setup_script are not selectable by clients at all. Every
 * function therefore checks who may see or change what itself, and is the
 * validation boundary for what it is handed:
 *   a Mac environment     its owner only (it works in all their workspaces);
 *   a cloud environment   seen by workspace members when shared, else by its
 *                         creator, and by workspace admins always; changed
 *                         and archived by its creator or an admin, who are
 *                         also the only ones who see its env vars and setup
 *                         script (masked for everyone else).
 * A row someone may not see reads as missing (not_found), never forbidden.
 *
 * What the web may do to a Mac (§5): rename it, set a folder's base branch
 * and linked repo, and remove it. Never add a folder, raise one above its
 * grant, or send it env vars or a script: those stay the Mac's.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  FOLDER_HOLDING_STATUSES,
  SESSION_SELECT,
  isOnline,
  isUuid,
  reapIfStale,
  type DbSession,
} from '@/lib/local-agent/store'
import { ensureMacEnvironment } from './mac'
import {
  ENVIRONMENT_IN_USE_CODE,
  ENVIRONMENT_NAME_MAX,
  ENV_TEXT_MAX_BYTES,
  EnvironmentError,
  MAC_BUSY_CODE,
  NEW_CLOUD_NETWORK_ACCESS,
  isBaseBranch,
  isNetworkAccess,
  isRepoFullName,
  macEnvironmentName,
  utf8Bytes,
  type CloudEnvironment,
  type Environment,
  type FolderMode,
  type MacCapability,
  type MacEnvironment,
  type MacFolder,
  type NetworkAccess,
} from './types'

export { ensureMacEnvironment }

type Svc = SupabaseClient

// ── Rows ────────────────────────────────────────────────────────────────────

export interface DbEnvironment {
  id: string
  kind: 'mac' | 'cloud'
  name: string
  owner_user_id: string | null
  device_id: string | null
  workspace_id: string | null
  created_by: string | null
  shared: boolean | null
  network_access: NetworkAccess | null
  env_vars: string | null
  setup_script: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
}

const ENV_FIELDS =
  'id, kind, name, owner_user_id, device_id, workspace_id, created_by, shared, network_access, env_vars, setup_script, archived_at, created_at, updated_at'

function nowIso(): string {
  return new Date().toISOString()
}

/** The device's capabilities column (migration 420) says it can do `what`. */
export function hasCapability(capabilities: unknown, what: MacCapability): boolean {
  return Array.isArray(capabilities) && capabilities.includes(what)
}

export async function loadEnvironmentRow(svc: Svc, environmentId: string): Promise<DbEnvironment | null> {
  if (!isUuid(environmentId)) return null
  const { data, error } = await svc.from('environment').select(ENV_FIELDS).eq('id', environmentId).maybeSingle()
  if (error) throw new Error(`environment read failed: ${error.message}`)
  return (data as DbEnvironment | null) ?? null
}

/** The person's role in the workspace, or null when they aren't a member. */
export async function memberRole(svc: Svc, userId: string, workspaceId: string): Promise<string | null> {
  if (!isUuid(workspaceId)) return null
  const { data, error } = await svc
    .from('member')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`membership read failed: ${error.message}`)
  return (data as { role?: string | null } | null)?.role ?? null
}

function isAdminRole(role: string | null): boolean {
  return role === 'owner' || role === 'admin'
}

/** A cloud row this person may see (the RLS policy's rule): admins always, members when shared or theirs. */
function cloudVisible(row: DbEnvironment, userId: string, role: string | null): boolean {
  if (!role) return false
  return isAdminRole(role) || row.shared === true || row.created_by === userId
}

function cloudEditable(row: DbEnvironment, userId: string, role: string | null): boolean {
  if (!role) return false
  return isAdminRole(role) || (!!row.created_by && row.created_by === userId)
}

function toCloud(
  row: DbEnvironment,
  ctx: { userId: string; role: string | null; defaultId: string | null; projectCount: number },
): CloudEnvironment {
  const canEdit = cloudEditable(row, ctx.userId, ctx.role)
  const hasEnvVars = !!row.env_vars && row.env_vars.trim().length > 0
  const hasSetupScript = !!row.setup_script && row.setup_script.trim().length > 0
  return {
    kind: 'cloud',
    id: row.id,
    name: row.name,
    workspaceId: row.workspace_id as string,
    shared: row.shared === true,
    networkAccess: (row.network_access ?? NEW_CLOUD_NETWORK_ACCESS) as NetworkAccess,
    createdBy: row.created_by,
    canEdit,
    envVars: canEdit ? (row.env_vars ?? null) : null,
    setupScript: canEdit ? (row.setup_script ?? null) : null,
    secretsHidden: !canEdit,
    hasEnvVars,
    hasSetupScript,
    isWorkspaceDefault: ctx.defaultId === row.id,
    projectCount: ctx.projectCount,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ── Validation (the boundary) ───────────────────────────────────────────────

function cleanName(v: unknown): string {
  const name = typeof v === 'string' ? v.trim() : ''
  if (!name) throw new EnvironmentError('bad_request', 'Name is required')
  if (Array.from(name).length > ENVIRONMENT_NAME_MAX) {
    throw new EnvironmentError('bad_request', `Name must be at most ${ENVIRONMENT_NAME_MAX} characters`)
  }
  return name
}

/** The env vars and setup script rule (a string is kept as written, anything else clears it), at most 64 KB. */
function cleanText(v: unknown, what: 'Env vars' | 'The setup script'): string | null {
  if (typeof v !== 'string') return null
  if (utf8Bytes(v) > ENV_TEXT_MAX_BYTES) throw new EnvironmentError('bad_request', `${what} can be at most ${ENV_TEXT_MAX_BYTES / 1024} KB`)
  return v
}

/** What a cloud environment's fields may be set to. `undefined` leaves a field alone. */
export interface CloudFieldsInput {
  name?: unknown
  networkAccess?: unknown
  envVars?: unknown
  setupScript?: unknown
  shared?: unknown
}

export interface CloudFields {
  name?: string
  networkAccess?: NetworkAccess
  envVars?: string | null
  setupScript?: string | null
  shared?: boolean
}

/** Validate a cloud environment's fields (the old cloud_environment rules, plus the 80-character name). */
export function cleanCloudFields(input: CloudFieldsInput): CloudFields {
  const out: CloudFields = {}
  if (input.name !== undefined) out.name = cleanName(input.name)
  if (input.networkAccess !== undefined) {
    if (!isNetworkAccess(input.networkAccess)) throw new EnvironmentError('bad_request', 'Invalid network_access')
    out.networkAccess = input.networkAccess
  }
  if (input.envVars !== undefined) out.envVars = cleanText(input.envVars, 'Env vars')
  if (input.setupScript !== undefined) out.setupScript = cleanText(input.setupScript, 'The setup script')
  if (input.shared !== undefined) {
    if (typeof input.shared !== 'boolean') throw new EnvironmentError('bad_request', 'shared must be true or false')
    out.shared = input.shared
  }
  return out
}

function cleanSetting(v: unknown, what: 'base branch' | 'linked repo'): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null) return null
  if (typeof v !== 'string') throw new EnvironmentError('bad_request', `Invalid ${what}`)
  const t = v.trim()
  if (!t) return null
  const ok = what === 'base branch' ? isBaseBranch(t) : isRepoFullName(t)
  if (!ok) {
    throw new EnvironmentError(
      'bad_request',
      what === 'base branch' ? 'The base branch must be a plain local branch name, like main' : 'The linked repo must look like owner/repo',
    )
  }
  return t
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * The person's Macs, online ones first, then in the order they were added
 * (a stable order: "most recently online" flips on every heartbeat with two
 * Macs on), each with its live folders (label order) and their settings. A removed Mac isn't one of them. A Mac
 * seen by the heartbeat before the environment existed (between migration
 * 420 and the deploy) gets its environment here, once.
 */
export async function listMacs(svc: Svc, userId: string): Promise<MacEnvironment[]> {
  const [devices, envs, folders] = await Promise.all([
    svc
      .from('user_device')
      .select('id, name, app_version, last_seen_at, capabilities')
      .eq('user_id', userId)
      .is('removed_at', null)
      .order('last_seen_at', { ascending: false }),
    svc.from('environment').select('id, name, device_id, created_at, updated_at').eq('kind', 'mac').eq('owner_user_id', userId),
    svc.from('device_folder').select('id, device_id, label, mode, is_git').eq('user_id', userId).is('revoked_at', null).order('label', { ascending: true }),
  ])
  if (devices.error) throw new Error(`devices read failed: ${devices.error.message}`)
  if (envs.error) throw new Error(`mac environments read failed: ${envs.error.message}`)
  if (folders.error) throw new Error(`folders read failed: ${folders.error.message}`)

  const folderRows = (folders.data ?? []) as Array<{ id: string; device_id: string; label: string; mode: FolderMode; is_git: boolean }>
  const settings = new Map<string, { base_branch: string | null; repo_full_name: string | null }>()
  if (folderRows.length > 0) {
    const { data, error } = await svc
      .from('device_folder_setting')
      .select('device_folder_id, base_branch, repo_full_name')
      .in('device_folder_id', folderRows.map((f) => f.id))
    if (error) throw new Error(`folder settings read failed: ${error.message}`)
    for (const s of (data ?? []) as Array<{ device_folder_id: string; base_branch: string | null; repo_full_name: string | null }>) {
      settings.set(s.device_folder_id, s)
    }
  }

  const byDevice = new Map<string, { id: string; name: string; created_at: string; updated_at: string }>()
  for (const e of (envs.data ?? []) as Array<{ id: string; name: string; device_id: string; created_at: string; updated_at: string }>) {
    byDevice.set(e.device_id, e)
  }

  const now = Date.now()
  const out: MacEnvironment[] = []
  for (const d of (devices.data ?? []) as Array<{ id: string; name: string; app_version: string; last_seen_at: string | null; capabilities?: unknown }>) {
    let env = byDevice.get(d.id)
    if (!env) {
      const id = await ensureMacEnvironment(svc, userId, d.id, d.name)
      if (!id) continue
      const at = nowIso()
      env = { id, name: macEnvironmentName(d.name), created_at: at, updated_at: at }
    }
    const macFolders: MacFolder[] = folderRows
      .filter((f) => f.device_id === d.id)
      .map((f) => ({
        id: f.id,
        label: f.label,
        mode: f.mode === 'edit' ? 'edit' : 'read',
        isGit: f.is_git === true,
        baseBranch: settings.get(f.id)?.base_branch ?? null,
        repoFullName: settings.get(f.id)?.repo_full_name ?? null,
      }))
    out.push({
      kind: 'mac',
      id: env.id,
      name: env.name,
      deviceId: d.id,
      deviceName: d.name ?? '',
      appVersion: d.app_version ?? '',
      lastSeenAt: d.last_seen_at ?? null,
      online: isOnline(d.last_seen_at, now),
      supportsBaseBranch: hasCapability(d.capabilities, 'baseBranch'),
      folders: macFolders,
      createdAt: env.created_at,
      updatedAt: env.updated_at,
    })
  }
  return out.sort(macOrder)
}

/** Online Macs first, then by when each was added (its environment), then by id: the same order on every read. */
export function macOrder(a: { online: boolean; createdAt: string; id: string }, b: { online: boolean; createdAt: string; id: string }): number {
  if (a.online !== b.online) return a.online ? -1 : 1
  const at = (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0)
  return at !== 0 ? at : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** The workspace's cloud environments this person may see, oldest first (archived ones only with `includeArchived`). */
export async function listCloudEnvironments(
  svc: Svc,
  args: { userId: string; workspaceId: string; includeArchived?: boolean },
): Promise<CloudEnvironment[]> {
  if (!isUuid(args.workspaceId)) return []
  let envQuery = svc
    .from('environment')
    .select(ENV_FIELDS)
    .eq('kind', 'cloud')
    .eq('workspace_id', args.workspaceId)
  if (!args.includeArchived) envQuery = envQuery.is('archived_at', null)
  const [role, envs, ws, linked] = await Promise.all([
    memberRole(svc, args.userId, args.workspaceId),
    envQuery.order('created_at', { ascending: true }),
    svc.from('workspace').select('default_cloud_environment_id').eq('id', args.workspaceId).maybeSingle(),
    svc.from('projects').select('environment_id').eq('workspace_id', args.workspaceId).not('environment_id', 'is', null),
  ])
  if (envs.error) throw new Error(`cloud environments read failed: ${envs.error.message}`)
  if (ws.error) throw new Error(`workspace default read failed: ${ws.error.message}`)
  if (linked.error) throw new Error(`project environments read failed: ${linked.error.message}`)
  if (!role) return []
  const defaultId = (ws.data as { default_cloud_environment_id?: string | null } | null)?.default_cloud_environment_id ?? null
  const counts = new Map<string, number>()
  for (const p of (linked.data ?? []) as Array<{ environment_id: string | null }>) {
    if (p.environment_id) counts.set(p.environment_id, (counts.get(p.environment_id) ?? 0) + 1)
  }
  return ((envs.data ?? []) as DbEnvironment[])
    .filter((row) => cloudVisible(row, args.userId, role))
    .map((row) => toCloud(row, { userId: args.userId, role, defaultId, projectCount: counts.get(row.id) ?? 0 }))
}

/**
 * Every environment this person may use from this workspace: their Macs
 * first (online first, then the first added: macOrder; each with its live folders), then the
 * workspace's cloud environments they can see (oldest first). Archived cloud
 * environments only with `includeArchived`.
 */
export async function listEnvironments(
  svc: Svc,
  args: { userId: string; workspaceId: string; includeArchived?: boolean },
): Promise<Environment[]> {
  const [macs, cloud] = await Promise.all([listMacs(svc, args.userId), listCloudEnvironments(svc, args)])
  return [...macs, ...cloud]
}

/** One environment, as listEnvironments shows it (an archived cloud one too), or null when this person can't see it. */
export async function getEnvironment(
  svc: Svc,
  args: { userId: string; workspaceId: string; environmentId: string },
): Promise<Environment | null> {
  const row = await loadEnvironmentRow(svc, args.environmentId)
  if (!row) return null
  if (row.kind === 'mac') {
    if (row.owner_user_id !== args.userId) return null
    return (await listMacs(svc, args.userId)).find((e) => e.id === row.id) ?? null
  }
  if (row.workspace_id !== args.workspaceId) return null
  return (await listCloudEnvironments(svc, { ...args, includeArchived: true })).find((e) => e.id === row.id) ?? null
}

// ── Cloud environments ──────────────────────────────────────────────────────

/**
 * A new cloud environment in the workspace, by any member. Network
 * defaults to restricted, sharing to the whole workspace.
 */
export async function createCloudEnvironment(
  svc: Svc,
  args: { userId: string; workspaceId: string } & CloudFieldsInput,
): Promise<CloudEnvironment> {
  const fields = cleanCloudFields(args)
  if (fields.name === undefined) throw new EnvironmentError('bad_request', 'Name is required')
  const role = await memberRole(svc, args.userId, args.workspaceId)
  if (!role) throw new EnvironmentError('forbidden', 'Not a workspace member')
  const { data, error } = await svc
    .from('environment')
    .insert({
      kind: 'cloud',
      name: fields.name,
      workspace_id: args.workspaceId,
      created_by: args.userId,
      shared: fields.shared ?? true,
      network_access: fields.networkAccess ?? NEW_CLOUD_NETWORK_ACCESS,
      env_vars: fields.envVars ?? null,
      setup_script: fields.setupScript ?? null,
    })
    .select(ENV_FIELDS)
    .single()
  if (error || !data) throw new Error(`cloud environment insert failed: ${error?.message ?? 'no row'}`)
  return toCloud(data as DbEnvironment, { userId: args.userId, role, defaultId: null, projectCount: 0 })
}

/** What starts runs in this cloud environment: projects, and the workspace default. */
async function cloudUse(svc: Svc, environmentId: string, workspaceId: string): Promise<{ projects: number; workspaceDefault: boolean }> {
  const [projects, ws] = await Promise.all([
    svc.from('projects').select('id').eq('environment_id', environmentId),
    svc.from('workspace').select('default_cloud_environment_id').eq('id', workspaceId).maybeSingle(),
  ])
  if (projects.error) throw new Error(`project environments read failed: ${projects.error.message}`)
  if (ws.error) throw new Error(`workspace default read failed: ${ws.error.message}`)
  return {
    projects: (projects.data ?? []).length,
    workspaceDefault: (ws.data as { default_cloud_environment_id?: string | null } | null)?.default_cloud_environment_id === environmentId,
  }
}

/** The 409 for an environment something still runs in, saying what. */
function inUse(use: { projects: number; workspaceDefault: boolean }, verb: 'archived' | 'only yours'): EnvironmentError {
  const users = [
    use.projects > 0 ? `${use.projects} ${use.projects === 1 ? 'project uses' : 'projects use'} it` : null,
    use.workspaceDefault ? 'it is the workspace’s default cloud environment' : null,
  ].filter(Boolean).join(', and ')
  const what = verb === 'archived' ? 'archived' : 'made only yours'
  return new EnvironmentError(
    'conflict',
    `This environment can’t be ${what} while ${users || 'something uses it'}. Pick another environment for ${use.projects > 0 && use.workspaceDefault ? 'them' : 'it'} first.`,
    { code: ENVIRONMENT_IN_USE_CODE, projects: use.projects, workspaceDefault: use.workspaceDefault },
  )
}

/**
 * Change an environment. A Mac: its name only, by its owner. A cloud one:
 * name, network, env vars, setup script and sharing, by its creator or a
 * workspace admin. One a project or the workspace default uses stays
 * shared (409 ENVIRONMENT_IN_USE; migration 420's environment_guard says
 * the same). Returns it as getEnvironment does.
 */
export async function updateEnvironment(
  svc: Svc,
  args: { userId: string; workspaceId: string; environmentId: string; patch: CloudFieldsInput },
): Promise<Environment> {
  const row = await loadEnvironmentRow(svc, args.environmentId)
  if (!row) throw new EnvironmentError('not_found', 'Environment not found')

  if (row.kind === 'mac') {
    // A removed Mac's environment is archived: it reads as missing until the Mac comes back.
    if (row.owner_user_id !== args.userId || row.archived_at) throw new EnvironmentError('not_found', 'Environment not found')
    const { name, ...rest } = args.patch
    if (Object.values(rest).some((v) => v !== undefined)) {
      throw new EnvironmentError('bad_request', 'A Mac environment has only a name; its folders and their modes are set on the Mac')
    }
    if (name === undefined) throw new EnvironmentError('bad_request', 'No fields to update')
    const { error } = await svc
      .from('environment')
      .update({ name: cleanName(name) })
      .eq('id', row.id)
      .eq('kind', 'mac')
      .eq('owner_user_id', args.userId)
    if (error) throw new Error(`mac environment rename failed: ${error.message}`)
  } else {
    if (row.workspace_id !== args.workspaceId || row.archived_at) throw new EnvironmentError('not_found', 'Environment not found')
    const role = await memberRole(svc, args.userId, args.workspaceId)
    if (!cloudVisible(row, args.userId, role)) throw new EnvironmentError('not_found', 'Environment not found')
    if (!cloudEditable(row, args.userId, role)) {
      throw new EnvironmentError('forbidden', 'Only the person who made this environment or a workspace admin can change it')
    }
    const fields = cleanCloudFields(args.patch)
    const updates: Record<string, unknown> = {}
    if (fields.name !== undefined) updates.name = fields.name
    if (fields.networkAccess !== undefined) updates.network_access = fields.networkAccess
    if (fields.envVars !== undefined) updates.env_vars = fields.envVars
    if (fields.setupScript !== undefined) updates.setup_script = fields.setupScript
    if (fields.shared !== undefined) updates.shared = fields.shared
    if (Object.keys(updates).length === 0) throw new EnvironmentError('bad_request', 'No fields to update')
    if (fields.shared === false && row.shared === true) {
      const use = await cloudUse(svc, row.id, args.workspaceId)
      if (use.projects > 0 || use.workspaceDefault) throw inUse(use, 'only yours')
    }
    const { error } = await svc
      .from('environment')
      .update(updates)
      .eq('id', row.id)
      .eq('kind', 'cloud')
      .eq('workspace_id', args.workspaceId)
    // 42501: environment_guard, when a project linked it since the check above.
    if (error?.code === '42501') throw inUse(await cloudUse(svc, row.id, args.workspaceId), 'only yours')
    if (error) throw new Error(`cloud environment update failed: ${error.message}`)
  }

  const env = await getEnvironment(svc, args)
  if (!env) throw new EnvironmentError('not_found', 'Environment not found')
  return env
}

/**
 * Archive a cloud environment (its creator or an admin). Refused (409
 * ENVIRONMENT_IN_USE, with how many projects use it and whether it is the
 * workspace default) while anything that starts runs points at it: the
 * person moves those off it first, so archiving never quietly moves a
 * project's runs, or a loop's, somewhere else (migration 420's
 * environment_guard refuses the same). Chats and personal defaults that name
 * it fall back to the next one when they are read. Runs that used it keep
 * their record of it, and one still running fails at its next session
 * rather than run elsewhere (resolveRunEnvironment). A Mac is removed, not
 * archived (removeMac).
 */
export async function archiveEnvironment(
  svc: Svc,
  args: { userId: string; workspaceId: string; environmentId: string },
): Promise<{ archived: true }> {
  const row = await loadEnvironmentRow(svc, args.environmentId)
  if (!row) throw new EnvironmentError('not_found', 'Environment not found')
  if (row.kind === 'mac') {
    if (row.owner_user_id !== args.userId) throw new EnvironmentError('not_found', 'Environment not found')
    throw new EnvironmentError('bad_request', 'A Mac environment is removed with its Mac (Remove this Mac), not archived')
  }
  if (row.workspace_id !== args.workspaceId) throw new EnvironmentError('not_found', 'Environment not found')
  const role = await memberRole(svc, args.userId, args.workspaceId)
  if (!cloudVisible(row, args.userId, role)) throw new EnvironmentError('not_found', 'Environment not found')
  if (!cloudEditable(row, args.userId, role)) {
    throw new EnvironmentError('forbidden', 'Only the person who made this environment or a workspace admin can archive it')
  }
  if (row.archived_at) return { archived: true }

  const use = await cloudUse(svc, row.id, args.workspaceId)
  if (use.projects > 0 || use.workspaceDefault) throw inUse(use, 'archived')
  const { error } = await svc
    .from('environment')
    .update({ archived_at: nowIso() })
    .eq('id', row.id)
    .eq('kind', 'cloud')
    .eq('workspace_id', args.workspaceId)
  // 42501: environment_guard, when a project linked it since the check above.
  if (error?.code === '42501') throw inUse(await cloudUse(svc, row.id, args.workspaceId), 'archived')
  if (error) throw new Error(`cloud environment archive failed: ${error.message}`)
  return { archived: true }
}

// ── A Mac's folders ─────────────────────────────────────────────────────────

/**
 * A folder's two web settings, by its owner: the base branch for edit jobs
 * (E3: the Mac checks the name again and resolves only a local branch) and
 * the linked repo. `undefined` keeps a setting, null or '' clears it. Only
 * a live grant (the Mac still shares the folder).
 */
export async function setFolderSetting(
  svc: Svc,
  args: { userId: string; deviceFolderId: string; baseBranch?: unknown; repoFullName?: unknown },
): Promise<{ deviceFolderId: string; baseBranch: string | null; repoFullName: string | null }> {
  if (!isUuid(args.deviceFolderId)) throw new EnvironmentError('not_found', 'Folder not found')
  const baseBranch = cleanSetting(args.baseBranch, 'base branch')
  const repoFullName = cleanSetting(args.repoFullName, 'linked repo')
  if (baseBranch === undefined && repoFullName === undefined) throw new EnvironmentError('bad_request', 'No fields to update')

  const { data: folder, error: folderError } = await svc
    .from('device_folder')
    .select('id, revoked_at')
    .eq('id', args.deviceFolderId)
    .eq('user_id', args.userId)
    .maybeSingle()
  if (folderError) throw new Error(`folder read failed: ${folderError.message}`)
  if (!folder || (folder as { revoked_at: string | null }).revoked_at) throw new EnvironmentError('not_found', 'Folder not found')

  const { data: current, error: currentError } = await svc
    .from('device_folder_setting')
    .select('base_branch, repo_full_name')
    .eq('device_folder_id', args.deviceFolderId)
    .maybeSingle()
  if (currentError) throw new Error(`folder setting read failed: ${currentError.message}`)
  const prev = (current as { base_branch: string | null; repo_full_name: string | null } | null) ?? { base_branch: null, repo_full_name: null }
  const next = {
    device_folder_id: args.deviceFolderId,
    base_branch: baseBranch === undefined ? prev.base_branch : baseBranch,
    repo_full_name: repoFullName === undefined ? prev.repo_full_name : repoFullName,
  }
  const { error } = await svc.from('device_folder_setting').upsert(next, { onConflict: 'device_folder_id' })
  if (error) throw new Error(`folder setting write failed: ${error.message}`)
  return { deviceFolderId: args.deviceFolderId, baseBranch: next.base_branch, repoFullName: next.repo_full_name }
}

// ── Personal defaults ───────────────────────────────────────────────────────

/**
 * May this person use this environment here? Their own Mac (everywhere), or,
 * unless `macOnly`, a live cloud environment of the workspace they can see
 * (shared, or theirs). Migration 420's _environment_usable, in code.
 */
export function usableBy(row: DbEnvironment, userId: string, workspaceId: string, macOnly: boolean): boolean {
  // Archived: a cloud one, or a removed Mac's.
  if (row.archived_at) return false
  if (row.kind === 'mac') return row.owner_user_id === userId
  if (macOnly || row.workspace_id !== workspaceId) return false
  return row.shared === true || row.created_by === userId
}

async function assertProject(svc: Svc, projectId: string, workspaceId: string): Promise<void> {
  if (!isUuid(projectId)) throw new EnvironmentError('not_found', 'Project not found')
  const { data, error } = await svc.from('projects').select('id').eq('id', projectId).eq('workspace_id', workspaceId).maybeSingle()
  if (error) throw new Error(`project read failed: ${error.message}`)
  if (!data) throw new EnvironmentError('not_found', 'Project not found')
}

function defaultRows(svc: Svc, args: { userId: string; workspaceId: string; projectId: string | null }) {
  const q = svc.from('environment_default').select('id, environment_id').eq('user_id', args.userId).eq('workspace_id', args.workspaceId)
  return args.projectId ? q.eq('project_id', args.projectId) : q.is('project_id', null)
}

/**
 * Set (or, with environmentId null, clear) this person's default: for the
 * workspace, or with a projectId, "run this project's work on my Mac", which
 * may only name their own Mac. Returns what is now set.
 */
export async function setDefault(
  svc: Svc,
  args: { userId: string; workspaceId: string; projectId?: unknown; environmentId: unknown },
): Promise<{ environmentId: string | null; projectId: string | null }> {
  if (args.projectId !== undefined && args.projectId !== null && typeof args.projectId !== 'string') {
    throw new EnvironmentError('bad_request', 'Invalid projectId')
  }
  const projectId = typeof args.projectId === 'string' && args.projectId ? args.projectId : null
  if (args.environmentId !== null && typeof args.environmentId !== 'string') throw new EnvironmentError('bad_request', 'environmentId must be an id or null')
  const role = await memberRole(svc, args.userId, args.workspaceId)
  if (!role) throw new EnvironmentError('forbidden', 'Not a workspace member')
  if (projectId) await assertProject(svc, projectId, args.workspaceId)

  if (args.environmentId === null || args.environmentId === '') {
    let del = svc.from('environment_default').delete().eq('user_id', args.userId).eq('workspace_id', args.workspaceId)
    del = projectId ? del.eq('project_id', projectId) : del.is('project_id', null)
    const { error } = await del
    if (error) throw new Error(`default clear failed: ${error.message}`)
    return { environmentId: null, projectId }
  }

  const row = await loadEnvironmentRow(svc, args.environmentId)
  if (!row || (row.kind === 'mac' ? row.owner_user_id !== args.userId : !cloudVisible(row, args.userId, role) || row.workspace_id !== args.workspaceId)) {
    throw new EnvironmentError('not_found', 'Environment not found')
  }
  if (projectId && row.kind !== 'mac') {
    throw new EnvironmentError('bad_request', "A project's personal default can only be one of your Macs; the project's own environment is set on the project")
  }
  if (!usableBy(row, args.userId, args.workspaceId, projectId !== null)) {
    throw new EnvironmentError('bad_request', 'You can’t use this environment here')
  }

  const write = async (): Promise<boolean> => {
    let upd = svc.from('environment_default').update({ environment_id: row.id }).eq('user_id', args.userId).eq('workspace_id', args.workspaceId)
    upd = projectId ? upd.eq('project_id', projectId) : upd.is('project_id', null)
    const { data, error } = await upd.select('id')
    if (error) throw new Error(`default update failed: ${error.message}`)
    return ((data ?? []) as unknown[]).length > 0
  }
  if (!(await write())) {
    const { error } = await svc
      .from('environment_default')
      .insert({ user_id: args.userId, workspace_id: args.workspaceId, project_id: projectId, environment_id: row.id })
    // Another set won the race to insert (environment_default_one): this one is the later word.
    if (error?.code === '23505') await write()
    else if (error) throw new Error(`default insert failed: ${error.message}`)
  }
  return { environmentId: row.id, projectId }
}

/**
 * This person's default (for the workspace, or with a projectId, for that
 * project), or null when none is set or the one set can't be used any more
 * (archived, unshared, gone): the caller then uses the next default.
 */
export async function getDefault(
  svc: Svc,
  args: { userId: string; workspaceId: string; projectId?: string | null },
): Promise<string | null> {
  if (!isUuid(args.workspaceId)) return null
  const projectId = args.projectId ?? null
  const { data, error } = await defaultRows(svc, { userId: args.userId, workspaceId: args.workspaceId, projectId }).limit(1)
  if (error) throw new Error(`default read failed: ${error.message}`)
  const envId = ((data ?? []) as Array<{ environment_id: string }>)[0]?.environment_id
  if (!envId) return null
  const row = await loadEnvironmentRow(svc, envId)
  if (!row || !usableBy(row, args.userId, args.workspaceId, projectId !== null)) return null
  if (row.kind === 'cloud' && !(await memberRole(svc, args.userId, args.workspaceId))) return null
  return row.id
}

// ── Remove this Mac ─────────────────────────────────────────────────────────

/** Why "Remove this Mac" was refused. */
export const MAC_BUSY_REASON = 'A Native Intelligence job is still open on this Mac. Stop it first, then remove the Mac.'

/**
 * "Remove this Mac" (MAX_DEVICES says "remove one first"), softly: nothing
 * is deleted, so its sessions (transcripts, branches, pull requests,
 * reports), its folders' ids and settings and its environment's id all stay.
 * user_device.removed_at is set first, then a local agent that still holds a
 * folder on it (queued, running, waiting, interrupted, after the reaper
 * settles what is stale) refuses the remove (409 MAC_BUSY) and takes the
 * mark back. createSession refuses a removed Mac before and after its
 * insert, so a start racing this can't slip between the check and the mark.
 * Then its folders are revoked and its environment archived: it leaves every
 * list, chats that used it fall back to the next default, and its heartbeat
 * is refused (DEVICE_REMOVED) until a folder is added on that Mac again
 * (the heartbeat's rejoin brings it back, same ids). Removing a removed Mac
 * is a no-op.
 */
export async function removeMac(svc: Svc, userId: string, deviceId: string): Promise<{ removed: true }> {
  if (!isUuid(deviceId)) throw new EnvironmentError('not_found', 'Mac not found')
  const { data: device, error: deviceError } = await svc
    .from('user_device')
    .select('id, removed_at')
    .eq('user_id', userId)
    .eq('id', deviceId)
    .maybeSingle()
  if (deviceError) throw new Error(`device read failed: ${deviceError.message}`)
  if (!device) throw new EnvironmentError('not_found', 'Mac not found')
  if ((device as { removed_at: string | null }).removed_at) return { removed: true }

  const removedAt = nowIso()
  const { error: markError } = await svc
    .from('user_device')
    .update({ removed_at: removedAt })
    .eq('user_id', userId)
    .eq('id', deviceId)
    .is('removed_at', null)
  if (markError) throw new Error(`device remove failed: ${markError.message}`)

  const { data: live, error: liveError } = await svc
    .from('local_agent_session')
    .select(SESSION_SELECT)
    .eq('user_id', userId)
    .eq('device_id', deviceId)
    .in('status', [...FOLDER_HOLDING_STATUSES])
  if (liveError) {
    await unmark(svc, userId, deviceId, removedAt)
    throw new Error(`sessions read failed: ${liveError.message}`)
  }
  for (const s of (live ?? []) as DbSession[]) {
    const settled = await reapIfStale(svc, s)
    if ((FOLDER_HOLDING_STATUSES as readonly string[]).includes(settled.status)) {
      await unmark(svc, userId, deviceId, removedAt)
      throw new EnvironmentError('conflict', MAC_BUSY_REASON, { code: MAC_BUSY_CODE, sessionId: settled.id })
    }
  }

  const { error: revokeError } = await svc
    .from('device_folder')
    .update({ revoked_at: removedAt })
    .eq('user_id', userId)
    .eq('device_id', deviceId)
    .is('revoked_at', null)
  if (revokeError) throw new Error(`folder revoke failed: ${revokeError.message}`)
  const { error: archiveError } = await svc
    .from('environment')
    .update({ archived_at: removedAt })
    .eq('kind', 'mac')
    .eq('owner_user_id', userId)
    .eq('device_id', deviceId)
    .is('archived_at', null)
  if (archiveError) throw new Error(`mac environment archive failed: ${archiveError.message}`)
  return { removed: true }
}

/** Take back this remove's mark (only this one: a later remove's stays). */
async function unmark(svc: Svc, userId: string, deviceId: string, removedAt: string): Promise<void> {
  const { error } = await svc
    .from('user_device')
    .update({ removed_at: null })
    .eq('user_id', userId)
    .eq('id', deviceId)
    .eq('removed_at', removedAt)
  if (error) console.warn('[environments] taking back a refused remove failed:', error.message)
}
