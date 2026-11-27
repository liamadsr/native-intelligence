/**
 * A Wix site, through Wix's REST APIs, as our app installed on it
 * (docs/plans/hosted-site-builders.md, Wix, phase 4; roadmap issue #13,
 * Liam, 11-27: "let's do it").
 *
 *   connect   an UNLISTED app (no App Market review): the owner opens our
 *             install link, approves the app's permissions on Wix, and Wix
 *             sends them back to our callback with the site's instance id.
 *             Nothing tied to a person is kept: each call mints a short-lived
 *             token from our app's id and secret and that instance
 *             ({@link wixToken}, the client-credentials grant), and the
 *             instance is checked to be the site asked for.
 *   content   honest about what Wix allows: NO API changes the text of a
 *             Wix page. What can change: CMS collection items (Wix Data;
 *             read as one JSON object of their text fields, as Webflow's) and
 *             product descriptions (Wix Stores). Blog posts are kept in Wix's
 *             rich-content JSON, not text: not here yet. Wix keeps no
 *             revision: undo writes the earlier text back from the change row.
 *   form      site-wide, on every page: the app's Embedded Script (an
 *             extension defined in the app's dashboard, placed at the end of
 *             the body, whose one parameter is the form's key), turned on with
 *             Embed Script. It reads and writes as the embed's own markup (a
 *             `<div data-ni-form>` and our embed.js), so the flow reads back
 *             what Wix keeps exactly as it does for a page.
 *
 * Each call answers a result, never throws for Wix's answer. Server only.
 */
import { embedSnippet } from '@/lib/forms/manage'
import type { BuilderClient, BuilderIdentity, BuilderResult, ContentRef, ContentSnapshot } from './types'

export const WIX_API = 'https://www.wixapis.com'

/** The permissions the app asks for, set on the app's dashboard (the owner's steps, deploy/app/.env.example). */
export const WIX_PERMISSIONS = ['Manage Embedded Scripts', 'Wix Data: read and write items', 'Wix Stores: manage products', 'Read site, business and email details'] as const

export interface WixApp {
  appId: string
  appSecret: string
}

export interface WixLogin extends WixApp {
  instanceId: string
  /** Our app's own origin, for the form embed's markup. */
  formOrigin: string
}

export interface WixDeps {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

const INSTANCE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const GUID_RE = INSTANCE_RE
const ITEM_RE = /^([A-Za-z0-9_-]{1,100})::([A-Za-z0-9_-]{1,100})$/
const MAX_BYTES = 3_000_000

/** The form's place: one per site, every page. */
export const WIX_FORM_REF: ContentRef = { kind: 'site_script', id: 'site-form', title: 'every page of your site', url: null, status: 'publish' }

const no = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error })
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export function isWixInstance(v: unknown): v is string {
  return typeof v === 'string' && INSTANCE_RE.test(v)
}

/**
 * Our install link: Wix's installer for our app, which sends the owner to our
 * callback with the site's instance id and our state once they approve. Pure.
 */
export function wixInstallLink(args: { appId: string; redirectUrl: string; state: string }): string {
  const url = new URL('https://www.wix.com/installer/install')
  url.searchParams.set('appId', args.appId)
  url.searchParams.set('redirectUrl', args.redirectUrl)
  url.searchParams.set('state', args.state)
  return url.toString()
}

