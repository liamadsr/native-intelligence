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
 * public host name only (./fetch.ts publicHttpsUrl), no redirects followed
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

export interface WordpressDeps {
  fetchImpl?: typeof fetch
  timeoutMs?: number
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
const ID_RE = /^\d{1,12}$/

/** A WordPress site as a {@link BuilderClient}. */
export function wordpressClient(login: WordpressLogin, deps: WordpressDeps = {}): BuilderClient {
  const auth = `Basic ${Buffer.from(`${login.user}:${login.password}`).toString('base64')}`
  const api = (path: string, query?: Record<string, string>) => wordpressUrl(login.apiRoot, path, query)
  return {
    provider: 'wordpress',

    async identity(): Promise<BuilderResult<BuilderIdentity>> {
      const me = await call(deps, api('wp/v2/users/me', { context: 'edit' }), { auth })
      if (!me.ok) return me
      const user = me.value as { name?: unknown; slug?: unknown; capabilities?: Record<string, unknown> }
      const caps = user.capabilities && typeof user.capabilities === 'object' ? user.capabilities : {}
      const index = await call(deps, login.apiRoot)
      const info = index.ok && index.value && typeof index.value === 'object' ? (index.value as { name?: unknown; home?: unknown; url?: unknown }) : {}
      const home = publicHttpsUrl(str(info.home) || str(info.url)) ?? publicHttpsUrl(login.apiRoot)
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
      if (!ID_RE.test(ref.id)) return no(404, 'not found on the site')
      const got = await call(deps, api(`wp/v2/${collection(ref.kind)}/${ref.id}`, { context: 'edit' }), { auth })
      if (!got.ok) return got
      const row = got.value as { content?: unknown; title?: unknown; modified_gmt?: unknown; modified?: unknown }
      const found = refOf(ref.kind, got.value)
      if (!found) return no(404, 'not found on the site')
      return { ok: true, value: { ref: found, title: raw(row.title), body: raw(row.content), modified: str(row.modified_gmt) || str(row.modified) || null } }
    },

    async writeContent(ref, next): Promise<BuilderResult<{ modified: string | null; revision: string | null }>> {
      if (!ID_RE.test(ref.id)) return no(404, 'not found on the site')
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
