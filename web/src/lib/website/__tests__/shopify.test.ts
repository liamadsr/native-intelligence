/**
 * A website on Shopify (phase 2 of docs/plans/hosted-site-builders.md) on an
 * in-memory database and a fake Shopify store: the setting and its app
 * credentials, the store's consent link, the callback (Shopify's HMAC, our
 * state, the signed-in person, the code traded server-side), a page and a
 * product changed through the same card and yes, an undo, Shopify's refusals,
 * and a form whose script the store strips (the page put back). Nothing calls
 * a real Shopify. Every name is made up.
 */
import { createHmac, randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryDb } from '@/test/memory-db'

vi.mock('@/lib/chat/cloud-coding-tools', () => ({ startSiteCodingRun: vi.fn() }))
vi.mock('@/lib/safety/approvals', () => ({ createToolApproval: vi.fn() }))
vi.mock('@/lib/chat/home-message-writer', () => ({ appendHomeMessage: vi.fn(async () => ({ written: true, conversationId: 'conv-1' })) }))
vi.mock('@/lib/reach/route', () => ({ requestRoute: vi.fn(async () => undefined) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => undefined) } }))
vi.mock('@/lib/customers/store', () => ({ businessName: vi.fn(async () => 'Example Goods') }))
vi.mock('@/lib/demo/demo-mode', () => ({ isDemoWorkspace: vi.fn(async () => false), DEMO_OFF: { connector: 'demo' } }))
const dataTables = vi.hoisted(() => ({ byId: new Map<string, Record<string, unknown>>() }))
vi.mock('@/lib/tables/store', () => ({
  getTable: vi.fn(async (_db: unknown, workspaceId: string, tableId: string) => {
    const t = dataTables.byId.get(tableId)
    return t && t.workspace_id === workspaceId ? t : null
  }),
}))

process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64')

import { completeShopifyConnect, enabledBuilders, startBuilderConnect, type BuilderDeps } from '../builder'
import { startEdit, startUndo, startWiring } from '../start'
import { mergeWebsiteChange, websiteApprovalPermits } from '../approval'
import { getLiveSite, toChange } from '../store'
import { renderWebsiteSection } from '../section'
import { shopHostOf, shopifyCallbackValid, SHOPIFY_API_VERSION } from '../providers/shopify'
import { MERGE_WEBSITE_CHANGE_TOOL } from '../types'

type Row = Record<string, unknown>

const OWNER = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'
const WS = '00000000-0000-4000-8000-0000000000aa'
const SHOP = 'example-goods.myshopify.com'
const SECRET = 'made-up-shopify-app-secret'
const TOKEN = 'made-up-offline-token'
const ON = { WEBSITE_BUILDERS: 'shopify', SHOPIFY_CLIENT_ID: 'made-up-client-id', SHOPIFY_CLIENT_SECRET: SECRET }
const PAGE_GID = 'gid://shopify/Page/101'
const PRODUCT_GID = 'gid://shopify/Product/202'
const TABLE_ID = '00000000-0000-4000-8000-0000000000b1'
const FORM_ID = '00000000-0000-4000-8000-0000000000f1'

/** Shopify's HMAC over a callback's parameters, as the store signs them. */
function signed(params: Record<string, string>, secret = SECRET): URLSearchParams {
  const message = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&')
  return new URLSearchParams({ ...params, hmac: createHmac('sha256', secret).update(message).digest('hex') })
}

