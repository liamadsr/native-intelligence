/**
 * Phase 3 of docs/plans/hosted-site-builders.md on an in-memory database and
 * fakes of Webflow's Data API and WordPress.com's: the setting and each app's
 * credentials, the consent links, the callbacks (our state for that builder,
 * the signed-in person, the code traded server-side, the site the owner asked
 * for), a Webflow CMS item and a WordPress.com page changed through the same
 * card and yes, Webflow's field rules, an undo, and the forms neither can take
 * yet. Nothing calls a real builder. Every name is made up.
 */
import { randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryDb } from '@/test/memory-db'

vi.mock('@/lib/chat/cloud-coding-tools', () => ({ startSiteCodingRun: vi.fn() }))
vi.mock('@/lib/safety/approvals', () => ({ createToolApproval: vi.fn() }))
vi.mock('@/lib/chat/home-message-writer', () => ({ appendHomeMessage: vi.fn(async () => ({ written: true, conversationId: 'conv-1' })) }))
vi.mock('@/lib/reach/route', () => ({ requestRoute: vi.fn(async () => undefined) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => undefined) } }))
vi.mock('@/lib/customers/store', () => ({ businessName: vi.fn(async () => 'Example Studio') }))
vi.mock('@/lib/demo/demo-mode', () => ({ isDemoWorkspace: vi.fn(async () => false), DEMO_OFF: { connector: 'demo' } }))
const dataTables = vi.hoisted(() => ({ byId: new Map<string, Record<string, unknown>>() }))
vi.mock('@/lib/tables/store', () => ({
  getTable: vi.fn(async (_db: unknown, workspaceId: string, tableId: string) => {
    const t = dataTables.byId.get(tableId)
    return t && t.workspace_id === workspaceId ? t : null
  }),
}))

process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64')

import { completeOAuthBuilderConnect, enabledBuilders, signConnectState, startBuilderConnect, type BuilderDeps } from '../builder'
import { startEdit, startUndo, startWiring } from '../start'
import { mergeWebsiteChange, websiteApprovalPermits } from '../approval'
import { getLiveSite, toChange } from '../store'
import { itemFields, itemText, pickWebflowSite } from '../providers/webflow'
import { MERGE_WEBSITE_CHANGE_TOOL } from '../types'

type Row = Record<string, unknown>

const OWNER = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'
const WS = '00000000-0000-4000-8000-0000000000aa'
const TABLE_ID = '00000000-0000-4000-8000-0000000000b1'
const FORM_ID = '00000000-0000-4000-8000-0000000000f1'
const ENV = {
  WEBSITE_BUILDERS: 'webflow,wpcom',
  WEBFLOW_CLIENT_ID: 'made-up-webflow-id',
  WEBFLOW_CLIENT_SECRET: 'made-up-webflow-secret',
  WPCOM_CLIENT_ID: 'made-up-wpcom-id',
  WPCOM_CLIENT_SECRET: 'made-up-wpcom-secret',
}
const WF_TOKEN = 'made-up-webflow-token'
const WP_TOKEN = 'made-up-wpcom-token'
const SITE_ID = 'a'.repeat(24)
const OTHER_SITE_ID = 'b'.repeat(24)
const COL = 'c'.repeat(24)
const ITEM = 'd'.repeat(24)
const BLOG = '555'
const HOME = '<!-- wp:paragraph --><p>Coffee from 7 to 3.</p><!-- /wp:paragraph -->'

