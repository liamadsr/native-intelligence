'use client'

/**
 * The environment routes' writes, for Edit environment, Settings →
 * Environments and the project panel (docs/plans/environments.md §6). Each
 * answers { ok: true, value } or { ok: false, error, code }: `error` is the
 * server's own sentence (an ENVIRONMENT_IN_USE or MAC_BUSY refusal says what
 * to do), `code` the api-errors code. Nothing here throws.
 */
import {
  DEFAULT_ENVIRONMENT_URL,
  ENVIRONMENTS_URL,
  parseEnvironmentItem,
  readRefusal,
  type EnvironmentItem,
} from '@/lib/local-agent/environment-client'
import type { NetworkAccess } from '@/lib/environments/types'

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string; code: string | null }

const UNREACHABLE = "Native Intelligence couldn't be reached. Try again."

async function call<T>(url: string, init: RequestInit, pick: (json: unknown) => T | null, fallback: string): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: init.body ? { 'Content-Type': 'application/json', ...init.headers } : init.headers,
      cache: 'no-store',
    })
    if (!res.ok) return { ok: false, ...(await readRefusal(res, fallback)) }
    const value = pick(await res.json().catch(() => null))
    return value === null ? { ok: false, error: fallback, code: null } : { ok: true, value }
  } catch {
    return { ok: false, error: UNREACHABLE, code: null }
  }
}

const environmentOf = (json: unknown) => parseEnvironmentItem((json as { environment?: unknown } | null)?.environment)

/** A cloud environment's fields as a POST or PATCH sends them; a missing key is left alone. */
export interface CloudFieldsPatch {
  name?: string
  networkAccess?: NetworkAccess
  envVars?: string
  setupScript?: string
  shared?: boolean
}

/** Make a cloud environment in the current workspace. */
export function createCloudEnvironment(fields: CloudFieldsPatch): Promise<ApiResult<EnvironmentItem>> {
  return call(ENVIRONMENTS_URL, { method: 'POST', body: JSON.stringify(fields) }, environmentOf, 'Couldn’t create the environment.')
}

/** Change an environment: a Mac's name, or a cloud one's fields. */
export function updateEnvironment(environmentId: string, patch: CloudFieldsPatch): Promise<ApiResult<EnvironmentItem>> {
  return call(
    `${ENVIRONMENTS_URL}/${encodeURIComponent(environmentId)}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
    environmentOf,
    'Couldn’t save the environment.',
  )
}

/** Archive a cloud environment (refused while a project or the workspace default uses it). */
export function archiveEnvironment(environmentId: string): Promise<ApiResult<true>> {
  return call(
    `${ENVIRONMENTS_URL}/${encodeURIComponent(environmentId)}`,
    { method: 'DELETE' },
    (json) => ((json as { archived?: unknown } | null)?.archived === true ? true : null),
    'Couldn’t archive the environment.',
  )
}

/** A Mac folder's base branch and linked repo ('' clears one; a missing key keeps it). */
export function saveFolderSetting(
  folderId: string,
  patch: { baseBranch?: string; repoFullName?: string },
): Promise<ApiResult<{ baseBranch: string | null; repoFullName: string | null }>> {
  return call(
    `${ENVIRONMENTS_URL}/folders/${encodeURIComponent(folderId)}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
    (json) => {
      const f = (json as { folder?: { baseBranch?: unknown; repoFullName?: unknown } } | null)?.folder
      if (!f) return null
      return {
        baseBranch: typeof f.baseBranch === 'string' && f.baseBranch ? f.baseBranch : null,
        repoFullName: typeof f.repoFullName === 'string' && f.repoFullName ? f.repoFullName : null,
      }
    },
    'Couldn’t save the folder.',
  )
}

/** "Remove this Mac" (refused with MAC_BUSY while a Native Intelligence job is open on it). */
export function removeMac(deviceId: string): Promise<ApiResult<true>> {
  return call(
    `${ENVIRONMENTS_URL}/macs/${encodeURIComponent(deviceId)}`,
    { method: 'DELETE' },
    (json) => ((json as { removed?: unknown } | null)?.removed === true ? true : null),
    'Couldn’t remove the Mac.',
  )
}

/**
 * Your "Run my work here on: <your Mac>" for a project: the Mac environment
 * it names, or null when it's off (or names one that can't be used any more).
 * GET …/environments/default?workspaceId&projectId: your own rows only; the
 * workspace is the current one when none is given.
 */
export function readProjectMacDefault(args: { workspaceId?: string | null; projectId: string }): Promise<ApiResult<string | null>> {
  const query = new URLSearchParams({ ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}), projectId: args.projectId })
  return call(
    `${DEFAULT_ENVIRONMENT_URL}?${query.toString()}`,
    { method: 'GET' },
    (json) => {
      if (!json || typeof json !== 'object' || !('environmentId' in json)) return null
      const id = (json as { environmentId: unknown }).environmentId
      // `ok` wraps the value: a null here (off) is still an answer.
      return { id: typeof id === 'string' && id ? id : null }
    },
    'Couldn’t read where this project’s work runs.',
  ).then((r) => (r.ok ? { ok: true as const, value: r.value.id } : r))
}

/** Turn "Run my work here" on (a Mac environment's id) or off (null). */
export function setProjectMacDefault(args: { workspaceId?: string | null; projectId: string; environmentId: string | null }): Promise<ApiResult<string | null>> {
  return call(
    DEFAULT_ENVIRONMENT_URL,
    {
      method: 'PUT',
      body: JSON.stringify({ ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}), projectId: args.projectId, environmentId: args.environmentId }),
    },
    (json) => {
      const id = (json as { environmentId?: unknown } | null)?.environmentId
      return { id: typeof id === 'string' && id ? id : null }
    },
    'Couldn’t change where this project’s work runs.',
  ).then((r) => (r.ok ? { ok: true as const, value: r.value.id } : r))
}
