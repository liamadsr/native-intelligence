/**
 * A self-hosted WordPress site, through its own REST API (WordPress 5.6+),
 * with an application password the owner made by clicking "Approve" on their
 * own site (docs/plans/hosted-site-builders.md, WordPress):
 *
 *   connect   {@link wordpressDiscover}: the site's REST root and its
 *             "Authorize Application" page (the REST index's
 *             authentication.application-passwords). No developer app, no
 *             marketplace: the owner's own site hands out the password, to
 *             our callback (src/app/api/website/wordpress/callback).
 *   identity  users/me (context=edit): the login's name and capabilities
 *             (edit_pages, edit_posts, unfiltered_html: a form embed carries
 *             a script, which WordPress keeps only for a login allowed it).
 *   content   pages and posts, their raw block markup (context=edit), and a
 *             write of title and content. WordPress keeps a revision of every
 *             update itself; our undo writes the text before back (also a
 *             revision), so either way the owner can step back in WordPress.
 *
 * The site's address is the owner's, so nothing here trusts it: https and a
 * public host name only (./fetch.ts publicHttpsUrl) that resolves only to
 * public addresses (never a private, loopback or link-local one), no redirects followed
 * with the password on (a redirect is an error), a time limit and a size cap.
 * The password never appears in a URL we make, a log line or an error.
 *
 * Server only.
 */
import { publicHttpsUrl } from '../fetch'
import type { BuilderClient, BuilderIdentity, BuilderResult, ContentRef, ContentSnapshot } from './types'

export interface WordpressLogin {
  /** The REST root, e.g. https://janescleaning.com/wp-json/ (or …/?rest_route=/ without pretty links). */
  apiRoot: string
  user: string
  /** The application password (spaces and all, as WordPress shows it). */
  password: string
}

/**
 * A WordPress.com site (plan, phase 3): the same wp/v2 routes through
 * WordPress.com's own API (public-api.wordpress.com/wp/v2/sites/<id>/…), with
 * the OAuth token its owner approved for that one site.
 */
export interface WpcomLogin {
  /** The site's numeric id (the token answer's blog_id). */
  wpcomSite: string
  token: string
}

export const WPCOM_API = 'https://public-api.wordpress.com'

/** WordPress.com's consent page for one site (the default: one blog, the owner picks it). Pure. */
export function wpcomAuthorizeLink(args: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL(`${WPCOM_API}/oauth2/authorize`)
  url.searchParams.set('client_id', args.clientId)
  url.searchParams.set('redirect_uri', args.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('state', args.state)
  return url.toString()
}

/** Trade the consent page's code for the site's token, server-side: the token, the site's id and its address. */
export async function wpcomExchangeCode(
  args: { clientId: string; clientSecret: string; code: string; redirectUri: string },
  deps: WordpressDeps = {},
): Promise<BuilderResult<{ token: string; blogId: string; blogUrl: string }>> {
  let res: Response
  try {
    res = await (deps.fetchImpl ?? fetch)(`${WPCOM_API}/oauth2/token`, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: args.clientId, client_secret: args.clientSecret, redirect_uri: args.redirectUri, code: args.code, grant_type: 'authorization_code' }).toString(),
    })
  } catch {
    return no(0, 'WordPress.com did not answer')
  }
  if (!res.ok) return no(res.status, `WordPress.com answered ${res.status}`)
  try {
    const body = (await readJson(res)) as { access_token?: unknown; blog_id?: unknown; blog_url?: unknown }
    const blogId = typeof body?.blog_id === 'number' || typeof body?.blog_id === 'string' ? String(body.blog_id) : ''
    if (typeof body?.access_token !== 'string' || !/^\d{1,15}$/.test(blogId)) return no(400, 'WordPress.com sent no site token')
    return { ok: true, value: { token: body.access_token, blogId, blogUrl: str(body.blog_url) } }
  } catch {
    return no(res.status, 'WordPress.com did not answer as it does')
  }
}

export interface WordpressDeps {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /**
   * The addresses a host name resolves to. Default: the system resolver, when
   * the real fetch is used (a test's own fetch owns its network, so nothing is
   * resolved unless the test passes this).
   */
  resolveHost?: (host: string) => Promise<string[]>
}

/** Whether an IP address is private, loopback, link-local or otherwise not the public internet's. Pure. */
export function isNonPublicAddress(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
  }
  const v6 = ip.toLowerCase()
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6)
}