/** A fake store: its OAuth token endpoint and the Admin GraphQL API, with the writes made. */
function fakeShopify(opts: { scopes?: string[]; stripScripts?: boolean; userError?: string } = {}) {
  const pages = new Map<string, { title: string; body: string }>([[PAGE_GID, { title: 'About us', body: '<p>Open Monday to Friday, 9 to 5.</p>' }]])
  const products = new Map<string, { title: string; descriptionHtml: string }>([[PRODUCT_GID, { title: 'Deep clean', descriptionHtml: '<p>Three hours, two cleaners.</p>' }]])
  const writes: Array<{ mutation: string; variables: Record<string, unknown> }> = []
  const exchanges: unknown[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    if (url === `https://${SHOP}/admin/oauth/access_token`) {
      const body = JSON.parse(String(init?.body))
      exchanges.push(body)
      return body.code === 'good-code' && body.client_secret === SECRET ? json(200, { access_token: TOKEN, scope: (opts.scopes ?? ['write_online_store_pages', 'write_products']).join(',') }) : json(400, { error: 'invalid_request' })
    }
    if (url !== `https://${SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`) return json(404, {})
    if ((init?.headers as Record<string, string>)['X-Shopify-Access-Token'] !== TOKEN) return json(401, { errors: 'Invalid API key or access token' })
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> }
    const pageNode = (id: string) => ({ id, ...pages.get(id)!, isPublished: true, onlineStoreUrl: `https://examplegoods.test.site/pages/about` })
    const productNode = (id: string) => ({ id, ...products.get(id)!, status: 'ACTIVE', onlineStoreUrl: `https://examplegoods.test.site/products/deep-clean` })
    if (query.includes('currentAppInstallation')) {
      return json(200, { data: { shop: { name: 'Example Goods', primaryDomain: { url: 'https://examplegoods.test.site' } }, currentAppInstallation: { accessScopes: (opts.scopes ?? ['write_online_store_pages', 'write_products']).map((handle) => ({ handle })) } } })
    }
    if (query.includes('pageUpdate')) {
      writes.push({ mutation: 'pageUpdate', variables })
      if (opts.userError) return json(200, { data: { pageUpdate: { page: null, userErrors: [{ field: ['body'], message: opts.userError }] } } })
      const page = pages.get(String(variables.id))!
      const next = variables.page as { body: string; title?: string }
      page.body = opts.stripScripts ? next.body.replace(/<script[\s\S]*?<\/script>/g, '') : next.body
      if (next.title) page.title = next.title
      return json(200, { data: { pageUpdate: { page: { id: variables.id }, userErrors: [] } } })
    }
    if (query.includes('productUpdate')) {
      writes.push({ mutation: 'productUpdate', variables })
      const next = variables.product as { id: string; descriptionHtml: string; title?: string }
      const product = products.get(next.id)!
      product.descriptionHtml = next.descriptionHtml
      if (next.title) product.title = next.title
      return json(200, { data: { productUpdate: { product: { id: next.id }, userErrors: [] } } })
    }
    if (query.includes('pages(first')) return json(200, { data: { pages: { nodes: [...pages.keys()].map(pageNode) }, products: { nodes: [...products.keys()].map(productNode) } } })
    if (query.includes('page(id')) return json(200, { data: { page: pages.has(String(variables.id)) ? pageNode(String(variables.id)) : null } })
    if (query.includes('product(id')) return json(200, { data: { product: products.has(String(variables.id)) ? productNode(String(variables.id)) : null } })
    return json(200, { errors: [{ message: 'unknown query' }] })
  }) as typeof fetch
  return { pages, products, writes, exchanges, fetchImpl }
}

let tables: Record<string, Row[]>
let db: ReturnType<typeof memoryDb>
let shop: ReturnType<typeof fakeShopify>
const createApproval = vi.fn()

const builderDeps = (): BuilderDeps => ({ fetchImpl: shop.fetchImpl, createApproval, env: ON, now: () => Date.parse('2026-11-27T12:00:00Z') })
const startDeps = () => ({ fetchImpl: shop.fetchImpl, builder: builderDeps() })
const approvalDeps = () => ({ builder: builderDeps(), paused: async () => false })
const who = { userId: OWNER, workspaceId: WS }

beforeEach(() => {
  tables = { website_site: [], website_change: [], data_form: [], member: [{ id: 'm-owner', workspace_id: WS, user_id: OWNER, role: 'owner' }] }
  dataTables.byId.clear()
  db = memoryDb(tables, {
    website_site: (a, b) => a.workspace_id === b.workspace_id && a.state !== 'disconnected' && b.state !== 'disconnected',
    website_change: (a, b) => a.site_id === b.site_id && ['preparing', 'awaiting_yes', 'merging', 'deploying'].includes(String(a.state)) && ['preparing', 'awaiting_yes', 'merging', 'deploying'].includes(String(b.state)),
  })
  shop = fakeShopify()
  createApproval.mockReset().mockResolvedValue({ ok: true, approvalId: 'appr-1', cardId: 'card-1' })
})

