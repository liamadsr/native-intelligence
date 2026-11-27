/**
 * A website on a site builder (roadmap issue #13, migration 724,
 * docs/plans/hosted-site-builders.md) on an in-memory database and a fake
 * WordPress: the setting, the connect link and its callback, reading a page,
 * an edit → its card → the owner's yes → the page written, a page that moved
 * meanwhile, an undo, a form drawn on a page, a stuck write settled, and the
 * refusals. Nothing calls a real WordPress. Every name is made up.
 */
import { randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryDb } from '@/test/memory-db'

vi.mock('@/lib/chat/cloud-coding-tools', () => ({ startSiteCodingRun: vi.fn() }))
vi.mock('@/lib/safety/approvals', () => ({ createToolApproval: vi.fn() }))
vi.mock('@/lib/chat/home-message-writer', () => ({ appendHomeMessage: vi.fn(async () => ({ written: true, conversationId: 'conv-1' })) }))
vi.mock('@/lib/reach/route', () => ({ requestRoute: vi.fn(async () => undefined) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => undefined) } }))
vi.mock('@/lib/customers/store', () => ({ businessName: vi.fn(async () => 'Example Cleaning') }))
vi.mock('@/lib/demo/demo-mode', () => ({ isDemoWorkspace: vi.fn(async () => false), DEMO_OFF: { connector: 'demo' } }))
const dataTables = vi.hoisted(() => ({ byId: new Map<string, Record<string, unknown>>() }))
vi.mock('@/lib/tables/store', () => ({
  getTable: vi.fn(async (_db: unknown, workspaceId: string, tableId: string) => {
    const t = dataTables.byId.get(tableId)
    return t && t.workspace_id === workspaceId ? t : null
  }),
}))

process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64')

import {
  addsCode,
  addedHosts,
  applyTextEdits,
  completeWordpressConnect,
  contentHash,
  enabledBuilders,
  isBuilderShell,
  reconcileBuilderWrite,
  signConnectState,
  startBuilderConnect,
  stagedSummary,
  verifyConnectState,
  type BuilderDeps,
} from '../builder'
import { startEdit, startUndo, startWiring } from '../start'
import { mergeWebsiteChange, websiteApprovalPermits } from '../approval'
import { getLiveSite, missing724, toChange } from '../store'
import { renderWebsiteSection } from '../section'
import { wordpressUrl } from '../providers/wordpress'
import { hashFormKey } from '@/lib/forms/store'
import { MERGE_WEBSITE_CHANGE_TOOL } from '../types'

type Row = Record<string, unknown>

const OWNER = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'
const WS = '00000000-0000-4000-8000-0000000000aa'
const SITE = 'https://examplecleaning.test.site'
const ROOT = `${SITE}/wp-json/`
const TABLE_ID = '00000000-0000-4000-8000-0000000000b1'
const FORM_ID = '00000000-0000-4000-8000-0000000000f1'
const ON = { WEBSITE_BUILDERS: 'wordpress' }

const HOME = '<!-- wp:paragraph --><p>We clean homes Monday to Friday, 9 to 5.</p><!-- /wp:paragraph -->\n<!-- wp:paragraph --><p>Call us at 555-0100.</p><!-- /wp:paragraph -->'

interface WpPage {
  id: number
  title: string
  content: string
  link: string
  modified: string
}

