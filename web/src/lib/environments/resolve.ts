/**
 * Which cloud environment a coding run uses (docs/plans/environments.md §4).
 *
 *   A run that recorded one when it started (agent_run.environment_id) runs
 *   there and only there. If it was archived, is gone, or the run's starter
 *   can't use it any more, the run fails with a plain reason
 *   (RUN_ENVIRONMENT_UNUSABLE): it never falls through to another, which
 *   could be a more open network with other env vars and setup script.
 *   A run that recorded none (made before migration 420) gets its project's,
 *   else the workspace's default, else none (the sandbox defaults: trusted,
 *   no setup script, no env vars).
 *
 * A project's environment and the workspace default must be shared, live
 * cloud environments of the run's workspace; one that isn't is skipped. The
 * run's own may also be its starter's "only me" one. The code re-checks here
 * what migration 420's triggers check on write, so a stale reference is
 * never used.
 *
 * `svc` is a service-role client: env_vars and setup_script are not
 * selectable by clients. Only resolveRunEnvironment reads them.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { EnvironmentError, RUN_ENVIRONMENT_UNUSABLE_CODE, isNetworkAccess, type RunEnvironment } from './types'

type Svc = SupabaseClient

interface CloudRow {
  id: string
  kind: string
  name: string
  workspace_id: string | null
  shared: boolean | null
  created_by: string | null
  network_access: string | null
  archived_at: string | null
  env_vars?: string | null
  setup_script?: string | null
}

/** What deciding needs: everything but the secrets. */
const CHECK_FIELDS = 'id, kind, name, workspace_id, shared, created_by, network_access, archived_at'
/** What a run's sandbox needs. */
const RUN_FIELDS = `${CHECK_FIELDS}, env_vars, setup_script`

/** Why a run whose own environment can't be used any more fails (the run's page shows it). */
export const RUN_ENVIRONMENT_UNUSABLE_REASON =
  'The cloud environment this run started in was archived or can no longer be used, so it won’t run anywhere else. Start it again.'

async function loadCloud(svc: Svc, id: string, fields: string): Promise<CloudRow | null> {
  const { data, error } = await svc.from('environment').select(fields).eq('id', id).maybeSingle()
  if (error) throw new Error(`environment read failed: ${error.message}`)
  return (data as CloudRow | null) ?? null
}

function usable(row: CloudRow | null, workspaceId: string, opts: { userId?: string | null; allowOwn: boolean }): row is CloudRow {
  if (!row || row.kind !== 'cloud' || row.archived_at || row.workspace_id !== workspaceId) return false
  if (!isNetworkAccess(row.network_access)) return false
  if (row.shared === true) return true
  return opts.allowOwn && !!opts.userId && row.created_by === opts.userId
}

function toRun(row: CloudRow, source: RunEnvironment['source']): RunEnvironment {
  return {
    environmentId: row.id,
    name: row.name,
    source,
    networkAccess: row.network_access as RunEnvironment['networkAccess'],
    envVars: row.env_vars ?? null,
    setupScript: row.setup_script ?? null,
  }
}

/** The project's environment, else the workspace default (each shared, live, of this workspace), else null. */
async function fallbackChain(
  svc: Svc,
  args: { projectId?: string | null; workspaceId: string },
  fields: string,
): Promise<RunEnvironment | null> {
  if (args.projectId) {
    const { data, error } = await svc
      .from('projects')
      .select('environment_id')
      .eq('id', args.projectId)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle()
    if (error) throw new Error(`project environment read failed: ${error.message}`)
    const envId = (data as { environment_id?: string | null } | null)?.environment_id ?? null
    if (envId) {
      const row = await loadCloud(svc, envId, fields)
      if (usable(row, args.workspaceId, { allowOwn: false })) return toRun(row, 'project')
    }
  }
  const { data: ws, error: wsError } = await svc
    .from('workspace')
    .select('default_cloud_environment_id')
    .eq('id', args.workspaceId)
    .maybeSingle()
  if (wsError) throw new Error(`workspace default read failed: ${wsError.message}`)
  const defaultId = (ws as { default_cloud_environment_id?: string | null } | null)?.default_cloud_environment_id ?? null
  if (defaultId) {
    const row = await loadCloud(svc, defaultId, fields)
    if (usable(row, args.workspaceId, { allowOwn: false })) return toRun(row, 'workspace')
  }
  return null
}