/** The state a connect link carries. */
async function stateOfLink(): Promise<string> {
  const out = await startBuilderConnect(db, who, { builder: 'shopify', siteUrl: 'example-goods' }, builderDeps())
  expect(out.success).toBe(true)
  return new URL(String(out.connect_link)).searchParams.get('state')!
}

async function connected() {
  const state = await stateOfLink()
  const done = await completeShopifyConnect(db, { params: signed({ code: 'good-code', shop: SHOP, state, timestamp: '1795000000' }), sessionUserId: OWNER }, builderDeps())
  expect(done).toMatchObject({ ok: true })
  return (await getLiveSite(db, WS))!
}

const changeRow = () => tables.website_change[tables.website_change.length - 1]

async function yes() {
  const row = changeRow()
  const ctx = createApproval.mock.calls.at(-1)![0].context.website
  expect(await websiteApprovalPermits(db, { id: 'appr-1', workspace_id: WS, user_id: OWNER, tool: MERGE_WEBSITE_CHANGE_TOOL, context: { website: ctx } })).toBe(true)
  return mergeWebsiteChange(db, { userId: OWNER, workspaceId: WS, changeId: String(row.id), headSha: ctx.headSha }, approvalDeps())
}

describe('the setting and the pure parts', () => {
  it('Shopify is on only when named and the app’s two credentials are set', () => {
    expect(enabledBuilders({ WEBSITE_BUILDERS: 'shopify' })).toEqual([])
    expect(enabledBuilders({ WEBSITE_BUILDERS: 'shopify', SHOPIFY_CLIENT_ID: 'x' })).toEqual([])
    expect(enabledBuilders(ON)).toEqual(['shopify'])
    expect(enabledBuilders({ ...ON, WEBSITE_BUILDERS: 'wordpress,shopify' })).toEqual(['wordpress', 'shopify'])
  })

  it('reads a store’s myshopify host from a handle, an address or an admin link, never a custom domain', () => {
    expect(shopHostOf('example-goods')).toBe(SHOP)
    expect(shopHostOf('https://Example-Goods.myshopify.com/admin')).toBe(SHOP)
    expect(shopHostOf('https://admin.shopify.com/store/example-goods/products')).toBe(SHOP)
    expect(shopHostOf('examplegoods.com')).toBeNull()
    expect(shopHostOf('')).toBeNull()
  })

  it('tells Shopify’s HMAC from a forged or tampered one', () => {
    const good = signed({ code: 'c', shop: SHOP, state: 's', timestamp: '1' })
    expect(shopifyCallbackValid(good, SECRET)).toBe(true)
    expect(shopifyCallbackValid(signed({ code: 'c', shop: SHOP, state: 's', timestamp: '1' }, 'other-secret'), SECRET)).toBe(false)
    const tampered = new URLSearchParams(good)
    tampered.set('code', 'other')
    expect(shopifyCallbackValid(tampered, SECRET)).toBe(false)
    expect(shopifyCallbackValid(signed({ code: 'c', shop: 'evil.example.com', state: 's' }), SECRET)).toBe(false)
  })
})

