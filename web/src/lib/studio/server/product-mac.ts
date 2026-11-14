// The Mac body's door to the Studio's product jobs (src/app/api/local-agent/agent/studio): who is asking, checked the
// way every Mac body call is (agent-access.ts authorizeMacBody: the job's session token, a live session of the token's
// own person, the workspace and its membership), then the Studio's own fence (no workspace guest), and only for a job
// the person started or asked for in a typed turn: a loop's unattended job never brings product code into the Studio.
import type { SupabaseClient } from '@supabase/supabase-js'
import { apiError, forbidden } from '@/lib/api-errors'
import { authorizeMacBody, workerJobRefusal } from '@/lib/local-agent/agent-access'
import { isRefusal, studioContext } from '@/lib/studio/agent/access'
import type { StudioContext } from './context'
import type { FolderNames, MacJobCaller } from './products'

/** A Mac session allowed to work on Studio product jobs. */
export type MacStudio = { ctx: StudioContext; caller: MacJobCaller; names: FolderNames }

/**
 * A request's body read into memory, or null once it passes `maxBytes`: the read stops there and the rest is
 * cancelled, so a body with no length (or a false one) can never hold more than the cap in memory.
 */
export async function readCappedBody(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}

/** The Mac session behind a request, ready for the Studio, or the refusal to answer. */
export async function macStudio(request: Request, svc: SupabaseClient): Promise<MacStudio | Response> {
  const body = await authorizeMacBody(request, svc)
  if (body instanceof Response) return body
  // A job on the person's own coding agent never brings product code into the Studio either.
  if (body.session.worker) return workerJobRefusal()
  if (body.caller !== 'person_remote') return forbidden('Studio product jobs run only in a local agent the person started or asked for.')
  const { data, error } = await svc.from('local_agent_session').select('folder_id').eq('id', body.session.id).maybeSingle<{ folder_id: string }>()
  if (error || !data?.folder_id) return apiError("This local agent's folder can't be read just now", { status: 503, code: 'UNAVAILABLE' })
  const ctx = await studioContext(svc, body.session.userId, body.session.workspaceId)
  if (isRefusal(ctx)) return forbidden(ctx.error)
  return {
    ctx,
    caller: { userId: body.session.userId, sessionId: body.session.id, folderId: data.folder_id },
    names: { folderLabel: body.session.folderLabel, deviceName: body.session.deviceName },
  }
}
