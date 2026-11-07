/**
 * The `environment` turn-context rider (docs/plans/environments.md §4 "The
 * turn context"; it replaces the `folders` rider): the chat's environment,
 * where the Dial8 agent sends work (src/lib/environments/chat.ts picks it).
 *
 *   its kind and name, the name as quoted data on one line (admins name
 *   shared environments, and those names reach every member's prompt);
 *   a Mac: online or offline, then at most 20 of its folders, most recently
 *     used first (by each folder's latest job), each with its label, id, mode
 *     ceiling and base branch (only on a Mac whose app resolves one), then
 *     "and N more: ask for one by name". Never a path;
 *   cloud: its network level, and the workspace's project repos the agent may
 *     name (start_cloud_coding_run);
 *   and the person's other Macs, one short line each (name, online), so
 *   "use my other Mac" works.
 *
 * DB-backed, by the token's user, never from the client's systemContext: a
 * home turn the server started carries none. The chat spec loads it beside
 * `log` and `recent` (chat-run-rebuild.ts), in one round of reads (a second
 * only for a cloud chat's repos), and a failed load is held
 * (turnContextHeld), so the version the model has stands. No environment at
 * all (no Mac, no cloud): no section.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { pickChatEnvironment, pinChatEnvironment } from '@/lib/environments/chat'
import { macOrder } from '@/lib/environments/store'
import { isBaseBranch, isNetworkAccess, isRepoFullName, macEnvironmentName, type NetworkAccess } from '@/lib/environments/types'
import { isOnline } from '@/lib/local-agent/store'

/** The section's key (TURN_CONTEXT_KEYS in src/lib/ai/chat-system-prompt.ts). */
export const ENVIRONMENT_SECTION_KEY = 'environment'

/** Folders the section lists, at most (the rest: "ask for one by name"). */
export const ENVIRONMENT_FOLDERS_MAX = 20
/** Project repos a cloud chat's section lists, at most. */
export const ENVIRONMENT_REPOS_MAX = 20

/** A name, one line and at most this long. */
const NAME_MAX = 80

