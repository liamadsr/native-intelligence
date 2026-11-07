import { getServiceClient } from '@/lib/admin'
import { getValidToken, getValidTokenForAccount } from '@/lib/oauth/token-manager'

// =====================================================================
// Setup Microsoft Graph webhook subscription for mail changes
// =====================================================================

export async function setupOutlookSubscription(
  accessToken: string,
  userId: string,
  accountId?: string,
): Promise<{ id: string; expirationDateTime: string }> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) {
    throw new Error('NEXT_PUBLIC_APP_URL environment variable not set')
  }

  // Use accountId as clientState for multi-account, userId for legacy,
  // prefixed with the webhook secret (format: "secret:id"). The webhook
  // refuses any other form, so a subscription without the secret would never
  // sync: none is made.
  const webhookSecret = process.env.OUTLOOK_WEBHOOK_SECRET
  if (!webhookSecret) {
    throw new Error('OUTLOOK_WEBHOOK_SECRET environment variable not set')
  }
  const rawId = accountId || userId
  const clientState = `${webhookSecret}:${rawId}`

  const response = await fetch(
    'https://graph.microsoft.com/v1.0/subscriptions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        changeType: 'created,updated,deleted',
        notificationUrl: `${appUrl}/api/webhooks/outlook`,
        resource: 'me/mailFolders/inbox/messages',
        expirationDateTime: new Date(
          Date.now() + 3 * 24 * 60 * 60 * 1000,
        ).toISOString(), // 3 days max
        clientState,
      }),
    },
  )

  if (!response.ok) {
    const err = await response.text()
    throw new Error(
      `Outlook subscription setup failed: ${response.status} - ${err}`,
    )
  }

  const subscription = await response.json()

  const supabase = getServiceClient()
  const syncFilter = accountId
    ? { account_id: accountId }
    : { user_id: userId, provider: 'microsoft' }

  await supabase
    .from('email_sync_state')
    .update({
      ms_subscription_id: subscription.id,
      ms_subscription_expiration: subscription.expirationDateTime,
    })
    .match(syncFilter)

  return subscription
}

// =====================================================================
// Renew expiring Outlook subscriptions (call from cron every 2 days)
// =====================================================================

export async function renewOutlookSubscriptions(): Promise<number> {
  const supabase = getServiceClient()

  // Find subscriptions expiring in the next 12 hours OR subscriptions that
  // were never established (expiration is null because setup failed at connect
  // time). Healing the null case recovers real-time push automatically.
  const expirationThreshold = new Date(
    Date.now() + 12 * 60 * 60 * 1000,
  ).toISOString()

  const { data: expiring } = await supabase
    .from('email_sync_state')
    .select('user_id, workspace_id, account_id, ms_subscription_id')
    .eq('provider', 'microsoft')
    .or(
      `ms_subscription_expiration.is.null,ms_subscription_expiration.lt.${expirationThreshold}`,
    )

  let renewed = 0

  for (const state of expiring || []) {
    try {
      let tokenResult: { token: string } | null = null

      if (state.account_id) {
        tokenResult = await getValidTokenForAccount(state.account_id)
      } else {
        tokenResult = await getValidToken(state.user_id, 'microsoft', 'email')
      }

      if (!tokenResult) continue

      // Never established (or lost) the subscription id — create a fresh one.
      if (!state.ms_subscription_id) {
        await setupOutlookSubscription(tokenResult.token, state.user_id, state.account_id)
        renewed++
        continue
      }

      // Renew existing subscription
      const res = await fetch(
        `https://graph.microsoft.com/v1.0/subscriptions/${state.ms_subscription_id}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${tokenResult.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            expirationDateTime: new Date(
              Date.now() + 3 * 24 * 60 * 60 * 1000,
            ).toISOString(),
          }),
        },
      )

      if (res.ok) {
        const data = await res.json()
        const syncFilter = state.account_id
          ? { account_id: state.account_id }
          : { user_id: state.user_id, provider: 'microsoft' }

        await supabase
          .from('email_sync_state')
          .update({
            ms_subscription_expiration: data.expirationDateTime,
          })
          .match(syncFilter)
        renewed++
      } else {
        // Subscription expired or invalid — recreate
        await setupOutlookSubscription(tokenResult.token, state.user_id, state.account_id)
        renewed++
      }
    } catch (err) {
      console.error(
        `Failed to renew Outlook subscription for ${state.account_id || state.user_id}:`,
        err,
      )
    }
  }

  return renewed
}
