/**
 * The second half of an OAuth integration connect: exchange the provider's
 * authorization code for tokens and store them as the user's connected
 * account. Shared by the two places a connect completes:
 *   - the web callback (src/app/api/oauth/[provider]/callback/route.ts), after
 *     it bound the completing browser to the initiator (session or nonce cookie);
 *   - the desktop claim (src/app/api/oauth/[provider]/claim/route.ts), after it
 *     bound the claim to the initiator (signed-in user + the claim secret only
 *     the initiating window holds).
 *
 * The caller has ALREADY established that `userId` is the person who started
 * the flow. This function trusts that and never re-derives it.
 *
 * Moved verbatim from the callback route (security review 2026-10-31, P0-2);
 * every former `buildRedirect('oauth/error', …)` is now an `{ ok: false }`
 * result the caller renders as a redirect (web) or JSON (desktop).
 */
import { createClient } from '@supabase/supabase-js'
import { OAUTH_CONFIG, getScopesForCapability, getRedirectUri, isPkceProvider, type OAuthProvider, type OAuthCapability } from '@/lib/oauth/config'
import { pkceVerifier } from '@/lib/oauth/pkce'
import { startConnectedImport } from '@/lib/crm/import/connected'
import { inngest } from '@/lib/inngest/client'
import { setupGmailWatch } from '@/lib/email/gmail-watch'
import { setupOutlookSubscription } from '@/lib/email/outlook-webhook'
import { reconcileThreadCopies } from '@/lib/email/account-scope'
import { trackServerEvent } from '@/lib/posthog'
import { setReauthRequiredAt } from '@/lib/oauth/token-manager'
import { encryptOAuthToken, encryptOAuthTokenOrNull } from '@/lib/oauth/token-crypto'

export interface CompleteConnectInput {
  provider: OAuthProvider
  code: string
  /** The initiator, already bound by the caller. */
  userId: string
  capability: OAuthCapability
  /** The workspace the connect was started in (from the signed state), if any. */
  stateWorkspaceId: string | null
  /** The flow's nonce (from the signed state): a public app's PKCE verifier is derived from it (./pkce.ts). */
  stateNonce?: string | null
}

export type CompleteConnectResult =
  | { ok: true; provider: string; capability: string; email: string }
  | { ok: false; error: string }

