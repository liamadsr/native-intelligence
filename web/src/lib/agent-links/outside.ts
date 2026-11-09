/**
 * Agent links with Native Intelligence users outside your workspace (phase E; decisions 3,
 * 4 and 5 in /mnt/project-files/agent-links/contracts.md), read and written
 * with the service role. The routes call these after their own auth.
 *
 *   resolveEmailTarget    the confirmed user who signs in with an email, for
 *                         requestLink. Whatever it finds, the requester hears
 *                         the same "request sent" (decision 3): nothing here
 *                         or in requestLink tells them who is on Native Intelligence.
 *   requestLinkByEmail /  the two ways to ask someone outside: by the email
 *   createConnectLink     they sign in with (one email goes out, the same
 *                         whoever it is), or a link the requester sends
 *                         themselves. Both go through the store's requestLink.
 *   connect tokens        a link someone can open once, for 7 days, to land on
 *                         the request (signing up first if they need to).
 *                         Only an HMAC of the token is stored, like invite
 *                         codes. An email request carries one too, and the
 *                         email it sends links to it.
 *   redeemConnectToken /  bind a waiting request to the person who opened
 *   claimEmailRequests    its link, or who signed in with the email it named.
 *   listAnswerWorkspaces  which of my workspaces could answer a request
 *                         (decision 4), and whether each allows outside links.
 *   setOutsideLinksAllowed the workspace admin's switch (decision 5). Off ends
 *                         the outside links answering from that workspace.
 *
 * Server only.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { BASE_URL, sendEmail } from '@/lib/email'
import { escapeHtml } from '@/lib/email/plain-text-to-html'
import { endLinkForWorkspace, outsideLinksAllowed, requestLink, type LinkResult, type RequestLinkInput } from './store'

/** Where a connect link opens: /link/<token>. */
export const CONNECT_LINK_PATH = '/link/'
/** Email requests one person may send in a day (on top of 5 waiting at once). */
export const EMAIL_REQUESTS_PER_DAY = 10
const EMAIL_MAX = 320

/** An email as a request stores it: trimmed, lower-cased, one @ with something either side. Null when it isn't one. */
export function normalizeLinkEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const email = raw.trim().toLowerCase()
  if (email.length < 3 || email.length > EMAIL_MAX) return null
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null
}

/** The confirmed Native Intelligence user signing in with `email`, else null (migration 436). A failed lookup reads as nobody. */
export async function resolveEmailTarget(service: SupabaseClient, email: string): Promise<string | null> {
  const normalized = normalizeLinkEmail(email)
  if (!normalized) return null
  const { data, error } = await service.rpc('agent_link_user_for_email', { p_email: normalized })
  if (error) {
    console.error('[agent-links] email lookup failed:', error.message)
    return null
  }
  return typeof data === 'string' && data.length > 0 ? data : null
}

/** How many requests by email this person sent in the last day (the daily cap). */
export async function emailRequestsToday(service: SupabaseClient, requesterUserId: string, now = Date.now()): Promise<number> {
  const { count, error } = await service
    .from('agent_link')
    .select('id', { count: 'exact', head: true })
    .eq('requester_user_id', requesterUserId)
    .not('target_email', 'is', null)
    .gte('requested_at', new Date(now - 24 * 60 * 60_000).toISOString())
  if (error) return EMAIL_REQUESTS_PER_DAY // fail closed
  return count ?? 0
}

// ── Connect tokens ──────────────────────────────────────────────────────────

/** A fresh token: 24 random bytes, URL-safe (32 characters). */
export function generateConnectToken(): string {
  return randomBytes(24).toString('base64url')
}

/** Whether a string could be a token at all (before any lookup). */
export function isConnectTokenShape(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{32}$/.test(token)
}

/** The key tokens are hashed with: the required internal secret (fail closed without it). */
export function connectTokenKey(): string | null {
  const key = process.env.RUN_SKILL_INTERNAL_SECRET
  return key && key.length > 0 ? key : null
}

/** The stored form of a token (agent_link.connect_token_hash). */
export function hashConnectToken(token: string, key: string): string {
  return createHmac('sha256', key).update(`agent-link-connect:${token}`).digest('hex')
}

/** The link to send: https://dial8.ai/link/<token>. */
export function connectLinkUrl(token: string, base: string = BASE_URL): string {
  return `${base}${CONNECT_LINK_PATH}${token}`
}

/** The waiting request a token opens, as the /link page and redeem read it. */
export interface ConnectTarget {
  linkId: string
  requesterUserId: string
  requesterWorkspaceId: string
  requesterGuestId: string
  targetUserId: string | null
  targetEmail: string | null
  expiresAt: string | null
}

