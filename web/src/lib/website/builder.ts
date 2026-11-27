/**
 * A business's website on a site builder, worked on by text (roadmap issue
 * #13, migration 724, docs/plans/hosted-site-builders.md): the same tools and
 * the same one card as the GitHub path (./start.ts, ./approval.ts), with the
 * builder's own API in place of a pull request.
 *
 * Liam, 11-27, on issue #13: "let's do it": quote forms and website changes
 * by text for sites on WordPress, Wix, Webflow, Framer and Shopify. Phase 1
 * is WordPress, self-hosted (no developer app, no marketplace review); phase
 * 2 is Shopify (an app of ours the merchant approves; custom distribution
 * first, the owner's choice of distribution still open).
 *
 *   connect   {@link startBuilderConnect}: the builder's own connect page
 *             (WordPress: "Authorize Application" on the owner's site;
 *             Shopify: the store's own consent page for our app), with
 *             a signed state; {@link completeWordpressConnect} (the callback
 *             route) checks the state against the signed-in person, reads
 *             the login's rights, and saves the site with the login
 *             encrypted (src/lib/crypto/credentials.ts, the OAuth tokens'
 *             key).
 *   read      {@link builderRead}: the site's pages, or one page's text, so
 *             the agent quotes exactly what it replaces.
 *   edit      {@link startBuilderEdit}: exact text and its replacement, each
 *             found once on the page; never a script, a frame or an event
 *             handler. Staged on the change row (website_change.staged), and
 *             the card raised at once ({@link raiseBuilderCard}): the card
 *             quotes what is replaced and with what (the preview).
 *   wire      {@link startBuilderWiring}: one of the business's public forms
 *             drawn on a page by our embed (src/lib/forms/manage.ts
 *             embedSnippet) in the builder's own block, with a fresh link
 *             that goes live only at the yes (./form-target.ts).
 *   undo      {@link startBuilderUndo}: the text the last change replaced,
 *             written back, if the page is still what that change wrote.
 *   yes       {@link applyBuilderYes} (./approval.ts mergeWebsiteChange): the
 *             page must still be what the card was made from (a page edited
 *             in the builder since is refused, as a moved pull request head
 *             is); then the write, which the builder keeps a revision of.
 *
 * Nothing outward happens before the owner's yes. Off unless WEBSITE_BUILDERS
 * names the builder (empty: the flow is exactly the GitHub one). Never throws
 * for an outcome the owner should hear: each is a result.
 *
 * Server only.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptCredential, encryptCredential } from '@/lib/crypto/credentials'
import { isDemoWorkspace, DEMO_OFF } from '@/lib/demo/demo-mode'
import { embedSnippet } from '@/lib/forms/manage'
import { generateFormKey, hashFormKey } from '@/lib/forms/store'
import { oauthStateSecret } from '@/lib/oauth/state'
import { createToolApproval, type NewApproval, type NewApprovalResult } from '@/lib/safety/approvals'
import { appOrigin } from '@/lib/twilio/config'
import { clip, mergeCardCopy } from './brief'
import { activateFormLink, formWiringTarget, wiredFormOrigins } from './form-target'
import { publicHttpsUrl } from './fetch'
import { wordpressAuthorizeLink, wordpressClient, wordpressDiscover, type WordpressDeps } from './providers/wordpress'
import { isShopHost, shopHostOf, shopifyAuthorizeLink, shopifyCallbackValid, shopifyClient, shopifyExchangeCode, SHOPIFY_SCOPES } from './providers/shopify'
import { shopifyApp } from './providers/enabled'
import { enabledBuilders } from './providers/enabled'
import { PROVIDER_LABEL, type BuilderClient, type BuilderProvider, type ContentRef, type ContentSnapshot, type StagedWrite } from './providers/types'
import { fail, MANAGES_SITE, openChangeWords, roleOf, siteOrigins, type Outcome, type Who } from './start'
import { connectBuilderSite, dropSiteWiring, getChange, getLiveSite, getOpenChange, getSite, insertChange, recentChanges, recordSiteWiring, siteCredentials, updateChange, updateSite } from './store'
import { MERGE_WEBSITE_CHANGE_TOOL, type FormCandidate, type WebsiteApprovalContext, type WebsiteChange, type WebsiteSite } from './types'

type Svc = SupabaseClient

// ── The setting ──────────────────────────────────────────────────────────────

export { enabledBuilders }

export function isBuilderSite(site: Pick<WebsiteSite, 'provider'>): boolean {
  return !!site.provider && site.provider !== 'github'
}

/** Seams for the tests. */
export interface BuilderDeps {
  fetchImpl?: typeof fetch
  createApproval?: (approval: NewApproval) => Promise<NewApprovalResult>
  env?: Record<string, string | undefined>
  now?: () => number
  /** A builder's client for a site (default: from its stored login). */
  client?: (site: WebsiteSite) => Promise<BuilderClient | null>
}

const wpDeps = (deps: BuilderDeps): WordpressDeps => (deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})

/** A stored WordPress login: `{ user, password }`, encrypted as one value. */
interface StoredLogin {
  user: string
  password: string
}