async function systemResolve(host: string): Promise<string[]> {
  const { lookup } = await import('node:dns/promises')
  return (await lookup(host, { all: true })).map((a) => a.address)
}

/** Whether the host resolves only to public addresses (the Basic-auth request goes nowhere else). */
async function resolvesPublic(deps: WordpressDeps, host: string): Promise<boolean> {
  const resolve = deps.resolveHost ?? (deps.fetchImpl ? null : systemResolve)
  if (!resolve) return true
  try {
    const addresses = await resolve(host)
    return addresses.length > 0 && !addresses.some(isNonPublicAddress)
  } catch {
    return false
  }
}

const MAX_BYTES = 3_000_000
const LIST_MAX = 50

const no = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error })

/** A REST path under a root, with its query, for both root shapes. Pure. */
export function wordpressUrl(apiRoot: string, path: string, query: Record<string, string> = {}): string {
  const qs = new URLSearchParams(query).toString()
  const clean = path.replace(/^\/+/, '')
  if (apiRoot.includes('rest_route=')) return `${apiRoot.replace(/\/?$/, '/')}${clean}${qs ? `&${qs}` : ''}`
  return `${apiRoot.replace(/\/?$/, '/')}${clean}${qs ? `?${qs}` : ''}`
}

async function readJson(res: Response): Promise<unknown> {
  const length = Number(res.headers.get('content-length') ?? '0')
  if (Number.isFinite(length) && length > MAX_BYTES) throw new Error('too large')
  const text = await res.text()
  if (text.length > MAX_BYTES) throw new Error('too large')
  return text ? JSON.parse(text) : null
}

