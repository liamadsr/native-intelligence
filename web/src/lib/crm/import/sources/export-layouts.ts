/**
 * The customer exports of the tools a small business already uses (roadmap
 * #10): QuickBooks, Stripe, HubSpot, Pipedrive, Mailchimp, Jobber, Housecall
 * Pro and Square. Each layout knows its export's columns, so a file from one
 * of them imports with no questions:
 *
 *   detect   {@link detectExportLayout}: the export whose own columns the
 *            header row has (Stripe's "Card Last4" and "Total Spend",
 *            Square's "Square Customer ID"…). Generic headers ("Name",
 *            "Email") never decide it.
 *   map      each column the export is known to have → its field, the junk
 *            (card details, IP addresses, owners) → skip, and a column it
 *            doesn't know (the owner's custom field) → notes, never a
 *            question. The owner's own answers still win.
 *   records  the import's source is the app, so its contacts are tagged
 *            "from Stripe", a second import of the same app finds them by the
 *            app's own id, and the summary says where they came from.
 *
 * Pure. Headers are compared as {@link headerKey}s ("Created (UTC)" →
 * "createdutc").
 */
import type { ImportRelationship, ImportSource } from '../record'
import { headerKey, type LayoutColumns, type MappedTarget } from './spreadsheet'

export const EXPORT_APPS = ['quickbooks', 'stripe', 'hubspot', 'pipedrive', 'mailchimp', 'jobber', 'housecall_pro', 'square'] as const
export type ExportApp = (typeof EXPORT_APPS)[number] & ImportSource

export interface ExportLayout extends LayoutColumns {
  app: ExportApp
  /** The file's people, when no column says: a billing, payments or field-service tool's are customers; a CRM's or a mailing list's are not all. */
  relationship: ImportRelationship | null
  /** A row that is not a person (a report's totals or its printed-at line). */
  skipRow?: (row: string[]) => boolean
}

interface LayoutSpec {
  app: ExportApp
  relationship: ImportRelationship | null
  /** Columns this export has: `min` of them (or any one `decisive` one) identify it… */
  signals: string[]
  decisive?: string[]
  min: number
  /** …as long as one is a column only this app writes (a generic sheet may have "Billing Address" and "Shipping Address" too)… */
  anyOf?: string[]
  /** …or the header row carries a mark only this app's exports have (Pipedrive's "Person - " prefix): worth two signals. */
  mark?: (headers: string[]) => boolean
  /** A field's value as the app writes it, read plain. */
  cell?: LayoutColumns['cell']
  /** The file names the app gives its export (a hint worth one signal). */
  fileName?: RegExp
  /** Every column the export is known to have, by header key. */
  columns: Record<string, MappedTarget>
  /** Families of columns ("… (metadata)", "Card …"), checked after `columns`. */
  patterns?: Array<[RegExp, MappedTarget]>
  /** A header as the layout compares it (Pipedrive's "Person - " prefix off). */
  key?: (header: string) => string
  /** A header as a note line names it ("Won deals", not "Person - Won deals"). */
  label?: (header: string) => string
  rest?: 'note' | 'skip'
  skipRow?: (row: string[]) => boolean
}

const skip = (...keys: string[]): Record<string, MappedTarget> => Object.fromEntries(keys.map((k) => [k, 'skip' as const]))

/** A report's footer: its "TOTAL" line, or the line saying when it was printed ("Monday, Nov 03, 2025 09:14 AM GMT-08:00"). */
function reportFooter(row: string[]): boolean {
  const cells = row.map((c) => c.trim()).filter(Boolean)
  if (cells.length === 0) return true
  if (/^total\b/i.test(cells[0])) return true
  return cells.length === 1 && /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)\b/i.test(cells[0]) && /\b(?:gmt|utc)|\d{4}\b/i.test(cells[0])
}

