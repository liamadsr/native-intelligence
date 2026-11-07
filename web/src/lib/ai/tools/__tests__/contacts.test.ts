import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Tests for what create_contact fans out (src/lib/ai/tools/contacts.ts).
 *
 * Two emits, two different gates:
 *   - crm/hubspot-push-contact ONLY when the created row carries an email
 *     (the tool always creates source='manual' contacts).
 *   - crm/enrich-contact ALWAYS, preceded by the pending mark — the same
 *     thing /api/account/contacts POST does, so a contact the agent creates
 *     arrives as complete as one typed into the New Contact dialog. The
 *     enricher owns every guard, including "not enough to search on".
 */

const hoisted = vi.hoisted(() => ({
  inngestSend: vi.fn(),
}))
vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: hoisted.inngestSend },
}))

const { createContactTools } = await import('@/lib/ai/tools/contacts')

/**
 * Minimal Supabase fake for the create_contact path: a `member` lookup
 * (.select().eq().eq().single()), a `contact` insert
 * (.insert().select().single()) returning `insertedRow`, and the enrichment
 * pending mark (.update().eq().eq()), whose patch is recorded.
 */
let insertedRow: Record<string, unknown> = { id: 'ct-1', full_name: 'Ada', email: 'ada@example.com', relationship_type: 'contact' }
let updates: Array<Record<string, unknown>> = []
let inserted: Record<string, unknown> | null = null
function makeSupabase(): SupabaseClient {
  return {
    from(table: string) {
      if (table === 'member') {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ single: async () => ({ data: { id: 'member-1' }, error: null }) }) }),
          }),
        }
      }
      // contact insert + the enrichment pending mark
      return {
        insert: (row: Record<string, unknown>) => {
          inserted = row
          return { select: () => ({ single: async () => ({ data: insertedRow, error: null }) }) }
        },
        update: (patch: Record<string, unknown>) => {
          updates.push(patch)
          return { eq: () => ({ eq: async () => ({ data: null, error: null }) }) }
        },
      }
    },
  } as unknown as SupabaseClient
}

function createTool() {
  return createContactTools('user-1', makeSupabase(), 'ws-1').create_contact
}

/** The events the tool fanned out, by name. */
function emitted(): string[] {
  return hoisted.inngestSend.mock.calls.map((c) => (c[0] as { name: string }).name)
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.inngestSend.mockResolvedValue({ ids: ['e'] })
  insertedRow = { id: 'ct-1', full_name: 'Ada', email: 'ada@example.com', relationship_type: 'contact' }
  updates = []
  inserted = null
})

describe('create_contact — what it fans out', () => {
  it('emits crm/hubspot-push-contact when the created contact has an email', async () => {
    const tool = createTool()
    const res = await tool.execute!(
      { full_name: 'Ada', email: 'ada@example.com', relationship_type: 'contact' },
      {} as never,
    )
    expect(res).toMatchObject({ success: true })
    expect(hoisted.inngestSend).toHaveBeenCalledWith({
      name: 'crm/hubspot-push-contact',
      data: { contactId: 'ct-1', workspaceId: 'ws-1' },
    })
    // An attended create carries no hold.
    expect(inserted?.metadata).toBeUndefined()
  })

  it('an UNATTENDED run creates the row HELD from HubSpot and sends no push (Sequence step 2, plan A.1)', async () => {
    const tool = createContactTools('user-1', makeSupabase(), 'ws-1', true, 'session', true).create_contact
    const res = await tool.execute!(
      { full_name: 'Ada', email: 'ada@example.com', relationship_type: 'contact' },
      {} as never,
    )
    expect(res).toMatchObject({ success: true })
    expect(emitted()).not.toContain('crm/hubspot-push-contact')
    // The hold is what keeps the 15-minute sweep off the row too.
    expect(inserted?.metadata).toEqual({ hubspot_push_hold: { at: expect.any(String), by: 'unattended' } })
  })

  it('does NOT emit when the created contact has no email', async () => {
    insertedRow = { id: 'ct-2', full_name: 'No Email', email: null, relationship_type: 'contact' }
    const tool = createTool()
    const res = await tool.execute!(
      { full_name: 'No Email', relationship_type: 'contact' },
      {} as never,
    )
    expect(res).toMatchObject({ success: true })
    expect(emitted()).not.toContain('crm/hubspot-push-contact')
  })

  // Enrichment is a paid web search and only runs when the person asks for it
  // (the Enrich button, or a yes to the chat's enrich_contact): creating a
  // contact never starts one, email or no email.
  it('never marks the row pending or asks for enrichment', async () => {
    const tool = createTool()
    await tool.execute!(
      { full_name: 'Ada', email: 'ada@example.com', relationship_type: 'contact' },
      {} as never,
    )
    expect(updates).toEqual([])
    expect(emitted()).not.toContain('crm/enrich-contact')

    vi.clearAllMocks()
    insertedRow = { id: 'ct-2', full_name: 'No Email', email: null, relationship_type: 'contact' }
    await createTool().execute!({ full_name: 'No Email', relationship_type: 'contact' }, {} as never)
    expect(updates).toEqual([])
    expect(emitted()).toEqual([])
  })

  it('does NOT fail the tool when the emit send rejects (fire-and-forget)', async () => {
    hoisted.inngestSend.mockRejectedValueOnce(new Error('inngest down'))
    const tool = createTool()
    const res = await tool.execute!(
      { full_name: 'Ada', email: 'ada@example.com', relationship_type: 'contact' },
      {} as never,
    )
    expect(res).toMatchObject({ success: true })
  })
})
