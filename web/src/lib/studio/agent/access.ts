/**
 * Who may use the Studio tools, and how a Studio refusal reads to the agent.
 *
 * Every tool runs as the person, on the service client (the Studio tables are
 * service-role only: migration 620), fenced to the workspace by the Studio
 * server's own functions (src/lib/studio/server/). Before any of that: the
 * person must be a member of the workspace, and not a workspace guest (a
 * guest sees only what is shared with them, and nothing in the Studio is).
 *
 * A refusal is `{ success: false, code, error }`, the error one plain
 * sentence, as every tool's.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { StudioError } from '@/lib/studio/server/errors'
import type { StudioContext } from '@/lib/studio/server/context'

/** A tool's refusal. */
export interface StudioRefusal {
  success: false
  code: string
  error: string
}

export function refusal(code: string, error: string): StudioRefusal {
  return { success: false, code, error }
}

export function isRefusal(value: unknown): value is StudioRefusal {
  return !!value && typeof value === 'object' && (value as { success?: unknown }).success === false
}

/**
 * The Studio context for the person in the workspace, or a refusal: no
 * workspace, not a member, or a workspace guest.
 */
export async function studioContext(supabase: SupabaseClient, userId: string, workspaceId: string | undefined): Promise<StudioContext | StudioRefusal> {
  if (!workspaceId) return refusal('NO_WORKSPACE', 'No workspace is active.')
  const { data, error } = await supabase.from('member').select('role').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle<{ role: string | null }>()
  if (error) return refusal('INTERNAL', "Couldn't check your place in this workspace just now. Try again.")
  if (!data) return refusal('FORBIDDEN', "You're not a member of this workspace, so its Studio isn't yours to use.")
  if (data.role === 'guest') return refusal('FORBIDDEN', "A workspace guest can't use the Studio. Ask a member of the workspace to do this.")
  return { supabase, workspaceId, userId }
}

/** What a thing is called in a not-found refusal, and where its id comes from. */
const MISSING: Record<'video' | 'studio_project' | 'version' | 'job' | 'asset', string> = {
  video: 'No such video in this workspace (or it is in the trash). list_studio_projects lists the videos.',
  studio_project: 'No such Studio project in this workspace. list_studio_projects lists them.',
  version: 'No such version of this video. list_studio_versions lists them.',
  job: 'No such Studio job in this workspace.',
  asset: 'No such media in the library. list_studio_assets lists it.',
}

/** What a Studio tool answers where the Studio is not set up on the server. */
export const NOT_SET_UP_REFUSAL = 'The Studio is not set up on this server yet, so nothing was done. Do not retry: tell the person the Studio is not available here yet.'

/** The refusal for a thing that isn't in the workspace (or is in the trash). */
export function missingRefusal(kind: keyof typeof MISSING): StudioRefusal {
  return refusal('NOT_FOUND', MISSING[kind])
}

/**
 * Any error a Studio call threw, as a refusal: the Studio server's own
 * sentence (a locked beat, a failing step, a stale digest), a not-found named
 * in the agent's words ("video", never the editor's "project"), anything else
 * as a plain failure that leaks nothing of the database.
 */
export function studioRefusal(error: unknown, missing: keyof typeof MISSING = 'video'): StudioRefusal {
  if (error instanceof StudioError) {
    // The server's database has no Studio yet: retrying changes nothing.
    if (error.code === 'STUDIO_NOT_SET_UP') return refusal('STUDIO_NOT_SET_UP', NOT_SET_UP_REFUSAL)
    if (error.status === 404) return missingRefusal(missing)
    if (error.code === 'DIGEST_CONFLICT') {
      return refusal('DIGEST_CONFLICT', 'The video changed since you read it (the person may be editing it). Read it again with get_studio_video, then redo the edit against the new digest.')
    }
    return refusal(error.code ?? (error.status >= 500 ? 'INTERNAL' : 'INVALID'), error.message)
  }
  // The engine throws plain errors that name the failing step or the locked beat: pass them through.
  if (error instanceof Error && error.message) return refusal('INVALID', error.message)
  return refusal('INTERNAL', 'Something went wrong in the Studio. Try again.')
}