/** The builder client for a connected site, from its stored login; null when it has none or it can't be read. */
export async function builderClientFor(svc: Svc, site: WebsiteSite, deps: BuilderDeps = {}): Promise<BuilderClient | null> {
  if (deps.client) return deps.client(site)
  if ((site.provider !== 'wordpress' && site.provider !== 'shopify') || !site.providerSiteId) return null
  const stored = await siteCredentials(svc, site.workspaceId, site.id)
  if (!stored) return null
  if (site.provider === 'shopify') {
    try {
      const login = JSON.parse(decryptCredential(stored)) as { token?: unknown }
      const shop = site.providerSiteId.replace(/^https:\/\//, '')
      return typeof login.token === 'string' && isShopHost(shop) ? shopifyClient({ shop, token: login.token }, deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) : null
    } catch {
      return null
    }
  }
  try {
    const login = JSON.parse(decryptCredential(stored)) as Partial<StoredLogin>
    if (typeof login.user !== 'string' || typeof login.password !== 'string') return null
    return wordpressClient({ apiRoot: site.providerSiteId, user: login.user, password: login.password }, wpDeps(deps))
  } catch {
    return null
  }
}

// ── Connect ──────────────────────────────────────────────────────────────────

/** How long a connect link works. */
export const CONNECT_STATE_TTL_MS = 30 * 60 * 1000

interface ConnectState {
  v: 1
  provider: BuilderProvider
  userId: string
  workspaceId: string
  /** The REST root discovered at start: the callback's site must be the same. */
  apiRoot: string
  exp: number
}

/** The state's key: derived from the OAuth state secret for this one purpose, so no other signed value is a valid one. */
function stateKey(): Uint8Array {
  return new Uint8Array(createHmac('sha256', oauthStateSecret()).update('website-builder-connect-v1').digest())
}

export function signConnectState(state: ConnectState): string {
  const body = Buffer.from(JSON.stringify(state)).toString('base64url')
  const sig = createHmac('sha256', stateKey()).update(body).digest('base64url')
  return `${body}.${sig}`
}

export function verifyConnectState(param: string | null | undefined, nowMs = Date.now()): ConnectState | null {
  if (!param) return null
  const dot = param.lastIndexOf('.')
  if (dot <= 0) return null
  const body = param.slice(0, dot)
  const sig = Buffer.from(param.slice(dot + 1))
  const want = Buffer.from(createHmac('sha256', stateKey()).update(body).digest('base64url'))
  if (sig.length !== want.length || !timingSafeEqual(new Uint8Array(sig), new Uint8Array(want))) return null
  try {
    const s = JSON.parse(Buffer.from(body, 'base64url').toString()) as Partial<ConnectState>
    if (s.v !== 1 || (s.provider !== 'wordpress' && s.provider !== 'shopify') || typeof s.userId !== 'string' || typeof s.workspaceId !== 'string' || typeof s.apiRoot !== 'string' || typeof s.exp !== 'number') return null
    if (nowMs > s.exp) return null
    return s as ConnectState
  } catch {
    return null
  }
}

/** The callback WordPress hands the password to. */
export const WORDPRESS_CALLBACK_PATH = '/api/website/wordpress/callback'
/** The callback Shopify sends the merchant back to with a code: the app's redirect URL (deploy/app/.env.example). */
export const SHOPIFY_CALLBACK_PATH = '/api/website/shopify/callback'

/** The Shopify callback's full address: what the app's settings in Shopify must name. */
export function shopifyRedirectUri(): string {
  return `${appOrigin().replace(/\/$/, '')}${SHOPIFY_CALLBACK_PATH}`
}

/**
 * The owner's site is on a builder: its connect link, which they open and
 * approve on the builder itself. Owners and admins only, as a repo's connect.
 */
export async function startBuilderConnect(svc: Svc, who: Who, input: { builder: BuilderProvider; siteUrl: string | null }, deps: BuilderDeps = {}): Promise<Outcome> {
  if (!enabledBuilders(deps.env).includes(input.builder)) {
    return fail('BUILDER_OFF', `Connecting a ${PROVIDER_LABEL[input.builder]} site isn’t switched on yet. Tell them it is coming, and that for now you can give them the form’s embed snippet to paste (create_form, then its embed).`)
  }
  if (await isDemoWorkspace(who.workspaceId)) return fail('DEMO_WORKSPACE', DEMO_OFF.connector)
  if (!MANAGES_SITE.has((await roleOf(svc, who)) ?? '')) return fail('NOT_ALLOWED', 'Only an owner or admin of the workspace connects its website. Tell them.')
  if (!input.siteUrl) return fail('NO_SITE_URL', 'Ask them for their website’s address (e.g. janescleaning.com), then call connect_website again with builder and site_url.')
  const live = await getLiveSite(svc, who.workspaceId)
  const found = live ? await getOpenChange(svc, who.workspaceId, live.id) : null
  if (found) return fail('OPEN_CHANGE', `${openChangeWords(found)} The website stays as it is until it is done.`)
  if (input.builder === 'shopify') return shopifyConnectLink(who, input.siteUrl ?? '', deps)
  const discovered = await wordpressDiscover(input.siteUrl, wpDeps(deps))
  if (!discovered.ok) return fail('NOT_WORDPRESS', discovered.error)
  const now = (deps.now ?? Date.now)()
  const state = signConnectState({ v: 1, provider: 'wordpress', userId: who.userId, workspaceId: who.workspaceId, apiRoot: discovered.value.apiRoot, exp: now + CONNECT_STATE_TTL_MS })
  const callback = `${appOrigin().replace(/\/$/, '')}${WORDPRESS_CALLBACK_PATH}?state=${encodeURIComponent(state)}`
  const link = wordpressAuthorizeLink(discovered.value.authorizeUrl, { appName: 'Native Intelligence', appId: randomUUID(), successUrl: callback, rejectUrl: `${callback}&rejected=1` })
  return {
    success: true,
    builder: 'wordpress',
    connect_link: link,
    message:
      'Send them this link (by text as is). It opens their own WordPress: they sign in there as an administrator and press "Approve". Then come back to Native Intelligence on the same phone or computer they use it on; the site connects and you can change it by text. The link works for 30 minutes. Never ask them for their WordPress password.',
  }
}

/**
 * What the callback page says for each refusal (fixed words: the page is
 * shown again without the query that carried the password, from the code
 * alone).
 */
export const CONNECT_REFUSALS = {
  BAD_STATE: 'That connect link is no longer good. Ask for a new one.',
  BUILDER_OFF: 'Connecting this kind of site isn’t switched on.',
  WRONG_PERSON: 'Sign in to Native Intelligence as the person who asked for this link, on this device, and open the link again.',
  NO_PASSWORD: 'The site didn’t send a login back. Ask for a new link and approve it.',
  OTHER_SITE: 'That approval came from another site than the one asked for. Ask for a new link.',
  NOT_ALLOWED: 'Only an owner or admin of the workspace connects its website.',
  LOGIN_REFUSED: 'The site refused the new login. Ask for a new link and try again.',
  CANT_EDIT: 'That login can’t change published pages. Approve with an administrator or editor login (on Shopify: approve every permission the app asks for).',
  FAILED: 'Something went wrong connecting the site. Ask for a new link and try again.',
  REJECTED: 'Nothing was connected: the request was turned down. You can ask for a new link any time.',
} as const
export type ConnectRefusal = keyof typeof CONNECT_REFUSALS

/** A Shopify store's consent link (custom distribution: the one store, or Plus organization, the app is distributed to). */
function shopifyConnectLink(who: Who, typed: string, deps: BuilderDeps): Outcome {
  const app = shopifyApp(deps.env)
  const shop = shopHostOf(typed)
  if (!app) return fail('BUILDER_OFF', 'Connecting a Shopify store isn’t switched on yet. Tell them it is coming.')
  if (!shop) return fail('NEEDS_SHOP', 'Ask them for their store’s Shopify address, the one ending in .myshopify.com (Shopify admin › Settings › Domains), then call connect_website again with builder shopify and that as site_url.')
  const now = (deps.now ?? Date.now)()
  const state = signConnectState({ v: 1, provider: 'shopify', userId: who.userId, workspaceId: who.workspaceId, apiRoot: `https://${shop}`, exp: now + CONNECT_STATE_TTL_MS })
  return {
    success: true,
    builder: 'shopify',
    connect_link: shopifyAuthorizeLink(shop, { clientId: app.clientId, redirectUri: shopifyRedirectUri(), state }),
    message:
      'Send them this link (by text as is). It opens their own Shopify admin: they sign in as the store owner (or a staff member allowed to manage apps) and approve Native Intelligence, which can then read and change their store’s pages and product descriptions. Then come back to Native Intelligence on the same phone or computer they use it on. The link works for 30 minutes.',
  }
}

export type CompleteResult = { ok: true; site: WebsiteSite } | { ok: false; code: string; error: string }

/**
 * WordPress handed the password back (the callback route): the state must
 * be ours, unexpired, for the signed-in person, and for the same site it was
 * made for; the login must be able to change published pages. Then saved,
 * encrypted. The password is never logged or returned.
 */
export async function completeWordpressConnect(
  svc: Svc,
  input: { state: string | null; sessionUserId: string | null; siteUrl: string | null; userLogin: string | null; password: string | null },
  deps: BuilderDeps = {},
): Promise<CompleteResult> {
  const no = (code: ConnectRefusal): CompleteResult => ({ ok: false, code, error: CONNECT_REFUSALS[code] })
  const state = verifyConnectState(input.state, (deps.now ?? Date.now)())
  if (!state || state.provider !== 'wordpress') return no('BAD_STATE')
  if (!enabledBuilders(deps.env).includes('wordpress')) return no('BUILDER_OFF')
  // The person approving must be the one who asked: a link made in someone else's workspace can't take this site's login there.
  if (!input.sessionUserId || input.sessionUserId !== state.userId) return no('WRONG_PERSON')
  if (!input.userLogin || !input.password) return no('NO_PASSWORD')
  const reported = input.siteUrl ? publicHttpsUrl(input.siteUrl) : null
  if (!reported || reported.origin !== new URL(state.apiRoot).origin) return no('OTHER_SITE')
  const role = await roleOf(svc, { userId: state.userId, workspaceId: state.workspaceId })
  if (!MANAGES_SITE.has(role ?? '')) return no('NOT_ALLOWED')
  const client = wordpressClient({ apiRoot: state.apiRoot, user: input.userLogin, password: input.password }, wpDeps(deps))
  const me = await client.identity()
  if (!me.ok) return no('LOGIN_REFUSED')
  if (!me.value.canEdit) return no('CANT_EDIT')
  const site = await connectBuilderSite(svc, {
    workspaceId: state.workspaceId,
    connectedBy: state.userId,
    provider: 'wordpress',
    providerSiteId: state.apiRoot,
    siteUrl: me.value.siteUrl || reported.origin,
    credentialsEncrypted: encryptCredential(JSON.stringify({ user: input.userLogin, password: input.password } satisfies StoredLogin)),
    name: me.value.name,
    user: me.value.user,
  })
  return { ok: true, site }
}

/**
 * Shopify sent the merchant back (the callback route): its HMAC must be
 * Shopify's, the state ours, unexpired, for the signed-in person and the same
 * store; the code is traded for the store's token server-side, the token's
 * scopes must cover pages, and the store is saved with the token encrypted.
 */
export async function completeShopifyConnect(svc: Svc, input: { params: URLSearchParams; sessionUserId: string | null }, deps: BuilderDeps = {}): Promise<CompleteResult> {
  const no = (code: ConnectRefusal): CompleteResult => ({ ok: false, code, error: CONNECT_REFUSALS[code] })
  const app = shopifyApp(deps.env)
  if (!app || !enabledBuilders(deps.env).includes('shopify')) return no('BUILDER_OFF')
  if (!shopifyCallbackValid(input.params, app.clientSecret)) return no('BAD_STATE')
  const state = verifyConnectState(input.params.get('state'), (deps.now ?? Date.now)())
  if (!state || state.provider !== 'shopify') return no('BAD_STATE')
  if (!input.sessionUserId || input.sessionUserId !== state.userId) return no('WRONG_PERSON')
  const shop = input.params.get('shop') ?? ''
  if (`https://${shop}` !== state.apiRoot) return no('OTHER_SITE')
  const code = input.params.get('code')
  if (!code) return no('NO_PASSWORD')
  const role = await roleOf(svc, { userId: state.userId, workspaceId: state.workspaceId })
  if (!MANAGES_SITE.has(role ?? '')) return no('NOT_ALLOWED')
  const traded = await shopifyExchangeCode(shop, { clientId: app.clientId, clientSecret: app.clientSecret, code }, deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
  if (!traded.ok) return no('LOGIN_REFUSED')
  const me = await shopifyClient({ shop, token: traded.value.token }, deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}).identity()
  if (!me.ok) return no('LOGIN_REFUSED')
  if (!me.value.canEdit) return no('CANT_EDIT')
  const site = await connectBuilderSite(svc, {
    workspaceId: state.workspaceId,
    connectedBy: state.userId,
    provider: 'shopify',
    providerSiteId: `https://${shop}`,
    siteUrl: me.value.siteUrl,
    credentialsEncrypted: encryptCredential(JSON.stringify({ token: traded.value.token })),
    name: me.value.name,
    user: shop,
  })
  return { ok: true, site }
}

/** The scopes the Shopify app asks for, for the owner's setup words. */
export const SHOPIFY_APP_SCOPES = SHOPIFY_SCOPES

// ── Reading the site ─────────────────────────────────────────────────────────

/** The most of a page's text the agent reads back. */
export const PAGE_TEXT_MAX = 12_000

const loginGone = (provider: BuilderProvider) =>
  fail('LOGIN_GONE', `Their ${PROVIDER_LABEL[provider]} login stopped working (it was revoked, or the site changed). Connect it again (connect_website with builder and site_url).`)
const LOGIN_GONE = (site: WebsiteSite) => loginGone(site.provider && site.provider !== 'github' ? site.provider : 'wordpress')

/** A page named by the agent: its id, its address, or its title. */
async function resolvePage(client: BuilderClient, hint: string): Promise<{ ok: true; ref: ContentRef } | { ok: false; outcome: Outcome }> {
  const want = hint.trim()
  if (client.looksLikeId(want)) {
    for (const kind of client.kinds) {
      const got = await client.readContent({ kind, id: want })
      if (got.ok) return { ok: true, ref: got.value.ref }
      if (got.status === 401 || got.status === 403) return { ok: false, outcome: loginGone(client.provider) }
    }
    return { ok: false, outcome: fail('NO_SUCH_PAGE', `No page ${want} on the site. Call change_website with no page to list them.`) }
  }
  const asUrl = publicHttpsUrl(want)
  const listed = await client.listContent({ search: asUrl ? null : want, limit: 50 })
  if (!listed.ok) return { ok: false, outcome: listed.status === 401 || listed.status === 403 ? loginGone(client.provider) : fail('SITE_UNAVAILABLE', `The site didn’t answer just now (${listed.error}). Try again in a moment.`) }
  const path = (u: string) => {
    try {
      return new URL(u).pathname.replace(/\/+$/, '') || '/'
    } catch {
      return u
    }
  }
  const byUrl = asUrl ? listed.value.filter((r) => r.url && path(r.url) === path(asUrl.toString())) : []
  const byPath = !asUrl && want.startsWith('/') ? listed.value.filter((r) => r.url && path(r.url) === (want.replace(/\/+$/, '') || '/')) : []
  const byTitle = listed.value.filter((r) => r.title.trim().toLowerCase() === want.toLowerCase())
  const pick = byUrl[0] ?? byPath[0] ?? byTitle[0] ?? (listed.value.length === 1 ? listed.value[0] : null)
  if (pick) return { ok: true, ref: pick }
  return {
    ok: false,
    outcome: fail('WHICH_PAGE', 'Which page? Ask them, or pick from these and call again with its id.', { pages: listed.value.slice(0, 20).map(pageLine) }),
  }
}

const pageLine = (r: ContentRef) => ({ id: r.id, kind: r.kind, title: r.title, url: r.url })

/**
 * change_website on a builder site with no edits: the pages (to pick one),
 * or a page's text (to quote exactly what to replace). Text from the site is
 * the caller's to fence as outside text.
 */
export async function builderRead(svc: Svc, who: Who, site: WebsiteSite, input: { page?: string | null }, deps: BuilderDeps = {}): Promise<Outcome> {
  const client = await builderClientFor(svc, site, deps)
  if (!client) return LOGIN_GONE(site)
  if (!input.page) {
    const listed = await client.listContent({ limit: 30 })
    if (!listed.ok) return listed.status === 401 || listed.status === 403 ? LOGIN_GONE(site) : fail('SITE_UNAVAILABLE', `The site didn’t answer just now (${listed.error}). Try again in a moment.`)
    return {
      success: true,
      pages: listed.value.map(pageLine),
      next: 'Pick the page their change is on (ask if it isn’t clear), then call change_website with page (its id) to read its text.',
    }
  }
  const found = await resolvePage(client, input.page)
  if (!found.ok) return found.outcome
  const got = await client.readContent(found.ref)
  if (!got.ok) return got.status === 401 || got.status === 403 ? LOGIN_GONE(site) : fail('SITE_UNAVAILABLE', `The site didn’t answer just now (${got.error}). Try again in a moment.`)
  const body = got.value.body
  return {
    success: true,
    page: pageLine(got.value.ref),
    title: got.value.title,
    text: body.length > PAGE_TEXT_MAX ? `${body.slice(0, PAGE_TEXT_MAX)}\n…(cut: the page goes on)` : body,
    ...(client.provider === 'wordpress' && isBuilderShell(body) ? { note: 'This page’s words seem to live in a page builder plugin (Elementor, Divi…), not in its WordPress text: a change here may not show. Say so if what they want isn’t in the text.' } : {}),
    next: 'Call change_website again with page and edits: each find is text copied exactly from `text` (enough to occur once), each replace is the new text. Words only: no scripts, frames or code.',
  }
}

/** A page whose text is an empty shell (a page builder keeps the real text elsewhere). Pure. */
export function isBuilderShell(body: string): boolean {
  return body.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '').trim().length < 20 || /\[(et_pb_|vc_row|fusion_)/.test(body)
}

// ── Edits ────────────────────────────────────────────────────────────────────

export interface TextEdit {
  find: string
  replace: string
}

export const EDITS_MAX = 5

/** What an edit may not add: code (a script, a frame, an embed, an event handler, a javascript: link). */
const CODE_RE = /<\s*(script|iframe|object|embed|form|style|link|meta|base)\b|javascript:|\son[a-z]+\s*=|data:text\/html/gi

function count(haystack: string, needle: string): number {
  if (!needle) return 0
  let n = 0
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++
  return n
}

/** The page's text with the edits applied, each found exactly once, or why not. Pure. */
export function applyTextEdits(body: string, edits: readonly TextEdit[]): { ok: true; body: string } | { ok: false; error: string } {
  if (!edits.length) return { ok: false, error: 'No edits given.' }
  if (edits.length > EDITS_MAX) return { ok: false, error: `At most ${EDITS_MAX} edits at once: one change at a time.` }
  let out = body
  for (const [i, e] of edits.entries()) {
    if (!e.find) return { ok: false, error: `Edit ${i + 1} has nothing to find.` }
    if (e.find === e.replace) return { ok: false, error: `Edit ${i + 1} changes nothing.` }
    const n = count(out, e.find)
    if (n === 0) return { ok: false, error: `Edit ${i + 1}'s text isn't on the page as written: copy it exactly from the page's text (read it with change_website and page).` }
    if (n > 1) return { ok: false, error: `Edit ${i + 1}'s text is on the page ${n} times: quote more of it around the part to change, so it is there once.` }
    out = out.replace(e.find, () => e.replace)
  }
  return { ok: true, body: out }
}

/** Whether `after` carries more code than `before` (see CODE_RE). Pure. */
export function addsCode(before: string, after: string): boolean {
  return (after.match(CODE_RE)?.length ?? 0) > (before.match(CODE_RE)?.length ?? 0)
}

/** The outside hosts `after` links to that `before` didn't, but the site's own. Pure. */
export function addedHosts(before: string, after: string, siteUrl: string | null): string[] {
  const hosts = (text: string) => new Set([...text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1].toLowerCase().replace(/^www\./, '')))
  const had = hosts(before)
  let own = ''
  try {
    own = siteUrl ? new URL(siteUrl).hostname.replace(/^www\./, '') : ''
  } catch {
    own = ''
  }
  return [...hosts(after)].filter((h) => !had.has(h) && h !== own).slice(0, 5)
}

