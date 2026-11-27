/**
 * A Shopify store, through the Admin GraphQL API, with the offline access
 * token our app gets when the merchant approves it (docs/plans/hosted-site-
 * builders.md, Shopify; roadmap issue #13, Liam, 11-27: "let's do it").
 *
 *   connect   {@link shopifyAuthorizeLink}: the store's own consent page
 *             (/admin/oauth/authorize, the authorization code grant);
 *             {@link shopifyCallbackValid} checks Shopify's HMAC over the
 *             callback, and {@link shopifyExchangeCode} trades the code for
 *             the token, server-side. Designed for custom distribution first
 *             (one store, or one Plus organization, no App Store review); a
 *             public app changes only who may install it.
 *   identity  shop { name, primaryDomain } and the scopes the token holds.
 *   content   Online Store pages (`pageUpdate`: body HTML and title) and
 *             products (`productUpdate`: descriptionHtml and title). Shopify
 *             keeps no revision of either: our undo writes the text before
 *             back, from the change row.
 *
 * The store's address is never trusted: only `<name>.myshopify.com` over
 * https, and the token only ever goes to that host. Each call answers a
 * result, never throws for Shopify's answer; a throttle is a result too.
 *
 * Server only.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { BuilderClient, BuilderIdentity, BuilderResult, ContentRef, ContentSnapshot } from './types'

/** The Admin API version this client speaks (Shopify supports each for a year). */
export const SHOPIFY_API_VERSION = '2026-10'

/** What the app asks the merchant for: pages and products, read and write. */
export const SHOPIFY_SCOPES = ['read_online_store_pages', 'write_online_store_pages', 'read_products', 'write_products'] as const

export interface ShopifyLogin {
  /** The store's own host, `<name>.myshopify.com`. */
  shop: string
  token: string
}

export interface ShopifyDeps {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

const SHOP_RE = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/
const MAX_BYTES = 3_000_000

const no = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error })

/**
 * The store's `.myshopify.com` host from what the owner typed: the store's
 * handle, its myshopify address, or an admin link. Null for anything else
 * (a custom domain can't be told from here: ask for the myshopify one). Pure.
 */
export function shopHostOf(input: string | null | undefined): string | null {
  if (!input) return null
  const raw = input.trim().toLowerCase()
  const admin = /admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]{0,60})/.exec(raw)
  if (admin) return `${admin[1]}.myshopify.com`
  const host = raw.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '')
  if (SHOP_RE.test(host)) return host
  if (/^[a-z0-9][a-z0-9-]{0,60}$/.test(host)) return `${host}.myshopify.com`
  return null
}

export function isShopHost(v: unknown): v is string {
  return typeof v === 'string' && SHOP_RE.test(v)
}

/** The store's consent page: Shopify asks the merchant, then sends them to `redirectUri` with a code. Pure. */
export function shopifyAuthorizeLink(shop: string, args: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL(`https://${shop}/admin/oauth/authorize`)
  url.searchParams.set('client_id', args.clientId)
  url.searchParams.set('scope', SHOPIFY_SCOPES.join(','))
  url.searchParams.set('redirect_uri', args.redirectUri)
  url.searchParams.set('state', args.state)
  return url.toString()
}

/**
 * Whether a callback's query is Shopify's: its `hmac` is the HMAC-SHA256 (hex)
 * of the other parameters, sorted and joined `k=v&k=v`, under the app's
 * secret; and its shop is a myshopify host. Pure.
 */
export function shopifyCallbackValid(params: URLSearchParams, clientSecret: string): boolean {
  const hmac = params.get('hmac')
  if (!hmac || !/^[0-9a-f]{64}$/i.test(hmac) || !isShopHost(params.get('shop'))) return false
  const message = [...params.entries()]
    .filter(([k]) => k !== 'hmac' && k !== 'signature')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  const want = Buffer.from(createHmac('sha256', clientSecret).update(message).digest('hex'))
  const got = Buffer.from(hmac.toLowerCase())
  return got.length === want.length && timingSafeEqual(new Uint8Array(got), new Uint8Array(want))
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text()
  if (text.length > MAX_BYTES) throw new Error('too large')
  return text ? JSON.parse(text) : null
}

