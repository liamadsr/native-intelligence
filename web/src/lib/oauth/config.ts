export type OAuthProvider = 'google' | 'microsoft' | 'github' | 'hubspot' | 'asana' | 'jira' | 'linear' | 'brevo'
export type OAuthCapability = 'calendar' | 'email' | 'github' | 'crm' | 'tasks' | 'contacts'

export const OAUTH_CONFIG = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: {
      calendar: [
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/userinfo.email',
      ],
      email: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.compose',
        'https://www.googleapis.com/auth/userinfo.email',
      ],
      // Bringing the owner's Google Contacts into the CRM (roadmap track G2):
      // read-only, imported once through the importer (src/lib/crm/import/).
      // contacts.readonly is a SENSITIVE scope: Google's OAuth verification
      // must list it before users outside the test list can grant it (see
      // docs/plans/customer-import.md). Its own capability, not part of
      // `email`, so no Gmail connection needs a re-consent for it.
      contacts: [
        'https://www.googleapis.com/auth/contacts.readonly',
        'https://www.googleapis.com/auth/userinfo.email',
      ],
    },
  },
  microsoft: {
    authUrl:
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl:
      'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: {
      calendar: [
        'Calendars.ReadWrite',
        'User.Read',
        'offline_access',
      ],
      email: [
        'Mail.Read',
        'Mail.ReadWrite',
        // Graph requires Mail.Send for POST /me/sendMail and /messages/{id}/send —
        // Mail.ReadWrite does NOT cover sending. Connections made before this scope
        // was added need re-consent (the authorize route forces prompt=consent).
        'Mail.Send',
        'User.Read',
        'offline_access',
      ],
    },
  },
  github: {
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: {
      github: [
        'repo',
        'read:user',
      ],
    },
  },
  hubspot: {
    authUrl: 'https://app.hubspot.com/oauth/authorize',
    // Date-versioned token endpoint (current recommendation). The legacy
    // /oauth/v1/token sunsets 2027-02-16.
    tokenUrl: 'https://api.hubapi.com/oauth/2026-03/token',
    scopes: {
      // 'oauth' is mandatory for every HubSpot app; the read scopes cover the
      // contacts + companies backfill/incremental sync. contacts.write is the
      // ONLY scope meeting-engagement writeback needs (there is no dedicated
      // meetings scope on the v3 reference) — it also gates the re-consent
      // banner on the integration card for connections made before it was added.
      crm: [
        'oauth',
        'crm.objects.contacts.read',
        'crm.objects.companies.read',
        'crm.objects.contacts.write',
      ],
    },
  },
  brevo: {
    // A PUBLIC Brevo app (roadmap track G4, docs/plans/customer-import.md):
    // authorization code + PKCE (S256), no client secret. Brevo's own MCP
    // server only takes a pasted full-access API key, which an owner must
    // never be asked for. The app is reviewed by Brevo before any account
    // outside the developer's can authorize it.
    authUrl: 'https://oauth.brevo.com/realms/partner/oauth/authorize',
    tokenUrl: 'https://oauth.brevo.com/realms/partner/oauth/token',
    scopes: {
      // Read only: contacts (and their lists) and the CRM (companies, deals).
      // `:write` does not imply `:read` on Brevo, and nothing here writes.
      // `contacts`, not `crm`: everything keyed on the `crm` capability is
      // HubSpot's (the sync cron, the contact push), and a Brevo account must
      // never be handed to it.
      contacts: ['contacts:read', 'crm:read'],
    },
  },
  asana: {
    authUrl: 'https://app.asana.com/-/oauth_authorize',
    tokenUrl: 'https://app.asana.com/-/oauth_token',
    scopes: {
      // The Native Intelligence Asana app runs in FULL-PERMISSIONS mode (the Developer
      // Console's "Full permissions" toggle — Liam's call, 2026-07-26). In that
      // mode Asana FORBIDS requesting named granular scopes (forbidden_scopes),
      // and the app must ask for the single 'default' scope instead.
      //
      // If the app is ever switched back to granular scopes (e.g. for a
      // marketplace listing), restore this exact set — Asana grants scopes at
      // consent time only, so growing the set later forces every connected
      // user through a re-consent (the cost HubSpot paid for contacts.write):
      //   tasks:read tasks:write projects:read workspaces:read
      //   workspaces.typeahead:read users:read
      //   webhooks:read webhooks:write webhooks:delete
      tasks: ['default'],
    },
  },
  jira: {
    // Atlassian's shared 3LO endpoints — NOT the tenant's own site. Every API
    // call afterwards goes through the gateway
    // (https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/…), so the site
    // the user picks is config, not part of the OAuth URLs. The authorize URL
    // additionally needs `audience=api.atlassian.com` and `prompt=consent`,
    // which the authorize route adds (see its provider branch).
    authUrl: 'https://auth.atlassian.com/authorize',
    tokenUrl: 'https://auth.atlassian.com/oauth/token',
    scopes: {
      // CLASSIC scopes — Atlassian's own recommendation for the Jira platform
      // APIs ("where available, the recommendation is to use classic scopes").
      // Granular scopes would multiply into dozens of per-event names for the
      // same surface.
      //
      //   read:jira-work      issues, projects, statuses, transitions, createmeta
      //   write:jira-work     create/edit/transition/delete issues
      //   read:jira-user      user search + accountId for the assignee bridge
      //   manage:jira-webhook dynamic webhook register/refresh/delete
      //   read:me             `GET https://api.atlassian.com/me`, the ACCOUNT-
      //                       level identity the callback labels the connection
      //                       with. It belongs to the User Identity API, NOT to
      //                       the Jira platform API — `read:jira-user` grants
      //                       jira-SITE user endpoints and does not cover it, so
      //                       without this every connect 403s that call and
      //                       stores `<uuid>@unknown` as the account email (two
      //                       Atlassian accounts then collide on that key).
      //                       The Developer Console needs the User Identity API
      //                       permission ADDED to the app for this to be
      //                       grantable — see the README.
      //   offline_access      MANDATORY — without it Atlassian returns no
      //                       refresh_token and the connection dies in an hour.
      //
      // Atlassian grants scopes at consent time only, so growing this set later
      // forces every connected user through a re-consent — the cost HubSpot
      // paid for contacts.write.
      tasks: [
        'read:jira-work',
        'write:jira-work',
        'read:jira-user',
        'manage:jira-webhook',
        'read:me',
        'offline_access',
      ],
    },
  },
  linear: {
    // Linear has no per-tenant hostname — the authorize page and the token
    // endpoint are the same two URLs for every organization, and every API call
    // afterwards goes to ONE GraphQL endpoint. So unlike Jira there is no
    // cloudId/site to discover and no site picker: a Linear destination is just
    // a team (and optionally a project) inside the org the token belongs to.
    authUrl: 'https://linear.app/oauth/authorize',
    tokenUrl: 'https://api.linear.app/oauth/token',
    scopes: {
      // The FULL set — `write` covers issueCreate and issueUpdate, which is
      // everything this integration does. `admin` is deliberately NOT requested:
      // it exists for managing an organization (including creating webhooks
      // through the API), and Linear's webhooks for an OAuth app are APP-LEVEL —
      // configured once in the app console and auto-provisioned per authorizing
      // organization — so there is nothing for us to create and no reason to ask
      // a user for admin over their workspace.
      //
      // NOTE the DELIMITER: Linear's authorize endpoint wants these
      // COMMA-separated ("read,write"), not the space-separated form every other
      // provider here uses. The authorize route owns that join — see
      // SCOPE_DELIMITER there — and Linear's token RESPONSE then reports the
      // granted scopes space-separated, which is why nothing reads them back.
      tasks: ['read', 'write'],
    },
  },
} as const

export function isValidProvider(p: string): p is OAuthProvider {
  return (
    p === 'google' ||
    p === 'microsoft' ||
    p === 'github' ||
    p === 'hubspot' ||
    p === 'asana' ||
    p === 'jira' ||
    p === 'linear' ||
    p === 'brevo'
  )
}

/** Providers whose app is PUBLIC (PKCE, no client secret): the token exchange and refresh send a code verifier, never a secret. */
export function isPkceProvider(p: OAuthProvider): boolean {
  return p === 'brevo'
}

export function isValidCapability(c: string): c is OAuthCapability {
  return c === 'calendar' || c === 'email' || c === 'github' || c === 'crm' || c === 'tasks' || c === 'contacts'
}

export function getScopesForCapability(
  provider: OAuthProvider,
  capability: OAuthCapability,
): string[] {
  const providerScopes = OAUTH_CONFIG[provider].scopes as Record<string, readonly string[]>
  const scopes = providerScopes[capability]
  return scopes ? [...scopes] : []
}

export function getRedirectUri(provider: string) {
  const base = process.env.OAUTH_REDIRECT_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  return `${base}/api/oauth/${provider}/callback`
}
