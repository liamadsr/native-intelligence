// Supabase Edge Function for handling Stripe webhooks.
//
// This is the single source of truth for Stripe → Dial8 sync. Production
// Stripe webhooks point only at this function. Handles:
//   - One-time BYOK purchases (desktop app)
//   - Subscription lifecycle (web app)
//   - AI credit top-ups (web app): payment → grant_credits RPC → Postgres wallet
//
// NOTE: Credits are a POSTGRES wallet (ai_credit_ledger + ai_user_credits),
// debited atomically inside log_ai_usage. Stripe credit grants, the scaffold
// metered subscription, and meter events were removed in the billing rework
// (migration 160) — real-time gating on invoice-cadence data never worked.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@22.1.0?target=denonext'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2025-08-27.basil',
  httpClient: Stripe.createFetchHttpClient(),
})

const cryptoProvider = Stripe.createSubtleCryptoProvider()

// Helper: pull the subscription id from an invoice across API versions.
// API 2025-03-31+ removed the top-level `invoice.subscription` and exposes
// it as `invoice.parent.subscription_details.subscription` instead.
function invoiceSubscriptionId(invoice: any): string | null {
  const direct = invoice?.subscription
  if (direct) return typeof direct === 'string' ? direct : direct.id ?? null

  const parent = invoice?.parent
  if (parent?.type === 'subscription_details') {
    const sub = parent.subscription_details?.subscription
    if (sub) return typeof sub === 'string' ? sub : sub.id ?? null
  }
  return null
}

// Helper: extract period dates from subscription object.
// Newer Stripe API versions (2025+) moved current_period_start/end to items,
// so we check both locations.
function getPeriodDates(subscription: any): { start: string | null; end: string | null } {
  let periodStart = subscription.current_period_start
  let periodEnd = subscription.current_period_end

  if (periodStart == null || periodEnd == null) {
    const firstItem = subscription.items?.data?.[0]
    if (firstItem) {
      periodStart = periodStart ?? firstItem.current_period_start
      periodEnd = periodEnd ?? firstItem.current_period_end
    }
  }

  return {
    start: periodStart ? new Date(periodStart * 1000).toISOString() : null,
    end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
  }
}

// Helper: assign the subscriber AI plan to a user.
async function assignSubscriberPlan(supabaseAdmin: any, userId: string, context: string): Promise<boolean> {
  const { data: subscriptionPlan, error: planError } = await supabaseAdmin
    .from('ai_plan_definitions')
    .select('id, name')
    .eq('purchase_action', 'subscription')
    .limit(1)
    .single()

  if (planError || !subscriptionPlan) {
    console.error(`❌ [${context}] Could not find AI plan with purchase_action=subscription:`, planError?.message)
    return false
  }

  const { error: upsertError } = await supabaseAdmin
    .from('ai_user_plans')
    .upsert({
      user_id: userId,
      plan_id: subscriptionPlan.id,
      is_active: true,
      admin_override: false,
    }, {
      onConflict: 'user_id',
    })

  if (upsertError) {
    console.error(`❌ [${context}] Failed to assign AI plan to user ${userId}:`, upsertError.message)
    return false
  }

  console.log(`📋 [${context}] Assigned AI plan "${subscriptionPlan.name}" to user`, userId)
  return true
}

// Helper: downgrade a user to the default (free) AI plan.
async function downgradeToDefaultPlan(supabaseAdmin: any, userId: string, context: string): Promise<boolean> {
  const { data: defaultPlan } = await supabaseAdmin
    .from('ai_plan_definitions')
    .select('id, name')
    .eq('is_default', true)
    .limit(1)
    .single()

  if (!defaultPlan) {
    console.error(`❌ [${context}] Could not find default AI plan`)
    return false
  }

  const { error: upsertError } = await supabaseAdmin
    .from('ai_user_plans')
    .upsert({
      user_id: userId,
      plan_id: defaultPlan.id,
      is_active: true,
      admin_override: false,
    }, {
      onConflict: 'user_id',
    })

  if (upsertError) {
    console.error(`❌ [${context}] Failed to downgrade user ${userId}:`, upsertError.message)
    return false
  }

  console.log(`📋 [${context}] Downgraded user to default AI plan "${defaultPlan.name}"`, userId)
  return true
}