/** One fake for both builders, with the writes made and the codes traded. */
function fakes() {
  const item = { id: ITEM, isDraft: false, isArchived: false, lastUpdated: '2026-11-01T00:00:00Z', fieldData: { name: 'Deep clean', slug: 'deep-clean', summary: 'Three hours, two cleaners.', price: 120 } as Record<string, unknown> }
  const page = { id: 12, title: 'Home', content: HOME }
  const writes: Array<{ url: string; method: string; body: unknown; auth: string }> = []
  const traded: unknown[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '')
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    // Webflow
    if (url === 'https://api.webflow.com/oauth/access_token') {
      const body = JSON.parse(String(init?.body))
      traded.push(body)
      return body.code === 'good-code' && body.client_secret === ENV.WEBFLOW_CLIENT_SECRET ? json(200, { access_token: WF_TOKEN, token_type: 'Bearer' }) : json(400, { error: 'invalid_grant' })
    }
    if (url.startsWith('https://api.webflow.com/v2/')) {
      if (auth !== `Bearer ${WF_TOKEN}`) return json(401, { message: 'Not authorized' })
      const path = url.slice('https://api.webflow.com/v2/'.length)
      const site = (id: string, name: string, short: string, custom: string[]) => ({ id, displayName: name, shortName: short, customDomains: custom.map((u) => ({ url: u })) })
      if (path === 'sites') return json(200, { sites: [site(SITE_ID, 'Example Studio', 'example-studio', ['examplestudio.test.site']), site(OTHER_SITE_ID, 'Side Project', 'side-project', [])] })
      if (path === `sites/${SITE_ID}`) return json(200, site(SITE_ID, 'Example Studio', 'example-studio', ['examplestudio.test.site']))
      if (path === `sites/${SITE_ID}/collections`) return json(200, { collections: [{ id: COL, displayName: 'Services' }] })
      if (path === `collections/${COL}`) return json(200, { id: COL, displayName: 'Services' })
      if (path.startsWith(`collections/${COL}/items?`)) return json(200, { items: [item] })
      if (path === `collections/${COL}/items/${ITEM}`) return json(200, item)
      if (path === `collections/${COL}/items/${ITEM}/live` && method === 'PATCH') {
        const body = JSON.parse(String(init?.body)) as { fieldData: Record<string, unknown> }
        writes.push({ url, method, body, auth })
        Object.assign(item.fieldData, body.fieldData)
        return json(200, { ...item, lastUpdated: '2026-11-27T12:00:00Z' })
      }
      return json(404, { message: 'Requested resource not found' })
    }
    // WordPress.com
    if (url === 'https://public-api.wordpress.com/oauth2/token') {
      const body = new URLSearchParams(String(init?.body))
      traded.push(Object.fromEntries(body))
      return body.get('code') === 'good-code' && body.get('client_secret') === ENV.WPCOM_CLIENT_SECRET ? json(200, { access_token: WP_TOKEN, blog_id: Number(BLOG), blog_url: 'https://examplecafe.test.site', token_type: 'bearer' }) : json(400, { error: 'invalid_request' })
    }
    if (url.startsWith('https://public-api.wordpress.com/')) {
      if (auth !== `Bearer ${WP_TOKEN}`) return json(403, { code: 'unauthorized' })
      const u = new URL(url)
      if (u.pathname === `/rest/v1.1/sites/${BLOG}`) return json(200, { name: 'Example Cafe', URL: 'https://examplecafe.test.site', capabilities: { edit_pages: true, edit_others_pages: true, unfiltered_html: false } })
      if (u.pathname === `/wp/v2/sites/${BLOG}/pages`) return json(200, [{ id: page.id, title: { raw: page.title }, link: 'https://examplecafe.test.site/', status: 'publish' }])
      if (u.pathname === `/wp/v2/sites/${BLOG}/posts`) return json(200, [])
      if (u.pathname === `/wp/v2/sites/${BLOG}/pages/12`) {
        if (method === 'POST') {
          const body = JSON.parse(String(init?.body)) as { content: string; title: string }
          writes.push({ url, method, body, auth })
          page.content = body.content
          page.title = body.title
        }
        return json(200, { id: page.id, title: { raw: page.title }, content: { raw: page.content }, link: 'https://examplecafe.test.site/', status: 'publish', modified_gmt: '2026-11-27T12:00:00' })
      }
      if (u.pathname === `/wp/v2/sites/${BLOG}/pages/12/revisions`) return json(200, [{ id: 77 }])
      return json(404, { code: 'rest_no_route' })
    }
    return json(404, {})
  }) as typeof fetch
  return { item, page, writes, traded, fetchImpl }
}

let tables: Record<string, Row[]>
let db: ReturnType<typeof memoryDb>
let world: ReturnType<typeof fakes>
const createApproval = vi.fn()

