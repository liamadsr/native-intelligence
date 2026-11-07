/**
 * Fresh links for files uploaded in chat.
 *
 * A chat message keeps the signed link its upload was given
 * (/api/ai/chat/upload), and a signed link dies after an hour. So a photo in
 * a chat reopened later, restored in a tab, or clicked in a tab left open
 * showed a broken image. Wherever such a link is shown, an expired one (or
 * one about to expire) is swapped for a fresh one from
 * /api/ai/chat/upload/sign, which signs the caller's own uploads alone
 * (useFreshUploadUrl in ./use-fresh-upload-url.ts).
 *
 * The model never sees these links: it reads a photo with read_chat_file.
 */

/** How long a chat upload's signed link lives: an upload's, and a fresh one's. */
export const CHAT_UPLOAD_URL_TTL_SECONDS = 3600
/** Paths one sign request may carry. */
export const CHAT_UPLOAD_SIGN_MAX = 50
/** A link this close to expiring is refreshed before it is shown. */
export const CHAT_UPLOAD_REFRESH_MARGIN_MS = 60_000

/** A Supabase signed link to an object in the attachments bucket. */
const SIGNED_ATTACHMENT = /\/storage\/v1\/object\/sign\/attachments\/(.+)$/

/** A chat upload's signed link, read. */
export interface SignedUpload {
  /** Its storage path, `<user>/chat-uploads/<name>`. */
  path: string
  /** When the link expires (ms), from its token; null when that can't be read. */
  expiresAt: number | null
}

/** When a signed link's token expires (ms), or null. */
function tokenExpiry(token: string | null): number | null {
  const payload = token?.split('.')[1]
  if (!payload) return null
  try {
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: unknown }
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null
  } catch {
    return null
  }
}

/** A chat upload's signed link, read; null for any other URL (a blob, another bucket, a page). */
export function signedUploadOf(url: string): SignedUpload | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const match = SIGNED_ATTACHMENT.exec(parsed.pathname)
  if (!match) return null
  let path: string
  try {
    path = decodeURIComponent(match[1])
  } catch {
    return null
  }
  if (!/^[^/]+\/chat-uploads\/[^/]+$/.test(path)) return null
  return { path, expiresAt: tokenExpiry(parsed.searchParams.get('token')) }
}

/** Whether a link is expired or about to be (one whose expiry can't be read counts). */
export function isStaleUpload(upload: SignedUpload, now: number = Date.now()): boolean {
  return upload.expiresAt === null || upload.expiresAt - CHAT_UPLOAD_REFRESH_MARGIN_MS <= now
}

/** Fresh links this page has been given, by path. */
const freshLinks = new Map<string, { url: string; expiresAt: number }>()
/** Paths asked for in this tick, each with whoever waits on it. */
let pending: Map<string, Array<(url: string | null) => void>> | null = null

/**
 * A fresh signed link for the caller's chat upload at `path`, or null when
 * none could be had (not theirs, gone, or the request failed). A link already
 * fetched is reused while it lasts; paths asked for in the same tick go in
 * one request (a reopened chat with several photos asks once).
 */
export function freshUploadUrl(path: string, now: number = Date.now()): Promise<string | null> {
  const known = freshLinks.get(path)
  if (known && known.expiresAt - CHAT_UPLOAD_REFRESH_MARGIN_MS > now) return Promise.resolve(known.url)
  return new Promise((resolve) => {
    if (!pending) {
      pending = new Map()
      setTimeout(() => void signPending(), 0)
    }
    pending.set(path, [...(pending.get(path) ?? []), resolve])
  })
}

async function signPending(): Promise<void> {
  const batch = pending
  pending = null
  if (!batch) return
  const paths = [...batch.keys()]
  for (let i = 0; i < paths.length; i += CHAT_UPLOAD_SIGN_MAX) {
    const chunk = paths.slice(i, i + CHAT_UPLOAD_SIGN_MAX)
    let urls: Record<string, unknown> = {}
    try {
      const res = await fetch('/api/ai/chat/upload/sign', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paths: chunk }),
      })
      if (res.ok) urls = ((await res.json()) as { urls?: Record<string, unknown> }).urls ?? {}
    } catch {
      // Best effort: the bubble keeps the link it had.
    }
    for (const path of chunk) {
      const url = typeof urls[path] === 'string' ? (urls[path] as string) : null
      if (url) {
        const expiresAt = signedUploadOf(url)?.expiresAt ?? Date.now() + CHAT_UPLOAD_URL_TTL_SECONDS * 1000
        freshLinks.set(path, { url, expiresAt })
      }
      for (const resolve of batch.get(path) ?? []) resolve(url)
    }
  }
}

/** Forget every fresh link this page was given (tests). */
export function resetFreshUploadUrlsForTests(): void {
  freshLinks.clear()
  pending = null
}