/** Trade the callback's code for the store's offline token (server-side; the secret never leaves us). */
export async function shopifyExchangeCode(shop: string, args: { clientId: string; clientSecret: string; code: string }, deps: ShopifyDeps = {}): Promise<BuilderResult<{ token: string; scopes: string[] }>> {
  if (!isShopHost(shop)) return no(0, 'not a Shopify store')
  let res: Response
  try {
    res = await (deps.fetchImpl ?? fetch)(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: args.clientId, client_secret: args.clientSecret, code: args.code }),
    })
  } catch {
    return no(0, 'Shopify did not answer')
  }
  if (!res.ok) return no(res.status, `Shopify answered ${res.status}`)
  try {
    const body = (await readJson(res)) as { access_token?: unknown; scope?: unknown }
    if (typeof body?.access_token !== 'string' || !body.access_token) return no(res.status, 'Shopify sent no token')
    return { ok: true, value: { token: body.access_token, scopes: typeof body.scope === 'string' ? body.scope.split(',').map((s) => s.trim()).filter(Boolean) : [] } }
  } catch {
    return no(res.status, 'Shopify did not answer as it does')
  }
}

const GID_RE = /^gid:\/\/shopify\/(Page|Product)\/\d{1,20}$/

const kindOfGid = (id: string): ContentRef['kind'] | null => (id.startsWith('gid://shopify/Page/') ? 'page' : id.startsWith('gid://shopify/Product/') ? 'product' : null)

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function refOf(kind: ContentRef['kind'], v: unknown): ContentRef | null {
  if (!v || typeof v !== 'object') return null
  const r = v as { id?: unknown; title?: unknown; onlineStoreUrl?: unknown; isPublished?: unknown; status?: unknown }
  if (typeof r.id !== 'string' || !GID_RE.test(r.id)) return null
  const url = str(r.onlineStoreUrl)
  const status = kind === 'page' ? (r.isPublished === false ? 'draft' : 'publish') : str(r.status).toLowerCase() === 'active' ? 'publish' : str(r.status).toLowerCase() || 'publish'
  return { kind, id: r.id, title: str(r.title).slice(0, 200), url: /^https:\/\//.test(url) ? url : null, status }
}

const PAGE_FIELDS = 'id title body isPublished onlineStoreUrl'
const PRODUCT_FIELDS = 'id title descriptionHtml status onlineStoreUrl'

/** A Shopify store as a {@link BuilderClient}. */
export function shopifyClient(login: ShopifyLogin, deps: ShopifyDeps = {}): BuilderClient {
  const endpoint = `https://${login.shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`

  async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<BuilderResult<T>> {
    if (!isShopHost(login.shop)) return no(0, 'not a Shopify store')
    let res: Response
    try {
      res = await (deps.fetchImpl ?? fetch)(endpoint, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Shopify-Access-Token': login.token },
        body: JSON.stringify({ query, variables }),
      })
    } catch {
      return no(0, 'Shopify did not answer')
    }
    if (res.status === 401 || res.status === 403) return no(res.status, 'the Shopify login was refused')
    if (res.status === 429) return no(429, 'Shopify asked us to slow down')
    if (res.status >= 300) return no(res.status, `Shopify answered ${res.status}`)
    let body: { data?: T; errors?: Array<{ message?: string; extensions?: { code?: string } }> }
    try {
      body = (await readJson(res)) as typeof body
    } catch {
      return no(res.status, 'Shopify did not answer as it does')
    }
    if (body?.errors?.length) {
      const code = body.errors[0]?.extensions?.code
      if (code === 'THROTTLED') return no(429, 'Shopify asked us to slow down')
      if (code === 'ACCESS_DENIED') return no(403, 'that Shopify login can’t change this')
      return no(400, 'Shopify refused the request')
    }
    if (!body?.data) return no(500, 'Shopify sent nothing back')
    return { ok: true, value: body.data }
  }

  return {
    provider: 'shopify',
    kinds: ['page', 'product'],
    keepsRevisions: false,
    looksLikeId: (hint: string) => GID_RE.test(hint.trim()),

    async identity(): Promise<BuilderResult<BuilderIdentity>> {
      const got = await gql<{ shop?: { name?: string; primaryDomain?: { url?: string } }; currentAppInstallation?: { accessScopes?: Array<{ handle?: string }> } }>(
        'query { shop { name primaryDomain { url } } currentAppInstallation { accessScopes { handle } } }',
      )
      if (!got.ok) return got
      const scopes = new Set((got.value.currentAppInstallation?.accessScopes ?? []).map((s) => str(s.handle)))
      const url = str(got.value.shop?.primaryDomain?.url)
      const pages = scopes.has('write_online_store_pages') || scopes.has('write_content')
      return {
        ok: true,
        value: {
          name: str(got.value.shop?.name).slice(0, 200),
          siteUrl: /^https:\/\//.test(url) ? new URL(url).origin : `https://${login.shop}`,
          user: login.shop,
          canEdit: pages,
          // A form goes in a page's body; whether the store keeps its script is checked on the write itself.
          canEmbed: pages,
        },
      }
    },

    async listContent(opts = {}): Promise<BuilderResult<ContentRef[]>> {
      const first = Math.min(Math.max(opts.limit ?? 20, 1), 50)
      const query = opts.search ? `title:*${opts.search.replace(/[\\"*:()]/g, ' ').trim().slice(0, 80)}*` : null
      const got = await gql<{ pages?: { nodes?: unknown[] }; products?: { nodes?: unknown[] } }>(
        `query($first: Int!, $products: Int!, $query: String) { pages(first: $first, query: $query) { nodes { ${PAGE_FIELDS} } } products(first: $products, query: $query) { nodes { ${PRODUCT_FIELDS} } } }`,
        { first, products: Math.min(first, 10), query },
      )
      if (!got.ok) return got
      const out: ContentRef[] = []
      for (const n of got.value.pages?.nodes ?? []) {
        const ref = refOf('page', n)
        if (ref) out.push(ref)
      }
      for (const n of got.value.products?.nodes ?? []) {
        const ref = refOf('product', n)
        if (ref) out.push(ref)
      }
      return { ok: true, value: out }
    },

    async readContent(ref): Promise<BuilderResult<ContentSnapshot>> {
      if (!GID_RE.test(ref.id) || kindOfGid(ref.id) !== ref.kind) return no(404, 'not found on the store')
      if (ref.kind === 'page') {
        const got = await gql<{ page?: { title?: string; body?: string } | null }>(`query($id: ID!) { page(id: $id) { ${PAGE_FIELDS} } }`, { id: ref.id })
        if (!got.ok) return got
        const found = refOf('page', got.value.page)
        if (!found || !got.value.page) return no(404, 'not found on the store')
        return { ok: true, value: { ref: found, title: str(got.value.page.title), body: str(got.value.page.body), modified: null } }
      }
      const got = await gql<{ product?: { title?: string; descriptionHtml?: string } | null }>(`query($id: ID!) { product(id: $id) { ${PRODUCT_FIELDS} } }`, { id: ref.id })
      if (!got.ok) return got
      const found = refOf('product', got.value.product)
      if (!found || !got.value.product) return no(404, 'not found on the store')
      return { ok: true, value: { ref: found, title: str(got.value.product.title), body: str(got.value.product.descriptionHtml), modified: null } }
    },

    async writeContent(ref, next): Promise<BuilderResult<{ modified: string | null; revision: string | null }>> {
      if (!GID_RE.test(ref.id) || kindOfGid(ref.id) !== ref.kind) return no(404, 'not found on the store')
      type Answer = { userErrors?: Array<{ message?: string }> } | null | undefined
      const answered = (a: Answer): BuilderResult<{ modified: string | null; revision: string | null }> =>
        a?.userErrors?.length ? no(422, `Shopify refused it: ${str(a.userErrors[0]?.message).slice(0, 200) || 'no reason given'}`) : { ok: true, value: { modified: null, revision: null } }
      if (ref.kind === 'page') {
        const got = await gql<{ pageUpdate?: Answer }>('mutation($id: ID!, $page: PageUpdateInput!) { pageUpdate(id: $id, page: $page) { page { id } userErrors { field message } } }', {
          id: ref.id,
          page: { body: next.body, ...(next.title !== undefined ? { title: next.title } : {}) },
        })
        return got.ok ? answered(got.value.pageUpdate) : got
      }
      const got = await gql<{ productUpdate?: Answer }>('mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id } userErrors { field message } } }', {
        product: { id: ref.id, descriptionHtml: next.body, ...(next.title !== undefined ? { title: next.title } : {}) },
      })
      return got.ok ? answered(got.value.productUpdate) : got
    },

    embedBlock(html: string): string {
      return `\n${html}\n`
    },
  }
}