const builderDeps = (): BuilderDeps => ({ fetchImpl: world.fetchImpl, createApproval, env: ENV, now: () => Date.parse('2026-11-27T12:00:00Z') })
const startDeps = () => ({ fetchImpl: world.fetchImpl, builder: builderDeps() })
const approvalDeps = () => ({ builder: builderDeps(), paused: async () => false })
const who = { userId: OWNER, workspaceId: WS }

beforeEach(() => {
  tables = { website_site: [], website_change: [], data_form: [], member: [{ id: 'm-owner', workspace_id: WS, user_id: OWNER, role: 'owner' }] }
  dataTables.byId.clear()
  db = memoryDb(tables, {
    website_site: (a, b) => a.workspace_id === b.workspace_id && a.state !== 'disconnected' && b.state !== 'disconnected',
    website_change: (a, b) => a.site_id === b.site_id && ['preparing', 'awaiting_yes', 'merging', 'deploying'].includes(String(a.state)) && ['preparing', 'awaiting_yes', 'merging', 'deploying'].includes(String(b.state)),
  })
  world = fakes()
  createApproval.mockReset().mockResolvedValue({ ok: true, approvalId: 'appr-1', cardId: 'card-1' })
})

async function linkState(builder: 'webflow' | 'wpcom', siteUrl: string): Promise<{ link: URL; state: string }> {
  const out = await startBuilderConnect(db, who, { builder, siteUrl }, builderDeps())
  expect(out).toMatchObject({ success: true, builder })
  const link = new URL(String(out.connect_link))
  return { link, state: link.searchParams.get('state')! }
}

