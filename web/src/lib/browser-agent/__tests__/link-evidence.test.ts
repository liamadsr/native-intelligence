import { describe, expect, it, vi } from 'vitest'
import { browserLinkEvidence, MAX_BROWSER_LINK_EVIDENCE_BYTES, MAX_BROWSER_EVIDENCE_LINKS } from '../link-evidence'
import { executeBrowserTask, type TaskExecutorPorts } from '../task-executor'
import { compactBrowserTaskResult } from '../task-result-summary'
import type { BrowserObservation } from '../task-contract'

const link = (index: number, overrides: Partial<BrowserObservation['elements'][number]> = {}): BrowserObservation['elements'][number] => ({
  ref: `e${index}`, role: 'link', name: `Result ${index}`, value: '', canType: false, disabled: false,
  sensitive: false, forbidden: false, context: '', destination: `https://example.com/article/${index}`, ...overrides,
})
const observation = (elements: BrowserObservation['elements']): BrowserObservation => ({
  protocol: 'dial8-browser-decision-v1', documentId: 'doc', observationId: 1, interactionEpoch: 0,
  observedAt: Date.now(), url: 'https://example.com/search', title: 'Search results', text: 'Matching results', elements,
})

describe('bounded final observed link evidence', () => {
  it('retains exact labels and HTTP destinations with observed-not-visited provenance', () => {
    const current = observation([link(1, { name: 'A title & exact query', destination: 'https://example.com/a?x=1&y=%2F#part' }),
      link(2, { destination: 'http://other.example/article' })])
    expect(browserLinkEvidence(current)).toEqual({ source: 'final_native_observation', scope: 'visible_link_controls',
      observedAt: current.observedAt, destinationsVisited: false, truncated: false,
      links: current.elements.map(element => ({ name: element.name, url: element.destination })) })
    expect(JSON.stringify(browserLinkEvidence(current))).not.toContain('"ref"')
  })

  it('excludes credentials, executable URLs, ambiguous relative URLs and non-link form destinations', () => {
    const rejected = ['javascript:alert(1)', 'data:text/html,hello', 'file:///tmp/file', '/relative',
      'https://user:secret@example.com', 'https://example.com/has space', 'https://example.com/\npath']
    const current = observation([...rejected.map((destination, i) => link(i, { destination })),
      link(20, { role: 'button' }), link(21, { disabled: true }), link(22, { forbidden: true }), link(23, { name: ' ' }), link(24)])
    expect(browserLinkEvidence(current).links).toEqual([{ name: 'Result 24', url: 'https://example.com/article/24' }])
  })

  it('deduplicates exact destinations and explicitly bounds the returned inventory', () => {
    const current = observation([link(0), link(1, { name: 'Repeated target', destination: link(0).destination }),
      ...Array.from({ length: MAX_BROWSER_EVIDENCE_LINKS + 2 }, (_, i) => link(i + 2))])
    const evidence = browserLinkEvidence(current)
    expect(evidence.links).toHaveLength(MAX_BROWSER_EVIDENCE_LINKS)
    expect(new Set(evidence.links.map(entry => entry.url)).size).toBe(MAX_BROWSER_EVIDENCE_LINKS)
    expect(evidence.truncated).toBe(true)
  })

  it('enforces a UTF-8 byte budget without slicing URLs or hiding shorter later candidates', () => {
    const long = 'https://example.com/' + '文'.repeat(1900)
    const current = observation([link(1, { name: '記事'.repeat(100), destination: long }), link(2),
      link(3, { destination: 'https://example.com/' + '界'.repeat(2100) }), link(4)])
    const evidence = browserLinkEvidence(current)
    expect(evidence.truncated).toBe(true)
    expect(new TextEncoder().encode(JSON.stringify(evidence)).length).toBeLessThanOrEqual(MAX_BROWSER_LINK_EVIDENCE_BYTES)
    expect(evidence.links).toEqual([link(2), link(4)].map(entry => ({ name: entry.name, url: entry.destination })))
    expect(current.elements[0].destination).toBe(long)
  })

  it('marks the native control ceiling conservatively and does not claim whole-page coverage', () => {
    const current = observation(Array.from({ length: 100 }, (_, index) => link(index, { role: 'button' })))
    expect(browserLinkEvidence(current)).toMatchObject({ links: [], scope: 'visible_link_controls', truncated: true })
  })

  it('omits potentially native-truncated URLs while preserving exact destinations below the cap', () => {
    const prefix = 'https://example.com/'
    const below = prefix + 'a'.repeat(3999 - prefix.length)
    const capped = prefix + 'a'.repeat(4000 - prefix.length)
    const evidence = browserLinkEvidence(observation([link(1, { destination: capped }),
      link(2, { destination: below }), link(3)]))
    expect(evidence.truncated).toBe(true)
    expect(evidence.links).toEqual([
      { name: 'Result 2', url: below }, { name: 'Result 3', url: link(3).destination },
    ])
    expect(browserLinkEvidence(observation([link(2, { destination: below })])).truncated).toBe(false)
  })

  it('marks cap-length native labels as possibly truncated without inventing a full title', () => {
    const below = browserLinkEvidence(observation([link(1, { name: 'a'.repeat(299) })]))
    const capped = browserLinkEvidence(observation([link(1, { name: 'a'.repeat(300) })]))
    expect(below.truncated).toBe(false)
    expect(capped.truncated).toBe(true)
    expect(capped.links).toEqual([{ name: 'a'.repeat(300), url: link(1).destination }])
  })

  it('uses the fresh successful completion read and survives parent-result compaction without raw refs', async () => {
    const first = observation([link(1), link(2), link(3)])
    const fresh = { ...first, observationId: 2, observedAt: first.observedAt + 1 }
    const ports: TaskExecutorPorts = {
      signal: new AbortController().signal, deadline: Date.now() + 45000, alive: () => true,
      blockedSites: () => [], approve: async () => false, navigate: async () => {},
      snapshot: vi.fn().mockResolvedValueOnce(first).mockResolvedValue(fresh), act: vi.fn(),
      decide: vi.fn(async () => ({ decision: { status: 'accepted' as const, value: { operation: 'done' as const },
        inferenceId: 'inference', version: 'v10' }, deadline: Date.now() + 45000 })),
    }
    const result = await executeBrowserTask({ goal: 'Show matching results and their links.', goalDriven: true }, ports)
    expect(result).toMatchObject({ status: 'verified', url: fresh.url, linkEvidence: browserLinkEvidence(fresh) })
    expect(ports.snapshot).toHaveBeenCalledTimes(2)
    expect(ports.act).not.toHaveBeenCalled()
    const compact = compactBrowserTaskResult(result)
    expect(compact).toMatchObject({ status: 'verified', url: fresh.url, linkEvidence: result.linkEvidence })
    expect(compact).not.toHaveProperty('trace')
    expect(JSON.stringify(compact)).not.toContain('"ref"')
  })

  it('does not attach verified link evidence to a task that stopped short', async () => {
    const ports: TaskExecutorPorts = {
      signal: new AbortController().signal, deadline: Date.now() + 45000, alive: () => true,
      blockedSites: () => [], approve: async () => false, navigate: async () => {},
      snapshot: async () => observation([link(1)]), act: vi.fn(),
      decide: async () => ({ decision: { status: 'escalate', reason: 'text_unresolved' }, deadline: Date.now() + 45000 }),
    }
    const result = await executeBrowserTask({ goal: 'Show matching results.', goalDriven: true }, ports)
    expect(result.status).toBe('escalate')
    expect(result).not.toHaveProperty('linkEvidence')
    expect(compactBrowserTaskResult(result)).not.toHaveProperty('linkEvidence')
  })
})