interface LinkRow {
  id: string
  requester_user_id: string
  requester_workspace_id: string
  requester_guest_id: string
  target_user_id: string | null
  target_email: string | null
  connect_token_hash?: string | null
  state: string
  expires_at: string | null
}

const LINK_SELECT = 'id, requester_user_id, requester_workspace_id, requester_guest_id, target_user_id, target_email, connect_token_hash, state, expires_at'

function isWaiting(row: Pick<LinkRow, 'state' | 'expires_at'>, now: number): boolean {
  return row.state === 'requested' && (row.expires_at === null || Date.parse(row.expires_at) > now)
}

function toTarget(row: LinkRow): ConnectTarget {
  return {
    linkId: row.id,
    requesterUserId: row.requester_user_id,
    requesterWorkspaceId: row.requester_workspace_id,
    requesterGuestId: row.requester_guest_id,
    targetUserId: row.target_user_id,
    targetEmail: row.target_email,
    expiresAt: row.expires_at,
  }
}

/** The waiting request a token opens, else null (unknown, used, expired, or no key). Constant-time on the hash. */
export async function findConnectTarget(service: SupabaseClient, token: string, now = Date.now()): Promise<ConnectTarget | null> {
  if (!isConnectTokenShape(token)) return null
  const key = connectTokenKey()
  if (!key) return null
  const hash = hashConnectToken(token, key)
  const { data, error } = await service.from('agent_link').select(LINK_SELECT).eq('connect_token_hash', hash).maybeSingle()
  if (error || !data) return null
  const row = data as LinkRow
  const stored = new Uint8Array(Buffer.from(row.connect_token_hash ?? '', 'utf8'))
  const given = new Uint8Array(Buffer.from(hash, 'utf8'))
  if (stored.length !== given.length || !timingSafeEqual(stored, given)) return null
  return isWaiting(row, now) ? toTarget(row) : null
}

// ── Asking ──────────────────────────────────────────────────────────────────

/** What the requester's workspace calls them, for the email and the /link page. */
async function requesterName(service: SupabaseClient, userId: string, workspaceId: string): Promise<string> {
  const { data } = await service.from('member').select('display_name').eq('user_id', userId).eq('workspace_id', workspaceId).maybeSingle()
  return (data as { display_name?: string | null } | null)?.display_name?.trim() || 'Someone'
}

type AskInput = Omit<RequestLinkInput, 'peerUserId' | 'email' | 'resolveEmail' | 'connectTokenHash'>

export type OutsideRequestResult = LinkResult | { ok: false; reason: 'daily_cap' | 'no_key' }

/**
 * Ask someone by email (decision 3). The address is looked up, and the
 * request carries a connect token either way; one email goes out with its
 * link, worded the same whether or not the address is on Native Intelligence. Refusals
 * are the store's, plus `daily_cap` (EMAIL_REQUESTS_PER_DAY).
 */
export async function requestLinkByEmail(service: SupabaseClient, input: AskInput & { email: string }, now = Date.now()): Promise<OutsideRequestResult> {
  const email = normalizeLinkEmail(input.email)
  if (!email) return { ok: false, reason: 'bad_email' }
  const key = connectTokenKey()
  if (!key) return { ok: false, reason: 'no_key' }
  if ((await emailRequestsToday(service, input.requesterUserId, now)) >= EMAIL_REQUESTS_PER_DAY) return { ok: false, reason: 'daily_cap' }

  const token = generateConnectToken()
  const result = await requestLink(
    service,
    { ...input, email, connectTokenHash: hashConnectToken(token, key), resolveEmail: (e) => resolveEmailTarget(service, e) },
    now,
  )
  if (!result.ok) return result
  await sendLinkRequestEmail({ to: email, requesterName: await requesterName(service, input.requesterUserId, input.workspaceId), url: connectLinkUrl(token) })
  return result
}

/**
 * A plain connect link the requester sends themselves: for whoever opens it
 * first, signing up if they need to. Shown once; only its hash is kept.
 */
export async function createConnectLink(service: SupabaseClient, input: AskInput, now = Date.now()): Promise<(LinkResult & { ok: true; url: string }) | Exclude<OutsideRequestResult, { ok: true }>> {
  const key = connectTokenKey()
  if (!key) return { ok: false, reason: 'no_key' }
  const token = generateConnectToken()
  const result = await requestLink(service, { ...input, email: null, peerUserId: null, connectTokenHash: hashConnectToken(token, key) }, now)
  if (!result.ok) return result
  return { ...result, url: connectLinkUrl(token) }
}

// ── Binding a request to the person who opened it ───────────────────────────

export type BindResult = { ok: true; linkId: string } | { ok: false; reason: 'already_linked' | 'failed' }

const isUniqueClash = (error: { code?: string } | null) => error?.code === '23505'

