// A finished export as a short-lived link that downloads it without a session: what the desktop app opens in the
// person's own browser when an export is too large to hand to its Save panel (the released app's `save_file` takes the
// whole file as a JSON array of numbers, which a large video would freeze or crash).
//
// Minting is the person's: a member of the workspace (not a guest, the Studio on), as every Studio route checks, for a
// file of that workspace that is still kept (what /file would serve them). The link is a random token kept as a studio_record of
// that workspace (collection `download_links`) with the file, its download name, who asked and when it ends
// (LINK_SECONDS). Using it needs no session (the person's browser may not be signed in): the token is looked up, its
// time and its asker's membership checked again, and the file served as an attachment, as /file serves it.
import { randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { apiError, notFound } from '@/lib/api-errors'
import { checkBlobKey, getBlob } from './blobs'
import { must, type StudioContext } from './context'
import { notFoundError } from './errors'
import { serveBlob, type PartFetch } from './files'
import { errorResponse } from './router'
import { deleteRecord, putRecord } from './records'
import type { StudioStorage } from './storage'

export const DOWNLOAD_LINKS = 'download_links'
/** How long a download link works: long enough to open the browser and start, short enough not to be worth sharing. */
export const LINK_SECONDS = 10 * 60
/** The public route a link points at (src/app/api/studio/download/[token]). */
export const LINK_PATH = '/api/studio/download/'
const TOKEN = /^[A-Za-z0-9_-]{32}$/

type LinkRecord = { key: string; name: string; userId: string | null; expiresAt: string }

/**
 * A download link for a stored file of this workspace (a finished export, an ad's image, a reel): what /file serves
 * the same person, under `name`. `{ url }` is a path on this app, valid LINK_SECONDS.
 */
export async function mintFileLink(ctx: StudioContext, body: { key?: unknown; name?: unknown }, now = Date.now()): Promise<{ url: string; expiresAt: string }> {
  const key = checkBlobKey(body.key)
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 160) : key.split('/').at(-1) || 'download'
  if (!(await getBlob(ctx, key))) throw notFoundError(key.startsWith('exports/') ? 'This export is no longer kept: exports are kept for 30 days. Export the video again.' : 'There is no file under that key.')
  const token = randomBytes(24).toString('base64url')
  const expiresAt = new Date(now + LINK_SECONDS * 1000).toISOString()
  await putRecord(ctx, DOWNLOAD_LINKS, token, { key, name, userId: ctx.userId, expiresAt } satisfies LinkRecord)
  return { url: `${LINK_PATH}${token}`, expiresAt }
}

/** Answer GET/HEAD of a download link: the file as an attachment, or why not (404, 410). */
export async function serveDownloadLink(supabase: SupabaseClient, token: string, request: Request, options: { now?: number; fetchPart?: PartFetch; storage?: StudioStorage } = {}): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return apiError('That method is not allowed here.', { status: 405, code: 'METHOD_NOT_ALLOWED' })
  if (!TOKEN.test(token)) return notFound('This download link is not valid.')
  try {
    return await serve(supabase, token, request, options)
  } catch (error) {
    return errorResponse(error)
  }
}

async function serve(supabase: SupabaseClient, token: string, request: Request, options: { now?: number; fetchPart?: PartFetch; storage?: StudioStorage }): Promise<Response> {
  const found = must(await supabase.from('studio_record').select('workspace_id, value').eq('collection', DOWNLOAD_LINKS).eq('key', token).maybeSingle(), 'read that link') as { workspace_id: string; value: LinkRecord } | null
  if (!found) return notFound('This download link is not valid.')
  const ctx: StudioContext = { supabase, workspaceId: found.workspace_id, userId: found.value.userId, ...(options.storage ? { storage: options.storage } : {}) }
  if (Date.parse(found.value.expiresAt) <= (options.now ?? Date.now())) {
    await deleteRecord(ctx, DOWNLOAD_LINKS, token).catch(() => undefined)
    return apiError('This download link has expired. Save the video again from the Studio.', { status: 410, code: 'EXPIRED' })
  }
  // Whoever asked for it must still be a member (not a guest) of the workspace the file is in.
  if (!found.value.userId) return notFound('This download link is not valid.')
  const member = must(await supabase.from('member').select('role').eq('workspace_id', found.workspace_id).eq('user_id', found.value.userId).maybeSingle(), 'read that link') as { role?: string | null } | null
  if (!member || member.role === 'guest') return notFound('This download link is not valid.')
  const blob = await getBlob(ctx, found.value.key)
  if (!blob) return notFound('This export is no longer kept: exports are kept for 30 days. Export the video again.')
  return serveBlob(ctx, blob, request, { download: found.value.name, fetchPart: options.fetchPart })
}
