/**
 * The website in the app (roadmap track E): the GitHub connector page's
 * routes run the same flow the agent runs by text, on the person's own
 * session. Picking a repo connects it (never as a by-text turn); refusals
 * reach the person in plain words, never the agent's instructions.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readJson } from '@/test/integration'
import type { WebsiteSite } from '@/lib/website/types'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  token: vi.fn(),
  connectWebsite: vi.fn(),
  startWiring: vi.fn(),
  getLiveSite: vi.fn(),
  getOpenChange: vi.fn(),
  recentChanges: vi.fn(),
  listOwnerRepos: vi.fn(),
  rankingHints: vi.fn(),
}))

vi.mock('@/lib/api-auth', () => ({ requireWorkspaceMember: hoisted.requireWorkspace }))
vi.mock('@/lib/website/reconcile', () => ({ reconcileOpenChange: async (_svc: unknown, change: unknown) => change }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ svc: true }) }))
vi.mock('@/lib/oauth/github-token', () => ({ storedGithubToken: hoisted.token }))
vi.mock('@/lib/website/start', () => ({ connectWebsite: hoisted.connectWebsite, startWiring: hoisted.startWiring }))
vi.mock('@/lib/website/store', () => ({ getLiveSite: hoisted.getLiveSite, getOpenChange: hoisted.getOpenChange, recentChanges: hoisted.recentChanges }))
vi.mock('@/lib/website/github', async (orig) => ({ ...(await orig<typeof import('@/lib/website/github')>()), listOwnerRepos: hoisted.listOwnerRepos }))
vi.mock('@/lib/website/repos', async (orig) => ({ ...(await orig<typeof import('@/lib/website/repos')>()), rankingHints: hoisted.rankingHints }))

import { GET, POST } from '../route'
import { GET as REPOS } from '../repos/route'
import { POST as WIRE } from '../wire/route'

const SITE: WebsiteSite = {
  id: 's1',
  workspaceId: 'w1',
  connectedBy: 'u1',
  repoFullName: 'jane/site',
  defaultBranch: 'main',
  projectId: 'p1',
  environmentId: 'e1',
  siteUrl: 'https://janescleaning.com',
  framework: 'nextjs',
  inspection: { framework: 'nextjs', host: 'vercel', siteUrl: null, truncated: false, forms: [{ path: 'app/quote/page.tsx', kind: 'quote', fields: [], submits: 'formspree', target: null, score: 9 }] },
  state: 'connected',
  wiredAt: null,
  createdAt: '2026-11-01T00:00:00Z',
}

const json = (body: unknown) => new Request('https://dial8.ai/api/account/website', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.requireWorkspace.mockResolvedValue({ supabase: {}, user: { id: 'u1' }, workspaceId: 'w1', member: { id: 'm1', role: 'owner' } })
  hoisted.token.mockResolvedValue('gh-token')
  hoisted.getLiveSite.mockResolvedValue(null)
  hoisted.getOpenChange.mockResolvedValue(null)
  hoisted.recentChanges.mockResolvedValue([])
  hoisted.rankingHints.mockResolvedValue({ domain: 'janescleaning.com', businessName: "Jane's Cleaning" })
})

describe('GET /api/account/website', () => {
  it('needs a session', async () => {
    hoisted.requireWorkspace.mockResolvedValue(new Response(null, { status: 401 }))
    expect((await GET()).status).toBe(401)
  })

  it('no site yet: says whether GitHub is connected', async () => {
    expect(await readJson(await GET())).toEqual({ githubConnected: true, canConnect: true, site: null, change: null })
  })

  it('a member who is not an owner or admin may look, not connect', async () => {
    hoisted.requireWorkspace.mockResolvedValue({ supabase: {}, user: { id: 'u2' }, workspaceId: 'w1', member: { id: 'm2', role: 'member' } })
    hoisted.getLiveSite.mockResolvedValue(SITE)
    const body = await readJson<{ canConnect: boolean; site: Record<string, unknown> }>(await GET())
    expect(body.canConnect).toBe(false)
    expect(body.site).toMatchObject({ connectedByYou: false, canRepoint: false })
  })

  it('the site, what reading it found (without the address, which has its own row), and the change in flight', async () => {
    hoisted.getLiveSite.mockResolvedValue(SITE)
    hoisted.getOpenChange.mockResolvedValue({ id: 'c1', kind: 'wire_form', state: 'awaiting_yes', prUrl: 'https://github.com/jane/site/pull/7', previewUrl: 'https://site-git.vercel.app', error: null })
    const body = await readJson<{ site: Record<string, unknown>; change: Record<string, unknown> }>(await GET())
    expect(body.site).toMatchObject({ repo: 'jane/site', siteUrl: 'https://janescleaning.com', wired: false, hasForm: true, hostAddress: false, connectedByYou: true, canRepoint: true })
    expect(body.site.found).toBe("It's built with Next.js and hosted on Vercel. I found your quote form (app/quote/page.tsx): today it sends each one to Formspree, which emails you.")
    expect(body.change).toMatchObject({ state: 'awaiting_yes', open: true, previewUrl: 'https://site-git.vercel.app' })
    expect(String(body.change.status)).toContain('Ready for your yes')
  })
})

describe('POST /api/account/website', () => {
  it('connects the picked repo as the person, never as a by-text turn', async () => {
    hoisted.connectWebsite.mockResolvedValue({ success: true })
    hoisted.getLiveSite.mockResolvedValue(SITE)
    const res = await POST(json({ repo: 'jane/site' }))
    expect(res.status).toBe(200)
    expect(hoisted.connectWebsite).toHaveBeenCalledWith({ svc: true }, { userId: 'u1', workspaceId: 'w1' }, { repo: 'jane/site', siteUrl: null })
    expect((await readJson<{ site: { repo: string } }>(res)).site.repo).toBe('jane/site')
  })

  it('takes the address they typed, as an https site URL', async () => {
    hoisted.connectWebsite.mockResolvedValue({ success: true })
    await POST(json({ repo: 'jane/site', site_url: 'www.JanesCleaning.com/contact' }))
    expect(hoisted.connectWebsite.mock.calls[0][2]).toEqual({ repo: 'jane/site', siteUrl: 'https://www.janescleaning.com' })
  })

  it('refuses a malformed repo or address before anything runs', async () => {
    expect((await POST(json({ repo: 'not a repo' }))).status).toBe(400)
    expect((await POST(json({ repo: 'jane/site', site_url: 'http://10.0.0.1' }))).status).toBe(400)
    expect(hoisted.connectWebsite).not.toHaveBeenCalled()
  })

  it("a refusal reaches the person in plain words, never the agent's instructions", async () => {
    hoisted.connectWebsite.mockResolvedValue({ success: false, code: 'NO_PUSH', error: "Their GitHub account can read jane/site but can't change it. Tell them." })
    const res = await POST(json({ repo: 'jane/site' }))
    expect(res.status).toBe(403)
    const body = await readJson<{ error: string; code: string }>(res)
    expect(body).toMatchObject({ code: 'NO_PUSH', error: 'Your GitHub account can read that repository but can’t change it. Whoever owns it has to give you write access.' })
    expect(body.error).not.toMatch(/tell them|their/i)
  })
})

describe('GET /api/account/website/repos', () => {
  it('the repos they can change, the likeliest website first', async () => {
    const repo = (fullName: string, extra = {}) => ({ fullName, private: true, defaultBranch: 'main', pushedAt: '2026-10-01T00:00:00Z', homepage: null, language: 'TypeScript', description: null, archived: false, fork: false, hasPages: false, canPush: true, ...extra })
    hoisted.listOwnerRepos.mockResolvedValue({ ok: true, value: [repo('jane/api'), repo('jane/thing', { homepage: 'https://janescleaning.com' }), repo('jane/readonly', { canPush: false })] })
    const body = await readJson<{ repos: Array<{ fullName: string; likely: boolean; homepage: string | null }> }>(await REPOS())
    expect(body.repos.map((r) => r.fullName)).toEqual(['jane/thing', 'jane/api'])
    expect(body.repos[0]).toMatchObject({ homepage: 'https://janescleaning.com', likely: true })
  })

  it('needs GitHub', async () => {
    hoisted.token.mockResolvedValue(null)
    const res = await REPOS()
    expect(res.status).toBe(409)
    expect((await readJson<{ code: string }>(res)).code).toBe('NO_GITHUB')
  })
})

describe('POST /api/account/website/wire', () => {
  it('starts the wiring as the person; its pull request merges only on their yes', async () => {
    hoisted.startWiring.mockResolvedValue({ success: true, change_id: 'c1' })
    const res = await WIRE()
    expect(res.status).toBe(200)
    expect(hoisted.startWiring).toHaveBeenCalledWith({ svc: true }, { userId: 'u1', workspaceId: 'w1' }, {})
  })

  it('says why it could not start', async () => {
    hoisted.startWiring.mockResolvedValue({ success: false, code: 'NO_SITE_URL', error: 'Ask them for their live website address first, then call connect_website again with site_url.' })
    const body = await readJson<{ error: string }>(await WIRE())
    expect(body.error).toBe('Add the address customers visit first: the form is checked on the live site.')
  })
})