/** The version a card shows: the SHA-256 of a page's title and text. Pure. */
export function contentHash(title: string, body: string): string {
  return createHash('sha256').update(JSON.stringify([title, body])).digest('hex')
}

/** Text as the card quotes it: tags out, one line, clipped. Pure. */
export function plainWords(text: string, max = 140): string {
  return clip(text.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim() || '(no words)', max)
}

/** The plain summary of a staged write: what the owner reads on the card and by text. Pure. */
export function stagedSummary(staged: Pick<StagedWrite, 'ref' | 'edits'>, kind: WebsiteChange['kind']): string {
  const where = `“${clip(staged.ref.title || 'the page', 60)}”`
  if (kind === 'wire_form') return `Adds your form to the ${where} page.`
  if (kind === 'revert') return `Puts the ${where} page back the way it was before the last change.`
  const [first, ...rest] = staged.edits
  if (!first) return `Changes the ${where} page.`
  const more = rest.length ? ` (and ${rest.length} more change${rest.length > 1 ? 's' : ''})` : ''
  return `On ${where}: “${plainWords(first.find, 90)}” becomes “${plainWords(first.replace, 90)}”${more}.`
}

/** The site, its owner check and its open change; the builder site's own, else a refusal. */
async function builderSiteFor(svc: Svc, who: Who): Promise<{ ok: true; site: WebsiteSite } | { ok: false; outcome: Outcome }> {
  const { siteFor } = await import('./start')
  const found = await siteFor(svc, who)
  if (!found.ok) return found
  if (!isBuilderSite(found.site)) return { ok: false, outcome: fail('NOT_A_BUILDER_SITE', 'Their website is a GitHub repo: change it with change_website and their words alone.') }
  return found
}