export async function completeOAuthConnect(input: CompleteConnectInput): Promise<CompleteConnectResult> {
  const { provider, code, userId, capability, stateWorkspaceId, stateNonce } = input
  const fail = (error: string): CompleteConnectResult => ({ ok: false, error })

  try {
    // Exchange code for tokens
    const config = OAUTH_CONFIG[provider]
    const clientIdByProvider: Record<OAuthProvider, string | undefined> = {
      google: process.env.GOOGLE_CLIENT_ID,
      microsoft: process.env.MICROSOFT_CLIENT_ID,
      github: process.env.GITHUB_CLIENT_ID,
      hubspot: process.env.HUBSPOT_CLIENT_ID,
      asana: process.env.ASANA_CLIENT_ID,
      jira: process.env.JIRA_CLIENT_ID,
      linear: process.env.LINEAR_CLIENT_ID,
      brevo: process.env.BREVO_CLIENT_ID,
    }
    const clientSecretByProvider: Record<OAuthProvider, string | undefined> = {
      google: process.env.GOOGLE_CLIENT_SECRET,
      microsoft: process.env.MICROSOFT_CLIENT_SECRET,
      github: process.env.GITHUB_CLIENT_SECRET,
      hubspot: process.env.HUBSPOT_CLIENT_SECRET,
      asana: process.env.ASANA_CLIENT_SECRET,
      jira: process.env.JIRA_CLIENT_SECRET,
      linear: process.env.LINEAR_CLIENT_SECRET,
      // A public app: no secret, the PKCE verifier instead.
      brevo: undefined,
    }
    const clientId = clientIdByProvider[provider]!
    const clientSecret = clientSecretByProvider[provider]

    const tokenHeaders: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    }
    // GitHub returns form-encoded by default; request JSON
    if (provider === 'github') {
      tokenHeaders['Accept'] = 'application/json'
    }

    const tokenBody: Record<string, string> = {
      client_id: clientId,
      code,
      redirect_uri: getRedirectUri(provider),
    }
    if (isPkceProvider(provider)) {
      if (!stateNonce) return fail('token_exchange_failed')
      tokenBody.code_verifier = pkceVerifier(stateNonce)
    } else {
      tokenBody.client_secret = clientSecret!
    }
    // GitHub doesn't use grant_type; Google/Microsoft require it
    if (provider !== 'github') {
      tokenBody.grant_type = 'authorization_code'
    }

    const tokenRes = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: tokenHeaders,
      body: new URLSearchParams(tokenBody),
    })

    if (!tokenRes.ok) {
      const err = await tokenRes.text()
      console.error(`OAuth token exchange failed: ${err}`)
      return fail('token_exchange_failed')
    }

    const tokens = await tokenRes.json()

    // GitHub returns errors as 200 with error field
    if (tokens.error) {
      console.error(`GitHub OAuth error: ${tokens.error_description || tokens.error}`)
      return fail('token_exchange_failed')
    }

    // The tokens as stored: encrypted at rest (token-crypto.ts), and before
    // anything is written, so a missing key fails the connect without leaving
    // an account with no token. A reconnect over a legacy plaintext row
    // rewrites it encrypted.
    const storedAccessToken = encryptOAuthToken(tokens.access_token)
    const storedRefreshToken = encryptOAuthTokenOrNull(tokens.refresh_token)

    // Get user email from the provider
    const email = await getUserEmail(provider, tokens.access_token)

    // Store tokens using service role
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )

    // Persist the scopes the provider actually GRANTED, not the set we requested.
    // Google/Microsoft/GitHub return them on the token exchange (space-delimited;
    // GitHub uses commas). Providers that omit the field (HubSpot, Asana) fall
    // back to the requested set. Granted-scope storage is what the re-consent
    // banner diffs against — storing the requested set here produced false
    // "already has it" reads whenever a provider silently granted a stale set
    // (Azure AD cached consent did exactly this).
    const requestedScopes = getScopesForCapability(provider, capability)
    let scopes: string[]
    if (Array.isArray(tokens.scope)) {
      // Some providers (e.g. pre-2023 Linear apps) return scopes as an array.
      // tokens is untyped provider JSON — keep only real strings.
      scopes = tokens.scope.filter((s: unknown): s is string => typeof s === 'string')
    } else if (typeof tokens.scope === 'string' && tokens.scope.trim().length > 0) {
      // GitHub delimits with commas; everyone else is space-delimited per RFC
      // 6749 — splitting those on commas too would mangle any scope value that
      // legitimately contains one.
      scopes = tokens.scope.trim().split(provider === 'github' ? /[\s,]+/ : /\s+/)
    } else {
      console.warn('[OAuth Callback] provider did not echo granted scopes; storing requested set', provider)
      scopes = requestedScopes
    }

    // Use workspace from OAuth state (current workspace when user clicked Connect),
    // falling back to first membership for backward compat
    let workspaceId = stateWorkspaceId
    if (workspaceId) {
      // Re-check membership: the account and its imported mail/CRM rows are
      // written into this workspace with the service-role client.
      const { data: stateMember } = await supabase
        .from('member')
        .select('id')
        .eq('user_id', userId)
        .eq('workspace_id', workspaceId)
        .maybeSingle()
      if (!stateMember) {
        return fail('not_member')
      }
    } else {
      const { data: membership } = await supabase
        .from('member')
        .select('workspace_id')
        .eq('user_id', userId)
        .limit(1)
        .maybeSingle()
      workspaceId = membership?.workspace_id
    }
    if (!workspaceId) {
      return fail('no_workspace')
    }

    // Check if a connected_account already exists for this user+provider+capability+email
    const accountEmail = email || `${userId}@unknown`
    console.log(`[OAuth Callback] provider=${provider} capability=${capability} userId=${userId}`)

    const { data: existingAccount } = await supabase
      .from('connected_account')
      .select('id')
      .eq('user_id', userId)
      .eq('provider', provider)
      .eq('capability', capability)
      .eq('account_email', accountEmail)
      .maybeSingle()

    let accountId: string

    if (existingAccount) {
      // Re-auth / token refresh scenario — update existing token
      accountId = existingAccount.id
      console.log(`[OAuth Callback] Found existing connected_account: ${accountId}`)

      // Ensure the account is linked to the current workspace so it stays
      // visible after a reconnect (the junction may be missing if the account
      // was first connected without a workspace context).
      if (workspaceId) {
        await supabase
          .from('connected_account_workspace')
          .upsert(
            { account_id: accountId, workspace_id: workspaceId },
            { onConflict: 'account_id,workspace_id', ignoreDuplicates: true },
          )
          .then(({ error: junctionErr }) => {
            if (junctionErr) console.error('[OAuth Callback] Junction upsert failed:', junctionErr)
          })
        // Newly linked here: its threads get this workspace's copies.
        if (capability === 'email') await reconcileThreadCopies(accountId)
      }
    } else {
      // New account — check if this is the first account for this capability
      const { count } = await supabase
        .from('connected_account')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('capability', capability)

      const isFirst = (count ?? 0) === 0

      // Determine display name
      const displayName = provider === 'github'
        ? 'GitHub'
        : provider === 'hubspot'
          ? 'HubSpot'
          : provider === 'asana'
            ? 'Asana'
            : provider === 'jira'
              ? 'Jira'
              : provider === 'linear'
                ? 'Linear'
                : provider === 'brevo'
                  ? 'Brevo'
                  : provider === 'google'
                  ? (capability === 'email' ? 'Gmail' : capability === 'contacts' ? 'Google Contacts' : 'Google Calendar')
                  : (capability === 'email' ? 'Outlook' : 'Outlook Calendar')

      // Create new connected_account
      const { data: newAccount, error: createError } = await supabase
        .from('connected_account')
        .insert({
          user_id: userId,
          workspace_id: workspaceId,
          provider,
          capability,
          account_email: accountEmail,
          display_name: displayName,
          is_primary: isFirst,
        })
        .select('id')
        .single()

      if (createError || !newAccount) {
        console.error('Failed to create connected_account:', createError)
        return fail('account_creation_failed')
      }

      accountId = newAccount.id
      console.log(`[OAuth Callback] Created new connected_account: ${accountId} (isFirst=${isFirst})`)

      // Add to junction table so this account is visible in the current workspace
      if (workspaceId) {
        await supabase
          .from('connected_account_workspace')
          .insert({ account_id: accountId, workspace_id: workspaceId })
          .then(({ error: junctionErr }) => {
            if (junctionErr) console.error('[OAuth Callback] Junction insert failed:', junctionErr)
          })
      }

      // Create default preference (not applicable for GitHub)
      if (capability === 'email') {
        await supabase.from('email_account_preference').insert({
          user_id: userId,
          account_id: accountId,
        })
      } else if (capability === 'calendar') {
        await supabase.from('calendar_account_preference').insert({
          user_id: userId,
          account_id: accountId,
        })
      }
    }

    // Upsert the oauth token linked to the connected_account.
    // We can't use Supabase upsert with the COALESCE-based unique index,
    // so check for existing row first and update or insert accordingly.
    const { data: existingToken } = await supabase
      .from('user_oauth_tokens')
      .select('id')
      .eq('user_id', userId)
      .eq('provider', provider)
      .eq('capability', capability)
      .eq('account_id', accountId)
      .maybeSingle()

    const tokenData = {
      user_id: userId,
      provider,
      capability,
      account_id: accountId,
      access_token: storedAccessToken,
      refresh_token: storedRefreshToken,
      token_type: tokens.token_type || 'Bearer',
      expires_at: tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : null,
      scopes,
      email,
      updated_at: new Date().toISOString(),
    }

    let tokenSaved = true
    if (existingToken) {
      console.log(`[OAuth Callback] Updating existing token row: ${existingToken.id}`)
      const { error: updateErr } = await supabase
        .from('user_oauth_tokens')
        .update(tokenData)
        .eq('id', existingToken.id)
      if (updateErr) {
        tokenSaved = false
        console.error('[OAuth Callback] Token update failed:', updateErr)
      }
    } else {
      // Also check for a legacy token without account_id and update it
      const { data: legacyToken } = await supabase
        .from('user_oauth_tokens')
        .select('id')
        .eq('user_id', userId)
        .eq('provider', provider)
        .eq('capability', capability)
        .is('account_id', null)
        .maybeSingle()

      if (legacyToken) {
        console.log(`[OAuth Callback] Updating legacy token row: ${legacyToken.id} with account_id=${accountId}`)
        const { error: updateErr } = await supabase
          .from('user_oauth_tokens')
          .update(tokenData)
          .eq('id', legacyToken.id)
        if (updateErr) {
          tokenSaved = false
          console.error('[OAuth Callback] Legacy token update failed:', updateErr)
        }
      } else {
        console.log(`[OAuth Callback] Inserting new token row for account_id=${accountId}`)
        const { error: insertErr } = await supabase
          .from('user_oauth_tokens')
          .insert(tokenData)
        if (insertErr) {
          tokenSaved = false
          console.error('[OAuth Callback] Token insert failed:', insertErr)
        }
      }
    }

    // A reconnect with fresh tokens clears the "needs reconnect" flag the
    // refresh path sets (connected_account.reauth_required_at, migration 348).
    // A new account starts NULL, so only an existing one needs it. Its own
    // best-effort statement: it never throws, and a missing column (migration
    // not applied yet) is swallowed, so it can't fail the connect.
    if (existingAccount && tokenSaved) {
      await setReauthRequiredAt(supabase, accountId, null)
    }

    // For email capability: set up webhook subscription immediately so real-time
    // notifications work even if the background import fails or is slow.
    if (capability === 'email') {
      // Create email_sync_state row so incremental sync has something to work with
      await supabase.from('email_sync_state').insert({
        user_id: userId,
        workspace_id: workspaceId,
        provider,
        account_id: accountId,
        initial_import_status: 'pending',
      })

      // Set up real-time webhook — lightweight API call, doesn't block long
      try {
        if (provider === 'google') {
          await setupGmailWatch(tokens.access_token, userId, accountId)
        } else if (provider === 'microsoft') {
          await setupOutlookSubscription(tokens.access_token, userId, accountId)
        }
      } catch {
        // Non-critical — the initial import will retry this in step 5
      }

      // Trigger background import for historical emails
      try {
        await inngest.send({
          name: 'email/initial-import',
          data: {
            accountId,
            userId,
            workspaceId,
            provider: provider as 'google' | 'microsoft',
          },
        })
      } catch (err) {
        console.error('Failed to trigger email import:', err)
      }
    }

    // Google Contacts and Brevo: the first import through the one importer
    // (roadmap track G, src/lib/crm/import/connected.ts). Read-only, once per
    // connect, texted when done. Best-effort: never fails the redirect.
    if (capability === 'contacts' && (provider === 'google' || provider === 'brevo')) {
      try {
        await startConnectedImport(supabase, { provider, userId, workspaceId, accountId, accountEmail: email || null })
      } catch (err) {
        console.error('Failed to start the contacts import:', err)
      }
    }

    // For CRM capability (HubSpot): seed crm_sync_state and kick off the initial
    // contacts + companies import. Best-effort — a failure here must never fail
    // the OAuth redirect (the cron self-heals by re-firing the initial import
    // for pending/failed/missing state).
    if (capability === 'crm' && provider === 'hubspot') {
      try {
        // Idempotent seed: on reconnect the row already exists (UNIQUE account_id),
        // so ignore the conflict rather than resetting an in-flight/complete sync.
        await supabase
          .from('crm_sync_state')
          .upsert(
            {
              user_id: userId,
              workspace_id: workspaceId,
              provider,
              account_id: accountId,
              initial_import_status: 'pending',
            },
            { onConflict: 'account_id', ignoreDuplicates: true },
          )

        await inngest.send({
          name: 'crm/hubspot-initial-import',
          data: { userId, workspaceId, accountId },
        })
      } catch (err) {
        console.error('Failed to trigger CRM import:', err)
      }
    }

    // For tasks capability (Asana, Jira): seed task_sync_state so the workspace
    // has a row to hang its push destination on. Provider-generic — it keys off
    // `capability`, so a new task provider needs no edit here. There is NO
    // initial import — Dial8 never pulls remote tasks in; the integration only
    // pushes actions out (and reads status back over a webhook). Best-effort: a
    // failure here must never fail the OAuth redirect — the settings PATCH
    // re-upserts the row when the user picks a destination.
    if (capability === 'tasks') {
      try {
        // Idempotent seed: on reconnect the row already exists (UNIQUE
        // account_id), so ignore the conflict rather than wiping the
        // destination config the user already configured.
        await supabase
          .from('task_sync_state')
          .upsert(
            {
              user_id: userId,
              workspace_id: workspaceId,
              provider,
              account_id: accountId,
            },
            { onConflict: 'account_id', ignoreDuplicates: true },
          )
      } catch (err) {
        console.error('Failed to seed task sync state:', err)
      }
    }

    // Connection succeeded — token stored and account persisted. Fire on the
    // success path only (never on the error results above).
    trackServerEvent(
      'integration_connected',
      { userId, workspaceId, email },
      {
        provider,
        capability,
        account_email: accountEmail,
      },
    )

    return { ok: true, provider, capability, email: email || '' }
  } catch (err) {
    console.error('OAuth callback error:', err)
    return fail('server_error')
  }
}

