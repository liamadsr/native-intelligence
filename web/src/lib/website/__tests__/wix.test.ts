/**
 * Phase 4 of docs/plans/hosted-site-builders.md, Wix, on an in-memory
 * database and a fake of Wix's APIs: the setting and the app's credentials,
 * the install link, the callback (our state, the signed-in person, the
 * install proven with a token for the instance, the site asked for), a CMS
 * item and a product description changed through the same card and yes, the
 * form on every page (and taken back), what Wix can't do said plainly, and
 * Wix's refusals. Nothing calls a real Wix. Every name is made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryDb } from '@/test/memory-db'

vi.mock('@/lib/chat/cloud-coding-tools', () => ({ startSiteCodingRun: vi.fn() }))
vi.mock('@/lib/safety/approvals', () => ({ createToolApproval: vi.fn() }))
vi.mock('@/lib/chat/home-message-writer', () => ({ appendHomeMessage: vi.fn(async () => ({ written: true, conversationId: 'conv-1' })) }))
vi.mock('@/lib/reach/route', () => ({ requestRoute: vi.fn(async () => undefined) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => undefined) } }))
vi.mock('@/lib/customers/store', () => ({ businessName: vi.fn(async () => 'Example Yoga') }))
vi.mock('@/lib/demo/demo-mode', () => ({ isDemoWorkspace: vi.fn(async () => false), DEMO_OFF: { connector: 'demo' } }))
const dataTables = vi.hoisted(() => ({ byId: new Map<string, Record<string, unknown>>() }))
vi.mock('@/lib/tables/store', () => ({
  getTable: vi.fn(async (_db: unknown, workspaceId: string, tableId: string) => {
    const t = dataTables.byId.get(tableId)
    return t && t.workspace_id === workspaceId ? t : null
  }),
}))

import { completeWixConnect, enabledBuilders, startBuilderConnect, type BuilderDeps } from '../builder'
import { startEdit, startUndo, startWiring } from '../start'
import { mergeWebsiteChange, websiteApprovalPermits } from '../approval'
import { getLiveSite, toChange } from '../store'
import { renderWebsiteSection } from '../section'
import { wixItemText } from '../providers/wix'
import { hashFormKey } from '@/lib/forms/store'
import { renderTextSetupSection } from '@/lib/onboarding/text-setup'
import { MERGE_WEBSITE_CHANGE_TOOL } from '../types'

type Row = Record<string, unknown>

const OWNER = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'
const WS = '00000000-0000-4000-8000-0000000000aa'
const TABLE_ID = '00000000-0000-4000-8000-0000000000b1'
const FORM_ID = '00000000-0000-4000-8000-0000000000f1'
const INSTANCE = '11111111-2222-4333-8444-555555555555'
const PRODUCT = '66666666-7777-4888-9999-000000000000'
const ENV = { WEBSITE_BUILDERS: 'wix', WIX_APP_ID: 'made-up-wix-app-id', WIX_APP_SECRET: 'made-up-wix-app-secret' }
const TOKEN = 'made-up-wix-token'

/** A fake Wix: the token grant, the instance, Stores, Data and the embedded script, with the writes made. */
function fakeWix(opts: { refuseScripts?: boolean } = {}) {
  const product = { id: PRODUCT, name: 'Ten classes', description: '<p>Ten classes, any time.</p>', visible: true, productPageUrl: { base: 'https://exampleyoga.test.site', path: '/product-page/ten-classes' } }
  const item = { id: 'item-1', dataCollectionId: 'Classes', data: { _id: 'item-1', _owner: 'x', title: 'Morning flow', description: 'Gentle, 7am.', spots: 12 } as Record<string, unknown> }
  const script = { formKey: '' }
  const writes: Array<{ path: string; method: string; body: unknown }> = []
  const grants: unknown[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    if (url.origin !== 'https://www.wixapis.com') return json(404, {})
    const body = init?.body ? JSON.parse(String(init.body)) : null
    if (url.pathname === '/oauth2/token') {
      grants.push(body)
      return body.client_secret === ENV.WIX_APP_SECRET && body.instance_id === INSTANCE ? json(200, { access_token: TOKEN, expires_in: 14400 }) : json(401, { message: 'invalid client' })
    }
    if ((init?.headers as Record<string, string>).Authorization !== TOKEN) return json(401, { message: 'unauthorized' })
    if (url.pathname === '/apps/v1/instance') return json(200, { instance: { instanceId: INSTANCE }, site: { url: 'https://exampleyoga.test.site', siteDisplayName: 'Example Yoga' } })
    if (url.pathname === '/stores/v1/products/query') return json(200, { products: [product] })
    if (url.pathname === `/stores/v1/products/${PRODUCT}`) {
      if (method === 'PATCH') {
        writes.push({ path: url.pathname, method, body })
        Object.assign(product, body.product)
      }
      return json(200, { product })
    }
    if (url.pathname === '/wix-data/v2/collections') return json(200, { collections: [{ id: 'Classes', displayName: 'Classes' }, { id: 'Stores/Products', displayName: 'Products' }] })
    if (url.pathname === '/wix-data/v2/items/query') return json(200, { dataItems: body.dataCollectionId === 'Classes' ? [item] : [] })
    if (url.pathname === '/wix-data/v2/items/item-1') {
      if (method === 'PUT') {
        writes.push({ path: url.pathname, method, body })
        item.data = body.dataItem.data
      }
      return json(200, { dataItem: item })
    }
    if (url.pathname === '/apps/v1/scripts') {
      if (method === 'POST') {
        writes.push({ path: url.pathname, method, body })
        if (opts.refuseScripts) return json(400, { message: 'Site must be premium with a connected domain' })
        script.formKey = body.properties.parameters.formKey
      }
      return json(200, { properties: { parameters: script } })
    }
    return json(404, { message: 'not found' })
  }) as typeof fetch
  return { product, item, script, writes, grants, fetchImpl }
}

