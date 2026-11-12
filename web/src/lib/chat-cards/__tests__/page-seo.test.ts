/**
 * SEO's Site audit as a `/` page (the `seo` feature): declared once after the
 * outreach pages, found by its words, gated with the `seo` view every SEO
 * page shares, opened by openTarget and the `?page=` deep link; a card only
 * the person opens (show doesn't offer it), whose read_card points the agent
 * at the audit tools and names the audit it is on.
 */
import { describe, expect, it } from 'vitest'
import { getEdition, withEffectiveSurface } from '@/lib/editions/manifest'
import { CARD_PAGES, filterPages, pagesFor } from '../page-menu'
import { cardForTarget, pageDeepLink } from '../open-card'
import { isCardSpec } from '../kinds'
import { PAGE_KINDS, PLACE_NOUN, SHOW_PAGE_KIND_NAMES, isPageCardSpec, pageTab } from '../pages'
import { buildCardContextEntry, parseCardContext } from '../context'
import { pageTools, seededWorkspace } from './page-fixtures'

const NOW = new Date('2026-11-12T15:00:00Z')
const AUDIT = '3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c'

describe('the Site audit page', () => {
  it('is declared once, right after the outreach pages, opening the seo_audit card', () => {
    const pages = CARD_PAGES.filter((p) => p.slug === 'seo-audit')
    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({ label: 'Site audit', description: 'Check your website for search problems', kind: 'seo_audit', view: 'seo' })
    expect(pages[0].personalTool).toBeUndefined()
    const slugs = CARD_PAGES.map((p) => p.slug)
    expect(slugs.indexOf('seo-audit')).toBe(slugs.indexOf('campaigns') + 1)
    expect(pages[0].spec(NOW)).toEqual({ kind: 'seo_audit', title: 'Site audit' })
    expect(isCardSpec(pages[0].spec(NOW))).toBe(true)
  })

  it('is offered where SEO is on, and found by its words', () => {
    const offered = pagesFor(getEdition('full'), { desktop: false, now: NOW })
    expect(offered.map((p) => p.slug)).toContain('seo-audit')
    for (const q of ['seo', 'site', 'audit', 'crawl', 'broken', 'search']) expect(filterPages(offered, q).map((p) => p.slug), q).toContain('seo-audit')
    const off = withEffectiveSurface(getEdition('full'), { seo: 'off' })
    expect(pagesFor(off, { desktop: false, now: NOW }).map((p) => p.slug)).not.toContain('seo-audit')
  })

  it('opens from anywhere as its card, and has a deep link', () => {
    expect(cardForTarget({ type: 'page', slug: 'seo-audit' }, NOW)).toEqual({ spec: { kind: 'seo_audit', title: 'Site audit' } })
    expect(pageDeepLink('seo-audit')).toBe('/account?page=seo-audit')
  })

  it('is the person’s to open, with one audit as its place and Findings and Pages as its tabs', () => {
    expect(PAGE_KINDS.seo_audit).toMatchObject({ label: 'Site audit', rows: 'audits', view: 'seo', personOnly: true, tabs: ['findings', 'pages'] })
    expect((SHOW_PAGE_KIND_NAMES as readonly string[]).includes('seo_audit')).toBe(false)
    expect(PLACE_NOUN.seo_audit).toBe('site audit')
    expect(pageTab('seo_audit', undefined)).toBe('findings')
    expect(pageTab('seo_audit', 'pages')).toBe('pages')
    expect(isPageCardSpec({ kind: 'seo_audit', title: 'Site audit', tab: 'pages' })).toBe(true)
    expect(isPageCardSpec({ kind: 'seo_audit', title: 'Site audit', tab: 'keywords' })).toBe(false)
  })
})

describe('the Site audit card and the agent', () => {
  it('is never shown by the agent', async () => {
    const out = await pageTools(seededWorkspace()).show({ kind: 'seo_audit' as never, title: 'Site audit' })
    expect(out.success).toBe(false)
  })

  it('read_card points at the audit tools, and names the audit and tab it is on', async () => {
    const top = parseCardContext([buildCardContextEntry({ n: 1, id: 'c1', spec: { kind: 'seo_audit', title: 'Site audit' } })])
    const index = await pageTools(seededWorkspace(), top).readCard({ card: 1 })
    expect(index).toMatchObject({ success: true, card: 1, title: 'Site audit' })
    expect(index.audit_id).toBeUndefined()
    for (const tool of ['list_site_audits', 'get_site_audit', 'get_site_audit_issues', 'get_site_audit_pages']) expect(String(index.note), tool).toContain(tool)

    const one = parseCardContext([
      buildCardContextEntry({ n: 2, id: 'c2', spec: { kind: 'seo_audit', title: 'Site audit' }, at: { type: 'seo_audit', id: AUDIT, label: 'fernhillstudio.example' }, tab: 'pages' }),
    ])
    const read = await pageTools(seededWorkspace(), one).readCard({ card: 2 })
    expect(read).toMatchObject({ success: true, card: 2, audit_id: AUDIT, tab: 'pages' })
  })

  it('read_card refuses where SEO is off', async () => {
    const parsed = parseCardContext([buildCardContextEntry({ n: 1, id: 'c1', spec: { kind: 'seo_audit', title: 'Site audit' } })])
    const read = await pageTools(seededWorkspace({ seo: 'off' }), parsed).readCard({ card: 1 })
    expect(read).toMatchObject({ success: false, code: 'PAGE_OFF' })
  })
})
