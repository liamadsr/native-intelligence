/**
 * The customers of the owner's connected Stripe account (roadmap #10), read
 * through the platform with the account's id (the connection payments made:
 * src/lib/payments/accounts.ts), so no new sign-in is needed. Read-only: list
 * calls only, never a write to their Stripe.
 *
 *   payments   {@link readStripePayments}: the account's succeeded charges,
 *              newest first, as past payments by customer, and the people who
 *              paid without a Stripe customer (a Payment Link or Checkout
 *              guest), grouped by their billing email.
 *   customers  {@link listStripeCustomers} + {@link stripeCustomerToRecord}:
 *              a page of customers as import records, each with its payments
 *              on its timeline.
 *
 * Every record's source is 'stripe' with the customer's id (cus_…), the same
 * id a Stripe customers export file carries ("id"), so an export and a direct
 * import of one account find the same contacts.
 */
import type Stripe from 'stripe'
import { formatAddress, MAX_HISTORY, normalizeEmail, type ImportContactRecord, type ImportPastJob } from '../record'

/** Customers or charges one list call returns (Stripe's most). */
export const STRIPE_PAGE = 100
/** The most charges read for payment history: the newest, which are the ones a win-back needs. */
export const MAX_CHARGE_PAGES = 50

/** A guest payer: someone who paid with no Stripe customer, by their billing email. */
export interface StripeGuest {
  email: string
  name: string | null
  phone: string | null
  address: string | null
  jobs: ImportPastJob[]
}

export interface StripePayments {
  /** Each customer's payments (newest first, at most MAX_HISTORY), as [customer id, jobs] pairs: a step's output is JSON. */
  byCustomer: Array<[string, ImportPastJob[]]>
  guests: StripeGuest[]
  /** More charges than were read: the oldest are left out. */
  truncated: boolean
}

function addressOf(address: Stripe.Address | null | undefined): string | null {
  if (!address) return null
  return formatAddress([address.line1, address.line2, address.city, address.state, address.postal_code, address.country])
}

/** A charge that brought money in (succeeded, not refunded in full), as a past payment. Null otherwise. */
export function chargeToJob(charge: Stripe.Charge): ImportPastJob | null {
  if (charge.status !== 'succeeded' || !charge.paid) return null
  const cents = charge.amount - (charge.amount_refunded ?? 0)
  if (cents <= 0) return null
  return {
    kind: 'invoice',
    title: charge.description?.trim() || 'Stripe payment',
    occurredAt: new Date(charge.created * 1000).toISOString(),
    amountCents: cents,
    currency: charge.currency ?? null,
  }
}

const customerIdOf = (charge: Stripe.Charge): string | null => (typeof charge.customer === 'string' ? charge.customer : (charge.customer?.id ?? null))

/** Fold a page of charges into the payments read so far. Pure. */
export function foldCharges(into: { byCustomer: Map<string, ImportPastJob[]>; guests: Map<string, StripeGuest> }, charges: Stripe.Charge[]): void {
  for (const charge of charges) {
    const job = chargeToJob(charge)
    if (!job) continue
    const customerId = customerIdOf(charge)
    if (customerId) {
      const jobs = into.byCustomer.get(customerId) ?? []
      if (jobs.length < MAX_HISTORY) jobs.push(job)
      into.byCustomer.set(customerId, jobs)
      continue
    }
    const billing = charge.billing_details
    const email = normalizeEmail(billing?.email ?? charge.receipt_email)
    if (!email) continue
    const guest = into.guests.get(email) ?? { email, name: null, phone: null, address: null, jobs: [] }
    // Charges come newest first: the first name, phone and address seen are the latest.
    guest.name ??= billing?.name?.trim() || null
    guest.phone ??= billing?.phone?.trim() || null
    guest.address ??= addressOf(billing?.address)
    if (guest.jobs.length < MAX_HISTORY) guest.jobs.push(job)
    into.guests.set(email, guest)
  }
}

/** The account's payments, newest first, up to MAX_CHARGE_PAGES pages. */
export async function readStripePayments(stripe: Stripe, stripeAccount: string): Promise<StripePayments> {
  const into = { byCustomer: new Map<string, ImportPastJob[]>(), guests: new Map<string, StripeGuest>() }
  let startingAfter: string | undefined
  let truncated = false
  for (let page = 0; ; page++) {
    if (page >= MAX_CHARGE_PAGES) {
      truncated = true
      break
    }
    const list = await stripe.charges.list({ limit: STRIPE_PAGE, ...(startingAfter ? { starting_after: startingAfter } : {}) }, { stripeAccount })
    foldCharges(into, list.data)
    if (!list.has_more || list.data.length === 0) break
    startingAfter = list.data[list.data.length - 1].id
  }
  return { byCustomer: [...into.byCustomer], guests: [...into.guests.values()], truncated }
}

/** A page of the account's customers (deleted ones are never listed). */
export async function listStripeCustomers(stripe: Stripe, stripeAccount: string, startingAfter: string | null): Promise<{ customers: Stripe.Customer[]; next: string | null }> {
  const list = await stripe.customers.list({ limit: STRIPE_PAGE, ...(startingAfter ? { starting_after: startingAfter } : {}) }, { stripeAccount })
  const last = list.data[list.data.length - 1]
  return { customers: list.data, next: list.has_more && last ? last.id : null }
}

/**
 * A Stripe customer as an import record, with their payments: a customer of
 * the business when they paid, a lead when every payment was read and none
 * is theirs (a quote, an abandoned checkout), else a customer.
 */
export function stripeCustomerToRecord(customer: Stripe.Customer, jobs: ImportPastJob[] = [], opts: { allPaymentsRead?: boolean } = {}): ImportContactRecord {
  return {
    kind: 'contact',
    externalId: customer.id,
    fullName: customer.name ?? customer.shipping?.name ?? null,
    emails: customer.email ? [customer.email] : [],
    phones: [customer.phone, customer.shipping?.phone].filter((p): p is string => !!p),
    address: addressOf(customer.address) ?? addressOf(customer.shipping?.address),
    notes: customer.description ?? null,
    history: jobs,
    relationship: jobs.length === 0 && opts.allPaymentsRead ? 'lead' : 'customer',
  }
}

/** Someone who paid with no Stripe customer, as an import record. */
export function stripeGuestToRecord(guest: StripeGuest): ImportContactRecord {
  return {
    kind: 'contact',
    fullName: guest.name,
    emails: [guest.email],
    phones: guest.phone ? [guest.phone] : [],
    address: guest.address,
    history: guest.jobs,
    relationship: 'customer',
  }
}
