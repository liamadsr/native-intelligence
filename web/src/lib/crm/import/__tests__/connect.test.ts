/**
 * Connecting the places an owner keeps customers (roadmap tracks G2-G4):
 * texted single-use links for Google Contacts, HubSpot and Brevo (track A's
 * shape: purpose, account, 15 minutes, once), Brevo's public-app PKCE, the
 * first import starting once per account, and the import tools seeded on the
 * turns that need them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { oneTimeLinkDb } from '@/lib/links/__tests__/one-time-fake'
import { connectLinkText, mintConnectLink, startConnectFromLink, textConnectConfirmation } from '@/lib/links/oauth-link'
import { LINK_PURPOSES } from '@/lib/links/purposes'
import type { OneTimeLink } from '@/lib/links/one-time'
import { buildOAuthStart } from '@/lib/oauth/authorize-url'
import { getScopesForCapability } from '@/lib/oauth/config'
import { pkceChallenge, pkceVerifier } from '@/lib/oauth/pkce'
import { mentionsContactImport } from '@/lib/ai/tool-discovery'
import { startConnectedImport } from '../connected'
import { memDb } from './mem-db'

beforeEach(() => {
  vi.stubEnv('GOOGLE_CLIENT_ID', 'google-client')
  vi.stubEnv('HUBSPOT_CLIENT_ID', 'hubspot-client')
  vi.stubEnv('BREVO_CLIENT_ID', 'brevo-client')
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://dial8.ai')
})

const link = (payload: Record<string, unknown>): OneTimeLink => ({ id: 'l', purpose: 'oauth_connect', userId: 'user-1', workspaceId: 'ws-1', payload, expiresAt: '2026-11-02T15:15:00Z' })

describe('texted links for the places customers are kept', () => {
  it('a Google Contacts link asks for contacts alone (its scope waits on Google), a plain Google link never does', async () => {
    const db = oneTimeLinkDb()
    await mintConnectLink(db.client as never, { userId: 'user-1', workspaceId: 'ws-1', provider: 'google', origin: 'https://dial8.ai', capabilities: ['contacts'] })
    await mintConnectLink(db.client as never, { userId: 'user-1', workspaceId: 'ws-1', provider: 'google', origin: 'https://dial8.ai' })
    expect(db.rows.map((r) => r.payload)).toEqual([
      { provider: 'google', capabilities: ['contacts'] },
      { provider: 'google', capabilities: ['email', 'calendar'] },
    ])
    expect(db.rows.every((r) => r.purpose === 'oauth_connect')).toBe(true)
    expect(LINK_PURPOSES.oauth_connect.view(link({ provider: 'google', capabilities: ['contacts'] }))?.title).toBe('Connect Google Contacts')
    expect(LINK_PURPOSES.oauth_connect.view(link({ provider: 'google', capabilities: ['email', 'calendar'] }))?.title).toBe('Connect Google')
  })

  it('a HubSpot link starts HubSpot\'s sign-in for the CRM, and its page says it only reads', () => {
    const l = link({ provider: 'hubspot', capabilities: ['crm'] })
    const started = startConnectFromLink(l)
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(new URL(started.start.authUrl).host).toBe('app.hubspot.com')
    expect(LINK_PURPOSES.oauth_connect.view(l)).toEqual({
      title: 'Connect HubSpot',
      body: "Your Native Intelligence agent will read your contacts and companies to bring them into Native Intelligence. It only reads: nothing is sent or changed in HubSpot. You sign in on HubSpot's own page: Native Intelligence never sees your password.",
      button: 'Continue to HubSpot',
    })
  })

  it("the texted link names what it connects, and says a customers link only reads", () => {
    expect(connectLinkText('google', 'https://dial8.ai/l/x', ['contacts'])).toBe(
      "Connect your Google Contacts: https://dial8.ai/l/x It opens Google's own sign-in and works once, for 15 minutes. I only read them, to bring your contacts into Native Intelligence. I'll never ask for a password by text.",
    )
    expect(connectLinkText('google', 'https://dial8.ai/l/x')).not.toContain('only read')
    expect(connectLinkText('hubspot', 'https://dial8.ai/l/x')).toContain('Connect your HubSpot account')
  })

  it('the confirmation says the import has started (and in setup, a contacts connect asks nothing more)', () => {
    expect(textConnectConfirmation({ provider: 'brevo', capabilities: ['contacts'], email: 'owner@brightweave.com', inSetup: true })).toBe(
      "Brevo is connected (owner@brightweave.com): contacts. I'm bringing your contacts into Native Intelligence now (read only, nothing is sent) and will text you a summary when it's done.",
    )
  })
})

describe('Brevo: a public app with PKCE', () => {
  it('asks for read-only scopes with an S256 challenge of a verifier only the server can derive', () => {
    expect(getScopesForCapability('brevo', 'contacts')).toEqual(['contacts:read', 'crm:read'])
    // Never under `crm`: that capability is HubSpot's everywhere (the sync cron, the contact push).
    expect(getScopesForCapability('brevo', 'crm')).toEqual([])
    const start = buildOAuthStart({ provider: 'brevo', capability: 'contacts', userId: 'user-1', workspaceId: 'ws-1', source: 'web' })
    const url = new URL(start.authUrl)
    expect(url.origin + url.pathname).toBe('https://oauth.brevo.com/realms/partner/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('brevo-client')
    expect(url.searchParams.get('scope')).toBe('contacts:read crm:read')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBe(pkceChallenge(pkceVerifier(start.nonce)))
    // Nothing in the URL is the verifier.
    expect(start.authUrl).not.toContain(pkceVerifier(start.nonce))
    expect(pkceVerifier(start.nonce)).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('other providers get no PKCE parameters', () => {
    const url = new URL(buildOAuthStart({ provider: 'hubspot', capability: 'crm', userId: 'user-1', workspaceId: 'ws-1', source: 'web' }).authUrl)
    expect(url.searchParams.has('code_challenge')).toBe(false)
  })
})

describe('the first import from a connected account', () => {
  it('opens one batch for the account and starts reading it; a reconnect never imports again', async () => {
    const db = memDb({ contact_import_batch: [] })
    const send = vi.fn(async () => undefined)
    const args = { provider: 'google' as const, userId: 'user-1', workspaceId: 'ws-1', accountId: 'acct-1', accountEmail: 'owner@gmail.com' }
    const first = await startConnectedImport(db.client, args, { send })
    expect(first).toEqual(expect.any(String))
    expect(db.tables.contact_import_batch[0]).toMatchObject({ source: 'google_contacts', account_id: 'acct-1', label: 'owner@gmail.com', status: 'staging', notify: true })
    expect(send).toHaveBeenCalledWith({ name: 'crm/import.google-contacts', data: { batchId: first, workspaceId: 'ws-1' } })
    expect(await startConnectedImport(db.client, args, { send })).toBeNull()
    expect(send).toHaveBeenCalledTimes(1)
    // An undone import: reconnecting imports again.
    db.tables.contact_import_batch[0].status = 'undone'
    expect(await startConnectedImport(db.client, { ...args, provider: 'brevo' }, { send })).toEqual(expect.any(String))
    expect(send).toHaveBeenLastCalledWith({ name: 'crm/import.brevo', data: expect.anything() })
  })
})

describe('import tools up front', () => {
  it('on a texted contacts file, an ask to import people, or an undo', () => {
    expect(mentionsContactImport('[They texted a spreadsheet (CSV): storage_path u/chat-uploads/x.csv]')).toBe(true)
    expect(mentionsContactImport('here are my customers - storage_path u/chat-uploads/a.xlsx')).toBe(true)
    expect(mentionsContactImport('can you import my customers from this spreadsheet')).toBe(true)
    expect(mentionsContactImport('undo import')).toBe(true)
    expect(mentionsContactImport('import the meeting notes into a doc')).toBe(false)
    expect(mentionsContactImport('what time is my call')).toBe(false)
  })
})
