// Who is asking, for every function in this folder. The route (or an agent tool) resolves the person and their
// workspace first; everything after that reads and writes through the service-role client, always fenced to
// `workspaceId` (the Studio's tables have no row-level policies: see migration 620).
import type { SupabaseClient } from '@supabase/supabase-js'
import { isNotSetUp, notSetUpError, storeError } from './errors'
import type { StudioStorage } from './storage'

export type StudioContext = {
  /** A service-role client. Every query below filters on workspaceId itself. */
  supabase: SupabaseClient
  workspaceId: string
  /** The person acting (null for the worker finishing a job). */
  userId: string | null
  /** Where file parts live. Defaults to the `studio` bucket through `supabase` (storage.ts); tests pass a fake. */
  storage?: StudioStorage
}

type Result<T> = { data: T; error: { message: string; code?: string } | null }

/**
 * The data of a query, or a StudioError (500) saying what could not be done. The database's own text is logged, never
 * shown. A Studio table or function missing (the migrations not applied here) is the one 503 STUDIO_NOT_SET_UP.
 */
export function must<T>(result: Result<T>, what: string): T {
  if (result.error) {
    if (isNotSetUp(result.error)) throw notSetUpError()
    console.error(`[studio] ${what}:`, result.error.message?.slice(0, 300), result.error.code ?? '')
    throw storeError(what)
  }
  return result.data
}

/** True when a query failed only because a unique key was taken (Postgres 23505). */
export const isDuplicate = (error: { code?: string } | null | undefined) => error?.code === '23505'

/** A UUID, as the Studio's row ids are. */
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