/**
 * Make `userId` the person a waiting request is for: the link's target, and
 * the peer on the requester's half. Single use: the token is spent here. If
 * the requester already lists this user (an earlier link's half they kept),
 * that row takes 'dial8' and becomes the half, so one person stays one row
 * (decision 1), and the placeholder half is removed. Another open link
 * between the two is `already_linked`.
 */
export async function bindLinkTarget(service: SupabaseClient, target: ConnectTarget, userId: string): Promise<BindResult> {
  const pair = [target.requesterUserId, userId]
  const { data: open, error: openErr } = await service
    .from('agent_link')
    .select('id')
    .in('state', ['requested', 'active'])
    .neq('id', target.linkId)
    .in('requester_user_id', pair)
    .in('target_user_id', pair)
  if (openErr) return { ok: false, reason: 'failed' }
  if ((open ?? []).length > 0) return { ok: false, reason: 'already_linked' }

  // The link: still waiting, and either unbound or already this user's (an email that matched).
  const { data: bound, error: bindErr } = await service
    .from('agent_link')
    .update({ target_user_id: userId, connect_token_hash: null, updated_at: new Date().toISOString() })
    .eq('id', target.linkId)
    .eq('state', 'requested')
    .or(`target_user_id.is.null,target_user_id.eq.${userId}`)
    .select('id')
  if (isUniqueClash(bindErr)) return { ok: false, reason: 'already_linked' }
  if (bindErr || !bound || bound.length === 0) return { ok: false, reason: 'failed' }

  // The requester's half.
  const { data: existing } = await service
    .from('agent_guest')
    .select('id, channels')
    .eq('owner_user_id', target.requesterUserId)
    .eq('peer_user_id', userId)
    .neq('state', 'removed')
    .neq('id', target.requesterGuestId)
    .maybeSingle()
  if (existing) {
    const row = existing as { id: string; channels: string[] | null }
    const channels = Array.from(new Set([...(row.channels ?? []), 'dial8']))
    const { error: mergeErr } = await service.from('agent_guest').update({ channels }).eq('id', row.id)
    if (mergeErr) return { ok: false, reason: 'failed' }
    await service.from('agent_link').update({ requester_guest_id: row.id }).eq('id', target.linkId)
    await service
      .from('agent_guest')
      .update({ state: 'removed', removed_at: new Date().toISOString() })
      .eq('id', target.requesterGuestId)
      .is('peer_user_id', null)
    return { ok: true, linkId: target.linkId }
  }
  const { error: halfErr } = await service
    .from('agent_guest')
    .update({ peer_user_id: userId })
    .eq('id', target.requesterGuestId)
    .or(`peer_user_id.is.null,peer_user_id.eq.${userId}`)
  if (isUniqueClash(halfErr)) return { ok: false, reason: 'already_linked' }
  if (halfErr) return { ok: false, reason: 'failed' }
  return { ok: true, linkId: target.linkId }
}

/** The signed-in person, as binding needs them. */
export interface LinkingUser {
  id: string
  email?: string | null
  email_confirmed_at?: string | null
}

export type RedeemResult =
  | { ok: true; linkId: string }
  | { ok: false; reason: 'invalid' | 'self' | 'wrong_account' | 'already_linked' | 'failed' }

/** Whether this signed-in person is who an email request was for: a confirmed sign-in on that address. */
function emailMatches(user: LinkingUser, email: string): boolean {
  return !!user.email_confirmed_at && typeof user.email === 'string' && user.email.trim().toLowerCase() === email
}

/**
 * Open a connect link as the signed-in person: the request becomes theirs to
 * review. A link sent to an email works only for the account on that email;
 * one that already names a user works only for them.
 */
export async function redeemConnectToken(service: SupabaseClient, input: { token: string; user: LinkingUser }, now = Date.now()): Promise<RedeemResult> {
  const target = await findConnectTarget(service, input.token, now)
  if (!target) return { ok: false, reason: 'invalid' }
  if (target.requesterUserId === input.user.id) return { ok: false, reason: 'self' }
  if (target.targetUserId !== null && target.targetUserId !== input.user.id) return { ok: false, reason: 'wrong_account' }
  if (target.targetUserId === null && target.targetEmail !== null && !emailMatches(input.user, target.targetEmail)) {
    return { ok: false, reason: 'wrong_account' }
  }
  return bindLinkTarget(service, target, input.user.id)
}

/**
 * Requests sent by email to this person's address before they were on Native Intelligence
 * (or before it matched): each becomes theirs, so it shows on their People
 * tab. Runs on every read of their links; a confirmed address only. Returns
 * how many it bound.
 */
