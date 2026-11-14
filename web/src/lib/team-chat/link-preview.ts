/**
 * A team chat message's link preview (migration 555): when a message's words
 * hold a link, the server fetches the page once, out of the request path (the
 * message route asks for it after answering; the Inngest function
 * src/lib/inngest/team-chat-link-preview.ts does the work), and stores its
 * title, description and image on the message. The preview arrives live,
 * as an update of the message's row.
 *
 * The page is fetched by the SSRF-safe fetcher (src/lib/link-preview/
 * safe-fetch.ts: public addresses only, checked at the dial and on every
 * redirect, a short timeout, a size cap, nothing of the person's sent with
 * it). Only the first link is previewed. Server only.
 *
 * Privacy: the event carries the message id only; logs carry ids and
 * outcomes, never a URL or a word of the message.
 */
import { isEmailShareLinkUrl } from '@/lib/email-share/links'
import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from '@/lib/inngest/client'
import { checkPublicUrl, fetchPublicPage, PublicFetchError, type PublicFetchOptions, type PublicPage } from '@/lib/link-preview/safe-fetch'
import { decodeHtml, readPagePreview } from '@/lib/link-preview/parse'
import { trimLinkEnd } from './compose'
import type { TeamChatLinkPreview, TeamChatMessage } from './types'

export const TEAM_CHAT_LINK_PREVIEW_EVENT = 'team-chat/link-preview.requested' as const

/** The longest link previewed (anything longer is no link a person typed). */
const MAX_URL_CHARS = 2048

/**
 * The first http(s) link in a message's words, or null. Trailing punctuation
 * a sentence puts after a link ("see https://example.com.") is not part of it.
 */
export function firstLink(body: string): string | null {
  for (const match of body.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    // Sentence punctuation and unbalanced closing brackets at the end belong to the sentence.
    const url = trimLinkEnd(match[0])
    if (url.length > MAX_URL_CHARS) continue
    // A share link to an email thread (migration 646) never unfurls: its page is the person's mail.
    if (isEmailShareLinkUrl(url)) continue
    try {
      checkPublicUrl(url)
      return url
    } catch {
      continue
    }
  }
  return null
}

/** The event that asks for a message's preview (its id dedupes a retry of the same words). */
export function linkPreviewEvent(message: Pick<TeamChatMessage, 'id' | 'created_at' | 'edited_at'>) {
  const version = Date.parse(message.edited_at ?? message.created_at) || 0
  return { name: TEAM_CHAT_LINK_PREVIEW_EVENT, id: `team-chat-preview-${message.id}-${version}`, data: { messageId: message.id } }
}

/**
 * Ask for a message's preview, after the route has answered. Only when its
 * words hold a link, or (an edit) it had a preview its words may have lost.
 * Never throws: a message without its preview is still a message.
 */
export async function requestLinkPreview(
  message: Pick<TeamChatMessage, 'id' | 'body' | 'created_at' | 'edited_at' | 'link_preview'>,
  deps: { send?: (event: ReturnType<typeof linkPreviewEvent>) => Promise<unknown> } = {},
): Promise<boolean> {
  if (!firstLink(message.body) && !message.link_preview) return false
  try {
    await (deps.send ?? ((e) => inngest.send(e)))(linkPreviewEvent(message))
    return true
  } catch (err) {
    console.warn(`[team-chat] link preview request for message=${message.id} failed:`, err instanceof Error ? err.message : 'unknown')
    return false
  }
}

/** An image the page names for itself, kept only when it is https on a public-looking host (the reader's browser loads it). */
function safeImage(image: string | null): string | null {
  if (!image) return null
  try {
    const url = checkPublicUrl(image)
    return url.protocol === 'https:' && url.href.length <= MAX_URL_CHARS ? url.href : null
  } catch {
    return null
  }
}

/** A page as the preview it makes: an HTML page that names a title or a description, else null. */
export function previewOfPage(link: string, page: PublicPage): TeamChatLinkPreview | null {
  if (page.status < 200 || page.status >= 300) return null
  if (page.contentType !== 'text/html' && page.contentType !== 'application/xhtml+xml') return null
  const read = readPagePreview(decodeHtml(page.body, page.charset), page.url)
  if (!read.title && !read.description) return null
  return {
    url: link,
    site: read.siteName ?? new URL(page.url).hostname.replace(/^www\./, ''),
    title: read.title,
    description: read.description,
    image: safeImage(read.image),
  }
}

export type LinkPreviewOutcome = 'written' | 'cleared' | 'none' | 'unreadable' | 'gone' | 'changed'

/**
 * Write a message's preview: read it (service role), fetch its first link and
 * store what the page says. Written only while the words are the ones it read
 * (an edit in the meantime asks again), never on a deleted message. A message
 * whose words no longer hold a link loses its old preview. Returns the
 * outcome only. Never throws.
 */
export async function writeLinkPreview(
  svc: SupabaseClient,
  messageId: string,
  deps: { fetch?: (url: string, opts?: PublicFetchOptions) => Promise<PublicPage> } = {},
): Promise<LinkPreviewOutcome> {
  try {
    const { data: message } = await svc
      .from('team_chat_message')
      .select('id, body, deleted_at, link_preview')
      .eq('id', messageId)
      .maybeSingle<{ id: string; body: string; deleted_at: string | null; link_preview: TeamChatLinkPreview | null }>()
    if (!message || message.deleted_at) return 'gone'
    // The words as read: the write below holds only while they are still these.
    const body = message.body
    const hadPreview = !!message.link_preview
    const link = firstLink(body)
    let preview: TeamChatLinkPreview | null = null
    if (link) {
      try {
        preview = previewOfPage(link, await (deps.fetch ?? fetchPublicPage)(link))
      } catch (err) {
        if (!(err instanceof PublicFetchError)) throw err
        preview = null
      }
    }
    if (!preview && !hadPreview) return link ? 'unreadable' : 'none'
    const { data, error } = await svc
      .from('team_chat_message')
      .update({ link_preview: preview })
      .eq('id', messageId)
      .eq('body', body)
      .is('deleted_at', null)
      .select('id')
    if (error) return 'unreadable'
    if (!Array.isArray(data) || data.length === 0) return 'changed'
    return preview ? 'written' : 'cleared'
  } catch {
    return 'unreadable'
  }
}
