import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ROADMAP_ISSUES_URL } from '@/lib/roadmap/constants'
import { buildRoadmap, emptyRoadmap } from '@/lib/roadmap/parse'
import { RoadmapTimeline } from '../roadmap-timeline'

// Made-up roadmap issues.
const issues = [
  {
    number: 21,
    title: 'Shared team inbox',
    body: 'One inbox the whole team can work from.\n---\nVoting note that must not show.',
    html_url: 'https://github.com/example/repo/issues/21',
    state: 'open',
    labels: [{ name: 'roadmap' }, { name: 'now' }, { name: 'in progress' }],
    milestone: { title: '2026 Q4' },
    reactions: { '+1': 12, '-1': 3 },
  },
  {
    number: 22,
    title: 'Offline notes',
    body: 'Take notes without a connection.',
    html_url: 'https://github.com/example/repo/issues/22',
    state: 'open',
    labels: [{ name: 'roadmap' }, { name: 'next' }],
    milestone: { title: '2027 Q1' },
    reactions: { '+1': 4, '-1': 0 },
  },
  {
    number: 20,
    title: 'Dark mode',
    body: 'Easy on the eyes.',
    html_url: 'https://github.com/example/repo/issues/20',
    state: 'closed',
    closed_at: '2026-10-01T00:00:00Z',
    labels: [{ name: 'roadmap' }, { name: 'shipped' }],
    milestone: { title: '2026 Q3' },
    reactions: { '+1': 30, '-1': 1 },
  },
]

const render = (data = buildRoadmap(issues)) => renderToStaticMarkup(createElement(RoadmapTimeline, { data }))

describe('RoadmapTimeline', () => {
  it('renders the three columns with their quarters', () => {
    const html = render()
    for (const heading of ['>Now<', '>Next<', '>Later<']) expect(html).toContain(heading)
    expect(html).toContain('2026 Q4')
    expect(html).toContain('2027 Q1')
    // Later has no items: an empty state, not a missing column.
    expect(html).toContain('Nothing here yet.')
  })

  it('renders a card with title, In progress pill, summary, counts and a Vote link', () => {
    const html = render()
    expect(html).toContain('Shared team inbox')
    expect(html).toContain('In progress')
    expect(html).toContain('One inbox the whole team can work from.')
    expect(html).not.toContain('Voting note that must not show.')
    expect(html).toMatch(/>12<\/span><span class="sr-only">votes for/)
    expect(html).toMatch(/>3<\/span><span class="sr-only">votes against/)
    expect(html).toContain('href="https://github.com/example/repo/issues/21"')
    expect(html).toMatch(/>Vote<svg/)
    // Only the in-progress item gets the pill.
    expect(html.match(/In progress/g)).toHaveLength(1)
  })

  it('shows the Shipped section only when something shipped', () => {
    expect(render()).toContain('Shipped')
    expect(render()).toContain('Dark mode')
    const withoutShipped = render(buildRoadmap(issues.filter((i) => i.state === 'open')))
    expect(withoutShipped).not.toContain('Shipped')
  })

  it('shows the GitHub fallback when the roadmap could not be loaded', () => {
    const html = render(emptyRoadmap(false))
    expect(html).toContain('See the roadmap on GitHub')
    expect(html).toContain(`href="${ROADMAP_ISSUES_URL.replace(/&/g, '&amp;')}"`)
    expect(html).not.toContain('>Now<')
  })
})