async function send(deps: WixDeps, url: string, init: { method?: string; token?: string; body?: unknown } = {}): Promise<BuilderResult<unknown>> {
  let res: Response
  try {
    res = await (deps.fetchImpl ?? fetch)(url, {
      method: init.method ?? 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
      headers: { Accept: 'application/json', ...(init.token ? { Authorization: init.token } : {}), ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    })
  } catch {
    return no(0, 'Wix did not answer')
  }
  if (res.status === 401 || res.status === 403) return no(res.status, 'Wix refused our app (it was removed from the site, or a permission is missing)')
  if (res.status === 429) return no(429, 'Wix asked us to slow down')
  if (res.status === 404) return no(404, 'not found on the site')
  let body: unknown
  try {
    const text = await res.text()
    if (text.length > MAX_BYTES) return no(res.status, 'Wix sent too much')
    body = text ? JSON.parse(text) : null
  } catch {
    return no(res.status, 'Wix did not answer as it does')
  }
  if (!res.ok) {
    const msg = body && typeof body === 'object' ? str((body as { message?: unknown }).message).slice(0, 200) : ''
    return no(res.status, msg ? `Wix refused it: ${msg}` : `Wix answered ${res.status}`)
  }
  return { ok: true, value: body }
}

/** A short-lived token for our app on one site (the client-credentials grant). */
export async function wixToken(app: WixApp, instanceId: string, deps: WixDeps = {}): Promise<BuilderResult<string>> {
  if (!isWixInstance(instanceId)) return no(0, 'not a Wix site')
  const got = await send(deps, `${WIX_API}/oauth2/token`, { method: 'POST', body: { grant_type: 'client_credentials', client_id: app.appId, client_secret: app.appSecret, instance_id: instanceId } })
  if (!got.ok) return got
  const token = got.value && typeof got.value === 'object' ? str((got.value as { access_token?: unknown }).access_token) : ''
  return token ? { ok: true, value: token } : no(400, 'Wix sent no token')
}

/** A CMS item's text fields, the JSON text the agent edits (keys sorted; no system fields). Pure. */
export function wixItemText(data: Record<string, unknown>): string {
  const fields: Record<string, string> = {}
  for (const k of Object.keys(data).sort()) if (!k.startsWith('_') && typeof data[k] === 'string' && !/^(slug|link-)/.test(k)) fields[k] = data[k] as string
  return JSON.stringify(fields, null, 2)
}

/** A Wix site as a {@link BuilderClient}. */
export function wixClient(login: WixLogin, deps: WixDeps = {}): BuilderClient {
  let cached: string | null = null
  const token = async (): Promise<BuilderResult<string>> => {
    if (cached) return { ok: true, value: cached }
    const got = await wixToken(login, login.instanceId, deps)
    if (got.ok) cached = got.value
    return got
  }
  async function call(path: string, init: { method?: string; body?: unknown } = {}): Promise<BuilderResult<unknown>> {
    const t = await token()
    if (!t.ok) return t
    return send(deps, `${WIX_API}/${path}`, { ...init, token: t.value })
  }

  const productRef = (p: unknown): ContentRef | null => {
    const r = p as { id?: unknown; name?: unknown; visible?: unknown; productPageUrl?: { base?: unknown; path?: unknown } }
    if (!r || typeof r.id !== 'string' || !GUID_RE.test(r.id)) return null
    const base = str(r.productPageUrl?.base)
    const url = base ? `${base.replace(/\/$/, '')}${str(r.productPageUrl?.path)}` : ''
    return { kind: 'product', id: r.id, title: str(r.name).slice(0, 200), url: /^https:\/\//.test(url) ? url : null, status: r.visible === false ? 'draft' : 'publish' }
  }
  const itemRef = (collectionId: string, collectionName: string, it: unknown): ContentRef | null => {
    const r = it as { id?: unknown; data?: Record<string, unknown> }
    if (!r || typeof r.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(r.id)) return null
    return { kind: 'cms_item', id: `${collectionId}::${r.id}`, title: `${str(r.data?.title) || 'Untitled'} (${collectionName})`.slice(0, 200), url: null, status: 'publish' }
  }

  return {
    provider: 'wix',
    kinds: ['product', 'cms_item'],
    keepsRevisions: false,
    siteWideForm: WIX_FORM_REF,
    looksLikeId: (hint: string) => GUID_RE.test(hint.trim()) || ITEM_RE.test(hint.trim()),
    titleOf: (body: string) => {
      if (!body.trimStart().startsWith('{')) return null
      try {
        const title = (JSON.parse(body) as { title?: unknown }).title
        return typeof title === 'string' ? title : null
      } catch {
        return null
      }
    },
    validateEdit: (before: string, after: string) => {
      // A CMS item's text must stay its fields; a product's description is plain HTML.
      if (!before.trimStart().startsWith('{')) return null
      try {
        const a = JSON.parse(after) as Record<string, unknown>
        const b = JSON.parse(before) as Record<string, unknown>
        const same = Object.keys(a).sort().join('\n') === Object.keys(b).sort().join('\n') && Object.values(a).every((v) => typeof v === 'string')
        return same ? null : 'The edit changed which fields the item has: only their text may change.'
      } catch {
        return 'The edit broke the item’s fields (they must stay as they were around the text changed).'
      }
    },

    async identity(): Promise<BuilderResult<BuilderIdentity>> {
      const got = await call('apps/v1/instance')
      if (!got.ok) return got
      const r = got.value as { site?: { url?: unknown; siteDisplayName?: unknown }; instance?: { permissions?: unknown } }
      const url = str(r.site?.url)
      return {
        ok: true,
        value: {
          name: str(r.site?.siteDisplayName).slice(0, 200),
          siteUrl: /^https:\/\//.test(url) ? new URL(url).origin : '',
          user: 'Wix',
          // Our app installed is our permission: a missing one answers each call with a refusal.
          canEdit: true,
          canEmbed: true,
        },
      }
    },

    async listContent(opts = {}): Promise<BuilderResult<ContentRef[]>> {
      const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50)
      const want = opts.search?.toLowerCase() ?? null
      const out: ContentRef[] = []
      const products = await call('stores/v1/products/query', { method: 'POST', body: { query: { paging: { limit: Math.min(limit, 20) } } } })
      // A site without Wix Stores answers 404 there: it simply has no products.
      if (!products.ok && products.status !== 404) return products
      for (const p of products.ok ? ((products.value as { products?: unknown[] })?.products ?? []) : []) {
        const ref = productRef(p)
        if (ref && (!want || ref.title.toLowerCase().includes(want))) out.push(ref)
      }
      const cols = await call('wix-data/v2/collections?paging.limit=10')
      if (!cols.ok) return cols
      for (const c of ((cols.value as { collections?: Array<{ id?: unknown; displayName?: unknown }> })?.collections ?? []).slice(0, 5)) {
        // The site's own collections only: Wix's apps keep theirs under a namespace ("Stores/Products").
        if (typeof c.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(c.id)) continue
        const items = await call('wix-data/v2/items/query', { method: 'POST', body: { dataCollectionId: c.id, query: { paging: { limit } } } })
        if (!items.ok) return items
        for (const it of (items.value as { dataItems?: unknown[] })?.dataItems ?? []) {
          const ref = itemRef(c.id, str(c.displayName) || c.id, it)
          if (ref && (!want || ref.title.toLowerCase().includes(want))) out.push(ref)
        }
      }
      return { ok: true, value: out }
    },

    async readContent(ref): Promise<BuilderResult<ContentSnapshot>> {
      if (ref.kind === 'site_script') {
        const got = await call('apps/v1/scripts')
        const key = got.ok ? str((got.value as { properties?: { parameters?: { formKey?: unknown } } })?.properties?.parameters?.formKey) : ''
        if (!got.ok && got.status !== 404) return got
        return { ok: true, value: { ref: WIX_FORM_REF, title: WIX_FORM_REF.title, body: /^fk_[A-Za-z0-9_-]{43}$/.test(key) ? embedSnippet(login.formOrigin, key) : '', modified: null } }
      }
      if (ref.kind === 'product') {
        if (!GUID_RE.test(ref.id)) return no(404, 'not found on the site')
        const got = await call(`stores/v1/products/${ref.id}`)
        if (!got.ok) return got
        const p = (got.value as { product?: { name?: unknown; description?: unknown } })?.product
        const found = productRef(p)
        if (!found || !p) return no(404, 'not found on the site')
        return { ok: true, value: { ref: found, title: str(p.name), body: str(p.description), modified: null } }
      }
      const m = ref.kind === 'cms_item' ? ITEM_RE.exec(ref.id) : null
      if (!m) return no(404, 'not found on the site')
      const got = await call(`wix-data/v2/items/${m[2]}?dataCollectionId=${encodeURIComponent(m[1])}`)
      if (!got.ok) return got
      const item = (got.value as { dataItem?: { id?: unknown; data?: Record<string, unknown> } })?.dataItem
      const found = itemRef(m[1], m[1], item)
      if (!found || !item?.data) return no(404, 'not found on the site')
      return { ok: true, value: { ref: found, title: str(item.data.title), body: wixItemText(item.data), modified: str(item.data._updatedDate) || null } }
    },

    async writeContent(ref, next): Promise<BuilderResult<{ modified: string | null; revision: string | null }>> {
      const done: BuilderResult<{ modified: string | null; revision: string | null }> = { ok: true, value: { modified: null, revision: null } }
      if (ref.kind === 'site_script') {
        // The embed's markup carries the form's key: that key is the script's one parameter (none: the form comes off).
        const key = /data-ni-form="(fk_[A-Za-z0-9_-]{43})"/.exec(next.body)?.[1] ?? ''
        const got = await call('apps/v1/scripts', { method: 'POST', body: { properties: { parameters: { formKey: key } } } })
        return got.ok ? done : got
      }
      if (ref.kind === 'product') {
        if (!GUID_RE.test(ref.id)) return no(404, 'not found on the site')
        const got = await call(`stores/v1/products/${ref.id}`, { method: 'PATCH', body: { product: { description: next.body, ...(next.title !== undefined ? { name: next.title } : {}) } } })
        return got.ok ? done : got
      }
      const m = ref.kind === 'cms_item' ? ITEM_RE.exec(ref.id) : null
      if (!m) return no(404, 'not found on the site')
      let fields: Record<string, string>
      try {
        fields = JSON.parse(next.body) as Record<string, string>
      } catch {
        return no(400, 'the item’s fields are not readable')
      }
      // An update replaces the whole item: its other fields (numbers, images, references) are kept from Wix's own copy.
      const now = await call(`wix-data/v2/items/${m[2]}?dataCollectionId=${encodeURIComponent(m[1])}`)
      if (!now.ok) return now
      const data = (now.value as { dataItem?: { data?: Record<string, unknown> } })?.dataItem?.data ?? {}
      const got = await call(`wix-data/v2/items/${m[2]}`, { method: 'PUT', body: { dataCollectionId: m[1], dataItem: { id: m[2], dataCollectionId: m[1], data: { ...data, ...fields } } } })
      return got.ok ? done : got
    },

    embedBlock(html: string): string {
      return html
    },
  }
}