let tables: Record<string, Row[]>
let db: ReturnType<typeof memoryDb>
let wix: ReturnType<typeof fakeWix>
const createApproval = vi.fn()

const builderDeps = (): BuilderDeps => ({ fetchImpl: wix.fetchImpl, createApproval, env: ENV, now: () => Date.parse('2026-11-27T12:00:00Z') })
const startDeps = () => ({ fetchImpl: wix.fetchImpl, builder: builderDeps() })
const approvalDeps = () => ({ builder: builderDeps(), paused: async () => false })
const who = { userId: OWNER, workspaceId: WS }

beforeEach(() => {
  tables = { website_site: [], website_change: [], data_form: [], member: [{ id: 'm-owner', workspace_id: WS, user_id: OWNER, role: 'owner' }] }
  dataTables.byId.clear()
  db = memoryDb(tables, {
    website_site: (a, b) => a.workspace_id === b.workspace_id && a.state !== 'disconnected' && b.state !== 'disconnected',
    website_change: (a, b) => a.site_id === b.site_id && ['preparing', 'awaiting_yes', 'merging', 'deploying'].includes(String(a.state)) && ['preparing', 'awaiting_yes', 'merging', 'deploying'].includes(String(b.state)),
  })
  wix = fakeWix()
  createApproval.mockReset().mockResolvedValue({ ok: true, approvalId: 'appr-1', cardId: 'card-1' })
})

async function linkState(siteUrl = 'https://exampleyoga.test.site') {
  const out = await startBuilderConnect(db, who, { builder: 'wix', siteUrl }, builderDeps())
  expect(out).toMatchObject({ success: true, builder: 'wix' })
  const link = new URL(String(out.connect_link))
  return { out, link, state: link.searchParams.get('state')! }
}

async function connected() {
  const { state } = await linkState()
  expect(await completeWixConnect(db, { params: new URLSearchParams({ instanceId: INSTANCE, state }), sessionUserId: OWNER }, builderDeps())).toMatchObject({ ok: true })
  return (await getLiveSite(db, WS))!
}

const changeRow = () => tables.website_change[tables.website_change.length - 1]

async function yes() {
  const row = changeRow()
  const ctx = createApproval.mock.calls.at(-1)![0].context.website
  expect(await websiteApprovalPermits(db, { id: 'appr-1', workspace_id: WS, user_id: OWNER, tool: MERGE_WEBSITE_CHANGE_TOOL, context: { website: ctx } })).toBe(true)
  return mergeWebsiteChange(db, { userId: OWNER, workspaceId: WS, changeId: String(row.id), headSha: ctx.headSha }, approvalDeps())
}

