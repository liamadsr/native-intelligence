/**
 * Native Intelligence's optional platform fee on a customer's payment (migration 459):
 * per workspace, basis points of the amount plus fixed cents, BOTH DEFAULT 0.
 * Pricing isn't decided, so nothing depends on a fee: at zero no
 * application_fee_amount is sent to Stripe at all, and the whole payment is
 * the owner's (less Stripe's own processing fee, which Stripe takes from the
 * connected account: fees_collector 'stripe').
 *
 * Pure.
 */

export interface PlatformFee {
  /** Basis points of the amount (100 = 1%). */
  bps: number
  /** Fixed, in the currency's minor unit. */
  cents: number
}

export const NO_PLATFORM_FEE: PlatformFee = { bps: 0, cents: 0 }

/** The table's caps (459): at most 20% and $100 fixed. */
export const MAX_FEE_BPS = 2000
export const MAX_FEE_CENTS = 10_000

function wholeIn(value: unknown, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? Math.min(value, max) : 0
}

/** A stored fee, cleaned: anything missing, negative or not whole is 0. */
export function platformFeeOf(row: { application_fee_bps?: unknown; application_fee_cents?: unknown } | null | undefined): PlatformFee {
  if (!row) return NO_PLATFORM_FEE
  return { bps: wholeIn(row.application_fee_bps, MAX_FEE_BPS), cents: wholeIn(row.application_fee_cents, MAX_FEE_CENTS) }
}

/**
 * The fee on `amountCents`, rounded down, never more than the amount less one
 * cent (a payment the owner keeps nothing of is refused upstream). 0 when the
 * workspace has no fee.
 */
export function applicationFeeCents(amountCents: number, fee: PlatformFee = NO_PLATFORM_FEE): number {
  if (!Number.isInteger(amountCents) || amountCents <= 0) return 0
  const { bps, cents } = platformFeeOf({ application_fee_bps: fee.bps, application_fee_cents: fee.cents })
  if (bps === 0 && cents === 0) return 0
  const total = Math.floor((amountCents * bps) / 10_000) + cents
  return Math.max(0, Math.min(total, amountCents - 1))
}
