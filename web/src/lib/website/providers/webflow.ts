/**
 * A Webflow site, through the Data API v2, with the token our app gets when
 * the site's owner approves it (docs/plans/hosted-site-builders.md, Webflow,
 * phase 3; roadmap issue #13, Liam, 11-27: "let's do it").
 *
 *   connect   {@link webflowAuthorizeLink}: Webflow's consent page, where the
 *             owner picks the site(s) the app may reach; the code is traded
 *             for a token server-side ({@link webflowExchangeCode}); the site
 *             is the one matching the address they gave
 *             ({@link pickWebflowSite}). An app outside our own Workspace
 *             installs only after Webflow's review (private apps too).
 *   content   CMS collection items only: Webflow's API writes a static page's
 *             primary-language text nowhere (its DOM write takes secondary
 *             locales alone), so "change the homepage hours" is said to be
 *             impossible unless the text is in the CMS. An item reads as its
 *             text fields, one JSON object (`{"name": …, "summary": …}`); an
 *             edit replaces text inside it, which must stay that object with
 *             the same fields; the write is the item's live update (it
 *             publishes that item only, never the whole site). Webflow keeps no
 *             revision: our undo writes the earlier fields back.
 *   form      not here yet: a form needs a placed element on a page, which a
 *             registered script alone doesn't give (plan, phase 3).
 *
 * Each call answers a result, never throws for Webflow's answer; 429 (60 to
 * 120 requests a minute by site plan) is a result too. Server only.
 */
import type { BuilderClient, BuilderIdentity, BuilderResult, ContentRef, ContentSnapshot } from './types'

export const WEBFLOW_API = 'https://api.webflow.com/v2'
export const WEBFLOW_SCOPES = ['sites:read', 'cms:read', 'cms:write'] as const

export interface WebflowLogin {
  token: string
  siteId: string
}

export interface WebflowDeps {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

const ID_RE = /^[0-9a-f]{24}$/
const REF_RE = /^([0-9a-f]{24}):([0-9a-f]{24})$/
const MAX_BYTES = 3_000_000
const COLLECTIONS_MAX = 5

const no = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error })
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export function webflowAuthorizeLink(args: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL('https://webflow.com/oauth/authorize')
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', args.clientId)
  url.searchParams.set('scope', WEBFLOW_SCOPES.join(' '))
  url.searchParams.set('redirect_uri', args.redirectUri)
  url.searchParams.set('state', args.state)
  return url.toString()
}

async function send(deps: WebflowDeps, url: string, init: { method?: string; token?: string; body?: unknown } = {}): Promise<BuilderResult<unknown>> {
  let res: Response
  try {
    res = await (deps.fetchImpl ?? fetch)(url, {
      method: init.method ?? 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
      headers: { Accept: 'application/json', ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}), ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    })
  } catch {
    return no(0, 'Webflow did not answer')
  }
  if (res.status === 401 || res.status === 403) return no(res.status, 'the Webflow login was refused')
  if (res.status === 429) return no(429, 'Webflow asked us to slow down')
  if (res.status === 404) return no(404, 'not found on the site')
  let body: unknown
  try {
    const text = await res.text()
    if (text.length > MAX_BYTES) return no(res.status, 'Webflow sent too much')
    body = text ? JSON.parse(text) : null
  } catch {
    return no(res.status, 'Webflow did not answer as it does')
  }
  if (!res.ok) {
    const msg = body && typeof body === 'object' ? str((body as { message?: unknown }).message).slice(0, 200) : ''
    return no(res.status, msg ? `Webflow refused it: ${msg}` : `Webflow answered ${res.status}`)
  }
  return { ok: true, value: body }
}

/** Trade the consent page's code for a token, server-side. */
export async function webflowExchangeCode(args: { clientId: string; clientSecret: string; code: string; redirectUri: string }, deps: WebflowDeps = {}): Promise<BuilderResult<{ token: string }>> {
  const got = await send(deps, `${WEBFLOW_API.replace(/\/v2$/, '')}/oauth/access_token`, {
    method: 'POST',
    body: { client_id: args.clientId, client_secret: args.clientSecret, code: args.code, grant_type: 'authorization_code', redirect_uri: args.redirectUri },
  })
  if (!got.ok) return got
  const token = got.value && typeof got.value === 'object' ? str((got.value as { access_token?: unknown }).access_token) : ''
  return token ? { ok: true, value: { token } } : no(400, 'Webflow sent no token')
}