/** Stage a write and raise its card; the change row is the one record. */
async function stageAndAsk(
  svc: Svc,
  who: Who,
  site: WebsiteSite,
  args: {
    kind: WebsiteChange['kind']
    request: string
    snapshot: ContentSnapshot
    after: { title: string; body: string }
    edits: TextEdit[]
    revertsChangeId?: string | null
    wiring?: { formPath: string; formKind: FormCandidate['kind']; keyHash: string; keyPrefix: string; origins: string[]; formId: string; formName: string; accepts: string[] }
  },
  deps: BuilderDeps,
): Promise<Outcome> {
  const before = { title: args.snapshot.title, body: args.snapshot.body }
  const staged: StagedWrite = {
    provider: site.provider as BuilderProvider,
    ref: args.snapshot.ref,
    before,
    after: args.after,
    beforeHash: contentHash(before.title, before.body),
    afterHash: contentHash(args.after.title, args.after.body),
    edits: args.edits.slice(0, EDITS_MAX).map((e) => ({ find: e.find.slice(0, 4000), replace: e.replace.slice(0, 4000) })),
  }
  const summary = stagedSummary(staged, args.kind)
  const inserted = await insertChange(svc, {
    workspaceId: who.workspaceId,
    siteId: site.id,
    kind: args.kind,
    request: args.request,
    requestedBy: who.userId,
    revertsChangeId: args.revertsChangeId ?? null,
    staged,
    headSha: staged.afterHash,
    summary,
    ...(args.wiring
      ? {
          formPath: args.wiring.formPath,
          formKind: args.wiring.formKind,
          intakeKeyHash: args.wiring.keyHash,
          intakeKeyPrefix: args.wiring.keyPrefix,
          intakeOrigins: args.wiring.origins,
          wiringIntake: { kind: 'form' as const, formId: args.wiring.formId },
        }
      : {}),
  })
  if (!inserted.ok) return fail('OPEN_CHANGE', inserted.open ? openChangeWords(inserted.open) : 'Another website change is open. Nothing new was started.')
  const card = await raiseBuilderCard(svc, inserted.change, site, staged, { summary, wiring: args.wiring ? { formName: args.wiring.formName, accepts: args.wiring.accepts } : null }, deps)
  if (!card.ok) return fail('CARD_FAILED', 'The change couldn’t be put to them just now. Nothing on their site changed; try again in a moment.')
  return {
    success: true,
    change_id: inserted.change.id,
    summary,
    message:
      'Ready for their yes: they get the exact change (what is replaced and with what) with a code by text, or the card in the app. Nothing on the site changes until they say yes. Tell them that in one line; never say it is done.',
  }
}

