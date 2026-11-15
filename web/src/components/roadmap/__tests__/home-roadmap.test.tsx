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
  it('renders the board: Now, Next and Later, each item linked, with what it is', () => {
    const html = render(buildRoadmap(issues))
    expect(html).toContain('What we’re building')
    expect(html).toContain('Vote on what matters to you')
    for (const column of ['>Now<', '>Next<', '>Later<']) expect(html).toContain(column)
    for (const title of ['Shared team inbox', 'Offline notes', 'Calendar sharing', 'Spreadsheet import', 'Kiosk mode']) expect(html).toContain(title)
    expect(html).toContain('href="https://github.com/example/repo/issues/31"')
    expect(html).toContain('href="https://github.com/example/repo/issues/35"')
    expect(html).toContain('Shared team inbox, described.')
    // Only the item being built says so.
    expect(html.match(/In progress/g)).toHaveLength(1)
  })

  it('shows a vote count only where there is one', () => {
    const html = render(buildRoadmap(issues))
    expect(html).toMatch(/>12<\/span><span class="sr-only">votes for/)
    expect(html).toMatch(/>5<\/span><span class="sr-only">votes for/)
    // Three items have votes; the two with none show no count.
    expect(html.match(/votes for<\/span>/g)).toHaveLength(3)
  })

  it('shows a column’s first four and says how many more there are', () => {
    const many = [...issues, ...[41, 42, 43, 44, 45].map((n) => issue(n, `Later item ${n}`, ['later']))]
    const html = render(buildRoadmap(many))
    expect(html).toMatch(/<a href="\/roadmap"[^>]*>and 2 more<\/a>/)
  })

  it('leaves out a column with nothing in it', () => {
    const html = render(buildRoadmap(issues.slice(0, 2)))
    expect(html).toContain('Shared team inbox')
    expect(html).not.toContain('>Next<')
    expect(html).not.toContain('>Later<')
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
