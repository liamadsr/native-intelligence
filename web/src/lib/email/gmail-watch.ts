import { getServiceClient } from '@/lib/admin'
import { getValidToken, getValidTokenForAccount } from '@/lib/oauth/token-manager'

// =====================================================================
// Setup Gmail Pub/Sub watch for push notifications
// =====================================================================

export async function setupGmailWatch(
  accessToken: string,
  userId: string,
  accountId?: string,
): Promise<{ historyId: string; expiration: string }> {
  const topicName = process.env.GMAIL_PUBSUB_TOPIC
  if (!topicName) {
    throw new Error('GMAIL_PUBSUB_TOPIC environment variable not set')
  }

  const response = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/watch',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        topicName,
        // Changes to inbox and sent mail only. A star on an inbox message still
        // notifies (it carries INBOX). DRAFT is left out: every draft save,
        // including the replies Native Intelligence drafts on arrival, would otherwise push a
        // sync run; Native Intelligence's own drafts are indexed when they are written.
        labelIds: ['INBOX', 'SENT'],
        labelFilterBehavior: 'INCLUDE',
      }),
    },
  )

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`Gmail watch setup failed: ${response.status} - ${err}`)
  }

  const data = await response.json()

  // Save watch expiration (7 days from now)
  const supabase = getServiceClient()
  const syncFilter = accountId
    ? { account_id: accountId }
    : { user_id: userId, provider: 'google' }

  await supabase
    .from('email_sync_state')
    .update({
      gmail_watch_expiration: new Date(parseInt(data.expiration)).toISOString(),
      gmail_watch_resource_id: data.historyId,
    })
    .match(syncFilter)

  return data
}

// =====================================================================
// Renew expiring Gmail watches (call from cron every 6 days)
// =====================================================================

export async function renewGmailWatches(): Promise<number> {
  const supabase = getServiceClient()

  // Find watches expiring in the next 24 hours OR watches that were never
  // established (expiration is null because setup failed at connect time).
  // Healing the null case ensures real-time push recovers without the user
  // having to disconnect/reconnect.
  const expirationThreshold = new Date(
    Date.now() + 24 * 60 * 60 * 1000,
  ).toISOString()

  const { data: expiring } = await supabase
    .from('email_sync_state')
    .select('user_id, workspace_id, account_id')
    .eq('provider', 'google')
    .or(
      `gmail_watch_expiration.is.null,gmail_watch_expiration.lt.${expirationThreshold}`,
    )

  let renewed = 0

  for (const state of expiring || []) {
    try {
      let tokenResult: { token: string } | null = null

      if (state.account_id) {
        tokenResult = await getValidTokenForAccount(state.account_id)
      } else {
        tokenResult = await getValidToken(state.user_id, 'google', 'email')
      }

      if (tokenResult) {
        await setupGmailWatch(tokenResult.token, state.user_id, state.account_id)
        renewed++
      }
    } catch (err) {
      console.error(`Failed to renew Gmail watch for ${state.account_id || state.user_id}:`, err)
    }
  }

  return renewed
}