/** An edit the owner asked for, on a builder site: exact text and its replacement. */
export async function startBuilderEdit(svc: Svc, who: Who, input: { request: string; page: string | null; edits: TextEdit[]; title?: string | null }, deps: BuilderDeps = {}): Promise<Outcome> {
  const found = await builderSiteFor(svc, who)
  if (!found.ok) return found.outcome
  const { site } = found
  if (!input.page || (!input.edits.length && !input.title)) return builderRead(svc, who, site, { page: input.page }, deps)
  const client = await builderClientFor(svc, site, deps)
  if (!client) return LOGIN_GONE(site)
  const page = await resolvePage(client, input.page)
  if (!page.ok) return page.outcome
  const snap = await client.readContent(page.ref)
  if (!snap.ok) return snap.status === 401 || snap.status === 403 ? LOGIN_GONE(site) : fail('SITE_UNAVAILABLE', `The site didn’t answer just now (${snap.error}). Try again in a moment.`)
  const edited = input.edits.length ? applyTextEdits(snap.value.body, input.edits) : { ok: true as const, body: snap.value.body }
  if (!edited.ok) return fail('EDIT_DOESNT_FIT', edited.error)
  const title = input.title?.trim() ? input.title.trim().slice(0, 200) : snap.value.title
  if (addsCode(snap.value.body, edited.body) || addsCode(snap.value.title, title)) {
    return fail('NO_CODE', 'A change by text changes words, links and pictures already there, never code (a script, a frame, a form or an event handler). Nothing was started. For a form, use wire_website_form.')
  }
  const edits = [...input.edits, ...(title !== snap.value.title ? [{ find: snap.value.title, replace: title }] : [])]
  return stageAndAsk(svc, who, site, { kind: 'edit', request: input.request, snapshot: snap.value, after: { title, body: edited.body }, edits }, deps)
}