/** A fake WordPress at SITE: its REST index, users/me, pages and posts, and the writes made. */
function fakeWordpress(opts: { appPasswords?: boolean; caps?: Record<string, boolean>; password?: string } = {}) {
  const pages = new Map<number, WpPage>([
    [12, { id: 12, title: 'Home', content: HOME, link: `${SITE}/`, modified: '2026-11-01T00:00:00' }],
    [34, { id: 34, title: 'Get a Quote', content: '<!-- wp:paragraph --><p>Tell us about your home.</p><!-- /wp:paragraph -->', link: `${SITE}/quote/`, modified: '2026-11-01T00:00:00' }],
  ])
  const writes: Array<{ id: number; body: Record<string, unknown>; auth: string | null }> = []
  const calls: string[] = []
  const caps = opts.caps ?? { edit_pages: true, edit_published_pages: true, edit_others_pages: true, unfiltered_html: true }
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null
    calls.push(`${method} ${url.pathname}${url.search}`)
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    const authed = auth === `Basic ${Buffer.from(`admin:${opts.password ?? 'abcd efgh ijkl'}`).toString('base64')}`
    if (url.origin !== SITE) return json(404, {})
    if (url.pathname === '/wp-json/' && method === 'GET') {
      return json(200, {
        name: 'Example Cleaning',
        url: SITE,
        home: SITE,
        namespaces: ['oembed/1.0', 'wp/v2'],
        authentication: opts.appPasswords === false ? [] : { 'application-passwords': { endpoints: { authorization: `${SITE}/wp-admin/authorize-application.php` } } },
      })
    }
    if (!authed) return json(401, { code: 'rest_not_logged_in' })
    if (url.pathname === '/wp-json/wp/v2/users/me') return json(200, { id: 1, name: 'Site Admin', slug: 'admin', capabilities: caps })
    const list = url.pathname.match(/^\/wp-json\/wp\/v2\/(pages|posts)$/)
    if (list) {
      if (list[1] === 'posts') return json(200, [])
      const search = url.searchParams.get('search')?.toLowerCase()
      return json(200, [...pages.values()].filter((p) => !search || p.title.toLowerCase().includes(search)).map((p) => ({ id: p.id, title: { raw: p.title }, link: p.link, status: 'publish' })))
    }
    const one = url.pathname.match(/^\/wp-json\/wp\/v2\/(pages|posts)\/(\d+)$/)
    if (one) {
      const page = one[1] === 'pages' ? pages.get(Number(one[2])) : undefined
      if (!page) return json(404, { code: 'rest_post_invalid_id' })
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { content?: string; title?: string }
        writes.push({ id: page.id, body, auth })
        if (typeof body.content === 'string') page.content = body.content
        if (typeof body.title === 'string') page.title = body.title
        page.modified = '2026-11-27T12:00:00'
      }
      return json(200, { id: page.id, title: { raw: page.title }, content: { raw: page.content }, link: page.link, status: 'publish', modified_gmt: page.modified })
    }
    if (url.pathname.match(/\/revisions$/)) return json(200, [{ id: 900 + writes.length }])
    return json(404, { code: 'rest_no_route' })
  }) as typeof fetch
  return { pages, writes, calls, fetchImpl }
}

let tables: Record<string, Row[]>
let db: ReturnType<typeof memoryDb>
let wp: ReturnType<typeof fakeWordpress>
const createApproval = vi.fn()

function builderDeps(): BuilderDeps {
  return { fetchImpl: wp.fetchImpl, createApproval, env: ON, now: () => Date.parse('2026-11-27T12:00:00Z') }
}
const startDeps = () => ({ fetchImpl: wp.fetchImpl, builder: builderDeps() })
const approvalDeps = () => ({ builder: builderDeps(), paused: async () => false })

beforeEach(() => {
  tables = { website_site: [], website_change: [], data_form: [], member: [{ id: 'm-owner', workspace_id: WS, user_id: OWNER, role: 'owner' }] }
  dataTables.byId.clear()
  db = memoryDb(tables, {
    website_site: (a, b) => a.workspace_id === b.workspace_id && a.state !== 'disconnected' && b.state !== 'disconnected',
    website_change: (a, b) => a.site_id === b.site_id && ['preparing', 'awaiting_yes', 'merging', 'deploying'].includes(String(a.state)) && ['preparing', 'awaiting_yes', 'merging', 'deploying'].includes(String(b.state)),
  })
  wp = fakeWordpress()
  createApproval.mockReset().mockResolvedValue({ ok: true, approvalId: 'appr-1', cardId: 'card-1' })
})

const who = { userId: OWNER, workspaceId: WS }

/** The owner asked for the link, approved on WordPress, and came back signed in. */
async function connected() {
  const out = await startBuilderConnect(db, who, { builder: 'wordpress', siteUrl: SITE }, builderDeps())
  expect(out.success).toBe(true)
  const link = new URL(String(out.connect_link))
  const state = new URL(link.searchParams.get('success_url')!).searchParams.get('state')
  const done = await completeWordpressConnect(db, { state, sessionUserId: OWNER, siteUrl: SITE, userLogin: 'admin', password: 'abcd efgh ijkl' }, builderDeps())
  expect(done.ok).toBe(true)
  return (await getLiveSite(db, WS))!
}