// Helper: hit Stripe's API directly for reads not in stripe-node's typed map.
async function stripeFetch(path: string, params: Record<string, string>): Promise<any> {
  const apiKey = Deno.env.get('STRIPE_SECRET_KEY') ?? ''
  const qs = new URLSearchParams(params).toString()
  const url = qs
    ? `https://api.stripe.com/v1/${path}?${qs}`
    : `https://api.stripe.com/v1/${path}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Stripe ${path} failed ${res.status}: ${text}`)
  }
  return res.json()
}

serve(async (req) => {
  const signature = req.headers.get('Stripe-Signature')

  if (!signature) {
    return new Response('No signature', { status: 400 })
  }

  try {
    const body = await req.text()

    const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')
    if (!webhookSecret) {
      throw new Error('Webhook secret not configured')
    }

    const event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      webhookSecret,
      undefined,
      cryptoProvider,
    )

    console.log('📩 Stripe webhook event received', {
      type: event.type,
      id: event.id,
    })

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!supabaseUrl || !serviceRoleKey) {
      console.error('Missing Supabase configuration for webhook', {
        hasUrl: Boolean(supabaseUrl),
        hasServiceRoleKey: Boolean(serviceRoleKey),
      })
      return new Response('Configuration error', { status: 500 })
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    })

    switch (event.type) {
      // ---------------------------------------------------------------
      // checkout.session.completed
      //   - mode='subscription' → handled by customer.subscription.created
      //   - mode='payment' + metadata.purpose='ai_credits_topup' → credit grant
      //   - mode='payment' + metadata.purchase_option → BYOK desktop purchase
      // ---------------------------------------------------------------
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session

        if (session.mode === 'subscription') {
          console.log('📋 Subscription checkout completed — handled by subscription events')
          break
        }

        // AI credit top-up flow (web app) → credit the Postgres wallet.
        if (session.metadata?.purpose === 'ai_credits_topup') {
          const userId = session.metadata.user_id
          const amountUsd = Number(session.metadata.credit_amount_usd)
          if (!userId || !Number.isFinite(amountUsd) || amountUsd <= 0) {
            console.error('credits topup: invalid metadata', session.metadata)
            break
          }
          const customerId = session.customer ? String(session.customer) : null

          // grant_credits is idempotent on the key: a Stripe webhook retry
          // (or a duplicate delivery) adds the credit exactly once. This is the
          // bug that previously double-granted a top-up — now impossible.
          const { data: grantResult, error: grantError } = await supabaseAdmin.rpc('grant_credits', {
            p_user_id: userId,
            p_amount_usd: amountUsd,
            p_kind: 'topup',
            p_idempotency_key: `topup-${session.id}`,
            p_stripe_ref: session.id,
            p_stripe_customer_id: customerId,
            p_note: `Top-up $${amountUsd.toFixed(2)}`,
          })
          // Throw so Stripe retries a transient DB failure — the idempotency
          // key makes the retry safe.
          if (grantError) {
            throw new Error(`grant_credits failed: ${grantError.message}`)
          }

          const applied = Array.isArray(grantResult) ? grantResult[0]?.applied : grantResult?.applied
          console.log(
            `💳 Credit topup ${applied ? 'applied' : 'deduplicated'}: user=${userId} amount=$${amountUsd}`,
          )
          break
        }

        // BYOK one-time purchase (desktop app).
        const userId = session.client_reference_id
        const purchaseOption = session.metadata?.purchase_option

        if (!userId || !purchaseOption) {
          console.error('Missing user ID or purchase option in session metadata')
          return new Response('Invalid session metadata', { status: 400 })
        }

        const { data: optionRow, error: optionError } = await supabaseAdmin
          .from('purchase_options')
          .select('id, features')
          .eq('id', purchaseOption)
          .single()

        if (optionError || !optionRow) {
          console.error('Unable to load purchase option from DB:', optionError)
          return new Response('Unknown purchase option', { status: 400 })
        }

        const features = (optionRow.features as string[]) || []

        console.log('🗂️ Webhook purchase option', {
          purchaseOption,
          featureCount: features.length,
        })

        if (features.length === 0) {
          console.warn('Purchase option has no features configured', { purchaseOption })
        }

        for (const featureId of features) {
          const { error } = await supabaseAdmin
            .from('purchases')
            .insert({
              user_id: userId,
              feature_id: featureId,
              purchase_option: purchaseOption,
              price_paid: (session.amount_total ?? 0) / 100,
              stripe_payment_intent_id: (session.payment_intent as string) ?? session.id,
              status: 'completed',
              purchased_at: new Date().toISOString(),
            })

          if (error) {
            console.error('Error recording purchase', { featureId, error: error.message })
          } else {
            console.log('💾 Recorded purchase feature', { userId, featureId })
          }
        }

        await supabaseAdmin
          .from('analytics_events')
          .insert({
            user_id: userId,
            device_id: 'webhook',
            event: 'purchase_completed',
            properties: {
              purchase_option: purchaseOption,
              purchase_tier: 'byok',
              amount: String((session.amount_total ?? 0) / 100),
              currency: session.currency,
            },
            created_at: new Date().toISOString(),
          })

        console.log(`✅ Successfully processed BYOK purchase for user ${userId}: ${purchaseOption}`)
        break
      }

      // ---------------------------------------------------------------
      // Subscription created
      // ---------------------------------------------------------------
      case 'customer.subscription.created': {
        const subscription = event.data.object as Stripe.Subscription
        const userId = subscription.metadata?.user_id

        if (!userId) {
          console.error('Missing user_id in subscription metadata')
          break
        }

        console.log('🆕 New subscription created', {
          subscriptionId: subscription.id,
          userId,
          status: subscription.status,
        })

        const period = getPeriodDates(subscription)
        const { error: insertError } = await supabaseAdmin
          .from('subscriptions')
          .upsert({
            user_id: userId,
            stripe_subscription_id: subscription.id,
            stripe_customer_id: subscription.customer as string,
            status: subscription.status,
            current_period_start: period.start,
            current_period_end: period.end,
            cancel_at_period_end: subscription.cancel_at_period_end,
          }, {
            onConflict: 'stripe_subscription_id',
          })

        if (insertError) {
          console.error('Error inserting subscription:', insertError.message)
        }

        if (subscription.status === 'active' || subscription.status === 'trialing') {
          await assignSubscriberPlan(supabaseAdmin, userId, 'subscription.created')
        }

        await supabaseAdmin
          .from('analytics_events')
          .insert({
            user_id: userId,
            device_id: 'webhook',
            event: 'subscription_created',
            properties: {
              subscription_id: subscription.id,
              status: subscription.status,
              purchase_tier: 'subscription',
            },
            created_at: new Date().toISOString(),
          })

        break
      }

      // ---------------------------------------------------------------
      // Subscription updated
      // ---------------------------------------------------------------
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription
        const userId = subscription.metadata?.user_id

        console.log('🔄 Subscription updated', {
          subscriptionId: subscription.id,
          userId,
          status: subscription.status,
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
        })

        const updPeriod = getPeriodDates(subscription)
        const updFields = {
          stripe_customer_id: subscription.customer as string,
          status: subscription.status,
          current_period_start: updPeriod.start,
          current_period_end: updPeriod.end,
          cancel_at_period_end: subscription.cancel_at_period_end,
        }

        if (userId) {
          // We own this subscription — upsert is safe (user_id satisfies NOT NULL).
          const { error: updateError } = await supabaseAdmin
            .from('subscriptions')
            .upsert(
              { stripe_subscription_id: subscription.id, user_id: userId, ...updFields },
              { onConflict: 'stripe_subscription_id' },
            )
          if (updateError) {
            console.error('Error updating subscription:', updateError.message)
          }
        } else {
          // No user_id in metadata (e.g. a stray/legacy subscription). Only
          // UPDATE an already-tracked row — never INSERT one that would violate
          // the user_id NOT NULL constraint (P2-2).
          const { error: updateError } = await supabaseAdmin
            .from('subscriptions')
            .update(updFields)
            .eq('stripe_subscription_id', subscription.id)
          if (updateError) {
            console.error('Error updating untracked subscription:', updateError.message)
          }
        }

        if (userId) {
          if (subscription.status === 'active' || subscription.status === 'trialing') {
            await assignSubscriberPlan(supabaseAdmin, userId, 'subscription.updated')
          } else if (subscription.status === 'canceled' || subscription.status === 'incomplete') {
            await downgradeToDefaultPlan(supabaseAdmin, userId, 'subscription.updated')
          }
        }

        break
      }

      // ---------------------------------------------------------------
      // Subscription deleted
      // ---------------------------------------------------------------
      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription
        const userId = subscription.metadata?.user_id

        console.log('❌ Subscription deleted', {
          subscriptionId: subscription.id,
          userId,
        })

        await supabaseAdmin
          .from('subscriptions')
          .update({ status: 'canceled' })
          .eq('stripe_subscription_id', subscription.id)

        if (userId) {
          await downgradeToDefaultPlan(supabaseAdmin, userId, 'subscription.deleted')

          await supabaseAdmin
            .from('analytics_events')
            .insert({
              user_id: userId,
              device_id: 'webhook',
              event: 'subscription_canceled',
              properties: { subscription_id: subscription.id },
              created_at: new Date().toISOString(),
            })
        }

        break
      }

      // ---------------------------------------------------------------
      // Invoice payment succeeded (subscription renewal)
      //
      // API version 2025-03-31+ moved invoice.subscription to
      // invoice.parent.subscription_details.subscription. Read from both
      // shapes so this works regardless of which API version the event
      // was rendered with.
      // ---------------------------------------------------------------
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as any
        const subscriptionId = invoiceSubscriptionId(invoice)
        if (subscriptionId) {
          console.log('💰 Invoice payment succeeded for subscription', subscriptionId)

          // P1-5: the invoice carries the period that JUST ENDED, not the new
          // cycle. Writing invoice.period_* left current_period_end permanently
          // one cycle behind. Re-fetch the subscription for its CURRENT period.
          let period = { start: undefined as string | undefined, end: undefined as string | undefined }
          try {
            const sub = await stripe.subscriptions.retrieve(subscriptionId)
            const dates = getPeriodDates(sub as any)
            period = { start: dates.start ?? undefined, end: dates.end ?? undefined }
          } catch (err) {
            console.error('Failed to re-fetch subscription for period:', err)
          }

          await supabaseAdmin
            .from('subscriptions')
            .update({
              status: 'active',
              current_period_start: period.start,
              current_period_end: period.end,
            })
            .eq('stripe_subscription_id', subscriptionId)

          const { data: subRow } = await supabaseAdmin
            .from('subscriptions')
            .select('user_id')
            .eq('stripe_subscription_id', subscriptionId)
            .single()

          if (subRow?.user_id) {
            await assignSubscriberPlan(supabaseAdmin, subRow.user_id, 'invoice.payment_succeeded')
          }
        }
        break
      }

      // ---------------------------------------------------------------
      // Invoice payment failed
      // ---------------------------------------------------------------
      case 'invoice.payment_failed': {
        const invoice = event.data.object as any
        const subscriptionId = invoiceSubscriptionId(invoice)
        if (subscriptionId) {
          console.log('⚠️ Invoice payment failed for subscription', subscriptionId)

          await supabaseAdmin
            .from('subscriptions')
            .update({ status: 'past_due' })
            .eq('stripe_subscription_id', subscriptionId)
        }
        break
      }

      // ---------------------------------------------------------------
      // One-time payment failed (BYOK)
      // ---------------------------------------------------------------
      case 'payment_intent.payment_failed': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent
        console.log(`⚠️ Payment failed for intent: ${paymentIntent.id}`)
        break
      }

      // ---------------------------------------------------------------
      // Charge refunded (BYOK refunds)
      // ---------------------------------------------------------------
      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge
        const paymentIntentId = typeof charge.payment_intent === 'string'
          ? charge.payment_intent
          : charge.payment_intent?.id

        if (!paymentIntentId) {
          console.log('⚠️ Charge refunded but no payment_intent ID found')
          break
        }

        console.log('💸 Charge refunded', { chargeId: charge.id, paymentIntentId })

        // BYOK purchase refunds (desktop).
        const { data: refundedPurchases, error: refundError } = await supabaseAdmin
          .from('purchases')
          .update({
            status: 'refunded',
            refunded_at: new Date().toISOString(),
          })
          .eq('stripe_payment_intent_id', paymentIntentId)
          .neq('status', 'refunded')
          .select('id, user_id, feature_id')

        if (refundError) {
          console.error('Error updating purchases for refund:', refundError.message)
        } else if ((refundedPurchases?.length ?? 0) > 0) {
          console.log(`💸 Marked ${refundedPurchases?.length ?? 0} purchase(s) as refunded`, {
            paymentIntentId,
            purchases: refundedPurchases?.map((p: any) => p.feature_id),
          })
        }

        // Credit top-up refunds (P2-8): map the payment intent → the topup
        // checkout session, then debit the wallet via grant_credits(kind='refund').
        // ONE ledger row per Stripe refund, keyed on the refund id:
        // charge.refunded fires once per refund while charge.amount_refunded is
        // CUMULATIVE, so a key per charge clawed back only the first partial
        // refund and silently dropped every later one.
        try {
          const sessions = await stripeFetch('checkout/sessions', {
            payment_intent: paymentIntentId,
            limit: '1',
          })
          const topupSession = sessions?.data?.find(
            (s: any) => s?.metadata?.purpose === 'ai_credits_topup',
          )
          if (topupSession?.metadata?.user_id) {
            const refunds = await stripeFetch('refunds', { charge: charge.id, limit: '100' })
            for (const refund of (refunds?.data ?? []) as any[]) {
              // A failed or canceled refund gave nothing back.
              if (refund?.status === 'failed' || refund?.status === 'canceled') continue
              const refundedUsd = (refund?.amount ?? 0) / 100
              if (!refund?.id || refundedUsd <= 0) continue
              const { error: rfError } = await supabaseAdmin.rpc('grant_credits', {
                p_user_id: topupSession.metadata.user_id,
                // Pass the POSITIVE refunded amount; grant_credits signs it
                // negative for kind='refund' (claws the credits back).
                p_amount_usd: refundedUsd,
                p_kind: 'refund',
                p_idempotency_key: `refund-${refund.id}`,
                p_stripe_ref: charge.id,
                p_note: `Refund ${refund.id} of top-up ${topupSession.id}`,
              })
              if (rfError) {
                console.error('Failed to record topup refund:', rfError.message)
              } else {
                console.log(`💸 Top-up refund recorded: user=${topupSession.metadata.user_id} refund=${refund.id} amount=$${refundedUsd}`)
              }
            }
          }
        } catch (err) {
          console.error('Error handling possible topup refund:', err)
        }

        break
      }

      default:
        console.log(`Unhandled event type: ${event.type}`)
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('Webhook error:', error)
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 400 },
    )
  }
})
