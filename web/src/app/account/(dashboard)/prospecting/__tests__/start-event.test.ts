// @vitest-environment jsdom
/**
 * PACKAGE B — the Prospecting → Scout handoff event.
 *
 * The Prospecting page and the chat strip live in different subtrees, so the
 * page dispatches a window event that dashboard-shell forwards to the active
 * tab's ChatPanel — the same shape as the five dispatch/listen pairs already in
 * the shell. This module owns the name, the payload and the dispatcher so the
 * two sides can't drift; these tests pin all three.
 *
 * The seeded text is pinned here rather than only in the panel test because it
 * is a CONTRACT WITH THE SKILL: Scout's prompt (migration 253) keys off the
 * domain line and the "Source company established" line to decide whether to
 * ask for a domain and whether research_my_company can resolve without spending.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  PROSPECTING_START_EVENT,
  PROSPECT_LIST_SKILL_SLUG,
  STICKY_SKILL_SLUGS,
  buildProspectingSeedText,
  normalizeSeedDomain,
  startProspectingChat,
  type ProspectingStartDetail,
} from '../start-event'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('startProspectingChat', () => {
  it('dispatches the named event carrying the detail verbatim', () => {
    const seen: ProspectingStartDetail[] = []
    const listener = (e: Event) => seen.push((e as CustomEvent).detail)
    window.addEventListener(PROSPECTING_START_EVENT, listener)
    try {
      startProspectingChat({ domain: 'acme.com', sourceEstablished: true, listId: 'list-1' })
    } finally {
      window.removeEventListener(PROSPECTING_START_EVENT, listener)
    }
    expect(seen).toEqual([
      { domain: 'acme.com', sourceEstablished: true, listId: 'list-1' },
    ])
  })

  it('the event name is the one the shell listens for', () => {
    expect(PROSPECTING_START_EVENT).toBe('ni:prospecting-start')
  })

  it('the skill slug matches the system skill the migration seeds', () => {
    expect(PROSPECT_LIST_SKILL_SLUG).toBe('build-prospect-list')
  })

  it('keeps only the prospect-list skill armed across turns', () => {
    expect([...STICKY_SKILL_SLUGS]).toEqual(['build-prospect-list'])
  })
})

describe('buildProspectingSeedText', () => {
  it('carries the domain and the source-company state', () => {
    expect(buildProspectingSeedText({ domain: 'acme.com', sourceEstablished: false })).toBe(
      'Learn about my company. Domain: acme.com. Source company established: no.',
    )
    expect(buildProspectingSeedText({ domain: 'acme.com', sourceEstablished: true })).toBe(
      'Learn about my company. Domain: acme.com. Source company established: yes.',
    )
  })

  it('says "unknown" when there is no domain — Scout then asks with ask_user', () => {
    expect(buildProspectingSeedText({ domain: null, sourceEstablished: false })).toContain(
      'Domain: unknown.',
    )
  })

  it('names an existing list when the entry point knows one', () => {
    expect(
      buildProspectingSeedText({ domain: 'acme.com', sourceEstablished: true, listId: 'list-9' }),
    ).toBe(
      'Learn about my company. Domain: acme.com. Source company established: yes. Continue prospect list: list-9.',
    )
  })

  it('normalises a pasted URL down to the bare host', () => {
    // The form takes what the user types; the model should never see a path.
    expect(buildProspectingSeedText({ domain: 'https://Acme.com/pricing?x=1', sourceEstablished: false }))
      .toContain('Domain: acme.com.')
  })
})

describe('normalizeSeedDomain', () => {
  it.each([
    ['acme.com', 'acme.com'],
    ['  ACME.com  ', 'acme.com'],
    ['https://acme.com', 'acme.com'],
    ['http://www.acme.com/about', 'www.acme.com'],
    ['acme.com/pricing#plans', 'acme.com'],
    ['acme.com.', 'acme.com'],
    ['liam@acme.com', 'acme.com'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeSeedDomain(input)).toBe(expected)
  })

  it.each([null, undefined, '', '   '])('%s → null', (input) => {
    expect(normalizeSeedDomain(input)).toBeNull()
  })
})