export async function claimEmailRequests(service: SupabaseClient, user: LinkingUser, now = Date.now()): Promise<number> {
  const email = normalizeLinkEmail(user.email)
  if (!email || !user.email_confirmed_at) return 0
  const { data, error } = await service
    .from('agent_link')
    .select(LINK_SELECT)
    .eq('target_email', email)
    .is('target_user_id', null)
    .eq('state', 'requested')
    .neq('requester_user_id', user.id)
  if (error || !data) return 0
  let bound = 0
  for (const row of data as LinkRow[]) {
    if (!isWaiting(row, now)) continue
    const result = await bindLinkTarget(service, toTarget(row), user.id)
    if (result.ok) bound++
  }
  return bound
}

// ── Which workspace answers ─────────────────────────────────────────────────

export interface AnswerWorkspace {
  id: string
  name: string
  /** The admin's switch for links outside the workspace (decision 5). */
  outsideAllowed: boolean
}

/** My workspaces, any of which could answer a request (decision 4), oldest membership first. */
export async function listAnswerWorkspaces(service: SupabaseClient, userId: string): Promise<AnswerWorkspace[] | null> {
  const { data, error } = await service
    .from('member')
    .select('workspace_id, created_at, workspace:workspace_id(id, name, settings)')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
  if (error) return null
  const out: AnswerWorkspace[] = []
  for (const row of (data ?? []) as Array<{ workspace: unknown }>) {
    const ws = (Array.isArray(row.workspace) ? row.workspace[0] : row.workspace) as { id: string; name: string | null; settings: unknown } | null
    if (!ws) continue
    out.push({ id: ws.id, name: ws.name ?? 'Workspace', outsideAllowed: outsideLinksAllowed(ws.settings) })
  }
  return out
}

// ── The admin's switch ──────────────────────────────────────────────────────

/**
 * Store the switch. Turning it off ends every active or waiting outside link
 * that answers from, or was asked from, this workspace, for both people (the
 * same end as Disconnect). Returns how many links it ended.
 */
export async function setOutsideLinksAllowed(
  service: SupabaseClient,
  input: { workspaceId: string; allowed: boolean; byUserId: string },
): Promise<{ ended: number } | { error: string }> {
  const { data, error } = await service.from('workspace').select('settings').eq('id', input.workspaceId).maybeSingle()
  if (error) return { error: error.message }
  if (!data) return { error: 'Workspace not found' }
  const settings = ((data as { settings?: unknown }).settings ?? {}) as Record<string, unknown>
  const { data: updated, error: writeErr } = await service
    .from('workspace')
    .update({ settings: { ...settings, outside_agent_links: input.allowed } })
    .eq('id', input.workspaceId)
    .select('id')
  if (writeErr) return { error: writeErr.message }
  if (!updated || updated.length === 0) return { error: 'The workspace update affected no rows' }
  if (input.allowed) return { ended: 0 }

  const { data: links, error: linksErr } = await service
    .from('agent_link')
    .select('id')
    .eq('outside', true)
    .in('state', ['requested', 'active'])
    .or(`requester_workspace_id.eq.${input.workspaceId},target_workspace_id.eq.${input.workspaceId}`)
  if (linksErr) return { error: linksErr.message }
  let ended = 0
  for (const link of (links ?? []) as Array<{ id: string }>) {
    const result = await endLinkForWorkspace(service, { linkId: link.id, byUserId: input.byUserId })
    if (result.ok) ended++
  }
  return { ended }
}

// ── The request email ───────────────────────────────────────────────────────

/**
 * The one email a request by address sends, the same whether or not the
 * address is on Native Intelligence (decision 3): who asked, and the connect link, which
 * signs them in or up and opens the request. Returns whether Resend took it.
 */
export async function sendLinkRequestEmail(input: { to: string; requesterName: string; url: string }): Promise<boolean> {
  const name = input.requesterName.trim() || 'Someone'
  const nameHtml = escapeHtml(name)
  try {
    const { error } = await sendEmail({
      to: input.to,
      subject: `${name} wants their Native Intelligence agent to talk to yours`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="margin: 0 0 16px;">${nameHtml} wants your agents to talk</h2>
          <p style="color: #555; line-height: 1.6;">
            ${nameHtml} asked to connect their Native Intelligence agent with yours, so the two can find times and answer each other's questions. Nothing is shared until you accept, and you choose what their agent may ask yours.
          </p>
          <a href="${input.url}" style="display: inline-block; margin: 24px 0; padding: 12px 24px; background: #000; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 500;">
            Review the request
          </a>
          <p style="color: #888; font-size: 13px; line-height: 1.5;">
            If you're new to Native Intelligence, the link lets you create an account first. It works once and expires in 7 days. If you didn't expect this email, you can ignore it.
          </p>
        </div>
      `,
    })
    if (error) {
      console.error('[agent-links] request email refused:', error)
      return false
    }
    return true
  } catch (err) {
    console.error('[agent-links] request email failed:', err)
    return false
  }
}
