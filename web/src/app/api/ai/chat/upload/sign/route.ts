import { requireUser } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { isOwnChatUploadPath } from '@/lib/chat/upload-allowlist'
import { CHAT_UPLOAD_SIGN_MAX, CHAT_UPLOAD_URL_TTL_SECONDS } from '@/lib/chat/fresh-upload-url'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * POST /api/ai/chat/upload/sign   { paths: string[] }  →  { urls: { [path]: signedUrl } }
 *
 * Fresh signed links for files the caller uploaded in chat. A chat message
 * keeps the link its upload was given (/api/ai/chat/upload), which dies after
 * an hour, so a photo in a chat reopened later (or restored in a tab) showed
 * a broken image. The bubble now asks here for a fresh one when its link has
 * expired (src/lib/chat/fresh-upload-url.ts).
 *
 * Only the caller's own uploads, one object directly in `${user.id}/chat-uploads/`
 * (isOwnChatUploadPath, the rule read_chat_file and the upload route use): any
 * other path is left out of the answer, never signed. Links live an hour, as
 * an upload's does; nothing long-lived is minted.
 */
export async function POST(request: NextRequest) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { supabase, user } = auth

  const body = await request.json().catch(() => null)
  const raw: unknown = body && typeof body === 'object' ? (body as { paths?: unknown }).paths : undefined
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > CHAT_UPLOAD_SIGN_MAX) {
    return badRequest(`paths is a list of 1 to ${CHAT_UPLOAD_SIGN_MAX} storage paths`)
  }
  const paths = [...new Set(raw.filter((p): p is string => typeof p === 'string' && isOwnChatUploadPath(user.id, p)))]
  if (paths.length === 0) return NextResponse.json({ urls: {} })

  const { data, error } = await supabase.storage.from('attachments').createSignedUrls(paths, CHAT_UPLOAD_URL_TTL_SECONDS)
  if (error) return serverError(error.message)

  const urls: Record<string, string> = {}
  for (const entry of data ?? []) {
    if (entry.path && entry.signedUrl && !entry.error) urls[entry.path] = entry.signedUrl
  }
  return NextResponse.json({ urls })
}