const changeRow = () => tables.website_change[tables.website_change.length - 1]

/** The owner's yes on the newest card, as approvals.ts runs it. */
async function yes() {
  const row = changeRow()
  const ctx = createApproval.mock.calls.at(-1)![0].context.website
  expect(await websiteApprovalPermits(db, { id: 'appr-1', workspace_id: WS, user_id: OWNER, tool: MERGE_WEBSITE_CHANGE_TOOL, context: { website: ctx } })).toBe(true)
  return mergeWebsiteChange(db, { userId: OWNER, workspaceId: WS, changeId: String(row.id), headSha: ctx.headSha }, approvalDeps())
}

describe('the setting', () => {
  it('is off unless WEBSITE_BUILDERS names a builder this build has', () => {
    expect(enabledBuilders({})).toEqual([])
    expect(enabledBuilders({ WEBSITE_BUILDERS: '' })).toEqual([])
    expect(enabledBuilders({ WEBSITE_BUILDERS: ' WordPress , wix' })).toEqual(['wordpress'])
  })

  it('off: connecting a builder site is refused and nothing is read', async () => {
    const out = await startBuilderConnect(db, who, { builder: 'wordpress', siteUrl: SITE }, { ...builderDeps(), env: {} })
    expect(out).toMatchObject({ success: false, code: 'BUILDER_OFF' })
    expect(wp.calls).toEqual([])
  })
})

describe('the pure parts', () => {
  it('applies edits found exactly once, and says why not otherwise', () => {
    expect(applyTextEdits(HOME, [{ find: '9 to 5', replace: '8 to 6' }])).toEqual({ ok: true, body: HOME.replace('9 to 5', '8 to 6') })
    expect(applyTextEdits(HOME, [{ find: 'Saturday', replace: 'x' }])).toMatchObject({ ok: false, error: expect.stringContaining('isn\'t on the page') })
    expect(applyTextEdits(HOME, [{ find: '<p>', replace: '<p class="x">' }])).toMatchObject({ ok: false, error: expect.stringContaining('2 times') })
    expect(applyTextEdits(HOME, [])).toMatchObject({ ok: false })
    // A replacement's $ is text, not a pattern.
    expect(applyTextEdits('price: X', [{ find: 'X', replace: '$& $1' }])).toEqual({ ok: true, body: 'price: $& $1' })
  })

  it('finds added code and outside links', () => {
    expect(addsCode('<p>a</p>', '<p>a</p><script>x</script>')).toBe(true)
    expect(addsCode('<p>a</p>', '<p onclick="x">a</p>')).toBe(true)
    expect(addsCode('<p>a</p>', '<a href="javascript:x">a</a>')).toBe(true)
    expect(addsCode('<p>a</p>', '<p>b</p>')).toBe(false)
    expect(addedHosts('<a href="https://ok.example">', '<a href="https://ok.example"><a href="https://new.example/x">', SITE)).toEqual(['new.example'])
    expect(addedHosts('', `<a href="${SITE}/x">`, SITE)).toEqual([])
  })

  it('says a change in plain words, and tells a page builder’s shell', () => {
    expect(stagedSummary({ ref: { kind: 'page', id: '12', title: 'Home', url: null, status: 'publish' }, edits: [{ find: '<p>9 to 5</p>', replace: '8 to 6' }] }, 'edit')).toBe('On “Home”: “9 to 5” becomes “8 to 6”.')
    expect(isBuilderShell('[et_pb_section]')).toBe(true)
    expect(isBuilderShell(HOME)).toBe(false)
  })

  it('builds REST addresses for both root shapes', () => {
    expect(wordpressUrl(ROOT, 'wp/v2/pages', { context: 'edit' })).toBe(`${SITE}/wp-json/wp/v2/pages?context=edit`)
    expect(wordpressUrl(`${SITE}/?rest_route=/`, 'wp/v2/pages', { context: 'edit' })).toBe(`${SITE}/?rest_route=/wp/v2/pages&context=edit`)
  })

  it('a database without 724 is told apart', () => {
    expect(missing724({ code: '42703', message: 'column website_site.provider does not exist' })).toBe(true)
    expect(missing724({ code: 'PGRST204', message: "Could not find the 'staged' column" })).toBe(true)
    expect(missing724({ code: '42703', message: 'column other does not exist' })).toBe(false)
    expect(missing724(null)).toBe(false)
  })
})

