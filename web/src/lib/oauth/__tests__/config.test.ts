import { describe, it, expect } from 'vitest'
import {
  isValidProvider,
  isValidCapability,
  getScopesForCapability,
  OAUTH_CONFIG,
} from '../config'

describe('isValidProvider', () => {
  it('accepts every configured provider including hubspot, asana and jira', () => {
    for (const p of ['google', 'microsoft', 'github', 'hubspot', 'asana', 'jira']) {
      expect(isValidProvider(p)).toBe(true)
    }
  })

  it('rejects unknown providers', () => {
    for (const p of ['slack', 'salesforce', 'hub', 'HUBSPOT', 'ASANA', 'JIRA', 'atlassian', '']) {
      expect(isValidProvider(p)).toBe(false)
    }
  })
})

describe('isValidCapability', () => {
  it('accepts every configured capability including crm and tasks', () => {
    for (const c of ['calendar', 'email', 'github', 'crm', 'tasks']) {
      expect(isValidCapability(c)).toBe(true)
    }
  })

  it('rejects unknown capabilities', () => {
    for (const c of ['both', 'contact', 'CRM', 'TASKS', 'task', '']) {
      expect(isValidCapability(c)).toBe(false)
    }
  })
})

describe('getScopesForCapability — hubspot/crm', () => {
  it('returns the mandatory oauth scope plus contacts + companies read and contacts write', () => {
    const scopes = getScopesForCapability('hubspot', 'crm')
    expect(scopes).toEqual([
      'oauth',
      'crm.objects.contacts.read',
      'crm.objects.companies.read',
      // Phase 2 writeback: meeting-engagement creation needs contacts.write
      // (there is no dedicated meetings scope on the v3 reference).
      'crm.objects.contacts.write',
    ])
  })

  it('returns a fresh mutable copy (not the frozen config array)', () => {
    const scopes = getScopesForCapability('hubspot', 'crm')
    // Should not throw — a returned copy is a plain, mutable array.
    expect(() => scopes.push('x')).not.toThrow()
  })

  it('returns [] for a capability the provider does not support', () => {
    // hubspot has no 'email' scope set.
    expect(getScopesForCapability('hubspot', 'email')).toEqual([])
  })

  it('leaves existing providers unchanged', () => {
    expect(getScopesForCapability('github', 'github')).toEqual(['repo', 'read:user'])
    expect(getScopesForCapability('google', 'calendar')).toContain(
      'https://www.googleapis.com/auth/calendar.events',
    )
  })
})

describe('OAUTH_CONFIG.hubspot', () => {
  it('uses the app.hubspot.com authorize URL', () => {
    expect(OAUTH_CONFIG.hubspot.authUrl).toBe('https://app.hubspot.com/oauth/authorize')
  })

  it('uses the date-versioned token endpoint', () => {
    expect(OAUTH_CONFIG.hubspot.tokenUrl).toBe('https://api.hubapi.com/oauth/2026-03/token')
  })
})

describe('getScopesForCapability — asana/tasks', () => {
  it("requests ONLY the 'default' scope — the app runs in Asana's full-permissions mode", () => {
    // The Developer Console app has "Full permissions" toggled ON, and in that
    // mode Asana rejects any named granular scope with forbidden_scopes. The
    // single 'default' scope is the only legal request. If the app ever moves
    // back to granular scopes, restore the 9-scope set listed in config.ts.
    expect(getScopesForCapability('asana', 'tasks')).toEqual(['default'])
  })

  it('never sneaks a named granular scope into the request', () => {
    const scopes = getScopesForCapability('asana', 'tasks')
    expect(scopes.some((s) => s.includes(':'))).toBe(false)
  })

  it('returns [] for a capability asana does not support', () => {
    expect(getScopesForCapability('asana', 'calendar')).toEqual([])
    expect(getScopesForCapability('asana', 'crm')).toEqual([])
  })

  it('returns [] for tasks on a provider that does not support it', () => {
    expect(getScopesForCapability('hubspot', 'tasks')).toEqual([])
    expect(getScopesForCapability('google', 'tasks')).toEqual([])
  })
})

describe('OAUTH_CONFIG.asana', () => {
  it('uses the app.asana.com authorize + token endpoints', () => {
    expect(OAUTH_CONFIG.asana.authUrl).toBe('https://app.asana.com/-/oauth_authorize')
    expect(OAUTH_CONFIG.asana.tokenUrl).toBe('https://app.asana.com/-/oauth_token')
  })
})

describe('getScopesForCapability — jira/tasks', () => {
  it('requests the CLASSIC scopes the integration actually uses', () => {
    expect(getScopesForCapability('jira', 'tasks')).toEqual([
      'read:jira-work',
      'write:jira-work',
      'read:jira-user',
      'manage:jira-webhook',
      'read:me',
      'offline_access',
    ])
  })

  /**
   * REGRESSION (review finding: "read:me scope missing, so getUserEmail always
   * fails and two Atlassian accounts collide"). The OAuth callback labels a
   * connection with `GET https://api.atlassian.com/me`, which belongs to the
   * User Identity API — `read:jira-user` grants the Jira-SITE user endpoints and
   * does NOT cover it. Without this scope the call 403s silently, the account
   * row is stored as `<uuid>@unknown`, and a second Atlassian account connected
   * by the same user matches that key and overwrites the first one's tokens.
   *
   * Atlassian grants scopes at consent time only, so this is cheap now and a
   * fleet-wide forced re-consent later.
   */
  it('includes read:me — the account-level identity the callback labels with', () => {
    expect(getScopesForCapability('jira', 'tasks')).toContain('read:me')
  })

  it('INCLUDES offline_access — without it Atlassian returns no refresh token', () => {
    // Not a data scope: it is the only thing that makes the connection outlive
    // the 1-hour access token. Losing it is a silent, delayed failure.
    expect(getScopesForCapability('jira', 'tasks')).toContain('offline_access')
  })

  it('includes the webhook-management scope the read-back registration needs', () => {
    expect(getScopesForCapability('jira', 'tasks')).toContain('manage:jira-webhook')
  })

  it('asks for no GRANULAR scopes — classic is Atlassian\'s own recommendation', () => {
    // Granular scopes are per-entity (read:issue:jira, read:status:jira, …) and
    // multiply past the documented ~50-scope soft limit for the same surface.
    const scopes = getScopesForCapability('jira', 'tasks')
    expect(scopes.filter((s) => s.split(':').length > 2)).toEqual([])
  })

  it('returns [] for a capability jira does not support', () => {
    expect(getScopesForCapability('jira', 'calendar')).toEqual([])
    expect(getScopesForCapability('jira', 'crm')).toEqual([])
  })

  it('leaves the asana scope set untouched', () => {
    expect(getScopesForCapability('asana', 'tasks')).toEqual(['default'])
  })
})

describe('OAUTH_CONFIG.jira', () => {
  it('uses ATLASSIAN\'s shared 3LO endpoints, not a tenant site', () => {
    // A per-site URL would be unusable: the site isn't known until after the
    // token exists (accessible-resources), and 3LO tokens are minted against
    // auth.atlassian.com regardless.
    expect(OAUTH_CONFIG.jira.authUrl).toBe('https://auth.atlassian.com/authorize')
    expect(OAUTH_CONFIG.jira.tokenUrl).toBe('https://auth.atlassian.com/oauth/token')
  })

  it('reuses the existing tasks capability rather than minting a new one', () => {
    expect(Object.keys(OAUTH_CONFIG.jira.scopes)).toEqual(['tasks'])
    expect(isValidCapability('tasks')).toBe(true)
  })
})