function seedForm() {
  dataTables.byId.set(TABLE_ID, { id: TABLE_ID, workspace_id: WS, name: 'Leads', visibility: 'workspace', owner_member_id: null, archived_at: null, kind: 'table', columns: [{ id: 'c1', table_id: TABLE_ID, key: 'email', label: 'Email', field_type: 'email', options: [], config: {}, position: 0, deleted_at: null }] })
  tables.data_form.push({ id: FORM_ID, workspace_id: WS, table_id: TABLE_ID, name: 'Class enquiry', fields: [{ key: '$title', label: 'Name', required: true }, { key: 'email', label: 'Email', required: true }], access: 'public', allowed_origins: [], thanks: null, active: true, key_hash: 'old-link-hash', key_prefix: 'fk_oldold', created_by: OWNER, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', last_submitted_at: null, bot_check: true })
}

describe('the setting and the pure parts', () => {
  it('Wix is on only when named and the app’s two credentials are set', () => {
    expect(enabledBuilders({ WEBSITE_BUILDERS: 'wix' })).toEqual([])
    expect(enabledBuilders({ WEBSITE_BUILDERS: 'wix', WIX_APP_ID: 'x' })).toEqual([])
    expect(enabledBuilders(ENV)).toEqual(['wix'])
  })

  it('a CMS item reads as its own text fields, never Wix’s system fields or numbers', () => {
    expect(wixItemText({ _id: 'a', _owner: 'b', title: 'T', description: 'D', spots: 3 })).toBe('{\n  "description": "D",\n  "title": "T"\n}')
  })
})

describe('connect', () => {
  it('answers our install link and says plainly what Wix allows', async () => {
    const { out, link } = await linkState()
    expect(`${link.origin}${link.pathname}`).toBe('https://www.wix.com/installer/install')
    expect(link.searchParams.get('appId')).toBe('made-up-wix-app-id')
    expect(new URL(link.searchParams.get('redirectUrl')!).pathname).toBe('/api/website/wix/callback')
    expect(String(out.connect_link)).not.toContain(ENV.WIX_APP_SECRET)
    expect(out.message).toContain('Wix allows no app to change the words of a page itself')
  })

  it('the callback proves the install with a token for the instance, and keeps nothing of a person’s', async () => {
    const site = await connected()
    expect(wix.grants).toEqual([{ grant_type: 'client_credentials', client_id: 'made-up-wix-app-id', client_secret: ENV.WIX_APP_SECRET, instance_id: INSTANCE }])
    expect(site).toMatchObject({ provider: 'wix', providerSiteId: INSTANCE, siteUrl: 'https://exampleyoga.test.site' })
    expect(tables.website_site[0].credentials_encrypted).toBeNull()
    const section = renderWebsiteSection(site, null, null)
    expect(section).toContain('Their website: a Wix site "Example Yoga"')
    expect(section).toContain('On Wix no app can change the words of a page itself')
  })

  it('the callback refuses another person, another site, a forged instance and a bad state', async () => {
    const { state } = await linkState()
    expect(await completeWixConnect(db, { params: new URLSearchParams({ instanceId: INSTANCE, state }), sessionUserId: OTHER }, builderDeps())).toMatchObject({ ok: false, code: 'WRONG_PERSON' })
    expect(await completeWixConnect(db, { params: new URLSearchParams({ instanceId: '99999999-2222-4333-8444-555555555555', state }), sessionUserId: OWNER }, builderDeps())).toMatchObject({ ok: false, code: 'LOGIN_REFUSED' })
    expect(await completeWixConnect(db, { params: new URLSearchParams({ instanceId: 'not-an-instance', state }), sessionUserId: OWNER }, builderDeps())).toMatchObject({ ok: false, code: 'NO_PASSWORD' })
    expect(await completeWixConnect(db, { params: new URLSearchParams({ instanceId: INSTANCE, state: 'forged.sig' }), sessionUserId: OWNER }, builderDeps())).toMatchObject({ ok: false, code: 'BAD_STATE' })
    const other = await linkState('https://another.test.site')
    expect(await completeWixConnect(db, { params: new URLSearchParams({ instanceId: INSTANCE, state: other.state }), sessionUserId: OWNER }, builderDeps())).toMatchObject({ ok: false, code: 'OTHER_SITE' })
    expect(tables.website_site).toHaveLength(0)
  })
})

describe('changes by text', () => {
  it('lists only CMS items and products (never Wix’s own collections)', async () => {
    await connected()
    const listed = await startEdit(db, who, { request: 'x' }, startDeps())
    expect(listed).toMatchObject({ success: true })
    expect((listed.pages as Array<{ id: string; kind: string }>).map((p) => [p.kind, p.id])).toEqual([
      ['product', PRODUCT],
      ['cms_item', 'Classes::item-1'],
    ])
  })

  it('a CMS item: edit → card → yes → the item written whole, its other fields kept; then undo', async () => {
    await connected()
    expect(await startEdit(db, who, { request: '8am now', page: 'Classes::item-1', edits: [{ find: '7am', replace: '8am' }] }, startDeps())).toMatchObject({ success: true })
    expect(createApproval.mock.calls[0][0].input.yes_does).toContain('to the item on your Wix site')
    expect(wix.writes).toEqual([])
    expect(await yes()).toMatchObject({ success: true })
    expect(wix.writes).toEqual([{ path: '/wix-data/v2/items/item-1', method: 'PUT', body: { dataCollectionId: 'Classes', dataItem: { id: 'item-1', dataCollectionId: 'Classes', data: { _id: 'item-1', _owner: 'x', title: 'Morning flow', description: 'Gentle, 8am.', spots: 12 } } } }])
    await startUndo(db, who, {}, startDeps())
    await yes()
    expect(wix.item.data.description).toBe('Gentle, 7am.')
    expect(wix.item.data.spots).toBe(12)
  })

  it('an item’s title changes in its text, never as a separate title; a product’s name can', async () => {
    await connected()
    expect(await startEdit(db, who, { request: 'x', page: 'Classes::item-1', title: 'Evening flow' }, startDeps())).toMatchObject({ success: false, code: 'TITLE_IN_TEXT' })
    expect(await startEdit(db, who, { request: 'x', page: 'Classes::item-1', edits: [{ find: '"description"', replace: '"blurb"' }] }, startDeps())).toMatchObject({ success: false, code: 'EDIT_DOESNT_FIT' })
    expect(await startEdit(db, who, { request: 'any day', page: PRODUCT, edits: [{ find: 'any time', replace: 'any day' }], title: 'Ten class pass' }, startDeps())).toMatchObject({ success: true })
    await yes()
    expect(wix.writes).toEqual([{ path: `/stores/v1/products/${PRODUCT}`, method: 'PATCH', body: { product: { description: '<p>Ten classes, any day.</p>', name: 'Ten class pass' } } }])
    expect(toChange(changeRow())).toMatchObject({ state: 'live' })
  })
})

describe('the form on every page', () => {
  it('needs no page: card → yes → the embedded script’s key, the form’s new link, bot check kept; undo takes it off', async () => {
    await connected()
    seedForm()
    expect(await startWiring(db, who, { formId: FORM_ID }, startDeps())).toMatchObject({ success: true, summary: 'Adds your form to every page of your site.' })
    expect(createApproval.mock.calls[0][0].input.yes_does).toContain('Puts this on every page of your Wix site')
    expect(wix.writes).toEqual([])
    expect(await yes()).toMatchObject({ success: true })
    expect(wix.script.formKey).toMatch(/^fk_[A-Za-z0-9_-]{43}$/)
    expect(hashFormKey(wix.script.formKey)).toBe(changeRow().intake_key_hash)
    expect(tables.data_form[0]).toMatchObject({ key_hash: changeRow().intake_key_hash, bot_check: true })
    const site = (await getLiveSite(db, WS))!
    expect(site.inspection?.wirings).toEqual([expect.objectContaining({ intake: 'form', formId: FORM_ID, formPath: 'site_script:site-form' })])

    expect(await startUndo(db, who, {}, startDeps())).toMatchObject({ success: true, summary: 'Puts your site’s form back the way it was before the last change.' })
    await yes()
    expect(wix.script.formKey).toBe('')
    expect((await getLiveSite(db, WS))!.inspection?.wirings ?? []).toEqual([])
  })

  it('a site Wix won’t put scripts on: said plainly, the form keeps its link', async () => {
    await connected()
    seedForm()
    wix = fakeWix({ refuseScripts: true })
    await startWiring(db, who, { formId: FORM_ID }, startDeps())
    expect(await yes()).toMatchObject({ success: false, error: expect.stringContaining('premium') })
    expect(tables.data_form[0].key_hash).toBe('old-link-hash')
  })
})

describe('the onboarding text', () => {
  it('offers Wix honestly when it is on', () => {
    const text = renderTextSetupSection({ startedAt: '2026-11-27T00:00:00Z', name: 'Sam' } as never, { google: null, company: null } as never, { builders: ['wix'] })
    expect(text).toContain('builder "wix"')
    expect(text).toContain('Wix lets no app change a page’s own words')
    expect(text).toContain('(on Wix, on every page)')
    expect(text).toContain('A site on Squarespace, WordPress, Webflow, Shopify, Framer')
  })
})