describe('connect', () => {
  it('answers a link to the owner’s own WordPress, with a signed state for our callback', async () => {
    const out = await startBuilderConnect(db, who, { builder: 'wordpress', siteUrl: SITE }, builderDeps())
    expect(out).toMatchObject({ success: true, builder: 'wordpress' })
    const link = new URL(String(out.connect_link))
    expect(`${link.origin}${link.pathname}`).toBe(`${SITE}/wp-admin/authorize-application.php`)
    expect(link.searchParams.get('app_name')).toBe('Native Intelligence')
    const success = new URL(link.searchParams.get('success_url')!)
    expect(success.pathname).toBe('/api/website/wordpress/callback')
    expect(verifyConnectState(success.searchParams.get('state'), Date.parse('2026-11-27T12:10:00Z'))).toMatchObject({ userId: OWNER, workspaceId: WS, apiRoot: ROOT })
    // Expired after half an hour; a tampered one never.
    expect(verifyConnectState(success.searchParams.get('state'), Date.parse('2026-11-27T12:31:00Z'))).toBeNull()
    expect(verifyConnectState(`${success.searchParams.get('state')}x`)).toBeNull()
    expect(tables.website_site).toHaveLength(0)
  })

  it('a site without application passwords, or not WordPress, is said plainly', async () => {
    wp = fakeWordpress({ appPasswords: false })
    expect(await startBuilderConnect(db, who, { builder: 'wordpress', siteUrl: SITE }, builderDeps())).toMatchObject({ success: false, code: 'NOT_WORDPRESS', error: expect.stringContaining('application passwords') })
    expect(await startBuilderConnect(db, who, { builder: 'wordpress', siteUrl: 'https://not-wordpress.example' }, builderDeps())).toMatchObject({ success: false, code: 'NOT_WORDPRESS' })
    expect(await startBuilderConnect(db, who, { builder: 'wordpress', siteUrl: null }, builderDeps())).toMatchObject({ success: false, code: 'NO_SITE_URL' })
  })

  it('only an owner or admin connects', async () => {
    tables.member.push({ id: 'm-2', workspace_id: WS, user_id: OTHER, role: 'member' })
    expect(await startBuilderConnect(db, { userId: OTHER, workspaceId: WS }, { builder: 'wordpress', siteUrl: SITE }, builderDeps())).toMatchObject({ success: false, code: 'NOT_ALLOWED' })
  })

  it('the callback saves the site with the login encrypted, never in plaintext', async () => {
    const site = await connected()
    expect(site).toMatchObject({ provider: 'wordpress', providerSiteId: ROOT, siteUrl: SITE, repoFullName: '', connectedBy: OWNER, state: 'connected' })
    expect(site.inspection?.builder).toEqual({ name: 'Example Cleaning', user: 'Site Admin' })
    const stored = String(tables.website_site[0].credentials_encrypted)
    expect(stored).toMatch(/^v1\./)
    expect(stored).not.toContain('abcd')
    expect(tables.website_site[0]).toMatchObject({ repo_full_name: null, default_branch: null })
  })

  it('the callback refuses another person, another site, a bad state and a login that can’t edit', async () => {
    const out = await startBuilderConnect(db, who, { builder: 'wordpress', siteUrl: SITE }, builderDeps())
    const state = new URL(new URL(String(out.connect_link)).searchParams.get('success_url')!).searchParams.get('state')
    const base = { state, sessionUserId: OWNER, siteUrl: SITE, userLogin: 'admin', password: 'abcd efgh ijkl' }
    expect(await completeWordpressConnect(db, { ...base, sessionUserId: OTHER }, builderDeps())).toMatchObject({ ok: false, code: 'WRONG_PERSON' })
    expect(await completeWordpressConnect(db, { ...base, sessionUserId: null }, builderDeps())).toMatchObject({ ok: false, code: 'WRONG_PERSON' })
    expect(await completeWordpressConnect(db, { ...base, siteUrl: 'https://elsewhere.example' }, builderDeps())).toMatchObject({ ok: false, code: 'OTHER_SITE' })
    expect(await completeWordpressConnect(db, { ...base, state: 'forged.sig' }, builderDeps())).toMatchObject({ ok: false, code: 'BAD_STATE' })
    expect(await completeWordpressConnect(db, { ...base, password: 'wrong' }, builderDeps())).toMatchObject({ ok: false, code: 'LOGIN_REFUSED' })
    wp = fakeWordpress({ caps: { edit_pages: true } })
    expect(await completeWordpressConnect(db, base, builderDeps())).toMatchObject({ ok: false, code: 'CANT_EDIT' })
    // A state signed for another builder's purpose is no state here.
    expect(verifyConnectState(signConnectState({ v: 1, provider: 'wordpress', userId: OWNER, workspaceId: WS, apiRoot: ROOT, exp: 0 }))).toBeNull()
    expect(tables.website_site).toHaveLength(0)
  })
})

