/**
 * Google Contacts as import records (roadmap track G2), read with the People
 * API under contacts.readonly: the owner's own contacts ("My Contacts" and
 * their labels), never "Other contacts". Read only.
 *
 *   listGoogleContactGroups  label ids → names (a contact's labels become tags).
 *   listGoogleConnections    one page of the owner's contacts.
 *   googlePersonToRecord     one person → a record (pure).
 */
import { formatAddress, type ImportContactRecord } from '../record'

const PEOPLE_API = 'https://people.googleapis.com/v1'
const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,addresses,organizations,biographies,memberships,metadata'
/** The People API's largest page. */
export const GOOGLE_PAGE_SIZE = 1000

interface GoogleField {
  value?: string
  metadata?: { primary?: boolean }
}

export interface GooglePerson {
  resourceName?: string
  names?: Array<GoogleField & { displayName?: string; givenName?: string; familyName?: string }>
  emailAddresses?: GoogleField[]
  phoneNumbers?: Array<GoogleField & { canonicalForm?: string }>
  addresses?: Array<GoogleField & { formattedValue?: string; streetAddress?: string; extendedAddress?: string; city?: string; region?: string; postalCode?: string; country?: string }>
  organizations?: Array<GoogleField & { name?: string; title?: string; domain?: string }>
  biographies?: GoogleField[]
  memberships?: Array<{ contactGroupMembership?: { contactGroupResourceName?: string } }>
}

export class GoogleContactsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

async function peopleGet<T>(token: string, path: string, fetchImpl: typeof fetch = fetch): Promise<T> {
  const res = await fetchImpl(`${PEOPLE_API}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
  if (!res.ok) throw new GoogleContactsError(`People API ${res.status}`, res.status)
  return (await res.json()) as T
}

/** The owner's own contact labels (system groups like "My Contacts" left out), id → name. */
export async function listGoogleContactGroups(token: string, fetchImpl?: typeof fetch): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  let pageToken: string | undefined
  for (let page = 0; page < 10; page++) {
    const qs = new URLSearchParams({ pageSize: '1000', ...(pageToken ? { pageToken } : {}) })
    const body = await peopleGet<{ contactGroups?: Array<{ resourceName?: string; name?: string; formattedName?: string; groupType?: string }>; nextPageToken?: string }>(
      token,
      `/contactGroups?${qs}`,
      fetchImpl,
    )
    for (const g of body.contactGroups ?? []) {
      if (g.resourceName && g.groupType === 'USER_CONTACT_GROUP') out[g.resourceName] = g.formattedName || g.name || ''
    }
    pageToken = body.nextPageToken
    if (!pageToken) break
  }
  return out
}

/** One page of the owner's contacts. */
export async function listGoogleConnections(
  token: string,
  pageToken: string | null,
  fetchImpl?: typeof fetch,
): Promise<{ people: GooglePerson[]; nextPageToken: string | null }> {
  const qs = new URLSearchParams({ personFields: PERSON_FIELDS, pageSize: String(GOOGLE_PAGE_SIZE), ...(pageToken ? { pageToken } : {}) })
  const body = await peopleGet<{ connections?: GooglePerson[]; nextPageToken?: string }>(token, `/people/me/connections?${qs}`, fetchImpl)
  return { people: body.connections ?? [], nextPageToken: body.nextPageToken ?? null }
}

/** The primary entry first. */
function primaryFirst<T extends GoogleField>(list: T[] | undefined): T[] {
  return [...(list ?? [])].sort((a, b) => Number(!!b.metadata?.primary) - Number(!!a.metadata?.primary))
}

/** One Google contact as a record. Pure. */
export function googlePersonToRecord(person: GooglePerson, groups: Record<string, string> = {}): ImportContactRecord {
  const name = primaryFirst(person.names)[0]
  const address = primaryFirst(person.addresses)[0]
  const org = primaryFirst(person.organizations)[0]
  const tags = (person.memberships ?? [])
    .map((m) => m.contactGroupMembership?.contactGroupResourceName)
    .map((id) => (id ? groups[id] : undefined))
    .filter((t): t is string => !!t)
  return {
    kind: 'contact',
    externalId: person.resourceName ?? null,
    fullName: name?.displayName ?? null,
    firstName: name?.givenName ?? null,
    lastName: name?.familyName ?? null,
    emails: primaryFirst(person.emailAddresses).map((e) => e.value ?? '').filter(Boolean),
    phones: primaryFirst(person.phoneNumbers).map((p) => p.canonicalForm || p.value || '').filter(Boolean),
    address: address
      ? address.formattedValue?.replace(/\n+/g, ', ') ||
        formatAddress([address.streetAddress, address.extendedAddress, address.city, address.region, address.postalCode, address.country])
      : null,
    company: org?.name || org?.domain ? { name: org.name ?? null, domain: org.domain ?? null } : null,
    jobTitle: org?.title ?? null,
    tags,
    notes: primaryFirst(person.biographies)[0]?.value ?? null,
  }
}
