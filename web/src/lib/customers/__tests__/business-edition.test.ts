/**
 * A business profile and the service-business edition (roadmap F1): the
 * first profile puts the workspace on it, a later edit doesn't touch it, an
 * edition a person chose stays, and the agent's words carry the business's
 * own word for a booking.
 */
import { describe, expect, it } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import { getEdition } from '@/lib/editions/manifest'
import { upsertBusinessProfile } from '../store'
import { businessWordsFor, workspaceWordsSection } from '../business-words'

const WS = 'ws-1'
const OWNER = 'user-1'

function db(settings: Record<string, unknown>, profile?: Record<string, unknown>) {
  const tables = {
    workspace: [{ id: WS, settings }],
    business_profile: profile ? [{ workspace_id: WS, owner_user_id: OWNER, business_name: 'Bright Loom', ...profile }] : [],
  }
  return { tables, client: memoryDb(tables) }
}

describe('a business profile and the edition', () => {
  it('the first profile switches attribution’s stamp to the service business', async () => {
    const { tables, client } = db({ edition: 'sales', trust_policy: { enabled: true } })
    expect(await upsertBusinessProfile(client, { workspaceId: WS, ownerUserId: OWNER }, { businessName: 'Bright Loom' })).toMatchObject({ ok: true })
    expect(tables.workspace[0].settings).toEqual({ edition: 'service', edition_source: 'business', trust_policy: { enabled: true } })
  })

  it('an edit to an existing profile leaves the edition alone', async () => {
    const { tables, client } = db({ edition: 'full', edition_source: 'business' }, { booking_kind: 'pickup' })
    expect(await upsertBusinessProfile(client, { workspaceId: WS, ownerUserId: OWNER }, { bookingKind: 'visit' })).toMatchObject({ ok: true })
    expect(tables.workspace[0].settings).toEqual({ edition: 'full', edition_source: 'business' })
  })

  it('never replaces an edition a person chose', async () => {
    const { tables, client } = db({ edition: 'sales', edition_source: 'chosen' })
    expect(await upsertBusinessProfile(client, { workspaceId: WS, ownerUserId: OWNER }, { businessName: 'Bright Loom' })).toMatchObject({ ok: true })
    expect(tables.workspace[0].settings).toEqual({ edition: 'sales', edition_source: 'chosen' })
  })
})

describe('the business’s own words', () => {
  const service = getEdition('service')

  it('the agent says the business’s word for a booking', async () => {
    const { client } = db({ edition: 'service' }, { booking_kind: 'pickup' })
    expect(await businessWordsFor(client, WS, service)).toEqual({ bookingKind: 'pickup' })
    expect(await workspaceWordsSection(client, WS, service)).toContain('- a booking is a “pickup” (the word the business’s booking page uses')
  })

  it('reads nothing for an edition that doesn’t name bookings, and no profile is no word', async () => {
    const { client } = db({}, { booking_kind: 'pickup' })
    expect(await businessWordsFor(client, WS, getEdition('full'))).toEqual({})
    expect(await workspaceWordsSection(client, WS, getEdition('full'))).toBe('')
    expect(await businessWordsFor(db({ edition: 'service' }).client, WS, service)).toEqual({})
  })

  it('a failed read is the edition’s own words, never a failed turn', async () => {
    const broken = { from: () => { throw new Error('db down') } } as never
    expect(await businessWordsFor(broken, WS, service)).toEqual({})
    expect(await workspaceWordsSection(broken, WS, service)).toMatch(/^## Words to use\n/)
  })
})