async function connect(builder: 'webflow' | 'wpcom', siteUrl: string) {
  const { state } = await linkState(builder, siteUrl)
  const done = await completeOAuthBuilderConnect(db, builder, { params: new URLSearchParams({ code: 'good-code', state }), sessionUserId: OWNER }, builderDeps())
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

describe('the setting', () => {
  it('each is on only when named and its app’s two credentials are set', () => {
    expect(enabledBuilders({ WEBSITE_BUILDERS: 'webflow,wpcom' })).toEqual([])
    expect(enabledBuilders({ WEBSITE_BUILDERS: 'webflow', WEBFLOW_CLIENT_ID: 'x' })).toEqual([])
    expect(enabledBuilders(ENV)).toEqual(['webflow', 'wpcom'])
    expect(enabledBuilders({ ...ENV, WPCOM_CLIENT_SECRET: '' })).toEqual(['webflow'])
  })
})

describe('Webflow', () => {
  it('the pure parts: an item as its text fields, the edit kept to them, the site by its address', () => {
    expect(itemText({ name: 'A', slug: 'a', summary: 'B', price: 3 })).toBe('{\n  "name": "A",\n  "summary": "B"\n}')
    expect(itemFields('{"name":"A"}', '{"name":"B"}')).toEqual({ ok: true, fields: { name: 'B' } })
    expect(itemFields('{"name":"A"}', '{"name":"A","extra":"x"}')).toMatchObject({ ok: false })
    expect(itemFields('{"name":"A"}', '{"name":"A"')).toMatchObject({ ok: false })
    const sites = [{ id: SITE_ID, name: 'S', hosts: ['examplestudio.test.site', 'example-studio.webflow.io'] }, { id: OTHER_SITE_ID, name: 'O', hosts: ['side.webflow.io'] }]
    expect(pickWebflowSite(sites, 'https://www.examplestudio.test.site')?.id).toBe(SITE_ID)
    expect(pickWebflowSite(sites, 'https://elsewhere.test.site')).toBeNull()
    expect(pickWebflowSite([sites[1]], 'https://elsewhere.test.site')?.id).toBe(OTHER_SITE_ID)
  })

  it('connect: Webflow’s consent link, then the callback trades the code and picks the site asked for', async () => {
    const { link } = await linkState('webflow', 'https://examplestudio.test.site')
    expect(`${link.origin}${link.pathname}`).toBe('https://webflow.com/oauth/authorize')
    expect(link.searchParams.get('scope')).toBe('sites:read cms:read cms:write')
    expect(new URL(link.searchParams.get('redirect_uri')!).pathname).toBe('/api/website/webflow/callback')
    const site = await connect('webflow', 'https://examplestudio.test.site')
    expect(site).toMatchObject({ provider: 'webflow', providerSiteId: SITE_ID, siteUrl: 'https://examplestudio.test.site' })
    expect(world.traded).toEqual([expect.objectContaining({ client_id: 'made-up-webflow-id', code: 'good-code', grant_type: 'authorization_code' })])
    expect(String(tables.website_site[0].credentials_encrypted)).not.toContain(WF_TOKEN)
  })

  it('the callback refuses another person, a site not among those approved, and another builder’s state', async () => {
    const { state } = await linkState('webflow', 'https://elsewhere.test.site')
    expect(await completeOAuthBuilderConnect(db, 'webflow', { params: new URLSearchParams({ code: 'good-code', state }), sessionUserId: OTHER }, builderDeps())).toMatchObject({ ok: false, code: 'WRONG_PERSON' })
    expect(await completeOAuthBuilderConnect(db, 'webflow', { params: new URLSearchParams({ code: 'good-code', state }), sessionUserId: OWNER }, builderDeps())).toMatchObject({ ok: false, code: 'OTHER_SITE' })
    const wpState = signConnectState({ v: 1, provider: 'wpcom', userId: OWNER, workspaceId: WS, apiRoot: 'https://examplestudio.test.site', exp: Date.parse('2026-11-27T13:00:00Z') })
    expect(await completeOAuthBuilderConnect(db, 'webflow', { params: new URLSearchParams({ code: 'good-code', state: wpState }), sessionUserId: OWNER }, builderDeps())).toMatchObject({ ok: false, code: 'BAD_STATE' })
    expect(tables.website_site).toHaveLength(0)
  })

  it('a CMS item: read as its fields, edit → card → yes → its live update; then undo', async () => {
    await connect('webflow', 'https://examplestudio.test.site')
    const ref = `${COL}:${ITEM}`
    const read = await startEdit(db, who, { request: 'four hours', page: ref }, startDeps())
    expect(read).toMatchObject({ success: true, page: { id: ref, kind: 'cms_item', title: 'Deep clean (Services)' } })
    expect(read.text).toBe('{\n  "name": "Deep clean",\n  "summary": "Three hours, two cleaners."\n}')
    expect(await startEdit(db, who, { request: 'four hours', page: ref, edits: [{ find: 'Three hours', replace: 'Four hours' }] }, startDeps())).toMatchObject({ success: true })
    expect(world.writes).toEqual([])
    expect(await yes()).toMatchObject({ success: true })
    expect(world.writes).toEqual([{ url: `https://api.webflow.com/v2/collections/${COL}/items/${ITEM}/live`, method: 'PATCH', body: { fieldData: { name: 'Deep clean', summary: 'Four hours, two cleaners.' } }, auth: `Bearer ${WF_TOKEN}` }])
    // Fields that aren't text (a price) and the slug are never written.
    expect(world.item.fieldData).toMatchObject({ price: 120, slug: 'deep-clean', summary: 'Four hours, two cleaners.' })
    expect(toChange(changeRow())).toMatchObject({ state: 'live' })
    await startUndo(db, who, {}, startDeps())
    await yes()
    expect(world.item.fieldData.summary).toBe('Three hours, two cleaners.')
  })

  it('the item’s name changes in its text, never as a separate title; an edit that breaks the fields is refused', async () => {
    await connect('webflow', 'https://examplestudio.test.site')
    const ref = `${COL}:${ITEM}`
    expect(await startEdit(db, who, { request: 'x', page: ref, edits: [{ find: '"summary"', replace: '"blurb"' }] }, startDeps())).toMatchObject({ success: false, code: 'EDIT_DOESNT_FIT' })
    expect(await startEdit(db, who, { request: 'x', page: ref, edits: [{ find: 'two cleaners.', replace: 'two cleaners."' }] }, startDeps())).toMatchObject({ success: false, code: 'EDIT_DOESNT_FIT' })
    expect(await startEdit(db, who, { request: 'x', page: ref, title: 'New name' }, startDeps())).toMatchObject({ success: false, code: 'TITLE_IN_TEXT' })
    expect(await startEdit(db, who, { request: 'rename', page: ref, edits: [{ find: '"Deep clean"', replace: '"Full clean"' }] }, startDeps())).toMatchObject({ success: true })
    await yes()
    expect(world.item.fieldData.name).toBe('Full clean')
    expect(toChange(changeRow())).toMatchObject({ state: 'live' })
  })

  it('a form can’t go on a Webflow page yet, in plain words', async () => {
    await connect('webflow', 'https://examplestudio.test.site')
    seedForm()
    expect(await startWiring(db, who, { formId: FORM_ID, page: `${COL}:${ITEM}` }, startDeps())).toMatchObject({ success: false, code: 'CANT_EMBED', error: expect.stringContaining('Embed element') })
  })
})

describe('WordPress.com', () => {
  it('connect: the consent link, then the callback trades the code for the one site’s token', async () => {
    const { link } = await linkState('wpcom', 'https://examplecafe.test.site')
    expect(`${link.origin}${link.pathname}`).toBe('https://public-api.wordpress.com/oauth2/authorize')
    expect(new URL(link.searchParams.get('redirect_uri')!).pathname).toBe('/api/website/wpcom/callback')
    const site = await connect('wpcom', 'https://examplecafe.test.site')
    expect(site).toMatchObject({ provider: 'wpcom', providerSiteId: BLOG, siteUrl: 'https://examplecafe.test.site' })
    expect(world.traded).toEqual([expect.objectContaining({ client_id: 'made-up-wpcom-id', code: 'good-code', grant_type: 'authorization_code' })])
  })

  it('a token for another site than the one asked for is refused', async () => {
    const { state } = await linkState('wpcom', 'https://another.test.site')
    expect(await completeOAuthBuilderConnect(db, 'wpcom', { params: new URLSearchParams({ code: 'good-code', state }), sessionUserId: OWNER }, builderDeps())).toMatchObject({ ok: false, code: 'OTHER_SITE' })
  })

  it('a page through WordPress.com’s own wp/v2 routes, with the token; its revisions kept', async () => {
    await connect('wpcom', 'https://examplecafe.test.site')
    await startEdit(db, who, { request: 'hours', page: '12', edits: [{ find: '7 to 3', replace: '7 to 4' }] }, startDeps())
    expect(createApproval.mock.calls[0][0].input.yes_does).toContain('WordPress.com keeps the earlier version')
    expect(await yes()).toMatchObject({ success: true })
    expect(world.writes).toEqual([{ url: `https://public-api.wordpress.com/wp/v2/sites/${BLOG}/pages/12`, method: 'POST', body: { content: HOME.replace('7 to 3', '7 to 4'), title: 'Home' }, auth: `Bearer ${WP_TOKEN}` }])
    expect(toChange(changeRow())).toMatchObject({ state: 'live', mergeSha: '77' })
  })

  it('a site whose plan keeps no scripts can’t take a form', async () => {
    await connect('wpcom', 'https://examplecafe.test.site')
    seedForm()
    expect(await startWiring(db, who, { formId: FORM_ID, page: '12' }, startDeps())).toMatchObject({ success: false, code: 'CANT_EMBED' })
  })
})

function seedForm() {
  dataTables.byId.set(TABLE_ID, { id: TABLE_ID, workspace_id: WS, name: 'Leads', visibility: 'workspace', owner_member_id: null, archived_at: null, kind: 'table', columns: [{ id: 'c1', table_id: TABLE_ID, key: 'email', label: 'Email', field_type: 'email', options: [], config: {}, position: 0, deleted_at: null }] })
  tables.data_form.push({ id: FORM_ID, workspace_id: WS, table_id: TABLE_ID, name: 'Quote request', fields: [{ key: '$title', label: 'Name', required: true }, { key: 'email', label: 'Email', required: true }], access: 'public', allowed_origins: [], thanks: null, active: true, key_hash: 'old-link-hash', key_prefix: 'fk_oldold', created_by: OWNER, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', last_submitted_at: null, bot_check: true })
}
