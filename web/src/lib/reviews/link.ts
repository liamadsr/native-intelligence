/**
 * The business's Google review link (roadmap D3): set once by the owner, by
 * text ("my review link is https://g.page/r/…/review"), kept on the
 * workspace (workspace.settings.review_link), and sent to each customer after
 * their job is done (./request.ts).
 *
 * Only a Google review link is accepted, over https, by host AND path: the
 * link goes out from the owner's own mailbox to their customers, so a link
 * that isn't one (a typo, a lookalike, or one of Google's own redirectors,
 * www.google.com/url?q=… or /amp/…, that would carry customers anywhere)
 * must never be stored. No query value may itself be a link.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Where a Google review link lives, host by host, and the paths it takes
 * there: a Business Profile's share link (g.page/r/…), a Maps short link
 * (maps.app.goo.gl/…, which only opens Google Maps), Search's write-a-review
 * page, and a place on Maps.
 */
const GOOGLE_REVIEW_PATHS: Readonly<Record<string, (url: URL) => boolean>> = {
  'g.page': (u) => /^\/r\/[A-Za-z0-9_-]+(\/review)?\/?$/.test(u.pathname),
  'maps.app.goo.gl': (u) => /^\/[A-Za-z0-9_-]+\/?$/.test(u.pathname),
  'search.google.com': (u) => u.pathname === '/local/writereview' || u.pathname === '/local/reviews',
  'www.google.com': (u) => u.pathname.startsWith('/maps/') || u.pathname === '/maps',
  'google.com': (u) => u.pathname.startsWith('/maps/') || u.pathname === '/maps',
  'maps.google.com': (u) => u.pathname === '/' || u.pathname.startsWith('/maps'),
}

/** True when a query value is itself a link (what a redirector forwards to). */
function queryCarriesALink(url: URL): boolean {
  for (const value of url.searchParams.values()) {
    if (/^(https?:)?\/\//i.test(value.trim()) || /^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(value.trim())) return true
  }
  return false
}

export const REVIEW_LINK_MAX_LENGTH = 500

export interface ReviewLinkSetting {
  url: string
  /** Who set it: the review requests go from their mailbox. */
  set_by: string
  set_at: string
}

/** The link as stored (trimmed), or why it can't be. Pure. */
export function parseReviewLink(raw: unknown): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'Give the review link, e.g. https://g.page/r/…/review.' }
  const text = raw.trim()
  if (text.length > REVIEW_LINK_MAX_LENGTH) return { ok: false, error: 'That link is too long to be a review link.' }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { ok: false, error: 'That isn\'t a link. It should start with https://.' }
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'The review link must start with https://.' }
  if (url.username || url.password) return { ok: false, error: 'That link carries a login, so it was not saved.' }
  const host = url.hostname.toLowerCase()
  const pathOk = Object.hasOwn(GOOGLE_REVIEW_PATHS, host) ? GOOGLE_REVIEW_PATHS[host](url) : false
  if (!pathOk || queryCarriesALink(url) || url.port) {
    return { ok: false, error: 'Only a Google review link can be saved (from your Google Business Profile: "Ask for reviews", or a g.page / maps.app.goo.gl link).' }
  }
  return { ok: true, url: url.toString() }
}

/** The stored setting, or null when there is none (or it no longer parses). Pure. */
export function reviewLinkOf(settings: unknown): ReviewLinkSetting | null {
  const raw = settings && typeof settings === 'object' ? (settings as { review_link?: unknown }).review_link : undefined
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<ReviewLinkSetting>
  if (typeof r.set_by !== 'string' || !r.set_by) return null
  const parsed = parseReviewLink(r.url)
  if (!parsed.ok) return null
  return { url: parsed.url, set_by: r.set_by, set_at: typeof r.set_at === 'string' ? r.set_at : '' }
}

/** The workspace's name and review link. Throws on a failed read. */
export async function readReviewSettings(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<{ businessName: string; link: ReviewLinkSetting | null }> {
  const { data, error } = await supabase.from('workspace').select('name, settings').eq('id', workspaceId).maybeSingle()
  if (error) throw new Error(`workspace read failed: ${error.message}`)
  const row = data as { name?: string | null; settings?: unknown } | null
  return { businessName: row?.name?.trim() || 'us', link: reviewLinkOf(row?.settings) }
}

/**
 * Store the link on the workspace, keeping every other setting. Owners and
 * admins only (it is workspace configuration other members' customers
 * receive). Service or RLS client: the role is checked here either way.
 */
export async function saveReviewLink(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; url: string; now?: number },
): Promise<{ ok: true; link: ReviewLinkSetting } | { ok: false; code: string; error: string }> {
  const parsed = parseReviewLink(args.url)
  if (!parsed.ok) return { ok: false, code: 'INVALID_LINK', error: parsed.error }
  const { data: member } = await supabase
    .from('member')
    .select('role')
    .eq('workspace_id', args.workspaceId)
    .eq('user_id', args.userId)
    .maybeSingle()
  const role = (member as { role?: string } | null)?.role
  if (role !== 'owner' && role !== 'admin') {
    return { ok: false, code: 'NOT_ALLOWED', error: 'Only the workspace owner or an admin can set the review link.' }
  }
  const { data: ws, error: readError } = await supabase.from('workspace').select('settings').eq('id', args.workspaceId).maybeSingle()
  if (readError || !ws) return { ok: false, code: 'READ_FAILED', error: 'Could not read the workspace, so the link was not saved.' }
  const link: ReviewLinkSetting = { url: parsed.url, set_by: args.userId, set_at: new Date(args.now ?? Date.now()).toISOString() }
  const settings = { ...(((ws as { settings?: unknown }).settings as Record<string, unknown> | null) ?? {}), review_link: link }
  const { error } = await supabase.from('workspace').update({ settings }).eq('id', args.workspaceId)
  if (error) return { ok: false, code: 'WRITE_FAILED', error: `The link was not saved: ${error.message}` }
  return { ok: true, link }
}
