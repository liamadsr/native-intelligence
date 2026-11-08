/**
 * The website as the app shows it (roadmap track E): the change worth
 * showing, in plain words, and a host's own address flagged.
 */
import { describe, expect, it } from 'vitest'
import { changeView, siteView, websiteView } from '../view'
import type { WebsiteChange, WebsiteSite } from '../types'

const SITE = {
  id: 's1', workspaceId: 'w1', connectedBy: 'u1', repoFullName: 'jane/site', defaultBranch: 'main', projectId: null, environmentId: null,
  siteUrl: 'https://janes-cleaning.vercel.app', framework: 'nextjs', state: 'connected', wiredAt: null, createdAt: 'x',
  inspection: { framework: 'nextjs', host: 'vercel', siteUrl: null, truncated: false, forms: [{ path: 'src/components/Quote.tsx', kind: 'quote', fields: [], submits: 'dial8', target: null, score: 9 }] },
} as WebsiteSite

const ME = { userId: 'u1', role: 'owner' }

const change = (extra: Partial<WebsiteChange>) => ({ kind: 'edit', state: 'preparing', prUrl: null, previewUrl: 'https://p.vercel.app', error: null, ...extra }) as WebsiteChange

describe('website view', () => {
  it("flags a host's own address, and a form already posting to Native Intelligence has nothing to connect", () => {
    expect(siteView(SITE, ME)).toMatchObject({ hostAddress: true, hasForm: false, wired: false })
    expect(siteView(SITE, ME).found).not.toContain('live site is')
  })

  it('who may do what: the connector makes changes; an owner or admin may re-point it', () => {
    expect(siteView(SITE, ME)).toMatchObject({ connectedByYou: true, canRepoint: true })
    expect(siteView(SITE, { userId: 'u2', role: 'admin' })).toMatchObject({ connectedByYou: false, canRepoint: true })
    expect(siteView(SITE, { userId: 'u2', role: 'member' })).toMatchObject({ connectedByYou: false, canRepoint: false })
  })

  it("a preview only while it waits for a yes; a failure never shows its raw error (the agent's words, a run's own)", () => {
    expect(changeView(change({ state: 'preparing' }))).toMatchObject({ open: true, previewUrl: null })
    expect(changeView(change({ state: 'awaiting_yes' }))).toMatchObject({ open: true, previewUrl: 'https://p.vercel.app' })
    expect(changeView(change({ state: 'failed', error: 'not a usable cloud environment: Pick a shared one.' })).status).toBe('It didn’t work, and nothing on your site changed. Your agent told you why in your chat.')
  })

  it('shows the open change, else only a last one that failed', () => {
    expect(websiteView({ githubConnected: true, canConnect: true, viewer: ME, site: SITE, open: null, last: change({ state: 'live' }) }).change).toBeNull()
    expect(websiteView({ githubConnected: true, canConnect: true, viewer: ME, site: SITE, open: null, last: change({ state: 'failed' }) }).change?.state).toBe('failed')
    expect(websiteView({ githubConnected: true, canConnect: true, viewer: ME, site: SITE, open: change({ state: 'merging' }), last: change({ state: 'failed' }) }).change?.state).toBe('merging')
  })
})