describe('an edit by text', () => {
  it('reads the pages, then a page’s text, writing nothing', async () => {
    await connected()
    const list = await startEdit(db, who, { request: 'change the hours' }, startDeps())
    expect(list).toMatchObject({ success: true, pages: expect.arrayContaining([expect.objectContaining({ id: '12', title: 'Home' })]) })
    const read = await startEdit(db, who, { request: 'change the hours', page: 'Home' }, startDeps())
    expect(read).toMatchObject({ success: true, page: { id: '12' }, text: HOME })
    expect(wp.writes).toEqual([])
    expect(tables.website_change).toHaveLength(0)
  })

  it('edit → card (the exact text) → yes → the page written, and the section says so', async () => {
    const site = await connected()
    const out = await startEdit(db, who, { request: 'hours are now 8 to 6', page: '12', edits: [{ find: '9 to 5', replace: '8 to 6' }] }, startDeps())
    expect(out).toMatchObject({ success: true, summary: 'On “Home”: “9 to 5” becomes “8 to 6”.' })
    // Nothing written before the yes.
    expect(wp.writes).toEqual([])
    const row = changeRow()
    expect(row).toMatchObject({ kind: 'edit', state: 'awaiting_yes', approval_id: 'appr-1', request: 'hours are now 8 to 6', pr_number: null })
    const after = HOME.replace('9 to 5', '8 to 6')
    expect(row.head_sha).toBe(contentHash('Home', after))
    const card = createApproval.mock.calls[0][0]
    expect(card).toMatchObject({ toolName: MERGE_WEBSITE_CHANGE_TOOL, sideEffect: 'external-write', userId: OWNER, context: { website: { changeId: row.id, headSha: row.head_sha } } })
    expect(card.input.replaces).toBe('1. “9 to 5” → “8 to 6”')
    expect(card.input.you_asked).toBe('hours are now 8 to 6')

    const done = await yes()
    expect(done).toMatchObject({ success: true, written: true })
    expect(wp.writes).toEqual([{ id: 12, body: { content: after, title: 'Home' }, auth: expect.stringMatching(/^Basic /) }])
    expect(wp.pages.get(12)!.content).toBe(after)
    const live = toChange(changeRow())
    expect(live).toMatchObject({ state: 'live', mergeSha: '901' })
    expect(live.staged?.written).toMatchObject({ revision: '901' })
    // A second yes on the same card writes nothing.
    expect(await mergeWebsiteChange(db, { userId: OWNER, workspaceId: WS, changeId: live.id, headSha: String(row.head_sha) }, approvalDeps())).toMatchObject({ success: false })
    expect(wp.writes).toHaveLength(1)

    const section = renderWebsiteSection((await getLiveSite(db, WS))!, null, live)
    expect(section).toContain('Their website: a WordPress site "Example Cleaning", live at examplecleaning.test.site.')
    expect(section).toContain('change_website with page')
    expect(section).not.toContain('GitHub repo')
    expect(site.provider).toBe('wordpress')
  })

  it('a page changed in WordPress after the card is never overwritten', async () => {
    await connected()
    await startEdit(db, who, { request: 'hours 8 to 6', page: '12', edits: [{ find: '9 to 5', replace: '8 to 6' }] }, startDeps())
    wp.pages.get(12)!.content = `${HOME}<p>Someone else's line.</p>`
    expect(await yes()).toMatchObject({ success: false, code: 'PAGE_MOVED' })
    expect(wp.writes).toEqual([])
    expect(changeRow()).toMatchObject({ state: 'failed' })
  })

  it('refuses code, text not on the page, and a GitHub-only kill switch still holds', async () => {
    await connected()
    expect(await startEdit(db, who, { request: 'x', page: '12', edits: [{ find: 'Call us at 555-0100.', replace: 'Call us<script>steal()</script>' }] }, startDeps())).toMatchObject({ success: false, code: 'NO_CODE' })
    expect(await startEdit(db, who, { request: 'x', page: '12', edits: [{ find: 'open Sundays', replace: 'x' }] }, startDeps())).toMatchObject({ success: false, code: 'EDIT_DOESNT_FIT' })
    expect(tables.website_change).toHaveLength(0)
    await startEdit(db, who, { request: 'hours', page: '12', edits: [{ find: '9 to 5', replace: '8 to 6' }] }, startDeps())
    const row = changeRow()
    const out = await mergeWebsiteChange(db, { userId: OWNER, workspaceId: WS, changeId: String(row.id), headSha: String(row.head_sha) }, { ...approvalDeps(), paused: async () => true })
    expect(out).toMatchObject({ success: false, code: 'AGENT_PAUSED' })
    expect(wp.writes).toEqual([])
  })

  it('one open change at a time, and only the person who connected it', async () => {
    await connected()
    await startEdit(db, who, { request: 'hours', page: '12', edits: [{ find: '9 to 5', replace: '8 to 6' }] }, startDeps())
    expect(await startEdit(db, who, { request: 'phone', page: '12', edits: [{ find: '555-0100', replace: '555-0199' }] }, startDeps())).toMatchObject({ success: false, code: 'OPEN_CHANGE' })
    tables.member.push({ id: 'm-2', workspace_id: WS, user_id: OTHER, role: 'admin' })
    expect(await startEdit(db, { userId: OTHER, workspaceId: WS }, { request: 'x', page: '12', edits: [{ find: '555-0100', replace: '555-0199' }] }, startDeps())).toMatchObject({ success: false, code: 'NOT_CONNECTOR' })
  })
})