/** The kind of a page's form, from its title. Pure. */
function pageFormKind(title: string): FormCandidate['kind'] {
  if (/quote|estimate|pricing/i.test(title)) return 'quote'
  if (/book|appointment|schedule/i.test(title)) return 'booking'
  if (/contact/i.test(title)) return 'contact'
  return 'other'
}

const EMBED_ATTR = /data-ni-form="[^"]*"/

/** The form key a page's embed carries, or null. Pure. */
export function embedKeyOf(body: string): string | null {
  return /data-ni-form="(fk_[A-Za-z0-9_-]{43})"/.exec(body)?.[1] ?? null
}

/** One of the business's public forms, drawn on a page of a builder site. */
export async function startBuilderWiring(svc: Svc, who: Who, input: { page: string | null; formId: string | null; editGrants?: boolean }, deps: BuilderDeps = {}): Promise<Outcome> {
  const found = await builderSiteFor(svc, who)
  if (!found.ok) return found.outcome
  const { site } = found
  if (!input.formId) {
    return fail(
      'NEEDS_FORM',
      'On a site builder the form is drawn by Native Intelligence: it is one of their forms. Make one first if they have none (create_table, then create_form with who_can_submit public and the fields a customer fills in), then call wire_website_form again with form_id and page.',
    )
  }
  const target = await formWiringTarget(svc, who, input.formId, { editGrants: input.editGrants !== false, embed: true })
  if (!target.ok) return fail(target.code, target.error)
  const client = await builderClientFor(svc, site, deps)
  if (!client) return LOGIN_GONE(site)
  const me = await client.identity()
  if (!me.ok) return LOGIN_GONE(site)
  if (!me.value.canEmbed) {
    return fail(
      'CANT_EMBED',
      client.provider === 'wordpress'
        ? 'Their WordPress login can’t put a form on a page (WordPress keeps scripts only for an administrator on a single site). Connect again with an administrator login, or give them the form’s embed snippet to paste into a Custom HTML block.'
        : `Their ${PROVIDER_LABEL[client.provider]} login can’t change pages, so the form can’t go on one. Connect it again, approving every permission.`,
    )
  }
  if (!input.page) {
    const listed = await client.listContent({ limit: 30 })
    const likely = listed.ok ? listed.value.filter((r) => r.kind === 'page' && pageFormKind(r.title) !== 'other') : []
    return fail('WHICH_PAGE', 'Which page should the form go on? Ask them (a quote or contact page is usual), then call again with page.', { pages: (likely.length ? likely : listed.ok ? listed.value : []).slice(0, 20).map(pageLine) })
  }
  const page = await resolvePage(client, input.page)
  if (!page.ok) return page.outcome
  const snap = await client.readContent(page.ref)
  if (!snap.ok) return snap.status === 401 || snap.status === 403 ? LOGIN_GONE(site) : fail('SITE_UNAVAILABLE', `The site didn’t answer just now (${snap.error}). Try again in a moment.`)
  const key = generateFormKey()
  const snippet = embedSnippet(appOrigin(), key)
  const formPath = `${page.ref.kind}:${page.ref.id}`
  // This form on this page already (an earlier wiring): its key is replaced in place, not a second form.
  const rewire = (site.inspection?.wirings ?? []).some((w) => w.intake === 'form' && w.formId === target.target.form.id && w.formPath === formPath) && EMBED_ATTR.test(snap.value.body)
  const body = rewire ? snap.value.body.replace(EMBED_ATTR, `data-ni-form="${key}"`) : `${snap.value.body}${client.embedBlock(snippet)}`
  const origins = siteOrigins(site.siteUrl)
  return stageAndAsk(
    svc,
    who,
    site,
    {
      kind: 'wire_form',
      request: `Add the form “${clip(target.target.form.name, 80)}” to the page “${clip(page.ref.title, 80)}”.`,
      snapshot: snap.value,
      after: { title: snap.value.title, body },
      edits: [],
      wiring: {
        formPath,
        formKind: pageFormKind(page.ref.title),
        keyHash: hashFormKey(key),
        keyPrefix: key.slice(0, 9),
        origins,
        formId: target.target.form.id,
        formName: target.target.form.name,
        accepts: wiredFormOrigins(origins, target.target.form.allowedOrigins),
      },
    },
    deps,
  )
}

