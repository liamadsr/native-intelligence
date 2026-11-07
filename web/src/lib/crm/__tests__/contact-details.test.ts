/**
 * `buildContactDetails` + the timeline parser behind the contact Details tab.
 *
 * The fixture is the Devin Marsh run: a CEO whose "Previously" and
 * "Education" came back as long semicolon lists with dates in parentheses
 * (and one parenthetical — "(J.D.)" — that is NOT a date). The tab promises
 * a timeline for those, so the parser is the thing to pin: entries split on
 * the right boundaries, the org is what follows the last "at"/"from", the
 * period is the trailing dated parenthetical and nothing else.
 */
import { describe, it, expect } from 'vitest'
import { buildContactDetails, type ContactDetailsInput } from '@/lib/crm/contact-details'
import { chipText, looksLikeList, parseTimeline } from '@/lib/crm/enrichment-details'

const LI = 'https://lnkd.in/xQ7kV2pL'

function field(value: string, confidence: 'high' | 'medium' | 'low' = 'high', source_url = LI) {
  return { value, source_url, source_title: 'Devin Marsh | LinkedIn', confidence }
}

const PREVIOUS =
  'Senior Counsel - North America at Halvern (2022–Present); Associate, Mergers & Acquisitions Private Equity at Whitcombe & Rowe (2020–2022); Associate at Marlowe Pierce (2016–2020); Intern in Supply Chain Sustainability at Coastal Trade Council (2015).'

const EDUCATION =
  'Bachelor of Arts in History, Political Science, and Economics from Westbrook (2005–2009); Doctor of Law (J.D.) and LL.M. in International Human Rights from Lakeshore University School of Law (2012–2016).'

const EXPERTISE =
  'Agriculture technology, AI application in agriculture, and drone technology, as evidenced by his public speaking engagements on behalf of Fieldwing.'

const DEVIN: ContactDetailsInput = {
  job_title: 'CEO',
  department: 'General Management',
  email: 'devin@fieldwing.ag',
  secondary_emails: ['dm@example.com'],
  phone: null,
  linkedin_url: LI,
  company_name: 'Fieldwing',
  enrichment_status: 'enriched',
  enriched_at: '2026-09-04T01:00:00Z',
  metadata: {
    enrichment: {
      version: 2,
      status: 'enriched',
      enriched_at: '2026-09-04T01:00:00Z',
      summary: 'Devin Marsh is the CEO of Fieldwing.',
      notes_summary: 'Devin Marsh is the CEO of Fieldwing.',
      applied_fields: ['department', 'linkedin_url'],
      fields: {
        full_name: field('Devin Marsh'),
        job_title: field('Chief Executive Officer', 'medium'),
        department: field('General Management', 'medium'),
        seniority: field('C-level'),
        company_name: field('Fieldwing'),
        company_domain: field('fieldwing.ag'),
        location: field('Tulsa, Oklahoma'),
        linkedin_url: field(LI),
        expertise: field(EXPERTISE, 'medium'),
        previous_roles: field(PREVIOUS),
        education: field(EDUCATION),
      },
      sources: [{ url: LI, title: 'Devin Marsh | LinkedIn' }, { url: 'https://fieldwing.ag/team' }],
    },
  },
}

