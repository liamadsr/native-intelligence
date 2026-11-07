'use client'

import type { CaptureListItem } from '../views/capture-utils'
import type { MentionCompany, MentionContact } from '@/lib/search/menu-search'

// The person and company the menu mentions live with the search
// (src/lib/search/menu-search.ts); re-exported for the composer's imports.
export type { MentionCompany, MentionContact } from '@/lib/search/menu-search'

export type PickerItem =
  | { kind: 'contact'; contact: MentionContact }
  | { kind: 'company'; company: MentionCompany }
  | { kind: 'capture'; capture: CaptureListItem }

/**
 * How well a candidate string matches the query: 3 exact, 2 prefix,
 * 1 substring, 0 none. Drives which SECTION leads the picker.
 */
export function matchScore(candidate: string | null | undefined, q: string): number {
  if (!q) return 0
  const s = (candidate ?? '').toLowerCase()
  if (!s) return 0
  if (s === q) return 3
  if (s.startsWith(q)) return 2
  if (s.includes(q)) return 1
  return 0
}

/**
 * A person's score is their NAME match. An email-only hit ("corvanne" ⊂
 * liam@corvanne.com) is real but incidental — it's a proxy for "works at
 * Corvanne", which is exactly what the Companies section is for. Scoring it
 * at 1 (substring) while a company named Corvanne scores 3 (exact) is what
 * lets the company lead when the user clearly typed a company name. Without
 * this, every company search is buried under its own employees, because a
 * company's name is almost always inside its staff's email domain.
 */
export function contactScore(c: MentionContact, q: string): number {
  const byName = matchScore(c.full_name, q)
  if (byName) return byName
  return matchScore(c.email, q) ? 1 : 0
}

export function companyScore(c: MentionCompany, q: string): number {
  return Math.max(matchScore(c.name, q), matchScore(c.domain, q) ? 1 : 0)
}

export interface PickerSection {
  key: 'people' | 'companies' | 'captures'
  label: string
  items: PickerItem[]
  /** Best match score among this section's items (0 with no query). */
  best: number
  /**
   * Index of this section's first row in the flat `items` list. Precomputed
   * here so the render never mutates a counter mid-JSX (react-hooks/
   * immutability) and so the keyboard index is derived from the same source
   * as the painted rows.
   */
  offset: number
}

/**
 * Order the three sections by MATCH QUALITY, not a fixed kind order.
 *
 * With no query the default is People → Companies → Captures. With a query,
 * the section whose best item matches best leads — so typing a company's
 * exact name puts the company first, above people who only matched because
 * the name sits inside their email domain. Ties keep the default order
 * (stable sort), so nothing jumps around for weak, equal matches.
 *
 * Pure and exported so the ranking can be tested without mounting the picker.
 * Both the flat keyboard index and the render derive from this one array.
 */
export function orderSections(
  people: MentionContact[],
  companies: MentionCompany[],
  captures: CaptureListItem[],
  q: string,
): PickerSection[] {
  const best = <T,>(xs: T[], score: (x: T) => number) =>
    q && xs.length ? Math.max(...xs.map(score)) : 0
  const defs: Omit<PickerSection, 'offset'>[] = [
    {
      key: 'people',
      label: 'People',
      items: people.map((contact): PickerItem => ({ kind: 'contact', contact })),
      best: best(people, (c) => contactScore(c, q)),
    },
    {
      key: 'companies',
      label: 'Companies',
      items: companies.map((company): PickerItem => ({ kind: 'company', company })),
      best: best(companies, (c) => companyScore(c, q)),
    },
    {
      key: 'captures',
      label: 'Captures',
      items: captures.map((capture): PickerItem => ({ kind: 'capture', capture })),
      best: best(captures, (c) => matchScore(c.title, q)),
    },
  ]
  const ordered = defs
    .map((d, i) => ({ d, i }))
    .sort((a, b) => b.d.best - a.d.best || a.i - b.i)
    .map(({ d }) => d)
  // Assign flat offsets in final order, once, here — not during render.
  let offset = 0
  return ordered.map((d) => {
    const section: PickerSection = { ...d, offset }
    offset += d.items.length
    return section
  })
}

export function contactSubline(c: MentionContact): string | null {
  const parts = [c.job_title, c.company_name].filter(Boolean)
  if (parts.length) return parts.join(' · ')
  return c.email
}

export function companySubline(c: MentionCompany): string | null {
  const parts = [c.industry, c.domain].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}