describe('undo', () => {
  it('writes back the text the last change replaced, through the same yes', async () => {
    await connected()
    await startEdit(db, who, { request: 'hours', page: '12', edits: [{ find: '9 to 5', replace: '8 to 6' }] }, startDeps())
    await yes()
    const out = await startUndo(db, who, {}, startDeps())
    expect(out).toMatchObject({ success: true, summary: 'Puts the “Home” page back the way it was before the last change.' })
    expect(changeRow()).toMatchObject({ kind: 'revert', state: 'awaiting_yes' })
    expect(wp.writes).toHaveLength(1)
    expect(await yes()).toMatchObject({ success: true })
    expect(wp.pages.get(12)!.content).toBe(HOME)
  })

  it('refuses when the page changed since, or nothing went live', async () => {
    await connected()
    expect(await startUndo(db, who, {}, startDeps())).toMatchObject({ success: false, code: 'NOTHING_TO_UNDO' })
    await startEdit(db, who, { request: 'hours', page: '12', edits: [{ find: '9 to 5', replace: '8 to 6' }] }, startDeps())
    await yes()
    wp.pages.get(12)!.content += '<p>later</p>'
    expect(await startUndo(db, who, {}, startDeps())).toMatchObject({ success: false, code: 'CHANGED_SINCE' })
  })
})