const LAYOUTS: LayoutSpec[] = [
  {
    app: 'stripe',
    relationship: 'customer',
    signals: ['createdutc', 'cardid', 'cardlast4', 'cardbrand', 'delinquent', 'totalspend', 'paymentcount', 'refundedvolume', 'disputelosses', 'businessvatid', 'accountbalance', 'cardfingerprint'],
    min: 3,
    fileName: /unified_customers|^customers.*\.csv$/i,
    columns: {
      id: 'external_id',
      description: 'notes',
      email: 'email',
      name: 'full_name',
      phone: 'phone',
      addressline1: 'street',
      addressline2: 'street2',
      addresscity: 'city',
      addressstate: 'state',
      addresscountry: 'country',
      addresszip: 'postal_code',
      addresspostalcode: 'postal_code',
      totalspend: 'spend',
      paymentcount: 'spend',
      ...skip(
        'createdutc', 'delinquent', 'currency', 'accountbalance', 'balance', 'businessvatid', 'refundedvolume', 'disputelosses', 'taxexempt', 'taxids',
        'preferredlocales', 'invoiceprefix', 'defaultsource', 'defaultpaymentmethod', 'plan', 'status', 'cancelatperiodend', 'coupon', 'discount',
        'shippingname', 'shippingphone', 'shippingaddressline1', 'shippingaddressline2', 'shippingaddresscity', 'shippingaddressstate',
        'shippingaddresscountry', 'shippingaddresspostalcode', 'shippingaddresszip', 'testclock', 'livemode', 'deleted', 'averageorder',
        'taxlocationrecognized',
      ),
    },
    patterns: [
      [/^card/, 'skip'],
      [/^paymentmethod/, 'skip'],
      [/metadata$/, 'note'],
    ],
    // "gate_code (metadata)" reads "gate_code" in notes.
    label: (header) => header.replace(/\s*\(metadata\)\s*$/i, ''),
  },
  {
    app: 'square',
    relationship: 'customer',
    signals: ['squarecustomerid', 'creationsource', 'firstvisit', 'lastvisit', 'transactioncount', 'lifetimespend', 'transactiontotal', 'emailsubscriptionstatus', 'instantprofile', 'referenceid'],
    decisive: ['squarecustomerid'],
    min: 3,
    columns: {
      squarecustomerid: 'external_id',
      firstname: 'first_name',
      lastname: 'last_name',
      emailaddress: 'email',
      phonenumber: 'phone',
      nickname: 'skip',
      companyname: 'company',
      streetaddress1: 'street',
      streetaddress2: 'street2',
      city: 'city',
      state: 'state',
      postalcode: 'postal_code',
      memo: 'notes',
      lastvisit: 'last_contact',
      transactioncount: 'spend',
      lifetimespend: 'spend',
      transactiontotal: 'spend',
      emailsubscriptionstatus: 'email_opt_out',
      groups: 'tags',
      ...skip('referenceid', 'birthday', 'creationsource', 'firstvisit', 'instantprofile', 'blocked', 'smssubscriptionstatus', 'emailunsubscribed'),
    },
  },
  {
    app: 'hubspot',
    relationship: null,
    signals: ['recordid', 'contactowner', 'lifecyclestage', 'leadstatus', 'marketingcontactstatus', 'associatedcompany', 'lastactivitydate', 'createdate', 'associatedcompanyids', 'hubspotscore'],
    decisive: ['marketingcontactstatus'],
    anyOf: ['recordid', 'contactid', 'contactowner'],
    min: 3,
    columns: {
      recordid: 'external_id',
      contactid: 'external_id',
      firstname: 'first_name',
      lastname: 'last_name',
      email: 'email',
      phonenumber: 'phone',
      mobilephonenumber: 'phone',
      associatedcompany: 'company',
      associatedcompanyprimary: 'company',
      primaryassociatedcompany: 'company',
      companyname: 'company',
      jobtitle: 'job_title',
      streetaddress: 'street',
      city: 'city',
      stateregion: 'state',
      postalcode: 'postal_code',
      countryregion: 'country',
      lifecyclestage: 'relationship',
      lastactivitydate: 'last_contact',
      lastcontacted: 'last_contact',
      unsubscribedfromallemail: 'email_opt_out',
      ...skip(
        'contactowner', 'leadstatus', 'marketingcontactstatus', 'createdate', 'associatedcompanyids', 'associatedcompanyidprimary', 'hubspotscore',
        'lastmodifieddate', 'originalsource', 'originaltrafficsource', 'becamealeaddate', 'becameacustomerdate', 'emaildomain', 'ipcountry', 'ipcity',
        'ipstateregion', 'numberofpageviews', 'numberofsessions', 'marketingemailsopened', 'marketingemailsclicked', 'marketingemailsdelivered',
        'marketingemailsbounced', 'lastmarketingemailname', 'lastmarketingemailsenddate', 'associateddeals', 'associateddealids', 'recentdealamount',
        'totalrevenue', 'persona', 'owner', 'hubspotteam',
      ),
    },
  },
  {
    app: 'pipedrive',
    relationship: null,
    signals: ['name', 'organization', 'owner', 'opendeals', 'wondeals', 'lostdeals', 'closeddeals', 'activitiestodo', 'doneactivities', 'nextactivitydate', 'lastactivitydate', 'visibleto', 'emailmessagescount', 'label'],
    // Some exports leave the prefix off: then a deal or activity count Pipedrive keeps per person says it.
    anyOf: ['opendeals', 'wondeals', 'lostdeals', 'closeddeals', 'activitiestodo', 'doneactivities', 'emailmessagescount'],
    mark: (headers) => {
      const named = headers.filter((h) => h.trim())
      return named.length > 0 && headers.filter((h) => /^\s*person\s*-\s*/i.test(h)).length * 2 >= named.length
    },
    min: 4,
    // "Person - Name", "Person - Email - Work": every column carries the entity.
    key: (header) => headerKey(header.replace(/^\s*person\s*-\s*/i, '')),
    label: (header) => header.replace(/^\s*person\s*-\s*/i, ''),
    columns: {
      id: 'external_id',
      name: 'full_name',
      firstname: 'first_name',
      lastname: 'last_name',
      organization: 'company',
      organizationname: 'company',
      label: 'tags',
      labels: 'tags',
      jobtitle: 'job_title',
      postaladdress: 'address',
      lastactivitydate: 'last_contact',
      lastemailreceived: 'last_contact',
      lastemailsent: 'last_contact',
      wondeals: 'spend',
      marketingstatus: 'email_opt_out',
      notes: 'notes',
      ...skip(
        'owner', 'opendeals', 'lostdeals', 'closeddeals', 'activitiestodo', 'doneactivities', 'totalactivities', 'nextactivitydate', 'visibleto',
        'emailmessagescount', 'addtime', 'updatetime', 'profilepicture', 'followers', 'participantofopendeals', 'participantofcloseddeals', 'ownerid',
        'organizationid', 'birthday', 'instantmessenger',
      ),
    },
    patterns: [
      [/^email/, 'email'],
      [/^phone/, 'phone'],
      [/^postaladdress/, 'skip'],
    ],
  },
  {
    app: 'mailchimp',
    relationship: null,
    signals: ['memberrating', 'optintime', 'optinip', 'confirmtime', 'confirmip', 'latitude', 'longitude', 'gmtoff', 'dstoff', 'timezone', 'lastchanged', 'leid', 'euid', 'unsubtime', 'cleantime'],
    min: 3,
    // subscribed_members_export_<id>.csv, and since 2025 subscribed_email_audience_export_<id>.csv (and the unsubscribed, cleaned, nonsubscribed ones).
    fileName: /(?:(?:non|un)?subscribed|cleaned)_(?:members|email_audience)_export/i,
    columns: {
      emailaddress: 'email',
      firstname: 'first_name',
      lastname: 'last_name',
      address: 'address',
      phonenumber: 'phone',
      notes: 'notes',
      tags: 'tags',
      company: 'company',
      unsubtime: 'email_opt_out',
      cleantime: 'email_opt_out',
      ...skip(
        'memberrating', 'optintime', 'optinip', 'confirmtime', 'confirmip', 'latitude', 'longitude', 'gmtoff', 'dstoff', 'timezone', 'cc', 'region',
        'lastchanged', 'leid', 'euid', 'birthday', 'unsubcampaigntitle', 'unsubcampaignid', 'unsubreason', 'unsubreasonother', 'cleancampaigntitle',
        'cleancampaignid', 'emailtype', 'language', 'source', 
      ),
    },
  },
  {
    app: 'jobber',
    relationship: 'customer',
    // Clients → Export Clients. One row per property, so a client with two properties is two rows.
    signals: ['jid', 'iscompany', 'displayname', 'mainphonenumbers', 'mobilephonenumbers', 'workphonenumbers', 'homephonenumbers', 'servicepropertyname', 'servicestreet1', 'billingstreet1', 'billingzipcode', 'servicezipcode', 'textmessageenabledphonenumber'],
    anyOf: ['jid', 'mainphonenumbers', 'servicepropertyname', 'textmessageenabledphonenumber'],
    min: 3,
    columns: {
      jid: 'external_id',
      displayname: 'display_name',
      firstname: 'first_name',
      lastname: 'last_name',
      companyname: 'company',
      emails: 'email',
      tags: 'tags',
      billingstreet1: 'street',
      billingstreet2: 'street2',
      billingcity: 'city',
      billingstate: 'state',
      billingcountry: 'country',
      billingzipcode: 'postal_code',
      ...skip('title', 'createddate', 'iscompany', 'archived', 'leadsource'),
    },
    patterns: [
      [/^fax/, 'skip'],
      [/^service/, 'skip'],
      [/^receives/, 'skip'],
      [/phonenumbers?$/, 'phone'],
    ],
    // "CFS[Gate code]", a custom field, reads "Gate code" in notes.
    label: (header) => header.replace(/^\s*CFS\[(.*)\]\s*$/i, '$1'),
    // "J-ID" is "<client>_<property>": every row of one client is that client.
    cell: { external_id: (value) => value.split('_')[0] },
  },
  {
    app: 'housecall_pro',
    relationship: 'customer',
    // Customers → Export: the list's chosen columns, an address set per address ("Address_1 Street Line 1"…).
    signals: ['address1streetline1', 'address1streetline2', 'address1city', 'address1state', 'address1postalcode', 'address1billing', 'address1notes', 'mobilenumber', 'worknumber', 'homenumber', 'lifetimevalue', 'lastservicedate', 'displayname'],
    anyOf: ['address1streetline1', 'address1billing', 'address1notes', 'lifetimevalue'],
    min: 3,
    columns: {
      id: 'external_id',
      displayname: 'display_name',
      firstname: 'first_name',
      lastname: 'last_name',
      company: 'company',
      jobtitle: 'job_title',
      email: 'email',
      mobilenumber: 'phone',
      homenumber: 'phone',
      worknumber: 'phone',
      address1streetline1: 'street',
      address1streetline2: 'street2',
      address1city: 'city',
      address1state: 'state',
      address1postalcode: 'postal_code',
      address1notes: 'note',
      tags: 'tags',
      notes: 'notes',
      lifetimevalue: 'spend',
      jobscompleted: 'spend',
      lastservicedate: 'last_contact',
      ...skip('address1billing', 'leadsource', 'customertype', 'customersince', 'createdat', 'notificationsenabled', 'donotservice'),
    },
    // A second address of theirs is not where to reach them.
    patterns: [[/^address(?:[2-9]|\d{2})/, 'skip']],
    label: (header) => header.replace(/^\s*Address_1\s+/i, 'Address '),
  },
  {
    app: 'quickbooks',
    relationship: 'customer',
    // Online's customer list (old and new screens), its Customer Contact List report, and Desktop's customer list.
    signals: [
      'openbalance', 'attachments', 'attachment', 'salestax', 'customertype', 'balance', 'phonenumbers', 'billingaddress', 'shippingaddress',
      'activestatus', 'billto1', 'shipto1', 'mrms', 'resalenum', 'creditlimit', 'mainphone', 'mainemail', 'altphone', 'balancetotal',
    ],
    anyOf: ['openbalance', 'attachments', 'attachment', 'salestax', 'phonenumbers', 'billto1', 'mrms', 'resalenum', 'mainemail'],
    min: 2,
    columns: {
      customer: 'display_name',
      name: 'display_name',
      fullname: 'full_name',
      primarycontact: 'full_name',
      firstname: 'first_name',
      lastname: 'last_name',
      company: 'company',
      companyname: 'company',
      phonenumbers: 'phone',
      phone: 'phone',
      phonenumber: 'phone',
      mobile: 'phone',
      mainphone: 'phone',
      altphone: 'phone',
      email: 'email',
      emailaddress: 'email',
      mainemail: 'email',
      address: 'address',
      billingaddress: 'address',
      streetaddress: 'street',
      billingstreet: 'street',
      city: 'city',
      billingcity: 'city',
      state: 'state',
      billingstate: 'state',
      zip: 'postal_code',
      billingzip: 'postal_code',
      country: 'country',
      billingcountry: 'country',
      notes: 'notes',
      note: 'notes',
      jobtitle: 'job_title',
      openbalance: 'note',
      balance: 'note',
      ...skip(
        'shippingaddress', 'attachments', 'attachment', 'salestax', 'fax', 'ccemail', 'website', 'activestatus', 'balancetotal', 'mrms', 'mi', 'secondarycontact',
        'resalenum', 'accountno', 'creditlimit', 'terms', 'rep', 'salestaxcode', 'taxitem', 'customertype', 'jobstatus', 'jobtype', 'jobdescription', 'startdate',
        'projectedend', 'enddate', 'currency',
      ),
    },
    patterns: [
      [/^billto\d$/, 'address_line'],
      [/^shipto\d$/, 'skip'],
    ],
    // A sub-customer or job is written "Parent:Job": the customer is the parent.
    cell: { display_name: (value) => value.split(':')[0] },
    skipRow: reportFooter,
  },
]

