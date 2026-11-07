/**
 * The workspace's connected Stripe account (migration 459,
 * stripe_connect_account): one per workspace, the account its customers pay
 * into by direct charges.
 *
 * Two ways in (./onboarding.ts):
 *   created  Dial8 makes an Accounts v2 account (full Stripe Dashboard,
 *            Stripe-owned fees and losses, the merchant configuration) and the
 *            owner fills in Stripe-hosted onboarding. An owner who already has
 *            Stripe can reuse their details there (networked onboarding), but
 *            it is a new account.
 *   oauth    an EXISTING Stripe account the owner links with Stripe OAuth
 *            (Standard-account OAuth: still supported, not recommended for new
 *            platforms), so payments land in the account they already run.
 *
 * Either way the owner keeps their own full Stripe Dashboard, and Stripe
 * collects its processing fees from them and owns negative balances.
 *
 * The status is always read back from Stripe (syncConnectedAccount), never
 * trusted from a redirect: the return page, the snapshot webhook's
 * account.updated and the v2 thin events all just re-read the account.
 *
 * Server only; service role.
 */
import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import { platformFeeOf, type PlatformFee } from './fees'

export const CONNECT_STATUSES = ['onboarding', 'ready', 'restricted', 'disconnected'] as const
export type ConnectStatus = (typeof CONNECT_STATUSES)[number]

export interface ConnectedAccount {
  workspaceId: string
  stripeAccountId: string
  linkedVia: 'created' | 'oauth'
  livemode: boolean
  status: ConnectStatus
  chargesEnabled: boolean
  payoutsEnabled: boolean
  detailsSubmitted: boolean
  connectedBy: string | null
  fee: PlatformFee
  readyAt: string | null
  readyNotifiedAt: string | null
}

interface AccountRow {
  workspace_id: string
  stripe_account_id: string
  linked_via: string
  livemode: boolean
  status: string
  charges_enabled: boolean
  payouts_enabled: boolean
  details_submitted: boolean
  connected_by: string | null
  application_fee_bps: number
  application_fee_cents: number
  ready_at: string | null
  ready_notified_at: string | null
}

const ACCOUNT_COLUMNS =
  'workspace_id, stripe_account_id, linked_via, livemode, status, charges_enabled, payouts_enabled, details_submitted, connected_by, application_fee_bps, application_fee_cents, ready_at, ready_notified_at'

function toAccount(row: AccountRow): ConnectedAccount {
  return {
    workspaceId: row.workspace_id,
    stripeAccountId: row.stripe_account_id,
    linkedVia: row.linked_via === 'oauth' ? 'oauth' : 'created',
    livemode: !!row.livemode,
    status: (CONNECT_STATUSES as readonly string[]).includes(row.status) ? (row.status as ConnectStatus) : 'onboarding',
    chargesEnabled: !!row.charges_enabled,
    payoutsEnabled: !!row.payouts_enabled,
    detailsSubmitted: !!row.details_submitted,
    connectedBy: row.connected_by,
    fee: platformFeeOf(row),
    readyAt: row.ready_at,
    readyNotifiedAt: row.ready_notified_at,
  }
}

export function isStripeAccountId(value: unknown): value is string {
  return typeof value === 'string' && /^acct_[A-Za-z0-9]{6,64}$/.test(value)
}

/** The workspace's connected account, or null (none, or a read failed). */
export async function getConnectedAccount(supabase: SupabaseClient, workspaceId: string): Promise<ConnectedAccount | null> {
  const { data, error } = await supabase.from('stripe_connect_account').select(ACCOUNT_COLUMNS).eq('workspace_id', workspaceId).maybeSingle<AccountRow>()
  if (error || !data) return null
  return toAccount(data)
}

/** The live (not disconnected) row for a Stripe account: the webhook's way to its workspace. */
export async function findByStripeAccount(supabase: SupabaseClient, stripeAccountId: string): Promise<ConnectedAccount | null> {
  if (!isStripeAccountId(stripeAccountId)) return null
  const { data, error } = await supabase
    .from('stripe_connect_account')
    .select(ACCOUNT_COLUMNS)
    .eq('stripe_account_id', stripeAccountId)
    .neq('status', 'disconnected')
    .maybeSingle<AccountRow>()
  if (error || !data) return null
  return toAccount(data)
}

/** What Stripe says about an account, in our words. Pure. */
export interface StripeAccountState {
  chargesEnabled: boolean
  payoutsEnabled: boolean
  detailsSubmitted: boolean
  status: Exclude<ConnectStatus, 'disconnected'>
  /** Stripe still wants details from the owner now (currently or past due). */
  needsDetails: boolean
}