export interface WebflowSite {
  id: string
  name: string
  /** Its addresses: custom domains, then its webflow.io one. */
  hosts: string[]
}

/** The sites the token reaches. */
export async function webflowSites(token: string, deps: WebflowDeps = {}): Promise<BuilderResult<WebflowSite[]>> {
  const got = await send(deps, `${WEBFLOW_API}/sites`, { token })
  if (!got.ok) return got
  const sites = got.value && typeof got.value === 'object' ? (got.value as { sites?: unknown }).sites : null
  const out: WebflowSite[] = []
  for (const s of Array.isArray(sites) ? sites : []) {
    const r = s as { id?: unknown; displayName?: unknown; shortName?: unknown; customDomains?: unknown }
    if (typeof r.id !== 'string' || !ID_RE.test(r.id)) continue
    const custom = Array.isArray(r.customDomains) ? r.customDomains.map((d) => str((d as { url?: unknown }).url).toLowerCase()).filter(Boolean) : []
    out.push({ id: r.id, name: str(r.displayName).slice(0, 200), hosts: [...custom, ...(str(r.shortName) ? [`${str(r.shortName).toLowerCase()}.webflow.io`] : [])] })
  }
  return { ok: true, value: out }
}

/**
 * The site an address names among those approved: by host (with or without
 * www), else the only one. Null when it's none of them or it can't be told.
 * Pure.
 */
export function pickWebflowSite(sites: readonly WebflowSite[], siteUrl: string | null): WebflowSite | null {
  const bare = (h: string) => h.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/^www\./, '').toLowerCase()
  if (siteUrl) {
    const want = bare(siteUrl)
    const hit = sites.find((s) => s.hosts.some((h) => bare(h) === want))
    if (hit) return hit
  }
  return sites.length === 1 ? sites[0] : null
}

/** An item's text fields, the JSON text the agent edits (keys sorted, one per line). Pure. */
export function itemText(fieldData: Record<string, unknown>): string {
  const fields: Record<string, string> = {}
  for (const k of Object.keys(fieldData).sort()) if (typeof fieldData[k] === 'string' && k !== 'slug') fields[k] = fieldData[k] as string
  return JSON.stringify(fields, null, 2)
}

/** The edited text back as fields: still one JSON object of strings, with exactly the same fields. Pure. */
export function itemFields(before: string, after: string): { ok: true; fields: Record<string, string> } | { ok: false; error: string } {
  let a: unknown
  let b: unknown
  try {
    a = JSON.parse(after)
    b = JSON.parse(before)
  } catch {
    return { ok: false, error: 'The edit broke the item’s fields (they must stay as they were around the text changed).' }
  }
  if (!a || typeof a !== 'object' || Array.isArray(a) || !b || typeof b !== 'object') return { ok: false, error: 'The edit broke the item’s fields.' }
  const keysA = Object.keys(a).sort()
  const keysB = Object.keys(b as object).sort()
  if (keysA.join('\n') !== keysB.join('\n') || keysA.some((k) => typeof (a as Record<string, unknown>)[k] !== 'string')) {
    return { ok: false, error: 'The edit changed which fields the item has: only their text may change.' }
  }
  return { ok: true, fields: a as Record<string, string> }
}