function toLayout(spec: LayoutSpec): ExportLayout {
  const keyOf = spec.key ?? headerKey
  return {
    app: spec.app,
    relationship: spec.relationship,
    rest: spec.rest ?? 'note',
    skipRow: spec.skipRow,
    ...(spec.label ? { label: spec.label } : {}),
    ...(spec.cell ? { cell: spec.cell } : {}),
    target(header: string) {
      const key = keyOf(header)
      if (!key) return null
      const known = spec.columns[key]
      if (known) return known
      for (const [pattern, target] of spec.patterns ?? []) if (pattern.test(key)) return target
      return null
    },
  }
}

/** How strongly a header row (and file name) looks like one layout's export. */
function scoreLayout(spec: LayoutSpec, headers: string[], fileName: string | null): number {
  const keys = new Set(headers.map(spec.key ?? headerKey))
  if (spec.decisive?.some((k) => keys.has(k))) return Number.POSITIVE_INFINITY
  const marked = spec.mark?.(headers) ?? false
  if (!marked && spec.anyOf && !spec.anyOf.some((k) => keys.has(k))) return 0
  let score = spec.signals.filter((k) => keys.has(k)).length + (marked ? 2 : 0)
  if (fileName && spec.fileName?.test(fileName)) score += 1
  return score >= spec.min ? score : 0
}

/** The export a header row is from, or null for anyone's own spreadsheet. */
export function detectExportLayout(headers: string[], fileName: string | null = null): ExportLayout | null {
  let best: LayoutSpec | null = null
  let bestScore = 0
  for (const spec of LAYOUTS) {
    const score = scoreLayout(spec, headers, fileName)
    if (score > bestScore) {
      best = spec
      bestScore = score
    }
  }
  return best ? toLayout(best) : null
}