async function getUserEmail(
  provider: string,
  accessToken: string,
): Promise<string | null> {
  try {
    if (provider === 'google') {
      const res = await fetch(
        'https://www.googleapis.com/oauth2/v2/userinfo',
        { headers: { Authorization: `Bearer ${accessToken}` } },
      )
      if (res.ok) {
        const data = await res.json()
        return data.email
      }
    } else if (provider === 'github') {
      // GitHub uses a different auth header format
      const res = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
        },
      })
      if (res.ok) {
        const data = await res.json()
        // GitHub login (username) is more useful than email for display
        // Email may be null if user has a private email
        if (data.email) return data.email
        // Fall back to username
        return data.login ? `${data.login}@github` : null
      }
    } else if (provider === 'hubspot') {
      // Token-info endpoint returns the connecting user's email + hub domain.
      // NOTE: this /oauth/v1/access-tokens endpoint is deprecated and sunsets
      // 2027-02-16 — migrate to POST /oauth/2026-03/token/introspect once that
      // response shape is confirmed.
      const res = await fetch(
        `https://api.hubapi.com/oauth/v1/access-tokens/${accessToken}`,
        { headers: { Accept: 'application/json' } },
      )
      if (res.ok) {
        const data = await res.json()
        // `user` is the connecting user's email; fall back to the hub domain.
        return data.user || data.hub_domain || null
      }
    } else if (provider === 'brevo') {
      // The connected Brevo account: its login email (the company name when there is none).
      const res = await fetch('https://api.brevo.com/v3/account', {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      })
      if (res.ok) {
        const data = await res.json()
        return data?.email || data?.companyName || null
      }
    } else if (provider === 'asana') {
      // Every Asana response wraps its payload in a top-level `data`.
      const res = await fetch('https://app.asana.com/api/1.0/users/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (res.ok) {
        const body = await res.json()
        const me = body?.data
        // Email is the useful identity; fall back to the display name so the
        // account row is never labelled `<uuid>@unknown`.
        return me?.email || me?.name || null
      }
    } else if (provider === 'jira') {
      // Atlassian's account-level identity endpoint, NOT a Jira-site one — it
      // lives on the gateway root and needs no cloudId (which we don't have
      // yet at callback time; the site is picked later, in settings).
      const res = await fetch('https://api.atlassian.com/me', {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      })
      if (res.ok) {
        const me = await res.json()
        // `email` may be withheld by the user's Atlassian privacy settings —
        // fall back to the display name so the account row is never labelled
        // with a bare uuid.
        return me?.email || me?.name || null
      }
    } else if (provider === 'linear') {
      // The ONE identity lookup in this function that is not a REST GET: Linear
      // has a single GraphQL endpoint and no /me resource, so the connecting
      // user is read with a query. Kept deliberately SHALLOW (viewer only, no
      // nested organization/teams) — Linear budgets queries by complexity
      // points, and this one runs on every connect.
      const res = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: '{ viewer { email name } }' }),
      })
      if (res.ok) {
        // A GraphQL failure is a 200 with an `errors` array and a null field, so
        // `res.ok` alone proves nothing — the optional chain below is what
        // actually handles it, falling through to null like every sibling.
        const body = await res.json()
        const viewer = body?.data?.viewer
        return viewer?.email || viewer?.name || null
      }
    } else {
      const res = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (res.ok) {
        const data = await res.json()
        return data.mail || data.userPrincipalName
      }
    }
  } catch {
    // Fall through
  }
  return null
}
