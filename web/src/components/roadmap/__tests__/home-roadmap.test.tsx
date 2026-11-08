import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ROADMAP_SUGGEST_URL } from '@/lib/roadmap/constants'
import { buildRoadmap, emptyRoadmap, type GitHubIssue, type RoadmapData } from '@/lib/roadmap/parse'
import { HomeRoadmap } from '../home-roadmap'

// Made-up roadmap issues.
function issue(number: number, title: string, labels: string[], up = 0): GitHubIssue {
  return {
    number,
    title,
    body: `${title}, described.`,
    html_url: `https://github.com/example/repo/issues/${number}`,
    state: 'open',
    labels: ['roadmap', ...labels].map((name) => ({ name })),
    milestone: null,
    reactions: { '+1': up, '-1': 0 },
  }
}

const issues: GitHubIssue[] = [
  issue(31, 'Shared team inbox', ['now', 'in progress'], 12),
  issue(32, 'Offline notes', ['now'], 5),
  issue(33, 'Calendar sharing', ['next'], 2),
  issue(34, 'Spreadsheet import', ['next']),
  issue(35, 'Kiosk mode', ['later']),
]

const render = (data: RoadmapData) => renderToStaticMarkup(createElement(HomeRoadmap, { data }))
const attr = (url: string) => url.replace(/&/g, '&amp;')

describe('HomeRoadmap', () => {
  it('renders the Now items as linked cards with the pill and vote count', () => {
    const html = render(buildRoadmap(issues))
    expect(html).toContain('What we’re building')
    expect(html).toContain('Vote on what matters to you')
    expect(html).toContain('Shared team inbox')
    expect(html).toContain('Offline notes')
    expect(html).toContain('href="https://github.com/example/repo/issues/31"')
    expect(html).toContain('href="https://github.com/example/repo/issues/32"')
    expect(html).toMatch(/>12<\/span><span class="sr-only">votes for/)
    expect(html).toMatch(/>5<\/span><span class="sr-only">votes for/)
    // Only the in-progress item gets the pill.
    expect(html.match(/In progress/g)).toHaveLength(1)
    // Next and Later items are counted, not shown.
    expect(html).not.toContain('Calendar sharing')
    expect(html).not.toContain('Kiosk mode')
  })

  it('counts Next and Later in one line linking to /roadmap', () => {
    const html = render(buildRoadmap(issues))
    expect(html).toMatch(/<a href="\/roadmap"[^>]*>and 3 more up next<\/a>/)
  })

  it('leaves out the "more" line when nothing comes after Now', () => {
    const html = render(buildRoadmap(issues.slice(0, 2)))
    expect(html).toContain('Shared team inbox')
    expect(html).not.toContain('more up next')
  })

  it('links to the full roadmap and the feature request form', () => {
    const html = render(buildRoadmap(issues))
    expect(html).toMatch(/<a href="\/roadmap"[^>]*>See the full roadmap<\/a>/)
    expect(html).toContain(`href="${attr(ROADMAP_SUGGEST_URL)}"`)
    expect(html).toMatch(/>Suggest a feature<svg/)
  })

  it('renders nothing when the roadmap could not be loaded', () => {
    expect(render(emptyRoadmap(false))).toBe('')
  })

  it('renders nothing when there are no Now items', () => {
    expect(render(emptyRoadmap(true))).toBe('')
    expect(render(buildRoadmap(issues.slice(2)))).toBe('')
  })
})
