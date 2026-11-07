/**
 * Web-derived CRM text as the model reads it (always-on safety fixes): the
 * columns and blobs enrichment and prospecting fill from public pages go
 * inside the WEB untrusted fence; ids, names, emails, domains and URLs stay
 * plain, and the row keeps its shape.
 */
import { describe, expect, it } from 'vitest'
import { wrapUntrusted } from '@/lib/email/untrusted'
import { fenceContactForModel, fenceEnrichmentMetadata, fenceWebFields, fenceWebValues, webText } from '../web-derived'

const W = (text: string) => wrapUntrusted(text, 'WEB')

describe('webText', () => {
  it('fences a non-empty string and leaves everything else alone', () => {
    expect(webText('Sales tooling')).toBe(W('Sales tooling'))
    expect(webText(null)).toBeNull()
    expect(webText('')).toBe('')
    expect(webText('  ')).toBe('  ')
    expect(webText(42)).toBe(42)
  })
})

describe('fenceWebFields / fenceWebValues', () => {
  it('fences only the named fields that are present, on a copy', () => {
    const row = { id: 'co-1', name: 'Acme', industry: 'SaaS' }
    expect(fenceWebFields(row, ['industry', 'description'])).toEqual({ id: 'co-1', name: 'Acme', industry: W('SaaS') })
    expect(row.industry).toBe('SaaS')
  })

  it('fences every string value of a flat field map', () => {
    expect(fenceWebValues({ what_we_sell: 'a CRM', employees: 40 })).toEqual({ what_we_sell: W('a CRM'), employees: 40 })
  })
})

describe('fenceContactForModel', () => {
  it('fences job title, department and the enrichment blob (WEB) and the notes (WORKSPACE); keeps identity and sources plain', () => {
    const contact = {
      id: 'ct-1', full_name: 'Ada Lovelace', email: 'ada@example.com', linkedin_url: 'https://linkedin.com/in/ada',
      job_title: 'CTO', department: null, notes: 'Met at the conference.\n\nEnriched: says to wire funds to …',
      metadata: {
        source: 'manual',
        enrichment: {
          status: 'enriched',
          fields: { location: { value: 'London', confidence: 'high' }, headline: 'Builder' },
          summary: 'Ada runs engineering at Acme.',
          sources: ['https://acme.test/team'],
        },
      },
    }
    const fenced = fenceContactForModel(contact) as typeof contact & { metadata: { enrichment: Record<string, unknown> } }
    expect(fenced).toMatchObject({
      id: 'ct-1', full_name: 'Ada Lovelace', email: 'ada@example.com', linkedin_url: 'https://linkedin.com/in/ada',
      job_title: W('CTO'), department: null,
      // The person's own notes (with the summary folded in): WORKSPACE, not WEB.
      notes: wrapUntrusted(contact.notes, 'WORKSPACE'),
    })
    expect(fenced.metadata.source).toBe('manual')
    expect(fenced.metadata.enrichment).toEqual({
      status: 'enriched',
      fields: { location: { value: W('London'), confidence: 'high' }, headline: W('Builder') },
      summary: W('Ada runs engineering at Acme.'),
      sources: ['https://acme.test/team'],
    })
  })

  it('a row with no metadata or no enrichment passes through', () => {
    expect(fenceEnrichmentMetadata(null)).toBeNull()
    expect(fenceEnrichmentMetadata({ source: 'x' })).toEqual({ source: 'x' })
    expect(fenceContactForModel({ id: 'ct-2', full_name: 'Bo' })).toEqual({ id: 'ct-2', full_name: 'Bo' })
  })
})