/** One REST call; a redirect, a non-public address or a non-JSON answer is a failed result. */
async function call(deps: WordpressDeps, url: string, init: { method?: string; auth?: string; body?: unknown } = {}): Promise<BuilderResult<unknown>> {
  const safe = publicHttpsUrl(url)
  if (!safe) return no(0, 'not a public https address')
  // The name checks out; so must where it points (a private, loopback or link-local address never gets the login).
  if (!(await resolvesPublic(deps, safe.hostname))) return no(0, 'the site’s address is not on the public internet')
  let res: Response
  try {
    res = await (deps.fetchImpl ?? fetch)(safe.toString(), {
      method: init.method ?? 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
      headers: {
        Accept: 'application/json',
        ...(init.auth ? { Authorization: init.auth } : {}),
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    })
  } catch {
    return no(0, 'the site did not answer')
  }
  if (res.status >= 300 && res.status < 400) return no(res.status, 'the site sent us somewhere else')
  let body: unknown
  try {
    body = await readJson(res)
  } catch {
    return no(res.status, 'the site did not answer as WordPress does')
  }
  if (!res.ok) {
    const code = body && typeof body === 'object' ? String((body as { code?: unknown }).code ?? '') : ''
    if (res.status === 401 || res.status === 403) return no(res.status, code === 'rest_cannot_edit' ? 'that WordPress login can’t change this' : 'the WordPress login was refused')
    if (res.status === 404) return no(404, 'not found on the site')
    return no(res.status, `WordPress answered ${res.status}`)
  }
  return { ok: true, value: body }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
/** A WordPress field that is `{ raw, rendered }` in context=edit, or a string. */
const raw = (v: unknown): string => (v && typeof v === 'object' ? str((v as { raw?: unknown }).raw ?? (v as { rendered?: unknown }).rendered) : str(v))

export interface WordpressDiscovery {
  apiRoot: string
  name: string
  siteUrl: string
  /** The site's "Authorize Application" page. */
  authorizeUrl: string
}

/**
 * Find a site's REST root and its application-password page from its
 * address. Fails in words the owner can act on: not WordPress, too old
 * (before 5.6), or application passwords switched off (a security plugin, or
 * a site without https).
 */
export async function wordpressDiscover(siteUrl: string, deps: WordpressDeps = {}): Promise<BuilderResult<WordpressDiscovery>> {
  const base = publicHttpsUrl(siteUrl)
  if (!base) return no(0, 'That isn’t a public https website address.')
  const origin = base.origin
  for (const root of [`${origin}/wp-json/`, `${origin}/?rest_route=/`]) {
    const got = await call(deps, root)
    if (!got.ok || !got.value || typeof got.value !== 'object') continue
    const index = got.value as { name?: unknown; url?: unknown; home?: unknown; namespaces?: unknown; authentication?: unknown }
    const namespaces = Array.isArray(index.namespaces) ? index.namespaces : []
    if (!namespaces.includes('wp/v2')) continue
    const auth = index.authentication && typeof index.authentication === 'object' ? (index.authentication as Record<string, unknown>)['application-passwords'] : null
    const authorize = auth && typeof auth === 'object' ? str((auth as { endpoints?: { authorization?: unknown } }).endpoints?.authorization) : ''
    const authorizeUrl = publicHttpsUrl(authorize)
    if (!authorizeUrl || authorizeUrl.origin !== new URL(root).origin) {
      return no(0, 'That WordPress site doesn’t offer application passwords (WordPress 5.6 or newer, on https, with no plugin switching them off). They can be switched back on in WordPress, or the site’s web person can do it.')
    }
    const home = publicHttpsUrl(str(index.home) || str(index.url) || origin)
    return { ok: true, value: { apiRoot: root, name: str(index.name).slice(0, 200) || base.hostname, siteUrl: (home ?? base).origin, authorizeUrl: authorizeUrl.toString() } }
  }
  return no(0, 'That address doesn’t look like a WordPress site (its REST API didn’t answer). If it is on WordPress.com, Wix, Webflow, Squarespace or Shopify, say which.')
}

/** The "Authorize Application" link the owner opens: WordPress hands the password to success_url. Pure. */
export function wordpressAuthorizeLink(authorizeUrl: string, args: { appName: string; appId: string; successUrl: string; rejectUrl: string }): string {
  const url = new URL(authorizeUrl)
  url.searchParams.set('app_name', args.appName)
  url.searchParams.set('app_id', args.appId)
  url.searchParams.set('success_url', args.successUrl)
  url.searchParams.set('reject_url', args.rejectUrl)
  return url.toString()
}

function refOf(kind: ContentRef['kind'], v: unknown): ContentRef | null {
  if (!v || typeof v !== 'object') return null
  const r = v as { id?: unknown; title?: unknown; link?: unknown; status?: unknown }
  if (typeof r.id !== 'number' && typeof r.id !== 'string') return null
  const link = publicHttpsUrl(str(r.link))
  return { kind, id: String(r.id), title: raw(r.title).slice(0, 200), url: link ? link.toString() : null, status: str(r.status) || 'publish' }
}

const collection = (kind: ContentRef['kind']) => (kind === 'page' ? 'pages' : 'posts')
const isWpKind = (kind: ContentRef['kind']) => kind === 'page' || kind === 'post'
const ID_RE = /^\d{1,12}$/

/** A WordPress site as a {@link BuilderClient}. */
export function wordpressClient(login: WordpressLogin | WpcomLogin, deps: WordpressDeps = {}): BuilderClient {
  const wpcom = 'wpcomSite' in login
  const auth = wpcom ? `Bearer ${login.token}` : `Basic ${Buffer.from(`${login.user}:${login.password}`).toString('base64')}`
  // WordPress.com serves the same wp/v2 routes under its own API, per site.
  const api = (path: string, query?: Record<string, string>) =>
    wpcom ? wordpressUrl(`${WPCOM_API}/wp/v2/sites/${login.wpcomSite}/`, path.replace(/^wp\/v2\//, ''), query) : wordpressUrl(login.apiRoot, path, query)
  const wpcomIdentity = async (): Promise<BuilderResult<BuilderIdentity>> => {
    const got = await call(deps, `${WPCOM_API}/rest/v1.1/sites/${(login as WpcomLogin).wpcomSite}`, { auth })
    if (!got.ok) return got
    const site = got.value as { name?: unknown; URL?: unknown; capabilities?: Record<string, unknown> }
    const caps = site.capabilities && typeof site.capabilities === 'object' ? site.capabilities : {}
    const home = publicHttpsUrl(str(site.URL))
    return {
      ok: true,
      value: {
        name: str(site.name).slice(0, 200),
        siteUrl: home ? home.origin : '',
        user: 'WordPress.com',
        canEdit: caps.edit_pages === true && caps.edit_others_pages === true,
        // Plans without plugins strip a page's script: reported here when the site says so; the write is read back either way.
        canEmbed: caps.unfiltered_html === true,
      },
    }
  }
  return {
    provider: wpcom ? 'wpcom' : 'wordpress',
    kinds: ['page', 'post'],
    keepsRevisions: true,
    looksLikeId: (hint: string) => ID_RE.test(hint.trim()),

    async identity(): Promise<BuilderResult<BuilderIdentity>> {
      if (wpcom) return wpcomIdentity()
      const login_ = login as WordpressLogin
      const me = await call(deps, api('wp/v2/users/me', { context: 'edit' }), { auth })
      if (!me.ok) return me
      const user = me.value as { name?: unknown; slug?: unknown; capabilities?: Record<string, unknown> }
      const caps = user.capabilities && typeof user.capabilities === 'object' ? user.capabilities : {}
      const index = await call(deps, login_.apiRoot)
      const info = index.ok && index.value && typeof index.value === 'object' ? (index.value as { name?: unknown; home?: unknown; url?: unknown }) : {}
      const home = publicHttpsUrl(str(info.home) || str(info.url)) ?? publicHttpsUrl(login_.apiRoot)
      return {
        ok: true,
        value: {
          name: str(info.name).slice(0, 200),
          siteUrl: home ? home.origin : '',
          user: (str(user.name) || str(user.slug)).slice(0, 100),
          canEdit: caps.edit_pages === true && caps.edit_published_pages === true && caps.edit_others_pages === true,
          canEmbed: caps.unfiltered_html === true,
        },
      }
    },

    async listContent(opts = {}): Promise<BuilderResult<ContentRef[]>> {
      const limit = String(Math.min(Math.max(opts.limit ?? 20, 1), LIST_MAX))
      const query = { context: 'edit', per_page: limit, status: 'publish', _fields: 'id,title,link,status', ...(opts.search ? { search: opts.search.slice(0, 100) } : {}) }
      const out: ContentRef[] = []
      for (const kind of ['page', 'post'] as const) {
        const got = await call(deps, api(`wp/v2/${collection(kind)}`, { ...query, ...(kind === 'post' ? { per_page: '10' } : {}) }), { auth })
        if (!got.ok) return got
        for (const row of Array.isArray(got.value) ? got.value : []) {
          const ref = refOf(kind, row)
          if (ref) out.push(ref)
        }
      }
      return { ok: true, value: out }
    },

    async readContent(ref): Promise<BuilderResult<ContentSnapshot>> {
      if (!ID_RE.test(ref.id) || !isWpKind(ref.kind)) return no(404, 'not found on the site')
      const got = await call(deps, api(`wp/v2/${collection(ref.kind)}/${ref.id}`, { context: 'edit' }), { auth })
      if (!got.ok) return got
      const row = got.value as { content?: unknown; title?: unknown; modified_gmt?: unknown; modified?: unknown }
      const found = refOf(ref.kind, got.value)
      if (!found) return no(404, 'not found on the site')
      return { ok: true, value: { ref: found, title: raw(row.title), body: raw(row.content), modified: str(row.modified_gmt) || str(row.modified) || null } }
    },

    async writeContent(ref, next): Promise<BuilderResult<{ modified: string | null; revision: string | null }>> {
      if (!ID_RE.test(ref.id) || !isWpKind(ref.kind)) return no(404, 'not found on the site')
      const got = await call(deps, api(`wp/v2/${collection(ref.kind)}/${ref.id}`), { method: 'POST', auth, body: { content: next.body, ...(next.title !== undefined ? { title: next.title } : {}) } })
      if (!got.ok) return got
      const row = got.value as { modified_gmt?: unknown; modified?: unknown }
      // The revision WordPress kept is the newest of the page's revisions: read for the owner's record, best effort.
      const revs = await call(deps, api(`wp/v2/${collection(ref.kind)}/${ref.id}/revisions`, { per_page: '1', _fields: 'id' }), { auth })
      const first = revs.ok && Array.isArray(revs.value) ? (revs.value[0] as { id?: unknown } | undefined) : undefined
      return { ok: true, value: { modified: str(row.modified_gmt) || str(row.modified) || null, revision: first && (typeof first.id === 'number' || typeof first.id === 'string') ? String(first.id) : null } }
    },

    embedBlock(html: string): string {
      // A Custom HTML block: WordPress keeps its markup as written for a login allowed unfiltered_html.
      return `\n\n<!-- wp:html -->\n${html}\n<!-- /wp:html -->\n`
    },
  }
}