/** A Webflow site's CMS as a {@link BuilderClient}. */
export function webflowClient(login: WebflowLogin, deps: WebflowDeps = {}): BuilderClient {
  const api = (path: string) => `${WEBFLOW_API}/${path}`

  function refOf(collectionId: string, item: unknown, collectionName: string): ContentRef | null {
    if (!item || typeof item !== 'object') return null
    const r = item as { id?: unknown; isDraft?: unknown; isArchived?: unknown; fieldData?: Record<string, unknown> }
    if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return null
    const name = str(r.fieldData?.name)
    return { kind: 'cms_item', id: `${collectionId}:${r.id}`, title: `${name || 'Untitled'} (${collectionName})`.slice(0, 200), url: null, status: r.isArchived ? 'archived' : r.isDraft ? 'draft' : 'publish' }
  }

  return {
    provider: 'webflow',
    kinds: ['cms_item'],
    keepsRevisions: false,
    looksLikeId: (hint: string) => REF_RE.test(hint.trim()),
    validateEdit: (before: string, after: string) => {
      const checked = itemFields(before, after)
      return checked.ok ? null : checked.error
    },
    titleOf: (body: string) => {
      try {
        const name = (JSON.parse(body) as { name?: unknown }).name
        return typeof name === 'string' ? name : null
      } catch {
        return null
      }
    },

    async identity(): Promise<BuilderResult<BuilderIdentity>> {
      if (!ID_RE.test(login.siteId)) return no(404, 'not found on the site')
      const got = await send(deps, api(`sites/${login.siteId}`), { token: login.token })
      if (!got.ok) return got
      const r = got.value as { displayName?: unknown; shortName?: unknown; customDomains?: unknown }
      const custom = Array.isArray(r.customDomains) ? str((r.customDomains[0] as { url?: unknown } | undefined)?.url) : ''
      const host = custom || (str(r.shortName) ? `${str(r.shortName)}.webflow.io` : '')
      return { ok: true, value: { name: str(r.displayName).slice(0, 200), siteUrl: host ? `https://${host.replace(/^https?:\/\//, '')}` : '', user: 'Webflow', canEdit: true, canEmbed: false } }
    },

    async listContent(opts = {}): Promise<BuilderResult<ContentRef[]>> {
      const cols = await send(deps, api(`sites/${login.siteId}/collections`), { token: login.token })
      if (!cols.ok) return cols
      const collections = (cols.value as { collections?: Array<{ id?: unknown; displayName?: unknown }> })?.collections ?? []
      const out: ContentRef[] = []
      const want = opts.search?.toLowerCase() ?? null
      for (const c of collections.slice(0, COLLECTIONS_MAX)) {
        if (typeof c.id !== 'string' || !ID_RE.test(c.id)) continue
        const items = await send(deps, `${api(`collections/${c.id}/items`)}?limit=${Math.min(Math.max(opts.limit ?? 20, 1), 50)}`, { token: login.token })
        if (!items.ok) return items
        for (const it of (items.value as { items?: unknown[] })?.items ?? []) {
          const ref = refOf(c.id, it, str(c.displayName))
          if (ref && ref.status !== 'archived' && (!want || ref.title.toLowerCase().includes(want))) out.push(ref)
        }
      }
      return { ok: true, value: out }
    },

    async readContent(ref): Promise<BuilderResult<ContentSnapshot>> {
      const m = REF_RE.exec(ref.id)
      if (!m || ref.kind !== 'cms_item') return no(404, 'not found on the site')
      const got = await send(deps, api(`collections/${m[1]}/items/${m[2]}`), { token: login.token })
      if (!got.ok) return got
      const item = got.value as { fieldData?: Record<string, unknown>; lastUpdated?: unknown }
      const col = await send(deps, api(`collections/${m[1]}`), { token: login.token })
      const found = refOf(m[1], got.value, col.ok ? str((col.value as { displayName?: unknown })?.displayName) || 'CMS' : 'CMS')
      if (!found || !item.fieldData) return no(404, 'not found on the site')
      return { ok: true, value: { ref: found, title: str(item.fieldData.name), body: itemText(item.fieldData), modified: str(item.lastUpdated) || null } }
    },

    async writeContent(ref, next): Promise<BuilderResult<{ modified: string | null; revision: string | null }>> {
      const m = REF_RE.exec(ref.id)
      if (!m || ref.kind !== 'cms_item') return no(404, 'not found on the site')
      let fields: Record<string, string>
      try {
        fields = JSON.parse(next.body) as Record<string, string>
      } catch {
        return no(400, 'the item’s fields are not readable')
      }
      // The title is the item's `name` as read: it changes only through the fields' text (the flow refuses a separate title).
      const got = await send(deps, api(`collections/${m[1]}/items/${m[2]}/live`), { method: 'PATCH', token: login.token, body: { fieldData: fields } })
      if (!got.ok) return got
      return { ok: true, value: { modified: str((got.value as { lastUpdated?: unknown })?.lastUpdated) || null, revision: null } }
    },

    embedBlock(html: string): string {
      return html
    },
  }
}