/** Undo the last change that went live on a builder site: the text it replaced, written back. */
export async function startBuilderUndo(svc: Svc, who: Who, input: { changeId?: string | null }, deps: BuilderDeps = {}): Promise<Outcome> {
  const found = await builderSiteFor(svc, who)
  if (!found.ok) return found.outcome
  const { site } = found
  const recent = await recentChanges(svc, who.workspaceId, site.id, 10)
  const undone = input.changeId ? recent.find((c) => c.id === input.changeId) : recent.find((c) => !!c.mergedAt && !!c.staged?.written)
  if (!undone?.staged?.written || !undone.mergedAt) return fail('NOTHING_TO_UNDO', 'There is no website change of yours that went live to undo. Tell them.')
  const client = await builderClientFor(svc, site, deps)
  if (!client) return LOGIN_GONE(site)
  const snap = await client.readContent(undone.staged.ref)
  if (!snap.ok) return snap.status === 401 || snap.status === 403 ? LOGIN_GONE(site) : fail('SITE_UNAVAILABLE', `The site didn’t answer just now (${snap.error}). Try again in a moment.`)
  if (contentHash(snap.value.title, snap.value.body) !== undone.staged.afterHash) {
    return fail('CHANGED_SINCE', `The page “${clip(undone.staged.ref.title, 60)}” was changed again since (on the site itself, or by a later change), so putting the old text back would undo that too. Nothing was started.${client.keepsRevisions ? ` In ${PROVIDER_LABEL[client.provider]}, its Revisions can step it back;` : ''} Or ask for the exact change again.`)
  }
  return stageAndAsk(
    svc,
    who,
    site,
    {
      kind: 'revert',
      request: `Undo: ${undone.summary ?? undone.request}`.slice(0, 2000),
      snapshot: snap.value,
      after: undone.staged.before,
      edits: undone.staged.edits.map((e) => ({ find: e.replace, replace: e.find })),
      revertsChangeId: undone.id,
    },
    deps,
  )
}

// ── The card ─────────────────────────────────────────────────────────────────

/**
 * The card for a staged builder write: the same tool and context as a pull
 * request's (merge_website_change; its head is the after's hash), so the
 * accept-time re-check (approval.ts websiteApprovalPermits) holds as is.
 */
export async function raiseBuilderCard(
  svc: Svc,
  change: WebsiteChange,
  site: WebsiteSite,
  staged: StagedWrite,
  args: { summary: string; wiring: { formName: string; accepts: string[] } | null },
  deps: BuilderDeps = {},
): Promise<{ ok: boolean; approvalId?: string; error?: string }> {
  const label = change.kind === 'wire_form' ? `Add your form to ${clip(staged.ref.title || 'a page', 60)}` : change.kind === 'revert' ? 'Undo your last website change' : clip(change.request.split('\n')[0] ?? 'A website change', 80)
  const asked = change.kind === 'edit' ? clip(change.request, 300) : null
  const outside = change.kind === 'wire_form' ? [] : addedHosts(staged.before.body, staged.after.body, site.siteUrl)
  const builder = PROVIDER_LABEL[staged.provider]
  const context: WebsiteApprovalContext = {
    changeId: change.id,
    headSha: staged.afterHash,
    summary: args.summary,
    previewUrl: null,
    ...(asked ? { asked } : {}),
    ...(outside.length ? { outside } : {}),
  }
  const held = await (deps.createApproval ?? ((a: NewApproval) => createToolApproval(svc, a)))({
    door: 'chat',
    userId: site.connectedBy,
    workspaceId: change.workspaceId,
    toolName: MERGE_WEBSITE_CHANGE_TOOL,
    sideEffect: 'external-write',
    input: {
      change: label,
      ...(asked ? { you_asked: asked } : {}),
      what_changes: args.summary,
      page: `${clip(staged.ref.title, 80)}${staged.ref.url ? ` (${staged.ref.url})` : ''}`,
      ...(staged.edits.length
        ? { replaces: staged.edits.map((e, i) => `${i + 1}. “${plainWords(e.find, 200)}” → “${plainWords(e.replace, 200)}”`).join('\n') }
        : {}),
      ...(outside.length ? { adds_outside_addresses: outside.join(', ') } : {}),
      ...(args.wiring ? { adds_entries_to: `Your form “${clip(args.wiring.formName, 80)}”: its old link stops working when this goes live.`, accepts_requests_from: args.wiring.accepts.join(', ') || 'any website' } : {}),
      yes_does: `Writes this exact change to the ${staged.ref.kind === 'product' ? 'product' : 'page'} on your ${builder} site, where it is live at once; ${staged.provider === 'wordpress' ? `${builder} keeps the earlier version` : 'I keep the earlier text, so it can be undone'}.`,
    },
    context: { website: context },
    reason: 'website_change',
    card: mergeCardCopy({ label, summary: args.summary, hasPreview: false, outside }),
  })
  if (!held.ok) {
    await updateChange(svc, change.workspaceId, change.id, { state: 'failed', error: held.error }, ['preparing']).catch(() => null)
    return { ok: false, error: held.error }
  }
  const moved = await updateChange(svc, change.workspaceId, change.id, { state: 'awaiting_yes', approval_id: held.approvalId }, ['preparing'])
  return moved ? { ok: true, approvalId: held.approvalId } : { ok: false, error: 'moved meanwhile' }
}

// ── Yes: the write ───────────────────────────────────────────────────────────