describe('connect', () => {
  it('answers the store’s own consent link, with our scopes, redirect and a signed state', async () => {
    const out = await startBuilderConnect(db, who, { builder: 'shopify', siteUrl: 'example-goods.myshopify.com' }, builderDeps())
    const link = new URL(String(out.connect_link))
    expect(`${link.origin}${link.pathname}`).toBe(`https://${SHOP}/admin/oauth/authorize`)
    expect(link.searchParams.get('client_id')).toBe('made-up-client-id')
    expect(link.searchParams.get('scope')).toBe('read_online_store_pages,write_online_store_pages,read_products,write_products')
    expect(new URL(link.searchParams.get('redirect_uri')!).pathname).toBe('/api/website/shopify/callback')
    expect(link.searchParams.get('client_secret')).toBeNull()
    expect(String(out.connect_link)).not.toContain(SECRET)
  })

  it('asks for the myshopify address, and is off without the app', async () => {
    expect(await startBuilderConnect(db, who, { builder: 'shopify', siteUrl: 'examplegoods.com' }, builderDeps())).toMatchObject({ success: false, code: 'NEEDS_SHOP' })
    expect(await startBuilderConnect(db, who, { builder: 'shopify', siteUrl: 'example-goods' }, { ...builderDeps(), env: { WEBSITE_BUILDERS: 'shopify' } })).toMatchObject({ success: false, code: 'BUILDER_OFF' })
  })

  it('the callback trades the code server-side and saves the store, the token encrypted', async () => {
    const site = await connected()
    expect(shop.exchanges).toEqual([{ client_id: 'made-up-client-id', client_secret: SECRET, code: 'good-code' }])
    expect(site).toMatchObject({ provider: 'shopify', providerSiteId: `https://${SHOP}`, siteUrl: 'https://examplegoods.test.site', repoFullName: '', connectedBy: OWNER })
    const stored = String(tables.website_site[0].credentials_encrypted)
    expect(stored).toMatch(/^v1\./)
    expect(stored).not.toContain(TOKEN)
    expect(renderWebsiteSection(site, null, null)).toContain('Their website: a Shopify site "Example Goods", live at examplegoods.test.site.')
  })

  it('the callback refuses a forged HMAC, another person, another store, a bad code and a token without page rights', async () => {
    const state = await stateOfLink()
    const params = (extra: Record<string, string> = {}) => signed({ code: 'good-code', shop: SHOP, state, timestamp: '1795000000', ...extra })
    expect(await completeShopifyConnect(db, { params: signed({ code: 'good-code', shop: SHOP, state }, 'wrong'), sessionUserId: OWNER }, builderDeps())).toMatchObject({ ok: false, code: 'BAD_STATE' })
    expect(await completeShopifyConnect(db, { params: params(), sessionUserId: OTHER }, builderDeps())).toMatchObject({ ok: false, code: 'WRONG_PERSON' })
    expect(await completeShopifyConnect(db, { params: params({ shop: 'other-goods.myshopify.com' }), sessionUserId: OWNER }, builderDeps())).toMatchObject({ ok: false, code: 'OTHER_SITE' })
    expect(await completeShopifyConnect(db, { params: params({ code: 'bad-code' }), sessionUserId: OWNER }, builderDeps())).toMatchObject({ ok: false, code: 'LOGIN_REFUSED' })
    shop = fakeShopify({ scopes: ['read_products'] })
    expect(await completeShopifyConnect(db, { params: params(), sessionUserId: OWNER }, builderDeps())).toMatchObject({ ok: false, code: 'CANT_EDIT' })
    expect(tables.website_site).toHaveLength(0)
  })
})

