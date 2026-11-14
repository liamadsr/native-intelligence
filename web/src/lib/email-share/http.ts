/**
 * The share routes' shared edges (src/app/api/account/email/shares/*): who
 * may call them at all, and how a refusal is answered.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember, type MemberAuthContext } from '@/lib/api-auth'
import { apiError } from '@/lib/api-errors'
import type { ShareCaller, ShareFailure } from './service'

/**
 * Shared mail opens in the app, in a person's own session: a Bearer caller
 * (an MCP client, a device token, a script holding an access token) is
 * refused, so no agent reaches a share's mail through these routes either.
 * (iOS would plug in here, with a fenced check of its own.)
 */
export function refuseBearer(request: NextRequest): Response | null {
  const header = request.headers.get('authorization') ?? ''
  if (/^bearer\s/i.test(header)) return apiError('Shared email opens in the app', { status: 403, code: 'APP_ONLY' })
  return null
}

/** The signed-in member, as a share caller; or the refusal to send. */
export async function shareCaller(request: NextRequest): Promise<ShareCaller | Response> {
  const refused = refuseBearer(request)
  if (refused) return refused
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  return callerOf(auth)
}

export function callerOf(auth: MemberAuthContext): ShareCaller {
  return { supabase: auth.supabase, userId: auth.user.id, workspaceId: auth.workspaceId, memberId: auth.member.id }
}

/** A refusal as the API's error shape: `{ error, code }`, never anything of the mail. */
export function shareFailure(f: ShareFailure): Response {
  return apiError(f.error, { status: f.status, code: f.code })
}

/** A response no cache keeps. */
export function noStore<T>(body: T, init: { status?: number } = {}): NextResponse {
  return NextResponse.json(body, { status: init.status ?? 200, headers: { 'Cache-Control': 'no-store, private' } })
}

export function isShareFailure(value: unknown): value is ShareFailure {
  return !!value && typeof value === 'object' && (value as { ok?: unknown }).ok === false
}

// ── Attachments ─────────────────────────────────────────────────────────────

/** Types a browser could run or draw as a page: handed on as plain bytes instead. */
const ACTIVE_TYPES = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|text\/javascript|application\/javascript|application\/x-javascript)\b/i

export function downloadType(mimeType: string): string {
  const type = mimeType.trim().toLowerCase()
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type) || ACTIVE_TYPES.test(type)) return 'application/octet-stream'
  return type
}

/** `attachment; filename="…"; filename*=UTF-8''…`, the plain name stripped to safe ASCII. */
export function contentDisposition(name: string): string {
  const plain = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').slice(0, 200) || 'attachment'
  return `attachment; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name.slice(0, 200))}`
}
