import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isPlaceholderName } from '@/lib/crm/enrichment'

/**
 * Tests for findOrCreateContact's name resolution.
 *
 * The regression: a meeting attendee whose provider sent no display name was
 * passed through as `fullName = email`, which the GEN-139 noise filter then
 * refused — so no contact was created at all. Now the meeting sources create,
 * and the ADDRESS must never be what lands in `full_name`.
 */

const inserted: Record<string, unknown>[] = []

let existingContact: { id: string } | null = null

vi.mock('@/lib/oauth/token-manager', () => ({
  getValidTokenForAccount: vi.fn(),
}))
vi.mock('@/lib/email/account-scope', () => ({
  getWorkspaceEmailAccountIds: vi.fn(),
}))

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from(table: string) {
      const api: Record<string, unknown> = {
        select: () => api,
        eq: () => api,
        is: () => api,
        or: () => api,
        limit: () => api,
        insert: (row: Record<string, unknown>) => {
          if (table === 'contact') inserted.push(row)
          return {
            select: () => ({
              single: async () => ({ data: { id: 'contact-new' }, error: null }),
            }),
          }
        },
        maybeSingle: async () => ({
          data: table === 'contact' ? existingContact : null,
          error: null,
        }),
        single: async () => ({ data: null, error: null }),
      }
      return api
    },
  }),
}))

const { findOrCreateContact } = await import('@/lib/crm/contacts')

beforeEach(() => {
  inserted.length = 0
  existingContact = null
})

describe('findOrCreateContact — name resolution', () => {
  it('creates a calendar_sync contact when the name equals the email', async () => {
    const res = await findOrCreateContact('ws-1', {
      email: 'nikhil.rao@pagetrail.ai',
      fullName: 'nikhil.rao@pagetrail.ai',
      source: 'calendar_sync',
    })

    expect(res).toEqual({ id: 'contact-new' })
    expect(inserted).toHaveLength(1)
    // The address is NEVER what gets stored as the name.
    expect(inserted[0].full_name).toBe('Nikhil Rao')
    expect(inserted[0].first_name).toBe('Nikhil')
    expect(inserted[0].last_name).toBe('Rao')
    expect(inserted[0].email).toBe('nikhil.rao@pagetrail.ai')
  })

  it('creates a calendar_sync contact with no name at all', async () => {
    await findOrCreateContact('ws-1', {
      email: 'nikhil.rao@pagetrail.ai',
      fullName: '',
      source: 'calendar_sync',
    })

    expect(inserted[0].full_name).toBe('Nikhil Rao')
  })

  it('keeps a real display name exactly as given', async () => {
    await findOrCreateContact('ws-1', {
      email: 'nikhil.rao@pagetrail.ai',
      fullName: 'Nikhil Rao',
      source: 'calendar_sync',
    })

    expect(inserted[0].full_name).toBe('Nikhil Rao')
  })

  it('stores an ENRICHABLE placeholder when the local-part is not name-shaped', async () => {
    await findOrCreateContact('ws-1', {
      email: 'jsmith42@acme.com',
      fullName: 'jsmith42@acme.com',
      source: 'calendar_sync',
    })

    const stored = inserted[0].full_name as string
    expect(stored).toBe('jsmith42')
    // The whole point of the raw-local-part fallback: enrichment must still
    // see this as a placeholder and overwrite it with the real name later.
    expect(isPlaceholderName(stored, 'jsmith42@acme.com')).toBe(true)
  })

  it('still refuses a role/bot address from a meeting source', async () => {
    const res = await findOrCreateContact('ws-1', {
      email: 'noreply@acme.com',
      fullName: '',
      source: 'calendar_sync',
    })

    expect(res).toBeNull()
    expect(inserted).toHaveLength(0)
  })

  it('still refuses an email_sync contact with no human-name signal', async () => {
    const res = await findOrCreateContact('ws-1', {
      email: 'chase@chase.com',
      fullName: 'chase@chase.com',
      source: 'email_sync',
    })

    expect(res).toBeNull()
    expect(inserted).toHaveLength(0)
  })

  it('returns the existing contact without inserting', async () => {
    existingContact = { id: 'contact-existing' }

    const res = await findOrCreateContact('ws-1', {
      email: 'nikhil.rao@pagetrail.ai',
      fullName: '',
      source: 'calendar_sync',
    })

    expect(res).toEqual({ id: 'contact-existing' })
    expect(inserted).toHaveLength(0)
  })

  it('refuses a non-address value outright', async () => {
    const res = await findOrCreateContact('ws-1', {
      email: 'Sarah Hale (ext)',
      fullName: 'Sarah Hale',
      source: 'calendar_sync',
    })

    expect(res).toBeNull()
    expect(inserted).toHaveLength(0)
  })
})
