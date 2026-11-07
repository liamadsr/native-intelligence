/**
 * HubSpot objects as import records (roadmap track G3): the first full import
 * of a connected portal goes through the one importer
 * (src/lib/inngest/hubspot-functions.ts stages its pages). Companies first,
 * then contacts with their first associated company. Archived records are
 * left out. Pure.
 *
 * The incremental sync after it (hubspot-sync.ts) still matches by the
 * HubSpot id the import leaves on each contact and company
 * (source_provider 'hubspot', provider_contact_id / provider_company_id).
 */
import type { HubspotObject } from '@/lib/integrations/hubspot-api'
import { formatAddress, type ImportCompanyRecord, type ImportContactRecord, type ImportRelationship } from '../record'

/** HubSpot lifecycle stages, as the CRM's relationship. */
export function relationshipFromLifecycle(stage: string | null | undefined): ImportRelationship | null {
  switch ((stage ?? '').toLowerCase()) {
    case 'customer':
    case 'evangelist':
      return 'customer'
    case 'lead':
    case 'subscriber':
    case 'marketingqualifiedlead':
    case 'salesqualifiedlead':
    case 'opportunity':
      return 'lead'
    default:
      return null
  }
}

export function hubspotCompanyToRecord(obj: HubspotObject): ImportCompanyRecord {
  const p = obj.properties ?? {}
  return {
    kind: 'company',
    externalId: obj.id,
    name: p.name ?? null,
    domain: p.domain ?? null,
    website: p.website ?? null,
    phone: p.phone ?? null,
    address: formatAddress([p.address, p.address2, p.city, p.state, p.zip, p.country]),
    city: p.city ?? null,
    state: p.state ?? null,
    country: p.country ?? null,
    industry: p.industry ?? null,
    description: p.description ?? null,
  }
}

export function hubspotContactToRecord(obj: HubspotObject): ImportContactRecord {
  const p = obj.properties ?? {}
  const companyId = obj.associations?.companies?.results?.[0]?.id ?? null
  return {
    kind: 'contact',
    externalId: obj.id,
    firstName: p.firstname ?? null,
    lastName: p.lastname ?? null,
    emails: [p.email, ...(p.hs_additional_emails ?? '').split(';')].filter((e): e is string => !!e),
    phones: [p.phone, p.mobilephone].filter((x): x is string => !!x),
    address: formatAddress([p.address, p.city, p.state, p.zip, p.country]),
    company: companyId ? { externalId: companyId, name: p.company ?? null } : p.company ? { name: p.company } : null,
    jobTitle: p.jobtitle ?? null,
    lastContactAt: p.notes_last_contacted ?? p.hs_last_sales_activity_timestamp ?? null,
    relationship: relationshipFromLifecycle(p.lifecyclestage),
  }
}

/** The records of a page of HubSpot objects (archived ones left out). */
export function hubspotPageToRecords(objectType: 'contacts' | 'companies', results: HubspotObject[]): Array<ImportContactRecord | ImportCompanyRecord> {
  return results.filter((o) => o.archived !== true).map((o) => (objectType === 'companies' ? hubspotCompanyToRecord(o) : hubspotContactToRecord(o)))
}