/** Text someone wrote (a Mac's name, a folder's label, an environment's), as quoted data on one line. */
export function oneLine(text: string | null | undefined, fallback: string): string {
  const t = (text ?? '').replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim().replace(/"/g, "'")
  const out = !t ? fallback : t.length <= NAME_MAX ? t : `${t.slice(0, NAME_MAX - 1)}…`
  return `"${out}"`
}

/** The tail every version of the section ends with. */
export const ENVIRONMENT_SECTION_TAIL =
  "Send work there. Use another of the person's environments only when they ask for it in words, and say where each job runs."

export interface EnvironmentMac {
  environmentId: string
  name: string
  online: boolean
  supportsBaseBranch: boolean
}

export interface EnvironmentFolder {
  id: string
  label: string
  mode: 'read' | 'edit'
  baseBranch: string | null
}

export interface EnvironmentRepo {
  projectId: string
  project: string
  repo: string
}

/** What the section shows, already read and picked. */
export type EnvironmentSnapshot =
  | { kind: 'mac'; mac: EnvironmentMac; folders: EnvironmentFolder[]; otherMacs: EnvironmentMac[] }
  | { kind: 'cloud'; name: string; networkAccess: NetworkAccess; repos: EnvironmentRepo[]; reposMore: boolean; otherMacs: EnvironmentMac[] }

function macLine(m: EnvironmentMac): string {
  return `${oneLine(m.name, 'Mac')} (${m.online ? 'online' : 'offline'})`
}

/** The section's text (folders already most recently used first). Pure. */
export function renderEnvironmentSection(s: EnvironmentSnapshot): string {
  const lines: string[] = []
  if (s.kind === 'mac') {
    lines.push(`This chat's environment, where you send work: the person's Mac ${macLine(s.mac)}.`)
    if (s.folders.length === 0) {
      lines.push('It has no folder yet: the person adds one on that Mac, in the Dial8 desktop app.')
    } else {
      lines.push('Its folders, most recently used first (start_local_agent takes the folder_id):')
      for (const f of s.folders.slice(0, ENVIRONMENT_FOLDERS_MAX)) {
        const base = f.mode === 'edit' && s.mac.supportsBaseBranch && f.baseBranch ? `, edits branch from ${f.baseBranch}` : ''
        lines.push(`- ${oneLine(f.label, 'folder')}: folder_id ${f.id}, ${f.mode === 'edit' ? 'edits allowed' : 'read-only'}${base}`)
      }
      const more = s.folders.length - ENVIRONMENT_FOLDERS_MAX
      if (more > 0) lines.push(`- and ${more} more: ask for one by name (local_agents lists them all).`)
    }
  } else {
    lines.push(`This chat's environment, where you send work: the cloud environment ${oneLine(s.name, 'Cloud')} (${s.networkAccess} network).`)
    if (s.repos.length === 0) {
      lines.push('No project in this workspace has a GitHub repository yet, so a coding run has nothing to work on.')
    } else {
      lines.push("Coding runs go there with start_cloud_coding_run, on a repository of one of this workspace's projects:")
      for (const r of s.repos) lines.push(`- ${oneLine(r.repo, 'repo')}: project ${oneLine(r.project, 'project')}, project_id ${r.projectId}`)
      if (s.reposMore) lines.push('- and more: list_projects has them.')
    }
  }
  if (s.otherMacs.length > 0) {
    lines.push(`${s.kind === 'mac' ? "The person's other Macs" : "The person's Macs"}: ${s.otherMacs.map(macLine).join(', ')} (local_agents lists their folders).`)
  }
  lines.push(ENVIRONMENT_SECTION_TAIL)
  return lines.join('\n')
}

type Svc = SupabaseClient

interface DeviceRow {
  id: string
  name: string | null
  last_seen_at: string | null
  capabilities?: unknown
}

interface CloudRow {
  id: string
  name: string
  shared: boolean | null
  created_by: string | null
  network_access: string | null
  archived_at: string | null
}

function rows<T>(res: { data: unknown; error: { message: string } | null }, what: string): T[] {
  if (res.error) throw new Error(`${what} read failed: ${res.error.message}`)
  return (res.data ?? []) as T[]
}

/**
 * The chat's environment and its section (null when there is none), and how
 * many folders the person has across their Macs (the local-agent tools ride
 * up front on any turn once there is one). Throws on a failed read.
 */
export async function buildEnvironmentSection(
  svc: Svc,
  input: { userId: string; workspaceId: string; conversationId: string },
): Promise<{
  kind: 'mac' | 'cloud' | null
  folderCount: number
  section: { key: string; markdown: string } | null
}> {
  const { userId, workspaceId } = input
  // One round of reads: everything the pick and a Mac's section need.
  const [chat, defaults, devices, macEnvs, cloudEnvs, workspace, folders, recent] = await Promise.all([
    svc.from('chat_conversations').select('environment_id').eq('id', input.conversationId).eq('user_id', userId).maybeSingle(),
    svc.from('environment_default').select('environment_id').eq('user_id', userId).eq('workspace_id', workspaceId).is('project_id', null).limit(1),
    svc.from('user_device').select('id, name, last_seen_at, capabilities').eq('user_id', userId).is('removed_at', null).order('last_seen_at', { ascending: false }),
    svc.from('environment').select('id, name, device_id, archived_at, created_at').eq('kind', 'mac').eq('owner_user_id', userId),
    svc.from('environment').select('id, name, shared, created_by, network_access, archived_at').eq('kind', 'cloud').eq('workspace_id', workspaceId).is('archived_at', null),
    svc.from('workspace').select('default_cloud_environment_id').eq('id', workspaceId).maybeSingle(),
    svc.from('device_folder').select('id, device_id, label, mode').eq('user_id', userId).is('revoked_at', null).order('label', { ascending: true }),
    svc.from('local_agent_session').select('folder_id, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(200),
  ])
  if (chat.error) throw new Error(`conversation read failed: ${chat.error.message}`)
  if (workspace.error) throw new Error(`workspace default read failed: ${workspace.error.message}`)
  const deviceRows = rows<DeviceRow>(devices, 'devices')
  const macRows = rows<{ id: string; name: string; device_id: string; archived_at: string | null; created_at?: string | null }>(macEnvs, 'mac environments')
  const cloudRows = rows<CloudRow>(cloudEnvs, 'cloud environments')
  const folderRows = rows<{ id: string; device_id: string; label: string; mode: string }>(folders, 'folders')
  const recentRows = rows<{ folder_id: string; created_at: string }>(recent, 'sessions')
  const defaultId = rows<{ environment_id: string }>(defaults, 'default')[0]?.environment_id ?? null

  // The person's Macs (a device with a live environment), in the stable
  // order the environments list uses: online first, then the first added.
  const envByDevice = new Map(macRows.filter((e) => !e.archived_at).map((e) => [e.device_id, e]))
  const now = Date.now()
  const macs: Array<EnvironmentMac & { deviceId: string; createdAt: string }> = []
  for (const d of deviceRows) {
    const env = envByDevice.get(d.id)
    if (!env) continue
    macs.push({
      environmentId: env.id,
      deviceId: d.id,
      createdAt: env.created_at ?? '',
      name: env.name || macEnvironmentName(d.name),
      online: isOnline(d.last_seen_at, now),
      supportsBaseBranch: Array.isArray(d.capabilities) && d.capabilities.includes('baseBranch'),
    })
  }
  macs.sort((a, b) => macOrder({ ...a, id: a.environmentId }, { ...b, id: b.environmentId }))
  const cloudById = new Map(cloudRows.map((c) => [c.id, c]))
  // A live cloud environment of this workspace, shared or the person's own (environments/chat.ts environmentUsable).
  const usableCloud = (c: CloudRow | undefined): c is CloudRow =>
    !!c && !c.archived_at && isNetworkAccess(c.network_access) && (c.shared === true || c.created_by === userId)
  const macIds = new Set(macs.map((m) => m.environmentId))

  const picked = pickChatEnvironment({
    chatEnvironmentId: (chat.data as { environment_id?: string | null } | null)?.environment_id ?? null,
    defaultEnvironmentId: defaultId,
    macEnvironmentIds: macs.map((m) => m.environmentId),
    workspaceDefaultId: (workspace.data as { default_cloud_environment_id?: string | null } | null)?.default_cloud_environment_id ?? null,
    usable: (id) => macIds.has(id) || usableCloud(cloudById.get(id)),
    shared: (id) => cloudById.get(id)?.shared === true,
  })

  const folderCount = folderRows.length
  const otherMacs = (exclude: string | null) => macs.filter((m) => m.environmentId !== exclude).map(({ deviceId: _d, createdAt: _c, ...m }) => m)
  if (!picked.environmentId) return { kind: null, folderCount, section: null }
  // The first turn that resolves it pins it on the chat (environments/chat.ts).
  if (picked.source !== 'chat' && chat.data) await pinChatEnvironment(svc, userId, input.conversationId, picked.environmentId)

  const mac = macs.find((m) => m.environmentId === picked.environmentId)
  if (mac) {
    // Most recently used first: each folder's latest job, then the rest by label.
    const lastUsed = new Map<string, number>()
    for (const r of recentRows) if (!lastUsed.has(r.folder_id)) lastUsed.set(r.folder_id, Date.parse(r.created_at) || 0)
    const own = folderRows
      .filter((f) => f.device_id === mac.deviceId)
      .map((f, i) => ({ f, i, used: lastUsed.get(f.id) ?? -1 }))
      .sort((a, b) => b.used - a.used || a.i - b.i)
      .map(({ f }) => f)
    // The shown folders' base branches (a second read, only for those, only when the Mac resolves one).
    const settings = new Map<string, string | null>()
    const shown = own.slice(0, ENVIRONMENT_FOLDERS_MAX).filter((f) => f.mode === 'edit')
    if (mac.supportsBaseBranch && shown.length > 0) {
      const res = await svc.from('device_folder_setting').select('device_folder_id, base_branch').in('device_folder_id', shown.map((f) => f.id))
      for (const s of rows<{ device_folder_id: string; base_branch: string | null }>(res, 'folder settings')) settings.set(s.device_folder_id, s.base_branch)
    }
    const { deviceId: _d, createdAt: _c, ...macView } = mac
    const markdown = renderEnvironmentSection({
      kind: 'mac',
      mac: macView,
      folders: own.map((f) => {
        const base = settings.get(f.id) ?? null
        return { id: f.id, label: f.label, mode: f.mode === 'edit' ? 'edit' : 'read', baseBranch: isBaseBranch(base) ? base : null }
      }),
      otherMacs: otherMacs(mac.environmentId),
    })
    return { kind: 'mac', folderCount, section: { key: ENVIRONMENT_SECTION_KEY, markdown } }
  }

  const cloud = cloudById.get(picked.environmentId)!
  const res = await svc
    .from('projects')
    .select('id, name, github_repo')
    .eq('workspace_id', workspaceId)
    .not('github_repo', 'is', null)
    .order('name', { ascending: true })
    .limit(ENVIRONMENT_REPOS_MAX + 1)
  const repos = rows<{ id: string; name: string | null; github_repo: string | null }>(res, 'project repos')
    // Any member can write a project's repo field (projects UPDATE RLS): only an owner/repo is shown, as quoted data.
    .filter((p) => isRepoFullName(p.github_repo?.trim()))
    .map((p) => ({ projectId: p.id, project: p.name ?? '', repo: p.github_repo!.trim() }))
  const markdown = renderEnvironmentSection({
    kind: 'cloud',
    name: cloud.name,
    networkAccess: cloud.network_access as NetworkAccess,
    repos: repos.slice(0, ENVIRONMENT_REPOS_MAX),
    reposMore: repos.length > ENVIRONMENT_REPOS_MAX,
    otherMacs: otherMacs(null),
  })
  return { kind: 'cloud', folderCount, section: { key: ENVIRONMENT_SECTION_KEY, markdown } }
}