describe('a form on a page', () => {
  function seed(extra: Row = {}) {
    dataTables.byId.set(TABLE_ID, { id: TABLE_ID, workspace_id: WS, name: 'Leads', visibility: 'workspace', owner_member_id: null, archived_at: null, kind: 'table', columns: [{ id: 'c1', table_id: TABLE_ID, key: 'email', label: 'Email', field_type: 'email', options: [], config: {}, position: 0, deleted_at: null }] })
    tables.data_form.push({
      id: FORM_ID,
      workspace_id: WS,
      table_id: TABLE_ID,
      name: 'Quote request',
      fields: [
        { key: '$title', label: 'Name', required: true },
        { key: 'email', label: 'Email', required: true },
        { key: '$files', label: 'Photos', required: false, type: 'file' },
      ],
      access: 'public',
      allowed_origins: [],
      thanks: null,
      active: true,
      key_hash: 'old-link-hash',
      key_prefix: 'fk_oldold',
      created_by: OWNER,
      created_at: '2026-11-01T00:00:00Z',
      updated_at: '2026-11-01T00:00:00Z',
      last_submitted_at: null,
      bot_check: true,
      ...extra,
    })
  }

  it('needs one of their forms and a page; then card → yes → the embed on the page and the form’s new link, bot check kept', async () => {
    await connected()
    expect(await startWiring(db, who, {}, startDeps())).toMatchObject({ success: false, code: 'NEEDS_FORM' })
    seed()
    expect(await startWiring(db, who, { formId: FORM_ID }, startDeps())).toMatchObject({ success: false, code: 'WHICH_PAGE', pages: [expect.objectContaining({ id: '34', title: 'Get a Quote' })] })
    const out = await startWiring(db, who, { formId: FORM_ID, page: 'Get a Quote' }, startDeps())
    expect(out).toMatchObject({ success: true, summary: 'Adds your form to the “Get a Quote” page.' })
    expect(wp.writes).toEqual([])
    const row = changeRow()
    expect(row).toMatchObject({ kind: 'wire_form', state: 'awaiting_yes', form_path: 'page:34', form_kind: 'quote', intake_origins: [SITE, SITE.replace('https://', 'https://www.')] })
    expect(tables.data_form[0].key_hash).toBe('old-link-hash')

    expect(await yes()).toMatchObject({ success: true })
    const body = String(wp.writes[0].body.content)
    expect(body).toContain('<!-- wp:html -->')
    const key = body.match(/data-ni-form="(fk_[A-Za-z0-9_-]+)"/)![1]
    expect(body).toContain('/f/embed.js')
    expect(hashFormKey(key)).toBe(row.intake_key_hash)
    // The form's link is the page's now; the embed runs the bot check, so it stays on.
    expect(tables.data_form[0]).toMatchObject({ key_hash: row.intake_key_hash, bot_check: true, allowed_origins: [SITE, SITE.replace('https://', 'https://www.')] })
    const site = (await getLiveSite(db, WS))!
    expect(site.state).toBe('wired')
    expect(site.inspection?.wirings).toEqual([expect.objectContaining({ intake: 'form', formId: FORM_ID, formPath: 'page:34' })])

    // Wired again: the embed's key is replaced in place, never a second form.
    await startWiring(db, who, { formId: FORM_ID, page: '34' }, startDeps())
    await yes()
    const again = String(wp.writes[1].body.content)
    expect(again.match(/data-ni-form=/g)).toHaveLength(1)
    expect(again).not.toContain(key)
  })

  it('a login without unfiltered_html can’t put a form on a page', async () => {
    await connected()
    seed()
    wp = fakeWordpress({ caps: { edit_pages: true, edit_published_pages: true, edit_others_pages: true } })
    expect(await startWiring(db, who, { formId: FORM_ID, page: '34' }, startDeps())).toMatchObject({ success: false, code: 'CANT_EMBED' })
  })

  it('a members-only form can’t go on a public page', async () => {
    await connected()
    seed({ access: 'members' })
    expect(await startWiring(db, who, { formId: FORM_ID, page: '34' }, startDeps())).toMatchObject({ success: false, code: 'FORM_NOT_PUBLIC' })
  })
})

describe('a write stuck in merging', () => {
  it('is finished when the page reads back as written, else failed', async () => {
    await connected()
    await startEdit(db, who, { request: 'hours', page: '12', edits: [{ find: '9 to 5', replace: '8 to 6' }] }, startDeps())
    const row = changeRow()
    row.state = 'merging'
    wp.pages.get(12)!.content = HOME.replace('9 to 5', '8 to 6')
    expect(await reconcileBuilderWrite(db, toChange(row), builderDeps())).toBeNull()
    expect(changeRow()).toMatchObject({ state: 'live' })

    await startEdit(db, who, { request: 'phone', page: '12', edits: [{ find: '555-0100', replace: '555-0199' }] }, startDeps())
    const next = changeRow()
    next.state = 'merging'
    expect(await reconcileBuilderWrite(db, toChange(next), builderDeps())).toBeNull()
    expect(changeRow()).toMatchObject({ state: 'failed' })
  })
})