/** What a finished write records, and a wiring's link and a revert's dropped wiring. Safe to repeat. */
async function finishBuilderWrite(svc: Svc, change: WebsiteChange, site: WebsiteSite, written: NonNullable<StagedWrite['written']>): Promise<void> {
  const staged = change.staged as StagedWrite
  await updateChange(
    svc,
    change.workspaceId,
    change.id,
    { state: 'live', merge_sha: written.revision ?? staged.afterHash, merged_at: change.mergedAt ?? written.at, live_at: written.at, error: null, staged: { ...staged, written } },
    ['merging', 'failed'],
  )
  if (change.kind === 'wire_form' && change.intakeKeyHash) {
    // The form's link becomes the page's; its bot check stays on (the embed runs it).
    await activateFormLink(svc, change, { embed: true })
    await recordSiteWiring(svc, change)
    await updateSite(svc, change.workspaceId, site.id, { state: 'wired', wired_at: written.at })
  }
  if (change.kind === 'revert' && change.revertsChangeId) {
    const undone = await getChange(svc, change.workspaceId, change.revertsChangeId).catch(() => null)
    if (undone?.kind === 'wire_form') await dropSiteWiring(svc, change.workspaceId, site.id, undone)
  }
}

/**
 * The owner said yes to a builder card (approval.ts mergeWebsiteChange, after
 * its own checks and the kill switch): the page must still be what the card
 * was made from; then the write. What the agent reads back is plain words.
 */
export async function applyBuilderYes(svc: Svc, change: WebsiteChange, site: WebsiteSite, headSha: string, deps: BuilderDeps = {}): Promise<Record<string, unknown>> {
  const staged = change.staged
  if (!staged || staged.afterHash !== headSha) return { success: false, error: 'That website change is no longer waiting for a yes. Nothing was written.' }
  const merging = await updateChange(svc, change.workspaceId, change.id, { state: 'merging' }, ['awaiting_yes'])
  if (!merging) return { success: false, error: 'That website change was already answered. Nothing more was done.' }
  const failWith = async (error: string, words: string, code = 'FAILED') => {
    await updateChange(svc, change.workspaceId, change.id, { state: 'failed', error }, ['merging']).catch(() => null)
    return { success: false, code, error: words }
  }
  const client = await builderClientFor(svc, site, deps)
  if (!client) return failWith('no builder login', `Their ${PROVIDER_LABEL[staged.provider]} login stopped working, so nothing was written. Connect it again, then ask for the change again.`)
  const now = await client.readContent(staged.ref)
  if (!now.ok) return failWith(`read: ${now.error}`, 'The site didn’t answer just now, so nothing was written. Ask for the change again in a moment.')
  if (contentHash(now.value.title, now.value.body) !== staged.beforeHash) {
    return failWith('the page changed since the card', `The page “${clip(staged.ref.title, 60)}” was changed on the site after this was put to them, so nothing was written (it would have undone that). Ask for the change again: it is made from the page as it is now.`, 'PAGE_MOVED')
  }
  const wrote = await client.writeContent(staged.ref, { title: staged.after.title, body: staged.after.body })
  if (!wrote.ok) return failWith(`write: ${wrote.error}`, `The site refused the change (${wrote.error}), so nothing was written. Tell them.`)
  // A form drawn on a page: the page must still carry its embed as written (a builder may strip a script). If not, the page is put back.
  if (change.kind === 'wire_form' && change.intakeKeyPrefix) {
    const back = await client.readContent(staged.ref)
    const kept = back.ok && embedKeyOf(back.value.body) !== null && embedKeyOf(back.value.body) === embedKeyOf(staged.after.body) && back.value.body.includes('/f/embed.js')
    if (!kept) {
      await client.writeContent(staged.ref, { title: staged.before.title, body: staged.before.body }).catch(() => null)
      return failWith('the site removed the form’s script', `${PROVIDER_LABEL[staged.provider]} removed the form’s script from the page, so the page was put back as it was and the form’s link didn’t change. Give them the form’s own link instead (or its embed snippet to add in their theme).`, 'EMBED_STRIPPED')
    }
  }
  const at = new Date((deps.now ?? Date.now)()).toISOString()
  const done = await getChange(svc, change.workspaceId, change.id)
  try {
    await finishBuilderWrite(svc, done ?? merging, site, { modified: wrote.value.modified, revision: wrote.value.revision, at })
  } catch (err) {
    // Written on the site: the record follows on the next reconcile (it reads the page back).
    console.error(`[website] ws=${change.workspaceId} ALERT builder write ${change.id} not recorded:`, err instanceof Error ? err.message : String(err))
  }
  return {
    success: true,
    written: true,
    message:
      change.kind === 'wire_form'
        ? 'It’s on the page now: their form shows there, and every entry lands in its table. Its older link has stopped working. Tell them in a line.'
        : change.kind === 'revert'
          ? 'Done: the page is back the way it was. Tell them in a line.'
          : `Done: it’s live on their site now${client.keepsRevisions ? ` (${PROVIDER_LABEL[staged.provider]} keeps the earlier version too)` : ' (undo_website_change puts it back)'}. Tell them in a line.`,
  }
}

/**
 * A builder write stuck in merging (./reconcile.ts): the page read back says
 * whether it landed (finished) or not (failed). Returns the change as it
 * stands, or null once settled. Never throws.
 */
export async function reconcileBuilderWrite(svc: Svc, change: WebsiteChange, deps: BuilderDeps = {}): Promise<WebsiteChange | null> {
  try {
    const site = await getSite(svc, change.workspaceId, change.siteId)
    const staged = change.staged
    const client = site && staged ? await builderClientFor(svc, site, deps) : null
    const now = client && staged ? await client.readContent(staged.ref) : null
    if (site && staged && now?.ok && contentHash(now.value.title, now.value.body) === staged.afterHash) {
      const at = new Date((deps.now ?? Date.now)()).toISOString()
      await finishBuilderWrite(svc, change, site, { modified: now.value.modified, revision: null, at })
      return null
    }
    await updateChange(svc, change.workspaceId, change.id, { state: 'failed', error: 'the write was interrupted' }, ['merging'])
    return null
  } catch (err) {
    console.warn('[website] builder reconcile skipped:', err instanceof Error ? err.message : String(err))
    return change
  }
}