/**
 * The run's environment with its sandbox settings, or null for the sandbox
 * defaults. `userId` is the run's starter (agent_run.triggered_by): only they
 * may run in their own "only me" environment. Throws EnvironmentError
 * (conflict, RUN_ENVIRONMENT_UNUSABLE) when the run's own environment can't
 * be used, and a plain Error on a database error, so a caller never mistakes
 * either for "no environment" (the defaults are the most open network).
 */
export async function resolveRunEnvironment(
  svc: Svc,
  args: { runEnvironmentId?: string | null; projectId?: string | null; workspaceId: string; userId?: string | null },
): Promise<RunEnvironment | null> {
  if (args.runEnvironmentId) {
    const row = await loadCloud(svc, args.runEnvironmentId, RUN_FIELDS)
    if (!usable(row, args.workspaceId, { userId: args.userId, allowOwn: true })) {
      throw new EnvironmentError('conflict', RUN_ENVIRONMENT_UNUSABLE_REASON, { code: RUN_ENVIRONMENT_UNUSABLE_CODE })
    }
    return toRun(row, 'run')
  }
  return fallbackChain(svc, args, RUN_FIELDS)
}

/**
 * May a run in this workspace, started by `userId`, run in this environment
 * (a CI fix inheriting its pull request run's)? The same rule as a run's
 * own; no secrets read. Throws on a database error.
 */
export async function runEnvironmentUsable(
  svc: Svc,
  args: { environmentId: string; workspaceId: string; userId?: string | null },
): Promise<boolean> {
  return usable(await loadCloud(svc, args.environmentId, CHECK_FIELDS), args.workspaceId, { userId: args.userId, allowOwn: true })
}

/**
 * Is this a shared, live cloud environment of the workspace (what project
 * work runs in: the run and its pull request are the team's)? No secrets
 * read. Throws on a database error.
 */
export async function runEnvironmentShared(svc: Svc, args: { environmentId: string; workspaceId: string }): Promise<boolean> {
  return usable(await loadCloud(svc, args.environmentId, CHECK_FIELDS), args.workspaceId, { allowOwn: false })
}

/**
 * Where a project's runs run, as a new run would get it (its own shared
 * cloud environment, else the workspace default), without the secrets
 * (envVars and setupScript come back null). Null: none, so the sandbox
 * defaults. Throws on a database error.
 */
export async function projectRunEnvironment(
  svc: Svc,
  args: { projectId: string | null; workspaceId: string },
): Promise<RunEnvironment | null> {
  return fallbackChain(svc, { projectId: args.projectId, workspaceId: args.workspaceId }, CHECK_FIELDS)
}

/**
 * The environment a new cloud run will start in, to stamp on its agent_run
 * row: its project's, else the workspace default, else null. Reads no
 * secrets. Best-effort: a failed read stamps null, and the run then resolves
 * the same chain at every session start, so it behaves the same either way.
 */
export async function runEnvironmentIdFor(
  svc: Svc,
  args: { projectId?: string | null; workspaceId: string; userId?: string | null },
): Promise<string | null> {
  try {
    return (await fallbackChain(svc, { projectId: args.projectId ?? null, workspaceId: args.workspaceId }, CHECK_FIELDS))?.environmentId ?? null
  } catch (err) {
    console.warn('[environments] could not resolve a new run’s environment:', err instanceof Error ? err.message : err)
    return null
  }
}