describe('buildContactDetails — sections', () => {
  const model = buildContactDetails(DEVIN)
  const section = (key: string) => model.sections.find((s) => s.key === key)
  const keys = (key: string) => section(key)?.fields.map((f) => f.key) ?? []

  it('orders sections role → contact → expertise → experience → education', () => {
    expect(model.sections.map((s) => s.key)).toEqual([
      'role', 'contact', 'expertise', 'experience', 'education',
    ])
  })

  it('places every value, with other emails right after the primary one', () => {
    expect(keys('role')).toEqual(['job_title', 'department', 'seniority', 'company_name', 'location'])
    expect(keys('contact')).toEqual(['email', 'secondary_emails', 'linkedin_url'])
    expect(keys('expertise')).toEqual(['expertise'])
    expect(keys('experience')).toEqual(['previous_roles'])
    expect(keys('education')).toEqual(['education'])
    expect(model.fieldCount).toBe(11)
    expect(model.unverified).toEqual([])
  })

  it('lets the column win and lends provenance only for applied columns', () => {
    const role = section('role')!
    const title = role.fields.find((f) => f.key === 'job_title')!
    const department = role.fields.find((f) => f.key === 'department')!
    const company = role.fields.find((f) => f.key === 'company_name')!

    // job_title was typed ("CEO") and never applied — the blob's longer form loses.
    expect(title.value).toBe('CEO')
    expect(title.enriched).toBe(false)
    expect(title.sourceUrl).toBeNull()

    expect(department.value).toBe('General Management')
    expect(department.enriched).toBe(true)
    expect(department.confidence).toBe('medium')
    expect(department.sourceUrl).toBe(LI)

    // The company relation is canonical too; the blob's company_name is ignored.
    expect(company.origin).toBe('column')
    expect(company.enriched).toBe(false)
  })

  it('pre-parses the timeline fields into entries', () => {
    const roles = section('experience')!.fields[0]
    expect(roles.kind).toBe('timeline')
    expect(roles.entries).toEqual([
      { title: 'Senior Counsel - North America', org: 'Halvern', period: '2022–Present' },
      { title: 'Associate, Mergers & Acquisitions Private Equity', org: 'Whitcombe & Rowe', period: '2020–2022' },
      { title: 'Associate', org: 'Marlowe Pierce', period: '2016–2020' },
      { title: 'Intern in Supply Chain Sustainability', org: 'Coastal Trade Council', period: '2015' },
    ])

    const education = section('education')!.fields[0]
    expect(education.entries).toEqual([
      { title: 'Bachelor of Arts in History, Political Science, and Economics', org: 'Westbrook', period: '2005–2009' },
      { title: 'Doctor of Law (J.D.) and LL.M. in International Human Rights', org: 'Lakeshore University School of Law', period: '2012–2016' },
    ])
  })

  it('keeps the raw value as the copy text for timeline fields', () => {
    expect(section('experience')!.fields[0].value).toBe(PREVIOUS)
  })

  it('keeps the bio out of the sections but on the model', () => {
    expect(model.summary).toBe('Devin Marsh is the CEO of Fieldwing.')
    expect(model.sections.flatMap((s) => s.fields).some((f) => f.key === 'summary')).toBe(false)
  })

  it('labels a single other email in the singular', () => {
    const one = buildContactDetails({ secondary_emails: ['a@b.co'] })
    expect(one.sections[0].fields[0]).toMatchObject({ key: 'secondary_emails', label: 'Other email', value: 'a@b.co' })
    const two = buildContactDetails({ secondary_emails: ['a@b.co', ' c@d.co '] })
    expect(two.sections[0].fields[0]).toMatchObject({ label: 'Other emails', value: 'a@b.co, c@d.co' })
  })
})

describe('buildContactDetails — confidence gate and empties', () => {
  it('quarantines low-confidence findings', () => {
    const model = buildContactDetails({
      metadata: {
        enrichment: {
          fields: {
            seniority: field('C-level'),
            education: field('MBA from Somewhere (1999–2001)', 'low'),
          },
        },
      },
    })
    expect(model.sections.map((s) => s.key)).toEqual(['role'])
    expect(model.unverified.map((f) => f.key)).toEqual(['education'])
    // Unverified timeline entries are still parsed, so the row renders the same way.
    expect(model.unverified[0].entries).toEqual([{ title: 'MBA', org: 'Somewhere', period: '1999–2001' }])
  })

  it('is empty for a bare row and tolerates junk blobs', () => {
    expect(buildContactDetails({}).fieldCount).toBe(0)
    const junk = buildContactDetails({ metadata: { enrichment: { fields: 'nope', sources: [1] } } })
    expect(junk.sections).toEqual([])
    expect(junk.sources).toEqual([])
  })

  it('surfaces a run that found nothing', () => {
    const model = buildContactDetails({
      enrichment_status: 'enriched',
      metadata: { enrichment: { status: 'enriched', fields: {}, applied_fields: [], sources: [{ url: 'https://x.y' }] } },
    })
    expect(model.status).toBe('enriched')
    expect(model.fieldCount).toBe(0)
    expect(model.sources).toHaveLength(1)
  })
})

