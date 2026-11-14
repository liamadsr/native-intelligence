/**
 * The share routes' shared edges (src/app/api/account/email/shares/*): who
 * may call them at all, and how a refusal is answered.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember, type MemberAuthContext } from '@/lib/api-auth'
import { apiError } from '@/lib/api-errors'
import { isDeviceToken } from '@/lib/device-tokens'
import type { ShareCaller, ShareFailure } from './service'
import { ShareProviderBusyError } from './provider'
import { EMAIL_SHARE_BUSY_TEXT } from './types'

/**
 * Shared mail opens in a person's own session. The web app's fetch layer
 * (src/lib/workspace-fetch.ts) sends that session's Supabase access token as
 * `Authorization: Bearer` on every /api/ call, so a Supabase Bearer is the
 * person themselves and passes. A device token (`nid_…`: hardware and the
 * desktop's device bodies, which act for agents) is refused, so no device or
 * agent reaches a share's mail through these routes. MCP clients never reach
 * them: MCP tools run server-side through /api/mcp, not these routes.
 * (iOS would plug in here, with a fenced check of its own.)
 */
export function refuseBearer(request: NextRequest): Response | null {
  const header = request.headers.get('authorization') ?? ''
  const bearer = /^bearer\s+(.+)$/i.exec(header.trim())
  if (bearer && isDeviceToken(bearer[1].trim())) return apiError('Shared email opens in the app', { status: 403, code: 'APP_ONLY' })
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

/**
 * A thrown error as the answer: the mailbox busy (rate limit, outage, token
 * refresh) is 503 `busy`, which the views offer to retry, never "no longer
 * available"; anything else is 500. Logged by the error's name only: a
 * provider's message may quote the mail.
 */
export function shareError(err: unknown, what: string, fallback: string): Response {
  const name = err instanceof Error ? err.name : 'unknown'
  if (err instanceof ShareProviderBusyError) {
    console.warn(`[email-share] ${what} busy provider=${err.provider} status=${err.status ?? 'network'}`)
    return apiError(EMAIL_SHARE_BUSY_TEXT, { status: 503, code: 'busy' })
  }
  console.error(`[email-share] ${what} failed:`, name)
  return apiError(fallback, { status: 500, code: 'failed' })
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
  // RFC 5987: encodeURIComponent leaves ' ( ) * as they are; they are encoded too.
  const encoded = encodeURIComponent(name.slice(0, 200)).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${plain}"; filename*=UTF-8''${encoded}`
}