export function stateOfStripeAccount(account: Pick<Stripe.Account, 'charges_enabled' | 'payouts_enabled' | 'details_submitted' | 'requirements'>): StripeAccountState {
  const chargesEnabled = !!account.charges_enabled
  const detailsSubmitted = !!account.details_submitted
  const due = [...(account.requirements?.currently_due ?? []), ...(account.requirements?.past_due ?? [])]
  const disabled = account.requirements?.disabled_reason ?? null
  const status: StripeAccountState['status'] = chargesEnabled ? 'ready' : detailsSubmitted && disabled && due.length === 0 ? 'restricted' : 'onboarding'
  return { chargesEnabled, payoutsEnabled: !!account.payouts_enabled, detailsSubmitted, status, needsDetails: due.length > 0 }
}

/**
 * Store the workspace's account (a new one, or a re-link that replaces a
 * disconnected or unfinished one). The platform fee on the row is kept: it is
 * the workspace's, not the account's.
 */
export async function upsertConnectedAccount(
  supabase: SupabaseClient,
  args: { workspaceId: string; stripeAccountId: string; linkedVia: 'created' | 'oauth'; livemode: boolean; connectedBy: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const now = new Date().toISOString()
  const { error } = await supabase.from('stripe_connect_account').upsert(
    {
      workspace_id: args.workspaceId,
      stripe_account_id: args.stripeAccountId,
      linked_via: args.linkedVia,
      livemode: args.livemode,
      status: 'onboarding',
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
      connected_by: args.connectedBy,
      ready_at: null,
      ready_notified_at: null,
      disconnected_at: null,
      updated_at: now,
    },
    { onConflict: 'workspace_id' },
  )
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

export interface SyncResult {
  account: ConnectedAccount
  state: StripeAccountState
  /** It just became ready, and this call won the one confirmation (ready_notified_at was set here). */
  becameReady: boolean
}

export interface SyncDeps {
  retrieve(stripeAccountId: string): Promise<Pick<Stripe.Account, 'charges_enabled' | 'payouts_enabled' | 'details_submitted' | 'requirements'>>
  now?: () => number
}

/**
 * Re-read a connected account from Stripe and store what it says. When it can
 * take payments for the first time, exactly one caller (of the return page,
 * the webhooks and any retry) gets `becameReady`: the claim is a conditional
 * update on ready_notified_at.
 */
export async function syncConnectedAccount(supabase: SupabaseClient, stripeAccountId: string, deps: SyncDeps): Promise<SyncResult | null> {
  const row = await findByStripeAccount(supabase, stripeAccountId)
  if (!row) return null
  const state = stateOfStripeAccount(await deps.retrieve(stripeAccountId))
  const at = new Date((deps.now ?? Date.now)()).toISOString()
  const { error } = await supabase
    .from('stripe_connect_account')
    .update({
      status: state.status,
      charges_enabled: state.chargesEnabled,
      payouts_enabled: state.payoutsEnabled,
      details_submitted: state.detailsSubmitted,
      ready_at: state.status === 'ready' ? (row.readyAt ?? at) : row.readyAt,
      synced_at: at,
      updated_at: at,
    })
    .eq('workspace_id', row.workspaceId)
    .eq('stripe_account_id', stripeAccountId)
  if (error) throw new Error(`stripe_connect_account update failed: ${error.message}`)

  let becameReady = false
  if (state.status === 'ready' && !row.readyNotifiedAt) {
    const { data: claimed } = await supabase
      .from('stripe_connect_account')
      .update({ ready_notified_at: at })
      .eq('workspace_id', row.workspaceId)
      .eq('stripe_account_id', stripeAccountId)
      .is('ready_notified_at', null)
      .select('workspace_id')
    becameReady = Array.isArray(claimed) && claimed.length > 0
  }
  return {
    account: {
      ...row,
      status: state.status,
      chargesEnabled: state.chargesEnabled,
      payoutsEnabled: state.payoutsEnabled,
      detailsSubmitted: state.detailsSubmitted,
      readyAt: state.status === 'ready' ? (row.readyAt ?? at) : row.readyAt,
      readyNotifiedAt: becameReady ? at : row.readyNotifiedAt,
    },
    state,
    becameReady,
  }
}

/** The owner removed Dial8 from their Stripe account (account.application.deauthorized). */
export async function markDisconnected(supabase: SupabaseClient, stripeAccountId: string): Promise<string | null> {
  if (!isStripeAccountId(stripeAccountId)) return null
  const at = new Date().toISOString()
  const { data, error } = await supabase
    .from('stripe_connect_account')
    .update({ status: 'disconnected', charges_enabled: false, disconnected_at: at, updated_at: at })
    .eq('stripe_account_id', stripeAccountId)
    .neq('status', 'disconnected')
    .select('workspace_id')
  if (error) throw new Error(`stripe_connect_account disconnect failed: ${error.message}`)
  return (data as Array<{ workspace_id: string }> | null)?.[0]?.workspace_id ?? null
}