describe('parseTimeline', () => {
  const roles = (v: string) => parseTimeline(v, { orgSeparators: [' at ', ' @ '] })

  it('splits on semicolons and reads "Title at Org (period)"', () => {
    expect(roles('CEO at Fieldwing (2024–Present); CTO at Acme (2019–2024)')).toEqual([
      { title: 'CEO', org: 'Fieldwing', period: '2024–Present' },
      { title: 'CTO', org: 'Acme', period: '2019–2024' },
    ])
  })

  it('splits after each dated parenthetical when there are no semicolons', () => {
    expect(roles('CEO at Fieldwing (2024–Present), CTO at Acme (2019 - 2024). Advisor at Foo (2018)')).toEqual([
      { title: 'CEO', org: 'Fieldwing', period: '2024–Present' },
      { title: 'CTO', org: 'Acme', period: '2019–2024' },
      { title: 'Advisor', org: 'Foo', period: '2018' },
    ])
  })

  it('splits on commas only when every piece has its own org', () => {
    expect(roles('CEO at Fieldwing, CTO at Acme')).toEqual([
      { title: 'CEO', org: 'Fieldwing', period: null },
      { title: 'CTO', org: 'Acme', period: null },
    ])
    // A comma inside one title with a single org stays one entry.
    expect(roles('Associate, Mergers & Acquisitions at Whitcombe')).toEqual([
      { title: 'Associate, Mergers & Acquisitions', org: 'Whitcombe', period: null },
    ])
  })

  it('reads a bare trailing period and normalises dashes and "present"', () => {
    expect(roles('Head of Sales at Acme, 2020 - present')).toEqual([
      { title: 'Head of Sales', org: 'Acme', period: '2020–Present' },
    ])
    expect(roles('Head of Sales at Acme (Jan 2020 — Current)')).toEqual([
      { title: 'Head of Sales', org: 'Acme', period: 'Jan 2020–Present' },
    ])
  })

  it('leaves a non-date parenthetical in the title and uses the LAST org separator', () => {
    expect(roles('Engineer (contract) at Bank at Work Ltd (2010–2012)')).toEqual([
      { title: 'Engineer (contract) at Bank', org: 'Work Ltd', period: '2010–2012' },
    ])
  })

  it('reads the "Org (Detail)" shape, commas inside the parenthetical included', () => {
    const schools = parseTimeline(
      'General Assembly (User Experience Design), ASA College (Associate\'s degree, Computer Science), Hudson County Schools of Technology (H.S. Diploma)',
      { orgSeparators: [' from ', ' at '] },
    )
    expect(schools).toEqual([
      { title: 'User Experience Design', org: 'General Assembly', period: null },
      { title: "Associate's degree, Computer Science", org: 'ASA College', period: null },
      { title: 'H.S. Diploma', org: 'Hudson County Schools of Technology', period: null },
    ])
    // A single one still splits org from detail; a dated parenthetical is a period, not a detail.
    expect(roles('Acme (Head of Sales)')).toEqual([{ title: 'Head of Sales', org: 'Acme', period: null }])
    expect(roles('Acme (2020)')).toEqual([{ title: 'Acme', org: null, period: '2020' }])
  })

  it('falls back to a single org-less entry', () => {
    expect(roles('Founder (2015)')).toEqual([{ title: 'Founder', org: null, period: '2015' }])
    expect(roles('Various consulting roles')).toEqual([
      { title: 'Various consulting roles', org: null, period: null },
    ])
    expect(roles('   ')).toEqual([])
  })
})

describe('looksLikeList / chipText', () => {
  it('treats short comma phrases as a list', () => {
    expect(looksLikeList('Larkspur Capital, Sequoia Capital')).toBe(true)
    expect(looksLikeList('Agriculture technology, AI in agriculture, and drone technology')).toBe(true)
  })

  it('treats a sentence with a trailing clause as prose', () => {
    expect(looksLikeList(EXPERTISE)).toBe(false)
    expect(looksLikeList('Just one thing')).toBe(false)
    expect(looksLikeList('Design; then, later, everything else that came after it too')).toBe(false)
  })

  it('drops a leading conjunction and trailing period from a chip', () => {
    expect(chipText('and drone technology.')).toBe('drone technology')
    expect(chipText('& Co')).toBe('Co')
    expect(chipText('Sequoia')).toBe('Sequoia')
  })
})