describe('changes by text', () => {
  it('a page: read, edit → card → yes → pageUpdate; then undo puts it back', async () => {
    await connected()
    const read = await startEdit(db, who, { request: 'hours', page: PAGE_GID }, startDeps())
    expect(read).toMatchObject({ success: true, page: { id: PAGE_GID, kind: 'page' }, text: '<p>Open Monday to Friday, 9 to 5.</p>' })
    const out = await startEdit(db, who, { request: 'hours are 8 to 6 now', page: 'About us', edits: [{ find: '9 to 5', replace: '8 to 6' }] }, startDeps())
    expect(out).toMatchObject({ success: true, summary: 'On “About us”: “9 to 5” becomes “8 to 6”.' })
    expect(shop.writes).toEqual([])
    expect(createApproval.mock.calls[0][0].input.yes_does).toContain('I keep the earlier text, so it can be undone')
    expect(await yes()).toMatchObject({ success: true, message: expect.stringContaining('undo_website_change puts it back') })
    expect(shop.writes).toEqual([{ mutation: 'pageUpdate', variables: { id: PAGE_GID, page: { body: '<p>Open Monday to Friday, 8 to 6.</p>', title: 'About us' } } }])
    expect(toChange(changeRow())).toMatchObject({ state: 'live' })

    expect(await startUndo(db, who, {}, startDeps())).toMatchObject({ success: true })
    await yes()
    expect(shop.pages.get(PAGE_GID)!.body).toBe('<p>Open Monday to Friday, 9 to 5.</p>')
  })

  it('a product description, by its id, through productUpdate', async () => {
    await connected()
    await startEdit(db, who, { request: 'four hours', page: PRODUCT_GID, edits: [{ find: 'Three hours', replace: 'Four hours' }] }, startDeps())
    expect(createApproval.mock.calls[0][0].input.yes_does).toContain('to the product on your Shopify site')
    await yes()
    expect(shop.writes).toEqual([{ mutation: 'productUpdate', variables: { product: { id: PRODUCT_GID, descriptionHtml: '<p>Four hours, two cleaners.</p>', title: 'Deep clean' } } }])
  })

  it('Shopify’s refusal fails the change in plain words, and a revoked token says connect again', async () => {
    await connected()
    shop = fakeShopify({ userError: 'Body is too long' })
    await startEdit(db, who, { request: 'x', page: PAGE_GID, edits: [{ find: '9 to 5', replace: '8 to 6' }] }, startDeps())
    expect(await yes()).toMatchObject({ success: false, error: expect.stringContaining('Body is too long') })
    expect(changeRow()).toMatchObject({ state: 'failed' })
    tables.website_site[0].credentials_encrypted = (await import('@/lib/crypto/credentials')).encryptCredential(JSON.stringify({ token: 'revoked' }))
    expect(await startEdit(db, who, { request: 'x', page: PAGE_GID }, startDeps())).toMatchObject({ success: false, code: 'LOGIN_GONE' })
  })
})

describe('a form on a page', () => {
  function seed() {
    dataTables.byId.set(TABLE_ID, { id: TABLE_ID, workspace_id: WS, name: 'Leads', visibility: 'workspace', owner_member_id: null, archived_at: null, kind: 'table', columns: [{ id: 'c1', table_id: TABLE_ID, key: 'email', label: 'Email', field_type: 'email', options: [], config: {}, position: 0, deleted_at: null }] })
    tables.data_form.push({ id: FORM_ID, workspace_id: WS, table_id: TABLE_ID, name: 'Quote request', fields: [{ key: '$title', label: 'Name', required: true }, { key: 'email', label: 'Email', required: true }], access: 'public', allowed_origins: [], thanks: null, active: true, key_hash: 'old-link-hash', key_prefix: 'fk_oldold', created_by: OWNER, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', last_submitted_at: null, bot_check: true })
  }

  it('goes on the page when the store keeps its script', async () => {
    await connected()
    seed()
    expect(await startWiring(db, who, { formId: FORM_ID, page: PAGE_GID }, startDeps())).toMatchObject({ success: true })
    expect(await yes()).toMatchObject({ success: true })
    expect(shop.pages.get(PAGE_GID)!.body).toMatch(/data-ni-form="fk_[A-Za-z0-9_-]{43}"/)
    expect(tables.data_form[0].key_hash).toBe(changeRow().intake_key_hash)
  })

  it('a store that strips the script gets its page back, and the form keeps its link', async () => {
    await connected()
    seed()
    shop = fakeShopify({ stripScripts: true })
    await startWiring(db, who, { formId: FORM_ID, page: PAGE_GID }, startDeps())
    expect(await yes()).toMatchObject({ success: false, code: 'EMBED_STRIPPED' })
    expect(shop.pages.get(PAGE_GID)!.body).toBe('<p>Open Monday to Friday, 9 to 5.</p>')
    expect(tables.data_form[0].key_hash).toBe('old-link-hash')
    expect(changeRow()).toMatchObject({ state: 'failed' })
  })
})
