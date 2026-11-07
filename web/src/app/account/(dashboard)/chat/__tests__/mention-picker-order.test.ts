/**
 * Section ordering for the `@` mention picker.
 *
 * Pins the bug Liam hit: typing "corvanne" (an exact company name) showed People
 * first — every one of them matched only because "corvanne" sits inside their
 * @corvanne.com email domain — and buried the company named Corvanne beneath them.
 * Sections used to render in a FIXED People → Companies → Captures order
 * regardless of match quality. Now the best-matching section leads.
 *
 * Also pins the invariant that makes keyboard navigation safe across a
 * reordered list: the flat item index and the per-section render offsets are
 * derived from the same ordered array, so flattening `sections` must give the
 * same sequence the rows are painted in.
 */
import { describe, it, expect } from 'vitest'
import {
  orderSections,
  type MentionContact,
  type MentionCompany,
} from '../mention-picker'
import type { CaptureListItem } from '../../views/capture-utils'

const person = (over: Partial<MentionContact> & { id: string }): MentionContact => ({
  full_name: null,
  email: null,
  job_title: null,
  company_name: null,
  is_member: false,
  ...over,
})
const company = (over: Partial<MentionCompany> & { id: string; name: string }): MentionCompany => ({
  domain: null,
  industry: null,
  logo_url: null,
  ...over,
})
const capture = (id: string, title: string): CaptureListItem =>
  ({ id, title, summary: null, started_at: null, recorded_at: null, created_at: null } as unknown as CaptureListItem)

describe('orderSections — which section leads', () => {
  it('no query: default People → Companies → Captures', () => {
    const s = orderSections(
      [person({ id: 'p1', full_name: 'Ada' })],
      [company({ id: 'c1', name: 'Acme' })],
      [capture('n1', 'Standup')],
      '',
    )
    expect(s.map((x) => x.key)).toEqual(['people', 'companies', 'captures'])
    expect(s.every((x) => x.best === 0)).toBe(true)
  })

  it('"corvanne": the company (exact) leads people who only matched on email domain', () => {
    const people = [
      person({ id: 'p1', full_name: 'Liam Alizadeh', email: 'liam.alizadeh@corvanne.com' }),
      person({ id: 'p2', full_name: 'Claire Dumont', email: 'claire.dumont@corvanne.com' }),
      person({ id: 'p3', full_name: 'owen.park@corvanne.com', email: 'owen.park@corvanne.com' }),
    ]
    const companies = [company({ id: 'co', name: 'Corvanne', domain: 'corvanne.com' })]
    const s = orderSections(people, companies, [], 'corvanne')

    expect(s[0].key).toBe('companies')
    expect(s[0].best).toBe(3) // exact name match
    expect(s[1].key).toBe('people')
    expect(s[1].best).toBe(1) // email-only matches are capped at substring strength
  })

  it('an email-only person match never outranks a company NAME match, even a prefix one', () => {
    const people = [person({ id: 'p1', full_name: 'Someone Else', email: 'x@corvannele.io' })]
    const companies = [company({ id: 'co', name: 'Corvannele Studio' })]
    const s = orderSections(people, companies, [], 'corvanne')
    expect(s[0].key).toBe('companies') // prefix (2) beats email-only (1)
  })

  it('a person whose NAME matches exactly still leads a company that only matches on domain', () => {
    const people = [person({ id: 'p1', full_name: 'Corvanne', email: 'c@example.com' })]
    const companies = [company({ id: 'co', name: 'Something Inc', domain: 'corvanne.com' })]
    const s = orderSections(people, companies, [], 'corvanne')
    expect(s[0].key).toBe('people') // exact name (3) beats domain-only (1)
  })

  it('ties keep the default order (stable), so weak equal matches do not jump around', () => {
    const people = [person({ id: 'p1', full_name: 'Anna Corvanneli' })] // substring → 1
    const companies = [company({ id: 'co', name: 'Macorvanne Co' })] // substring → 1
    const s = orderSections(people, companies, [], 'corvanne')
    expect(s.map((x) => x.key)).toEqual(['people', 'companies', 'captures'])
  })

  it('a capture whose title matches exactly leads everything', () => {
    const s = orderSections(
      [person({ id: 'p1', full_name: 'Alpha Team', email: 'a@alpha.com' })],
      [company({ id: 'co', name: 'Alpha Partners' })],
      [capture('n1', 'alpha')],
      'alpha',
    )
    expect(s[0].key).toBe('captures')
    expect(s[0].best).toBe(3)
  })

  it('empty sections are still present (so the render can skip them) and sort to the end on ties', () => {
    const s = orderSections([], [company({ id: 'co', name: 'Acme' })], [], 'zzz')
    expect(s).toHaveLength(3)
    // nothing matches 'zzz' → all best=0 → default order, empties included
    expect(s.map((x) => x.key)).toEqual(['people', 'companies', 'captures'])
  })
})

describe('orderSections — flat index invariant for keyboard nav', () => {
  it('flattening sections in order yields the exact row sequence, so cumulative offsets are correct', () => {
    const people = [person({ id: 'p1', full_name: 'Bo', email: 'bo@corvanne.com' }), person({ id: 'p2', full_name: 'Cy', email: 'cy@corvanne.com' })]
    const companies = [company({ id: 'co', name: 'Corvanne' })]
    const captures = [capture('n1', 'Corvanne kickoff')]
    const s = orderSections(people, companies, captures, 'corvanne')

    // Company leads (exact=3), then captures (prefix=2), then people (email-only=1)
    expect(s.map((x) => x.key)).toEqual(['companies', 'captures', 'people'])

    // This is what the component does: items = sections.flatMap(s => s.items),
    // and each row is painted at `section.offset + i`. The precomputed offsets
    // must line up with the flat list, or arrow-keys select the wrong row.
    const flat = s.flatMap((x) => x.items)
    const idOf = (item: (typeof flat)[number]) =>
      item.kind === 'contact'
        ? item.contact.id
        : item.kind === 'company'
          ? item.company.id
          : item.kind === 'capture'
            ? item.capture.id
            : 'note-taker'

    // offsets are cumulative in FINAL (reordered) section order
    expect(s.map((x) => [x.key, x.offset])).toEqual([
      ['companies', 0],
      ['captures', 1],
      ['people', 2],
    ])

    const painted: string[] = []
    for (const sec of s) {
      sec.items.forEach((item, i) => {
        expect(idOf(flat[sec.offset + i])).toBe(idOf(item))
        painted.push(idOf(item))
      })
    }
    expect(painted).toEqual(['co', 'n1', 'p1', 'p2'])
    const last = s[s.length - 1]
    expect(last.offset + last.items.length).toBe(flat.length)
  })
})
