/**
 * Brevo as import records (roadmap track G4), read with a public OAuth app's
 * token (contacts:read, crm:read): contacts with their lists, CRM companies,
 * and deals as past jobs on the contacts they are linked to. Read only:
 * nothing here writes to Brevo.
 *
 * A contact who unsubscribed in Brevo keeps that as a tag ("unsubscribed
 * email" / "unsubscribed sms"), so anyone writing to them later can see it.
 * Brevo's SMS-only contacts carry a placeholder address (…@mailin-sms.com):
 * it is dropped.
 *
 * Brevo allows 100 calls an hour outside /contacts on general plans, so
 * companies and deals are read in large pages and capped.
 */
import { cleanText, parseMoneyCents, UNSUBSCRIBED_EMAIL_TAG, UNSUBSCRIBED_SMS_TAG, type ImportCompanyRecord, type ImportContactRecord, type ImportPastJob } from '../record'

export const BREVO_API = 'https://api.brevo.com/v3'
export const BREVO_CONTACTS_PAGE = 1000
const BREVO_CRM_PAGE = 100
/** Pages of companies or deals read at most (Brevo's hourly budget outside /contacts). */
const BREVO_CRM_MAX_PAGES = 20

export class BrevoApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export async function brevoGet<T>(token: string, path: string, fetchImpl: typeof fetch = fetch): Promise<T> {
  const res = await fetchImpl(`${BREVO_API}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
  if (!res.ok) throw new BrevoApiError(`Brevo API ${res.status} on ${path.split('?')[0]}`, res.status)
  return (await res.json()) as T
}

export interface BrevoContact {
  id: number
  email?: string
  attributes?: Record<string, unknown>
  emailBlacklisted?: boolean
  smsBlacklisted?: boolean
  listIds?: number[]
  createdAt?: string
  modifiedAt?: string
}

export interface BrevoCompany {
  id: string
  attributes?: Record<string, unknown>
  linkedContactsIds?: number[]
}

export interface BrevoDeal {
  id: string
  attributes?: Record<string, unknown>
  linkedContactsIds?: number[]
}

/** The account's contact lists, id → name. */
export async function listBrevoLists(token: string, fetchImpl?: typeof fetch): Promise<Record<number, string>> {
  const out: Record<number, string> = {}
  for (let offset = 0, page = 0; page < 10; page++, offset += 50) {
    const body = await brevoGet<{ lists?: Array<{ id: number; name?: string }>; count?: number }>(token, `/contacts/lists?limit=50&offset=${offset}`, fetchImpl)
    for (const l of body.lists ?? []) if (l.name) out[l.id] = l.name
    if ((body.lists ?? []).length < 50) break
  }
  return out
}

/** One page of contacts. */
export async function listBrevoContacts(token: string, offset: number, fetchImpl?: typeof fetch): Promise<{ contacts: BrevoContact[]; more: boolean }> {
  const body = await brevoGet<{ contacts?: BrevoContact[]; count?: number }>(token, `/contacts?limit=${BREVO_CONTACTS_PAGE}&offset=${offset}&sort=asc`, fetchImpl)
  const contacts = body.contacts ?? []
  return { contacts, more: contacts.length === BREVO_CONTACTS_PAGE && (body.count === undefined || offset + contacts.length < body.count) }
}

/** Every CRM company (capped). */
export async function listBrevoCompanies(token: string, fetchImpl?: typeof fetch): Promise<BrevoCompany[]> {
  const out: BrevoCompany[] = []
  for (let page = 1; page <= BREVO_CRM_MAX_PAGES; page++) {
    const body = await brevoGet<{ items?: BrevoCompany[] }>(token, `/companies?limit=${BREVO_CRM_PAGE}&page=${page}&sort=asc`, fetchImpl)
    out.push(...(body.items ?? []))
    if ((body.items ?? []).length < BREVO_CRM_PAGE) break
  }
  return out
}

/** Every CRM deal (capped). */
export async function listBrevoDeals(token: string, fetchImpl?: typeof fetch): Promise<BrevoDeal[]> {
  const out: BrevoDeal[] = []
  for (let page = 0; page < BREVO_CRM_MAX_PAGES; page++) {
    const body = await brevoGet<{ items?: BrevoDeal[] }>(token, `/crm/deals?limit=${BREVO_CRM_PAGE}&offset=${page * BREVO_CRM_PAGE}&sort=asc`, fetchImpl)
    out.push(...(body.items ?? []))
    if ((body.items ?? []).length < BREVO_CRM_PAGE) break
  }
  return out
}

function attr(attributes: Record<string, unknown> | undefined, ...names: string[]): string | null {
  for (const n of names) {
    const v = attributes?.[n]
    if (typeof v === 'string' || typeof v === 'number') {
      const s = cleanText(v)
      if (s) return s
    }
  }
  return null
}

export function brevoCompanyToRecord(company: BrevoCompany): ImportCompanyRecord {
  const a = company.attributes
  return {
    kind: 'company',
    externalId: company.id,
    name: attr(a, 'name'),
    domain: attr(a, 'domain'),
    phone: attr(a, 'phone_number'),
    industry: attr(a, 'industry'),
  }
}

/** A won deal (or one with no stage) as a past job; an open one is left off the timeline. */
export function brevoDealToJob(deal: BrevoDeal): ImportPastJob | null {
  const a = deal.attributes
  const stage = (attr(a, 'deal_stage') ?? '').toLowerCase()
  if (stage && /lost|open|new|qualif|proposal|negotiat/.test(stage) && !/won/.test(stage)) return null
  const title = attr(a, 'deal_name')
  const amountCents = parseMoneyCents(a?.amount as string | number | undefined)
  if (!title && amountCents === null) return null
  return {
    kind: 'job',
    title: title ?? 'Deal',
    occurredAt: attr(a, 'close_date', 'closed_date', 'last_updated_date', 'created_at'),
    amountCents,
    currency: null,
  }
}

/** The CRM context a contact's record carries: its company and its won deals. */
export interface BrevoCrmIndex {
  companyByContact: Map<number, { externalId: string; name: string | null }>
  jobsByContact: Map<number, ImportPastJob[]>
}

export function brevoCrmIndex(companies: BrevoCompany[], deals: BrevoDeal[]): BrevoCrmIndex {
  const companyByContact = new Map<number, { externalId: string; name: string | null }>()
  for (const c of companies) for (const id of c.linkedContactsIds ?? []) if (!companyByContact.has(id)) companyByContact.set(id, { externalId: c.id, name: attr(c.attributes, 'name') })
  const jobsByContact = new Map<number, ImportPastJob[]>()
  for (const d of deals) {
    const job = brevoDealToJob(d)
    if (!job) continue
    for (const id of d.linkedContactsIds ?? []) jobsByContact.set(id, [...(jobsByContact.get(id) ?? []), job])
  }
  return { companyByContact, jobsByContact }
}

/** One Brevo contact as a record. Pure. */
export function brevoContactToRecord(contact: BrevoContact, lists: Record<number, string> = {}, crm?: BrevoCrmIndex): ImportContactRecord {
  const a = contact.attributes
  const email = contact.email && !/@mailin-sms\.com$/i.test(contact.email) ? contact.email : null
  const tags = [
    ...(contact.listIds ?? []).map((id) => lists[id]).filter((n): n is string => !!n),
    ...(contact.emailBlacklisted ? [UNSUBSCRIBED_EMAIL_TAG] : []),
    ...(contact.smsBlacklisted ? [UNSUBSCRIBED_SMS_TAG] : []),
  ]
  const history = crm?.jobsByContact.get(contact.id) ?? []
  const company = crm?.companyByContact.get(contact.id) ?? null
  const companyName = attr(a, 'COMPANY', 'COMPANY_NAME')
  return {
    kind: 'contact',
    externalId: String(contact.id),
    firstName: attr(a, 'FIRSTNAME', 'FIRST_NAME', 'PRENOM'),
    lastName: attr(a, 'LASTNAME', 'LAST_NAME', 'NOM'),
    emails: email ? [email] : [],
    phones: [attr(a, 'SMS'), attr(a, 'WHATSAPP'), attr(a, 'LANDLINE_NUMBER', 'PHONE')].filter((p): p is string => !!p),
    address: attr(a, 'ADDRESS', 'ADRESSE'),
    company: company ? { externalId: company.externalId, name: company.name } : companyName ? { name: companyName } : null,
    jobTitle: attr(a, 'JOB_TITLE', 'TITLE'),
    tags,
    history,
    relationship: history.length ? 'customer' : null,
  }
}
